import { EVENTS } from "../../constants/events.js";
import { compare as compareCFI } from "./../../../thirdparty/foliate-js/epubcfi.js";
import { EPUBRenderer } from "./epubRenderer.js";
import { mergeSegmentsInsideParentheses, splitSegmentsOnSemicolons } from "./sentenceSegmentation.js";
import { ignoresParenthesizedPunctuation, usesSemicolonPhraseBoundaries } from "../phrases/phraseSplitVersions.js";

export class EPUBLoader {
    constructor(app) {
        this.app = app;
        this.renderer = new EPUBRenderer(app, this);

        this._currentObjectURL = null;
        this._sentencesReady = false;
        this._sentencesPromise = null;
        this._sectionSentenceMap = new Map();
        this._localeHint = null;

        this.app.epubRenderer = this.renderer;
    }

    get view() {
        return this.renderer?.view ?? null;
    }

    computeEpubKeyFromDescriptor(descriptor) {
        if (!descriptor) return null;
        if (descriptor.type === "url" && descriptor.name) {
            return `url::${descriptor.name}`;
        }
        if (descriptor.type === "file") {
            const { name = "", size = 0, lastModified = 0 } = descriptor;
            if (!name) return null;
            return `file::${name}::${size}::${lastModified}`;
        }
        if (descriptor.type === "buffer" && Number.isFinite(descriptor.size)) {
            return `buffer::${descriptor.size}`;
        }
        return null;
    }

    async applyCSS(view, url) {
        const response = await fetch(url);
        const css = await response.text();
        view.setStyles(css);
    }

