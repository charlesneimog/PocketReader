import { EVENTS } from "../../constants/events.js";
import {
    ENGAGEMENT_REWARD_TYPES,
    elapsedLocalCalendarDays,
    localDateKey,
    REWARD_TYPES,
    sumLedger,
    uuid,
} from "./rewardDefinitions.js";
import {
    availablePlantDefinitions,
    getAutomaticTreeTier,
    PLANT_DEFINITIONS,
} from "./plantDefinitions.js";

/**
 * Idempotent reward ledger and plant allocation service. UI and reader events
 * cannot mint rewards directly; callers must supply trusted manager-owned facts.
 */
export class RewardEngine {
    constructor({ storage, gardenManager, streakManager, eventBus, config, now = Date.now, randomUUID } = {}) {
        this.storage = storage;
        this.gardenManager = gardenManager;
        this.streakManager = streakManager;
        this.eventBus = eventBus;
        this.config = config;
        this.now = now;
        this.randomUUID = randomUUID;
    }

    async recordActiveReading({ milliseconds, sessionId, documentId, timestamp = this.now() }) {
        const validMs = Math.max(0, Number(milliseconds) || 0);
        if (!validMs || !sessionId || !documentId) return [];
        const granted = [];
        let weeklyResult = null;
        let capReached = false;
        await this.storage.transaction((state) => {
            const session = state.sessions.find((candidate) => candidate.id === sessionId);
            if (!session || !["active", "idle-timeout"].includes(session.state)) return;
            const date = localDateKey(timestamp);
            state.totalActiveReadingMs += validMs;
            state.activeTimeByDay[date] = (Number(state.activeTimeByDay[date]) || 0) + validMs;
            state.activeTimeByDocument[documentId] =
                (Number(state.activeTimeByDocument[documentId]) || 0) + validMs;
            state.timeRewardRemainderMs =
                state.activeTimeByDay[date] %
                (this.config.timeRewardIntervalMinutes * 60000);
            state.lastValidReadingTimestamp = timestamp;

            session.activeReadingMs = (Number(session.activeReadingMs) || 0) + validMs;
            session.updatedAt = timestamp;
            if (state.currentSession?.id === session.id) state.currentSession = { ...session };

            const intervalMs = this.config.timeRewardIntervalMinutes * 60000;
            const earnedIntervals = Math.floor(state.activeTimeByDay[date] / intervalMs);
            const alreadyAwarded = sumLedger(
                state.rewardLedger,
                (transaction) => transaction.rewardType === REWARD_TYPES.ACTIVE_TIME && transaction.localDate === date,
            );
            const allowedPoints = Math.min(
                this.config.dailyTimeRewardCap,
                earnedIntervals * this.config.timeRewardPoints,
            );
            const points = Math.max(0, allowedPoints - alreadyAwarded);
            if (points) {
                const transaction = this._grantInDraft(state, {
                    rewardType: REWARD_TYPES.ACTIVE_TIME,
                    points,
                    timestamp,
                    sessionId,
                    documentId,
                    deduplicationKey: `active-time:${date}:${allowedPoints}`,
                    metadata: { activeReadingMs: state.activeTimeByDay[date], intervalMs },
                });
                if (transaction) granted.push(transaction);
            } else if (
                alreadyAwarded >= this.config.dailyTimeRewardCap &&
                earnedIntervals * this.config.timeRewardPoints > alreadyAwarded
            ) {
                capReached = true;
            }

            weeklyResult = this.streakManager.record(state, timestamp);
            if (weeklyResult.award) {
                const transaction = this._grantInDraft(state, {
                    rewardType: REWARD_TYPES.WEEKLY_CONSISTENCY,
                    points: weeklyResult.award.points,
                    timestamp,
                    sessionId,
                    documentId,
                    deduplicationKey: `weekly:${weeklyResult.weekKey}:${weeklyResult.award.tierDays}`,
                    metadata: { weekKey: weeklyResult.weekKey, tierDays: weeklyResult.award.tierDays },
                });
                if (transaction) granted.push(transaction);
            }
        });
        this._emitGranted(granted);
        if (weeklyResult?.award) this.eventBus?.emit(EVENTS.WEEKLY_GOAL_REACHED, weeklyResult);
        if (capReached) this.eventBus?.emit(EVENTS.REWARD_DAILY_LIMIT_REACHED, { category: "time" });
        return granted;
    }

