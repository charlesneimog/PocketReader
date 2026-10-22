import { EVENTS } from "../../constants/events.js";
import { ActiveReadingTracker } from "./activeReadingTracker.js";
import { CrossTabSessionLock } from "./crossTabSessionLock.js";
import { GardenManager } from "./gardenManager.js";
import { ReadingEventAdapter } from "./readingEventAdapter.js";
import { ReadingSessionManager } from "./readingSessionManager.js";
import { RewardEngine } from "./rewardEngine.js";
import { meaningfulCharacterCount, REWARD_TYPES, sumLedger, uuid } from "./rewardDefinitions.js";
import { RewardStorage } from "./rewardStorage.js";
import { StreakManager } from "./streakManager.js";
import { GardenDialog } from "../ui/gardenDialog.js";
import { ReflectionDialog } from "../ui/reflectionDialog.js";
import { RewardsPanel } from "../ui/rewardsPanel.js";
import { getPlantDefinition, getPlantStage } from "./plantDefinitions.js";

const REFLECTION_PLAYBACK_BLOCK = "required-reflection";

/** Application composition root and public reward UI/sync facade. */
export class RewardsController {
    constructor(app) {
        this.app = app;
        this.config = app.config.REWARDS;
        this.storage = new RewardStorage({
            storageKey: app.config.REWARDS_STORAGE_KEY,
            config: this.config,
        });
        this.gardenManager = new GardenManager();
        this.streakManager = new StreakManager({ weekStartsOn: this.config.weekStartsOn });
        this.rewardEngine = new RewardEngine({
            storage: this.storage,
            gardenManager: this.gardenManager,
            streakManager: this.streakManager,
            eventBus: app.eventBus,
            config: this.config,
        });
        this.lock = new CrossTabSessionLock();
        this.tracker = new ActiveReadingTracker({
            config: this.config,
            onDelta: () => {},
            onIdle: () => {},
            // autoAdvanceActive is the user-visible continuous TTS state used
            // by the Pause control. isPlaying can briefly become false between
            // phrase sources, especially on Firefox and lower-power phones.
            getPlaybackActive: () => !!(
                app.state?.isPlaying || app.state?.autoAdvanceActive
            ),
            onHidden: () => {
                // Page Visibility is the single boundary for leaving the PWA.
                // stopPlayback changes the player state synchronously and emits
                // the normal pause event; returning never auto-resumes it.
                app.audioManager?.stopPlayback?.(false)?.catch?.((error) => {
                    console.error("[RewardsController] Failed to pause hidden TTS", error);
                });
            },
        });
        this.adapter = new ReadingEventAdapter({ app, tracker: this.tracker });
        this.sessions = new ReadingSessionManager({
            storage: this.storage,
            rewardEngine: this.rewardEngine,
            gardenManager: this.gardenManager,
            tracker: this.tracker,
            lock: this.lock,
            eventBus: app.eventBus,
            config: this.config,
            getDocument: () => this.adapter.getDocumentDescriptor(),
        });
        this.unsubscribers = [];
        this.syncTimer = null;
        this.lastCheckpointAt = 0;
        this.automaticStartPromise = null;
        this.automaticCompletionPromise = null;
        this.pendingTreeNotifications = [];
        this.notifiedTreeIds = new Set();
        this.reflectionPromptPromise = null;
        this.reflectionResumeState = null;
        this.readingBoundaryPromise = null;
    }

    async initialize() {
        if (!this.config.enabled) return;
        await this.storage.load();
        await this.sessions.restore();
        this.adapter.start();
        this._createUi();
        this._bindEvents();
        this._rememberHistoricalTrees();
        if (this.adapter.getDocumentDescriptor()) this.adapter.documentOpened();
        this._refresh();
        this.app.state.rewards.ready = true;
    }

    _createUi() {
        this.gardenDialog = new GardenDialog({
            weekStartsOn: this.config.weekStartsOn,
            minimumRows: this.config.defaultGardenRows,
            onRemove: (plantId) => this.removeTree(plantId),
        });
        this.reflectionDialog = new ReflectionDialog({
            minimumCharacters: this.config.reflectionMinimumCharacters,
            onSave: (session, text) => this.saveReflection(session, text),
            onSaved: () => this._resumeAfterRequiredReflection(),
        });
        this.panel = new RewardsPanel({
            onGarden: () => this.openGarden(),
        });
        for (const dialog of [this.gardenDialog.dialog]) {
            dialog.addEventListener("close", () => {
                this.adapter._updateReadingScreen();
            });
        }
    }

