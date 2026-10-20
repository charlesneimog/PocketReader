import test from "node:test";
import assert from "node:assert/strict";

const VOICE = "en_US-lessac-medium";

globalThis.window = { location: { href: "https://reader.example/index.html" } };
globalThis.document = {
    currentScript: null,
    body: { style: {} },
    getElementById: () => null,
};

const { TTSEngine } = await import("../src/modules/tts/ttsEngine.js");
const { ServerTtsClient } = await import("../src/modules/tts/serverTtsClient.js");

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function decodedAudio(duration, sampleRate = 1000, fill = 0) {
    const data = new Float32Array(Math.round(duration * sampleRate)).fill(fill);
    return {
        duration: data.length / sampleRate,
        sampleRate,
        length: data.length,
        numberOfChannels: 1,
        getChannelData: () => data,
    };
}

function fixture({ serverEnabled = false } = {}) {
    const calls = { messages: [], providers: [], events: [], resets: 0, requeues: 0 };
    const sentence = {
        index: 0,
        text: "Hello reader.",
        normalizedText: "Hello reader.",
        isTextToRead: true,
        layoutProcessed: true,
        audioReady: false,
        audioInProgress: false,
    };
    const app = {
        config: {
            DEFAULT_PIPER_VOICE: VOICE,
            PIPER_VOICES: [VOICE],
            ENABLE_WORD_HIGHLIGHT: true,
            MAKE_WAV_COPY: true,
            PDF_AUDIO_LAYOUT_BLOCK_PAUSE_SEC: 0.18,
            SPLIT_PDF_AUDIO_ON_LAYOUT_BLOCKS: true,
        },
        state: {
            sentences: [sentence],
            generationEnabled: true,
            currentDocumentType: "epub",
            currentSentenceIndex: 0,
            CURRENT_SPEED: 1,
            serverTtsEnabled: serverEnabled,
            piperInstance: null,
            currentPiperVoice: null,
            audioCache: new Map(),
            playerState: { LOADING: "loading", DONE: "done" },
        },
        ui: {
            showInfo: (message) => calls.messages.push(message),
            showMessage: (message) => calls.messages.push(message),
            updatePlayButton: () => {},
        },
        controlsManager: { reflectTtsProvider: (provider) => calls.providers.push(provider) },
        eventBus: { emit: (...args) => calls.events.push(args) },
        ttsQueue: { reset: () => calls.resets++, add: () => calls.requeues++, run: () => {} },
        getSentenceSpeechText: async (_index, text) => text,
    };
    const engine = new TTSEngine(app);
    app.ttsEngine = engine;
    engine.voices = { [VOICE]: { name: "lessac", quality: "medium", language: {}, files: {} } };
    engine.modelRevision = "a".repeat(40);
    return { app, engine, sentence, calls };
}

function synthesisTask(engine, sentence) {
    return {
        generation: engine._generation,
        lifetime: engine._lifetime,
        signal: engine._generationController.signal,
        index: 0,
        sentence,
        speed: engine.app.state.CURRENT_SPEED,
    };
}

test("closing during server model activation cannot resurrect the closed voice", async (t) => {
    const { app, engine, calls } = fixture({ serverEnabled: true });
    const activation = deferred();
    const started = deferred();
    const closedClients = [];
    t.mock.method(ServerTtsClient.prototype, "init", async function () {
        started.resolve();
        await activation.promise;
    });
    t.mock.method(ServerTtsClient.prototype, "close", async function () { closedClients.push(this); });
    const local = t.mock.method(engine, "_initializeLocalVoice", () => assert.fail("A closed document cannot start local inference"));

    const initializing = engine.ensurePiper(VOICE);
    const rejected = assert.rejects(initializing, { name: "AbortError" });
    await started.promise;
    const originalClient = engine.client;
    await engine.deactivate();
    activation.resolve();
    await rejected;

    assert.ok(closedClients.includes(originalClient));
    assert.equal(local.mock.callCount(), 0);
    assert.equal(engine.client, null);
    assert.equal(engine.provider, null);
    assert.equal(engine.initialized, false);
    assert.equal(app.state.piperInstance, null);
    assert.equal(app.state.currentPiperVoice, null);
    assert.ok(calls.resets >= 1);
});

