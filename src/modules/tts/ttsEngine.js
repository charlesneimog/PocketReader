import {
    getWebsiteRoot,
    cooperativeYield,
    normalizeText,
    formatTextToSpeech,
    hasUsableSpeechText,
    isIOSLike,
    getInferenceConcurrencyProfile,
} from "../utils/helpers.js";
import { EVENTS } from "../../constants/events.js";
import { INFERENCE_BACKENDS, normalizeInferenceBackend } from "../../config.js";
import { ServerTtsClient } from "./serverTtsClient.js";
import {
    PiperWorkerPoolClient,
    getCachedJSON,
    getCachedModel,
    getUncachedJSON,
    getUncachedModel,
} from "./piper-client.js";

const USE_PERSONALIZED_PIPER_MODEL = false;
const PERSONALIZED_PIPER_MODEL_URL = "https://huggingface.co/csukuangfj/vits-piper-pt_BR-miro-high/resolve/main/pt_BR-miro-high.onnx";
const PERSONALIZED_PIPER_CONFIG_URL = "https://huggingface.co/csukuangfj/vits-piper-pt_BR-miro-high/resolve/main/pt_BR-miro-high.onnx.json";
const PERSONALIZED_PIPER_VOICE_ID = "personalized_piper_voice2";
const PERSONALIZED_PIPER_VOICE_NAME = "Personalized Piper Model2";
const TTS_OFFLINE_UNAVAILABLE = "TTS_OFFLINE_UNAVAILABLE";

export class TTSEngine {
    constructor(app) {
        this.app = app;
        this.client = null;
        this.voice = app.config.DEFAULT_PIPER_VOICE;
        this.piperInstance = null;
        this.voices = null;
        this.pendingVoiceId = null;
        this.preferredVoiceId = null;
        this.initializingPromise = null;
        this._pdfPhrasePrefetchRequestId = 0;
        this._restartAttemptedCount = 0;
        this._resetPromise = null;
        this._lifetime = 0;
        this._generation = 0;
        this._generationController = new AbortController();
        this._settingsRevision = 0;
        this.serverEnabled = !!app.state.serverTtsEnabled;
        this.provider = null;
        this._serverFailed = false;
        this._fallbackPromise = null;

        const scriptSrc = (document.currentScript && document.currentScript.src) || window.location.href;
        const scriptDir = scriptSrc.substring(0, scriptSrc.lastIndexOf("/"));
        const baseUrl = scriptDir.replace(/\/thirdparty\/piper$/, "");
        this.baseUrl = baseUrl;

        this.initialized = false;
    }

    async getVoicesLists() {
        const url = `${getWebsiteRoot()}assets/tts-voices.json`;
        let response;
        try {
            response = await fetch(url);
            if (!response.ok) throw new Error("Voice catalogue unavailable");
        } catch (err) {
            response = await globalThis.caches?.match(url);
        }
        if (!response?.ok) {
            const error = new Error("Voice catalogue is not cached. Connect once before reading offline.");
            error.code = TTS_OFFLINE_UNAVAILABLE;
            throw error;
        }
        const manifest = await response.json();
        if (!/^[a-f0-9]{40}$/.test(manifest.revision) || !manifest.voices) {
            throw new Error("Invalid voice catalogue");
        }
        this.modelRevision = manifest.revision;
        this.huggingFaceRoot = `https://huggingface.co/rhasspy/piper-voices/resolve/${manifest.revision}/`;
        return manifest.voices;
    }

    _abortError() {
        return new DOMException("Speech request cancelled", "AbortError");
    }

    _assertLifetime(lifetime) {
        if (lifetime !== this._lifetime) throw this._abortError();
    }

    cancelSynthesis() {
        this._generation++;
        this._pdfPhrasePrefetchRequestId++;
        this._generationController.abort();
        this._generationController = new AbortController();
    }

    async _releaseVoice() {
        this._lifetime++;
        this._settingsRevision++;
        this.cancelSynthesis();
        const client = this.client;
        this.client = null;
        this.initialized = false;
        this.initializingPromise = null;
        this.pendingVoiceId = null;
        this.voiceId = null;
        this.provider = null;
        this._fallbackPromise = null;
        this.app.state.piperInstance = null;
        this.app.state.currentPiperVoice = null;
        if (client instanceof ServerTtsClient) await client.close();
        else client?.terminate?.();
    }

    async beginDocument() {
        this.app.state.generationEnabled = false;
        await this._resetPromise;
        await this.deactivate();
        this._serverFailed = false;
    }

    async deactivate() {
        this.app.state.generationEnabled = false;
        this.app.state.autoAdvanceActive = false;
        this.app.ttsQueue?.reset();
        await Promise.all([this._releaseVoice(), this.app.audioManager?.stopPlayback?.(true)]);
        this.app.controlsManager?.reflectTtsProvider?.("local");
    }

    async setServerEnabled(enabled) {
        this.serverEnabled = !!enabled;
        this.app.state.serverTtsEnabled = this.serverEnabled;
        localStorage.setItem("config.serverTtsEnabled", this.serverEnabled ? "1" : "0");
        this.app.controlsManager?.reflectServerTtsEnabled?.(this.serverEnabled);
        this._serverFailed = false;
        await this.resetEngine({ preservePlayback: false, announce: false });
        await this.reconfigure();
    }

