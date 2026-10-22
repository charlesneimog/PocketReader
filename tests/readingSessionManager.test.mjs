import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../src/config.js";
import { EventBus } from "../src/core/eventBus.js";
import { CrossTabSessionLock } from "../src/modules/rewards/crossTabSessionLock.js";
import { GardenManager } from "../src/modules/rewards/gardenManager.js";
import { ReadingSessionManager } from "../src/modules/rewards/readingSessionManager.js";
import { RewardEngine } from "../src/modules/rewards/rewardEngine.js";
import { RewardStorage } from "../src/modules/rewards/rewardStorage.js";
import { StreakManager } from "../src/modules/rewards/streakManager.js";

const AUTOMATIC_TREE_GOAL_MS = CONFIG.REWARDS.treePlantingIntervalMinutes * 60000;

const config = {
    defaultGardenRows: 2, defaultGardenColumns: 2,
    automaticTreesEnabled: true,
    sessionGoalsMinutes: [10], timeRewardIntervalMinutes: 5, timeRewardPoints: 1,
    dailyTimeRewardCap: 12, dailyEngagementRewardCap: 10, sessionCompletionPoints: 4,
    reflectionPoints: 5, annotationWithNotePoints: 3, questionPoints: 3,
    recoveryAfterDays: 7, recoveryPoints: 5, weekStartsOn: 1,
};
class MemoryStorage {
    getItem(key) { return this.values?.get(key) || null; }
    setItem(key, value) { (this.values ||= new Map()).set(key, value); }
    removeItem(key) { this.values?.delete(key); }
}
class Tracker {
    start() {}
    stop() {}
    checkpoint() {}
    setPaused(value) { this.paused = value; }
}

async function fixture(backing = new MemoryStorage()) {
    let id = 0;
    const storage = new RewardStorage({ storage: backing, storageKey: "rewards", config });
    await storage.load();
    const gardenManager = new GardenManager({ randomUUID: () => `plant-${++id}` });
    const engine = new RewardEngine({
        storage, gardenManager, streakManager: new StreakManager(),
        eventBus: new EventBus(), config, randomUUID: () => `tx-${++id}`,
    });
    const tracker = new Tracker();
    const lock = { sessionId: null, acquire(sessionId) { this.sessionId = sessionId; return true; }, release() { this.sessionId = null; } };
    const manager = new ReadingSessionManager({
        storage, rewardEngine: engine, gardenManager, tracker, lock,
        eventBus: new EventBus(), config,
        getDocument: () => ({ id: "doc", type: "pdf", title: "Book", currentLocation: 0, progress: 0 }),
        randomUUID: () => `session-${++id}`,
    });
    return { backing, storage, engine, tracker, lock, manager };
}

test("pause/resume, completion, and completion bonus lifecycle", async () => {
    const item = await fixture();
    const started = await item.manager.start({ goalMinutes: 10, speciesId: "daisy-patch" });
    assert.equal(started.state, "active");
    await item.manager.pause();
    assert.equal(item.manager.getCurrentSession().state, "paused");
    await item.manager.resume();
    assert.equal(item.manager.getCurrentSession().state, "active");
    await item.engine.recordActiveReading({ milliseconds: 600000, sessionId: started.id, documentId: "doc" });
    const completed = await item.manager.complete();
    assert.equal(completed.session.state, "completed");
    assert.equal(item.storage.getSnapshot().rewardLedger.some((entry) => entry.rewardType === "session-completion"), true);
});

test("abandoned sessions retain active rewards but receive no completion bonus", async () => {
    const item = await fixture();
    const session = await item.manager.start({ goalMinutes: 10, speciesId: "daisy-patch" });
    await item.engine.recordActiveReading({ milliseconds: 300000, sessionId: session.id, documentId: "doc" });
    const abandoned = await item.manager.abandon();
    assert.equal(abandoned.state, "abandoned");
    assert.equal(item.storage.getSnapshot().rewardLedger.some((entry) => entry.rewardType === "active-time"), true);
    assert.equal(item.storage.getSnapshot().rewardLedger.some((entry) => entry.rewardType === "session-completion"), false);
});