test("a late activation cannot replace the voice belonging to the next document", async (t) => {
    const { app, engine } = fixture({ serverEnabled: true });
    const oldActivation = deferred();
    const started = deferred();
    let activations = 0;
    t.mock.method(ServerTtsClient.prototype, "init", async function () {
        if (++activations === 1) {
            started.resolve();
            await oldActivation.promise;
        }
    });
    t.mock.method(ServerTtsClient.prototype, "close", async () => {});

    const originalInitialization = engine.ensurePiper(VOICE);
    const rejected = assert.rejects(originalInitialization, { name: "AbortError" });
    await started.promise;
    await engine.deactivate();
    const currentClient = await engine.ensurePiper(VOICE);
    oldActivation.resolve();
    await rejected;

    assert.equal(engine.client, currentClient);
    assert.equal(app.state.piperInstance, currentClient);
    assert.equal(engine.initialized, true);
    assert.equal(engine.provider, "server");
    await engine.deactivate();
});

test("a working speech server is activated without creating a local voice worker", async (t) => {
    const { app, engine } = fixture({ serverEnabled: true });
    t.mock.method(ServerTtsClient.prototype, "init", async () => {});
    t.mock.method(ServerTtsClient.prototype, "close", async () => {});
    const local = t.mock.method(engine, "_initializeLocalVoice", () => assert.fail("Local warmup should not run for server speech"));

    const client = await engine.ensurePiper(VOICE);
    assert.ok(client instanceof ServerTtsClient);
    assert.equal(local.mock.callCount(), 0);
    assert.equal(app.state.piperInstance, client);
    assert.equal(engine.provider, "server");
    await engine.deactivate();
});

test("MP3 bytes and MIME survive decoding while phrase timing follows the decoded duration", async (t) => {
    const { app, engine, sentence } = fixture();
    const encoded = new Uint8Array(128).fill(9).buffer;
    const mp3 = new Blob([encoded], { type: "audio/mpeg" });
    const decoded = decodedAudio(2);
    const syntheses = [];
    const client = {
        synthesize: async (...args) => {
            syntheses.push(args);
            return { encodedBuffer: encoded, blob: mp3, mimeType: "audio/mpeg" };
        },
    };
    app.state.audioCtx = {
        decodeAudioData: async (bytes) => {
            assert.notEqual(bytes, encoded);
            assert.deepEqual(new Uint8Array(bytes), new Uint8Array(encoded));
            return decoded;
        },
    };
    t.mock.method(engine, "ensurePiper", async () => client);

    await engine.buildPiperAudio(sentence, VOICE, sentence.text, synthesisTask(engine, sentence));

    assert.equal(syntheses.length, 1);
    assert.equal(syntheses[0][0], "Hello reader.");
    assert.equal(syntheses[0][1], 1);
    assert.equal(sentence.audioBlob, mp3);
    assert.equal(sentence.audioBlob.type, "audio/mpeg");
    assert.equal(sentence.wavBlob, null);
    assert.equal(sentence.audioBuffer, decoded);
    assert.equal(sentence.audioReady, true);
    assert.deepEqual(sentence.ttsPhraseTimings, [{ blockKey: null, offsetMs: 0, durationMs: 2000 }]);
    assert.deepEqual(sentence.wordBoundaries, [
        { text: "Hello", offsetMs: 0, durationMs: 1000 },
        { text: "reader.", offsetMs: 1000, durationMs: 1000 },
    ]);
    const [cached] = app.state.audioCache.values();
    assert.equal(cached.audioBlob, mp3);
    assert.equal(cached.audioBuffer, decoded);
});

test("PDF block timings include the configured silence between decoded server phrases", async (t) => {
    const { app, engine, sentence } = fixture();
    app.state.currentDocumentType = "pdf";
    const phrases = [
        { text: "First block", blockKey: "readable:0" },
        { text: "Second block", blockKey: "readable:1" },
    ];
    let rendered = 0;
    const client = {
        synthesize: async () => ({
            encodedBuffer: new Uint8Array(128).fill(++rendered).buffer,
            mimeType: "audio/mpeg",
        }),
    };
    app.state.audioCtx = {
        decodeAudioData: async (bytes) => decodedAudio(new Uint8Array(bytes)[0], 1000, new Uint8Array(bytes)[0]),
        createBuffer: (_channels, length, rate) => decodedAudio(length / rate, rate),
    };
    t.mock.method(engine, "ensurePiper", async () => client);
    t.mock.method(engine, "_getSpeechPhraseEntries", async () => phrases);

    await engine.buildPiperAudio(sentence, VOICE, sentence.text, synthesisTask(engine, sentence));

    assert.deepEqual(sentence.ttsPhraseTimings, [
        { blockKey: "readable:0", offsetMs: 0, durationMs: 1000 },
        { blockKey: "readable:1", offsetMs: 1180, durationMs: 2000 },
    ]);
    assert.equal(sentence.audioBuffer.duration, 3.18);
    assert.equal(sentence.wordBoundaries[2].offsetMs, 1180);
    const samples = sentence.audioBuffer.getChannelData(0);
    assert.equal(samples[999], 1);
    assert.equal(samples[1000], 0);
    assert.equal(samples[1179], 0);
    assert.equal(samples[1180], 2);
});