    async loadEPUB(input, options = {}) {
        const { resume = true, existingKey = null } = options ?? {};
        const state = this.app.state;

        try {
            this.app.ui.showInfo("Loading EPUB...");
            this.app.ui.updatePlayButton(state.playerState.LOADING);

            const pdfDocContainer = document.getElementById("pdf-doc-container");
            if (pdfDocContainer) {
                pdfDocContainer.style.display = "none";
            }
            const viewerWrapper = document.getElementById("viewer-wrapper");
            if (viewerWrapper) {
                viewerWrapper.style.display = "none";
            }

            if (this.app.audioManager.stopPlayback) {
                try {
                    await this.app.audioManager.stopPlayback(true);
                } catch (error) {
                    console.debug("[EPUBLoader] Unable to stop playback prior to load", error);
                }
            }
            this.app.ttsQueue.reset();
            if (state) {
                state.audioCache.clear();
                state.currentSource = null;
                state.currentGain = null;
                state.isPlaying = false;
                state.autoAdvanceActive = false;
                state.playingSentenceIndex = -1;
                state.sentences = [];
                state.pageSentencesIndex?.clear?.();
                state.hoveredSentenceIndex = -1;
                state.currentSentenceIndex = -1;
                state.savedHighlights = new Map();
            }

            this.reset();

            const source = this._resolveSource(input);
            const view = await this.renderer.open(source);
            await this.renderer.applyContentCSS("src/css/epub.css");
            document.getElementById("previous-pdf-header")?.classList.add("hidden");

            if (state) {
                state.currentDocumentType = "epub";
                state.pdf = null;
                state.pagesCache.clear();
                state.viewportDisplayByPage.clear();
                state.fullPageRenderCache.clear();
                state.currentPdfKey = null;
                state.currentPdfDescriptor = null;
                state.generationEnabled = false;
                state.layoutFilteringReady = false;
                state.epub = view.book;
                state.epubMetadata = view.book.metadata ?? null;
                state.bookTitle = view.book.metadata.title ?? null;
                state.bookCover = await view.book.getCover();
                state.bookCoverDataUrl = null;
                if (state.bookCover instanceof Blob) {
                    try {
                        state.bookCoverDataUrl = await this.app.progressManager.convertBlobToDataURL(
                            state.bookCover,
                            state.bookCover.type,
                        );
                    } catch (coverError) {
                        console.debug("[EPUBLoader] Unable to convert cover blob to data URL", coverError);
                    }
                } else if (typeof state.bookCover === "string" && state.bookCover.startsWith("data:")) {
                    state.bookCoverDataUrl = state.bookCover;
                }
                state.epubSpine = view.book.spine ?? null;
                state.epubNavigation = view.book.toc ?? null;
                state.chapterCount = Array.isArray(view.book.sections) ? view.book.sections.length : 0;
                state.chapterTitles = Array.isArray(view.book.toc)
                    ? view.book.toc.map((item) => item?.label).filter(Boolean)
                    : [];

                if (input instanceof File) {
                    state.currentEpubDescriptor = {
                        type: "file",
                        name: input.name,
                        size: input.size,
                        lastModified: input.lastModified,
                    };
                } else if (typeof input === "string") {
                    state.currentEpubDescriptor = { type: "url", name: input };
                } else if (input?.data instanceof ArrayBuffer) {
                    state.currentEpubDescriptor = { type: "buffer", size: input.data.byteLength };
                } else if (input instanceof ArrayBuffer) {
                    state.currentEpubDescriptor = { type: "buffer", size: input.byteLength };
                } else {
                    state.currentEpubDescriptor = { type: "unknown" };
                }

                const computedKey = existingKey || this.computeEpubKeyFromDescriptor(state.currentEpubDescriptor);
                state.currentEpubKey = computedKey;
                state.savedHighlights = this.app.highlightsStorage.loadSavedHighlights(computedKey);
                state.phraseSplitVersion = this.app.highlightsStorage.getPhraseSplitVersion(
                    computedKey,
                    state.savedHighlights,
                );
                if (computedKey && !state.bookCoverDataUrl) {
                    const savedProgress = this.app.progressManager.loadSavedPosition(computedKey, "epub");
                    if (typeof savedProgress?.cover === "string") {
                        state.bookCoverDataUrl = savedProgress.cover;
                    }
                }
                if (input instanceof File && computedKey) {
                    try {
                        const stored = await this.app.progressManager.loadEpubFromIndexedDB(computedKey);
                        if (!stored) {
                            await this.app.progressManager.saveEpubToIndexedDB(input, computedKey);
                            this.app.ui.showInfo("EPUB saved on IndexedDB!");
                        }
                    } catch (dbError) {
                        console.debug("[EPUBLoader] Unable to persist EPUB in IndexedDB", dbError);
                    }
                }

                if (computedKey && typeof state.bookCoverDataUrl === "string") {
                    this.app.progressManager
                        .updateEpubCover(computedKey, state.bookCoverDataUrl)
                        .catch((coverStoreError) => {
                            console.debug("[EPUBLoader] Failed to persist EPUB cover", coverStoreError);
                        });
                }
            }

            this.app.eventBus.emit(EVENTS.EPUB_LOADED, {
                metadata: state.epubMetadata ?? null,
                chapters: state.chapterCount ?? 0,
            });

            await this._buildSentences();

            if (state.sentences?.length) {
                let startIndex = Math.max(0, state.currentSentenceIndex ?? 0);
                let resumeVoiceId = null;

                // First, try to load from server if enabled
                if (this.app.serverSync?.isEnabled() && state.currentEpubKey) {
                    try {
                        const serverData = await this.app.serverSync.loadPositionAndHighlightsFromServer(
                            state.currentEpubKey,
                        );

                        // Update position from server if available
                        if (serverData.position !== null && serverData.position >= 0) {
                            startIndex = Math.min(Math.max(serverData.position, 0), state.sentences.length - 1);
                            console.log(`[EPUBLoader] Restored position from server: ${startIndex}`);
                        }

                        // Update voice from server if available
                        if (resume && serverData.voice) {
                            resumeVoiceId = serverData.voice;
                            console.log(`[EPUBLoader] Restored voice from server: ${resumeVoiceId}`);
                        }

                        // Update highlights from server if available
                        if (serverData.highlights && serverData.highlights.size > 0) {
                            const serverSplitVersion = this.app.highlightsStorage.getPhraseSplitVersion(
                                state.currentEpubKey,
                                serverData.highlights,
                            );
                            state.savedHighlights = serverData.highlights;
                            if (serverSplitVersion !== state.phraseSplitVersion) {
                                state.phraseSplitVersion = serverSplitVersion;
                                this._sentencesReady = false;
                                await this._buildSentences();
                                startIndex = Math.min(startIndex, Math.max(0, state.sentences.length - 1));
                            }
                            console.log(`[EPUBLoader] Restored ${serverData.highlights.size} highlights from server`);

                            // Also save to local storage
                            this.app.highlightsStorage.saveHighlights(state.currentEpubKey, serverData.highlights);
                        }
                    } catch (error) {
                        console.warn("[EPUBLoader] Failed to load from server, using local data:", error);
                    }
                }

                // If no server data, load from local storage
                if (startIndex === 0 && resume && state.currentEpubKey) {
                    const saved = this.app.progressManager.loadSavedPosition(state.currentEpubKey, "epub");
                    if (saved) {
                        if (typeof saved.sentenceIndex === "number") {
                            startIndex = Math.min(Math.max(saved.sentenceIndex, 0), state.sentences.length - 1);
                        }
                        if (typeof saved.voice === "string" && saved.voice.trim()) {
                            resumeVoiceId = saved.voice.trim();
                        }
                    }
                }

                if (resume && resumeVoiceId) {
                    await this._applySavedVoice(resumeVoiceId);
                }

                if (state.currentEpubKey && (!state.savedHighlights || state.savedHighlights.size === 0)) {
                    state.savedHighlights = this.app.highlightsStorage.loadSavedHighlights(state.currentEpubKey);
                }
                if (state.savedHighlights?.size) {
                    const lastSaved = Array.from(state.savedHighlights.values()).pop();
                    if (lastSaved?.color) state.selectedHighlightColor = lastSaved.color;
                }

                await this.renderer.renderSentence(startIndex, { suppressScroll: true });
                await this.renderer.updateHighlightDisplay();
            } else {
                this.app.ui.showInfo("No readable text detected in EPUB.");
            }

            this.renderer.setupInteractionListeners();
            this.app.interactionHandler.setupInteractionListeners();
            this.app.controlsManager.reflectSelectedHighlightColor();

            this.app.ui.updatePlayButton(state.playerState.DONE);
            this.app.ui.showInfo("EPUB loaded successfully.");
        } catch (error) {
            console.error("EPUB load error", error);
            this.app.ui.showInfo(`Error loading EPUB: ${error.message}`);
            this.reset();
            throw error;
        } finally {
            this.app.ui.updatePlayButton(state.playerState.DONE);
        }
    }

