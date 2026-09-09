import test from "node:test";
import assert from "node:assert/strict";

import { PDFHeaderFooterDetector } from "../src/modules/pdf/pdfHeaderFooterDetector.js";
import { SentenceParser } from "../src/modules/pdf/sentenceParser.js";
import { PDFRenderer } from "../src/modules/pdf/pdfRenderer.js";

const merge = (boxes) =>
    PDFHeaderFooterDetector.prototype._mergeReadableBoxes.call(
        Object.create(PDFHeaderFooterDetector.prototype),
        boxes,
    );

test("clicking an uncertain region or either plus only adds it as text", async () => {
    const element = () => ({
        style: {}, children: [], listeners: {},
        setAttribute() {},
        querySelector() { return null; },
        appendChild(child) { this.children.push(child); },
        addEventListener(type, listener) { this.listeners[type] = listener; },
    });
    const container = element();
    const previousDocument = globalThis.document;
    globalThis.document = { querySelector: () => container, createElement: element };
    const detector = Object.create(PDFHeaderFooterDetector.prototype);
    detector.app = { state: { viewportDisplayByPage: new Map([[1, { width: 100, height: 100 }]]) } };
    const labels = [];
    detector.setDetectionLabel = async (...args) => labels.push(args);
    try {
        detector._drawNotSureTextControls(1, [{
            label: "not-sure-text", normalized: { left: 0, top: 0, right: 1, bottom: 1 },
        }]);
        const region = container.children[0].children[0];
        for (const target of [region, ...region.children]) {
            let prevented = false;
            let stopped = false;
            target.listeners.click({
                preventDefault: () => { prevented = true; },
                stopPropagation: () => { stopped = true; },
            });
            assert.ok(prevented && stopped);
        }
        assert.deepEqual(labels, [[1, 0, "text"], [1, 0, "text"], [1, 0, "text"]]);
    } finally {
        globalThis.document = previousDocument;
    }
});

test("keeps text, section header, and following text as separate phrases", () => {
    const boxes = merge([
        { x1: 0, y1: 0, x2: 1000, y2: 600, label: "text" },
        { x1: 0, y1: 620, x2: 420, y2: 670, label: "section-header" },
        { x1: 0, y1: 690, x2: 1000, y2: 1090, label: "text" },
    ]);

    assert.deepEqual(
        boxes.map((box) => box.label),
        ["text", "section-header", "text"],
    );
});

test("still merges adjacent blocks with the same label", () => {
    const boxes = merge([
        { x1: 0, y1: 0, x2: 1000, y2: 100, label: "text" },
        { x1: 0, y1: 110, x2: 1000, y2: 210, label: "text" },
    ]);

    assert.equal(boxes.length, 1);
    assert.deepEqual(boxes[0], { x1: 0, y1: 0, x2: 1000, y2: 210, label: "text" });
});

test("does not treat a different-column block as an intervening phrase", () => {
    const boxes = merge([
        { x1: 0, y1: 0, x2: 400, y2: 200, label: "text" },
        { x1: 600, y1: 210, x2: 1000, y2: 250, label: "section-header" },
        { x1: 0, y1: 260, x2: 400, y2: 460, label: "text" },
    ]);

    assert.equal(boxes.filter((box) => box.label === "text").length, 1);
    assert.equal(boxes.filter((box) => box.label === "section-header").length, 1);
});

test("parses text, section header, and following text as separate phrases without punctuation", async () => {
    const state = {
        sentences: [],
        pageSentencesIndex: new Map(),
        generationEnabled: true,
    };
    const readableBoxes = [
        { x1: 0, y1: 0, x2: 500, y2: 20, label: "text" },
        { x1: 0, y1: 30, x2: 500, y2: 50, label: "section-header" },
        { x1: 0, y1: 60, x2: 500, y2: 80, label: "text" },
    ];
    const app = {
        state,
        config: {
            SENTENCE_END: [".", "?", "!"],
            SPLIT_PDF_SENTENCES_ON_LAYOUT_BLOCKS: true,
            SPLIT_ON_LINE_GAP: false,
            SPLIT_ON_WORD_GAP: false,
            BREAK_ON_LINE: false,
        },
        getPdfHeaderFooterDetector: () => ({
            getLayoutRegions: async () => ({ readableBoxes }),
        }),
    };
    const parser = new SentenceParser(app);
    const word = (str, y) => ({ str, x: 10, y, width: 80, height: 10 });

    await parser.parsePageWords(1, {
        pageWords: [word("First text", 15), word("Section header", 45), word("Next text", 75)],
    });

    assert.deepEqual(
        state.sentences.map((sentence) => sentence.originalText),
        ["First text", "Section header", "Next text"],
    );
    assert.deepEqual(
        state.sentences.map((sentence) => sentence.layoutBlockKey),
        ["readable:0", "readable:1", "readable:2"],
    );
});