    _bindEvents() {
        const refreshEvents = [
            EVENTS.READING_DOCUMENT_OPENED,
            EVENTS.READING_DOCUMENT_CLOSED,
            EVENTS.READING_SESSION_STARTED,
            EVENTS.READING_SESSION_PAUSED,
            EVENTS.READING_SESSION_RESUMED,
            EVENTS.READING_SESSION_IDLE,
            EVENTS.READING_SESSION_RESET,
            EVENTS.READING_SESSION_PROGRESS,
            EVENTS.READING_SESSION_GOAL_REACHED,
            EVENTS.READING_SESSION_COMPLETED,
            EVENTS.READING_SESSION_ABANDONED,
            EVENTS.REWARD_GRANTED,
            EVENTS.PLANT_STAGE_CHANGED,
            EVENTS.GARDEN_UPDATED,
            EVENTS.AUDIO_PLAYBACK_START,
            EVENTS.AUDIO_PLAYBACK_PAUSE,
            EVENTS.AUDIO_PLAYBACK_END,
        ];
        for (const eventName of refreshEvents) {
            this.unsubscribers.push(this.app.eventBus.on(eventName, () => {
                this._refresh();
                this._queueSync();
            }));
        }
        this.unsubscribers.push(this.app.eventBus.on(EVENTS.READING_SESSION_IDLE, () => {
            this.app.ui.showInfo("Reading paused.");
            this.panel.announce("idle", "Reading paused after four minutes without activity.");
        }));
        this.unsubscribers.push(this.app.eventBus.on(EVENTS.READING_SESSION_RESUMED, () => {
            this.app.ui.showInfo("Activity resumed.");
        }));
        this.unsubscribers.push(this.app.eventBus.on(EVENTS.READING_SESSION_RESET, ({ reason, previousActiveReadingMs }) => {
            const labels = {
                "document-changed": "changing documents",
                "document-closed": "closing the document",
                "focus-lost": "losing window focus",
                "left-reader": "leaving the reader",
                "page-left": "leaving the page",
                "tab-hidden": "hiding the tab",
                "idle": "becoming idle",
                "explicit": "pausing",
            };
            const cause = labels[reason] || "an interruption";
            const readMinutes = Math.floor((Number(previousActiveReadingMs) || 0) / 60000);
            const readSeconds = Math.floor(((Number(previousActiveReadingMs) || 0) % 60000) / 1000);
            const duration = `${readMinutes}:${String(readSeconds).padStart(2, "0")}`;
            const message = `Focus streak reset after ${cause}. ${duration} of reading remains in your history.`;
            this.app.ui.showInfo(message);
            this.panel.announce(`focus-reset:${Date.now()}`, message);
        }));
        this.unsubscribers.push(this.app.eventBus.on(EVENTS.READING_DOCUMENT_OPENED, () => {
            this._ensureAutomaticTree();
        }));
        this.unsubscribers.push(this.app.eventBus.on(EVENTS.READING_ACTIVITY, () => {
            // Reconcile on every trusted reading activity, not only when the
            // session is missing. This resumes restore/idle sessions whose
            // persisted state otherwise leaves live TTS uncounted.
            this._ensureAutomaticTree();
        }));
        this.unsubscribers.push(this.app.eventBus.on(EVENTS.AUDIO_PLAYBACK_START, (payload) => {
            this._recordReadingPhrase(payload).catch((error) => {
                console.error("[RewardsController] Reading text could not be saved", error);
            });
        }));
        this.unsubscribers.push(this.app.eventBus.on(EVENTS.READING_SESSION_GOAL_REACHED, () => {
            this._completeAutomaticTree();
        }));
        this.unsubscribers.push(this.app.eventBus.on(EVENTS.PLANT_STAGE_CHANGED, ({ plant, stage }) => {
            if (stage.percent >= 25) this.panel.announce(
                `plant:${plant.id}:${stage.id}`,
                `Your plant reached the ${stage.label.toLowerCase()} stage.`,
            );
        }));
        this.unsubscribers.push(this.app.eventBus.on(EVENTS.HIGHLIGHT_ADDED, (payload) => {
            if (payload?.comment && payload?.annotationId) this.rewardAnnotation(payload);
        }));
        this.unsubscribers.push(this.app.eventBus.on(EVENTS.PLANT_MATURED, (plant) => {
            this._queueTreeNotification(plant);
        }));
        for (const eventName of [EVENTS.SENTENCE_CHANGED, EVENTS.AUDIO_PLAYBACK_END]) {
            this.unsubscribers.push(this.app.eventBus.on(eventName, () => {
                this.handleReadingBoundary().catch((error) => {
                    console.error("[RewardsController] Required reading paragraph prompt failed", error);
                });
            }));
        }
        const checkpoint = () => {
            this.tracker.checkpoint();
            this._queueSync(true);
        };
        document.addEventListener("visibilitychange", checkpoint);
        globalThis.window?.addEventListener?.("pagehide", checkpoint);
        this._checkpointHandler = checkpoint;
    }

