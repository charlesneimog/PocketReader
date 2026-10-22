import test from "node:test";
import assert from "node:assert/strict";
import { RewardsController } from "../src/modules/rewards/index.js";

function readingPhraseController({ type = "pdf", session = null } = {}) {
    const recorded = [];
    const controller = Object.create(RewardsController.prototype);
    controller.adapter = {
        getDocumentDescriptor: () => ({ id: "book-1", type }),
    };
    controller.app = {
        state: {
            currentSentenceIndex: 1,
            playingSentenceIndex: 0,
            sentences: [
                { text: "Original text.", readableText: "  First\nread phrase. ", cfi: "epubcfi(/6/2!/4/2)" },
                { text: "Next phrase has not played yet." },
            ],
        },
    };
    controller.sessions = {
        getCurrentSession: () => session,
        recordReadingPhrase: async (phrase, sessionId) => recorded.push({ phrase, sessionId }),
    };
    return { controller, recorded };
}

test("playback records its phrase index rather than the next displayed sentence", async () => {
    const { controller, recorded } = readingPhraseController({
        session: { id: "tree-1", automatic: true, state: "active", document: { id: "book-1" } },
    });
    await controller._recordReadingPhrase({ index: 0 });
    assert.deepEqual(recorded, [{
        phrase: { documentId: "book-1", location: 0, text: "First read phrase." },
        sessionId: "tree-1",
    }]);
});

test("the first phrase is captured before automatic tree creation finishes", async () => {
    const { controller, recorded } = readingPhraseController({ type: "epub" });
    let finishStarting;
    controller._ensureAutomaticTree = () => new Promise((resolve) => { finishStarting = resolve; });
    const pending = controller._recordReadingPhrase({ index: 0 });
    controller.app.state.sentences[0].readableText = "Changed while starting.";
    controller.app.state.currentSentenceIndex = 1;
    finishStarting({ id: "tree-1", state: "active", document: { id: "book-1" } });
    await pending;
    assert.deepEqual(recorded, [{
        phrase: { documentId: "book-1", location: "epubcfi(/6/2!/4/2)", text: "First read phrase." },
        sessionId: "tree-1",
    }]);
});

test("a phrase cannot spill into a different document while its tree starts", async () => {
    const { controller, recorded } = readingPhraseController();
    controller._ensureAutomaticTree = async () => ({
        id: "tree-2", state: "active", document: { id: "book-2" },
    });
    await controller._recordReadingPhrase({ index: 0 });
    assert.deepEqual(recorded, []);
});

test("a document switch during automatic startup retains the new document's first phrase", async () => {
    const { controller, recorded } = readingPhraseController();
    let checks = 0;
    controller._ensureAutomaticTree = async () => ({
        id: "tree-1", state: "active", document: { id: ++checks === 1 ? "previous-book" : "book-1" },
    });
    await controller._recordReadingPhrase({ index: 0 });
    assert.equal(checks, 2);
    assert.deepEqual(recorded, [{
        phrase: { documentId: "book-1", location: 0, text: "First read phrase." },
        sessionId: "tree-1",
    }]);
});

test("continuous TTS resumes a stale automatic reward pause", async () => {
    let resumed = false;
    const controller = Object.create(RewardsController.prototype);
    controller.automaticStartPromise = null;
    controller.app = {
        state: { isPlaying: true, autoAdvanceActive: true },
        ui: { showInfo() {} },
    };
    controller.sessions = {
        ensureAutomatic: async () => ({
            id: "session-1",
            state: "paused",
            pauseReason: "explicit",
        }),
        resume: async () => {
            resumed = true;
            return { id: "session-1", state: "active", pauseReason: null };
        },
    };
    controller._refresh = () => {};

    const session = await controller._ensureAutomaticTree();

    assert.equal(resumed, true);
    assert.equal(session.state, "active");
});

test("account snapshots preserve trees but exclude unfinished sessions", () => {
    const controller = Object.create(RewardsController.prototype);
    const safe = controller._syncSafeSnapshot({
        currentSession: { id: "live", state: "active" },
        sessions: [
            { id: "live", state: "active" },
            { id: "paused", state: "paused" },
            { id: "done", state: "completed" },
        ],
        plants: [{ id: "tree", speciesId: "minute-sprout", stage: "mature" }],
    });

    assert.equal(safe.currentSession, null);
    assert.deepEqual(safe.sessions, []);
    assert.equal(safe.plants.length, 1);
    assert.equal(safe.plants[0].id, "tree");
});

