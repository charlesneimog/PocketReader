import { EVENTS } from "../../constants/events.js";
import {
    availablePlantDefinitions,
    getAutomaticTreeTier,
    getPlantStage,
} from "./plantDefinitions.js";
import { SESSION_STATES, sumLedger, uuid } from "./rewardDefinitions.js";

/** Persistent reading-session lifecycle facade. */
export class ReadingSessionManager {
    constructor({
        storage,
        rewardEngine,
        gardenManager,
        tracker,
        lock,
        eventBus,
        config,
        getDocument,
        now = Date.now,
        randomUUID,
    } = {}) {
        this.storage = storage;
        this.rewardEngine = rewardEngine;
        this.gardenManager = gardenManager;
        this.tracker = tracker;
        this.lock = lock;
        this.eventBus = eventBus;
        this.config = config;
        this.getDocument = getDocument;
        this.now = now;
        this.randomUUID = randomUUID;
        this.deltaQueue = Promise.resolve();
        this.lifecycleState = SESSION_STATES.IDLE;
        this.tracker.onDelta = (milliseconds) => {
            this.deltaQueue = this.deltaQueue
                .then(() => this._recordDelta(milliseconds))
                .catch((error) => console.error("[ReadingSessionManager] Active time checkpoint failed", error));
        };
        this.tracker.onIdle = () => this._transitionIdle();
        this.tracker.onActivityResumed = () => this._resumeFromIdle();
        this.tracker.onInterrupted = ({ reason } = {}) =>
            this.resetContinuousProgress({ reason })
                .catch((error) => console.error("[ReadingSessionManager] Focus streak reset failed", error));
    }

    async restore() {
        const state = this.storage.getSnapshot();
        if (!state.currentSession) return null;
        const session = state.sessions.find((candidate) => candidate.id === state.currentSession.id);
        if (!session || [SESSION_STATES.COMPLETED, SESSION_STATES.ABANDONED].includes(session.state)) return null;
        const timestamp = this.now();
        await this.storage.transaction((draft) => {
            const stored = draft.sessions.find((candidate) => candidate.id === session.id);
            if (!stored) return;
            stored.state = SESSION_STATES.ABANDONED;
            stored.pauseReason = "new-app-session";
            stored.activeReadingMs = 0;
            stored.goalReachedAt = null;
            stored.abandonedAt = timestamp;
            stored.updatedAt = timestamp;
            draft.currentSession = null;
            const plant = draft.plants.find((candidate) => candidate.id === stored.plantId);
            if (plant && plant.stage !== "mature") {
                plant.growthProgress = 0;
                plant.stage = "seed";
                plant.updatedAt = timestamp;
            }
        });
        this.tracker.setPaused(true);
        this.tracker.stop();
        this.lock.release();
        this.lifecycleState = SESSION_STATES.IDLE;
        return null;
    }

    prepare() {
        if (!this.getCurrentSession()) this.lifecycleState = SESSION_STATES.PREPARING;
        return this.lifecycleState;
    }

    cancelPreparing() {
        if (!this.getCurrentSession() && this.lifecycleState === SESSION_STATES.PREPARING) {
            this.lifecycleState = SESSION_STATES.IDLE;
        }
    }

