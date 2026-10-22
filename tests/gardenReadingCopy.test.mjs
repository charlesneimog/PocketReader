import test from "node:test";
import assert from "node:assert/strict";
import { GardenDialog, readingTextForPlant } from "../src/modules/ui/gardenDialog.js";

function stubElement() {
    const classes = new Set(["hidden"]);
    return {
        textContent: "",
        disabled: false,
        classList: {
            add: (value) => classes.add(value),
            remove: (value) => classes.delete(value),
            contains: (value) => classes.has(value),
            toggle(value, enabled) {
                if (enabled) classes.add(value);
                else classes.delete(value);
            },
        },
    };
}

function createDialog(plant = {
    id: "tree-1",
    speciesId: "reading-sapling",
    sessionId: "session-1",
    readingPhrases: [{ text: "The first phrase." }, { text: "The next phrase." }],
}) {
    const elements = Object.fromEntries([
        "tooltip", "comment", "remove", "copy", "copy-label", "copy-status",
    ].map((name) => [`[data-${name}]`, stubElement()]));
    const dialog = Object.create(GardenDialog.prototype);
    dialog.state = { plants: [plant], sessions: [] };
    dialog.selectedPlantId = plant.id;
    dialog.dialog = {
        querySelector: (selector) => elements[selector],
    };
    return { dialog, elements, plant };
}

function mockGlobal(t, name, value) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
    });
}

test("tree reading text uses only its session and preserves the reading order and repeated phrases", () => {
    const sessions = [
        { id: "other-session", readingPhrases: [{ text: "Another tree's text." }] },
        {
            id: "session-1",
            readingPhrases: [
                { documentId: "book-1", location: "1", text: " First phrase. " },
                { documentId: "book-2", location: "8", text: "A second phrase." },
                { documentId: "book-1", location: "1", text: " First phrase. " },
                { text: "   " },
                null,
            ],
        },
    ];
    assert.equal(
        readingTextForPlant({ sessionId: "session-1" }, sessions),
        " First phrase. \n\nA second phrase.\n\n First phrase. ",
    );
});

test("a synced tree carries its reading text without local sessions", () => {
    const plant = { readingPhrases: [{ text: "Synced reading text." }] };
    assert.equal(readingTextForPlant(plant, []), "Synced reading text.");
    assert.equal(readingTextForPlant({
        ...plant,
        sessionId: "session-1",
    }, [{ id: "session-1", readingPhrases: [{ text: "Local session text." }] }]), "Synced reading text.");
});

test("historic trees and missing sessions have no fabricated reading text", () => {
    assert.equal(readingTextForPlant({ sessionId: "missing" }, []), "");
    assert.equal(readingTextForPlant(null, null), "");
    const { dialog, elements, plant } = createDialog({
        id: "historic-tree",
        speciesId: "reading-sapling",
        reflectionText: "A note is not the original reading text.",
    });
    dialog._showDetails({ plant });
    assert.equal(elements["[data-copy]"].disabled, true);
    assert.equal(elements["[data-copy]"].classList.contains("hidden"), false);
    assert.equal(elements["[data-copy-label]"].textContent, "No recorded text");
});

test("selecting a tree enables copying and selecting an empty cell hides it", () => {
    const { dialog, elements, plant } = createDialog();
    dialog._showDetails({ plant });
    assert.equal(elements["[data-copy]"].disabled, false);
    assert.equal(elements["[data-copy-label]"].textContent, "Copy reading text");
    elements["[data-copy-status]"].textContent = "Reading text copied.";
    dialog._showDetails({ cell: { x: 1, y: 2 } });
    assert.equal(dialog.selectedPlantId, null);
    assert.equal(elements["[data-copy]"].classList.contains("hidden"), true);
    assert.equal(elements["[data-copy-status]"].textContent, "");
});

test("copying sends all recorded phrases to the clipboard and reports success", async (t) => {
    const { dialog, elements } = createDialog();
    let copiedText;
    mockGlobal(t, "navigator", { clipboard: { writeText: async (text) => { copiedText = text; } } });
    dialog._copyTextUsingSelection = () => assert.fail("Clipboard succeeded; no fallback is needed");
    assert.equal(await dialog._copySelectedTreeText(), true);
    assert.equal(copiedText, "The first phrase.\n\nThe next phrase.");
    assert.equal(elements["[data-copy-status]"].textContent, "Reading text copied.");
    assert.equal(elements["[data-copy]"].disabled, false);
});

test("clipboard rejection falls back to a selection inside the modal and cleans it up", async (t) => {
    const { dialog } = createDialog();
    let appended;
    let selected = false;
    let removed = false;
    let focusRestored = false;
    const textarea = {
        style: {},
        focus() {},
        select() { selected = true; },
        remove() { removed = true; },
    };
    dialog.dialog.appendChild = (element) => { appended = element; };
    mockGlobal(t, "navigator", { clipboard: { writeText: async () => { throw new Error("Denied"); } } });
    mockGlobal(t, "document", {
        activeElement: { focus() { focusRestored = true; } },
        createElement: (tag) => {
            assert.equal(tag, "textarea");
            return textarea;
        },
        execCommand: (command) => {
            assert.equal(command, "copy");
            assert.equal(selected, true);
            return true;
        },
    });
    assert.equal(await dialog._copySelectedTreeText(), true);
    assert.equal(appended, textarea);
    assert.equal(textarea.value, "The first phrase.\n\nThe next phrase.");
    assert.equal(removed, true);
    assert.equal(focusRestored, true);
});

test("failed copying reports failure and permits trying again", async (t) => {
    const { dialog, elements } = createDialog();
    mockGlobal(t, "navigator", {});
    dialog._copyTextUsingSelection = () => false;
    assert.equal(await dialog._copySelectedTreeText(), false);
    assert.equal(elements["[data-copy-status]"].textContent, "Could not copy reading text. Please try again.");
    assert.equal(elements["[data-copy]"].disabled, false);
});

test("finishing a copy does not overwrite another selected tree's details", async (t) => {
    const { dialog, elements } = createDialog();
    let finishCopy;
    mockGlobal(t, "navigator", {
        clipboard: { writeText: () => new Promise((resolve) => { finishCopy = resolve; }) },
    });
    const pending = dialog._copySelectedTreeText();
    dialog.selectedPlantId = "another-tree";
    elements["[data-copy-status]"].textContent = "Another tree's status";
    finishCopy();
    assert.equal(await pending, true);
    assert.equal(elements["[data-copy-status]"].textContent, "Another tree's status");
});