test("historical trees do not become mandatory reflection popups on startup", () => {
    const controller = Object.create(RewardsController.prototype);
    controller.pendingTreeNotifications = [];
    controller.notifiedTreeIds = new Set();
    controller.storage = {
        getSnapshot: () => ({
            plants: [
                { id: "old-tree-without-note", stage: "mature", completedAt: 1, reflectionRequired: true },
                { id: "growing-tree", stage: "young", completedAt: null },
            ],
        }),
    };

    controller._rememberHistoricalTrees();

    assert.deepEqual(controller.pendingTreeNotifications, []);
    assert.deepEqual([...controller.notifiedTreeIds], ["old-tree-without-note"]);
});

test("a new PDF tree reflection remembers the text position where it was written", () => {
    const controller = Object.create(RewardsController.prototype);
    controller.app = {
        state: {
            currentDocumentType: "pdf",
            currentSentenceIndex: 7,
            sentences: Array.from({ length: 8 }, (_, index) => index === 7
                ? { pageNumber: 3, text: "The final sentence in this reading block." }
                : null),
        },
    };
    controller.adapter = {
        getDocumentDescriptor: () => ({ id: "book-1", type: "pdf" }),
    };

    assert.deepEqual(controller._captureReflectionAnchor("book-1"), {
        documentType: "pdf",
        sentenceIndex: 7,
        pageNumber: 3,
        text: "The final sentence in this reading block.",
    });
    assert.equal(controller._captureReflectionAnchor("another-book"), null);
});

test("removing a mature tree creates a sync-safe tombstone and clears pending prompts", async () => {
    const state = {
        plants: [{
            id: "tree-1",
            speciesId: "minute-sprout",
            stage: "mature",
            plotId: "garden-1",
            cell: { x: 0, y: 0 },
            reflectionRequired: true,
            updatedAt: 1,
        }],
        sessions: [{ id: "session-1", plantId: "tree-1" }],
        reflections: [],
    };
    const emitted = [];
    const notices = [];
    const controller = Object.create(RewardsController.prototype);
    controller.pendingTreeNotifications = [{ id: "tree-1" }];
    controller.notifiedTreeIds = new Set();
    controller.storage = {
        transaction: async (mutator) => mutator(state),
    };
    controller._refresh = () => {};
    controller._queueSync = (immediate) => assert.equal(immediate, true);
    controller.app = {
        eventBus: { emit: (...args) => emitted.push(args) },
        ui: { showInfo: (message) => notices.push(message) },
    };

    const removed = await controller.removeTree("tree-1");

    assert.equal(removed.id, "tree-1");
    assert.ok(Number.isFinite(state.plants[0].deletedAt));
    assert.equal(state.plants[0].plotId, null);
    assert.equal(state.plants[0].cell, null);
    assert.equal(state.plants[0].reflectionRequired, false);
    assert.equal(state.sessions.length, 1);
    assert.deepEqual(controller.pendingTreeNotifications, []);
    assert.equal(controller.notifiedTreeIds.has("tree-1"), true);
    assert.equal(emitted[0][0], "rewards:garden:updated");
    assert.deepEqual(notices, ["Tree removed from your garden."]);
});

test("automatic completion queues the reflection until the next sentence boundary", async () => {
    const lifecycle = [];
    const controller = Object.create(RewardsController.prototype);
    controller.automaticCompletionPromise = null;
    controller.pendingTreeNotifications = [];
    controller.notifiedTreeIds = new Set();
    controller.sessions = {
        getCurrentSession: () => ({ automatic: true, activeReadingMs: 60000, goalMs: 60000 }),
        complete: async () => {
            lifecycle.push("tree-completed");
            return { plant: { id: "tree-1", speciesId: "minute-sprout" } };
        },
        ensureAutomatic: async () => lifecycle.push("next-tree-created"),
    };
    controller._refresh = () => lifecycle.push("refreshed");
    controller.app = { ui: { showInfo: () => {} } };

    await controller._completeAutomaticTree();

    assert.deepEqual(lifecycle, [
        "tree-completed",
        "next-tree-created",
        "refreshed",
    ]);
    assert.deepEqual(controller.pendingTreeNotifications, [
        { id: "tree-1", speciesId: "minute-sprout" },
    ]);
});

test("a reading boundary waits for tree completion before opening its reflection", async () => {
    const lifecycle = [];
    let finishCompletion;
    const controller = Object.create(RewardsController.prototype);
    controller.readingBoundaryPromise = null;
    controller.automaticCompletionPromise = new Promise((resolve) => {
        finishCompletion = () => {
            lifecycle.push("tree-finalized");
            resolve();
        };
    });
    controller._flushTreeNotification = async () => lifecycle.push("prompt-opened");

    const boundary = controller.handleReadingBoundary();
    await Promise.resolve();
    assert.deepEqual(lifecycle, []);

    finishCompletion();
    await boundary;
    assert.deepEqual(lifecycle, ["tree-finalized", "prompt-opened"]);
});