    async start({ goalMinutes, speciesId, automatic = false }) {
        const document = this.getDocument?.();
        if (!document?.id || !["pdf", "epub"].includes(document.type)) {
            throw new Error("Open a PDF or EPUB before starting a reading session.");
        }
        const goal = Number(goalMinutes);
        if (!Number.isFinite(goal) || goal <= 0) throw new Error("Unsupported tree goal.");
        if (!automatic && !this.config.sessionGoalsMinutes.includes(goal)) throw new Error("Unsupported session goal.");
        const state = this.storage.getSnapshot();
        if (state.currentSession) throw new Error("A reading session is already in progress.");
        if (!automatic) {
            const totalPoints = sumLedger(state.rewardLedger);
            const selected = availablePlantDefinitions(totalPoints, state.plantUnlocks)
                .find((definition) => definition.id === speciesId);
            if (!selected || selected.locked) throw new Error("That plant species is still locked.");
        }
        const sessionId = uuid(this.randomUUID);
        if (!this.lock.acquire(sessionId)) throw new Error("Another tab already has an active reading session.");
        const timestamp = this.now();
        const previousTimestamp = state.lastValidReadingTimestamp;
        let session;
        try {
            await this.storage.transaction((draft) => {
                let plant = draft.plants.find(
                    (candidate) =>
                        candidate.id === draft.currentGrowingPlantId &&
                        candidate.speciesId === speciesId &&
                        candidate.stage !== "mature",
                );
                if (!plant) {
                    plant = this.gardenManager.createPlant({
                        speciesId,
                        sessionId,
                        document,
                        timestamp,
                    });
                    draft.plants.push(plant);
                } else {
                    plant.sessionId = sessionId;
                    plant.sourceDocumentId = document.id;
                    plant.sourceDocumentType = document.type;
                    plant.updatedAt = timestamp;
                }
                session = {
                    id: sessionId,
                    state: SESSION_STATES.ACTIVE,
                    goalMs: Math.round(goal * 60000),
                    activeReadingMs: 0,
                    readingPhrases: [],
                    pointsEarned: 0,
                    document,
                    plantId: plant.id,
                    startedAt: timestamp,
                    goalReachedAt: null,
                    completedAt: null,
                    abandonedAt: null,
                    automatic: !!automatic,
                    pauseReason: null,
                    updatedAt: timestamp,
                };
                draft.currentGrowingPlantId = plant.id;
                draft.sessions.push(session);
                draft.currentSession = { ...session };
            });
        } catch (error) {
            this.lock.release();
            throw error;
        }
        this.tracker.setPaused(false);
        this.tracker.start();
        this.lifecycleState = SESSION_STATES.ACTIVE;
        this.eventBus?.emit(EVENTS.PLANT_SELECTED, { speciesId, sessionId });
        this.eventBus?.emit(EVENTS.READING_SESSION_STARTED, { ...session });
        await this.rewardEngine.grantRecoveryIfEligible({
            sessionId,
            documentId: document.id,
            previousTimestamp,
            timestamp,
        });
        return this.getCurrentSession();
    }

    async ensureAutomatic() {
        if (!this.config.automaticTreesEnabled) return null;
        const document = this.getDocument?.();
        if (!document?.id) return null;
        const tier = getAutomaticTreeTier(this.storage.getSnapshot().plants);
        let current = this.getCurrentSession();
        if (current) {
            if (!current.automatic) {
                await this.abandon();
            } else {
                if (
                    current.state === SESSION_STATES.PAUSED &&
                    ["explicit", "reflection"].includes(current.pauseReason)
                ) {
                    this.tracker.setPaused(true);
                    return current;
                }
                const state = this.storage.getSnapshot();
                const plant = state.plants.find((candidate) => candidate.id === current.plantId);
                if (plant?.speciesId !== tier.definition.id) {
                    // Catalog changes take effect without asking the reader to
                    // discard storage or manually end an older automatic tree.
                    await this.abandon();
                    current = null;
                } else {
                    if (current.document?.id !== document.id || current.document?.type !== document.type) {
                        await this.resetContinuousProgress({ reason: "document-changed" });
                    }
                    const expectedGoalMs = Math.round(Number(tier.definition.durationMinutes) * 60000);
                    await this.storage.transaction((draft) => {
                        const stored = draft.sessions.find((candidate) => candidate.id === current.id);
                        const storedPlant = draft.plants.find((candidate) => candidate.id === current.plantId);
                        if (!stored) return;
                        stored.document = document;
                        stored.goalMs = expectedGoalMs;
                        stored.updatedAt = this.now();
                        draft.currentSession = { ...stored };
                        if (storedPlant) {
                            storedPlant.durationMinutes = tier.definition.durationMinutes;
                            storedPlant.updatedAt = this.now();
                        }
                    });
                    current = this.getCurrentSession();
                }
                if (current && [SESSION_STATES.PAUSED, SESSION_STATES.IDLE_TIMEOUT].includes(current.state)) {
                    return await this.resume();
                }
                if (current) return await this._activateRuntimeSession(current);
            }
        }
        return await this.start({
            goalMinutes: tier.definition.durationMinutes,
            speciesId: tier.definition.id,
            automatic: true,
        });
    }

