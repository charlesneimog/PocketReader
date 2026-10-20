# PocketReader application architecture

This document explains how PocketReader works at runtime, why its main boundaries exist, and where the code can be simplified later without intentionally changing behavior. It complements function-level comments; it is not a replacement for tests.

## Mental model

PocketReader is a browser application organized around one shared `PDFTTSApp` instance. `src/app.js` is the composition root: it constructs services, gives each service a reference to the app, and exposes the small public API used by controls and the page shell.

The important distinction is ownership:

| Concern | Owner | Notes |
| --- | --- | --- |
| Runtime data | `StateManager` | Holds the current document, sentences, indexes, caches, and playback flags. |
| Workflow coordination | `PDFTTSApp` | Connects loaders, renderers, TTS, persistence, translation, and UI. |
| PDF extraction | `PDFLoader` | Loads PDF.js documents and creates page word geometry. |
| Semantic phrases | `SentenceParser` | Converts PDF words into stable sentence/phrase records. |
| PDF presentation | `PDFRenderer` | Owns page canvases, scaling, phrase overlays, and scrolling. |
| Layout policy | `PDFHeaderFooterDetector` | Owns layout requests, caching, readable-region decisions, and layout UI. |
| Layout inference | `src/modules/pdf/ts.js` worker | Owns the Transformers.js model and processor only. |
| EPUB presentation | `EPUBLoader` / `EPUBRenderer` | Uses Foliate and CFI-based annotations instead of PDF geometry. |
| Speech generation | `TTSEngine`, Piper workers, optional `ServerTtsClient` | Selects device or server synthesis and records phrase/word timing on the client. |
| Speech scheduling | `TTSQueueManager` | Limits concurrency and refuses unreadable or unprocessed sentences. |
| Playback | `AudioManager` | Plays decoded audio, advances sentences, and emits playback events. |
| Pointer/selection input | `InteractionHandler` | Converts mouse coordinates into phrases or custom PDF text selections. |
| Persistence | `ProgressManager`, `HighlightsStorage`, `PDFThumbnailCache` | Own local IndexedDB/local-storage representations. |
| Optional remote state | `SyncManager` | Routes the shared sync interface to self-hosted or Google Drive implementations. |
| Cross-cutting observers | `EventBus` | Translation UI, rewards, and similar observers subscribe without owning core workflows. |

Services call each other through `this.app`. This is convenient but means a service's real dependencies are not visible in its constructor signature. When changing a workflow, search for both direct imports and `this.app.<service>` calls.

## Startup and lifetime

The module-level `app` instance is created when `src/app.js` is imported.

1. `PDFTTSApp.constructor()` creates UI helpers first, then config/state/event infrastructure, persistence, document loaders/renderers, and audio services.
2. `_loadRuntimeSettings()` loads user settings and resolves the current TTS backend. `TTS_BACKEND` is an application setting, but smartphone compatibility may downgrade WebGPU to WASM.
3. `initialize()` starts viewport tracking, installs accessibility regions, initializes rewards, and calls the initial document/gallery path.
4. `closeCurrentDocument()` is the lifetime boundary. It immediately invalidates speech requests, closes the server speech session or local Piper workers, stops playback/sync, releases document-specific objects and the lazy PDF layout worker, clears caches, and resets document state. Opening another book also releases the previous speech session.

The layout detector is deliberately lazy. `getPdfHeaderFooterDetector()` constructs it only when PDF work requires it; `loadEPUB()` and `closeCurrentDocument()` release it. This prevents EPUB-only sessions from downloading or allocating the layout model.

## PDF open call flow

The main PDF path is:

```text
PDFTTSApp.loadPDF(file)
  -> prompt/apply translation setup
  -> start TTS voice warm-up (in parallel)
  -> PDFLoader.loadPDF(file)
       -> reset document caches and queue state
       -> PDF.js getDocument()
       -> layout detector prepare() (in parallel)
       -> preprocessPage() for each page
            -> PDF.js getTextContent()
            -> create word records with display and canonical geometry
       -> SentenceParser.buildSentences()
       -> restore progress, voice, highlights, and optional remote state
       -> PDFRenderer.renderFullDocumentIfNeeded()
       -> PDFRenderer.renderSentence(startIndex)
       -> InteractionHandler.setupInteractionListeners()
       -> emit PDF_LOADED and SENTENCES_PARSED
       -> warm layout filtering for the initial page
  -> await the independent voice warm-up
  -> optionally begin playback
```

