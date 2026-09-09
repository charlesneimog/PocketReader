import { EVENTS } from "../../constants/events.js";
import { getInferenceConcurrencyProfile } from "../utils/helpers.js";

export class TTSQueueManager {
    constructor(app) {
        this.app = app;
        this.queue = [];
        this.active = 0;
        this.inFlight = new Set();
    }

    add(idx, priority = false) {
        const { state } = this.app;
        if (!state.generationEnabled) return;
        const sentence = state.sentences[idx];
        if (priority && sentence?.audioReady && idx === state.currentSentenceIndex && !state.isPlaying) {
            this.app.audioManager.playCurrentSentence();
        }
        if (!sentence || sentence.audioReady || sentence.audioInProgress) return;

        if (!sentence.layoutProcessed) {
            if (!sentence.layoutProcessingPromise) {
                if (state.currentDocumentType !== "pdf" || !this.app.getPdfHeaderFooterDetector) return;
                sentence.layoutProcessingPromise = this.app.getPdfHeaderFooterDetector()
                    .ensureReadabilityForPage(sentence.pageNumber)
                    .catch((err) => {
                        console.warn("Layout filtering failed for sentence", sentence.index, err);
                    })
                    .finally(() => {
                        sentence.layoutProcessingPromise = null;
                        this.add(idx, priority);
                    });
            }
            return;
        }

        if (!sentence.isTextToRead) {
            return;
        }

        if (this.queue.includes(idx) || this.inFlight.has(idx)) return;
        const idle = this.active === 0 && this.queue.length === 0;
        sentence.prefetchQueued = true;
        priority ? this.queue.unshift(idx) : this.queue.push(idx);
        if (idle && !state.isPlaying) {
            this.app.ui.updatePlayButton(state.playerState.LOADING);
        }
        this.run();
    }

    run() {
        const { config } = this.app;
        const profile = getInferenceConcurrencyProfile(config);
        const maxConcurrent = Math.min(
            Math.max(1, Number(config.MAX_CONCURRENT_SYNTH) || 1),
            profile.piperWorkers,
        );
        while (this.active < maxConcurrent && this.queue.length) {
            const idx = this.queue.shift();
            this.startTask(idx);
        }
    }

    async startTask(idx) {
        const { state } = this.app;
        const sentence = state.sentences[idx];
        if (!sentence) return;

        if (!sentence.layoutProcessed) {
            this.add(idx, true);
            this.run();
            return;
        }

        if (sentence.audioReady || sentence.audioInProgress || !sentence.isTextToRead) {
            this.run();
            return;
        }

        this.active++;
        this.inFlight.add(idx);
        try {
            await this.app.ttsEngine.synthesizeSequential(idx);
            // if sentence is same as current sentence, then begin playback immediately
            if (idx === state.currentSentenceIndex && !state.isPlaying) {
                this.app.ui.updatePlayButton(state.playerState.DONE);
                this.app.audioManager.playCurrentSentence();
            }
            this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_COMPLETE, { index: idx });

        } catch (e) {
            console.warn("Synthesis failure:", e);
            this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_ERROR, { index: idx, error: e });
        } finally {
            this.active--;
            this.inFlight.delete(idx);
            this.run();
            if (this.active === 0 && this.queue.length === 0 && !state.isPlaying) {
                this.app.ui.updatePlayButton(state.playerState.DONE);
            }
        }
    }

    reset() {
        this.queue = [];
        this.active = 0;
        this.inFlight.clear();
    }
}