    async _applySavedVoice(voiceId) {
        if (typeof voiceId !== "string") return;
        const trimmedVoiceId = voiceId.trim();
        if (!trimmedVoiceId) return;

        const { app } = this;
        const voiceSelect = document.getElementById("voice-select");
        const options = voiceSelect ? Array.from(voiceSelect.options || []) : [];
        const voiceAvailable =
            options.some((opt) => opt.value === trimmedVoiceId) || app.config.PIPER_VOICES.includes(trimmedVoiceId);

        if (!voiceAvailable) {
            console.warn(`Saved voice ${trimmedVoiceId} not available, skipping restore.`);
            return;
        }

        if (voiceSelect && options.some((opt) => opt.value === trimmedVoiceId)) {
            voiceSelect.value = trimmedVoiceId;
        }

        // Keep the worker's actual voice identity intact until ensurePiper performs
        // the model change.
        app.ttsEngine.preferredVoiceId = trimmedVoiceId;
    }

    reset() {
        this.renderer.reset();
        this._releaseObjectURL();
        this._sentencesReady = false;
        this._sentencesPromise = null;
        this._sectionSentenceMap.clear();
        this._localeHint = null;
    }

    destroy() {
        this.renderer.destroy();
        this._releaseObjectURL();
        this._sentencesReady = false;
        this._sentencesPromise = null;
        this._sectionSentenceMap.clear();
        this._localeHint = null;
    }

    renderSentence(idx, options = {}) {
        return this.renderer.renderSentence(idx, options);
    }

    renderHoverHighlightFullDoc() {
        return this.renderer.renderHoverHighlightFullDoc();
    }

    updateHighlightFullDoc(sentence) {
        return this.renderer.updateHighlightFullDoc(sentence);
    }

    setupInteractionListeners() {
        return this.renderer.setupInteractionListeners();
    }

    async ensureLayoutFilteringReady() {
        await this._buildSentences();
        if (this.app?.state) {
            this.app.state.layoutFilteringReady = true;
        }
    }

    handleViewportHeightChange() {
        this.renderer.handleViewportHeightChange();
    }

    findSentenceIndexInSection(sectionIndex, cfi) {
        return this._findSentenceIndexInSection(sectionIndex, cfi);
    }

    async _buildSentences() {
        if (this._sentencesReady && this.app?.state?.sentences?.length) return;
        if (this._sentencesPromise) return this._sentencesPromise;
        this._sentencesPromise = this._doBuildSentences()
            .catch((error) => {
                console.error("[EPUBLoader] Failed to build sentences", error);
            })
            .finally(() => {
                this._sentencesPromise = null;
            });
        await this._sentencesPromise;
    }