    async pause({ reason = "explicit" } = {}) {
        const session = this.getCurrentSession();
        if (!session || ![SESSION_STATES.ACTIVE, SESSION_STATES.IDLE_TIMEOUT].includes(session.state)) return null;
        this.tracker.checkpoint();
        this.tracker.setPaused(true);
        await this.deltaQueue;
        await this._setState(session.id, SESSION_STATES.PAUSED, { pauseReason: reason });
        this.lifecycleState = SESSION_STATES.PAUSED;
        this.eventBus?.emit(EVENTS.READING_SESSION_PAUSED, this.getCurrentSession());
        return this.getCurrentSession();
    }

    async resume() {
        const session = this.getCurrentSession();
        if (!session || ![SESSION_STATES.PAUSED, SESSION_STATES.IDLE_TIMEOUT].includes(session.state)) return null;
        if (!this.lock.sessionId && !this.lock.acquire(session.id)) {
            throw new Error("Another tab already has an active reading session.");
        }
        await this._setState(session.id, SESSION_STATES.ACTIVE, { pauseReason: null });
        this.lifecycleState = SESSION_STATES.ACTIVE;
        this.tracker.setPaused(false);
        this.tracker.start();
        this.eventBus?.emit(EVENTS.READING_SESSION_RESUMED, this.getCurrentSession());
        return this.getCurrentSession();
    }

    async _activateRuntimeSession(session) {
        if (!session || session.state !== SESSION_STATES.ACTIVE) return session;
        if (!this.lock.sessionId && !this.lock.acquire(session.id)) {
            throw new Error("Another tab already has an active reading session.");
        }
        this.lifecycleState = SESSION_STATES.ACTIVE;
        this.tracker.setPaused(false);
        this.tracker.start();
        return this.getCurrentSession() || session;
    }

    async complete() {
        const session = this.getCurrentSession();
        if (!session || session.activeReadingMs < session.goalMs) throw new Error("The session goal has not been reached.");
        this.tracker.checkpoint();
        this.tracker.setPaused(true);
        await this.deltaQueue;
        const result = await this.rewardEngine.completeSession(session.id, this.now());
        this.tracker.stop();
        this.lock.release();
        this.lifecycleState = SESSION_STATES.IDLE;
        if (result) {
            this.eventBus?.emit(EVENTS.READING_SESSION_COMPLETED, result);
            this.eventBus?.emit(EVENTS.GARDEN_UPDATED, result);
            if (result.plant?.stage === "mature") {
                await this.storage.transaction((state) => {
                    if (state.currentGrowingPlantId === result.plant.id) state.currentGrowingPlantId = null;
                });
            }
        }
        return result;
    }

    async abandon() {
        const session = this.getCurrentSession();
        if (!session) return null;
        this.tracker.checkpoint();
        this.tracker.setPaused(true);
        await this.deltaQueue;
        const timestamp = this.now();
        await this.storage.transaction((state) => {
            const stored = state.sessions.find((candidate) => candidate.id === session.id);
            stored.state = SESSION_STATES.ABANDONED;
            stored.abandonedAt = timestamp;
            stored.updatedAt = timestamp;
            stored.pointsEarned = sumLedger(state.rewardLedger, (entry) => entry.sessionId === stored.id);
            state.currentSession = null;
        });
        this.tracker.stop();
        this.lock.release();
        this.lifecycleState = SESSION_STATES.IDLE;
        const abandoned = this.storage.getSnapshot().sessions.find((candidate) => candidate.id === session.id);
        this.eventBus?.emit(EVENTS.READING_SESSION_ABANDONED, abandoned);
        return abandoned;
    }

