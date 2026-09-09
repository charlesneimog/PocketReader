import { hitTestSentence } from "../utils/coordinates.js";
import { getInferenceConcurrencyProfile } from "../utils/helpers.js";
import { INFERENCE_BACKENDS, normalizeInferenceBackend } from "../../config.js";

export class PDFHeaderFooterDetector {
    /**
     * Main-thread owner of the layout worker and page-level layout policy.
     *
     * The worker returns raw detections. This class serializes page inference,
     * caches results in StateManager, converts detections into readable/ignored
     * regions, and asks SentenceParser/PDFRenderer to consume that classification.
     * It is created lazily by PDFTTSApp so opening an EPUB never loads the model.
     */
    constructor(app) {
        this.app = app;
        this._overlayStylesInjected = false;
        this._pageContainers = new Map();
        this._pendingOverlayData = new Map();
        this.debug = false;

        this._pendingWorkerRequests = new Map();
        this._pendingDetectionsByPage = new Map();
        this._detectionQueue = Promise.resolve();
        this._requestIdCounter = 0;
        this.app.ui.showInfo("Loading Layout AI model...");
        this.worker = new Worker("./src/modules/pdf/ts.js", { type: "module" });
        this.app.ui.showInfo("AI Layout model loaded...");

        const threads = getInferenceConcurrencyProfile(this.app.config).layoutThreads;
        const requestedBackend = normalizeInferenceBackend(
            this.app.config.LAYOUT_DETECTION_BACKEND,
            INFERENCE_BACKENDS.WASM,
        );
        this.workerReadyPromise = new Promise((resolve, reject) => {
            this._resolveWorkerReady = resolve;
            this._rejectWorkerReady = reject;
        });

        this.worker.onmessage = (event) => {
            const { status, requestId } = event.data || {};
            if (status === "ready") {
                const backend = event.data.backend || "unknown";
                if (backend === "webgpu") {
                    console.info("[Layout] Model ready; backend=webgpu");
                } else {
                    console.warn(
                        `[Layout] Model ready; backend=${backend}; requested=${event.data.requestedBackend || requestedBackend}; threads=${event.data.threads || 1}/${event.data.requestedThreads || threads}`,
                        event.data.fallbackReason || "",
                    );
                }
                if (typeof this._resolveWorkerReady === "function") this._resolveWorkerReady();
                return;
            }
            if (status === "detections") {
                const pending = this._pendingWorkerRequests.get(requestId);
                if (!pending) return;
                this._pendingWorkerRequests.delete(requestId);
                pending.resolve(event.data);
                return;
            }
            if (status === "error") {
                const pending = this._pendingWorkerRequests.get(requestId);
                if (pending) {
                    this._pendingWorkerRequests.delete(requestId);
                    const error = event.data.error || new Error("Worker detection error");
                    if (error.name === "AbortError") {
                        console.warn("Worker operation was aborted (likely canceled or terminated early)");
                    } else {
                        console.error("Layout worker error", error);
                        this.app.ui.showFatalError("Layout worker exit with fatal error, please report!");
                    }
                    pending.reject(error);
                } else if (typeof this._rejectWorkerReady === "function") {
                    this._rejectWorkerReady(event.data.error || new Error("Layout worker initialization failed"));
                }
            }
        };

        this.worker.onerror = (e) => {
            console.error("Layout worker crashed", e);
            if (typeof this._rejectWorkerReady === "function") this._rejectWorkerReady(e);
            this._pendingWorkerRequests.forEach((pending) => pending.reject(e));
            this._pendingWorkerRequests.clear();
        };

        console.info(
            `[Layout] Initializing model; requestedBackend=${requestedBackend}; wasmFallbackThreads=${threads}`,
        );
        this.worker?.postMessage({ action: "init", threads, backend: requestedBackend });

        // Detection configuration
        this.DETECTION_THRESHOLD = 0.35;
        this.TEXT_CONFIDENCE_THRESHOLD = 0.89;
        this.DETECTION_CLASSES = [
            "caption",
            "footnote",
            "formula",
            "list-item",
            "page-footer",
            "page-header",
            "picture",
            "section-header",
            "table",
            "text",
        ];

        // Only these regions contain text that should be read
        this.ITEMS_TO_READ = ["list-item", "section-header", "text"];
        this._modelReady = this.workerReadyPromise;
    }