    openGarden() {
        const state = this.storage.getSnapshot();
        this.tracker.checkpoint();
        this.tracker.setReadingScreen(false);
        this.gardenDialog.open(state, this.rewardEngine.getSummary(state));
    }

    _recordReadingPhrase({ index } = {}) {
        const descriptor = this.adapter.getDocumentDescriptor();
        const state = this.app.state;
        const sentenceIndex = Number.isInteger(index) && index >= 0
            ? index
            : state.playingSentenceIndex >= 0
                ? state.playingSentenceIndex
                : state.currentSentenceIndex;
        const sentence = state.sentences?.[sentenceIndex];
        const text = String(sentence?.readableText?.trim() || sentence?.text || "")
            .trim().replace(/\s+/g, " ");
        if (!descriptor?.id || !text) return Promise.resolve(null);

        // Capture before awaiting session creation: playback may already have
        // moved on when the initial automatic tree finishes starting.
        const phrase = {
            documentId: descriptor.id,
            location: descriptor.type === "epub" && sentence.cfi ? sentence.cfi : sentenceIndex,
            text,
        };
        const current = this.sessions.getCurrentSession();
        if (current?.automatic && current.state === "active" && current.document?.id === descriptor.id) {
            return this.sessions.recordReadingPhrase(phrase, current.id);
        }
        return this._ensureAutomaticTree().then((session) => {
            if (!session || session.state !== "active" || session.document?.id !== descriptor.id) return null;
            return this.sessions.recordReadingPhrase(phrase, session.id);
        });
    }

    async _ensureAutomaticTree() {
        if (this.automaticStartPromise) return this.automaticStartPromise;
        this.automaticStartPromise = this.sessions.ensureAutomatic()
            .then(async (session) => {
                // There is no separate reward-session control in the current
                // UI. If continuous TTS is running, a stale explicit/restore
                // pause must not silently keep the automatic clock disabled.
                if (
                    session &&
                    (this.app.state?.isPlaying || this.app.state?.autoAdvanceActive) &&
                    ["paused", "idle-timeout"].includes(session.state) &&
                    session.pauseReason !== "reflection"
                ) {
                    session = await this.sessions.resume();
                }
                this._refresh();
                return session;
            })
            .catch((error) => {
                console.error("[RewardsController] Automatic tree start failed", error);
                this.app.ui.showInfo(error.message);
                return null;
            })
            .finally(() => {
                this.automaticStartPromise = null;
            });
        return this.automaticStartPromise;
    }

    async _completeAutomaticTree() {
        if (this.automaticCompletionPromise) return this.automaticCompletionPromise;
        this.automaticCompletionPromise = (async () => {
            const session = this.sessions.getCurrentSession();
            if (!session?.automatic || session.activeReadingMs < session.goalMs) return null;
            const result = await this.sessions.complete();
            this._queueTreeNotification(result?.plant);
            await this.sessions.ensureAutomatic();
            this._refresh();
            return result;
        })().catch((error) => {
            console.error("[RewardsController] Automatic tree completion failed", error);
            this.app.ui.showInfo("Your reading time was saved; the next tree will resume automatically.");
            return null;
        }).finally(() => {
            this.automaticCompletionPromise = null;
        });
        return this.automaticCompletionPromise;
    }