    getCurrentSession() {
        return this.storage.getSnapshot().currentSession;
    }

    async recordReadingPhrase({ documentId, location, text } = {}, sessionId = this.getCurrentSession()?.id) {
        const normalizedText = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
        const normalizedDocumentId = typeof documentId === "string" ? documentId.trim() : "";
        const validLocation = typeof location === "string"
            ? !!location.trim()
            : Number.isFinite(location) && location >= 0;
        if (!sessionId || !normalizedDocumentId || !normalizedText || !validLocation) return null;
        const phrase = { documentId: normalizedDocumentId, location, text: normalizedText };
        const timestamp = this.now();

        // Queue the captured phrase immediately against its original session.
        // Resolving the current session after an await could put the last phrase
        // of one tree into the following tree while completion is being saved.
        return this.storage.transaction((state) => {
            const session = state.sessions.find((candidate) => candidate.id === sessionId);
            if (!session || session.state === SESSION_STATES.ABANDONED) return null;
            const plant = state.plants.find((candidate) => candidate.id === session.plantId);
            if (!plant || plant.deletedAt) return null;
            const phrases = Array.isArray(session.readingPhrases) ? session.readingPhrases : [];
            if (phrases.some((entry) => entry.documentId === phrase.documentId &&
                entry.location === phrase.location && entry.text === phrase.text)) return null;
            phrases.push(phrase);
            session.readingPhrases = phrases;
            session.updatedAt = timestamp;
            if (state.currentSession?.id === sessionId) state.currentSession = { ...session };
            // A phrase that began before completion may finish being persisted
            // after the next session has started. Keep its original tree whole.
            if (session.state === SESSION_STATES.COMPLETED) {
                plant.readingPhrases = phrases.map((entry) => ({ ...entry }));
                plant.updatedAt = timestamp;
            }
            return phrase;
        });
    }

    async resetContinuousProgress({ reason = "interrupted" } = {}) {
        await this.deltaQueue;
        const timestamp = this.now();
        let reset = null;
        await this.storage.transaction((state) => {
            const current = state.currentSession;
            if (!current) return;
            const session = state.sessions.find((candidate) => candidate.id === current.id);
            if (!session || [SESSION_STATES.COMPLETED, SESSION_STATES.ABANDONED].includes(session.state)) return;
            const previousActiveReadingMs = Math.max(0, Number(session.activeReadingMs) || 0);
            const plant = state.plants.find((candidate) => candidate.id === session.plantId);
            const hadPlantProgress = plant && plant.stage !== "mature" &&
                (Number(plant.growthProgress) > 0 || plant.stage !== "seed");
            if (!previousActiveReadingMs && !hadPlantProgress) return;
            session.activeReadingMs = 0;
            session.goalReachedAt = null;
            session.lastInterruptionReason = reason;
            session.lastInterruptedAt = timestamp;
            session.lastResetReadingMs = previousActiveReadingMs;
            session.updatedAt = timestamp;
            state.currentSession = { ...session };
            if (plant && plant.stage !== "mature") {
                plant.growthProgress = 0;
                plant.stage = "seed";
                plant.updatedAt = timestamp;
            }
            reset = {
                reason,
                previousActiveReadingMs,
                session: { ...session },
                plant: plant ? { ...plant } : null,
            };
        });
        if (!reset) return this.getCurrentSession();
        this.eventBus?.emit(EVENTS.READING_SESSION_RESET, reset);
        this.eventBus?.emit(EVENTS.READING_SESSION_PROGRESS, {
            session: reset.session,
            plant: reset.plant,
        });
        return reset.session;
    }