    _normalizeDetectionLabels(detections) {
        if (!Array.isArray(detections)) return [];
        return detections.map((det) => {
            if (!det) return det;
            const label = String(det.label || "").toLowerCase();
            const score = Number(det.score);
            if (
                label === "text" &&
                !det.manualLabel &&
                Number.isFinite(score) &&
                score < this.TEXT_CONFIDENCE_THRESHOLD
            ) {
                return {
                    ...det,
                    originalLabel: det.originalLabel || det.label,
                    label: "not-sure-text",
                };
            }
            return det;
        });
    }

    dispose() {
        try {
            this.worker?.terminate?.();
        } catch (error) {
            console.debug("[Layout] Failed to terminate worker", error);
        }
        this._pendingWorkerRequests.forEach((pending) => {
            pending.reject(new Error("Layout detector disposed"));
        });
        this._pendingWorkerRequests.clear();
        this._pendingDetectionsByPage.clear();
        this.worker = null;
        this._modelReady = null;
        this.workerReadyPromise = null;
        this._resolveWorkerReady = null;
        this._rejectWorkerReady = null;
    }

    _initModels() {
        return this.workerReadyPromise;
    }

    _ensureModelReady() {
        if (!this._modelReady) {
            this._modelReady = this._initModels();
        }
        return this._modelReady;
    }

    prepare() {
        return this._ensureModelReady();
    }

    _drawDetectedLayoutOverlay(pageNumber, detections, baseCanvas) {
        const { state } = this.app;
        const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
        const container = document.querySelector(`[data-page-number="${pageNumber}"]`);
        if (!container || !viewportDisplay) return;

        container.querySelector(".layout-debug-overlay")?.remove();

        const overlay = document.createElement("canvas");
        overlay.width = viewportDisplay.width;
        overlay.height = viewportDisplay.height;
        overlay.style.position = "absolute";
        overlay.style.top = "0";
        overlay.style.left = "0";
        overlay.style.pointerEvents = "none";
        overlay.style.zIndex = "5";
        overlay.className = "layout-debug-overlay";

        const ctx = overlay.getContext("2d");
        ctx.lineWidth = 1.5;
        ctx.font = "11px sans-serif";
        ctx.textBaseline = "top";

        const canvasWidth = baseCanvas?.width || viewportDisplay.width;
        const canvasHeight = baseCanvas?.height || viewportDisplay.height;
        const scaleX = viewportDisplay.width / canvasWidth;
        const scaleY = viewportDisplay.height / canvasHeight;
        for (const det of detections || []) {
            let x, y, w, h;
            if (det.normalized) {
                x = det.normalized.left * viewportDisplay.width;
                y = det.normalized.top * viewportDisplay.height;
                w = (det.normalized.right - det.normalized.left) * viewportDisplay.width;
                h = (det.normalized.bottom - det.normalized.top) * viewportDisplay.height;
            } else {
                x = det.x1 * scaleX;
                y = det.y1 * scaleY;
                w = (det.width || det.x2 - det.x1) * scaleX;
                h = (det.height || det.y2 - det.y1) * scaleY;
            }
            if (w <= 0 || h <= 0) continue;
            ctx.strokeStyle = "rgba(255, 0, 0, 0.9)";
            ctx.fillStyle = "rgba(255, 0, 0, 0.9)";
            ctx.strokeRect(x, y, w, h);
            const label = det.score ? `${det.label} ${(det.score * 100).toFixed(0)}%` : det.label;
            const textWidth = ctx.measureText(label).width + 6;
            const labelHeight = 14;
            ctx.fillRect(x, Math.max(0, y - labelHeight), textWidth, labelHeight);
            ctx.fillStyle = "white";
            ctx.fillText(label, x + 3, Math.max(0, y - labelHeight + 2));
        }
        container.appendChild(overlay);
    }

