const APP_VERSION = "0.44.1+8";
const IDB_VERSION = 1;
const cacheName = `PocketReader-v${APP_VERSION}`;
const runtimeCache = `PocketReader-runtime-v${APP_VERSION}`;
let coepCredentialless = true;

// Determine the base path (works for both root and subpath deployments)
const getBasePath = () => {
    const path = self.location.pathname;
    // If hosted in subdirectory like /PocketReader/
    if (path.includes("/PocketReader/")) {
        return "/PocketReader";
    }
    return "";
};

const BASE_PATH = getBasePath();

// Helper to resolve paths
const resolvePath = (path) => {
    if (path.startsWith("http")) return path;
    return BASE_PATH + path;
};

// routes to cache
const staticFiles = [
    "/",
    "/index.html",
    "/privacy.html",
    "/terms.html",
    "/manifest.webmanifest",
    "/threads.js",

    // Assets
    "/assets/icons/favicon-16x16.png",
    "/assets/icons/favicon-32x32.png",
    "/assets/icons/favicon.svg",
    "/assets/icons/icon-192.png",
    "/assets/icons/icon-512.png",
    "/assets/icons/icon-1024.png",
    "/assets/icons/logo.png",
    "/assets/icons/logo.svg",
    "/assets/icons/mask-512.png",
    "/assets/icons/mask.svg",
    "/assets/images/default-user.png",
    "/assets/rewards/trees/catalog.json",
    "/assets/rewards/trees/minute-sprout.svg",
    "/assets/rewards/trees/reading-sapling.svg",
    "/assets/rewards/trees/aurora-pine.svg",
    "/assets/rewards/trees/violet-blossom.svg",
    "/assets/rewards/trees/coral-canopy.svg",
    "/assets/rewards/trees/crystal-willow.svg",
    "/assets/rewards/trees/sunset-maple.svg",
    "/assets/rewards/trees/ember-bonsai.svg",
    "/assets/rewards/trees/firefly-fig.svg",
    "/assets/rewards/trees/geometric-cypress.svg",
    "/assets/rewards/trees/rainbow-baobab.svg",
    "/assets/rewards/trees/moonlit-oak.svg",
    "/assets/rewards/trees/starlight-birch.svg",
    "/assets/rewards/trees/tea-cloud-tree.svg",
    "/assets/rewards/trees/wind-song-tree.svg",
    "/assets/rewards/trees/jequitiba-ancient.svg",
    "/assets/rewards/trees/ipe-amarelo-golden-rain.svg",
    "/assets/rewards/trees/ipe-roxo-twilight.svg",
    "/assets/rewards/trees/araucaria-parana.svg",
    "/assets/rewards/trees/pau-brasil-red-heart.svg",
    "/assets/rewards/trees/jabuticaba-night-orchard.svg",
    "/assets/rewards/trees/embauba-silver-fan.svg",
    "/assets/rewards/trees/mangue-vermelho-tide.svg",
    "/assets/rewards/trees/castanheira-amazonia.svg",
    "/assets/rewards/trees/buriti-sun-palm.svg",
    "/assets/screenshots/screenshot1.png",
    "/assets/screenshots/screenshot2.png",

    // CSS
    "/src/css/style.css",
    "/src/css/epub.css",
    "/src/css/input.css",
    "/src/css/output.css",
    "/src/css/rewards.css",

    // JS principais
    "/src/app.js",
    "/src/config.js",
    "/src/constants/cacheManager.js",
    "/src/constants/events.js",
    "/src/core/cacheManager.js",
    "/src/core/eventBus.js",
    "/src/core/stateManager.js",
    "/src/modules/index.js",

    // Módulos (principais)
    "/src/modules/pdf/pdfLoader.js",
    "/src/modules/pdf/pdfRenderer.js",
    "/src/modules/pdf/pdfHeaderFooterDetector.js",
    "/src/modules/pdf/sentenceParser.js",
    "/src/modules/pdf/ts.js",
    "/src/modules/epub/epubLoader.js",
    "/src/modules/epub/epubRenderer.js",
    "/src/modules/storage/pdfThumbnailCache.js",
    "/src/modules/storage/googleDriveSync.js",
    "/src/modules/storage/serverSync.js",
    "/src/modules/storage/syncManager.js",
    "/src/modules/storage/exportManager.js",
    "/src/modules/storage/highlightsStorage.js",
    "/src/modules/storage/progressManager.js",
    "/src/modules/rewards/activeReadingTracker.js",
    "/src/modules/rewards/crossTabSessionLock.js",
    "/src/modules/rewards/gardenManager.js",
    "/src/modules/rewards/gardenRenderer.js",
    "/src/modules/rewards/index.js",
    "/src/modules/rewards/plantDefinitions.js",
    "/src/modules/rewards/readingEventAdapter.js",
    "/src/modules/rewards/readingSessionManager.js",
    "/src/modules/rewards/rewardDefinitions.js",
    "/src/modules/rewards/rewardEngine.js",
    "/src/modules/rewards/rewardMigrations.js",
    "/src/modules/rewards/rewardStorage.js",
    "/src/modules/rewards/streakManager.js",
    "/src/modules/tts/audioManager.js",
    "/src/modules/tts/piper-client.js",
    "/src/modules/tts/piper.worker.js",
    "/src/modules/tts/ttsBackendPreference.js",
    "/src/modules/tts/synthesisQueue.js",
    "/src/modules/tts/ttsEngine.js",
    "/src/modules/tts/wordHighlighter.js",
    "/src/modules/ui/controlsManager.js",
    "/src/modules/ui/highlightManager.js",
    "/src/modules/ui/interactionHandler.js",
    "/src/modules/ui/uiService.js",
    "/src/modules/ui/gardenDialog.js",
    "/src/modules/ui/reflectionDialog.js",
    "/src/modules/ui/rewardsPanel.js",
    "/src/modules/ui/sessionProgressWidget.js",
    "/src/modules/ui/sessionSetupDialog.js",
    "/src/modules/utils/ariaManager.js",
    "/src/modules/utils/coordinates.js",
    "/src/modules/utils/helpers.js",
    "/src/modules/utils/responsive.js",
    "/src/modules/utils/viewport.js",

    // Third-party
    "/thirdparty/ort/ort.js",
    "/thirdparty/ort/ort-wasm-simd-threaded.asyncify.mjs",
    "/thirdparty/ort/ort-wasm-simd-threaded.asyncify.wasm",
    "/thirdparty/ort/ort-wasm-simd.wasm",
    "/thirdparty/ort/ort-wasm-simd-threaded.jsep.mjs",
    "/thirdparty/ort/ort-wasm-simd-threaded.jsep.wasm",
    "/thirdparty/pdf/pdf.js",
    "/thirdparty/pdf/pdf.worker.js",
    "/thirdparty/pdf/pdf-lib.js",
    "/thirdparty/piper/piper-o91UDS6e.js",
    "/thirdparty/piper/piper_phonemize.data",
    "/thirdparty/piper/piper_phonemize.js",
    "/thirdparty/piper/piper_phonemize.wasm",
    "/thirdparty/transformers/transformers.js",

    // Foliate EPUB reader dependencies
    "/thirdparty/foliate-js/comic-book.js",
    "/thirdparty/foliate-js/epub.js",
    "/thirdparty/foliate-js/epubcfi.js",
    "/thirdparty/foliate-js/fb2.js",
    "/thirdparty/foliate-js/fixed-layout.js",
    "/thirdparty/foliate-js/mobi.js",
    "/thirdparty/foliate-js/overlayer.js",
    "/thirdparty/foliate-js/paginator.js",
    "/thirdparty/foliate-js/pdf.js",
    "/thirdparty/foliate-js/progress.js",
    "/thirdparty/foliate-js/search.js",
    "/thirdparty/foliate-js/text-walker.js",
    "/thirdparty/foliate-js/tts.js",
    "/thirdparty/foliate-js/view.js",
    "/thirdparty/foliate-js/vendor/fflate.js",
    "/thirdparty/foliate-js/vendor/zip.js",

    // Fonts
    "/thirdparty/fonts/Inter.css",
    "/thirdparty/fonts/Material-symbols-outlined.css",
    "/thirdparty/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa0ZL7SUc.woff2",
    "/thirdparty/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2",
    "/thirdparty/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1pL7SUc.woff2",
    "/thirdparty/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa25L7SUc.woff2",
    "/thirdparty/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2JL7SUc.woff2",
    "/thirdparty/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2ZL7SUc.woff2",
    "/thirdparty/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2pL7SUc.woff2",
    "/thirdparty/fonts/font.woff2",
];

