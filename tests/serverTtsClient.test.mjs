import test from "node:test";
import assert from "node:assert/strict";
import { ServerTtsClient } from "../src/modules/tts/serverTtsClient.js";
import { readingSpeedToLengthScale } from "../src/modules/tts/readingSpeed.js";

const VOICE = "en_US-lessac-medium";
const OTHER_VOICE = "pt_BR-faber-medium";
const REVISION = "fixed-model-revision";

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function waitForAbort(signal) {
    return new Promise((resolve, reject) => {
        const fail = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
    });
}

function fixture(handler, options = {}) {
    const calls = [];
    const app = {
        serverSync: {
            getServerUrl: () => "https://reader.example/",
            _getAuthToken: () => "auth-token",
            _fetch: () => { throw new Error("Speech must not alter sync availability"); },
        },
    };
    const fetch = async (url, request) => {
        const call = { url, ...request, data: request.body ? JSON.parse(request.body) : null };
        calls.push(call);
        const custom = await handler?.(call, calls);
        if (custom !== undefined) return custom;
        if (url.endsWith("/capabilities")) return json({ enabled: true, voices: [VOICE, OTHER_VOICE], revision: REVISION });
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        if (url.endsWith("/phrases")) return new Response(new Uint8Array([73, 68, 51, 4]), { headers: { "Content-Type": "audio/mpeg" } });
        if (url.endsWith("/sessions")) return json({ id: call.data.id, voice: call.data.voice });
        return json({ id: url.split("/").at(-1), voice: call.data?.voice });
    };
    return { app, calls, client: new ServerTtsClient(app, { fetch, ...options }) };
}

test("authenticates activation and returns MP3 bytes without labelling them WAV", async (t) => {
    const { client, calls } = fixture();
    t.after(() => client.close());
    await client.init({ voiceId: VOICE, lengthScale: 0.5, modelRevision: REVISION });
    assert.equal(client.ready, true);
    const result = await client.synthesize("A phrase.", 0.5);
    const activation = calls.find((call) => call.url.endsWith("/sessions"));
    const phrase = calls.find((call) => call.url.endsWith("/phrases"));
    assert.match(activation.data.id, /^[\da-f-]{36}$/);
    assert.deepEqual(activation.data, { id: client.sessionId, voice: VOICE, lengthScale: 0.5, modelRevision: REVISION });
    assert.deepEqual(phrase.data, { text: "A phrase.", voice: VOICE, lengthScale: 0.5 });
    assert.equal(phrase.headers.Authorization, "Bearer auth-token");
    assert.equal(phrase.cache, "no-store");
    assert.equal(result.mimeType, "audio/mpeg");
    assert.equal(result.blob.type, "audio/mpeg");
    assert.equal(result.encodedBuffer.byteLength, 4);
    assert.equal(result.wavBuffer, undefined);
});

test("rejects a model revision mismatch before activating a model", async () => {
    const { client, calls } = fixture();
    await assert.rejects(client.init({ voiceId: VOICE, modelRevision: "different-revision" }), { code: "TTS_MODEL_MISMATCH" });
    assert.equal(calls.length, 1);
    assert.equal(client.sessionId, null);
});

test("reads authentication through the application's sync facade", async (t) => {
    const { client, app, calls } = fixture();
    t.after(() => client.close());
    app.serverSync.server = { _getAuthToken: () => "facade-token" };
    delete app.serverSync._getAuthToken;
    await client.init({ voiceId: VOICE });
    assert.equal(calls[0].headers.Authorization, "Bearer facade-token");
});

test("serializes voice changes after activation and uses the final settings on each phrase", async (t) => {
    const activationStarted = deferred();
    const finishActivation = deferred();
    const { client, calls } = fixture(async (call) => {
        if (call.url.endsWith("/sessions")) {
            activationStarted.resolve();
            await finishActivation.promise;
        }
    });
    t.after(() => client.close());
    const activation = client.init({ voiceId: VOICE, modelRevision: REVISION });
    await activationStarted.promise;
    const change = client.configure({ voiceId: OTHER_VOICE, lengthScale: 2 });
    assert.equal(calls.some((call) => call.method === "PUT"), false);
    finishActivation.resolve();
    await Promise.all([activation, change]);
    await client.synthesize("Outra frase.", 2, undefined, { createBlob: false });
    assert.equal(client.voiceId, OTHER_VOICE);
    assert.deepEqual(calls.find((call) => call.method === "PUT").data, { voice: OTHER_VOICE, lengthScale: 2 });
    assert.deepEqual(calls.at(-1).data, { text: "Outra frase.", voice: OTHER_VOICE, lengthScale: 2 });
});