test("cancelled audio decoding cannot mark a phrase ready or populate its cache", async (t) => {
    const { app, engine, sentence } = fixture();
    const decoding = deferred();
    const decodingStarted = deferred();
    app.state.audioCtx = {
        decodeAudioData: async () => {
            decodingStarted.resolve();
            return decoding.promise;
        },
    };
    t.mock.method(engine, "ensurePiper", async () => ({
        synthesize: async () => ({ encodedBuffer: new ArrayBuffer(128), mimeType: "audio/mpeg" }),
    }));

    const synthesis = engine.buildPiperAudio(sentence, VOICE, sentence.text, synthesisTask(engine, sentence));
    const rejected = assert.rejects(synthesis, { name: "AbortError" });
    await decodingStarted.promise;
    engine.cancelSynthesis();
    decoding.resolve(decodedAudio(2));
    await rejected;

    assert.equal(sentence.audioReady, false);
    assert.equal(sentence.audioBlob, undefined);
    assert.equal(app.state.audioCache.size, 0);
});

test("concurrent server failures share one local activation and do not retry the server for this book", async (t) => {
    const { app, engine, sentence } = fixture({ serverEnabled: true });
    const remote = new ServerTtsClient(app);
    t.mock.getter(remote, "ready", () => true);
    let remoteAttempts = 0;
    let closes = 0;
    t.mock.method(remote, "synthesize", async () => { remoteAttempts++; throw new Error("Server offline"); });
    t.mock.method(remote, "close", async () => { closes++; });
    engine._commitVoice(remote, VOICE, "server");
    const localStarted = deferred();
    const localReady = deferred();
    let localActivations = 0;
    let localAttempts = 0;
    const local = { synthesize: async () => { localAttempts++; return { encodedBuffer: new ArrayBuffer(128) }; } };
    t.mock.method(engine, "_initializeLocalVoice", async () => {
        localActivations++;
        localStarted.resolve();
        await localReady.promise;
        engine._commitVoice(local, VOICE, "local");
        return local;
    });

    const task = synthesisTask(engine, sentence);
    const first = engine._synthesizePhrase("First phrase.", VOICE, task);
    const second = engine._synthesizePhrase("Second phrase.", VOICE, task);
    await localStarted.promise;
    localReady.resolve();
    await Promise.all([first, second]);
    await engine._synthesizePhrase("Next phrase.", VOICE, task);

    assert.equal(remoteAttempts, 2);
    assert.equal(closes, 1);
    assert.equal(localActivations, 1);
    assert.equal(localAttempts, 3);
    assert.equal(engine.provider, "local");
    assert.equal(engine._serverFailed, true);
});

test("a cancelled text lookup cannot start synthesis after a voice or book change", async (t) => {
    const { app, engine, sentence, calls } = fixture();
    const lookup = deferred();
    const started = deferred();
    app.getSentenceSpeechText = async () => {
        started.resolve();
        return lookup.promise;
    };
    const build = t.mock.method(engine, "buildPiperAudio", async () => assert.fail("Cancelled text must not reach inference"));

    const synthesis = engine.synthesizeSequential(0);
    const rejected = assert.rejects(synthesis, { name: "AbortError" });
    await started.promise;
    engine.cancelSynthesis();
    lookup.resolve(sentence.text);
    await rejected;

    assert.equal(build.mock.callCount(), 0);
    assert.equal(sentence.audioReady, false);
    assert.equal(calls.requeues, 0);
});

test("closing while the voice catalogue loads cannot start a local model afterwards", async (t) => {
    const { app, engine } = fixture();
    const catalogue = deferred();
    const started = deferred();
    engine.voices = null;
    t.mock.method(engine, "getVoicesLists", async () => {
        started.resolve();
        return catalogue.promise;
    });
    const local = t.mock.method(engine, "_initializeLocalVoice", () => assert.fail("Closed book must not load its model"));

    const initialization = engine.ensurePiper(VOICE);
    const rejected = assert.rejects(initialization, { name: "AbortError" });
    await started.promise;
    await engine.deactivate();
    catalogue.resolve({ [VOICE]: { files: {} } });
    await rejected;

    assert.equal(local.mock.callCount(), 0);
    assert.equal(engine.client, null);
    assert.equal(app.state.piperInstance, null);
});