test("application restart discards an unfinished reading session", async () => {
    const first = await fixture();
    const session = await first.manager.start({ goalMinutes: 10, speciesId: "daisy-patch" });
    await first.engine.recordActiveReading({ milliseconds: 60000, sessionId: session.id, documentId: "doc" });
    const second = await fixture(first.backing);
    const restored = await second.manager.restore();
    const state = second.storage.getSnapshot();
    assert.equal(restored, null);
    assert.equal(state.currentSession, null);
    assert.equal(state.sessions.find((candidate) => candidate.id === session.id).state, "abandoned");
});

test("application restart keeps the tree but resets its unfinished growth", async () => {
    const first = await fixture();
    const session = await first.manager.ensureAutomatic();
    first.tracker.onDelta(AUTOMATIC_TREE_GOAL_MS * 0.3);
    await first.manager.deltaQueue;

    const second = await fixture(first.backing);
    const restored = await second.manager.restore();
    const state = second.storage.getSnapshot();
    const plant = state.plants.find((candidate) => candidate.id === session.plantId);
    assert.equal(restored, null);
    assert.equal(state.currentSession, null);
    assert.equal(plant.growthProgress, 0);
    assert.equal(plant.stage, "seed");
});

test("an explicit pause remains paused during automatic checks and records no time", async () => {
    const item = await fixture();
    const session = await item.manager.ensureAutomatic();
    item.tracker.onDelta(30000);
    await item.manager.deltaQueue;
    await item.manager.pause();
    const pausedAt = item.manager.getCurrentSession().activeReadingMs;

    item.tracker.onDelta(60000);
    await item.manager.deltaQueue;
    const automaticCheck = await item.manager.ensureAutomatic();

    assert.equal(automaticCheck.id, session.id);
    assert.equal(automaticCheck.state, "paused");
    assert.equal(automaticCheck.pauseReason, "explicit");
    assert.equal(automaticCheck.activeReadingMs, pausedAt);
    assert.equal(pausedAt, 30000);
    assert.equal(item.tracker.paused, true);
});

test("focus interruptions reset automatic tree progress without erasing earned reading history", async () => {
    const item = await fixture();
    const session = await item.manager.ensureAutomatic();
    const partialProgressMs = AUTOMATIC_TREE_GOAL_MS * 0.1;
    item.tracker.onDelta(partialProgressMs);
    await item.manager.deltaQueue;
    assert.equal(item.manager.getCurrentSession().activeReadingMs, partialProgressMs);

    await item.tracker.onInterrupted({ reason: "focus-lost" });

    const state = item.storage.getSnapshot();
    const plant = state.plants.find((candidate) => candidate.id === session.plantId);
    assert.equal(state.currentSession.activeReadingMs, 0);
    assert.equal(state.currentSession.lastResetReadingMs, partialProgressMs);
    assert.equal(state.currentSession.lastInterruptionReason, "focus-lost");
    assert.equal(plant.growthProgress, 0);
    assert.equal(plant.stage, "seed");
    assert.equal(state.totalActiveReadingMs, partialProgressMs);
});

test("an explicit pause does not survive application restart", async () => {
    const first = await fixture();
    await first.manager.ensureAutomatic();
    await first.manager.pause();

    const second = await fixture(first.backing);
    const restored = await second.manager.restore();
    assert.equal(restored, null);
    assert.equal(second.manager.getCurrentSession(), null);
    assert.equal(second.tracker.paused, true);
});

test("cross-tab storage lock excludes another owner until release", () => {
    const backing = new MemoryStorage();
    const intervals = [];
    const options = {
        storage: backing, BroadcastChannelClass: null, now: () => 1000,
        setIntervalFn: (callback) => { intervals.push(callback); return intervals.length; },
        clearIntervalFn: () => {},
    };
    const first = new CrossTabSessionLock({ ...options, ownerId: "one" });
    const second = new CrossTabSessionLock({ ...options, ownerId: "two" });
    assert.equal(first.acquire("session-one"), true);
    assert.equal(second.acquire("session-two"), false);
    first.release();
    assert.equal(second.acquire("session-two"), true);
});

test("cross-tab lock keeps native timer functions bound to the global timer host", () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const receivers = [];
    try {
        globalThis.setInterval = function () {
            receivers.push(this);
            return 42;
        };
        globalThis.clearInterval = function () {
            receivers.push(this);
        };
        const lock = new CrossTabSessionLock({
            storage: new MemoryStorage(),
            BroadcastChannelClass: null,
            ownerId: "timer-owner",
        });
        assert.equal(lock.acquire("timer-session"), true);
        lock.release();
        assert.deepEqual(receivers, [globalThis, globalThis]);
    } finally {
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
    }
});