    async reconfigure() {
        const revision = ++this._settingsRevision;
        this.app.ttsQueue?.reset();
        await this.app.audioManager?.stopPlayback?.(true);
        if (revision !== this._settingsRevision) return;
        const { state } = this.app;
        state.autoAdvanceActive = false;
        this.app.cache?.clearAllAudioCache?.();
        if (!state.generationEnabled || !state.sentences.length) return;
        const voice = document.getElementById("voice-select")?.value || this.preferredVoiceId || this.voiceId;
        this.preferredVoiceId = voice;
        const client = await this.ensurePiper(voice);
        if (revision !== this._settingsRevision) return;
        if (client instanceof ServerTtsClient) {
            const lifetime = this._lifetime;
            try {
                await client.configure({ voiceId: this.voiceId, lengthScale: state.CURRENT_SPEED });
            } catch (error) {
                this._assertLifetime(lifetime);
                if (revision !== this._settingsRevision || error.name === "AbortError") return;
                await this._fallbackToLocal(this.voiceId, lifetime);
            }
        }
        if (revision === this._settingsRevision) this.schedulePrefetch();
    }

    _isOfflineTtsUnavailableError(error) {
        const message = String(error?.message || "");
        return (
            error?.code === TTS_OFFLINE_UNAVAILABLE ||
            message.includes("voices.json and no cache available") ||
            message === "Failed to fetch"
        );
    }

    _handleOfflineTtsUnavailable(sentence, error) {
        const { state } = this.app;
        if (sentence) {
            sentence.audioError = error;
            sentence.audioInProgress = false;
            sentence.prefetchQueued = false;
        }
        state.generationEnabled = false;
        state.isPlaying = false;
        state.stopRequested = true;
        this.app.ttsQueue?.reset?.();
        this.app.ui.updatePlayButton(state.playerState.DONE);
        if (!this._offlineTtsNoticeShown) {
            this._offlineTtsNoticeShown = true;
            this.app.ui.showInfo("Offline Mode: this voice is not cached yet. Connect once and load Natural Voices before using it offline.");
        }
    }

    async ensureAudioContext() {
        const { state, config } = this.app;
        if (!state.audioCtx) {
            state.audioCtx = new window.AudioContext(config.AUDIO_CONTEXT_OPTIONS);
        }
        return state.audioCtx;
    }

    _isPersonalizedPiperEnabled() {
        return USE_PERSONALIZED_PIPER_MODEL === true;
    }

    _getActiveVoiceId(voiceId) {
        return this._isPersonalizedPiperEnabled()
            ? PERSONALIZED_PIPER_VOICE_ID
            : voiceId || this.app.config.DEFAULT_PIPER_VOICE;
    }

    _getPersonalizedPiperConfig() {
        const modelUrl = PERSONALIZED_PIPER_MODEL_URL.trim();
        const configUrl = PERSONALIZED_PIPER_CONFIG_URL.trim();

        if (!modelUrl || !configUrl) {
            throw new Error(
                "Personalized Piper model is enabled, but PERSONALIZED_PIPER_MODEL_URL and PERSONALIZED_PIPER_CONFIG_URL are not set.",
            );
        }

        new URL(modelUrl, window.location.href);
        new URL(configUrl, window.location.href);
        return { modelUrl, configUrl };
    }

    _getPersonalizedVoicesList() {
        return {
            [PERSONALIZED_PIPER_VOICE_ID]: {
                name: PERSONALIZED_PIPER_VOICE_NAME,
                quality: "custom",
                language: {},
                files: {},
            },
        };
    }

    async ensurePiper(voiceId) {
        const { state, config } = this.app;
        const targetVoiceId = this._getActiveVoiceId(voiceId || config.DEFAULT_PIPER_VOICE);
        const lifetime = this._lifetime;
        if (this._fallbackPromise) {
            await this._fallbackPromise;
            this._assertLifetime(lifetime);
        }

        while (this.initializingPromise) {
            await this.initializingPromise.catch(() => {});
            this._assertLifetime(lifetime);
        }
        if (this.initialized && this.voiceId === targetVoiceId && state.piperInstance &&
            (!(this.client instanceof ServerTtsClient) || this.client.ready)) {
            return state.piperInstance;
        }

        this.app.ui.showInfo("Loading AI Natural Voices...");
        this.pendingVoiceId = targetVoiceId;
        const initialization = this._initializeVoice(targetVoiceId, lifetime)
            .then(async () => {
                this._assertLifetime(lifetime);
                await this.initVoices();
                return state.piperInstance;
            });
        this.initializingPromise = initialization;

        try {
            return await initialization;
        } finally {
            if (this.initializingPromise === initialization) {
                this.pendingVoiceId = null;
                this.initializingPromise = null;
            }
        }
    }

    async _initializeVoice(voiceId, lifetime) {
        if (!this.voices && !this._isPersonalizedPiperEnabled()) {
            const voices = await this.getVoicesLists();
            this._assertLifetime(lifetime);
            this.voices = voices;
        }
        this._assertLifetime(lifetime);
        if (this.serverEnabled && !this._serverFailed && !this._isPersonalizedPiperEnabled()) {
            const client = this.client instanceof ServerTtsClient ? this.client : new ServerTtsClient(this.app);
            this.client = client;
            this.provider = "server";
            this.app.controlsManager?.reflectTtsProvider?.("loading");
            try {
                const settings = { voiceId, lengthScale: this.app.state.CURRENT_SPEED, modelRevision: this.modelRevision };
                if (this.initialized) await client.configure(settings);
                else await client.init(settings);
                this._assertLifetime(lifetime);
                this._commitVoice(client, voiceId, "server");
                return client;
            } catch (error) {
                await client.close();
                this._assertLifetime(lifetime);
                if (error.name === "AbortError") throw error;
                this.client = null;
                this.initialized = false;
                this._serverFailed = true;
                this.app.ui.showInfo("Server speech unavailable; using this device.");
            }
        }
        return this._initializeLocalVoice(voiceId, lifetime);
    }

