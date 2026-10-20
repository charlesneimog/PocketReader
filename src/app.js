import { CONFIG, INFERENCE_BACKENDS, normalizeInferenceBackend } from "./config.js";
import { EventBus } from "./core/eventBus.js";
import { StateManager } from "./core/stateManager.js";
import { CacheManager } from "./core/cacheManager.js";
import { EVENTS } from "./constants/events.js";

import * as helperFns from "./modules/utils/helpers.js";
import { ensureAriaRegions } from "./modules/utils/ariaManager.js";
import { viewportHeightManager } from "./modules/utils/viewport.js";

import { PDFLoader } from "./modules/pdf/pdfLoader.js";
import { PDFRenderer } from "./modules/pdf/pdfRenderer.js";
import { PDFHeaderFooterDetector } from "./modules/pdf/pdfHeaderFooterDetector.js";
import { SentenceParser } from "./modules/pdf/sentenceParser.js";

import { EPUBLoader } from "./modules/epub/epubLoader.js";

import { TTSEngine } from "./modules/tts/ttsEngine.js";
import {
    isSmartphoneEnvironment,
    resolveTtsWebGpuPreference,
} from "./modules/tts/ttsBackendPreference.js";
import { AudioManager } from "./modules/tts/audioManager.js";
import { TTSQueueManager } from "./modules/tts/synthesisQueue.js";
import { WordHighlighter } from "./modules/tts/wordHighlighter.js";

import { InteractionHandler } from "./modules/ui/interactionHandler.js";
import { ControlsManager } from "./modules/ui/controlsManager.js";
import { HighlightManager } from "./modules/ui/highlightManager.js";
import { UIService } from "./modules/ui/uiService.js";

import { ProgressManager } from "./modules/storage/progressManager.js";
import { HighlightsStorage } from "./modules/storage/highlightsStorage.js";
import { ExportManager } from "./modules/storage/exportManager.js";
import { PDFThumbnailCache } from "./modules/storage/pdfThumbnailCache.js";
import { SyncManager } from "./modules/storage/syncManager.js";
import { initializeRewards } from "./modules/rewards/index.js";

export class PDFTTSApp {
    constructor() {
        // UI
        this.ui = new UIService(this);
        this.interactionHandler = new InteractionHandler(this);
        this.controlsManager = new ControlsManager(this);
        this.highlightManager = new HighlightManager(this);

        // config
        this.config = CONFIG;
        this.state = new StateManager(this);
        this.eventBus = new EventBus();
        this.cache = new CacheManager(this.state);

        // Runtime settings
        this._autoTranslateCache = new Map();
        this._autoTranslateInFlight = new Set();

        // Runtime: sentence translations used for TTS substitution
        this._readTranslationCache = new Map();
        this._readTranslationInFlight = new Map();
        this._loadRuntimeSettings();

        // Utilities
        this.helpers = helperFns;
        this.viewportManager = viewportHeightManager;
        this._handleViewportHeightChange = this._handleViewportHeightChange.bind(this);

        // Storage / Persistence
        this.progressManager = new ProgressManager(this);
        this.highlightsStorage = new HighlightsStorage(this);
        this.exportManager = new ExportManager(this);
        this.pdfThumbnailCache = new PDFThumbnailCache(this);
        // Keep the historic property name while routing storage through the
        // selected self-host or Google Drive backend.
        this.serverSync = new SyncManager(this);
        void this.controlsManager.refreshReadingDigestPreference();

        // PDF / Text
        this.pdfLoader = new PDFLoader(this);
        this.epubLoader = new EPUBLoader(this);
        this.epubRenderer = this.epubLoader.renderer;
        this._pdfRenderer = new PDFRenderer(this);
        this.pdfRenderer = this._createRendererProxy();
        this._pdfHeaderFooterDetector = null;
        this.pdfHeaderFooterDetector = null;
        this.sentenceParser = new SentenceParser(this);

        // TTS / Audio
        this.ttsEngine = new TTSEngine(this);
        this.audioManager = new AudioManager(this);
        this.ttsQueue = new TTSQueueManager(this);
        this.wordHighlighter = new WordHighlighter(this);
        // pagehide is best effort; the server lease also covers killed phones.
        window.addEventListener("pagehide", () => { void this.ttsEngine.deactivate(); });

        this._setupAutoTranslate();
        this._setupReadTranslation();
        this._setupOriginalSubtitles();
        this.showSavedPDFs();

        // app version
        const appVersion = `${this.config.VERSION_MAJOR}.${this.config.VERSION_MINOR}.${this.config.VERSION_PATCH}+${this.config.VERSION_BUILD}`;
        document.getElementById("appversion-p").textContent = `v${appVersion}`;
        document.getElementById("appversion").textContent = `v${appVersion}`;
    }

    _createRendererProxy() {
        const getRenderer = () => {
            if (this.state.currentDocumentType === "epub") {
                return this.epubRenderer ?? this.epubLoader?.renderer ?? this.epubLoader;
            }
            return this._pdfRenderer;
        };

        return new Proxy(
            {},
            {
                get: (_target, prop) => {
                    if (prop === "getUnderlyingRenderer") return getRenderer;
                    const renderer = getRenderer();
                    const value = renderer[prop];
                    return typeof value === "function" ? value.bind(renderer) : value;
                },
                set: (_target, prop, value) => {
                    const renderer = getRenderer();
                    renderer[prop] = value;
                    return true;
                },
                has: (_target, prop) => {
                    const renderer = getRenderer();
                    return prop in renderer;
                },
            },
        );
    }

    getActiveRenderer() {
        return this.state.currentDocumentType === "epub" ? this.epubRenderer : this._pdfRenderer;
    }

    getPdfHeaderFooterDetector() {
        if (!this._pdfHeaderFooterDetector) {
            this._pdfHeaderFooterDetector = new PDFHeaderFooterDetector(this);
            this.pdfHeaderFooterDetector = this._pdfHeaderFooterDetector;
        }
        return this._pdfHeaderFooterDetector;
    }

    releasePdfHeaderFooterDetector() {
        this._pdfHeaderFooterDetector?.dispose?.();
        this._pdfHeaderFooterDetector = null;
        this.pdfHeaderFooterDetector = null;
    }

    _getSentencePhraseEntries(index) {
        const sentence = this.state?.sentences?.[index];
        if (!sentence) return [];

        if (this.state.currentDocumentType === "pdf") {
            const layoutEntries = this.pdfRenderer?.getLayoutPhraseEntriesForSentence?.(sentence) || [];
            if (layoutEntries.length) return layoutEntries;
        }

        const text = String(sentence.readableText || sentence.text || sentence.originalText || "").trim();
        return text ? [{ blockKey: sentence.layoutBlockKey || null, text, words: sentence.readableWords || [] }] : [];
    }