test("automatic reading plants a new tree at the configured interval", async () => {
    const item = await fixture();
    const session = await item.manager.ensureAutomatic();
    assert.equal(session.automatic, true);
    assert.equal(session.goalMs, AUTOMATIC_TREE_GOAL_MS);
    const initialPlant = item.storage.getSnapshot().plants.find((plant) => plant.id === session.plantId);
    assert.equal(initialPlant.speciesId, "minute-sprout");

    await item.engine.recordActiveReading({
        milliseconds: session.goalMs,
        sessionId: session.id,
        documentId: "doc",
    });
    const completed = await item.manager.complete();
    assert.equal(completed.plant.stage, "mature");
    assert.equal(completed.plant.reflectionRequired, true);
    assert.equal(completed.placement.placed, true);
    assert.equal(item.storage.getSnapshot().reflections.length, 0);

    const next = await item.manager.ensureAutomatic();
    assert.equal(next.goalMs, AUTOMATIC_TREE_GOAL_MS);
    assert.equal(item.storage.getSnapshot().plants.find(
        (plant) => plant.id === next.plantId,
    ).speciesId, "reading-sapling");
});

test("automatic sessions adopt catalog changes without manual reset", async () => {
    const item = await fixture();
    await item.manager.start({
        goalMinutes: 5,
        speciesId: "minute-sprout",
        automatic: true,
    });

    const synchronized = await item.manager.ensureAutomatic();
    assert.equal(synchronized.plantId, item.manager.getCurrentSession().plantId);
    assert.equal(synchronized.goalMs, AUTOMATIC_TREE_GOAL_MS);
});

test("an active session imported by account sync reactivates the runtime tracker", async () => {
    const item = await fixture();
    const session = await item.manager.ensureAutomatic();
    item.tracker.paused = true;
    item.lock.sessionId = null;

    const adopted = await item.manager.ensureAutomatic();

    assert.equal(adopted.id, session.id);
    assert.equal(item.tracker.paused, false);
    assert.equal(item.lock.sessionId, session.id);
});

test("read phrases retain reading order and distinct locations while replay deduplicates", async () => {
    const item = await fixture();
    const session = await item.manager.ensureAutomatic();
    assert.deepEqual(session.readingPhrases, []);

    await item.manager.recordReadingPhrase({ documentId: "doc", location: 4, text: "  The first\n phrase.  " });
    await item.manager.pause();
    await item.manager.resume();
    await item.manager.recordReadingPhrase({ documentId: "doc", location: 4, text: "The first phrase." });
    await item.manager.recordReadingPhrase({ documentId: "doc", location: 2, text: "The first phrase." });
    await item.manager.recordReadingPhrase({ documentId: "doc", location: 5, text: "The next phrase." });

    assert.deepEqual(item.manager.getCurrentSession().readingPhrases, [
        { documentId: "doc", location: 4, text: "The first phrase." },
        { documentId: "doc", location: 2, text: "The first phrase." },
        { documentId: "doc", location: 5, text: "The next phrase." },
    ]);
});

test("each completed tree keeps exactly its own read phrases", async () => {
    const item = await fixture();
    const first = await item.manager.ensureAutomatic();
    const firstPhrase = { documentId: "doc", location: 0, text: "The beginning of reading." };
    const lastPhrase = { documentId: "doc", location: 1, text: "The last phrase of the first tree." };
    await item.manager.recordReadingPhrase(firstPhrase);
    await item.engine.recordActiveReading({ milliseconds: first.goalMs, sessionId: first.id, documentId: "doc" });

    const completion = item.manager.complete();
    const pendingPhrase = item.manager.recordReadingPhrase(lastPhrase);
    const completed = await completion;
    await pendingPhrase;
    assert.deepEqual(completed.plant.readingPhrases, [firstPhrase, lastPhrase]);

    const second = await item.manager.ensureAutomatic();
    assert.deepEqual(second.readingPhrases, []);
    const secondPhrase = { documentId: "doc", location: 2, text: "The first phrase of the second tree." };
    await item.manager.recordReadingPhrase(secondPhrase);
    await item.engine.recordActiveReading({ milliseconds: second.goalMs, sessionId: second.id, documentId: "doc" });
    const nextCompleted = await item.manager.complete();

    const state = item.storage.getSnapshot();
    assert.deepEqual(state.plants.find((plant) => plant.id === first.plantId).readingPhrases, [firstPhrase, lastPhrase]);
    assert.deepEqual(nextCompleted.plant.readingPhrases, [secondPhrase]);
});