    async _doBuildSentences() {
        if (!this.view?.book || !this.app?.state) {
            this._sentencesReady = false;
            return;
        }

        const { state } = this.app;
        const book = this.view.book;
        const cooperativeYield = this.app?.helpers?.cooperativeYield;
        const locale = this._resolveLocaleHint(book);

        const sentences = [];
        this._sectionSentenceMap.clear();
        state.pageSentencesIndex?.clear?.();

        let globalIndex = 0;
        const sections = Array.isArray(book.sections) ? book.sections : [];
        for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
            const section = sections[sectionIndex];
            if (!section?.createDocument) continue;

            let doc = null;
            try {
                doc = await section.createDocument();
            } catch (error) {
                console.warn("[EPUBLoader] Unable to load section", sectionIndex, error);
                continue;
            }

            const extracted = this._extractSentencesFromDocument(doc, sectionIndex, locale);
            if (extracted.length) {
                if (!this._sectionSentenceMap.has(sectionIndex)) {
                    this._sectionSentenceMap.set(sectionIndex, []);
                }
                const pageNumber = sectionIndex + 1;
                if (!state.pageSentencesIndex.has(pageNumber)) {
                    state.pageSentencesIndex.set(pageNumber, []);
                }

                for (const sentence of extracted) {
                    sentence.index = globalIndex++;
                    sentences.push(sentence);
                    this._sectionSentenceMap.get(sectionIndex).push(sentence.index);
                    state.pageSentencesIndex.get(pageNumber).push(sentence.index);
                }
            }

            section.unload();
            if (typeof cooperativeYield === "function") {
                try {
                    await cooperativeYield();
                } catch (error) {
                    console.debug("[EPUBLoader] cooperativeYield failed", error);
                }
            }
        }

        state.sentences = sentences;
        state.currentSentenceIndex = sentences.length ? 0 : -1;
        state.hoveredSentenceIndex = -1;
        this._sentencesReady = sentences.length > 0;