    _getActiveSentencePhraseEntry(index, blockKey = null) {
        const entries = this._getSentencePhraseEntries(index);
        if (!entries.length) return null;

        const { state } = this;
        const activeBlockKey =
            blockKey ||
            (state.playingSentenceIndex === index ? state.playingPhraseBlockKey : null) ||
            (state.hoveredSentenceIndex === index ? state.hoveredPhraseBlockKey : null) ||
            state.sentences[index]?.layoutBlockKey ||
            null;
        return entries.find((entry) => entry.blockKey === activeBlockKey) || entries[0];
    }

    _getPhraseCacheKey(index, blockKey = null) {
        return `${index}::${blockKey || "sentence"}`;
    }

    async translateCurrentSentence() {
        const { state } = this;
        if (!state?.sentences?.length) {
            this.ui?.showInfo?.("Load a document first");
            return;
        }

        const idx =
            typeof state.playingSentenceIndex === "number" && state.playingSentenceIndex >= 0
                ? state.playingSentenceIndex
                : state.currentSentenceIndex;
        const phrase = this._getActiveSentencePhraseEntry(idx);
        const text = String(phrase?.text || "").trim();
        if (!text) return;

        this.ui?.showInfo?.("Translating...");
        const result = await this.serverSync.translateText(text);
        if (!result) return;

        await this.ui?.showTranslatePopup?.({
            originalText: text,
            translatedText: result.translatedText || "",
            target: result.target || "",
            detectedSource: result.detectedSource || "",
        });
    }

    _loadRuntimeSettings() {
        const crossOriginIsolated = window.crossOriginIsolated === true;
        const sharedArrayBufferAvailable = typeof globalThis.SharedArrayBuffer === "function";
        console.info(
            `[Runtime] Cross-origin isolation=${crossOriginIsolated ? "enabled" : "disabled"}; crossOriginIsolated=${crossOriginIsolated}; SharedArrayBuffer=${sharedArrayBufferAvailable}; WASM threads=${crossOriginIsolated && sharedArrayBufferAvailable ? "available" : "unavailable"}`,
        );

        const raw = localStorage.getItem("config.autoTranslate");
        this.state.serverTtsEnabled = localStorage.getItem("config.serverTtsEnabled") === "1";
        this.controlsManager?.reflectServerTtsEnabled?.(this.state.serverTtsEnabled);
        const enabled = raw === "1" || raw === "true";
        this.state.autoTranslateEnabled = enabled;
        this.controlsManager?.reflectAutoTranslateToggle?.(enabled);

        const rawReadTranslation = localStorage.getItem("config.readTranslation");
        const readTranslationEnabled = rawReadTranslation === "1" || rawReadTranslation === "true";
        this.state.readTranslationEnabled = readTranslationEnabled;
        this.controlsManager?.reflectReadTranslationToggle?.(readTranslationEnabled);

        const rawOriginalSubtitles = localStorage.getItem("config.originalSubtitles");
        const originalSubtitlesEnabled = rawOriginalSubtitles === "1" || rawOriginalSubtitles === "true";
        this.state.originalSubtitlesEnabled = originalSubtitlesEnabled;
        this.controlsManager?.reflectOriginalSubtitlesToggle?.(originalSubtitlesEnabled);

        const rawTextWidthFit = localStorage.getItem("config.textWidthFit");
        const textWidthFitEnabled = rawTextWidthFit === "1" || rawTextWidthFit === "true";
        this.state.textWidthFitEnabled = textWidthFitEnabled;
        this.controlsManager?.reflectTextWidthFitToggle?.(textWidthFitEnabled);

        // Backend selection is automatic. Remove the retired manual preference
        // so an old setting cannot override the current device decision.
        localStorage.removeItem("config.ttsWebGpu");
        const ttsEnvironment = {
            userAgent: navigator.userAgent,
            viewportWidth: window.innerWidth,
            coarsePointer: window.matchMedia?.("(pointer: coarse)")?.matches === true,
            maxTouchPoints: navigator.maxTouchPoints,
            mobileBreakpoint: this.config.MOBILE_BREAKPOINT,
        };
        this._isSmartphoneRuntime = isSmartphoneEnvironment(ttsEnvironment);
        const configuredTtsBackend = normalizeInferenceBackend(this.config.TTS_BACKEND, INFERENCE_BACKENDS.WASM);
        const ttsWebGpuEnabled =
            configuredTtsBackend === INFERENCE_BACKENDS.WEBGPU && resolveTtsWebGpuPreference(ttsEnvironment);
        this.state.ttsWebGpuEnabled = ttsWebGpuEnabled;
        this.config.TTS_BACKEND = ttsWebGpuEnabled ? INFERENCE_BACKENDS.WEBGPU : INFERENCE_BACKENDS.WASM;
        console.info(
            `[TTS] Automatic backend=${ttsWebGpuEnabled ? "WebGPU preferred" : "parallel WASM"} (${this._isSmartphoneRuntime ? "smartphone compatibility" : "desktop runtime detection"})`,
        );
    }

    isTtsWebGpuEnabled() {
        return !!this.state.ttsWebGpuEnabled;
    }

    startBookOpenPlaybackTimer({ bookName = "", documentType = "unknown", storageKey = null } = {}) {
        this._bookOpenPlaybackTimer = {
            startedAt: performance.now(),
            bookName: String(bookName || ""),
            documentType: String(documentType || "unknown"),
            storageKey,
        };
        console.info(
            `[Startup] Translation setup complete; TTS startup timer started: ${JSON.stringify(this._bookOpenPlaybackTimer.bookName)} (${this._bookOpenPlaybackTimer.documentType})`,
        );
    }

    finishBookOpenPlaybackTimer({ sentenceIndex = null } = {}) {
        const timer = this._bookOpenPlaybackTimer;
        if (!timer) return null;
        this._bookOpenPlaybackTimer = null;
        const elapsedMs = Math.round(performance.now() - timer.startedAt);
        console.info(
            `[Startup] Translation setup to TTS audio playing: ${elapsedMs} ms`,
            {
                bookName: timer.bookName,
                documentType: timer.documentType,
                sentenceIndex,
            },
        );
        return elapsedMs;
    }

    cancelBookOpenPlaybackTimer(reason = "book open cancelled") {
        if (!this._bookOpenPlaybackTimer) return;
        console.info(`[Startup] TTS startup timer cancelled: ${reason}`);
        this._bookOpenPlaybackTimer = null;
    }

    async setTtsWebGpuEnabled(
        enabled,
        { reconfigure = true, notify = true, reason = "Automatic TTS backend changed" } = {},
    ) {
        const value = this._isSmartphoneRuntime ? false : !!enabled;
        if (enabled && this._isSmartphoneRuntime) {
            if (notify) this.ui?.showInfo?.("TTS WebGPU is disabled on smartphones; using parallel WASM workers");
            return;
        }
        const changed = value !== !!this.state.ttsWebGpuEnabled;
        this.state.ttsWebGpuEnabled = value;
        this.config.TTS_BACKEND = value ? INFERENCE_BACKENDS.WEBGPU : INFERENCE_BACKENDS.WASM;

        if (changed && reconfigure && (this.ttsEngine?.initialized || this.ttsEngine?.client)) {
            this.audioManager?.stopPlayback?.(true);
            this.state.autoAdvanceActive = false;
            this.ttsQueue?.reset?.();
            this.cache?.clearAudioFrom?.(Math.max(0, this.state.currentSentenceIndex));
            await this.ttsEngine.resetEngine({
                clearCache: true,
                reason,
                preservePlayback: false,
                announce: false,
            });
        }

        if (notify) {
            this.ui?.showInfo?.(value ? "TTS WebGPU enabled" : "TTS WebGPU disabled; using WASM");
        }
    }