    _queueTreeNotification(plant) {
        if (!plant?.id || this.notifiedTreeIds.has(plant.id)) return false;
        this.notifiedTreeIds.add(plant.id);
        this.pendingTreeNotifications.push(plant);
        return true;
    }

    async handleReadingBoundary() {
        if (this.readingBoundaryPromise) return this.readingBoundaryPromise;
        this.readingBoundaryPromise = (async () => {
            if (this.automaticCompletionPromise) {
                await this.automaticCompletionPromise;
            }
            await this._flushTreeNotification();
        })().finally(() => {
            this.readingBoundaryPromise = null;
        });
        return this.readingBoundaryPromise;
    }

    async _flushTreeNotification() {
        if (this.reflectionDialog?.isOpen() || this.reflectionPromptPromise) return;
        const plant = this.pendingTreeNotifications.shift();
        if (!plant) return;
        const definition = getPlantDefinition(plant.speciesId);
        const message = `You earned one Reading Tree — ${definition.name}.`;
        this.panel.announce(`tree-earned:${plant.id}`, message);
        const state = this.storage.getSnapshot();
        const session = state.sessions.find((candidate) => candidate.id === plant.sessionId);
        const alreadyReflected = state.reflections.some((entry) => entry.sessionId === plant.sessionId);
        if (session && !alreadyReflected) {
            this.reflectionPromptPromise = this._pauseForRequiredReflection();
            try {
                await this.reflectionPromptPromise;
            } finally {
                this.reflectionPromptPromise = null;
            }
            this.reflectionDialog?.open(
                session,
                `${definition.name} was added to your garden. Reading is paused until you save its paragraph.`,
                this._getSessionHighlights(session),
            );
        }
    }

    _getSessionHighlights(session) {
        const descriptor = this.adapter?.getDocumentDescriptor?.();
        if (!session?.document?.id || descriptor?.id !== session.document.id) return [];

        const startedAt = Number(session.startedAt);
        const completedAt = Number(session.completedAt);
        if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return [];

        const highlights = this.app.state?.savedHighlights;
        if (!(highlights instanceof Map)) return [];

        const entries = [];
        for (const [sentenceIndex, highlight] of highlights.entries()) {
            const timestamp = Number(highlight?.timestamp);
            if (!Number.isFinite(timestamp) || timestamp < startedAt || timestamp > completedAt) continue;
            const fallback = this.app.state?.sentences?.[Number(sentenceIndex)]?.text;
            const text = String(highlight?.text || highlight?.sentenceText || fallback || "")
                .trim()
                .replace(/\s+/g, " ");
            if (text) entries.push({
                text,
                color: typeof highlight?.color === "string" ? highlight.color : "",
                timestamp,
                sentenceIndex: Number(sentenceIndex),
            });
        }
        entries.sort((left, right) =>
            left.timestamp - right.timestamp || left.sentenceIndex - right.sentenceIndex,
        );
        const seen = new Set();
        return entries
            .filter((entry) => {
                if (seen.has(entry.text)) return false;
                seen.add(entry.text);
                return true;
            })
            .map(({ text, color }) => ({ text, color }));
    }

    _rememberHistoricalTrees() {
        const state = this.storage.getSnapshot();
        for (const plant of state.plants) {
            if (plant?.id && (plant.completedAt || plant.stage === "mature")) {
                this.notifiedTreeIds.add(plant.id);
            }
        }
    }

    async removeTree(plantId) {
        if (!plantId) return null;
        const timestamp = Date.now();
        let removed = null;
        await this.storage.transaction((state) => {
            const plant = state.plants.find((candidate) => candidate.id === plantId);
            if (!plant || plant.deletedAt || plant.stage !== "mature") return;
            plant.deletedAt = timestamp;
            plant.updatedAt = timestamp;
            plant.plotId = null;
            plant.cell = null;
            plant.reflectionRequired = false;
            removed = { ...plant };
        });
        if (!removed) return null;

        this.pendingTreeNotifications = this.pendingTreeNotifications.filter((plant) => plant.id !== plantId);
        this.notifiedTreeIds.add(plantId);
        this._refresh();
        this.app.eventBus.emit(EVENTS.GARDEN_UPDATED, { plant: removed, removed: true });
        this._queueSync(true);
        this.app.ui.showInfo("Tree removed from your garden.");
        return removed;
    }