    _commitVoice(client, voiceId, provider) {
        this.client = client;
        this.provider = provider;
        this.voiceId = voiceId;
        this.initialized = true;
        client.availableVoices = this.voices;
        this.app.state.piperInstance = client;
        this.app.state.currentPiperVoice = voiceId;
        this.app.controlsManager?.reflectTtsProvider?.(provider);
    }

    async _initializeLocalVoice(voiceId, lifetime) {
        const { ui, state } = this.app;
        const targetVoiceId = this._getActiveVoiceId(voiceId);
        ui.updatePlayButton(state.playerState.LOADING);
        document.body.style.cursor = "wait";

        try {
            if (!this.client) {
                const workerCount = getInferenceConcurrencyProfile(this.app.config).piperWorkers;
                this.client = new PiperWorkerPoolClient({
                    size: workerCount,
                    workerUrl: "./src/modules/tts/piper.worker.js",
                    onBackendChange: ({ backend, reason }) => {
                        if (backend !== "wasm" || !this.app.isTtsWebGpuEnabled?.()) return;
                        this.app.setTtsWebGpuEnabled(false, {
                            reconfigure: false,
                            notify: true,
                            reason: reason || "WebGPU synthesis failed",
                        });
                    },
                });
            }
            const client = this.client;

            const usesPersonalizedModel = this._isPersonalizedPiperEnabled();
            if (usesPersonalizedModel) {
                this.voices = this._getPersonalizedVoicesList();
                this.client.availableVoices = this.voices;
            } else if (!this.voices) {
                this.voices = await this.getVoicesLists();
                this.client.availableVoices = this.voices;
            }

            let modelBuffer = null;
            let modelBufferFactory = null;
            let voiceConfig = null;

            if (usesPersonalizedModel) {
                const customModel = this._getPersonalizedPiperConfig();
                modelBuffer = await getUncachedModel(customModel.modelUrl, {
                    onProgress: (pct) => ui.showMessage(`Downloading personalized model: ${pct.toFixed(2)}%`, 1200),
                });
                voiceConfig = await getUncachedJSON(customModel.configUrl);
            } else {
                const voice = this.voices[targetVoiceId];
                if (!voice) {
                    ui.updatePlayButton(state.playerState.DONE);
                    throw new Error(
                        `Unknown voice: ${targetVoiceId}. Available voices: ${Object.keys(this.voices).join(", ")}`,
                    );
                }

                const filePaths = Object.keys(voice.files || {});

                const modelFile = filePaths.find((f) => f.endsWith(".onnx"));
                const configFile = filePaths.find((f) => f.endsWith(".onnx.json"));

                if (!modelFile || !configFile) {
                    ui.updatePlayButton(state.playerState.DONE);
                    throw new Error(`Voice ${targetVoiceId} is missing required model or config files.`);
                }

                const modelUrl = this.huggingFaceRoot + modelFile;
                const configUrl = this.huggingFaceRoot + configFile;

                const modelKey = `${this.modelRevision}/${modelFile}`;
                modelBuffer = await getCachedModel(modelKey, modelUrl, {
                    onProgress: (pct) => ui.showMessage(`Downloading model: ${pct.toFixed(2)}%`, 1200),
                });
                // Re-read the model from IndexedDB for the second worker so both
                // workers can initialize together without cloning the first buffer.
                modelBufferFactory = () => getCachedModel(modelKey, modelUrl);
                voiceConfig = await getCachedJSON(`${this.modelRevision}/${configFile}`, configUrl);
            }
            this._assertLifetime(lifetime);

            const baseUrl = getWebsiteRoot();
            const ortJsUrl = `${baseUrl}thirdparty/ort/ort.js`;
            const ortWasmRoot = `${baseUrl}thirdparty/ort/`;
            const phonemizerJsUrl = `${baseUrl}thirdparty/piper/piper-o91UDS6e.js`;
            const phonemizerWasmUrl = `${baseUrl}thirdparty/piper/piper_phonemize.wasm`;
            const phonemizerDataUrl = `${baseUrl}thirdparty/piper/piper_phonemize.data`;
            const maxThreads = getInferenceConcurrencyProfile(this.app.config).piperThreads;
            const backend = normalizeInferenceBackend(this.app.config.TTS_BACKEND);
            const useWebGpu = backend === INFERENCE_BACKENDS.WEBGPU;

            if (!this.initialized) {
                const workerLabel = client.size === 1 ? "AI voice worker" : `${client.size} AI voice workers`;
                ui.updateBookLoading?.(`Initializing ${workerLabel}…`);
                const runtime = await client.init({
                    modelBuffer,
                    voiceConfig,
                    ortJsUrl,
                    ortWasmRoot,
                    phonemizerJsUrl,
                    phonemizerWasmUrl,
                    phonemizerDataUrl,
                    logLevel: "error",
                    transferModel: true,
                    maxThreads,
                    useWebGpu,
                    modelBufferFactory,
                });
                console.info(
                    `[TTS] Piper ready; backend=${runtime.backend || "unknown"}; ort=${runtime.ortVersion || "unknown"}; workers=${runtime.workers || 1}; threadsPerWorker=${runtime.threadsPerWorker || runtime.threads || 1}`,
                );
                if (useWebGpu && runtime.backend === "wasm") {
                    await this.app.setTtsWebGpuEnabled?.(false, {
                        reconfigure: false,
                        notify: true,
                        reason: "WebGPU initialization failed",
                    });
                }
            } else if (this.voiceId !== targetVoiceId) {
                const runtime = await client.changeVoice({
                    modelBuffer,
                    voiceConfig,
                    modelBufferFactory,
                    transferModel: true,
                });
                console.info(`[TTS] Piper voice loaded; backend=${runtime.backend || "unknown"}`);
            }

            this._assertLifetime(lifetime);
            this._commitVoice(client, targetVoiceId, "local");

            return state.piperInstance;
        } catch (err) {
            if (lifetime !== this._lifetime) throw this._abortError();
            console.error("Failed to initialize Piper:", err);
            this.initialized = false;
            this.voiceId = null;
            state.piperInstance = null;
            state.currentPiperVoice = null;
            if (this.client) {
                try {
                    this.client.terminate();
                } catch (_) {}
            }
            this.client = null;
            throw err;
        } finally {
            if (lifetime === this._lifetime) {
                document.body.style.cursor = "default";
                ui.updatePlayButton(state.playerState.DONE);
            }
        }
    }

