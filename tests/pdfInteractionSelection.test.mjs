import test from "node:test";
import assert from "node:assert/strict";

import { InteractionHandler } from "../src/modules/ui/interactionHandler.js";

const handler = () => Object.create(InteractionHandler.prototype);

test("uncertain layout taps do not select a phrase or begin text selection", async () => {
    const interaction = handler();
    interaction.app = { state: { currentDocumentType: "pdf", viewMode: "full" } };
    const event = {
        button: 0,
        target: {
            closest(selector) {
                assert.ok(selector.includes(".not-sure-layout-region"));
                return this;
            },
        },
    };
    await interaction.handlePointerClick(event);
    interaction._startPdfDragSelection(event);
    assert.equal(interaction._textSelect, undefined);
});

const line = (number) => {
    const words = ["one", "two", "three", "four"].map((text, index) => ({
        text: `${number}-${text}`,
        leftPx: index * 20,
        widthPx: 10,
        sentenceIndex: number,
    }));
    return { topPx: number * 20, bottomPx: number * 20 + 10, leftPx: 0, rightPx: 70, words };
};

test("keeps partial endpoints and complete intervening lines when dragging down", () => {
    const interaction = handler();
    const selected = interaction._selectWordsBetweenEndpoints([line(0), line(1), line(2)], 0, 2, 22, 42);

    assert.deepEqual(selected.map(({ words }) => words.map(({ text }) => text)), [
        ["0-two", "0-three", "0-four"],
        ["1-one", "1-two", "1-three", "1-four"],
        ["2-one", "2-two", "2-three"],
    ]);
    assert.deepEqual(
        selected.map(({ leftPx, rightPx }) => [leftPx, rightPx]),
        [
            [20, 70],
            [0, 70],
            [0, 50],
        ],
    );
});

test("keeps partial endpoints and complete intervening lines when dragging up", () => {
    const interaction = handler();
    const selected = interaction._selectWordsBetweenEndpoints(
        [line(0), line(1), line(2), line(3), line(4)],
        4,
        0,
        22,
        42,
    );

    assert.deepEqual(selected.map(({ words }) => words.map(({ text }) => text)), [
        ["0-three", "0-four"],
        ["1-one", "1-two", "1-three", "1-four"],
        ["2-one", "2-two", "2-three", "2-four"],
        ["3-one", "3-two", "3-three", "3-four"],
        ["4-one", "4-two"],
    ]);
});

test("keeps the correct partial endpoints when a multiline drag moves right to left", () => {
    const interaction = handler();
    const selected = interaction._selectWordsBetweenEndpoints([line(0), line(1), line(2)], 0, 2, 62, 22);

    assert.deepEqual(selected.map(({ words }) => words.map(({ text }) => text)), [
        ["0-four"],
        ["1-one", "1-two", "1-three", "1-four"],
        ["2-one", "2-two"],
    ]);
});

test("limits a same-line selection to its horizontal endpoints", () => {
    const interaction = handler();
    const selected = interaction._selectWordsBetweenEndpoints([line(0)], 0, 0, 62, 22);

    assert.deepEqual(selected[0].words.map(({ text }) => text), ["0-two", "0-three", "0-four"]);
});

test("Ctrl+C copies the custom selection before the current phrase", async () => {
    const interaction = handler();
    interaction.app = { state: { currentDocumentType: "pdf", viewMode: "full" } };
    interaction._textSelect = { selectedTextOneLine: "mouse selection", selectedText: "" };
    interaction.getCurrentPhraseTextForCopy = () => "current phrase";

    let copied = null;
    interaction._copyTextToClipboard = async (text, options) => {
        copied = { text, options };
    };
    let prevented = false;
    await interaction._handleSelectionCopyShortcut({
        ctrlKey: true,
        metaKey: false,
        code: "KeyC",
        key: "c",
        target: { tagName: "DIV", isContentEditable: false },
        preventDefault: () => {
            prevented = true;
        },
    });

    assert.equal(prevented, true);
    assert.deepEqual(copied, { text: "mouse selection", options: { successMessage: "Selection copied" } });
});

test("splits words from two columns that share the same baseline", () => {
    const interaction = handler();
    const combinedLine = {
        topPx: 20,
        bottomPx: 30,
        leftPx: 0,
        rightPx: 150,
        layoutFlowKey: null,
        words: [
            { text: "left one", leftPx: 0, widthPx: 20, heightPx: 10 },
            { text: "left two", leftPx: 25, widthPx: 20, heightPx: 10 },
            { text: "right one", leftPx: 100, widthPx: 20, heightPx: 10 },
            { text: "right two", leftPx: 125, widthPx: 25, heightPx: 10 },
        ],
    };

    const lines = interaction._splitLineAtColumnGaps(combinedLine);

    assert.deepEqual(lines.map(({ words }) => words.map(({ text }) => text)), [
        ["left one", "left two"],
        ["right one", "right two"],
    ]);
    assert.equal(interaction._findLineIndexAtPoint(lines, 130, 25), 1);
});

test("keeps a vertical selection inside its detected layout column", () => {
    const interaction = handler();
    const lines = [
        { ...line(0), layoutFlowKey: "readable:left" },
        { ...line(0), leftPx: 100, rightPx: 170, layoutFlowKey: "readable:right" },
        { ...line(1), layoutFlowKey: "readable:left" },
        { ...line(1), leftPx: 100, rightPx: 170, layoutFlowKey: "readable:right" },
        { ...line(2), layoutFlowKey: "readable:left" },
        { ...line(2), leftPx: 100, rightPx: 170, layoutFlowKey: "readable:right" },
    ];

    const flow = interaction._getLinesForLayoutFlow(lines, 0, 4);

    assert.equal(flow.lines.length, 3);
    assert.ok(flow.lines.every(({ layoutFlowKey }) => layoutFlowKey === "readable:left"));
    assert.deepEqual([flow.startLineIdx, flow.endLineIdx], [0, 2]);
});

test("keeps a vertical selection inside a geometric column without layout metadata", () => {
    const interaction = handler();
    const lines = [
        { ...line(0), leftPx: 0, rightPx: 70, layoutFlowKey: null },
        { ...line(0), leftPx: 100, rightPx: 170, layoutFlowKey: null },
        { ...line(1), leftPx: 0, rightPx: 70, layoutFlowKey: null },
        { ...line(1), leftPx: 100, rightPx: 170, layoutFlowKey: null },
        { ...line(2), leftPx: 0, rightPx: 70, layoutFlowKey: null },
        { ...line(2), leftPx: 100, rightPx: 170, layoutFlowKey: null },
    ];

    const flow = interaction._getLinesForLayoutFlow(lines, 1, 5);

    assert.equal(flow.lines.length, 3);
    assert.ok(flow.lines.every(({ leftPx }) => leftPx === 100));
    assert.deepEqual([flow.startLineIdx, flow.endLineIdx], [0, 2]);
});