Text extraction, layout-model initialization, and TTS voice initialization overlap intentionally. They do not depend on one another, and serializing them would increase time-to-first-playback.

### Word and sentence representations

`PDFLoader.preprocessPage()` creates word objects. Each word has display geometry (`x`, `y`, `width`, `height`, `bbox`) and canonical base geometry used for safe rescaling. Do not discard the base geometry unless all resize/orientation paths are changed together.

`SentenceParser` groups words into phrase records stored in `state.sentences`. A phrase record is shared by rendering, layout filtering, TTS caching, playback, progress, and highlights. Its `index` is therefore an application identity, not merely an array position local to the parser.

Layout processing later adds `readableWords`, `readableText`, `layoutProcessed`, and `isTextToRead`. The TTS queue treats these fields as prerequisites. A sentence may exist before it is known to be readable.

## Layout detection call flow

Layout has a main-thread policy layer and a worker inference layer:

```text
PDFLoader / PDFRenderer / TTSQueueManager
  -> PDFHeaderFooterDetector.ensureReadabilityForPage(page)
       -> detectHeadersAndFooters(page)
            -> return valid state.layoutDetectionCache entry, or
            -> wait for an existing page promise, or
            -> serialize a new _performDetection(page)
                 -> PDFRenderer.ensureFullPageRendered(page)
                 -> canvas ImageData
                 -> _sendWorkerDetection({ requestId, imageData, ... })
                      -> layout worker runDetection()
                      -> normalized detection boxes
                 -> cache detections
       -> build readable and ignored regions
       -> mark page words readable/unreadable
       -> SentenceParser.applyLayoutFilteringToPage(page)
```

`PDFHeaderFooterDetector` serializes inference to avoid holding multiple full-page GPU tensors at once. This is independent from page text extraction and TTS concurrency.

The worker protocol has two commands:

- `init`: load the processor and model once. `LAYOUT_DETECTION_BACKEND` chooses `"wasm"` or `"webgpu"`. Requested WebGPU can fall back to WASM when the browser or model session cannot use it.
- `detect`: process one transferred `ImageData` object. Every response carries a `requestId`; the detector resolves the corresponding promise in `_pendingWorkerRequests`.

Backend strings are normalized in `config.js` before worker creation and validated again in the worker. The duplication is intentional because `postMessage` is a runtime boundary.

`state.layoutCacheVersion` invalidates cached detections/readability when policy changes or a force rebuild occurs. Code that changes detection labels or readable-region rules must also consider cache invalidation.

## PDF mouse selection call flow

PDF canvases do not provide native selectable text, so `InteractionHandler` maintains a custom word selection:

```text
mousedown
  -> _startPdfDragSelection()
       -> _buildPageLineModel() once for the gesture
mousemove
  -> _updatePdfDragSelection()
       -> _findLineIndexAtPoint() for anchor and focus
       -> _getLinesForLayoutFlow() to preserve the selected column
       -> _selectWordsBetweenEndpoints()
       -> paint .pdf-text-selection overlays
       -> store selected text and sentence indexes
Ctrl/Cmd+C
  -> _handleSelectionCopyShortcut()
       -> custom selection first
       -> current phrase only when no selection exists
```

The selection model uses CSS-pixel geometry because pointer events and overlays use CSS pixels. It must not mix those values with raw PDF units.

Layout block keys are preferred for column identity. `_splitLineAtColumnGaps()` and horizontal overlap are fallbacks for documents whose layout model is disabled, unavailable, or not finished. X-aware hit testing is required because two columns can share the same Y coordinate.

Endpoint rules mirror normal text selection:

