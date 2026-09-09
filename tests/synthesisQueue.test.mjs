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