test("splits PDF phrases at semicolons, including short opening clauses", async () => {
    const state = {
        sentences: [],
        pageSentencesIndex: new Map(),
        generationEnabled: false,
    };
    const app = {
        state,
        config: {
            SENTENCE_END: [".", ":", ";", "?", "!"],
            SPLIT_PDF_SENTENCES_ON_LAYOUT_BLOCKS: false,
            SPLIT_ON_LINE_GAP: false,
            SPLIT_ON_WORD_GAP: false,
            BREAK_ON_LINE: false,
        },
    };
    const parser = new SentenceParser(app);
    const word = (str, x) => ({ str, x, y: 20, width: 40, height: 10 });

    await parser.parsePageWords(1, {
        pageWords: [word("First;", 10), word("second", 60), word("phrase.", 110)],
    });

    assert.deepEqual(
        state.sentences.map((sentence) => sentence.originalText),
        ["First;", "second phrase."],
    );
});

test("replays version 1 PDF phrase boundaries for legacy highlights", async () => {
    const state = {
        sentences: [],
        pageSentencesIndex: new Map(),
        generationEnabled: false,
        phraseSplitVersion: 1,
    };
    const app = {
        state,
        config: {
            SENTENCE_END: [".", ":", "?", "!"],
            SPLIT_PDF_SENTENCES_ON_LAYOUT_BLOCKS: false,
            SPLIT_ON_LINE_GAP: false,
            SPLIT_ON_WORD_GAP: false,
            BREAK_ON_LINE: false,
        },
    };
    const parser = new SentenceParser(app);
    const word = (str, x) => ({ str, x, y: 20, width: 40, height: 10 });

    await parser.parsePageWords(1, {
        pageWords: [word("First;", 10), word("second", 60), word("phrase.", 110)],
    });

    assert.deepEqual(state.sentences.map(({ originalText }) => originalText), ["First; second phrase."]);
});

test("resolves whitespace between lines to the nearest sentence in the same layout block", () => {
    const upperSentence = {
        index: 0,
        pageNumber: 1,
        words: [{ str: "Upper", x: 10, y: 20, width: 80, height: 10, isReadable: true }],
    };
    const lowerSentence = {
        index: 1,
        pageNumber: 1,
        words: [
            { str: "Line one", x: 10, y: 75, width: 100, height: 10, isReadable: true },
            { str: "Line two", x: 10, y: 95, width: 100, height: 10, isReadable: true },
        ],
    };
    const state = {
        sentences: [upperSentence, lowerSentence],
        pageSentencesIndex: new Map([[1, [0, 1]]]),
    };
    const renderer = Object.create(PDFRenderer.prototype);
    renderer.app = {
        state,
        config: { SPLIT_PDF_AUDIO_ON_LAYOUT_BLOCKS: true },
    };
    renderer._getCachedReadableLayoutBoxes = () => [
        { x1: 0, y1: 0, x2: 500, y2: 30, label: "text" },
        { x1: 0, y1: 60, x2: 500, y2: 110, label: "text" },
    ];

    const index = renderer.getNearestSentenceIndexForLayoutBlock(1, "readable:1", 50, 80);

    assert.equal(index, 1);
});