    _normalizeTranslationTarget(target) {
        const raw = String(target || "")
            .trim()
            .replace(/_/g, "-");
        if (!raw) return "pt";

        const lower = raw.toLowerCase();
        if (/^[a-z]{2,3}$/.test(lower)) return lower;

        const parts = lower.split("-");
        if (parts.length === 2 && /^[a-z]{2,3}$/.test(parts[0]) && /^[a-z0-9]{2,4}$/.test(parts[1])) {
            return `${parts[0]}-${parts[1].toUpperCase()}`;
        }

        return "pt";
    }

    _getTranslationTargetLanguage() {
        try {
            const saved = localStorage.getItem("config.translationTarget");
            return this._normalizeTranslationTarget(saved);
        } catch {
            return "pt";
        }
    }

    _setTranslationTargetLanguage(target) {
        const normalized = this._normalizeTranslationTarget(target);
        try {
            localStorage.setItem("config.translationTarget", normalized);
        } catch {
            // ignore localStorage access failures
        }
        return normalized;
    }

    async _canReachTranslationService(target = "en") {
        const now = Date.now();
        if (this._translationAvailabilityCache && now - this._translationAvailabilityCache.checkedAt < 15000) {
            return this._translationAvailabilityCache.available;
        }

        const targetLang = this._normalizeTranslationTarget(target || "en");
        const available = await this.serverSync?.checkTranslationAvailability?.(targetLang, { timeoutMs: 5000 });

        this._translationAvailabilityCache = {
            available: !!available,
            checkedAt: Date.now(),
        };
        return !!available;
    }

    _normalizeTranslationMode(mode) {
        const value = String(mode || "")
            .trim()
            .toLowerCase();
        if (value === "read" || value === "show" || value === "off") return value;
        return "off";
    }

    _getCurrentSpeedControlValue() {
        const speedInput = document.getElementById("reading-speed");
        const raw = Number.parseFloat(speedInput?.value ?? "1");
        if (!Number.isFinite(raw)) return 1;
        return Math.min(2, Math.max(0.5, raw));
    }

    _applyReadingSpeedFromPopup(speedValue) {
        const speedInput = document.getElementById("reading-speed");
        if (!speedInput) return;

        const parsed = Number.parseFloat(speedValue);
        if (!Number.isFinite(parsed)) return;
        const clamped = Math.min(2, Math.max(0.5, parsed));
        speedInput.value = String(clamped);

        speedInput.dispatchEvent(new Event("input", { bubbles: true }));
        speedInput.dispatchEvent(new Event("change", { bubbles: true }));
    }

    _getSavedTranslationSettingsForDocument(docKey, docType = "pdf") {
        if (!docKey) return null;
        const type = docType === "epub" ? "epub" : "pdf";
        const entry = this.progressManager?.loadSavedPosition?.(docKey, type) || null;
        if (!entry || typeof entry !== "object") return null;

        const targetRaw = entry.translationTarget;
        const modeRaw = entry.translationMode;
        if (!targetRaw && !modeRaw) return null;

        return {
            originalLanguage: this._normalizeTranslationTarget(entry.originalLanguage || this._getDefaultOriginalLanguage()),
            target: this._normalizeTranslationTarget(targetRaw),
            mode: this._normalizeTranslationMode(modeRaw),
            speed: Number.isFinite(Number(entry.readingSpeed))
                ? Math.min(2, Math.max(0.5, Number(entry.readingSpeed)))
                : this._getCurrentSpeedControlValue(),
        };
    }

    _getDefaultOriginalLanguage() {
        const voiceSelect = document.getElementById("voice-select");
        const voice =
            voiceSelect?.value ||
            this.ttsEngine?.preferredVoiceId ||
            this.state?.currentPiperVoice ||
            this.config.DEFAULT_PIPER_VOICE;
        return this._normalizeTranslationTarget(this._getVoicePrimaryLanguage(voice) || "en");
    }

    _saveTranslationSettingsForDocumentLocal(
        docKey,
        docType = "pdf",
        { originalLanguage, target, mode, speed } = {},
    ) {
        if (!docKey) return;
        const type = docType === "epub" ? "epub" : "pdf";

        const map = this.progressManager.getProgressMap();
        const compoundKey = `${type}::${docKey}`;
        const existing = map[compoundKey] || {};

        map[compoundKey] = {
            ...existing,
            originalLanguage: this._normalizeTranslationTarget(originalLanguage || this._getDefaultOriginalLanguage()),
            translationTarget: this._normalizeTranslationTarget(target),
            translationMode: this._normalizeTranslationMode(mode),
            readingSpeed: Number.isFinite(Number(speed))
                ? Math.min(2, Math.max(0.5, Number(speed)))
                : this._getCurrentSpeedControlValue(),
            updated: Date.now(),
            docType: type,
        };

        if (type === "pdf" && docKey in map) {
            delete map[docKey];
        }
        this.progressManager.setProgressMap(map);
    }

    async _persistTranslationSettingsForDocument(
        docKey,
        docType = "pdf",
        { originalLanguage, target, mode, speed } = {},
    ) {
        if (!docKey) return;
        const type = docType === "epub" ? "epub" : "pdf";

        const targetNorm = this._normalizeTranslationTarget(target);
        const modeNorm = this._normalizeTranslationMode(mode);

        this._saveTranslationSettingsForDocumentLocal(docKey, type, {
            originalLanguage,
            target: targetNorm,
            mode: modeNorm,
            speed,
        });

        if (this.serverSync?.isEnabled?.()) {
            this.serverSync.syncTranslationSettings(docKey, { target: targetNorm, mode: modeNorm }).catch((err) => {
                console.warn("[translationPrompt] failed to sync translation settings", err);
            });
        }
    }

    _getDocumentKeyBeforeLoad(file, docType, options = {}) {
        if (options?.existingKey) return String(options.existingKey || "").trim();
        if (!(file instanceof File)) return "";

        if (docType === "epub") {
            return this.epubLoader.computeEpubKeyFromDescriptor({
                type: "file",
                name: file.name,
                size: file.size,
                lastModified: file.lastModified,
            });
        }

        return this.pdfLoader.computePdfKeyFromSource({
            type: "file",
            name: file.name,
            size: file.size,
            lastModified: file.lastModified,
        });
    }