        this.app.eventBus.emit(EVENTS.SENTENCES_PARSED, sentences);
    }

    _extractSentencesFromDocument(doc, sectionIndex, locale) {
        const entries = [];
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
        let cursor = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const value = node.nodeValue ?? "";
            if (!value.length) continue;
            const start = cursor;
            cursor += value.length;
            entries.push({ node, start, end: cursor });
        }

        if (!entries.length) return [];

        const fullText = entries.map((entry) => entry.node.nodeValue).join("");
        if (!fullText.trim()) return [];

        const segmenter = this._getSentenceSegmenter(locale);
        const ignoreParenthesizedPunctuation = ignoresParenthesizedPunctuation(this.app.state.phraseSplitVersion);
        const originalSegments = segmenter ? segmenter(fullText) : this._fallbackSegment(fullText);
        const sentenceSegments = ignoreParenthesizedPunctuation
            ? mergeSegmentsInsideParentheses(fullText, originalSegments)
            : originalSegments;
        const segments = usesSemicolonPhraseBoundaries(this.app.state.phraseSplitVersion)
            ? splitSegmentsOnSemicolons(fullText, sentenceSegments, { ignoreParenthesizedPunctuation })
            : sentenceSegments;
        if (!segments.length) return [];

        const sentences = [];
        for (const { text, start, end } of segments) {
            const range = this._createRangeFromOffsets(doc, entries, start, end);
            if (!range) continue;

            let cfi = null;
            try {
                cfi = this.view.getCFI(sectionIndex, range);
            } catch (error) {
                console.warn("[EPUBLoader] Failed to obtain CFI for sentence", error);
                continue;
            }

            const sentence = this._createSentenceObject({ text, sectionIndex, cfi });
            sentences.push(sentence);
        }
        return sentences;
    }

    _getSentenceSegmenter(locale) {
        if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return null;
        try {
            const segmenter = new Intl.Segmenter(locale || "en", { granularity: "sentence" });
            return (text) => {
                const segments = [];
                for (const { segment, index } of segmenter.segment(text)) {
                    const leading = segment.match(/^\s*/)?.[0]?.length ?? 0;
                    const trailing = segment.match(/\s*$/)?.[0]?.length ?? 0;
                    const trimmed = segment.replace(/\s+/g, " ").trim();
                    if (!trimmed) continue;
                    const start = index + leading;
                    const end = index + segment.length - trailing;
                    if (end <= start) continue;
                    segments.push({ text: trimmed, start, end });
                }
                return segments;
            };
        } catch (error) {
            console.warn("[EPUBLoader] Intl.Segmenter unavailable", error);
            return null;
        }
    }

    _fallbackSegment(text) {
        const segments = [];
        const regex = /[^.!?]+[.!?]*\s*/g;
        let match;
        while ((match = regex.exec(text))) {
            const chunk = match[0];
            const trimmed = chunk.replace(/\s+/g, " ").trim();
            if (!trimmed) continue;
            const leading = chunk.match(/^\s*/)?.[0]?.length ?? 0;
            const trailing = chunk.match(/\s*$/)?.[0]?.length ?? 0;
            const start = match.index + leading;
            let end = match.index + chunk.length - trailing;
            if (end <= start) continue;
            segments.push({ text: trimmed, start, end });
        }

        if (!segments.length) {
            const fallback = text.replace(/\s+/g, " ").trim();
            if (fallback) segments.push({ text: fallback, start: 0, end: text.length });
        }
        return segments;
    }

    _createRangeFromOffsets(doc, entries, start, end) {
        const startPos = this._locateDomPosition(entries, start);
        const endPos = this._locateDomPosition(entries, end);
        if (!startPos || !endPos) return null;
        const range = doc.createRange();
        range.setStart(startPos.node, startPos.offset);
        range.setEnd(endPos.node, endPos.offset);
        return range;
    }

    _locateDomPosition(entries, offset) {
        if (!entries.length) return null;
        if (offset <= 0) {
            const first = entries[0];
            const maxOffset = Math.max(0, Math.min(first.node.nodeValue?.length ?? 0, offset));
            return { node: first.node, offset: maxOffset };
        }

        for (const entry of entries) {
            if (offset < entry.end) {
                const nodeLength = entry.node.nodeValue?.length ?? 0;
                const relative = Math.min(nodeLength, Math.max(0, offset - entry.start));
                return { node: entry.node, offset: relative };
            }
        }

        const last = entries[entries.length - 1];
        const lastLength = last.node.nodeValue?.length ?? 0;
        return { node: last.node, offset: Math.min(lastLength, Math.max(0, offset - last.start)) };
    }

    _createSentenceObject({ text, sectionIndex, cfi }) {
        return {
            index: -1,
            sectionIndex,
            pageNumber: sectionIndex + 1,
            chapterIndex: sectionIndex,
            cfi,
            text,
            originalText: text,
            readableText: text,
            words: [],
            originalWords: [],
            readableWords: [],
            bbox: null,
            audioBlob: null,
            wavBlob: null,
            audioBuffer: null,
            audioReady: false,
            audioInProgress: false,
            audioError: null,
            lastVoice: null,
            lastSpeed: null,
            prefetchQueued: false,
            normalizedText: null,
            wordBoundaries: [],
            ttsPhraseTimings: [],
            playbackWordTimers: [],
            layoutProcessed: true,
            isTextToRead: true,
            layoutProcessingPromise: null,
        };
    }

    _resolveLocaleHint(book) {
        if (this._localeHint) return this._localeHint;
        const metaLang = book?.metadata?.language;
        if (Array.isArray(metaLang) && metaLang.length && typeof metaLang[0] === "string") {
            this._localeHint = metaLang[0];
        } else if (typeof metaLang === "string" && metaLang.trim()) {
            this._localeHint = metaLang;
        } else {
            this._localeHint = document.documentElement.lang || navigator.language || "en";
        }
        return this._localeHint;
    }

    _resolveSource(input) {
        if (!input) {
            throw new Error("No EPUB source provided.");
        }
        if (input instanceof File) {
            this._currentObjectURL = URL.createObjectURL(input);
            return this._currentObjectURL;
        }
        if (input instanceof ArrayBuffer) {
            const blob = new Blob([input], { type: "application/epub+zip" });
            this._currentObjectURL = URL.createObjectURL(blob);
            return this._currentObjectURL;
        }
        if (typeof input === "string") {
            this._currentObjectURL = null;
            return input;
        }
        if (input?.data instanceof ArrayBuffer) {
            const blob = new Blob([input.data], { type: "application/epub+zip" });
            this._currentObjectURL = URL.createObjectURL(blob);
            return this._currentObjectURL;
        }
        throw new Error("Unsupported EPUB source type.");
    }

    _releaseObjectURL() {
        if (this._currentObjectURL) {
            URL.revokeObjectURL(this._currentObjectURL);
            this._currentObjectURL = null;
        }
    }

    _findSentenceIndexInSection(sectionIndex, cfi) {
        const indices = this._sectionSentenceMap.get(sectionIndex);
        if (!indices || !indices.length) return -1;
        let candidate = -1;
        for (const idx of indices) {
            const sentence = this.app?.state?.sentences?.[idx];
            if (!sentence?.cfi) continue;
            try {
                const cmp = compareCFI(cfi, sentence.cfi);
                if (cmp === 0) {
                    return idx;
                }
                if (cmp > 0) {
                    candidate = idx;
                    continue;
                }
                if (candidate >= 0) return candidate;
                return idx;
            } catch (error) {
                console.debug("[EPUBLoader] compareCFI failed", error);
            }
        }
        if (candidate >= 0) return candidate;
        return indices[0];
    }
}