    async grantRecoveryIfEligible({ sessionId, documentId, previousTimestamp, timestamp = this.now() }) {
        if (
            !Number.isFinite(previousTimestamp) ||
            elapsedLocalCalendarDays(previousTimestamp, timestamp) < this.config.recoveryAfterDays
        ) return null;
        return this.grant({
            rewardType: REWARD_TYPES.RECOVERY,
            points: this.config.recoveryPoints,
            timestamp,
            sessionId,
            documentId,
            deduplicationKey: `recovery:${sessionId}`,
            metadata: { previousTimestamp },
        });
    }

    async grantEngagement({ rewardType, sessionId, documentId, entityId, metadata = {}, timestamp = this.now() }) {
        const configured = {
            [REWARD_TYPES.REFLECTION]: this.config.reflectionPoints,
            [REWARD_TYPES.ANNOTATION_WITH_NOTE]: this.config.annotationWithNotePoints,
            [REWARD_TYPES.QUESTION]: this.config.questionPoints,
        }[rewardType];
        if (!configured || !entityId) return null;
        return this.grant({
            rewardType,
            points: configured,
            timestamp,
            sessionId,
            documentId,
            deduplicationKey: `${rewardType}:${entityId}`,
            metadata: { ...metadata, entityId },
            engagement: true,
        });
    }

    async grant({
        rewardType,
        points,
        timestamp = this.now(),
        sessionId,
        documentId = null,
        deduplicationKey,
        metadata = {},
        engagement = false,
    }) {
        let transaction = null;
        let capReached = false;
        await this.storage.transaction((state) => {
            if (state.rewardLedger.some((entry) => entry.deduplicationKey === deduplicationKey)) return;
            let allowed = Math.max(0, Number(points) || 0);
            if (engagement || ENGAGEMENT_REWARD_TYPES.includes(rewardType)) {
                const date = localDateKey(timestamp);
                const used = sumLedger(
                    state.rewardLedger,
                    (entry) => entry.localDate === date && ENGAGEMENT_REWARD_TYPES.includes(entry.rewardType),
                );
                allowed = Math.min(allowed, Math.max(0, this.config.dailyEngagementRewardCap - used));
                capReached = allowed < points;
            }
            if (!allowed) return;
            transaction = this._grantInDraft(state, {
                rewardType,
                points: allowed,
                timestamp,
                sessionId,
                documentId,
                deduplicationKey,
                metadata,
            });
        });
        this._emitGranted(transaction ? [transaction] : []);
        if (capReached) this.eventBus?.emit(EVENTS.REWARD_DAILY_LIMIT_REACHED, { category: "engagement" });
        return transaction;
    }

    async completeSession(sessionId, timestamp = this.now()) {
        const granted = [];
        let result = null;
        await this.storage.transaction((state) => {
            const session = state.sessions.find((candidate) => candidate.id === sessionId);
            if (!session || session.state === "completed" || session.activeReadingMs < session.goalMs) return;
            session.state = "completed";
            session.completedAt = timestamp;
            session.updatedAt = timestamp;
            session.goalReachedAt ||= timestamp;
            const plant = state.plants.find((candidate) => candidate.id === session.plantId);
            if (plant) {
                plant.readingPhrases = Array.isArray(session.readingPhrases)
                    ? session.readingPhrases.map((phrase) => ({ ...phrase }))
                    : [];
                plant.updatedAt = timestamp;
            }
            if (session.automatic && plant) {
                plant.growthProgress = 1;
                plant.stage = "mature";
                plant.completedAt ||= timestamp;
                plant.reflectionRequired = true;
                plant.updatedAt = timestamp;
            }
            const completion = this._grantInDraft(state, {
                rewardType: REWARD_TYPES.SESSION_COMPLETION,
                points: this.config.sessionCompletionPoints,
                timestamp,
                sessionId,
                documentId: session.document.id,
                deduplicationKey: `session-completion:${sessionId}`,
                metadata: { goalMs: session.goalMs, activeReadingMs: session.activeReadingMs },
            });
            if (completion) granted.push(completion);
            const placement = plant?.stage === "mature"
                ? this.gardenManager.placeMaturePlant(state, plant, timestamp)
                : { placed: false, reason: "not-mature" };
            session.pointsEarned = sumLedger(state.rewardLedger, (entry) => entry.sessionId === sessionId);
            if (state.currentSession?.id === sessionId) state.currentSession = null;
            result = { session: { ...session }, plant: plant ? { ...plant } : null, placement };
        });
        this._emitGranted(granted);
        return result;
    }