    async _promptTranslationSetupBeforeOpen(file, docType, options = {}) {
        if (!(file instanceof File)) {
            return { proceed: true, shouldPlay: false, setup: null };
        }
        if (options?.showTranslationSetup === false) {
            return { proceed: true, shouldPlay: !!options?.playAfterLoad, setup: null };
        }

        const type = docType === "epub" ? "epub" : "pdf";
        const docKey = this._getDocumentKeyBeforeLoad(file, type, options);
        const bookTitle = String(file.name || "").trim();
        const label = type === "epub" ? "EPUB" : "PDF";
        const subtitle = bookTitle
            ? `Set up how "${bookTitle}" should be read`
            : `Set up how this ${label} should be read`;
        const savedPrefs = this._getSavedTranslationSettingsForDocument(docKey, type);
        const configured = !!savedPrefs;
        const initialOriginalLanguage = savedPrefs?.originalLanguage || this._getDefaultOriginalLanguage();
        const initialTarget = savedPrefs?.target || this._getTranslationTargetLanguage();
        const translationAvailable = await this._canReachTranslationService(initialTarget);
        const promptSubtitle = translationAvailable
            ? subtitle
            : `Offline mode for "${bookTitle || label}": choose the original reading language`;

        const response = await this.ui?.showTranslationSetupPrompt?.({
            subtitle: promptSubtitle,
            initialOriginalLanguage,
            initialTarget,
            initialMode: savedPrefs?.mode || "off",
            initialSpeed: savedPrefs?.speed || this._getCurrentSpeedControlValue(),
            translationAvailable,
            configured: configured && (translationAvailable || savedPrefs?.mode === "off"),
        });

        if (!response) return { proceed: false, shouldPlay: false, setup: null };

        const originalLanguage = this._normalizeTranslationTarget(response.originalLanguage);
        const mode = translationAvailable ? this._normalizeTranslationMode(response.mode) : "off";
        const target = this._setTranslationTargetLanguage(response.target);
        this._applyReadingSpeedFromPopup(response.speed);
        await this._persistTranslationSettingsForDocument(docKey, type, {
            originalLanguage,
            target,
            mode,
            speed: response.speed,
        });
        this._applyTranslationMode(mode, target);

        const setup = {
            docKey,
            docType: type,
            originalLanguage,
            target,
            mode,
            speed: response.speed,
        };
        this._applyReadingSetupVoicePreference(setup);

        return {
            proceed: true,
            shouldPlay: response.action === "start" || response.action === "keep",
            setup,
        };
    }

    _applyReadingSetupVoicePreference({ originalLanguage, target, mode } = {}) {
        const spokenLanguage = mode === "read" ? target : originalLanguage;
        const voice = this._pickVoiceForLanguage(spokenLanguage);
        if (!voice) return;

        this.ttsEngine.preferredVoiceId = voice;
        const voiceSelect = document.getElementById("voice-select");
        if (voiceSelect && Array.from(voiceSelect.options || []).some((option) => option.value === voice)) {
            voiceSelect.value = voice;
        }
    }

    _applyTranslationMode(mode, target) {
        if (mode === "read") {
            this.setReadTranslationEnabled(true);
            this.setAutoTranslateEnabled(false);
            this.ui?.showInfo?.(`Translation: read mode (${target})`);
            return;
        }

        if (mode === "show") {
            this.setReadTranslationEnabled(false);
            this.setAutoTranslateEnabled(true);
            this.ui?.showInfo?.(`Translation: show mode (${target})`);
            return;
        }

        this.setReadTranslationEnabled(false);
        this.setAutoTranslateEnabled(false);
        this.ui?.showInfo?.("Translation: OFF");
    }

    async _startPlaybackAfterDocumentLoad() {
        if (!this.state?.sentences?.length) {
            this.ui?.finishPlaybackPreparation?.();
            return;
        }
        try {
            this.ui?.updatePlaybackPreparation?.("Loading the selected voice…");
            await this.ensureReadTranslationVoiceReady?.();
            await this.audioManager?.playCurrentSentence?.();
        } finally {
            if (!this.state.isPlaying) {
                this.ui?.finishPlaybackPreparation?.();
            }
        }
    }

    async _ensureVoiceForTranslationSetup(setup) {
        if (!this.state?.sentences?.length) return;

        if (setup) {
            const spokenLanguage = setup.mode === "read" ? setup.target : setup.originalLanguage;
            const setupVoice = this._pickVoiceForLanguage(spokenLanguage);
            if (setupVoice) {
                await this.ttsEngine.ensurePiper(setupVoice);
                return;
            }
        }

        const voiceSelect = document.getElementById("voice-select");
        const voice = voiceSelect?.value || this.state.currentPiperVoice || this.config.DEFAULT_PIPER_VOICE;
        await this.ttsEngine.ensurePiper(voice);
    }

    _resolveVoiceForDocumentWarmup(file, options = {}, setup = null) {
        if (setup) {
            const spokenLanguage = setup.mode === "read" ? setup.target : setup.originalLanguage;
            return this._pickVoiceForLanguage(spokenLanguage) || this.config.DEFAULT_PIPER_VOICE;
        }

        const docKey = setup?.docKey || this._getDocumentKeyBeforeLoad(file, "pdf", options);
        const saved = docKey ? this.progressManager?.loadSavedPosition?.(docKey, "pdf") : null;
        if (typeof saved?.voice === "string" && saved.voice.trim()) {
            return saved.voice.trim();
        }

        const voiceSelect = document.getElementById("voice-select");
        return (
            voiceSelect?.value ||
            this.ttsEngine.preferredVoiceId ||
            this.state.currentPiperVoice ||
            this.config.DEFAULT_PIPER_VOICE
        );
    }

    _warmVoiceForPdf(file, options = {}, setup = null) {
        const voice = this._resolveVoiceForDocumentWarmup(file, options, setup);
        console.info(`[TTS] Starting PDF voice warm-up: ${voice}`);
        return this.ttsEngine.ensurePiper(voice);
    }

    _warmLayoutForPdf() {
        console.info("[Layout] Starting PDF layout-model warm-up before document setup");
        return this.getPdfHeaderFooterDetector().prepare();
    }

    setAutoTranslateEnabled(enabled) {
        const value = !!enabled;
        this.state.autoTranslateEnabled = value;
        localStorage.setItem("config.autoTranslate", value ? "1" : "0");
        this.controlsManager?.reflectAutoTranslateToggle?.(value);
        if (!value) this._resetAutoTranslateCache();
        if (value) this._kickAutoTranslatePrefetch();
        this.pdfRenderer?.refreshTextWidthFit?.();
    }

    isAutoTranslateEnabled() {
        return !!this.state.autoTranslateEnabled;
    }

    setReadTranslationEnabled(enabled) {
        const value = !!enabled;
        this.state.readTranslationEnabled = value;
        localStorage.setItem("config.readTranslation", value ? "1" : "0");
        this.controlsManager?.reflectReadTranslationToggle?.(value);
        if (!value) this._resetReadTranslationCache();
        this.pdfRenderer?.refreshTextWidthFit?.();
    }

    isReadTranslationEnabled() {
        return !!this.state.readTranslationEnabled;
    }