    async _pauseForRequiredReflection() {
        const current = this.sessions.getCurrentSession();
        const shouldResumePlayback = !!(
            this.app.state?.isPlaying || this.app.state?.autoAdvanceActive
        );
        this.reflectionResumeState = {
            sessionId: current?.id || null,
            shouldResumePlayback,
        };
        if (this.app.audioManager?.addPlaybackBlock) {
            await this.app.audioManager.addPlaybackBlock(REFLECTION_PLAYBACK_BLOCK, false);
        } else if (shouldResumePlayback) {
            await this.app.audioManager?.stopPlayback?.(false);
        }
        if (current?.state === "active" || current?.state === "idle-timeout") {
            await this.sessions.pause({ reason: "reflection" });
        }
    }

    async _resumeAfterRequiredReflection() {
        const resumeState = this.reflectionResumeState;
        this.reflectionResumeState = null;
        this.app.audioManager?.removePlaybackBlock?.(REFLECTION_PLAYBACK_BLOCK);
        this.adapter._updateReadingScreen();
        const current = this.sessions.getCurrentSession();
        if (
            resumeState?.sessionId &&
            current?.id === resumeState.sessionId &&
            current.state === "paused" &&
            current.pauseReason === "reflection" &&
            this.adapter.getDocumentDescriptor()
        ) {
            await this.sessions.resume();
        }
        if (resumeState?.shouldResumePlayback && this.adapter.getDocumentDescriptor()) {
            await this.app.audioManager?.playCurrentSentence?.();
        }
        this._flushTreeNotification().catch((error) => {
            console.error("[RewardsController] Next required paragraph prompt failed", error);
        });
    }

    async saveReflection(session, text) {
        if (!session || meaningfulCharacterCount(text) < this.config.reflectionMinimumCharacters) {
            throw new Error("The reflection is too short.");
        }
        const anchor = this._captureReflectionAnchor(session.document?.id);
        let reflection = null;
        await this.storage.transaction((state) => {
            const eligible = state.sessions.find(
                (candidate) => candidate.id === session.id && candidate.state === "completed",
            );
            if (!eligible || state.reflections.some((entry) => entry.sessionId === session.id)) return;
            const timestamp = Date.now();
            reflection = {
                id: uuid(),
                sessionId: session.id,
                documentId: eligible.document.id,
                text: String(text).trim(),
                anchor,
                createdAt: timestamp,
                updatedAt: timestamp,
            };
            state.reflections.push(reflection);
            const plant = state.plants.find((candidate) => candidate.id === eligible.plantId);
            if (plant) {
                plant.reflectionId = reflection.id;
                plant.reflectionRequired = false;
                plant.updatedAt = timestamp;
            }
        });
        if (!reflection) {
            this.app.ui.showInfo("A reflection is already saved for this session.");
            return null;
        }
        await this.rewardEngine.grantEngagement({
            rewardType: REWARD_TYPES.REFLECTION,
            sessionId: session.id,
            documentId: reflection.documentId,
            entityId: session.id,
            metadata: { reflectionId: reflection.id },
        });
        this.app.eventBus.emit(EVENTS.REFLECTION_SAVED, reflection);
        this._refresh();
        return reflection;
    }

    _captureReflectionAnchor(documentId) {
        const descriptor = this.adapter?.getDocumentDescriptor?.();
        if (!descriptor?.id || descriptor.id !== documentId) return null;

        const sentenceIndex = Math.max(0, Number(this.app.state?.currentSentenceIndex) || 0);
        const sentence = this.app.state?.sentences?.[sentenceIndex];
        const documentType = this.app.state?.currentDocumentType || descriptor.type;
        const anchor = {
            documentType,
            sentenceIndex,
        };

        if (documentType === "pdf" && Number.isFinite(Number(sentence?.pageNumber))) {
            anchor.pageNumber = Number(sentence.pageNumber);
            // This small text fingerprint lets export reject a stale sentence
            // index if parsing rules change between reading and exporting.
            anchor.text = String(sentence.text || "").trim().slice(0, 240);
        }
        return anchor;
    }