    getSummary(state = this.storage.getSnapshot(), timestamp = this.now()) {
        const totalPoints = sumLedger(state.rewardLedger);
        const current = state.currentSession;
        const currentPlant = current ? state.plants.find((plant) => plant.id === current.plantId) : null;
        const visiblePlants = state.plants.filter((plant) => !plant.deletedAt);
        const occupied = visiblePlants.filter((plant) => plant.cell).length;
        const capacity = state.gardenPlots.reduce(
            (total, plot) => total + (Number(plot.rows) || 0) * (Number(plot.columns) || 0),
            0,
        );
        const week = this.streakManager.current(state, timestamp);
        const definitions = availablePlantDefinitions(totalPoints, state.plantUnlocks);
        const treeTier = getAutomaticTreeTier(state.plants);
        return {
            totalPoints,
            unallocatedGrowthPoints: state.unallocatedGrowthPoints,
            maturePlantCount: visiblePlants.filter((plant) => plant.stage === "mature").length,
            currentPlant,
            weeklyReadingDays: week.days.length,
            nextUnlock: treeTier.next
                ? {
                    ...treeTier.next,
                    remainingTrees: treeTier.remaining,
                }
                : definitions.find((definition) => definition.locked) || null,
            treeTier,
            gardenOccupancy: { occupied, capacity },
        };
    }

    recomputeBalance(state) {
        const earned = sumLedger(state.rewardLedger);
        const invested = state.plants.reduce((total, plant) => total + (Number(plant.pointsInvested) || 0), 0);
        state.unallocatedGrowthPoints = Math.max(0, earned - invested);
        return state.unallocatedGrowthPoints;
    }

    _grantInDraft(state, input) {
        if (!input.deduplicationKey || state.rewardLedger.some(
            (entry) => entry.deduplicationKey === input.deduplicationKey,
        )) return null;
        const transaction = {
            id: uuid(this.randomUUID),
            rewardType: input.rewardType,
            points: Math.max(0, Number(input.points) || 0),
            timestamp: input.timestamp,
            localDate: localDateKey(input.timestamp),
            sessionId: input.sessionId || null,
            documentId: input.documentId || null,
            deduplicationKey: input.deduplicationKey,
            metadata: input.metadata || {},
        };
        if (!transaction.points) return null;
        state.rewardLedger.push(transaction);
        const dateCaps = state.dailyRewardCaps[transaction.localDate] || { time: 0, engagement: 0 };
        if (transaction.rewardType === REWARD_TYPES.ACTIVE_TIME) dateCaps.time += transaction.points;
        if (ENGAGEMENT_REWARD_TYPES.includes(transaction.rewardType)) dateCaps.engagement += transaction.points;
        state.dailyRewardCaps[transaction.localDate] = dateCaps;
        const lifetimePoints = sumLedger(state.rewardLedger);
        const unlocks = new Set(state.plantUnlocks);
        for (const definition of PLANT_DEFINITIONS) {
            if (lifetimePoints >= definition.unlockPoints) unlocks.add(definition.id);
        }
        state.plantUnlocks = [...unlocks];
        const session = state.sessions.find((candidate) => candidate.id === input.sessionId);
        const plant = session && state.plants.find((candidate) => candidate.id === session.plantId);
        if (plant) {
            const investment = this.gardenManager.invest(plant, transaction.points, input.timestamp);
            transaction.metadata = {
                ...transaction.metadata,
                plantId: plant.id,
                pointsInvested: investment.invested,
                excessPoints: investment.excess,
            };
            if (investment.matured && session.state === "completed") {
                transaction.metadata.gardenPlacement =
                    this.gardenManager.placeMaturePlant(state, plant, input.timestamp);
            }
        }
        this.recomputeBalance(state);
        return { ...transaction };
    }

    _emitGranted(transactions) {
        for (const transaction of transactions) {
            this.eventBus?.emit(EVENTS.REWARD_GRANTED, transaction);
            if (transaction.metadata?.gardenPlacement) {
                const state = this.storage.getSnapshot();
                const plant = state.plants.find((candidate) => candidate.id === transaction.metadata.plantId);
                this.eventBus?.emit(EVENTS.PLANT_MATURED, plant);
                this.eventBus?.emit(EVENTS.GARDEN_UPDATED, {
                    plant,
                    placement: transaction.metadata.gardenPlacement,
                });
            }
        }
    }
}