    setTextWidthFitEnabled(enabled) {
        const value = !!enabled;
        this.state.textWidthFitEnabled = value;
        localStorage.setItem("config.textWidthFit", value ? "1" : "0");
        this.controlsManager?.reflectTextWidthFitToggle?.(value);
        this.pdfRenderer?.refreshTextWidthFit?.({ scrollToFocus: true });
    }

    isTextWidthFitEnabled() {
        return !!this.state.textWidthFitEnabled;
    }

    setOriginalSubtitlesEnabled(enabled) {
        const value = !!enabled;
        this.state.originalSubtitlesEnabled = value;
        localStorage.setItem("config.originalSubtitles", value ? "1" : "0");
        this.controlsManager?.reflectOriginalSubtitlesToggle?.(value);
        if (!value) this.ui?._hideTranslatePopup?.();
        if (value && !this.isReadTranslationEnabled() && !this.isAutoTranslateEnabled()) {
            const index =
                typeof this.state.playingSentenceIndex === "number" && this.state.playingSentenceIndex >= 0
                    ? this.state.playingSentenceIndex
                    : this.state.currentSentenceIndex;
            if (Number.isFinite(index) && index >= 0) {
                this._showOriginalSubtitleForPlayback(index).catch((err) => {
                    console.warn("[subtitles] failed to show current original-language subtitle", err);
                });
            }
        }
    }

    isOriginalSubtitlesEnabled() {
        return !!this.state.originalSubtitlesEnabled;
    }

    _setupAutoTranslate() {
        const resetOnDocChange = () => {
            this._resetAutoTranslateCache();
            if (this.isAutoTranslateEnabled()) this._kickAutoTranslatePrefetch();
        };

        this.eventBus.on(EVENTS.PDF_LOADED, resetOnDocChange);
        this.eventBus.on(EVENTS.EPUB_LOADED, resetOnDocChange);
        this.eventBus.on(EVENTS.SENTENCES_PARSED, resetOnDocChange);

        this.eventBus.on(EVENTS.AUDIO_PLAYBACK_START, ({ index } = {}) => {
            if (!this.isAutoTranslateEnabled()) return;
            if (!Number.isFinite(index)) return;
            this._handleAutoTranslatePlaybackStart(index, this.state.playingPhraseBlockKey);
        });

        this.eventBus.on(EVENTS.AUDIO_PHRASE_CHANGE, ({ index, blockKey } = {}) => {
            if (!this.isAutoTranslateEnabled()) return;
            if (!Number.isFinite(index)) return;
            this._handleAutoTranslatePlaybackStart(index, blockKey);
        });
    }

    _resetAutoTranslateCache() {
        this._autoTranslateCache.clear();
        this._autoTranslateInFlight.clear();
    }

    _setupReadTranslation() {
        const resetOnDocChange = () => {
            this._resetReadTranslationCache();
        };

        this.eventBus.on(EVENTS.PDF_LOADED, resetOnDocChange);
        this.eventBus.on(EVENTS.EPUB_LOADED, resetOnDocChange);
        this.eventBus.on(EVENTS.SENTENCES_PARSED, resetOnDocChange);

        this.eventBus.on(EVENTS.AUDIO_PLAYBACK_START, ({ index } = {}) => {
            if (!this.isReadTranslationEnabled()) return;
            if (!Number.isFinite(index) || index < 0) return;
            this._showReadTranslationPopupForPlayback(index).catch((err) => {
                console.warn("[translation] failed to show read-translation popup", err);
            });
        });

        this.eventBus.on(EVENTS.AUDIO_PHRASE_CHANGE, ({ index, blockKey } = {}) => {
            if (!this.isReadTranslationEnabled()) return;
            if (!Number.isFinite(index) || index < 0) return;
            this._showReadTranslationPopupForPlayback(index, blockKey).catch((err) => {
                console.warn("[translation] failed to update read-translation popup", err);
            });
        });
    }

    _setupOriginalSubtitles() {
        this.eventBus.on(EVENTS.AUDIO_PLAYBACK_START, ({ index } = {}) => {
            if (!this.isOriginalSubtitlesEnabled()) return;
            if (this.isReadTranslationEnabled() || this.isAutoTranslateEnabled()) return;
            if (!Number.isFinite(index) || index < 0) return;
            this._showOriginalSubtitleForPlayback(index).catch((err) => {
                console.warn("[subtitles] failed to show original-language subtitle", err);
            });
        });

        this.eventBus.on(EVENTS.AUDIO_PHRASE_CHANGE, ({ index } = {}) => {
            if (!this.isOriginalSubtitlesEnabled()) return;
            if (this.isReadTranslationEnabled() || this.isAutoTranslateEnabled()) return;
            if (!Number.isFinite(index) || index < 0) return;
            this._showOriginalSubtitleForPlayback(index).catch((err) => {
                console.warn("[subtitles] failed to update original-language subtitle", err);
            });
        });

        const hideOriginalSubtitle = () => {
            if (!this.isOriginalSubtitlesEnabled()) return;
            if (this.isReadTranslationEnabled() || this.isAutoTranslateEnabled()) return;
            this.ui?._hideTranslatePopup?.();
        };
        this.eventBus.on(EVENTS.AUDIO_PLAYBACK_PAUSE, hideOriginalSubtitle);
        this.eventBus.on(EVENTS.AUDIO_PLAYBACK_END, hideOriginalSubtitle);
    }

    async _showOriginalSubtitleForPlayback(index) {
        const sentence = this.state?.sentences?.[index];
        if (!sentence) return;

        const text =
            this.interactionHandler?.getCurrentPhraseTextForCopy?.({ fallbackToSelection: false }) ||
            sentence.originalText ||
            sentence.readableText ||
            sentence.text ||
            "";
        const originalText = String(text || "").trim();
        if (!originalText) return;
        if (!this.isOriginalSubtitlesEnabled()) return;
        if (this.isReadTranslationEnabled() || this.isAutoTranslateEnabled()) return;

        const stillCurrent = this.state.playingSentenceIndex === index || this.state.currentSentenceIndex === index;
        if (!stillCurrent) return;

        await this.ui?.showTranslatePopup?.({
            originalText,
            translatedText: originalText,
            target: "",
            detectedSource: "",
        });
    }

    _getVoicePrimaryLanguage(voiceId) {
        const token = String(voiceId || "")
            .split("-")[0]
            .split("_")[0]
            .trim()
            .toLowerCase();
        return token || "";
    }

    _pickVoiceForLanguage(targetLanguage) {
        const targetPrimary = this._normalizeTranslationTarget(targetLanguage).split("-")[0].toLowerCase();
        if (!targetPrimary) return null;

        const voiceSelect = document.getElementById("voice-select");
        const availableVoices = voiceSelect?.options?.length
            ? Array.from(voiceSelect.options).map((opt) => opt.value)
            : this.config.PIPER_VOICES || [];

        const exact = availableVoices.find((voiceId) => this._getVoicePrimaryLanguage(voiceId) === targetPrimary);
        if (exact) return exact;
        return null;
    }