test("builds separate translation entries at a section-header boundary", () => {
    const sentence = {
        pageNumber: 1,
        words: [
            {
                str: "Gestell é um termo utilizado ... Bacon, 1973, p. 94.",
                x: 10,
                y: 20,
                width: 300,
                height: 10,
                isReadable: true,
            },
            { str: "2. DA TÉCNICA E DA CIÊNCIA", x: 10, y: 50, width: 220, height: 10, isReadable: true },
            { str: "Motor central do processo", x: 10, y: 80, width: 220, height: 10, isReadable: true },
        ],
    };
    const renderer = Object.create(PDFRenderer.prototype);
    renderer.app = {
        config: { SPLIT_PDF_AUDIO_ON_LAYOUT_BLOCKS: true },
        sentenceParser: { joinWords: (words) => words.map((word) => word.str).join(" ") },
    };
    renderer._getCachedReadableLayoutBoxes = () => [
        { x1: 0, y1: 70, x2: 500, y2: 90, label: "text" },
        { x1: 0, y1: 40, x2: 500, y2: 60, label: "section-header" },
        { x1: 0, y1: 0, x2: 500, y2: 30, label: "text" },
    ];

    const entries = renderer.getLayoutPhraseEntriesForSentence(sentence);

    assert.deepEqual(
        entries.map(({ blockKey, text }) => ({ blockKey, text })),
        [
            { blockKey: "readable:2", text: "Gestell é um termo utilizado ... Bacon, 1973, p. 94." },
            { blockKey: "readable:1", text: "2. DA TÉCNICA E DA CIÊNCIA" },
            { blockKey: "readable:0", text: "Motor central do processo" },
        ],
    );
});

test("uses separately translated layout entries for speech and popup timing", async () => {
    globalThis.window = globalThis.window || {};
    const { TTSEngine } = await import("../src/modules/tts/ttsEngine.js");
    const engine = Object.create(TTSEngine.prototype);
    engine.app = {
        state: { currentDocumentType: "pdf" },
        config: { SPLIT_PDF_AUDIO_ON_LAYOUT_BLOCKS: true },
        isReadTranslationEnabled: () => true,
    };
    const sentence = {
        readTranslationPhraseEntries: [
            { blockKey: "readable:0", text: "Translated paragraph" },
            { blockKey: "readable:1", text: "Translated section heading" },
        ],
    };

    const entries = await engine._getSpeechPhraseEntries(sentence, "combined fallback");

    assert.deepEqual(entries, sentence.readTranslationPhraseEntries);
});

test("uses translated speech even when layout block metadata is not ready", async () => {
    globalThis.window = globalThis.window || {};
    const { TTSEngine } = await import("../src/modules/tts/ttsEngine.js");
    const engine = Object.create(TTSEngine.prototype);
    engine.app = {
        state: { currentDocumentType: "pdf" },
        config: { SPLIT_PDF_AUDIO_ON_LAYOUT_BLOCKS: true },
        isReadTranslationEnabled: () => true,
    };
    const sentence = {
        readTranslationPhraseEntries: [
            { blockKey: null, text: "Parágrafo traduzido" },
        ],
    };

    const entries = await engine._getSpeechPhraseEntries(sentence, "Original English paragraph");

    assert.deepEqual(entries, sentence.readTranslationPhraseEntries);
});

test("queues the selected PDF sentence before scheduling TTS prefetch", async () => {
    const events = [];
    const sentence = {
        index: 0,
        pageNumber: 1,
        layoutProcessed: true,
        isTextToRead: true,
    };
    const renderer = Object.create(PDFRenderer.prototype);
    renderer.pageCoordinateSystems = new Map([[1, "baseline"]]);
    renderer.updateHighlightFullDoc = () => {};
    renderer.scrollSentenceIntoView = () => {};
    renderer.app = {
        state: {
            sentences: [sentence],
            generationEnabled: true,
            currentSentenceIndex: -1,
        },
        ttsQueue: {
            add: (index, priority) => events.push(`add:${index}:${priority}`),
            run: () => events.push("run"),
        },
        ttsEngine: {
            schedulePrefetch: () => events.push("prefetch"),
        },
        progressManager: { saveProgress: () => {} },
        eventBus: { emit: () => {} },
        ui: { showInfo: () => {} },
    };

    const previousDocument = globalThis.document;
    globalThis.document = { getElementById: () => null };
    try {
        await renderer.renderSentence(0);
    } finally {
        globalThis.document = previousDocument;
    }

    assert.deepEqual(events, ["add:0:true", "run", "prefetch"]);
});