    _drawIgnoredDetectionsOverlay(pageNumber, detections, baseCanvas) {
        const { state } = this.app;
        const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
        let container = document.querySelector(`[data-page-number="${pageNumber}"]`);
        if (!container) {
            console.error("No container found for page", pageNumber);
            return;
        }
        const existingOverlay = container.querySelector(".ignored-overlay");
        if (existingOverlay) {
            existingOverlay.remove();
        }
        const overlay = document.createElement("canvas");
        overlay.width = viewportDisplay.width;
        overlay.height = viewportDisplay.height;
        overlay.style.position = "absolute";
        overlay.style.top = "0";
        overlay.style.left = "0";
        overlay.style.pointerEvents = "none";
        overlay.style.zIndex = "4";
        overlay.className = "ignored-overlay";

        const ctx = overlay.getContext("2d");
        ctx.fillStyle = "rgba(200, 200, 200, 0.2)";

        const canvasWidth = baseCanvas?.width || viewportDisplay.width;
        const canvasHeight = baseCanvas?.height || viewportDisplay.height;
        const scaleX = viewportDisplay.width / canvasWidth;
        const scaleY = viewportDisplay.height / canvasHeight;

        let drawnCount = 0;
        for (const det of detections) {
            if (!this.ITEMS_TO_READ.includes(det.label)) {
                let x1, y1, width, height;

                if (det.normalized) {
                    x1 = det.normalized.left * viewportDisplay.width;
                    y1 = det.normalized.top * viewportDisplay.height;
                    width = (det.normalized.right - det.normalized.left) * viewportDisplay.width;
                    height = (det.normalized.bottom - det.normalized.top) * viewportDisplay.height;
                } else {
                    x1 = det.x1 * scaleX;
                    y1 = det.y1 * scaleY;
                    width = (det.width || det.x2 - det.x1) * scaleX;
                    height = (det.height || det.y2 - det.y1) * scaleY;
                }

                if (width > 0 && height > 0 && x1 < overlay.width && y1 < overlay.height) {
                    ctx.fillRect(x1, y1, width, height);
                    drawnCount++;
                }
            }
        }

        if (drawnCount > 0) {
            container.appendChild(overlay);
        }
    }

    // ---------- Main Detection ----------
    detectHeadersAndFooters(pageNumber, scaleFactor = 1) {
        const { state } = this.app;
        const cached = state.layoutDetectionCache.get(pageNumber);
        if (cached && cached.cacheVersion === state.layoutCacheVersion && Array.isArray(cached.detections)) {
            const hasNewLowConfidenceText = cached.detections.some((det) => {
                const label = String(det?.label || "").toLowerCase();
                const score = Number(det?.score);
                return label === "text" && Number.isFinite(score) && score < this.TEXT_CONFIDENCE_THRESHOLD;
            });
            cached.detections = this._normalizeDetectionLabels(cached.detections);
            if (hasNewLowConfidenceText) {
                cached.readabilityVersion = null;
                cached.readableWordCount = null;
            }
            const canvas = state.fullPageRenderCache.get(pageNumber) || null;
            this._drawIgnoredDetectionsOverlay(pageNumber, cached.detections, canvas);
            this._drawNotSureTextControls(pageNumber, cached.detections, canvas);
            return Promise.resolve(cached.detections);
        }

        if (this._pendingDetectionsByPage.has(pageNumber)) {
            return this._pendingDetectionsByPage.get(pageNumber);
        }

        const ttsQueue = this.app.ttsQueue;
        const queueIdle = !ttsQueue || (ttsQueue.active === 0 && ttsQueue.queue.length === 0);
        const shouldShowSpinner = !state.isPlaying && queueIdle;
        if (shouldShowSpinner) {
            this.app.ui.updatePlayButton(state.playerState.LOADING);
        }

        // Inference is serialized intentionally. Multiple full-resolution page
        // tensors can exhaust browser GPU memory, while text extraction and TTS
        // remain independently concurrent.
        const detectionPromise = this._detectionQueue
            .catch(() => {})
            .then(() => this._ensureModelReady())
            .then(() => this._performDetection(pageNumber, scaleFactor))
            .then((detections) => {
                this._pendingDetectionsByPage.delete(pageNumber);
                return detections;
            })
            .catch((error) => {
                this._pendingDetectionsByPage.delete(pageNumber);
                console.error(`[Layout] Detection failed for page ${pageNumber}`, error);
                throw error;
            });
        this._detectionQueue = detectionPromise.catch(() => {});

        const wrappedPromise = shouldShowSpinner
            ? detectionPromise.finally(() => {
                  const queueStillIdle = !ttsQueue || (ttsQueue.active === 0 && ttsQueue.queue.length === 0);
                  if (!state.isPlaying && queueStillIdle) {
                      this.app.ui.updatePlayButton(state.playerState.DONE);
                  }
              })
            : detectionPromise;

        this._pendingDetectionsByPage.set(pageNumber, wrappedPromise);
        return wrappedPromise;
    }