    async _syncTtsVoiceWithTranslationTarget(targetLanguage) {
        if (!this.isReadTranslationEnabled()) return;

        const nextVoice = this._pickVoiceForLanguage(targetLanguage);
        if (!nextVoice) return;
        if (this.state.currentPiperVoice === nextVoice && this.state.piperInstance) return;

        const voiceSelect = document.getElementById("voice-select");
        if (voiceSelect && Array.from(voiceSelect.options || []).some((opt) => opt.value === nextVoice)) {
            voiceSelect.value = nextVoice;
        }

        await this.ttsEngine.ensurePiper(nextVoice);

        const fromIndex = Math.max(0, this.state.currentSentenceIndex || 0);
        this.cache.clearAudioFrom(fromIndex);
        this.ttsEngine.schedulePrefetch();

        const docType = this.state.currentDocumentType === "epub" ? "epub" : "pdf";
        const fileId = docType === "epub" ? this.state.currentEpubKey : this.state.currentPdfKey;
        if (fileId && this.serverSync?.isEnabled?.()) {
            this.serverSync.queueVoiceSync(fileId, nextVoice);
        }
    }

    async ensureReadTranslationVoiceReady() {
        if (!this.isReadTranslationEnabled()) return;
        await this._syncTtsVoiceWithTranslationTarget(this._getTranslationTargetLanguage());
    }

    async _showReadTranslationPopupForPlayback(index, blockKey = null) {
        const sentence = this.state?.sentences?.[index];
        const phrase = this._getActiveSentencePhraseEntry(index, blockKey);
        const originalText = String(phrase?.text || "").trim();
        if (!originalText) return;

        if (!Array.isArray(sentence?.readTranslationPhraseEntries)) {
            await this.getSentenceSpeechText(index, sentence?.readableText || sentence?.text || originalText);
        }
        const translatedPhrase = sentence?.readTranslationPhraseEntries?.find(
            (entry) => entry.blockKey === phrase?.blockKey,
        );
        const translatedText = translatedPhrase?.text || originalText;
        if (!this.isReadTranslationEnabled()) return;

        const stillCurrent = this.state.playingSentenceIndex === index || this.state.currentSentenceIndex === index;
        if (!stillCurrent) return;

        await this.ui?.showTranslatePopup?.({
            originalText,
            translatedText: translatedText.trim() || originalText,
            target: this._getTranslationTargetLanguage(),
            detectedSource: "",
        });
    }

    _resetReadTranslationCache() {
        this._readTranslationCache.clear();
        this._readTranslationInFlight.clear();
        for (const sentence of this.state?.sentences || []) {
            delete sentence.readTranslationPhraseEntries;
        }
    }

    _getReadTranslationKey(index, blockKey = null) {
        const { state } = this;
        const docType = state.currentDocumentType || "pdf";
        const docKey = docType === "epub" ? state.currentEpubKey : state.currentPdfKey;
        return `${docType}::${docKey || ""}::${this._getPhraseCacheKey(index, blockKey)}`;
    }

    prefetchSentenceTranslationForTTS(index) {
        if (!this.isReadTranslationEnabled()) return;
        if (!Number.isFinite(index) || index < 0) return;
        const sentence = this.state?.sentences?.[index];
        const text = (sentence?.readableText || sentence?.text || "").trim();
        if (!text) return;
        this.getSentenceSpeechText(index, text).catch(() => {});
    }

    async _getReadTranslationForPhrase(index, phrase) {
        const base = String(phrase?.text || "").trim();
        if (!base) return "";
        const key = this._getReadTranslationKey(index, phrase?.blockKey);
        const cached = this._readTranslationCache.get(key);
        if (typeof cached === "string" && cached.trim()) return cached.trim();

        let inFlight = this._readTranslationInFlight.get(key);
        if (!inFlight) {
            inFlight = (async () => {
                const result = await this.serverSync.translateText(base);
                const translatedText = String(result?.translatedText || "").trim();
                if (translatedText) this._readTranslationCache.set(key, translatedText);
                return translatedText || base;
            })()
                .catch(() => base)
                .finally(() => this._readTranslationInFlight.delete(key));
            this._readTranslationInFlight.set(key, inFlight);
        }
        return (await inFlight) || base;
    }

    async getSentenceSpeechText(index, fallbackText) {
        const base = (fallbackText || "").trim();
        if (!base) return "";
        if (!this.isReadTranslationEnabled()) return base;

        const phrases = this._getSentencePhraseEntries(index);
        const effectivePhrases = phrases.length ? phrases : [{ blockKey: null, text: base }];
        const translatedTexts = await Promise.all(
            effectivePhrases.map((phrase) => this._getReadTranslationForPhrase(index, phrase)),
        );
        const sentence = this.state?.sentences?.[index];
        if (sentence) {
            sentence.readTranslationPhraseEntries = effectivePhrases.map((phrase, phraseIndex) => ({
                blockKey: phrase.blockKey,
                text: translatedTexts[phraseIndex] || phrase.text,
            }));
        }
        return translatedTexts.filter(Boolean).join(" ") || base;
    }

    _kickAutoTranslatePrefetch() {
        const { state } = this;
        const baseIdx =
            typeof state.playingSentenceIndex === "number" && state.playingSentenceIndex >= 0
                ? state.playingSentenceIndex
                : state.currentSentenceIndex;
        if (!Number.isFinite(baseIdx) || baseIdx < 0) return;

        const nextIdx = this._getNextTranslatableSentenceIndex(baseIdx);
        if (Number.isFinite(nextIdx)) this._prefetchSentenceTranslation(nextIdx);
    }

    _handleAutoTranslatePlaybackStart(index, blockKey = null) {
        const phrase = this._getActiveSentencePhraseEntry(index, blockKey);
        if (!phrase) return;
        const cacheKey = this._getPhraseCacheKey(index, phrase.blockKey);
        const cached = this._autoTranslateCache.get(cacheKey);
        if (cached) {
            this.ui?.showTranslatePopup?.(cached).catch(() => {});
        } else {
            this._prefetchSentenceTranslation(index, phrase.blockKey, { showWhenReady: true });
        }

        const nextIdx = this._getNextTranslatableSentenceIndex(index);
        if (Number.isFinite(nextIdx)) this._prefetchSentenceTranslation(nextIdx);
    }

    _getNextTranslatableSentenceIndex(fromIndex) {
        const { state } = this;
        const start = Math.max(-1, Number(fromIndex));
        const list = state?.sentences || [];
        for (let i = start + 1; i < list.length; i++) {
            const s = list[i];
            const text = (s?.text || "").trim();
            if (!text) continue;
            // PDF readability filter (EPUB sentences won't have this flag).
            if (s && s.isTextToRead === false) continue;
            return i;
        }
        return null;
    }