test("a failed local fallback surfaces once without restarting or requeuing inference", async (t) => {
    const { app, engine, sentence, calls } = fixture({ serverEnabled: true });
    const remote = new ServerTtsClient(app);
    t.mock.getter(remote, "ready", () => true);
    let remoteAttempts = 0;
    let localAttempts = 0;
    const localError = new Error("Local model unavailable");
    t.mock.method(remote, "synthesize", async () => { remoteAttempts++; throw new Error("Server offline"); });
    t.mock.method(remote, "close", async () => {});
    engine._commitVoice(remote, VOICE, "server");
    app.state.audioCtx = { decodeAudioData: () => assert.fail("No audio was generated") };
    const local = { synthesize: async () => { localAttempts++; throw localError; } };
    const activate = t.mock.method(engine, "_initializeLocalVoice", async () => {
        engine._commitVoice(local, VOICE, "local");
        return local;
    });
    const restart = t.mock.method(engine, "resetEngine", async () => assert.fail("A persistent model failure must not start a retry loop"));

    await assert.rejects(engine.synthesizeSequential(0), localError);

    assert.equal(remoteAttempts, 1);
    assert.equal(localAttempts, 1);
    assert.equal(activate.mock.callCount(), 1);
    assert.equal(restart.mock.callCount(), 0);
    assert.equal(calls.requeues, 0);
    assert.equal(sentence.audioError, localError);
    assert.equal(sentence.audioInProgress, false);
    assert.equal(sentence.audioReady, false);
});

test("an expired server session is reactivated before returning the voice client", async (t) => {
    const { app, engine } = fixture({ serverEnabled: true });
    const remote = new ServerTtsClient(app);
    let ready = false;
    t.mock.getter(remote, "ready", () => ready);
    const configure = t.mock.method(remote, "configure", async () => { ready = true; });
    const local = t.mock.method(engine, "_initializeLocalVoice", () => assert.fail("Session renewal should keep the server provider"));
    engine._commitVoice(remote, VOICE, "server");

    const client = await engine.ensurePiper(VOICE);

    assert.equal(client, remote);
    assert.equal(client.ready, true);
    assert.equal(configure.mock.callCount(), 1);
    assert.deepEqual(configure.mock.calls[0].arguments[0], {
        voiceId: VOICE, lengthScale: 1, modelRevision: engine.modelRevision,
    });
    assert.equal(local.mock.callCount(), 0);
});

test("a failed server speed change switches to local speech before resuming prefetch", async (t) => {
    const { app, engine } = fixture({ serverEnabled: true });
    const remote = new ServerTtsClient(app);
    t.mock.getter(remote, "ready", () => true);
    t.mock.method(remote, "close", async () => {});
    const configure = t.mock.method(remote, "configure", async () => { throw new Error("Server offline"); });
    engine._commitVoice(remote, VOICE, "server");
    app.state.CURRENT_SPEED = 0.5;
    let localActivations = 0;
    const local = { synthesize: async () => ({}) };
    t.mock.method(engine, "_initializeLocalVoice", async () => {
        localActivations++;
        engine._commitVoice(local, VOICE, "local");
        return local;
    });
    const prefetch = t.mock.method(engine, "schedulePrefetch", () => {
        assert.equal(engine.provider, "local");
        assert.equal(app.state.CURRENT_SPEED, 0.5);
    });

    await engine.reconfigure();

    assert.equal(configure.mock.callCount(), 1);
    assert.deepEqual(configure.mock.calls[0].arguments[0], { voiceId: VOICE, lengthScale: 0.5 });
    assert.equal(localActivations, 1);
    assert.equal(prefetch.mock.callCount(), 1);
    assert.equal(engine._serverFailed, true);
});

test("deactivation during a delayed settings response cannot restart prefetch", async (t) => {
    const { app, engine } = fixture({ serverEnabled: true });
    const remote = new ServerTtsClient(app);
    t.mock.getter(remote, "ready", () => true);
    t.mock.method(remote, "close", async () => {});
    engine._commitVoice(remote, VOICE, "server");
    const configured = deferred();
    const started = deferred();
    t.mock.method(remote, "configure", async () => {
        started.resolve();
        return configured.promise;
    });
    const prefetch = t.mock.method(engine, "schedulePrefetch", () => {});

    const configuration = engine.reconfigure();
    await started.promise;
    await engine.deactivate();
    configured.resolve();
    await configuration;

    assert.equal(prefetch.mock.callCount(), 0);
    assert.equal(engine.client, null);
    assert.equal(app.state.piperInstance, null);
});