test("aborting one phrase preserves the session and later speech requests", async (t) => {
    const phraseStarted = deferred();
    let block = true;
    const { client, calls } = fixture((call) => {
        if (block && call.url.endsWith("/phrases")) {
            phraseStarted.resolve();
            return waitForAbort(call.signal);
        }
    });
    t.after(() => client.close());
    await client.init({ voiceId: VOICE });
    const sessionId = client.sessionId;
    const controller = new AbortController();
    const synthesis = client.synthesize("Discard this phrase.", 1, undefined, { signal: controller.signal });
    await phraseStarted.promise;
    controller.abort();
    await assert.rejects(synthesis, { name: "AbortError" });
    assert.equal(client.sessionId, sessionId);
    assert.equal(client.ready, true);
    assert.equal(calls.some((call) => call.method === "DELETE"), false);
    block = false;
    assert.equal((await client.synthesize("Keep this phrase.", 1)).mimeType, "audio/mpeg");
});

test("close cancels model activation and deletes the known id at its original server", async () => {
    const activationStarted = deferred();
    const { client, app, calls } = fixture((call) => {
        if (call.url.endsWith("/sessions")) {
            activationStarted.resolve();
            return waitForAbort(call.signal);
        }
    });
    const activation = client.init({ voiceId: VOICE });
    const rejected = assert.rejects(activation, { name: "AbortError" });
    await activationStarted.promise;
    const sessionId = client.sessionId;
    app.serverSync.getServerUrl = () => "https://another.example";
    await client.close();
    await rejected;
    assert.equal(client.ready, false);
    assert.equal(client.sessionId, null);
    const deletions = calls.filter((call) => call.method === "DELETE");
    assert.ok(deletions.length >= 1);
    assert.ok(deletions.every((call) => call.url === `https://reader.example/api/tts/sessions/${sessionId}`));
    assert.ok(deletions.every((call) => call.keepalive));
});

test("queued speech cancellation does not wait for a pending model load", async (t) => {
    const activationStarted = deferred();
    const finishActivation = deferred();
    const { client, calls } = fixture(async (call) => {
        if (call.url.endsWith("/sessions")) {
            activationStarted.resolve();
            await finishActivation.promise;
        }
    });
    t.after(() => client.close());
    const activation = client.init({ voiceId: VOICE });
    await activationStarted.promise;
    const controller = new AbortController();
    const phrase = client.synthesize("Stale phrase.", 1, undefined, { signal: controller.signal });
    controller.abort();
    await assert.rejects(phrase, { name: "AbortError" });
    finishActivation.resolve();
    await activation;
    assert.equal(calls.some((call) => call.url.endsWith("/phrases")), false);
});

test("expired sessions can be activated again with the pinned revision", async (t) => {
    let expired = true;
    const { client, calls } = fixture((call) => {
        if (expired && call.url.endsWith("/phrases")) return json({ error: "Expired" }, 404);
    });
    t.after(() => client.close());
    await client.init({ voiceId: VOICE, modelRevision: REVISION });
    const oldSession = client.sessionId;
    await assert.rejects(client.synthesize("A phrase.", 1), { status: 404 });
    assert.equal(client.ready, false);
    expired = false;
    await client.configure({ voiceId: VOICE, lengthScale: 1 });
    assert.notEqual(client.sessionId, oldSession);
    const activations = calls.filter((call) => call.url.endsWith("/sessions"));
    assert.equal(activations.at(-1).data.modelRevision, REVISION);
    await client.synthesize("Another phrase.", 1);
});

test("a timed-out phrase does not mark general sync unavailable", async (t) => {
    const { client } = fixture((call) => call.url.endsWith("/phrases") ? waitForAbort(call.signal) : undefined, { requestTimeoutMs: 5 });
    t.after(() => client.close());
    await client.init({ voiceId: VOICE });
    await assert.rejects(client.synthesize("A phrase.", 1), { code: "TTS_SERVER_TIMEOUT" });
    assert.equal(client.ready, true);
});

test("heartbeat notices an expired lease so the next activation can recreate it", async (t) => {
    const heartbeat = deferred();
    const { client } = fixture((call) => {
        if (call.url.endsWith("/heartbeat")) {
            heartbeat.resolve();
            return json({ error: "Expired" }, 404);
        }
    }, { heartbeatIntervalMs: 5 });
    t.after(() => client.close());
    await client.init({ voiceId: VOICE });
    let deadline;
    try {
        await Promise.race([
            heartbeat.promise,
            new Promise((resolve, reject) => { deadline = setTimeout(() => reject(new Error("Heartbeat was not sent")), 1000); }),
        ]);
        await new Promise((resolve) => setImmediate(resolve));
    } finally {
        clearTimeout(deadline);
    }
    assert.equal(client.sessionId, null);
    assert.equal(client.ready, false);
});

test("reading speed maps to the same Piper length scale at every multiplier", () => {
    assert.equal(readingSpeedToLengthScale(0.5), 2);
    assert.equal(readingSpeedToLengthScale(1), 1);
    assert.equal(readingSpeedToLengthScale(1.5), 1 / 1.5);
    assert.equal(readingSpeedToLengthScale(2), 0.5);
    assert.equal(readingSpeedToLengthScale("invalid"), 1);
});
