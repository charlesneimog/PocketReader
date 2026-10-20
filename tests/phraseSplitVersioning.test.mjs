import test from "node:test";
import assert from "node:assert/strict";

import {
    CURRENT_PHRASE_SPLIT_VERSION,
    PHRASE_SPLIT_HISTORY,
    ignoresParenthesizedPunctuation,
} from "../src/modules/phrases/phraseSplitVersions.js";
import { HighlightsStorage } from "../src/modules/storage/highlightsStorage.js";
import { AudioManager } from "../src/modules/tts/audioManager.js";

test("keeps an append-only phrase split history with the current version", () => {
    assert.deepEqual(
        PHRASE_SPLIT_HISTORY.map(({ version }) => version),
        [1, 2, 3],
    );
    assert.equal(CURRENT_PHRASE_SPLIT_VERSION, 3);
    assert.equal(Object.isFrozen(PHRASE_SPLIT_HISTORY), true);
});

test("protects parenthesized punctuation only in the new phrase split version", () => {
    assert.equal(ignoresParenthesizedPunctuation(1), false);
    assert.equal(ignoresParenthesizedPunctuation(2), false);
    assert.equal(ignoresParenthesizedPunctuation(3), true);
    assert.equal(ignoresParenthesizedPunctuation(undefined), true);
});

test("treats unversioned highlights as version 1 and stamps new highlights", () => {
    const values = new Map([[3, { color: "yellow", text: "Old phrase" }]]);
    const app = {
        config: { HIGHLIGHTS_STORAGE_KEY: "test-highlights" },
        state: {
            phraseSplitVersion: 2,
            savedHighlights: values,
            currentDocumentType: "pdf",
            currentPdfKey: "book",
        },
    };
    const storage = new HighlightsStorage(app);

    assert.equal(storage.getPhraseSplitVersion("book", values), 1);
    values.set(4, { color: "blue", text: "New phrase", phraseSplitVersion: 2 });
    assert.equal(storage.getPhraseSplitVersion("book", values), 1);
    storage._stampPhraseSplitVersion(values);
    assert.equal(values.get(3).phraseSplitVersion, 2);
});

test("announces reading only when a reading run starts", () => {
    const begunMessages = [];
    const finishedMessages = [];
    const preparationMessages = [];
    const manager = Object.create(AudioManager.prototype);
    manager.app = {
        state: { currentDocumentType: "pdf" },
        ui: {
            beginPlaybackPreparation: (message) => begunMessages.push(message),
            finishPlaybackPreparation: (message) => finishedMessages.push(message),
            updatePlaybackPreparation: (message) => preparationMessages.push(message),
        },
    };

    manager._beginPlaybackPreparationForStart({ continuesReading: false });
    manager._beginPlaybackPreparationForStart({ continuesReading: true });
    manager._updatePlaybackPreparationForStart({ continuesReading: false });
    manager._updatePlaybackPreparationForStart({ continuesReading: true });
    manager._finishPlaybackPreparationForStart({ continuesReading: false });
    manager._finishPlaybackPreparationForStart({ continuesReading: true });

    assert.deepEqual(begunMessages, ["Checking page layout…"]);
    assert.deepEqual(preparationMessages, ["Starting reading…"]);
    assert.deepEqual(finishedMessages, ["Reading started.", ""]);
});