    _prefetchSentenceTranslation(index, blockKey = null, { showWhenReady = false } = {}) {
        if (!this.isAutoTranslateEnabled()) return;
        if (!Number.isFinite(index) || index < 0) return;
        const phrase = this._getActiveSentencePhraseEntry(index, blockKey);
        const text = String(phrase?.text || "").trim();
        if (!text) return;
        const cacheKey = this._getPhraseCacheKey(index, phrase.blockKey);
        if (this._autoTranslateCache.has(cacheKey)) return;
        if (this._autoTranslateInFlight.has(cacheKey)) return;

        this._autoTranslateInFlight.add(cacheKey);
        (async () => {
            try {
                const result = await this.serverSync.translateText(text);
                if (!result) return;
                const popup = {
                    originalText: text,
                    translatedText: result.translatedText || "",
                    target: result.target || "",
                    detectedSource: result.detectedSource || "",
                };
                this._autoTranslateCache.set(cacheKey, popup);

                const activePhrase = this._getActiveSentencePhraseEntry(index);
                if (
                    showWhenReady &&
                    this.state.playingSentenceIndex === index &&
                    activePhrase?.blockKey === phrase.blockKey
                ) {
                    await this.ui?.showTranslatePopup?.(popup);
                }
            } catch (e) {
                console.warn("[autoTranslate] prefetch failed", e);
            } finally {
                this._autoTranslateInFlight.delete(cacheKey);
            }
        })();
    }

    _getTotalPageCount() {
        if (this.state.currentDocumentType === "epub") {
            if (Number.isFinite(this.state.chapterCount) && this.state.chapterCount > 0) {
                return this.state.chapterCount;
            }
            return this.state.pagesCache.size || 0;
        }
        return this.state.pdf?.numPages || 0;
    }

    async _ensureAriaRegions() {
        ensureAriaRegions(this.config);
    }

    async _loadInitialPDF() {
        await this.loadPDF();
    }

    async initialize() {
        this.viewportManager.addListener(this._handleViewportHeightChange);
        this.viewportManager.start();
        this._handleViewportHeightChange(this.viewportManager.getCurrentHeight());
        await this._ensureAriaRegions();
        await initializeRewards(this);
        await this._loadInitialPDF();
    }

    // Public API methods preserving original signatures:
    async loadPDF(file = null, options = {}) {
        // Layout initialization does not depend on the selected language, voice,
        // or parsed PDF pages. Start it before awaiting the setup popup so model
        // download/cache lookup and ONNX session creation overlap user choice.
        // Detector preparation is idempotent; PDFLoader reuses this same promise.
        if (file instanceof File) {
            this._warmLayoutForPdf().catch((error) => {
                console.warn("[Layout] Early PDF model warm-up failed", error);
            });
        }

        const setup = await this._promptTranslationSetupBeforeOpen(file, "pdf", options);
        if (!setup.proceed) return null;
        if (file instanceof File) await this.ttsEngine.beginDocument();
        const speechLifetime = this.ttsEngine._lifetime;
        if (setup.shouldPlay) {
            this.startBookOpenPlaybackTimer({
                bookName: file?.name || "",
                documentType: "pdf",
                storageKey: options?.existingKey || null,
            });
        }

        if (file !== null) {
            const nopdf = document.getElementById("no-pdf-overlay");
            nopdf.style.display = "none";
        }

        // Voice initialization is independent of PDF parsing and layout-model
        // loading. Starting it here overlaps model download/cache lookup and
        // ONNX session creation with the document pipeline.
        const voiceWarmupPromise =
            file instanceof File
                ? this._warmVoiceForPdf(file, options, setup.setup).catch((error) => {
                      console.warn("[TTS] Early PDF voice warm-up failed; the normal initialization will retry", error);
                      return null;
                  })
                : Promise.resolve(null);

        let result;
        try {
            result = await this.pdfLoader.loadPDF(file, options);
        } catch (error) {
            if (speechLifetime === this.ttsEngine._lifetime) await this.ttsEngine.deactivate();
            throw error;
        }
        if (speechLifetime !== this.ttsEngine._lifetime) return null;
        this.ui?.setBookLoadingPageReady?.();
        this._setReaderScrollbarsHidden(this.state.currentDocumentType === "pdf" && !!this.state.pdf);
        if (setup.setup?.docKey) {
            await this._persistTranslationSettingsForDocument(setup.setup.docKey, "pdf", setup.setup);
        }
        await voiceWarmupPromise;
        if (speechLifetime !== this.ttsEngine._lifetime) return null;
        // Re-check after loading because server/local resume data may have
        // selected a different voice while the early warm-up was running.
        try {
            await this._ensureVoiceForTranslationSetup(setup.setup);
            this.serverSync?.startAutoSync();
            if (setup.shouldPlay) await this._startPlaybackAfterDocumentLoad();
        } catch (error) {
            if (setup.shouldPlay) {
                const detail = String(error?.message || "Unknown error");
                this.ui?.finishPlaybackPreparation?.(`Unable to start reading: ${detail}`);
            }
            throw error;
        }
        return result;
    }

    async loadEPUB(file = null, options = {}) {
        const setup = await this._promptTranslationSetupBeforeOpen(file, "epub", options);
        if (!setup.proceed) return null;
        await this.ttsEngine.beginDocument();
        const speechLifetime = this.ttsEngine._lifetime;
        if (setup.shouldPlay) {
            this.startBookOpenPlaybackTimer({
                bookName: file?.name || "",
                documentType: "epub",
                storageKey: options?.existingKey || null,
            });
        }

        this.releasePdfHeaderFooterDetector();

        if (file !== null) {
            const overlay = document.getElementById("no-pdf-overlay");
            if (overlay) overlay.style.display = "none";
        }
        let result;
        try {
            result = await this.epubLoader.loadEPUB(file, options);
        } catch (error) {
            if (speechLifetime === this.ttsEngine._lifetime) await this.ttsEngine.deactivate();
            throw error;
        }
        if (speechLifetime !== this.ttsEngine._lifetime) return null;
        this.ui?.setBookLoadingPageReady?.();
        this._setReaderScrollbarsHidden(this.state.currentDocumentType === "epub" && !!this.state.epub);
        if (setup.setup?.docKey) {
            await this._persistTranslationSettingsForDocument(setup.setup.docKey, "epub", setup.setup);
        }
        await this._ensureVoiceForTranslationSetup(setup.setup);
        this.serverSync?.startAutoSync();
        if (setup.shouldPlay) await this._startPlaybackAfterDocumentLoad();
        return result;
    }

    nextSentence(manual = true) {
        const { state } = this;
        if (state.currentSentenceIndex < state.sentences.length - 1) {
            this.audioManager.stopPlayback(true);
            if (manual) state.autoAdvanceActive = false;
            this.getActiveRenderer().renderSentence(state.currentSentenceIndex + 1);
        }
    }

    prevSentence(manual = true) {
        const { state } = this;
        if (state.currentSentenceIndex > 0) {
            this.audioManager.stopPlayback(true);
            if (manual) state.autoAdvanceActive = false;
            this.getActiveRenderer().renderSentence(state.currentSentenceIndex - 1);
        }
    }

    nextPageNav() {
        const { state } = this;
        const currentPage = state.currentSentence?.pageNumber || 1;
        const totalPages = this._getTotalPageCount();
        if (!totalPages) return;
        const target = Math.min(totalPages, currentPage + 1);
        const firstIdx = state.sentences.findIndex((s) => s.pageNumber === target);
        if (firstIdx >= 0) this.getActiveRenderer().renderSentence(firstIdx);
    }