    _performDetection(pageNumber, scaleFactor) {
        const { state } = this.app;
        const ensureCanvas = state.fullPageRenderCache.has(pageNumber)
            ? Promise.resolve(state.fullPageRenderCache.get(pageNumber))
            : this.app.pdfRenderer
                  .ensureFullPageRendered(pageNumber)
                  .then(() => state.fullPageRenderCache.get(pageNumber));

        return ensureCanvas.then((canvas) => {
            if (!canvas) {
                throw new Error(`[Layout] No canvas available for page ${pageNumber} after render attempt.`);
            }

            const scaledWidth = Math.max(1, Math.floor(canvas.width * scaleFactor));
            const scaledHeight = Math.max(1, Math.floor(canvas.height * scaleFactor));
            const needsScaledCopy = scaledWidth !== canvas.width || scaledHeight !== canvas.height;
            const imageCanvas = needsScaledCopy ? document.createElement("canvas") : canvas;
            if (needsScaledCopy) {
                imageCanvas.width = scaledWidth;
                imageCanvas.height = scaledHeight;
            }
            const imageCtx = imageCanvas.getContext("2d");
            if (!imageCtx) {
                throw new Error(`[Layout] Failed to acquire temp canvas context for page ${pageNumber}`);
            }
            if (needsScaledCopy) imageCtx.drawImage(canvas, 0, 0, scaledWidth, scaledHeight);

            let imageData;
            try {
                imageData = imageCtx.getImageData(0, 0, scaledWidth, scaledHeight);
            } catch (error) {
                throw new Error(`[Layout] Could not extract image data for page ${pageNumber}`, { cause: error });
            } finally {
                if (needsScaledCopy) {
                    imageCanvas.width = 0;
                    imageCanvas.height = 0;
                }
            }

            const totalPages = Number(state.pdf?.numPages) || "?";
            const detectionStartedAt = performance.now();
            console.info(`[Layout] Detecting page ${pageNumber}/${totalPages}`);

            return this._sendWorkerDetection({
                pageNumber,
                imageData,
                originalWidth: canvas.width,
                originalHeight: canvas.height,
                scaledWidth,
                scaledHeight,
                detectionThreshold: this.DETECTION_THRESHOLD,
                detectionClasses: this.DETECTION_CLASSES,
            }).then((payload) => {
                if (!Array.isArray(payload?.detections)) {
                    throw new Error(`[Layout] Invalid detection response for page ${pageNumber}.`);
                }
                const detections = this._normalizeDetectionLabels(
                    payload.detections.map((det) => ({ ...det, pageNumber })),
                );

                const cacheEntry = {
                    pageNumber,
                    detections,
                    timestamp: Date.now(),
                    cacheVersion: state.layoutCacheVersion,
                    modelVersion: payload?.modelVersion || "Oblix/yolov10m-doclaynet_ONNX_document-layout-analysis",
                    readabilityVersion: null,
                    readableWordCount: null,
                };

                state.layoutDetectionCache.set(pageNumber, cacheEntry);
                this._drawIgnoredDetectionsOverlay(pageNumber, detections, canvas);
                this._drawNotSureTextControls(pageNumber, detections, canvas);

                if (this.debug) {
                    this._drawDetectedLayoutOverlay(pageNumber, detections, canvas);
                }

                const elapsedMs = Math.round(performance.now() - detectionStartedAt);
                console.info(
                    `[Layout] Detecting page ${pageNumber}/${totalPages} done (${elapsedMs} ms, ${detections.length} detections)`,
                );
                return detections;
            });
        });
    }