// External resources to cache (fonts, CDN dependencies)
const externalResources = [
    // Kinde Auth (optional - will fail gracefully if offline)
    "https://cdn.jsdelivr.net/npm/@kinde-oss/kinde-auth-pkce-js@4.3.0/dist/kinde-auth-pkce-js.esm.js",
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json",
];

// Patterns for runtime caching
const EXTERNAL_CACHE_PATTERNS = [
    "https://fonts.googleapis.com",
    "https://fonts.gstatic.com",
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers",
    "https://huggingface.co/",
];

// Check if URL matches any cache pattern
const shouldCacheExternally = (url) => {
    return EXTERNAL_CACHE_PATTERNS.some((pattern) => url.startsWith(pattern));
};

const routes = ["/"];
const resolvedRoutes = routes.map(resolvePath);
const resolvedStaticFiles = staticFiles.map(resolvePath);
const filesToCache = [...resolvedRoutes, ...resolvedStaticFiles];
const requestsToRetryWhenOffline = [];

//╭─────────────────────────────────────╮
//│              IDBConfig              │
//╰─────────────────────────────────────╯
const IDBConfig = {
    name: "web-app-db",
    version: IDB_VERSION,
    stores: {
        requestStore: {
            name: `request-store`,
            keyPath: "timestamp",
        },
    },
};