    async _fallbackToLocal(voiceId, lifetime) {
        this._assertLifetime(lifetime);
        if (this.provider === "local" && this.initialized) return this.client;
        if (!this._fallbackPromise) {
            this._serverFailed = true;
            const remote = this.client;
            this.client = null;
            this.initialized = false;
            this.app.state.piperInstance = null;
            this._fallbackPromise = (async () => {
                await remote?.close?.();
                this._assertLifetime(lifetime);
                this.app.ui.showInfo("Server speech unavailable; using this device for this book.");
                return this._initializeLocalVoice(voiceId, lifetime);
            })();
        }
        const fallback = this._fallbackPromise;
        try {
            return await fallback;
        } finally {
            if (this._fallbackPromise === fallback) this._fallbackPromise = null;
        }
    }

    async _synthesizePhrase(text, voiceId, task) {
        let client = await this.ensurePiper(voiceId);
        this._assertTask(task);
        const options = { createBlob: true, signal: task.signal };
        try {
            return await client.synthesize(text, task.speed, undefined, options);
        } catch (error) {
            this._assertTask(task);
            if (!(client instanceof ServerTtsClient)) throw error;
            client = await this._fallbackToLocal(voiceId, task.lifetime);
            this._assertTask(task);
            return client.synthesize(text, task.speed, undefined, options);
        }
    }

    _assertTask(task) {
        if (task.signal.aborted || task.generation !== this._generation || task.lifetime !== this._lifetime ||
            !this.app.state.generationEnabled || this.app.state.sentences[task.index] !== task.sentence) {
            throw this._abortError();
        }
    }

    async safeDecodeAudioData(arrayBuffer) {
        const { state } = this.app;
        await this.ensureAudioContext();
        if (!arrayBuffer || arrayBuffer.byteLength < 100) throw new Error("Audio buffer too small/invalid.");
        try {
            return await state.audioCtx.decodeAudioData(arrayBuffer.slice(0));
        } catch (err) {
            try {
                if (state.audioCtx) await state.audioCtx.close();
            } catch {}
            state.audioCtx = null;
            await this.ensureAudioContext();
            return state.audioCtx.decodeAudioData(arrayBuffer.slice(0));
        }
    }

    _getWordBoxViewport(word) {
        if (word?.bbox && Number.isFinite(word.bbox.x1) && Number.isFinite(word.bbox.y1)) {
            return { x1: word.bbox.x1, y1: word.bbox.y1, x2: word.bbox.x2, y2: word.bbox.y2 };
        }
        const x1 = Number(word?.x) || 0;
        const y2 = Number(word?.y) || 0;
        const width = Number(word?.width) || 0;
        const height = Number(word?.height) || 0;
        return { x1, y1: y2 - height, x2: x1 + width, y2 };
    }

    _boxesOverlap(a, b) {
        const overlapX = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
        const overlapY = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
        return overlapX > 0 && overlapY > 0;
    }

    _findReadableLayoutBlockKey(word, readableBoxes) {
        const box = this._getWordBoxViewport(word);
        for (let i = 0; i < readableBoxes.length; i++) {
            if (this._boxesOverlap(box, readableBoxes[i])) return `readable:${i}`;
        }
        return "readable:unassigned";
    }