    prevPageNav() {
        const { state } = this;
        const currentPage = state.currentSentence?.pageNumber || 1;
        const totalPages = this._getTotalPageCount();
        if (!totalPages) return;
        const target = Math.max(1, Math.min(totalPages, currentPage - 1));
        const firstIdx = state.sentences.findIndex((s) => s.pageNumber === target);
        if (firstIdx >= 0) this.getActiveRenderer().renderSentence(firstIdx);
    }

    togglePlay() {
        this.audioManager.togglePlay();
    }

    toggleViewMode() {
        return this.viewManager.toggleViewMode();
    }

    listSavedProgress() {
        return this.progressManager.listSavedProgress();
    }

    clearPdfProgress(key) {
        return this.progressManager.clearPdfProgress(key);
    }

    listSavedHighlights() {
        return this.highlightsStorage.listSavedHighlights();
    }

    clearPdfHighlights(key) {
        return this.highlightsStorage.clearPdfHighlights(key);
    }

    exportPdfWithHighlights() {
        return this.exportManager.exportPdfWithHighlights();
    }

    saveCurrentSentenceHighlight(color) {
        return this.highlightManager.saveCurrentSentenceHighlight(color);
    }
    async login() {
        this.auth.login();
    }
    async logout() {
        this.auth.logout();
    }
    async subscribe() {
        this.auth.subscribe();
    }

    /**
     * Close the currently open document (PDF or EPUB).
     * Stops playback, resets renderers/loaders where possible and clears state
     * so the app can show the saved PDFs view cleanly.
     */
    async closeCurrentDocument() {
        const { state } = this;
        state.generationEnabled = false;
        this.ttsQueue?.reset();
        // Invalidate synthesis immediately, before persistence or fades await.
        const speechCleanup = this.ttsEngine.deactivate();
        this._setReaderScrollbarsHidden(false);

        try {
            await this.rewards?.closeDocument?.();
        } catch (err) {
            console.warn("closeCurrentDocument: reward checkpoint failed", err);
        }

        try {
            // Stop server sync
            this.serverSync?.stopAutoSync();
        } catch (err) {
            console.debug("closeCurrentDocument: server sync stop failed", err);
        }

        try {
            // Stop audio playback (best-effort)
            if (this.audioManager && typeof this.audioManager.stopPlayback === "function") {
                // pass true to fade out and clear playback
                await this.audioManager.stopPlayback(true).catch(() => {});
            }
        } catch (err) {
            console.debug("closeCurrentDocument: audio stop failed", err);
        }

        try {
            // Reset TTS queue
            this.ttsQueue?.reset?.();
            await speechCleanup;
        } catch (err) {
            console.debug("closeCurrentDocument: ttsQueue.reset failed", err);
        }

        try {
            this.releasePdfHeaderFooterDetector();
        } catch (err) {
            console.debug("closeCurrentDocument: layout detector release failed", err);
        }

        try {
            // Clear caches
            this.cache?.clearAll?.();
        } catch (err) {
            console.debug("closeCurrentDocument: cache.clearAll failed", err);
        }

        try {
            // Hide/clear PDF and EPUB containers
            const pdfDocContainer = document.getElementById("pdf-doc-container");
            const viewerWrapper = document.getElementById("viewer-wrapper");
            const pdfCanvas = document.getElementById("pdf-canvas");
            if (pdfDocContainer) {
                pdfDocContainer.style.display = "none";
                // remove heavy DOM to free memory
                try {
                    pdfDocContainer.innerHTML = "";
                } catch (e) {
                    /* ignore */
                }
            }
            if (viewerWrapper) viewerWrapper.style.display = "none";
            if (pdfCanvas) pdfCanvas.style.display = "none";
        } catch (err) {
            console.debug("closeCurrentDocument: hide containers failed", err);
        }

        try {
            // EPUB cleanup
            if (this.epubLoader && typeof this.epubLoader.reset === "function") {
                try {
                    this.epubLoader.reset();
                } catch (e) {
                    console.debug("closeCurrentDocument: epubLoader.reset failed", e);
                }
            }
        } catch (err) {
            console.debug("closeCurrentDocument: epub reset failed", err);
        }

        try {
            // PDF cleanup: clear renderer highlights and free caches
            if (this._pdfRenderer && typeof this._pdfRenderer.clearFullDocHighlights === "function") {
                try {
                    this._pdfRenderer.clearFullDocHighlights();
                } catch (e) {
                    console.debug("closeCurrentDocument: pdfRenderer.clearFullDocHighlights failed", e);
                }
            }
        } catch (err) {
            console.debug("closeCurrentDocument: pdf cleanup failed", err);
        }

        try {
            // Terminate the PDF.js worker and release decoded fonts/operator lists.
            await state?.pdf?.destroy?.();
        } catch (err) {
            console.debug("closeCurrentDocument: PDF.js destroy failed", err);
        }

        // Reset shared state fields
        if (state) {
            try {
                state.pdf = null;
                state.epub = null;
                state.pagesCache?.clear?.();
                state.viewportDisplayByPage?.clear?.();
                state.fullPageRenderCache?.clear?.();
                state.pageSentencesIndex?.clear?.();
                state.prefetchedPages?.clear?.();
                state.sentences = [];
                state.currentSentenceIndex = -1;
                state.hoveredSentenceIndex = -1;
                state.playingSentenceIndex = -1;
                state.currentDocumentType = null;
                state.currentPdfKey = null;
                state.currentPdfDescriptor = null;
                state.currentEpubKey = null;
                state.currentEpubDescriptor = null;
                state.bookTitle = null;
                state.bookCover = null;
                state.bookCoverDataUrl = null;
                state.layoutFilteringReady = false;
                state.layoutFilteringPromise = null;
                state.initialLayoutWarmupPromise = null;
                state.generationEnabled = false;
            } catch (e) {
                console.debug("closeCurrentDocument: clearing state failed", e);
            }
        }
    }

    _handleViewportHeightChange(height) {
        if (!Number.isFinite(height)) return;
        if (window.__freezeViewportUpdates) return;
        // If we're waiting for user confirmation to change orientation on mobile, don't auto-adjust UI
        if (this.state.awaitingOrientationDecision) return;
        this.state.viewportHeight = height;
        if (this.pdfRenderer && typeof this.pdfRenderer.handleViewportHeightChange === "function") {
            this.pdfRenderer.handleViewportHeightChange(height);
        }
    }

    /**
     * Show saved PDFs - delegated to PDFThumbnailCache
     */
    async showSavedPDFs() {
        this._setReaderScrollbarsHidden(false);
        return this.pdfThumbnailCache.showSavedPDFs();
    }

    _setReaderScrollbarsHidden(hidden) {
        document.documentElement?.classList.toggle("reader-scrollbars-hidden", hidden);
        document.body?.classList.toggle("reader-scrollbars-hidden", hidden);
    }
}

// Single shared app instance
export const app = new PDFTTSApp();