//╭─────────────────────────────────────╮
//│            For requests             │
//╰─────────────────────────────────────╯
const isOffline = () => !self.navigator.onLine;
const isRequestEligibleForRetry = ({ url, method }) => {
    return ["POST", "PUT", "DELETE"].includes(method) || requestsToRetryWhenOffline.includes(url);
};

const createIndexedDB = ({ name, stores }) => {
    const request = self.indexedDB.open(name, IDB_VERSION);
    return new Promise((resolve, reject) => {
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            Object.keys(stores).forEach((store) => {
                const { name, keyPath } = stores[store];
                if (!db.objectStoreNames.contains(name)) {
                    db.createObjectStore(name, { keyPath });
                    console.log("create objectstore", name);
                }
            });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
};

const getStoreFactory =
    (dbName) =>
    ({ name }, mode = "readonly") => {
        return new Promise((resolve, reject) => {
            const request = self.indexedDB.open(dbName, IDB_VERSION);
            request.onsuccess = (e) => {
                const db = request.result;
                const transaction = db.transaction(name, mode);
                const store = transaction.objectStore(name);
                const storeProxy = new Proxy(store, {
                    get(target, prop) {
                        if (typeof target[prop] === "function") {
                            return (...args) =>
                                new Promise((resolve, reject) => {
                                    const req = target[prop].apply(target, args);
                                    req.onsuccess = () => resolve(req.result);
                                    req.onerror = (err) => reject(err);
                                });
                        }
                        return target[prop];
                    },
                });
                return resolve(storeProxy);
            };
            request.onerror = (_) => reject(request.error);
        });
    };

const openStore = getStoreFactory(IDBConfig.name);

const serializeHeaders = (headers) =>
    [...headers.entries()].reduce(
        (acc, [key, value]) => ({
            ...acc,
            [key]: value,
        }),
        {},
    );

const storeRequest = async ({ url, method, body, headers, mode, credentials }) => {
    if (isOffline()) return;
    const serializedHeaders = serializeHeaders(headers);
    try {
        let storedBody = body;
        if (body && body instanceof ReadableStream) {
            const clonedBody = body.tee()[0];
            storedBody = await new Response(clonedBody).arrayBuffer();
        }

        const timestamp = Date.now();
        const store = await openStore(IDBConfig.stores.requestStore, "readwrite");

        await store.add({
            timestamp,
            url,
            method,
            ...(storedBody && { body: storedBody }),
            headers: serializedHeaders,
            mode,
            credentials,
        });

        if ("sync" in self.registration) {
            console.log("register sync for retry request");
            await self.registration.sync.register(`retry-request`);
        }
    } catch (error) {
        console.log("idb error", error);
    }
};

const getCacheStorageNames = async () => {
    const cacheNames = (await caches.keys()) || [];
    const outdatedCacheNames = cacheNames.filter((name) => !name.includes(cacheName));
    const latestCacheName = cacheNames.find((name) => name.includes(cacheName));
    return { latestCacheName, outdatedCacheNames };
};

const updateLastCache = async () => {
    const { latestCacheName, outdatedCacheNames } = await getCacheStorageNames();
    if (!latestCacheName || !outdatedCacheNames?.length) {
        return null;
    }
    const latestCache = await caches.open(latestCacheName);
    const latestCacheEntries = (await latestCache?.keys())?.map((c) => c.url) || [];
    for (const outdatedCacheName of outdatedCacheNames) {
        const outdatedCache = await caches.open(outdatedCacheName);
        for (const entry of latestCacheEntries) {
            const latestCacheResponse = await latestCache.match(entry);
            await outdatedCache.put(entry, latestCacheResponse.clone());
        }
    }
};

const getRequests = async () => {
    try {
        const store = await openStore(IDBConfig.stores.requestStore, "readwrite");
        return await store.getAll();
    } catch (err) {
        return err;
    }
};

const retryRequests = async () => {
    if (isOffline()) return;
    const reqs = await getRequests();
    const requests = reqs.map(({ url, method, headers: serializedHeaders, body, mode, credentials }) => {
        const headers = new Headers(serializedHeaders);
        return fetch(url, { method, headers, body, mode, credentials });
    });

    const responses = await Promise.allSettled(requests);
    const requestStore = await openStore(IDBConfig.stores.requestStore, "readwrite");
    const { keyPath } = IDBConfig.stores.requestStore;

    responses.forEach((response, index) => {
        const key = reqs[index][keyPath];

        // remove the request from IndexedDB if the response was successful
        if (response.status === "fulfilled") {
            requestStore.delete(key);
        } else {
            console.log(`retrying response with ${keyPath} ${key} failed: ${response.reason}`);
        }
    });
};

const cacheLocalFiles = async () => {
    const cache = await caches.open(cacheName);
    const results = await Promise.allSettled(
        filesToCache.map((file) => cache.add(new Request(file, { cache: "reload" }))),
    );
    results.forEach((result, index) => {
        if (result.status === "rejected") {
            console.warn("[SW] Failed to cache:", filesToCache[index], result.reason);
        }
    });
};

const installHandler = (e) => {
    console.log("[SW] Installing service worker v" + APP_VERSION);
    const offline = isOffline();
    e.waitUntil(
        Promise.all([
            // Cache local files
            offline ? Promise.resolve() : cacheLocalFiles(),
            // Cache external resources with proper error handling
            offline
                ? Promise.resolve()
                : caches.open(cacheName).then((cache) =>
                      Promise.allSettled(
                          externalResources.map((url) =>
                              fetch(url, { mode: "cors", cache: "no-cache" })
                                  .then((response) => {
                                      if (response.ok) {
                                          return cache.put(url, response);
                                      }
                                      console.warn(`[SW] Failed to cache external: ${url}`);
                                  })
                                  .catch((err) => {
                                      console.warn(`[SW] Error caching external ${url}:`, err);
                                  }),
                          ),
                      ),
                  ),
            // Create IndexedDB
            createIndexedDB(IDBConfig),
            // Open runtime cache
            caches.open(runtimeCache),
        ])
            .then(() => {
                console.log("[SW] Installation complete");
                return self.skipWaiting(); // Activate immediately
            })
            .catch((err) => console.error("[SW] Install error:", err)),
    );
};

// delete any outdated caches when the Service Worker is activated
const activateHandler = (e) => {
    console.log("[SW] Activating service worker v" + APP_VERSION);
    e.waitUntil(
        Promise.all([
            // Clean up old caches
            caches.keys().then((names) =>
                Promise.all(
                    names
                        .filter((name) => name !== cacheName && name !== runtimeCache)
                        .map((name) => {
                            console.log("[SW] Deleting old cache:", name);
                            return caches.delete(name);
                        }),
                ),
            ),
            // Take control of all clients immediately
            self.clients.claim(),
        ]).then(() => {
            console.log("[SW] Activation complete, controlling all clients");
        }),
    );
};

const cleanRedirect = async (response) => {
    const clonedResponse = response.clone();
    const { headers, status, statusText } = clonedResponse;

    return new Response(clonedResponse.body, {
        headers,
        status,
        statusText,
    });
};

const applyCoepHeaders = (response) => {
    if (!response || response.type === "opaque" || response.status === 0) {
        return response;
    }

    const clonedResponse = response.clone();
    const headers = new Headers(clonedResponse.headers);

    headers.set("Cross-Origin-Embedder-Policy", coepCredentialless ? "credentialless" : "require-corp");
    if (!coepCredentialless) {
        headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    }
    headers.set("Cross-Origin-Opener-Policy", "same-origin");

    return new Response(clonedResponse.body, {
        status: clonedResponse.status,
        statusText: clonedResponse.statusText,
        headers,
    });
};

const isAppShellRequest = (urlObj) => {
    const path = urlObj.pathname || "";
    if (path === "/" || path.endsWith("/index.html")) return true;
    if (path.endsWith("/sw.js") || path.endsWith("/threads.js") || path.endsWith("/manifest.webmanifest")) return true;
    if (path.includes("/src/")) return true;
    if (path.endsWith("/assets/rewards/trees/catalog.json")) return true;
    return false;
};

const fetchHandler = async (e) => {
    const { request } = e;
    const url = request.url;

    e.respondWith(
        (async () => {
            try {
                const urlObj = new URL(url);

                if (isOffline()) {
                    const cachedResponse = await caches.match(request, { ignoreVary: true, ignoreSearch: false });
                    if (cachedResponse) {
                        const normalized = cachedResponse.redirected
                            ? await cleanRedirect(cachedResponse)
                            : cachedResponse;
                        return applyCoepHeaders(normalized);
                    }

                    if (request.mode === "navigate") {
                        const offlinePage = await caches.match(resolvePath("/index.html"));
                        return applyCoepHeaders(offlinePage) || offlinePage;
                    }

                    return new Response("Offline", {
                        status: 503,
                        statusText: "Service Unavailable",
                        headers: { "Content-Type": "text/plain" },
                    });
                }

                // Never let the SW cache API calls. Await the request so the
                // outer handler can convert network/CORS rejections to a Response.
                if (urlObj.pathname === "/api" || urlObj.pathname.startsWith("/api/")) {
                    return await fetch(request);
                }

                if (request.cache === "no-store") {
                    return await fetch(request);
                }

                // Strategy 1: Network First for app shell assets to avoid stale UI.
                if (url.startsWith(self.location.origin) && request.method === "GET" && isAppShellRequest(urlObj)) {
                    try {
                        const fresh = await fetch(request, { cache: "no-store" });
                        if (fresh && fresh.ok) {
                            const cache = await caches.open(cacheName);
                            cache.put(request, fresh.clone());
                        }
                        return applyCoepHeaders(fresh);
                    } catch (err) {
                        const cachedResponse = await caches.match(request, { ignoreVary: true, ignoreSearch: false });
                        if (cachedResponse) {
                            const normalized = cachedResponse.redirected
                                ? await cleanRedirect(cachedResponse)
                                : cachedResponse;
                            return applyCoepHeaders(normalized);
                        }
                        throw err;
                    }
                }

                // Strategy 2: Cache First for local assets
                if (url.startsWith(self.location.origin)) {
                    const cachedResponse = await caches.match(request, { ignoreVary: true, ignoreSearch: false });
                    if (cachedResponse) {
                        const normalized = cachedResponse.redirected
                            ? await cleanRedirect(cachedResponse)
                            : cachedResponse;
                        return applyCoepHeaders(normalized);
                    }
                }

                // Strategy 3: Stale-While-Revalidate for external resources
                if (shouldCacheExternally(url)) {
                    const cache = await caches.open(runtimeCache);
                    const cachedResponse = await cache.match(request);

                    // Return cached version immediately
                    const fetchPromise = fetch(request, { mode: "cors" })
                        .then((response) => {
                            if (response.ok) {
                                cache.put(request, response.clone());
                            }
                            return applyCoepHeaders(response);
                        })
                        .catch((err) => {
                            console.warn("[SW] Failed to fetch external:", url, err);
                            // Always return a Response from respondWith()
                            return (
                                applyCoepHeaders(cachedResponse) ||
                                new Response("External resource unavailable", {
                                    status: 504,
                                    statusText: "Gateway Timeout",
                                    headers: { "Content-Type": "text/plain" },
                                })
                            );
                        });

                    // Return cached immediately if available, otherwise wait for network
                    return applyCoepHeaders(cachedResponse) || fetchPromise;
                }

                // Strategy 4: Network First for everything else
                try {
                    const fetchResponse = await fetch(request);

                    // Cache successful GET requests from external sources
                    if (fetchResponse.status === 200 && request.method === "GET" && shouldCacheExternally(url)) {
                        const cache = await caches.open(runtimeCache);
                        cache.put(request, fetchResponse.clone());
                    }

                    return applyCoepHeaders(fetchResponse);
                } catch (networkError) {
                    // Network failed, try cache as fallback
                    const cachedResponse = await caches.match(request);
                    if (cachedResponse) {
                        console.log("[SW] Serving from cache after network failure:", url);
                        return applyCoepHeaders(cachedResponse);
                    }

                    // Last resort: return offline page for navigation requests
                    if (request.mode === "navigate") {
                        const offlinePage = await caches.match(resolvePath("/index.html"));
                        return applyCoepHeaders(offlinePage) || offlinePage;
                    }

                    throw networkError;
                }
            } catch (err) {
                console.error("[SW] Fetch error:", err);
                if (request.mode === "navigate") {
                    const fallback = await caches.match(resolvePath("/index.html"));
                    if (fallback) return applyCoepHeaders(fallback) || fallback;
                }

                return new Response("Application Offline", {
                    status: 503,
                    statusText: "Service Unavailable",
                    headers: { "Content-Type": "text/plain" },
                });
            }
        })(),
    );
};

const messageHandler = async ({ data }) => {
    const { type } = data;
    switch (type) {
        case "SKIP_WAITING": {
            const clients = await self.clients.matchAll({
                includeUncontrolled: true,
            });
            if (clients.length < 2) {
                await self.skipWaiting();
                await self.clients.claim();
            }
            break;
        }
        case "PREPARE_CACHES_FOR_UPDATE": {
            await updateLastCache();
            break;
        }
        case "retry-requests": {
            if (isOffline()) {
                break;
            }
            if (!("sync" in self.registration)) {
                console.log("retry requests when Background Sync is not supported");
                await retryRequests();
            }
            break;
        }
        case "coepCredentialless": {
            coepCredentialless = Boolean(data.value);
            break;
        }
        case "deregister": {
            await self.registration.unregister();
            const clients = await self.clients.matchAll();
            clients.forEach((client) => client.navigate(client.url));
            break;
        }
    }
};

const syncHandler = async (e) => {
    if (isOffline()) return;
    console.log("sync event with tag:", e.tag);
    const { tag } = e;
    switch (tag) {
        case "retry-request":
            e.waitUntil(retryRequests());
            break;
    }
};

//╭─────────────────────────────────────╮
//│              Listener               │
//╰─────────────────────────────────────╯
self.addEventListener("install", installHandler);
self.addEventListener("activate", activateHandler);
self.addEventListener("fetch", fetchHandler);
self.addEventListener("message", messageHandler);
self.addEventListener("sync", syncHandler);
