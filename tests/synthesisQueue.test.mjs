import test from "node:test";
import assert from "node:assert/strict";

import { TTSQueueManager } from "../src/modules/tts/synthesisQueue.js";

test("replays the selected cached sentence immediately without synthesizing again", () => {
    let playbackStarts = 0;
    const app = {
        state: {
            sentences: [{ audioReady: true }, { audioReady: true }],
            generationEnabled: true,
            currentSentenceIndex: 0,
            isPlaying: false,
        },
        audioManager: { playCurrentSentence: () => playbackStarts++ },
    };
    const queue = new TTSQueueManager(app);

    queue.add(0, true);
    assert.equal(playbackStarts, 1);
    assert.equal(queue.active, 0);
    assert.deepEqual(queue.queue, []);

    queue.add(0);
    queue.add(1, true);
    app.state.isPlaying = true;
    queue.add(0, true);
    app.state.isPlaying = false;
    app.state.generationEnabled = false;
    queue.add(0, true);
    assert.equal(playbackStarts, 1);
});

test("starts two readable sentences concurrently", async () => {
    const started = [];
    const releases = [];
    const sentences = [0, 1].map((index) => ({
        index,
        layoutProcessed: true,
        isTextToRead: true,
        audioReady: false,
        audioInProgress: false,
    }));
    const app = {
        config: { MAX_CONCURRENT_SYNTH: 2 },
        state: {
            sentences,
            generationEnabled: true,
            currentSentenceIndex: -1,
            isPlaying: false,
            playerState: { LOADING: "loading", DONE: "done" },
        },
        ttsEngine: {
            synthesizeSequential: (index) =>
                new Promise((resolve) => {
                    started.push(index);
                    releases[index] = resolve;
                }),
        },
        ui: { updatePlayButton: () => {} },
        audioManager: { playCurrentSentence: () => {} },
        eventBus: { emit: () => {} },
    };
    const queue = new TTSQueueManager(app);

    queue.add(0, true);
    queue.add(1);

    assert.deepEqual(started, [0, 1]);
    assert.equal(queue.active, 2);
    assert.deepEqual([...queue.inFlight], [0, 1]);

    releases[0]();
    releases[1]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queue.active, 0);
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function readableSentence(index = 0) {
    return { index, layoutProcessed: true, isTextToRead: true, audioReady: false, audioInProgress: false };
}

function queueFixture() {
    const calls = { playback: 0, cancellations: 0, started: [], events: [] };
    const pending = [];
    const app = {
        config: { MAX_CONCURRENT_SYNTH: 1 },
        state: {
            sentences: [readableSentence()],
            generationEnabled: true,
            currentSentenceIndex: 0,
            currentDocumentType: "pdf",
            isPlaying: false,
            playerState: { LOADING: "loading", DONE: "done" },
        },
        ttsEngine: {
            cancelSynthesis: () => calls.cancellations++,
            synthesizeSequential: (index) => {
                const completion = deferred();
                calls.started.push(index);
                pending.push(completion);
                return completion.promise;
            },
        },
        ui: { updatePlayButton: () => {} },
        audioManager: { playCurrentSentence: () => calls.playback++ },
        eventBus: { emit: (...args) => calls.events.push(args) },
    };
    const queue = new TTSQueueManager(app);
    app.ttsQueue = queue;
    return { app, queue, calls, pending };
}

test("late completion after reset cannot play or remove a replacement task at the same index", async () => {
    const { app, queue, calls, pending } = queueFixture();
    queue.add(0, true);
    assert.equal(queue.active, 1);
    const oldSentence = app.state.sentences[0];

    queue.reset();
    app.state.sentences = [readableSentence()];
    queue.add(0, true);
    assert.equal(queue.active, 1);
    assert.equal(pending.length, 2);

    oldSentence.audioReady = true;
    pending[0].resolve();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.playback, 0);
    assert.deepEqual(calls.events, []);
    assert.equal(queue.active, 1);
    assert.deepEqual([...queue.inFlight], [0]);
    assert.ok(calls.cancellations >= 1);

    app.state.sentences[0].audioReady = true;
    pending[1].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.playback, 1);
    assert.equal(queue.active, 0);
    assert.deepEqual([...queue.inFlight], []);
});

test("a rejected task from before reset cannot report an error for the next document", async () => {
    const { app, queue, calls, pending } = queueFixture();
    queue.add(0);
    queue.reset();
    app.state.sentences = [readableSentence()];
    queue.add(0);

    pending[0].reject(new Error("Old book synthesis failed"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.events, []);
    assert.equal(calls.playback, 0);
    assert.equal(queue.active, 1);
    assert.deepEqual([...queue.inFlight], [0]);

    app.state.sentences[0].audioReady = true;
    pending[1].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queue.active, 0);
});

for (const replaceSentence of [false, true]) {
    test(`layout finishing after reset cannot enqueue ${replaceSentence ? "a replacement document" : "the cancelled phrase"}`, async () => {
        const { app, queue, calls } = queueFixture();
        const layout = deferred();
        const oldSentence = app.state.sentences[0];
        oldSentence.layoutProcessed = false;
        oldSentence.pageNumber = 1;
        app.getPdfHeaderFooterDetector = () => ({ ensureReadabilityForPage: () => layout.promise });

        queue.add(0, true);
        assert.equal(calls.started.length, 0);
        queue.reset();
        if (replaceSentence) app.state.sentences = [readableSentence()];
        oldSentence.layoutProcessed = true;
        layout.resolve();
        await new Promise((resolve) => setImmediate(resolve));

        assert.deepEqual(calls.started, []);
        assert.equal(calls.playback, 0);
        assert.equal(queue.active, 0);
        assert.deepEqual(queue.queue, []);
    });
}