    async _recordDelta(milliseconds) {
        const session = this.getCurrentSession();
        if (!session || session.state !== SESSION_STATES.ACTIVE) return;
        const before = this.storage.getSnapshot();
        const previousPlant = before.plants.find((plant) => plant.id === session.plantId);
        const previousStage = previousPlant?.stage;
        await this.rewardEngine.recordActiveReading({
            milliseconds,
            sessionId: session.id,
            documentId: session.document.id,
            timestamp: this.now(),
        });
        await this.storage.transaction((draft) => {
            const storedSession = draft.sessions.find((candidate) => candidate.id === session.id);
            const storedPlant = draft.plants.find((candidate) => candidate.id === session.plantId);
            if (!storedSession || !storedPlant || !storedSession.automatic) return;
            storedPlant.growthProgress = Math.max(
                0,
                Math.min(1, storedSession.activeReadingMs / storedSession.goalMs),
            );
            const stage = getPlantStage(
                storedPlant.speciesId,
                storedPlant.pointsInvested,
                storedPlant.growthProgress,
            );
            storedPlant.stage = stage.id;
            storedPlant.updatedAt = this.now();
        });
        const state = this.storage.getSnapshot();
        const updated = state.sessions.find((candidate) => candidate.id === session.id);
        const plant = state.plants.find((candidate) => candidate.id === session.plantId);
        if (!updated) return;
        if (!updated.goalReachedAt && updated.activeReadingMs >= updated.goalMs) {
            const timestamp = this.now();
            await this.storage.transaction((draft) => {
                const stored = draft.sessions.find((candidate) => candidate.id === session.id);
                stored.goalReachedAt ||= timestamp;
                stored.updatedAt = timestamp;
                draft.currentSession = { ...stored };
            });
            this.eventBus?.emit(EVENTS.READING_SESSION_GOAL_REACHED, this.getCurrentSession());
        }
        if (plant && plant.stage !== previousStage) {
            this.eventBus?.emit(EVENTS.PLANT_STAGE_CHANGED, {
                plant,
                stage: getPlantStage(plant.speciesId, plant.pointsInvested, plant.growthProgress),
            });
        }
        this.eventBus?.emit(EVENTS.READING_SESSION_PROGRESS, {
            session: this.getCurrentSession(),
            plant,
        });
    }

    async _setState(sessionId, stateName, changes = {}) {
        await this.storage.transaction((state) => {
            const session = state.sessions.find((candidate) => candidate.id === sessionId);
            if (!session) return;
            session.state = stateName;
            Object.assign(session, changes);
            session.updatedAt = this.now();
            state.currentSession = { ...session };
        });
    }

    _transitionIdle() {
        const session = this.getCurrentSession();
        if (!session || session.state !== SESSION_STATES.ACTIVE) return;
        this.lifecycleState = SESSION_STATES.IDLE_TIMEOUT;
        this._setState(session.id, SESSION_STATES.IDLE_TIMEOUT, { pauseReason: "idle" })
            .then(() => this.eventBus?.emit(EVENTS.READING_SESSION_IDLE, this.getCurrentSession()))
            .catch((error) => console.error("[ReadingSessionManager] Idle checkpoint failed", error));
    }

    _resumeFromIdle() {
        const session = this.getCurrentSession();
        if (!session || session.state !== SESSION_STATES.IDLE_TIMEOUT) return;
        this.lifecycleState = SESSION_STATES.ACTIVE;
        this._setState(session.id, SESSION_STATES.ACTIVE, { pauseReason: null })
            .then(() => this.eventBus?.emit(EVENTS.READING_SESSION_RESUMED, this.getCurrentSession()))
            .catch((error) => console.error("[ReadingSessionManager] Idle resume failed", error));
    }
}