    async _getSpeechPhraseEntries(sentence, sourceText) {
        const { state, config } = this.app;
        const fallback = (sourceText || "").trim();
        if (!fallback) return [];

        if (this.app.isReadTranslationEnabled?.() && Array.isArray(sentence?.readTranslationPhraseEntries)) {
            const translatedEntries = sentence.readTranslationPhraseEntries.filter(
                (entry) => hasUsableSpeechText(entry?.text),
            );
            if (translatedEntries.length) return translatedEntries;
        }

        if (
            state.currentDocumentType !== "pdf" ||
            !config.SPLIT_PDF_AUDIO_ON_LAYOUT_BLOCKS
        ) {
            return [{ text: fallback, blockKey: null }];
        }

        const words =
            Array.isArray(sentence?.readableWords) && sentence.readableWords.length
                ? sentence.readableWords
                : Array.isArray(sentence?.words)
                  ? sentence.words.filter((word) => word?.isReadable !== false)
                  : [];
        if (words.length < 2 || !this.app.getPdfHeaderFooterDetector || !sentence?.pageNumber) {
            return [{ text: fallback, blockKey: null }];
        }

        let layoutRegions = null;
        try {
            layoutRegions = await this.app.getPdfHeaderFooterDetector().getLayoutRegions(sentence.pageNumber);
        } catch (err) {
            console.warn("[TTS] Failed to get PDF layout regions for audio phrase split", err);
            return [{ text: fallback, blockKey: null }];
        }

        const readableBoxes = Array.isArray(layoutRegions?.readableBoxes) ? layoutRegions.readableBoxes : [];
        if (readableBoxes.length < 2) return [{ text: fallback, blockKey: null }];

        const groups = [];
        let currentWords = [];
        let currentBlockKey = null;

        const flush = () => {
            if (!currentWords.length) return;
            const text =
                this.app.sentenceParser?.joinWords?.(currentWords) || currentWords.map((w) => w?.str || "").join(" ");
            if (hasUsableSpeechText(text)) groups.push({ text: text.trim(), blockKey: currentBlockKey });
            currentWords = [];
        };

        for (const word of words) {
            const blockKey = this._findReadableLayoutBlockKey(word, readableBoxes);
            if (currentBlockKey !== null && blockKey !== currentBlockKey) flush();
            currentBlockKey = blockKey;
            currentWords.push(word);
        }
        flush();

        return groups.length > 1 ? groups : [{ text: fallback, blockKey: null }];
    }

    _createSilenceBuffer(durationSec, sampleRate, channels) {
        const { state } = this.app;
        const audioCtx = state.audioCtx;
        const length = Math.max(0, Math.round(durationSec * sampleRate));
        return audioCtx.createBuffer(channels, length, sampleRate);
    }

    _concatAudioBuffers(buffers) {
        const { state } = this.app;
        const audioCtx = state.audioCtx;
        const validBuffers = buffers.filter(Boolean);
        if (validBuffers.length === 1) return validBuffers[0];
        if (!validBuffers.length) throw new Error("No decoded audio buffers to concatenate");

        const sampleRate = validBuffers[0].sampleRate;
        const channels = Math.max(...validBuffers.map((buffer) => buffer.numberOfChannels || 1));
        const length = validBuffers.reduce((sum, buffer) => sum + buffer.length, 0);
        const output = audioCtx.createBuffer(channels, length, sampleRate);

        let offset = 0;
        for (const buffer of validBuffers) {
            for (let channel = 0; channel < channels; channel++) {
                const input = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
                output.getChannelData(channel).set(input, offset);
            }
            offset += buffer.length;
        }

        return output;
    }

    _buildWordBoundariesForAudio(phrases, decodedBuffers, finalBuffer, pauseSec = 0) {
        const { config } = this.app;
        if (!config.ENABLE_WORD_HIGHLIGHT) return [];

        const wordBoundaries = [];
        let offsetMs = 0;
        for (let i = 0; i < phrases.length; i++) {
            const phrase = phrases[i] || "";
            const buffer = decodedBuffers[i];
            if (!buffer) continue;

            const words = phrase.split(/\s+/).filter(Boolean);
            const total = words.length || 1;
            const totalMs = buffer.duration * 1000;
            for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
                wordBoundaries.push({
                    text: words[wordIndex],
                    offsetMs: Math.floor(offsetMs + (wordIndex / total) * totalMs),
                    durationMs: Math.floor(totalMs / total),
                });
            }
            offsetMs += buffer.duration * 1000;
            if (i < phrases.length - 1) offsetMs += pauseSec * 1000;
        }

        if (!wordBoundaries.length && finalBuffer?.duration) {
            const words = phrases.join(" ").split(/\s+/).filter(Boolean);
            const total = words.length || 1;
            const totalMs = finalBuffer.duration * 1000;
            for (let i = 0; i < words.length; i++) {
                wordBoundaries.push({
                    text: words[i],
                    offsetMs: Math.floor((i / total) * totalMs),
                    durationMs: Math.floor(totalMs / total),
                });
            }
        }