    registerPageDomElement(pageObj, pageContainer) {
        return;
    }

    _shouldMergeReadableBoxes(a, b) {
        if (!a || !b) return false;
        const textLike = new Set(["text", "list-item", "section-header"]);
        if (!textLike.has(a.label) || !textLike.has(b.label)) return false;
        if (a.label !== b.label) return false;

        const widthA = Math.max(1, a.x2 - a.x1);
        const widthB = Math.max(1, b.x2 - b.x1);
        const heightA = Math.max(1, a.y2 - a.y1);
        const heightB = Math.max(1, b.y2 - b.y1);
        const avgHeight = (heightA + heightB) / 2;

        const horizontalOverlap = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
        const horizontalOverlapRatio = horizontalOverlap / Math.min(widthA, widthB);
        const centersClose = Math.abs((a.x1 + a.x2) / 2 - (b.x1 + b.x2) / 2) <= Math.max(widthA, widthB) * 0.35;
        const sameColumn = horizontalOverlapRatio >= 0.35 || centersClose;
        if (!sameColumn) return false;

        const verticalGap = Math.max(0, Math.max(a.y1, b.y1) - Math.min(a.y2, b.y2));
        return verticalGap <= avgHeight * 0.9;
    }

    _hasInterveningReadableBox(a, b, boxes) {
        if (!a || !b || !Array.isArray(boxes)) return false;

        const centerYA = (a.y1 + a.y2) / 2;
        const centerYB = (b.y1 + b.y2) / 2;
        const minCenterY = Math.min(centerYA, centerYB);
        const maxCenterY = Math.max(centerYA, centerYB);
        const corridorX1 = Math.min(a.x1, b.x1);
        const corridorX2 = Math.max(a.x2, b.x2);
        const corridorWidth = Math.max(1, corridorX2 - corridorX1);

        return boxes.some((candidate) => {
            if (!candidate || candidate === a || candidate === b || candidate.label === a.label) return false;

            const candidateCenterY = (candidate.y1 + candidate.y2) / 2;
            if (candidateCenterY <= minCenterY || candidateCenterY >= maxCenterY) return false;

            const candidateWidth = Math.max(1, candidate.x2 - candidate.x1);
            const horizontalOverlap = Math.max(
                0,
                Math.min(corridorX2, candidate.x2) - Math.max(corridorX1, candidate.x1),
            );
            return horizontalOverlap / Math.min(corridorWidth, candidateWidth) >= 0.35;
        });
    }

    _mergeReadableBoxes(readableBoxes) {
        if (!Array.isArray(readableBoxes) || readableBoxes.length < 2) return readableBoxes || [];

        const boxes = readableBoxes
            .map((box, index) => ({ ...box, _order: index }))
            .sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);

        let changed = true;
        while (changed) {
            changed = false;
            outer: for (let i = 0; i < boxes.length; i++) {
                for (let j = i + 1; j < boxes.length; j++) {
                    if (!this._shouldMergeReadableBoxes(boxes[i], boxes[j])) continue;
                    // A different readable block is a phrase boundary even when the
                    // surrounding same-label blocks are tall enough to satisfy the
                    // gap heuristic (for example: text -> section-header -> text).
                    if (this._hasInterveningReadableBox(boxes[i], boxes[j], boxes)) continue;
                    boxes[i] = {
                        ...boxes[i],
                        x1: Math.min(boxes[i].x1, boxes[j].x1),
                        y1: Math.min(boxes[i].y1, boxes[j].y1),
                        x2: Math.max(boxes[i].x2, boxes[j].x2),
                        y2: Math.max(boxes[i].y2, boxes[j].y2),
                        label: boxes[i].label,
                    };
                    boxes.splice(j, 1);
                    changed = true;
                    break outer;
                }
            }
        }