test("a tree reflection includes only highlights created during its reading session", () => {
    const controller = Object.create(RewardsController.prototype);
    controller.adapter = {
        getDocumentDescriptor: () => ({ id: "book-1", type: "pdf" }),
    };
    controller.app = {
        state: {
            sentences: [
                { text: "An old passage." },
                { text: "First session passage." },
                { text: "Second session passage." },
                { text: "A later passage." },
            ],
            savedHighlights: new Map([
                [0, { text: "An old passage.", timestamp: 99 }],
                [2, { sentenceText: "Second session passage.", color: "#81c784", timestamp: 180 }],
                [1, { text: "First session passage.", color: "#ffda76", timestamp: 120 }],
                [3, { text: "A later passage.", timestamp: 201 }],
            ]),
        },
    };

    const highlights = controller._getSessionHighlights({
        document: { id: "book-1", type: "pdf" },
        startedAt: 100,
        completedAt: 200,
    });

    assert.deepEqual(highlights, [
        { text: "First session passage.", color: "#ffda76" },
        { text: "Second session passage.", color: "#81c784" },
    ]);
});

test("a tree reflection does not borrow highlights from another open document", () => {
    const controller = Object.create(RewardsController.prototype);
    controller.adapter = {
        getDocumentDescriptor: () => ({ id: "book-2", type: "pdf" }),
    };
    controller.app = {
        state: {
            savedHighlights: new Map([[0, { text: "Wrong book.", timestamp: 150 }]]),
        },
    };

    assert.deepEqual(controller._getSessionHighlights({
        document: { id: "book-1", type: "pdf" },
        startedAt: 100,
        completedAt: 200,
    }), []);
});

test("earned-tree prompt pauses reading and playback until the required paragraph is saved", async () => {
    const announcements = [];
    const notePrompts = [];
    const lifecycle = [];
    const controller = Object.create(RewardsController.prototype);
    controller.reflectionPromptPromise = null;
    controller.reflectionResumeState = null;
    controller.pendingTreeNotifications = [
        { id: "tree-1", speciesId: "reading-sapling", sessionId: "session-1" },
    ];
    controller.storage = {
        getSnapshot: () => ({
            sessions: [{ id: "session-1" }],
            reflections: [],
        }),
    };
    controller.reflectionDialog = {
        isOpen: () => false,
        open: (session, summary) => notePrompts.push({ session, summary }),
    };
    controller.panel = {
        announce: (key, message) => announcements.push({ key, message }),
    };
    const nextSession = { id: "session-2", state: "active", pauseReason: null };
    controller.sessions = {
        getCurrentSession: () => nextSession,
        pause: async ({ reason }) => {
            nextSession.state = "paused";
            nextSession.pauseReason = reason;
            lifecycle.push("reading-paused");
        },
        resume: async () => {
            nextSession.state = "active";
            nextSession.pauseReason = null;
            lifecycle.push("reading-resumed");
        },
    };
    controller.app = {
        state: { isPlaying: true, autoAdvanceActive: true },
        audioManager: {
            addPlaybackBlock: async (reason) => {
                controller.app.state.isPlaying = false;
                controller.app.state.autoAdvanceActive = false;
                lifecycle.push(`playback-blocked:${reason}`);
            },
            removePlaybackBlock: (reason) => lifecycle.push(`playback-unblocked:${reason}`),
            playCurrentSentence: async () => lifecycle.push("playback-resumed"),
        },
    };
    controller.adapter = {
        _updateReadingScreen: () => lifecycle.push("screen-updated"),
        getDocumentDescriptor: () => ({ id: "doc" }),
    };

    assert.deepEqual(notePrompts, []);
    await controller._flushTreeNotification();

    assert.deepEqual(announcements, [{
        key: "tree-earned:tree-1",
        message: "You earned one Reading Tree — Reading Sapling.",
    }]);
    assert.deepEqual(notePrompts, [{
        session: { id: "session-1" },
        summary: "Reading Sapling was added to your garden. Reading is paused until you save its paragraph.",
    }]);
    assert.deepEqual(lifecycle, ["playback-blocked:required-reflection", "reading-paused"]);
    assert.equal(nextSession.pauseReason, "reflection");

    await controller._resumeAfterRequiredReflection();
    assert.deepEqual(lifecycle, [
        "playback-blocked:required-reflection",
        "reading-paused",
        "playback-unblocked:required-reflection",
        "screen-updated",
        "reading-resumed",
        "playback-resumed",
    ]);
    assert.equal(controller.pendingTreeNotifications.length, 0);
});