- same line: select between the two word positions in either direction;
- forward multiline drag: anchor-line suffix, complete intervening lines, focus-line prefix;
- backward multiline drag: focus-line suffix, complete intervening lines, anchor-line prefix.

The selected word set is the single source used for overlays, clipboard text, and selection-based highlights/comments. Avoid independently recomputing those outputs.

## TTS and playback call flow

```text
PDFRenderer.renderSentence() / playback navigation
  -> TTSEngine.schedulePrefetch()
       -> TTSQueueManager.add(index)
            -> ensure page layout first when needed
            -> reject unreadable/already-ready/in-flight work
       -> TTSQueueManager.run()
            -> TTSEngine.synthesizeSequential(index)
                 -> optional translated speech text
                 -> ensurePiper(voice)
                 -> buildPiperAudio()
                      -> Piper worker pool
                      -> decode WebAudio buffers
                      -> cache audio and timing metadata
            -> AudioManager.playCurrentSentence() for the active index
                 -> phrase/word highlight updates
                 -> auto-advance and next prefetch
```

`TTS_BACKEND` is `"wasm"` or `"webgpu"`; WASM is the default. Piper may report a runtime fallback (initialization failure or GPU device loss); the app then updates its resolved setting and can rebuild the engine. Layout and TTS backend choices are independent because they use different models, workers, and failure characteristics. `LAYOUT_DETECTION_BACKEND` also defaults to WASM, with WebGPU remaining an explicit opt-in.

The optional **Use server speech when available** setting selects where speech is generated, independently of the device inference backend. `TTSEngine.ensurePiper()` prepares either a local worker pool or an authenticated `ServerTtsClient` session. Remote mode skips local model initialization. A server failure falls back to device speech for that book; opening another book or toggling the setting retries the server. Both paths select the same immutable Piper model/configuration revision from `assets/tts-voices.json`; local model cache keys include that revision.

Document parsing, layout filtering, phrase splitting, translation preparation, pauses, and highlighting remain client responsibilities. The client sends cleaned phrase text and immutable voice/length-scale settings; `/api/tts/sessions/{id}/phrases` returns binary MP3. The client decodes it to derive the existing phrase/word timing data and retains the MP3 for playback. Reading-speed multipliers map to Piper length scale as `1 / multiplier`.

`tts_service.py` owns a bounded set of per-reader subprocesses. Only those processes import Piper/ONNX, load models, and invoke FFmpeg. Closing a session or changing its voice terminates the process group and reaps the worker; pinned model files remain cached on disk. Heartbeats renew a lease so disconnected clients are eventually cleaned up. Each session serializes a small bounded queue of phrase/settings operations. Authentication binds session ownership to the requesting account.

Queue generations and engine lifetime IDs guard every asynchronous synthesis result. Resetting the queue aborts requests and prevents old completions, counters, layout callbacks, or settings responses from affecting a replacement task or document. Cancellation does not mark the shared sync server unavailable.

PDF phrases can be subdivided by layout block for speech. `ttsPhraseTimings` preserves the relationship between concatenated audio and visual layout blocks, and `wordBoundaries` drives word highlighting. An audio-cache entry is valid only when voice, speed, normalized text, and required phrase timing metadata still match.

## Events versus direct calls

Use a direct call when the caller requires a result or owns sequencing. Examples: the queue awaits TTS synthesis; the loader awaits sentence parsing; the detector awaits a worker response.

Use `EventBus` when independent observers react to a completed fact. Examples: rewards react to reading activity; subtitle UI reacts to playback phrase changes; persistence can react to highlight events.

Events should not secretly own a required step in the main load/playback path. Required work hidden in an event handler makes failures and ordering difficult to reason about.

## Persistence and sync

Local storage is authoritative for offline operation. Progress, documents, thumbnails, and highlights have specialized owners rather than one generic repository.

`SyncManager` is a compatibility facade. Its `active` backend is either the self-hosted `ServerSync` or `GoogleDriveSync`; common methods delegate to that backend. Server-only operations such as authentication and translation intentionally route directly to `ServerSync`.