        return boxes.sort((a, b) => a._order - b._order).map(({ _order, ...box }) => box);
    }

    _buildRegionsFromDetections(detections, viewportDisplay) {
        const readableBoxes = [];
        const ignoreBoxes = [];

        for (const det of detections || []) {
            const box = {
                x1: det.normalized.left * viewportDisplay.width,
                y1: det.normalized.top * viewportDisplay.height,
                x2: det.normalized.right * viewportDisplay.width,
                y2: det.normalized.bottom * viewportDisplay.height,
            };

            const expanded = {
                ...this._expandBox(box, viewportDisplay),
                label: det.label,
            };
            if (this.ITEMS_TO_READ.includes(det.label)) {
                readableBoxes.push(expanded);
            } else {
                ignoreBoxes.push(expanded);
            }
        }

        return { readableBoxes: this._mergeReadableBoxes(readableBoxes), ignoreBoxes };
    }

    // Public helper: returns readable/ignored layout boxes in viewport coordinates.
    // This lets other modules (e.g. SentenceParser) use layout regions for ordering/splitting.
    async getLayoutRegions(pageNumber, { force = false } = {}) {
        const { state } = this.app;
        const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
        if (!viewportDisplay) return { readableBoxes: [], ignoreBoxes: [] };

        const detections = await this.detectHeadersAndFooters(pageNumber, 1);
        // If we have no detections, return empty regions (caller can fall back to heuristics).
        if (!Array.isArray(detections) || detections.length === 0) {
            return { readableBoxes: [], ignoreBoxes: [] };
        }

        // Optionally force readability cache refresh to keep regions consistent.
        if (force) {
            try {
                await this.ensureReadabilityForPage(pageNumber, { force: true });
            } catch {}
        }

        return this._buildRegionsFromDetections(detections, viewportDisplay);
    }

    ensureReadabilityForPage(pageNumber, { force = false } = {}) {
        const { state } = this.app;

        const page = state.pagesCache.get(pageNumber);
        if (!page?.pageWords) {
            console.warn(`[Layout] No words cached for page ${pageNumber}; skipping readability.`);
            return Promise.resolve({ readable: 0, total: 0 });
        }

        const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
        if (!viewportDisplay) {
            console.warn(`[Layout] No viewport info for page ${pageNumber}; skipping readability.`);
            return Promise.resolve({ readable: 0, total: page.pageWords.length });
        }

        return this.detectHeadersAndFooters(pageNumber).then((detections) => {
            let cacheEntry = state.layoutDetectionCache.get(pageNumber);
            if (!cacheEntry) {
                cacheEntry = {
                    pageNumber,
                    detections,
                    timestamp: Date.now(),
                    cacheVersion: state.layoutCacheVersion,
                    modelVersion: "Oblix/yolov10m-doclaynet_ONNX_document-layout-analysis",
                    readabilityVersion: null,
                    readableWordCount: null,
                };
                state.layoutDetectionCache.set(pageNumber, cacheEntry);
            }

            const alreadyProcessed =
                !force &&
                cacheEntry.readabilityVersion === state.layoutCacheVersion &&
                cacheEntry.readableWordCount !== null;

            if (alreadyProcessed) {
                this.app.sentenceParser.applyLayoutFilteringToPage(pageNumber);
                return { readable: cacheEntry.readableWordCount, total: page.pageWords.length };
            }

            const { readableBoxes, ignoreBoxes } = this._buildRegionsFromDetections(detections, viewportDisplay);

            let readableCount = 0;
            for (const word of page.pageWords) {
                const box = word?.bbox
                    ? { x1: word.bbox.x1, y1: word.bbox.y1, x2: word.bbox.x2, y2: word.bbox.y2 }
                    : {
                          x1: word.x,
                          y1: word.y - word.height,
                          x2: word.x + word.width,
                          y2: word.y,
                      };

                // A successful inference with no readable regions means that the
                // model did not classify any part of this page as speech text.
                // Do not fail open here: model/render failures reject above, while
                // a genuine empty result deliberately leaves every word unreadable.
                const insideReadable = readableBoxes.some((r) => this._overlaps(box, r));
                const overlapsIgnored = ignoreBoxes.some((r) => this._overlaps(box, r));
                const isReadable = insideReadable && !overlapsIgnored;
                word.isReadable = isReadable;
                if (isReadable) readableCount++;
            }

            cacheEntry.readabilityVersion = state.layoutCacheVersion;
            cacheEntry.readableWordCount = readableCount;

            this.app.sentenceParser.applyLayoutFilteringToPage(pageNumber);
            return { readable: readableCount, total: page.pageWords.length };
        });
    }

    /**
     * NEW METHOD: Filter words based on layout detections
     * Returns only words that fall inside readable regions
     */
    filterReadableWords(pageNumber, words) {
        return this.ensureReadabilityForPage(pageNumber).then(() => (words || []).filter((word) => word?.isReadable));
    }

    _expandBox(box, viewportDisplay) {
        return {
            x1: Math.max(0, box.x1),
            y1: Math.max(0, box.y1),
            x2: Math.min(viewportDisplay.width, box.x2),
            y2: Math.min(viewportDisplay.height, box.y2),
        };
    }

    _overlaps(a, b) {
        const overlapX = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
        const overlapY = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
        return overlapX > 0 && overlapY > 0;
    }

    _getDetectionDisplayBox(det, viewportDisplay, baseCanvas = null) {
        if (!det || !viewportDisplay) return null;

        if (det.normalized) {
            const x1 = det.normalized.left * viewportDisplay.width;
            const y1 = det.normalized.top * viewportDisplay.height;
            const x2 = det.normalized.right * viewportDisplay.width;
            const y2 = det.normalized.bottom * viewportDisplay.height;
            if (x2 <= x1 || y2 <= y1) return null;
            return { x1, y1, x2, y2, width: x2 - x1, height: y2 - y1 };
        }

        const canvasWidth = baseCanvas?.width || viewportDisplay.width;
        const canvasHeight = baseCanvas?.height || viewportDisplay.height;
        const scaleX = viewportDisplay.width / canvasWidth;
        const scaleY = viewportDisplay.height / canvasHeight;
        const x1 = det.x1 * scaleX;
        const y1 = det.y1 * scaleY;
        const width = (det.width || det.x2 - det.x1) * scaleX;
        const height = (det.height || det.y2 - det.y1) * scaleY;
        if (width <= 0 || height <= 0) return null;
        return { x1, y1, x2: x1 + width, y2: y1 + height, width, height };
    }

    _drawNotSureTextControls(pageNumber, detections, baseCanvas = null) {
        const { state } = this.app;
        const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
        const container = document.querySelector(`[data-page-number="${pageNumber}"]`);
        if (!container || !viewportDisplay) return;

        container.querySelector(".not-sure-layout-controls")?.remove();
        const uncertain = (detections || [])
            .map((det, index) => ({ det, index }))
            .filter(({ det }) => String(det?.label || "").toLowerCase() === "not-sure-text");
        if (!uncertain.length) return;

        const overlay = document.createElement("div");
        overlay.className = "not-sure-layout-controls";

        for (const { det, index } of uncertain) {
            const box = this._getDetectionDisplayBox(det, viewportDisplay, baseCanvas);
            if (!box) continue;

            const region = document.createElement("button");
            region.type = "button";
            region.className = "not-sure-layout-region";
            // Percentages keep the interactive region aligned when the page
            // wrapper is resized or shifted by mobile scaling or text-width fit.
            region.style.left = `${(box.x1 / viewportDisplay.width) * 100}%`;
            region.style.top = `${(box.y1 / viewportDisplay.height) * 100}%`;
            region.style.width = `${(box.width / viewportDisplay.width) * 100}%`;
            region.style.height = `${(box.height / viewportDisplay.height) * 100}%`;
            region.title = "Add as text";
            region.setAttribute("aria-label", "Add as text");
            region.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.setDetectionLabel(pageNumber, index, "text").catch((error) => {
                    console.warn("[Layout] Failed to add uncertain region as text", error);
                });
            });

            for (const side of ["left", "right"]) {
                const addBtn = document.createElement("button");
                addBtn.type = "button";
                addBtn.className = `not-sure-layout-add not-sure-layout-add-${side}`;
                addBtn.title = "Add as text";
                addBtn.setAttribute("aria-label", "Add as text");
                addBtn.innerHTML = `<span class="material-symbols-outlined">add</span>`;
                addBtn.addEventListener("click", (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.setDetectionLabel(pageNumber, index, "text").catch((error) => {
                        console.warn("[Layout] Failed to add uncertain region as text", error);
                    });
                });
                region.appendChild(addBtn);
            }

            overlay.appendChild(region);
        }

        container.appendChild(overlay);
    }

    async setDetectionLabel(pageNumber, detectionIndex, label) {
        const { state } = this.app;
        const cacheEntry = state.layoutDetectionCache.get(pageNumber);
        const detections = cacheEntry?.detections;
        const det = detections?.[detectionIndex];
        if (!det) return false;

        det.originalLabel = det.originalLabel || det.label;
        det.label = label;
        det.manualLabel = true;
        cacheEntry.readabilityVersion = null;
        cacheEntry.readableWordCount = null;

        await this.ensureReadabilityForPage(pageNumber, { force: true });
        this._refreshPageLayoutUi(pageNumber);
        this.app.ui?.showInfo?.(`Layout label: ${label}`);
        return true;
    }

    async _readNotSureTextRegion(pageNumber, detectionIndex, event) {
        const { state } = this.app;
        const wrapper = event.target?.closest?.(".pdf-page-wrapper");
        const canvas = wrapper?.querySelector?.("canvas.page-canvas");
        const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
        if (!wrapper || !canvas || !viewportDisplay) return;

        const canvasRect = canvas.getBoundingClientRect();
        const scale = parseFloat(wrapper.dataset.scale) || 1;
        const xDisplay = (event.clientX - canvasRect.left) / scale;
        const yDisplay = (event.clientY - canvasRect.top) / scale;

        await this.setDetectionLabel(pageNumber, detectionIndex, "text");

        const idx = hitTestSentence(state, pageNumber, xDisplay, yDisplay);
        if (idx < 0) return;

        await this.app.audioManager?.stopPlayback?.(true);
        state.autoAdvanceActive = false;
        await this.app.pdfRenderer?.renderSentence?.(idx, { skipTTS: true });
        this.app.cache?.clearAudioFrom?.(idx);
        this.app.ttsQueue?.add?.(idx, true);
        this.app.ttsQueue?.run?.();
        await this.app.audioManager?.playCurrentSentence?.();
    }

    _refreshPageLayoutUi(pageNumber) {
        const { state } = this.app;
        const cacheEntry = state.layoutDetectionCache.get(pageNumber);
        const detections = cacheEntry?.detections || [];
        const canvas = state.fullPageRenderCache.get(pageNumber) || null;

        this._drawIgnoredDetectionsOverlay(pageNumber, detections, canvas);
        this._drawNotSureTextControls(pageNumber, detections, canvas);
        if (this.debug) this._drawDetectedLayoutOverlay(pageNumber, detections, canvas);
        this.app.pdfRenderer?.updatePhraseHighlightsAndListeners?.({ forceFullRescale: true });
    }

    _nextRequestId() {
        this._requestIdCounter = (this._requestIdCounter + 1) % Number.MAX_SAFE_INTEGER;
        if (this._requestIdCounter === 0) this._requestIdCounter = 1;
        return this._requestIdCounter;
    }

    _sendWorkerDetection(payload) {
        // Promise ownership stays on the main thread. The request map is the only
        // bridge between worker messages and callers awaiting a particular page.
        const requestId = this._nextRequestId();
        const message = {
            action: "detect",
            requestId,
            pageNumber: payload.pageNumber,
            detectionThreshold: payload.detectionThreshold,
            detectionClasses: payload.detectionClasses,
            originalWidth: payload.originalWidth,
            originalHeight: payload.originalHeight,
            scaledWidth: payload.scaledWidth,
            scaledHeight: payload.scaledHeight,
            imageData: payload.imageData,
        };

        const transferables = [];
        if (payload.imageData?.data?.buffer) transferables.push(payload.imageData.data.buffer);

        return this.workerReadyPromise.then(
            () =>
                new Promise((resolve, reject) => {
                    this._pendingWorkerRequests.set(requestId, { resolve, reject, pageNumber: payload.pageNumber });
                    try {
                        this.worker.postMessage(message, transferables);
                    } catch (error) {
                        this._pendingWorkerRequests.delete(requestId);
                        reject(error);
                    }
                }),
        );
    }
}