    async rewardAnnotation(payload) {
        const session = this.sessions.getCurrentSession();
        if (!session || session.document.id !== payload.documentId) return;
        const persisted = this.app.state.savedHighlights?.get?.(Number(payload.sentenceIndex));
        if (
            !persisted ||
            persisted.annotationId !== payload.annotationId ||
            !String(persisted.comment || "").trim()
        ) return;
        await this.rewardEngine.grantEngagement({
            rewardType: REWARD_TYPES.ANNOTATION_WITH_NOTE,
            sessionId: session.id,
            documentId: payload.documentId,
            entityId: payload.annotationId,
            metadata: { sentenceIndex: payload.sentenceIndex },
        });
    }

    async createQuestion() {
        const session = this.sessions.getCurrentSession();
        if (!session) return;
        this.tracker.checkpoint();
        this.tracker.setReadingScreen(false);
        let question = "";
        try {
            question = globalThis.prompt?.("What question would you like to remember from this reading?") || "";
        } finally {
            this.adapter._updateReadingScreen();
            this.tracker.recordActivity("question-saved");
        }
        if (!String(question || "").trim()) return;
        const normalized = String(question).trim();
        const entityId = `${session.document.id}:${session.id}:question:${uuid()}`;
        await this.rewardEngine.grantEngagement({
            rewardType: REWARD_TYPES.QUESTION,
            sessionId: session.id,
            documentId: session.document.id,
            entityId,
            metadata: { question: normalized },
        });
        this.app.ui.showInfo("Reading question saved.");
    }

    async mergeRemote(snapshot) {
        const merged = await this.storage.merge(this._syncSafeSnapshot(snapshot));
        await this.storage.transaction((state) => this.rewardEngine.recomputeBalance(state));
        if (
            (this.app.state?.isPlaying || this.app.state?.autoAdvanceActive) &&
            this.adapter.getDocumentDescriptor()
        ) {
            await this._ensureAutomaticTree();
        }
        this._refresh();
        return merged;
    }

    getSyncSnapshot() {
        return this._syncSafeSnapshot(this.storage.getSnapshot());
    }

    _syncSafeSnapshot(snapshot) {
        const safe = typeof structuredClone === "function"
            ? structuredClone(snapshot || {})
            : JSON.parse(JSON.stringify(snapshot || {}));
        // Reading sessions are device/runtime state and never belong in account
        // persistence. Trees and reflections carry their own durable data.
        safe.currentSession = null;
        safe.sessions = [];
        return safe;
    }

    _refresh() {
        const state = this.storage.getSnapshot();
        const session = state.currentSession;
        const plant = session ? state.plants.find((candidate) => candidate.id === session.plantId) : null;
        const stage = plant
            ? getPlantStage(plant.speciesId, plant.pointsInvested, plant.growthProgress)
            : null;
        const summary = this.rewardEngine.getSummary(state);
        this.app.state.rewards.session = session;
        this.app.state.rewards.garden = { plots: state.gardenPlots, plants: state.plants };
        this.app.state.rewards.summary = summary;
        this.panel?.update({
            // documentClosed() clears this projection before the document
            // renderer releases its state. Using only the descriptor here can
            // leave the tree visible on Home during that teardown window.
            documentOpen: !!this.app.state.rewards.document && !!this.adapter.getDocumentDescriptor(),
            session,
            summary,
            currentPlantStage: stage,
            activelyCounting: this.tracker.isEligible(),
        });
        if (this.gardenDialog?.dialog.open) this.gardenDialog.update(state, summary);
        this.app.eventBus.emit(EVENTS.REWARDS_UPDATED, { session, summary });
    }

    _queueSync(immediate = false) {
        clearTimeout(this.syncTimer);
        const run = () => this.app.serverSync?.queueRewardsSync?.(this.getSyncSnapshot());
        if (immediate) run();
        else this.syncTimer = setTimeout(run, this.config.syncDebounceMs);
    }

    async closeDocument() {
        const session = this.sessions.getCurrentSession();
        if (session?.state === "active" || session?.state === "idle-timeout") {
            await this.sessions.pause({ reason: "document-closed" });
        }
        this.adapter.documentClosed();
    }
}

export async function initializeRewards(app) {
    if (app.rewards) return app.rewards;
    app.rewards = new RewardsController(app);
    await app.rewards.initialize();
    return app.rewards;
}