Document keys connect local files, progress, highlights, and remote records. Changing key generation requires a migration plan; otherwise existing annotations can appear to disappear even though the data remains stored under an older key.

## Invariants worth protecting

- `state.sentences[index].index === index` for current PDF workflows.
- A PDF word's geometry and its page viewport use the same coordinate system before applying renderer CSS scale.
- TTS work starts only after `layoutProcessed`, and only for `isTextToRead` sentences.
- One page has at most one in-flight layout detection promise.
- Layout inference requests are correlated by `requestId` and cleared on success/error/dispose.
- Clipboard selection has priority over the current phrase.
- Intermediate lines in a multiline selection are complete; only endpoint lines are partial.
- A same-column drag must not include words from a neighboring column.
- Closing/changing documents invalidates queues and promises tied to the previous document.
- Persistent highlight remapping respects `PHRASE_SPLIT_VERSION`.

## Potential future simplifications

These are candidates, not current instructions. Each should be removed only after its callers are migrated and regression coverage exists.

1. **Replace the renderer proxy.** `app.pdfRenderer` is a compatibility proxy that sometimes targets PDF and sometimes EPUB, while `_pdfRenderer`, `epubRenderer`, and `getActiveRenderer()` also exist. Migrate call sites to explicit document renderers or a small common interface, then remove the proxy and duplicate aliases.

2. **Remove the `pdfHeaderFooterDetector` public alias.** `_pdfHeaderFooterDetector` plus `getPdfHeaderFooterDetector()` already owns lazy lifetime. Some renderer code still checks the public alias. Migrate those callers to the getter or an injected layout service, then keep one reference.

3. **Promote shared PDF geometry/layout helpers.** `InteractionHandler` currently calls underscored `PDFRenderer` methods to reuse cached layout boxes and overlap math. Move coordinate boxes, overlap, and block lookup into a small public geometry/layout module; this reduces hidden coupling without changing behavior.

4. **Remove unused selection helpers after verification.** `_buildSelectedTextFromWords()` currently has no call site. It can be deleted once repository-wide and browser-extension/integration callers are ruled out; `_buildSelectedTextFromLines()` is the active path.

5. **Remove the no-op page registration hook.** `PDFHeaderFooterDetector.registerPageDomElement()` currently returns immediately but still has a renderer call site. Remove both together after confirming no external/debug integration relies on the hook.

6. **Consolidate resolved TTS backend state.** `state.ttsWebGpuEnabled` and `config.TTS_BACKEND` describe the same resolved choice in different forms. Once UI callers consume the string backend, derive the boolean instead of storing both.

7. **Remove single-page view code if it remains unsupported.** `StateManager` already marks this as a TODO and defaults to full-document view. First inventory `viewMode === "single"` branches, remove/deactivate controls, and add full-view navigation tests.

8. **Split `PDFTTSApp` by workflow.** Translation setup, document loading, and playback preparation occupy the same orchestrator. Extracting workflow services can make dependencies explicit, but keep `PDFTTSApp` as the composition root until public UI call sites are migrated.

9. **Unify duplicate TTS completion/error emission.** Both the engine and queue participate in synthesis events. Define one owner and verify reward/UI subscribers before removing duplicates, otherwise observers may fire twice or stop firing.

10. **Replace broad `this.app` access gradually.** Constructor-injected narrow dependencies would improve testability. Do this module by module; a full rewrite would risk breaking lifecycle ordering and compatibility properties.

## How to approach changes

Before changing a workflow:

1. Identify the owner in the table above.
2. Trace required direct calls and optional event subscribers.
3. List shared `StateManager` fields read and written by the path.
4. Check document-close/reset behavior for stale promises, workers, and caches.
5. Preserve coordinate units when touching PDF geometry.
6. Preserve backend fallback and report the actual backend, not only the requested one.
7. Add focused unit coverage for pure decisions and a browser check for canvas, worker, WebGPU, or WebAudio behavior.

This approach favors small boundary improvements over rewrites. PocketReader's features are interconnected through sentence identity, page geometry, and asynchronous model work; simplifying one of those areas safely requires preserving those relationships explicitly.