test("a delayed phrase targets its captured completed tree after the next tree starts", async () => {
    const item = await fixture();
    const first = await item.manager.ensureAutomatic();
    await item.engine.recordActiveReading({ milliseconds: first.goalMs, sessionId: first.id, documentId: "doc" });
    await item.manager.complete();
    const next = await item.manager.ensureAutomatic();
    const phrase = { documentId: "doc", location: 7, text: "A phrase captured before completion." };

    await item.manager.recordReadingPhrase(phrase, first.id);

    const state = item.storage.getSnapshot();
    assert.equal(state.currentSession.id, next.id);
    assert.deepEqual(state.currentSession.readingPhrases, []);
    assert.deepEqual(state.sessions.find((session) => session.id === first.id).readingPhrases, [phrase]);
    assert.deepEqual(state.plants.find((plant) => plant.id === first.plantId).readingPhrases, [phrase]);
});

test("focus resets and document switches preserve phrases already read", async () => {
    const item = await fixture();
    const session = await item.manager.ensureAutomatic();
    const firstPhrase = { documentId: "doc", location: 0, text: "A phrase from the first document." };
    await item.manager.recordReadingPhrase(firstPhrase);
    item.tracker.onDelta(1000);
    await item.manager.deltaQueue;
    await item.manager.resetContinuousProgress({ reason: "tab-hidden" });
    assert.deepEqual(item.manager.getCurrentSession().readingPhrases, [firstPhrase]);

    item.manager.getDocument = () => ({ id: "epub-doc", type: "epub", title: "Another book" });
    const switched = await item.manager.ensureAutomatic();
    const secondPhrase = { documentId: "epub-doc", location: "epubcfi(/6/2!/4/2)", text: "A phrase from the next document." };
    await item.manager.recordReadingPhrase(secondPhrase);

    assert.equal(switched.id, session.id);
    assert.deepEqual(item.manager.getCurrentSession().readingPhrases, [firstPhrase, secondPhrase]);
});

test("completed tree text survives local reload and account sync without session history", async () => {
    const item = await fixture();
    const session = await item.manager.ensureAutomatic();
    const phrase = { documentId: "doc", location: 0, text: "The complete text remains on the tree." };
    await item.manager.recordReadingPhrase(phrase);
    await item.engine.recordActiveReading({ milliseconds: session.goalMs, sessionId: session.id, documentId: "doc" });
    await item.manager.complete();

    const reloaded = await fixture(item.backing);
    const reloadedPlant = reloaded.storage.getSnapshot().plants.find((plant) => plant.id === session.plantId);
    assert.deepEqual(reloadedPlant.readingPhrases, [phrase]);

    const accountSnapshot = item.storage.getSnapshot();
    accountSnapshot.currentSession = null;
    accountSnapshot.sessions = [];
    const otherDevice = await fixture();
    const synchronized = await otherDevice.storage.merge(accountSnapshot);
    assert.deepEqual(synchronized.sessions, []);
    assert.deepEqual(synchronized.plants.find((plant) => plant.id === session.plantId).readingPhrases, [phrase]);
});

test("empty phrases and phrases for abandoned or removed trees are ignored", async () => {
    const item = await fixture();
    const session = await item.manager.ensureAutomatic();
    const phrase = { documentId: "doc", location: 0, text: "A phrase." };
    assert.equal(await item.manager.recordReadingPhrase({ ...phrase, text: " \n " }), null);
    assert.equal(await item.manager.recordReadingPhrase({ ...phrase, location: -1 }), null);
    await item.manager.abandon();
    assert.equal(await item.manager.recordReadingPhrase(phrase, session.id), null);

    const next = await item.manager.ensureAutomatic();
    await item.storage.transaction((state) => {
        state.plants.find((plant) => plant.id === next.plantId).deletedAt = Date.now();
    });
    assert.equal(await item.manager.recordReadingPhrase(phrase, next.id), null);
    assert.deepEqual(item.manager.getCurrentSession().readingPhrases, []);
});