        return wordBoundaries;
    }

    _audioCacheKey(voice, speed, text) {
        return `${this.modelRevision || "custom"}|${voice}|${speed}|${text}`;
    }

    async buildPiperAudio(sentence, voice, text, task) {
        const { state, config } = this.app;
        const activeVoice = this._getActiveVoiceId(voice);

        await this.ensureAudioContext();
        await this.ensurePiper(activeVoice);
        this._assertTask(task);
        await cooperativeYield();

        const rawPhraseEntries = await this._getSpeechPhraseEntries(sentence, text);
        this._assertTask(task);
        const phraseEntries = rawPhraseEntries
            .map((entry) => ({
                text: normalizeText(entry?.text || ""),
                blockKey: entry?.blockKey || null,
            }))
            .filter((entry) => hasUsableSpeechText(entry.text));
        if (!phraseEntries.length) {
            sentence.audioError = new Error("No speech text available after PDF layout phrase split");
            return;
        }
        const phrases = phraseEntries.map((entry) => entry.text);

        const decodedSpeechBuffers = [];
        const buffersForPlayback = [];
        const ttsPhraseTimings = [];
        let effectiveBlob = null;
        const pauseSec =
            Number.isFinite(config.PDF_AUDIO_LAYOUT_BLOCK_PAUSE_SEC) && phraseEntries.length > 1
                ? Math.max(0, config.PDF_AUDIO_LAYOUT_BLOCK_PAUSE_SEC)
                : 0;

        let phraseOffsetMs = 0;
        for (let i = 0; i < phraseEntries.length; i++) {
            const phrase = phraseEntries[i].text;
            const cleaned = formatTextToSpeech(phrase);
            console.info(`[TTS] Rendering phrase: ${JSON.stringify(cleaned)}`);
            const result = await this._synthesizePhrase(cleaned, activeVoice, task);
            this._assertTask(task);
            const { blob: audioBlob, mimeType = "audio/wav" } = result;
            const encodedBuffer = result.encodedBuffer || result.wavBuffer;

            let bufferForDecode = null;
            if (encodedBuffer instanceof ArrayBuffer) {
                bufferForDecode = encodedBuffer;
            } else if (ArrayBuffer.isView(encodedBuffer)) {
                bufferForDecode = encodedBuffer.buffer.slice(encodedBuffer.byteOffset, encodedBuffer.byteOffset + encodedBuffer.byteLength);
            } else if (audioBlob?.arrayBuffer) {
                bufferForDecode = await audioBlob.arrayBuffer();
            } else {
                throw new Error("Invalid audio buffer returned from Piper worker");
            }

            const decoded = await this.safeDecodeAudioData(bufferForDecode.slice(0));
            this._assertTask(task);
            decodedSpeechBuffers.push(decoded);
            buffersForPlayback.push(decoded);
            ttsPhraseTimings.push({
                blockKey: phraseEntries[i].blockKey,
                offsetMs: Math.floor(phraseOffsetMs),
                durationMs: Math.floor(decoded.duration * 1000),
            });
            phraseOffsetMs += decoded.duration * 1000;

            if (!effectiveBlob && phraseEntries.length === 1) {
                effectiveBlob = audioBlob || new Blob([bufferForDecode], { type: mimeType });
            }

            if (pauseSec > 0 && i < phraseEntries.length - 1) {
                buffersForPlayback.push(
                    this._createSilenceBuffer(pauseSec, decoded.sampleRate, decoded.numberOfChannels),
                );
                phraseOffsetMs += pauseSec * 1000;
            }
        }

        const decoded = this._concatAudioBuffers(buffersForPlayback);
        const wordBoundaries = this._buildWordBoundariesForAudio(phrases, decodedSpeechBuffers, decoded, pauseSec);
        this._assertTask(task);
        const wavBlob = config.MAKE_WAV_COPY && effectiveBlob?.type === "audio/wav" ? effectiveBlob : null;

        if (!this._isPersonalizedPiperEnabled()) {
            const cacheKey = this._audioCacheKey(activeVoice, task.speed, sentence.normalizedText);
            state.audioCache.set(cacheKey, {
                // HTMLAudioElement is the playback source. Retain the worker's
                // WAV so sentence transitions do not re-encode the AudioBuffer.
                audioBlob: effectiveBlob,
                wavBlob,
                audioBuffer: decoded,
                wordBoundaries,
                ttsPhraseTimings,
            });
        }

        Object.assign(sentence, {
            audioBlob: effectiveBlob,
            wavBlob,
            audioBuffer: decoded,
            audioReady: true,
            lastVoice: activeVoice,
            lastSpeed: task.speed,
            prefetchQueued: false,
            audioError: null,
            wordBoundaries,
            ttsPhraseTimings,
        });
        sentence._restartRetryCount = 0;
        delete sentence._restartAttempted;
    }

    async synthesizeSequential(idx) {
        const { state, config } = this.app;
        const sentence = state.sentences[idx];
        if (!state.generationEnabled || !sentence?.isTextToRead || sentence.audioInProgress) return;
        const task = {
            index: idx,
            sentence,
            speed: state.CURRENT_SPEED,
            generation: this._generation,
            lifetime: this._lifetime,
            signal: this._generationController.signal,
        };
        sentence.audioInProgress = true;
        sentence.audioError = null;
        try {
            const baseText = sentence.readableText?.trim() || sentence.text;
            const text = this.app.getSentenceSpeechText
                ? await this.app.getSentenceSpeechText(idx, baseText)
                : baseText;
            this._assertTask(task);
            if (!text?.trim()) throw new Error("No speech text available for synthesis");
            if (this.app.isReadTranslationEnabled?.()) {
                await this.app.ensureReadTranslationVoiceReady?.();
                this._assertTask(task);
            }
            const voice = this._getActiveVoiceId(
                document.getElementById("voice-select")?.value || this.preferredVoiceId || config.DEFAULT_PIPER_VOICE,
            );
            if (!hasUsableSpeechText(text)) {
                this._markSentenceAsSilent(sentence);
                return;
            }
            const normalized = normalizeText(text);
            const needsTimings = state.currentDocumentType === "pdf" && config.SPLIT_PDF_AUDIO_ON_LAYOUT_BLOCKS &&
                sentence.readableWords?.length > 1;
            if (sentence.audioReady && sentence.lastVoice === voice && sentence.lastSpeed === task.speed &&
                sentence.normalizedText === normalized && (!needsTimings || sentence.ttsPhraseTimings?.length)) return;

            sentence.normalizedText = normalized;
            const key = this._audioCacheKey(voice, task.speed, normalized);
            const cached = !this._isPersonalizedPiperEnabled() && state.audioCache.get(key);
            if (cached && (!needsTimings || cached.ttsPhraseTimings?.length)) {
                Object.assign(sentence, {
                    ...cached,
                    audioReady: true,
                    lastVoice: voice,
                    lastSpeed: task.speed,
                    audioError: null,
                    prefetchQueued: false,
                });
                return;
            }
            this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_START, { index: idx });
            await this.buildPiperAudio(sentence, voice, text, task);
        } catch (error) {
            if (error.name !== "AbortError" && task.generation === this._generation &&
                state.sentences[idx] === sentence) {
                sentence.audioError = error;
                if (this._isOfflineTtsUnavailableError(error)) this._handleOfflineTtsUnavailable(sentence, error);
                else this.app.ui.showMessage(`Unable to generate speech: ${error.message}`, 3200);
            }
            throw error;
        } finally {
            if (task.generation === this._generation && state.sentences[idx] === sentence) {
                sentence.audioInProgress = false;
            }
        }
    }

    schedulePrefetch() {
        const { state, config } = this.app;
        if (!state.generationEnabled) return;
        this._pruneAudioForLowMemory(state.currentSentenceIndex);
        const isPdf = state.currentDocumentType === "pdf";
        const prefetchLimit = isIOSLike()
            ? 1
            : isPdf
              ? Math.max(0, Number(config.PDF_PREFETCH_PHRASES) || 3)
              : Math.max(0, Number(config.PREFETCH_AHEAD) || 0);
        if (state.currentSentenceIndex >= 0) {
            this.app.ttsQueue.add(state.currentSentenceIndex, true);
            this.app.prefetchSentenceTranslationForTTS?.(state.currentSentenceIndex);
        }

        const base = state.currentSentenceIndex;
        if (isPdf) {
            this._schedulePdfPhrasePrefetch(base, prefetchLimit);
            return;
        }

        for (let i = base + 1; i <= base + prefetchLimit && i < state.sentences.length; i++) {
            this.app.ttsQueue.add(i);
            this.app.prefetchSentenceTranslationForTTS?.(i);
        }
    }

    _pruneAudioForLowMemory(centerIndex) {
        if (!isIOSLike() || !Number.isFinite(centerIndex) || centerIndex < 0) return;
        const { state } = this.app;
        const nextAudioIndex = state.sentences.findIndex(
            (sentence, index) =>
                index > centerIndex &&
                (sentence?.audioReady || sentence?.audioInProgress || sentence?.prefetchQueued),
        );
        const retainedIndices = new Set([centerIndex]);
        if (nextAudioIndex >= 0) retainedIndices.add(nextAudioIndex);

        // Sentence objects already own the active buffers, so retaining the same
        // buffers in the global cache only lengthens their lifetime on iPadOS.
        state.audioCache.clear();
        for (let index = 0; index < state.sentences.length; index++) {
            const sentence = state.sentences[index];
            if (!sentence || sentence.audioInProgress || retainedIndices.has(index)) continue;
            sentence.audioBlob = null;
            sentence.wavBlob = null;
            sentence.audioBuffer = null;
            sentence.audioReady = false;
            sentence.audioError = null;
            sentence.prefetchQueued = false;
            sentence.normalizedText = null;
            sentence.wordBoundaries = [];
            sentence.ttsPhraseTimings = [];
        }

        if (Array.isArray(this.app.ttsQueue?.queue)) {
            this.app.ttsQueue.queue = this.app.ttsQueue.queue.filter((index) => retainedIndices.has(index));
        }
    }

    _schedulePdfPhrasePrefetch(fromIndex, limit) {
        if (!Number.isFinite(fromIndex) || fromIndex < 0 || limit <= 0) return;
        const requestId = ++this._pdfPhrasePrefetchRequestId;

        Promise.resolve()
            .then(() => this._prefetchPdfPhrasesAhead(fromIndex, limit, requestId))
            .catch((error) => console.warn("[TTSEngine] PDF phrase prefetch failed", error));
    }

    async _prefetchPdfPhrasesAhead(fromIndex, limit, requestId) {
        const { state } = this.app;
        const pdf = state.pdf;
        if (!pdf || state.currentDocumentType !== "pdf") return;

        let queued = 0;
        for (let index = fromIndex + 1; index < state.sentences.length && queued < limit; index++) {
            if (requestId !== this._pdfPhrasePrefetchRequestId || state.pdf !== pdf) return;

            let sentence = state.sentences[index];
            if (!sentence) continue;

            if (!sentence.layoutProcessed) {
                await this.app.pdfRenderer.ensureFullPageRendered(sentence.pageNumber);
                if (requestId !== this._pdfPhrasePrefetchRequestId || state.pdf !== pdf) return;

                await this.app.getPdfHeaderFooterDetector().ensureReadabilityForPage(sentence.pageNumber);
                if (requestId !== this._pdfPhrasePrefetchRequestId || state.pdf !== pdf) return;
                sentence = state.sentences[index];
            }

            if (!sentence?.layoutProcessed || !sentence.isTextToRead) continue;

            this.app.ttsQueue.add(index);
            this.app.prefetchSentenceTranslationForTTS?.(index);
            queued += 1;
            await cooperativeYield();
        }
    }

    _markSentenceAsSilent(sentence) {
        if (!sentence) return;
        sentence.isTextToRead = false;
        sentence.audioReady = false;
        sentence.audioBuffer = null;
        sentence.audioError = null;
        sentence.prefetchQueued = false;
        sentence.wordBoundaries = [];
        sentence.ttsPhraseTimings = [];
    }

    async initVoices() {
        const { state, config } = this.app;
        const voiceSelect = document.getElementById("voice-select");
        if (this._isPersonalizedPiperEnabled()) {
            if (!voiceSelect) return;
            voiceSelect.innerHTML = "";
            const opt = document.createElement("option");
            opt.value = PERSONALIZED_PIPER_VOICE_ID;
            opt.textContent = PERSONALIZED_PIPER_VOICE_NAME;
            voiceSelect.appendChild(opt);
            voiceSelect.value = PERSONALIZED_PIPER_VOICE_ID;
            state.currentPiperVoice = PERSONALIZED_PIPER_VOICE_ID;
            const micIcon = document.getElementById("mic-icon");
            if (micIcon) {
                micIcon.classList.remove("fa-spinner", "fa-spin");
                micIcon.classList.add("fa-microphone");
            }
            return;
        }

        const voicesSource = this.voices || state.piperInstance?.availableVoices;
        if (!voiceSelect || !voicesSource) return;
        voiceSelect.innerHTML = "";
        const allVoices = voicesSource;
        let firstAvailableVoice = null;
        config.PIPER_VOICES.forEach((v) => {
            const voiceDef = allVoices[v];
            if (!voiceDef) return;
            const opt = document.createElement("option");
            opt.value = v;
            const lang = voiceDef["language"] || {};
            const flag = this.app.helpers.regionToFlag(lang["region"] || "");
            const qual = this.app.helpers.capitalizeFirst(voiceDef["quality"] || "");
            const voiceName = this.app.helpers.capitalizeFirst(voiceDef["name"] || v);
            if (qual === "High") {
                opt.textContent = `${flag} ${voiceName} ${qual} - Need Fast CPU`;
            } else {
                opt.textContent = `${flag} ${voiceName} ${qual}`;
            }
            voiceSelect.appendChild(opt);
            if (!firstAvailableVoice) firstAvailableVoice = v;
        });

        const requestedVoiceId = this.preferredVoiceId || this.voiceId || config.DEFAULT_PIPER_VOICE;
        const hasRequestedOption = Array.from(voiceSelect.options).some((opt) => opt.value === requestedVoiceId);
        const selectedVoiceId = hasRequestedOption
            ? requestedVoiceId
            : firstAvailableVoice || voiceSelect.options[0]?.value || config.DEFAULT_PIPER_VOICE;
        voiceSelect.value = selectedVoiceId;
        this.preferredVoiceId = null;
        const micIcon = document.getElementById("mic-icon");
        if (micIcon) {
            micIcon.classList.remove("fa-spinner", "fa-spin");
            micIcon.classList.add("fa-microphone");
        }
    }

    async resetEngine({ clearCache = true, reason, preservePlayback = true, attempt, announce = true } = {}) {
        const { state } = this.app;

        if (this._resetPromise) {
            await this._resetPromise.catch(() => {});
            return;
        }

        if (announce) this._restartAttemptedCount += 1;
        const attemptNo = Number.isFinite(attempt) ? attempt : this._restartAttemptedCount;
        if (announce) {
            console.warn(`[TTS] Restarting engine (attempt ${attemptNo})`, reason || "");
            this.app.ui.showMessage(
                `TTS warning: restart attempt ${attemptNo}.${preservePlayback ? " Reader keeps playing." : ""}`,
                2800,
            );
        } else {
            console.info("[TTS] Reconfiguring engine", reason || "");
        }

        const activePlayingSentence =
            preservePlayback && state.isPlaying && state.playingSentenceIndex >= 0
                ? state.sentences[state.playingSentenceIndex]
                : null;

        this._resetPromise = (async () => {
            this.app.ttsQueue?.reset();
            await this._releaseVoice();

            const shouldRecycleAudioContext = !preservePlayback || !state.isPlaying;
            if (state.audioCtx && shouldRecycleAudioContext) {
                try {
                    await state.audioCtx.close();
                } catch (err) {
                    console.warn("AudioContext close failed:", err);
                }
                state.audioCtx = null;
            }

            state.piperInstance = null;
            state.currentPiperVoice = null;
            state.piperLoading = false;

            if (!preservePlayback) {
                state.stopRequested = false;
            }

            if (clearCache && state.audioCache) {
                try {
                    state.audioCache.clear();
                } catch (err) {
                    console.warn("Audio cache clear failed:", err);
                }
            }

            if (clearCache && Array.isArray(state.sentences)) {
                for (const sentence of state.sentences) {
                    if (!sentence) continue;

                    const keepLivePlaybackSentence = !!activePlayingSentence && sentence === activePlayingSentence;
                    if (keepLivePlaybackSentence) {
                        sentence.audioInProgress = false;
                        sentence.audioError = null;
                        sentence.prefetchQueued = false;
                        continue;
                    }

                    if (Array.isArray(sentence.playbackWordTimers)) {
                        for (const timer of sentence.playbackWordTimers) clearTimeout(timer);
                    }
                    sentence.playbackWordTimers = [];
                    sentence.audioBlob = null;
                    sentence.wavBlob = null;
                    sentence.audioBuffer = null;
                    sentence.audioReady = false;
                    sentence.audioInProgress = false;
                    sentence.lastVoice = null;
                    sentence.lastSpeed = null;
                    sentence.audioError = null;
                    sentence.prefetchQueued = false;
                    sentence.wordBoundaries = [];
                    sentence.ttsPhraseTimings = [];
                    sentence._restartRetryCount = 0;
                    delete sentence._restartAttempted;
                }
            }
        })();

        try {
            await this._resetPromise;
        } finally {
            this._resetPromise = null;
        }
    }

}
