export class ServerSync {
    constructor(app) {
        this.app = app;
        this.syncInterval = null;
        this.lastSyncTime = 0;
        this.isSyncing = false;

        // Gate background sync traffic behind one deduplicated availability
        // probe. When the configured server is offline, ordinary sync GET/POST
        // requests are skipped until the retry window expires or an explicit
        // focus/online probe succeeds.
        this.serverAvailabilityRetryMs = 30000;
        this._serverAvailable = null;
        this._lastServerAvailabilityCheck = 0;
        this._serverAvailabilityPromise = null;
        this._serverUnavailableNoticeShown = false;

        // Translation uses a session-level circuit breaker. Google is tried
        // initially; after its first failure, all later phrases go directly to
        // the server API instead of repeating a request known to be blocked.
        this._translationBackend = "google";

        this._autoSyncEnabled = false;
        this._autoSyncListeners = [];

        // Debounced client -> server updates
        this.positionSyncDebounceMs = 900;
        this.voiceSyncDebounceMs = 900;
        this._pendingPositionByFile = new Map();
        this._pendingVoiceByFile = new Map();
        this._positionSyncTimers = new Map();
        this._voiceSyncTimers = new Map();
        this._rewardsSyncTimer = null;

        // Throttle server -> client state pulls (position/highlights/voice)
        this.serverPullIntervalMs = 30000; // Check every 30 seconds
        this.lastServerPullCheck = 0;

        try {
            if (
                localStorage.getItem("config.syncBackend") !== "google-drive" &&
                localStorage.getItem("localreaderAuthToken")
            ) {
                this._ensureServerAvailable({ force: true }).catch(() => {});
            }
        } catch {
            // ignore
        }
    }

    _setReloadSuppressionWindow(ms = 15000) {
        // Some service-worker helpers (e.g. coi-serviceworker) may trigger reloads on certain
        // update/degrade events; avoid reloading while an API call is in flight.
        try {
            if (typeof window === "undefined") return;
            const suppressUntil = Date.now() + ms;
            window.__localreaderSuppressReloadUntil = Math.max(
                Number(window.__localreaderSuppressReloadUntil || 0),
                suppressUntil,
            );
        } catch {
            // ignore
        }
    }

    _setAuthToken(token) {
        try {
            const value = (token || "").toString();
            if (value) localStorage.setItem("localreaderAuthToken", value);
            else localStorage.removeItem("localreaderAuthToken");
        } catch {
            // ignore
        }
    }

    clearAuthToken() {
        this._setAuthToken("");
        this.stopAutoSync();
        this._clearPendingClientSync();
    }

    async apiFetch(
        path,
        { method = "GET", body = null, withAuth = true, skipAvailabilityGate = false } = {},
    ) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) throw new Error("No server URL configured");

        this._setReloadSuppressionWindow();

        const headers = { "Content-Type": "application/json" };
        const finalHeaders = withAuth ? this._withAuthHeaders(headers) : headers;

        const res = await this._fetch(`${serverUrl}${path}`, {
            method,
            headers: finalHeaders,
            body: body ? JSON.stringify(body) : undefined,
            skipAvailabilityGate,
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = data?.error || `${res.status} ${res.statusText}`;
            throw new Error(msg);
        }
        return data;
    }

    async authMe() {
        return await this.apiFetch("/api/auth/me", { method: "GET", withAuth: true });
    }

    async authLogin(email, password, { persistToken = true } = {}) {
        const data = await this.apiFetch("/api/auth/login", {
            method: "POST",
            body: { email, password },
            withAuth: false,
            skipAvailabilityGate: true,
        });
        if (persistToken && data?.token) this._setAuthToken(data.token);
        return data;
    }

    async authSignup(email, password, { persistToken = true } = {}) {
        const data = await this.apiFetch("/api/auth/signup", {
            method: "POST",
            body: { email, password },
            withAuth: false,
            skipAvailabilityGate: true,
        });
        if (persistToken && data?.token) this._setAuthToken(data.token);
        return data;
    }

    async requestPasswordReset(email) {
        return await this.apiFetch("/api/auth/request-password-reset", {
            method: "POST",
            body: { email },
            withAuth: false,
            skipAvailabilityGate: true,
        });
    }

    async resetPassword(email, token, newPassword, { persistToken = true } = {}) {
        const data = await this.apiFetch("/api/auth/reset-password", {
            method: "POST",
            body: { email, token, newPassword },
            withAuth: false,
            skipAvailabilityGate: true,
        });
        if (persistToken && data?.token) this._setAuthToken(data.token);
        return data;
    }

    async getReadingReminderPreference() {
        return await this.apiFetch("/api/reading-reminder-preferences", { method: "GET" });
    }

    async updateReadingReminderPreference(preference) {
        return await this.apiFetch("/api/reading-reminder-preferences", {
            method: "PUT", body: preference,
        });
    }

    async getReadingDigestPreference() {
        return await this.apiFetch("/api/reading-digest-preferences", {
            method: "GET",
            withAuth: true,
        });
    }

    async updateReadingDigestPreference(enabled, timezone) {
        return await this.apiFetch("/api/reading-digest-preferences", {
            method: "PUT",
            body: { enabled: !!enabled, timezone: timezone || "UTC" },
            withAuth: true,
        });
    }

    _getAuthToken() {
        try {
            return localStorage.getItem("localreaderAuthToken") || "";
        } catch {
            return "";
        }
    }

    _withAuthHeaders(headers = {}) {
        const token = this._getAuthToken();
        if (!token) return headers;
        return { ...headers, Authorization: `Bearer ${token}` };
    }

    _createServerUnavailableError(message = "Server is unavailable") {
        const error = new Error(message);
        error.name = "ServerUnavailableError";
        error.code = "SERVER_UNAVAILABLE";
        return error;
    }

    _isServerUnavailableError(error) {
        return error?.code === "SERVER_UNAVAILABLE" || error?.name === "ServerUnavailableError";
    }

    _logServerError(message, error, { level = "warn" } = {}) {
        if (this._isServerUnavailableError(error)) {
            if (!this._serverUnavailableNoticeShown) {
                this._serverUnavailableNoticeShown = true;
                console.warn("[ServerSync] Server unavailable; sync paused.");
            }
            return;
        }

        const logger = level === "error" ? console.error : console.warn;
        logger(message, error);
    }

    _markServerAvailability(available) {
        this._serverAvailable = !!available;
        this._lastServerAvailabilityCheck = Date.now();
        if (available) this._serverUnavailableNoticeShown = false;
    }

    async _ensureServerAvailable({ force = false, showMessages = false } = {}) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) return false;

        if (typeof navigator !== "undefined" && navigator.onLine === false) {
            this._markServerAvailability(false);
            return false;
        }

        const age = Date.now() - this._lastServerAvailabilityCheck;
        if (!force && this._serverAvailable !== null && age < this.serverAvailabilityRetryMs) {
            return this._serverAvailable;
        }

        if (this._serverAvailabilityPromise) return this._serverAvailabilityPromise;

        this._serverAvailabilityPromise = this.pingServer(showMessages)
            .catch(() => false)
            .finally(() => {
                this._serverAvailabilityPromise = null;
            });
        return this._serverAvailabilityPromise;
    }

    async _fetch(url, options = {}) {
        const { skipAvailabilityGate = false, ...fetchOptions } = options;
        if (!skipAvailabilityGate) {
            const available = await this._ensureServerAvailable();
            if (!available) {
                const error = this._createServerUnavailableError();
                this._logServerError("", error);
                throw error;
            }
        }

        const headers = this._withAuthHeaders(fetchOptions.headers || {});
        try {
            const response = await fetch(url, { ...fetchOptions, headers });
            this._markServerAvailability(true);
            return response;
        } catch (error) {
            this._markServerAvailability(false);
            const unavailableError = this._createServerUnavailableError(error?.message || "Server is unavailable");
            this._logServerError("", unavailableError);
            throw unavailableError;
        }
    }

    _addAutoSyncListener(element, type, handler, options) {
        element.addEventListener(type, handler, options);
        this._autoSyncListeners.push({ element, type, handler, options });
    }

    _clearAutoSyncListeners() {
        for (const { element, type, handler, options } of this._autoSyncListeners) {
            element.removeEventListener(type, handler, options);
        }
        this._autoSyncListeners = [];
    }

    _clearPendingClientSync() {
        for (const timer of this._positionSyncTimers.values()) clearTimeout(timer);
        for (const timer of this._voiceSyncTimers.values()) clearTimeout(timer);
        this._positionSyncTimers.clear();
        this._voiceSyncTimers.clear();
        this._pendingPositionByFile.clear();
        this._pendingVoiceByFile.clear();
        if (this._rewardsSyncTimer) clearTimeout(this._rewardsSyncTimer);
        this._rewardsSyncTimer = null;
    }

    queueRewardsSync(snapshot, { debounceMs = 1000 } = {}) {
        if (!this.isEnabled() || !snapshot) return;
        if (this._rewardsSyncTimer) clearTimeout(this._rewardsSyncTimer);
        this._rewardsSyncTimer = setTimeout(() => {
            this._rewardsSyncTimer = null;
            this.syncRewards(snapshot).catch((error) => {
                this._logServerError("[ServerSync] Reward sync failed:", error);
            });
        }, debounceMs);
    }

    async pullRewards() {
        if (!this.isEnabled()) return null;
        const data = await this.apiFetch("/api/rewards", { method: "GET", withAuth: true });
        if (data?.snapshot) return await this.app.rewards?.mergeRemote?.(data.snapshot);
        return null;
    }

    async syncRewards(snapshot = this.app.rewards?.getSyncSnapshot?.()) {
        if (!this.isEnabled() || !snapshot) return false;
        let merged = snapshot;
        try {
            const remote = await this.apiFetch("/api/rewards", { method: "GET", withAuth: true });
            if (remote?.snapshot) {
                await this.app.rewards?.mergeRemote?.(remote.snapshot);
                merged = this.app.rewards?.getSyncSnapshot?.() || snapshot;
            }
        } catch (error) {
            if (!/404/.test(String(error?.message))) throw error;
        }
        await this.apiFetch("/api/rewards", {
            method: "PUT",
            body: { snapshot: merged },
            withAuth: true,
        });
        return true;
    }

    getServerUrl() {
        const serverLink = this.app.controlsManager?.getServerLink();
        return serverLink ? serverLink.replace(/\/$/, "") : null;
    }

    isEnabled() {
        return !!this.getServerUrl() && !!this._getAuthToken();
    }

    _parseIsoToMs(value) {
        if (!value || typeof value !== "string") return 0;
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? ms : 0;
    }

    _extractActualFilename(key) {
        if (typeof key !== "string") return key;
        if (!key.startsWith("file::")) return key;
        const parts = key.split("::");
        const name = parts.length >= 2 ? parts[1] : key;
        return this._normalizeActualFilename(name);
    }

    _normalizeActualFilename(name) {
        if (typeof name !== "string") return "";
        return name
            .replace(/[\r\n\t]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    _sanitizeFileIdForUrl(fileId) {
        if (typeof fileId !== "string") return "";
        // Avoid control characters in URL paths (often blocked by proxies / WAFs).
        // Keep semantics intact: only normalize whitespace/control chars.
        return fileId
            .replace(/[\u0000-\u001F\u007F]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    _encodeFileIdForUrl(fileId) {
        const safe = this._sanitizeFileIdForUrl(fileId);
        return encodeURIComponent(safe);
    }

    _parseFileKeyParts(key) {
        if (typeof key !== "string") return null;
        if (!key.startsWith("file::")) return null;
        const parts = key.split("::");
        if (parts.length < 4) return null;
        const name = parts[1] ?? "";
        const sizeRaw = Number(parts[2] ?? 0);
        const lastModifiedRaw = Number(parts[3] ?? 0);
        const size = Number.isFinite(sizeRaw) ? sizeRaw : 0;
        const lastModified = Number.isFinite(lastModifiedRaw) ? lastModifiedRaw : 0;
        return { name, size, lastModified };
    }

    async _purgeLocalByActualFilename(actualFilename, docTypeHint) {
        const actual = this._normalizeActualFilename((actualFilename || "").toString());
        if (!actual) return 0;

        const docType = docTypeHint === "epub" ? "epub" : "pdf";
        let removed = 0;

        try {
            const keys =
                docType === "epub"
                    ? await this.app.progressManager.listSavedEPUBs()
                    : await this.app.progressManager.listSavedPDFs();

            const matching = keys.filter((k) => this._extractActualFilename(k) === actual);
            for (const k of matching) {
                if (docType === "epub") {
                    this.app.progressManager.clearEpubProgress(k);
                    this.app.highlightsStorage?.clearPdfHighlights?.(k);
                    await this.app.progressManager.removeEpubFromIndexedDB(k);
                } else {
                    this.app.progressManager.clearPdfProgress(k);
                    this.app.highlightsStorage?.clearPdfHighlights?.(k);
                    await this.app.progressManager.removePdfFromIndexedDB(k);
                }
                removed++;
            }
        } catch (e) {
            this._logServerError("[ServerSync] Failed to purge local copies by actual filename:", e);
        }

        return removed;
    }

    async _purgeServerTombstones(serverFiles, { showMessages = false } = {}) {
        if (!Array.isArray(serverFiles) || serverFiles.length === 0) return 0;

        let removed = 0;
        const tombstones = serverFiles.filter((f) => f && f.deleted);
        for (const t of tombstones) {
            const actualName = this._extractActualFilename(t.filename);
            if (!actualName) continue;

            const docType = t.format === "epub" ? "epub" : "pdf";
            const count = await this._purgeLocalByActualFilename(actualName, docType);
            removed += count;

            if (showMessages && count > 0) {
                this.app.ui?.showInfo?.(`Removed deleted file: ${actualName}`);
            }
        }

        return removed;
    }

    async _maybePullServerStateUpdates() {
        const now = Date.now();
        if (now - this.lastServerPullCheck < this.serverPullIntervalMs) return;
        this.lastServerPullCheck = now;

        const serverAvailable = await this.checkServerAvailability();
        if (!serverAvailable) return;

        await this.pullServerStateUpdates();
    }

    queuePositionSync(fileId, sentenceIndex, { debounceMs } = {}) {
        if (!this.isEnabled()) return;
        if (!fileId) return;
        if (!Number.isFinite(sentenceIndex) || sentenceIndex < 0) return;

        this._pendingPositionByFile.set(fileId, sentenceIndex);

        const delay = Number.isFinite(debounceMs) ? debounceMs : this.positionSyncDebounceMs;
        const existing = this._positionSyncTimers.get(fileId);
        if (existing) clearTimeout(existing);

        const t = setTimeout(() => {
            this._positionSyncTimers.delete(fileId);
            if (!this.isEnabled()) return;
            const latest = this._pendingPositionByFile.get(fileId);
            if (!Number.isFinite(latest)) return;
            this.syncPosition(fileId, latest).catch((err) => {
                console.warn("[ServerSync] Position sync failed:", err);
            });
        }, delay);
        this._positionSyncTimers.set(fileId, t);
    }

    queueVoiceSync(fileId, voice, { debounceMs } = {}) {
        if (!this.isEnabled()) return;
        if (!fileId) return;
        if (typeof voice !== "string" || !voice.trim()) return;

        this._pendingVoiceByFile.set(fileId, voice.trim());

        const delay = Number.isFinite(debounceMs) ? debounceMs : this.voiceSyncDebounceMs;
        const existing = this._voiceSyncTimers.get(fileId);
        if (existing) clearTimeout(existing);

        const t = setTimeout(() => {
            this._voiceSyncTimers.delete(fileId);
            if (!this.isEnabled()) return;
            const latest = this._pendingVoiceByFile.get(fileId);
            if (typeof latest !== "string" || !latest.trim()) return;
            this.syncVoice(fileId, latest.trim()).catch((err) => {
                console.warn("[ServerSync] Voice sync failed:", err);
            });
        }, delay);
        this._voiceSyncTimers.set(fileId, t);
    }

    async pullServerStateUpdates() {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) return;

        try {
            const response = await this._fetch(`${serverUrl}/api/files`, {
                method: "GET",
                headers: { "Content-Type": "application/json" },
            });

            if (!response.ok) {
                console.warn("[ServerSync] Failed to fetch server files for state sync");
                return;
            }

            const data = await response.json();
            const serverFiles = data.files || [];

            // Server tombstones (deleted/excluded) should purge local copies, not be downloaded.
            await this._purgeServerTombstones(serverFiles, { showMessages: true });

            const [localPdfKeys, localEpubKeys] = await Promise.all([
                this.app.progressManager.listSavedPDFs(),
                this.app.progressManager.listSavedEPUBs(),
            ]);
            const allLocalKeys = [...localPdfKeys, ...localEpubKeys];

            // Map actual filename -> local key for matching when timestamps differ.
            const localByActualName = new Map();
            for (const k of allLocalKeys) {
                const actual = this._extractActualFilename(k);
                if (!localByActualName.has(actual)) localByActualName.set(actual, k);
            }

            const progressMap = this.app.progressManager.getProgressMap();

            let updatedCount = 0;
            for (const fileInfo of serverFiles) {
                if (fileInfo && fileInfo.deleted) continue;

                const serverKey = fileInfo.filename;
                const actualName = this._extractActualFilename(serverKey);

                // Find local key: exact match first, else match by actual filename.
                const localKey = allLocalKeys.includes(serverKey) ? serverKey : localByActualName.get(actualName);
                if (!localKey) continue;

                const docType = fileInfo.format === "epub" ? "epub" : "pdf";

                const compoundKey = `${docType}::${localKey}`;
                const localEntry = progressMap[compoundKey] || {};

                const serverPosMs = this._parseIsoToMs(fileInfo.position_updated_at || fileInfo.updated_at);
                const serverHlMs = this._parseIsoToMs(fileInfo.highlights_updated_at || fileInfo.updated_at);
                const serverVoiceMs = this._parseIsoToMs(fileInfo.voice_updated_at || fileInfo.updated_at);
                const serverTranslationMs = this._parseIsoToMs(fileInfo.translation_updated_at || fileInfo.updated_at);

                const localServerPosMs = Number(localEntry.serverPositionUpdatedAt || 0);
                const localServerHlMs = Number(localEntry.serverHighlightsUpdatedAt || 0);
                const localServerVoiceMs = Number(localEntry.serverVoiceUpdatedAt || 0);
                const localServerTranslationMs = Number(localEntry.serverTranslationUpdatedAt || 0);

                // Position: if server has newer position than last pulled, update local.
                if (serverPosMs > localServerPosMs) {
                    const pos = fileInfo.reading_position != null ? parseInt(fileInfo.reading_position, 10) : null;
                    if (Number.isFinite(pos) && pos >= 0) {
                        localEntry.sentenceIndex = pos;
                        // Use server timestamp so "last timed sync" matches server.
                        localEntry.updated = serverPosMs;
                    }
                    localEntry.serverPositionUpdatedAt = serverPosMs;
                    updatedCount++;
                }

                // Voice: if newer.
                if (serverVoiceMs > localServerVoiceMs) {
                    if (typeof fileInfo.voice === "string" && fileInfo.voice.trim()) {
                        localEntry.voice = fileInfo.voice.trim();
                    }
                    localEntry.serverVoiceUpdatedAt = serverVoiceMs;
                    updatedCount++;
                }

                // Translation settings: if newer.
                if (serverTranslationMs > localServerTranslationMs) {
                    if (typeof fileInfo.translation_target === "string" && fileInfo.translation_target.trim()) {
                        localEntry.translationTarget = fileInfo.translation_target.trim();
                    }
                    if (typeof fileInfo.translation_mode === "string" && fileInfo.translation_mode.trim()) {
                        localEntry.translationMode = fileInfo.translation_mode.trim();
                    }
                    localEntry.serverTranslationUpdatedAt = serverTranslationMs;
                    updatedCount++;
                }

                // Title: keep if server provides.
                if (typeof fileInfo.title === "string" && fileInfo.title.trim()) {
                    localEntry.title = fileInfo.title.trim();
                }
                localEntry.docType = docType;

                // Highlights: only fetch when highlights timestamp advanced.
                if (serverHlMs > localServerHlMs) {
                    try {
                        const hlResp = await this._fetch(
                            `${serverUrl}/api/files/${this._encodeFileIdForUrl(serverKey)}/highlights`,
                            { method: "GET", headers: { "Content-Type": "application/json" } },
                        );
                        if (hlResp.ok) {
                            const hlData = await hlResp.json();
                            if (hlData?.highlights && Array.isArray(hlData.highlights)) {
                                const highlightsMap = new Map();
                                for (const h of hlData.highlights) {
                                    const idx = h?.sentence_index ?? h?.sentenceIndex;
                                    const sentenceIndex = typeof idx === "number" ? idx : parseInt(idx, 10);
                                    if (Number.isFinite(sentenceIndex)) {
                                        highlightsMap.set(sentenceIndex, {
                                            pageIndex: h.page_index ?? h.pageIndex,
                                            wordStart: h.word_start ?? h.wordStart,
                                            words: h.words,
                                            color: h.color,
                                            text: h.text || "",
                                            comment: typeof h.comment === "string" ? h.comment : "",
                                            annotationId: h.annotation_id ?? h.annotationId,
                                            phraseSplitVersion:
                                                h.phrase_split_version ?? h.phraseSplitVersion,
                                        });
                                    }
                                }
                                // Save under the local key we will open with.
                                this.app.highlightsStorage?.saveHighlights?.(localKey, highlightsMap);
                            }
                        }
                    } catch (e) {
                        this._logServerError("[ServerSync] Failed to pull highlights:", e);
                    }
                    localEntry.serverHighlightsUpdatedAt = serverHlMs;
                    updatedCount++;
                }

                progressMap[compoundKey] = localEntry;
            }

            this.app.progressManager.setProgressMap(progressMap);
        } catch (e) {
            this._logServerError("[ServerSync] pullServerStateUpdates failed:", e);
        }
    }

    async deleteFileOnServer(fileId) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl || !fileId) return false;

        try {
            const response = await this._fetch(`${serverUrl}/api/files/${this._encodeFileIdForUrl(fileId)}`, {
                method: "DELETE",
            });

            if (response.ok) return true;
            const data = await response.json().catch(() => ({}));
            const msg = data?.error || `${response.status} ${response.statusText}`;
            throw new Error(msg);
        } catch (e) {
            this._logServerError("[ServerSync] Failed to delete file on server:", e);
            return false;
        }
    }

    async checkServerAvailability() {
        return await this._ensureServerAvailable({ force: true });
    }

    async pingServer(showMessages = true) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) {
            const msg = "No server URL configured";
            console.error("[ServerSync] Ping failed:", msg);
            if (showMessages) {
                this.app.ui?.showInfo?.("❌ Ping failed: No server URL configured");
            }
            return false;
        }

        let timeoutId = null;
        try {
            const controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort(), 5000);

            const startTime = Date.now();
            const response = await this._fetch(`${serverUrl}/api/ping`, {
                method: "GET",
                signal: controller.signal,
                skipAvailabilityGate: true,
            });

            const pingTime = Date.now() - startTime;

            if (response.ok) {
                const data = await response.json();
                // console.log(`[ServerSync] ✓ Ping successful (${pingTime}ms):`, data.message);
                if (showMessages) {
                    //this.app.ui?.showInfo?.(`✓ Server is accessible (${pingTime}ms)`);
                    console.log(`[ServerSync] ✓ Ping successful (${pingTime}ms):`, data.message);
                }
                return true;
            } else {
                this._markServerAvailability(false);
                const msg = `Server returned ${response.status} ${response.statusText}`;
                this._logServerError("", this._createServerUnavailableError(msg));
                if (showMessages) {
                    this.app.ui?.showInfo?.(`❌ Ping failed: ${msg}`);
                }
                return false;
            }
        } catch (error) {
            this._markServerAvailability(false);
            let errorMsg = error.message;
            if (error.name === "AbortError") {
                errorMsg = "Connection timeout (server not responding)";
            }
            this._logServerError("[ServerSync] Ping failed:", error, { level: "error" });
            if (showMessages) {
                this.app.ui?.showInfo?.(`❌ Ping failed: ${errorMsg}`);
            }
            return false;
        } finally {
            if (timeoutId !== null) clearTimeout(timeoutId);
        }
    }

    _resolveTranslationTarget(target) {
        const explicitTarget = typeof target === "string" ? target.trim() : "";
        if (explicitTarget) return explicitTarget.replace(/_/g, "-");

        try {
            const savedTarget = (localStorage.getItem("config.translationTarget") || "").trim();
            if (savedTarget) return savedTarget.replace(/_/g, "-");
        } catch {
            // ignore localStorage access failures
        }

        return "pt";
    }

    async _translateTextWithGoogle(text, { target = null, signal = null } = {}) {
        const payloadText = (text || "").trim();
        if (!payloadText) return null;

        const targetLang = this._resolveTranslationTarget(target);
        const url =
            "https://translate.googleapis.com/translate_a/single" +
            `?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(payloadText)}`;

        const res = await fetch(url, signal ? { signal } : undefined);
        if (!res.ok) return null;

        const data = await res.json().catch(() => null);
        const chunks = Array.isArray(data?.[0]) ? data[0] : [];
        const translatedText = chunks
            .map((chunk) => (Array.isArray(chunk) && typeof chunk[0] === "string" ? chunk[0] : ""))
            .join("")
            .trim();

        if (!translatedText) return null;

        return {
            translatedText,
            target: targetLang,
            detectedSource: typeof data?.[2] === "string" ? data[2] : "",
        };
    }

    async translateText(text, { target = null, silent = false, signal = null } = {}) {
        const payloadText = (text || "").trim();
        if (!payloadText) return null;
        const effectiveTarget = this._resolveTranslationTarget(target);

        if (this._translationBackend !== "server") {
            try {
                const googleResult = await this._translateTextWithGoogle(payloadText, {
                    target: effectiveTarget,
                    signal,
                });
                if (googleResult?.translatedText) return googleResult;
            } catch (error) {
                console.debug("[Translation] Google request failed", error);
            }

            this._translationBackend = "server";
            console.info("[Translation] Google unavailable; using server API for the rest of this session");
        }

        const serverUrl = this.getServerUrl();
        if (!serverUrl) {
            console.warn("[Translation] Google returned no translation and no server URL is configured");
            return null;
        }

        try {
            const response = await this._fetch(`${serverUrl}/api/translate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: payloadText, target: effectiveTarget }),
                ...(signal ? { signal } : {}),
                // The translation request is itself an availability probe. Do
                // not let a stale background-sync health result suppress it.
                skipAvailabilityGate: true,
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                const msg = data?.error || `Translate failed: ${response.status} ${response.statusText}`;
                console.warn("[Translation] Server fallback rejected the request", {
                    status: response.status,
                    statusText: response.statusText,
                    message: msg,
                });
                if (!silent) this.app.ui?.showInfo?.(msg);
                return null;
            }
            if (data?.translatedText) {
                console.debug("[Translation] Server fallback succeeded");
            }
            return data;
        } catch (e) {
            console.warn("[Translation] Server fallback request failed", e);
            if (!silent) this.app.ui?.showInfo?.("⚠️ Translate request failed");
            return null;
        }
    }

    async checkTranslationAvailability(target = "en", { timeoutMs = 5000 } = {}) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const result = await this.translateText("ok", {
                target,
                silent: true,
                signal: controller.signal,
            });
            return !!result?.translatedText;
        } catch {
            return false;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async checkFileExists(fileId) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) return false;

        try {
            const response = await this._fetch(`${serverUrl}/api/files/${fileId}`, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                },
            });

            return response.ok;
        } catch (error) {
            this._logServerError("[ServerSync] Failed to check if file exists:", error);
            return false;
        }
    }

    async uploadFile(file, fileId, format, voice = null) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) {
            console.warn("[ServerSync] No server URL configured");
            return false;
        }

        try {
            const { state } = this.app;
            const title = state.bookTitle || file.name || "Untitled";

            const formData = new FormData();
            formData.append("file", file);
            formData.append("file_id", fileId);
            formData.append("title", title);
            formData.append("format", format);
            if (voice) {
                formData.append("voice", voice);
            }

            const response = await this._fetch(`${serverUrl}/api/files`, {
                method: "POST",
                body: formData,
            });

            if (response.ok) {
                const result = await response.json();
                // console.log("[ServerSync] File uploaded successfully:", result);
                this.app.ui?.showInfo?.("File synced to server");
                return true;
            } else {
                if (response.status === 410) {
                    const actualName = this._extractActualFilename(fileId);
                    const docType = format === "epub" ? "epub" : "pdf";
                    await this._purgeLocalByActualFilename(actualName, docType);
                    this.app.ui?.showInfo?.(`Server has deleted: ${actualName}`);
                    return false;
                }

                const errorText = await response.text();
                console.error("[ServerSync] Upload failed:", errorText);
                this.app.ui?.showInfo?.("Failed to sync file to server");
                return false;
            }
        } catch (error) {
            this._logServerError("[ServerSync] Upload error:", error, { level: "error" });
            if (!this._isServerUnavailableError(error)) {
                this.app.ui?.showInfo?.("Error syncing file to server");
            }
            return false;
        }
    }

    async syncPosition(fileId, sentenceIndex) {
        const serverUrl = this.getServerUrl();
        if (!this.isEnabled() || !serverUrl || !fileId || sentenceIndex < 0) return false;

        try {
            // Find the actual file_id on server (may have different timestamp)
            let actualFileIdOnServer = await this.findFileIdOnServer(fileId);
            if (!actualFileIdOnServer) {
                if (this._serverAvailable === false) return false;
                console.warn("[ServerSync] File not found on server for position sync; trying ensureFileOnServer()");
                try {
                    await this.ensureFileOnServer();
                } catch (e) {
                    // ignore
                }
                actualFileIdOnServer = await this.findFileIdOnServer(fileId);
                if (!actualFileIdOnServer) {
                    return false;
                }
            }

            const response = await this._fetch(
                `${serverUrl}/api/files/${this._encodeFileIdForUrl(actualFileIdOnServer)}/position`,
                {
                    method: "PUT",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        position: sentenceIndex.toString(),
                    }),
                },
            );

            if (response.ok) {
                //console.log("[ServerSync] Position synced:", sentenceIndex);
                return true;
            } else {
                console.warn("[ServerSync] Position sync failed:", response.statusText);
                return false;
            }
        } catch (error) {
            this._logServerError("[ServerSync] Position sync error:", error);
            return false;
        }
    }

    async syncVoice(fileId, voice) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl || !fileId || !voice) return false;

        try {
            // Find the actual file_id on server (may have different timestamp)
            let actualFileIdOnServer = await this.findFileIdOnServer(fileId);
            if (!actualFileIdOnServer) {
                if (this._serverAvailable === false) return false;
                console.warn("[ServerSync] File not found on server for voice sync; trying ensureFileOnServer()");
                try {
                    await this.ensureFileOnServer();
                } catch (e) {
                    // ignore
                }
                actualFileIdOnServer = await this.findFileIdOnServer(fileId);
                if (!actualFileIdOnServer) {
                    return false;
                }
            }

            const response = await this._fetch(
                `${serverUrl}/api/files/${this._encodeFileIdForUrl(actualFileIdOnServer)}/voice`,
                {
                    method: "PUT",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        voice: voice,
                    }),
                },
            );

            if (response.ok) {
                //// console.log("[ServerSync] Voice synced:", voice);
                return true;
            } else {
                console.warn("[ServerSync] Voice sync failed:", response.statusText);
                return false;
            }
        } catch (error) {
            this._logServerError("[ServerSync] Voice sync error:", error);
            return false;
        }
    }

    async syncTranslationSettings(fileId, { target, mode } = {}) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl || !fileId) return false;

        const modeValue = String(mode || "")
            .trim()
            .toLowerCase();
        if (!modeValue || !["read", "show", "off"].includes(modeValue)) return false;
        const targetValue = String(target || "").trim() || "pt";

        try {
            // Find the actual file_id on server (may have different timestamp)
            let actualFileIdOnServer = await this.findFileIdOnServer(fileId);
            if (!actualFileIdOnServer) {
                console.warn(
                    "[ServerSync] File not found on server for translation settings sync; trying ensureFileOnServer()",
                );
                try {
                    await this.ensureFileOnServer();
                } catch (e) {
                    // ignore
                }
                actualFileIdOnServer = await this.findFileIdOnServer(fileId);
                if (!actualFileIdOnServer) {
                    console.warn("[ServerSync] Still no matching file on server; translation settings not synced", {
                        fileId,
                    });
                    return false;
                }
            }

            const response = await this._fetch(
                `${serverUrl}/api/files/${this._encodeFileIdForUrl(actualFileIdOnServer)}/translation-settings`,
                {
                    method: "PUT",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        target: targetValue,
                        mode: modeValue,
                    }),
                },
            );

            return !!response.ok;
        } catch (error) {
            this._logServerError("[ServerSync] Translation settings sync error:", error);
            return false;
        }
    }

    async syncHighlights(fileId, highlights) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl || !fileId) return false;

        //console.log("[ServerSync] syncHighlights: start", {
        //    fileId,
        //    serverUrl,
        //    count: highlights?.size ?? 0,
        //});

        try {
            // Find the actual file_id on server (may have different timestamp)
            let actualFileIdOnServer = await this.findFileIdOnServer(fileId);
            if (!actualFileIdOnServer) {
                console.warn("[ServerSync] File not found on server for highlights sync; trying ensureFileOnServer()");
                try {
                    await this.ensureFileOnServer();
                } catch (e) {
                    // ignore
                }
                actualFileIdOnServer = await this.findFileIdOnServer(fileId);
                if (!actualFileIdOnServer) {
                    console.warn("[ServerSync] Still no matching file on server; highlights not synced", { fileId });
                    return false;
                }
            }

            const highlightsArray = [];
            for (const [sentenceIndex, data] of highlights.entries()) {
                highlightsArray.push({
                    sentenceIndex,
                    pageIndex: data.pageIndex,
                    wordStart: data.wordStart,
                    words: data.words,
                    color: data.color || "#ffda76",
                    text: data.text || data.sentenceText || "",
                    comment: typeof data.comment === "string" ? data.comment : "",
                    annotationId: data.annotationId,
                    phraseSplitVersion: data.phraseSplitVersion,
                });
            }

            const response = await this._fetch(
                `${serverUrl}/api/files/${this._encodeFileIdForUrl(actualFileIdOnServer)}/highlights`,
                {
                    method: "PUT",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        highlights: highlightsArray,
                    }),
                },
            );

            if (response.ok) {
                // console.log("[ServerSync] syncHighlights: OK", {
                //    fileId,
                //    actualFileIdOnServer,
                //    count: highlightsArray.length,
                //});
                return true;
            } else {
                console.warn("[ServerSync] syncHighlights: FAILED", {
                    status: response.status,
                    statusText: response.statusText,
                    fileId,
                    actualFileIdOnServer,
                });
                return false;
            }
        } catch (error) {
            this._logServerError("[ServerSync] Highlights sync error:", error);
            return false;
        }
    }

    async loadPositionAndHighlightsFromServer(fileId) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl || !fileId) {
            // console.log("[ServerSync] Cannot load from server - no URL or file ID");
            return { position: null, voice: null, highlights: null, translationTarget: null, translationMode: null };
        }

        try {
            // Find the actual file_id on server (may have different timestamp)
            const actualFileIdOnServer = await this.findFileIdOnServer(fileId);
            if (!actualFileIdOnServer) {
                // console.log("[ServerSync] File not found on server");
                return {
                    position: null,
                    voice: null,
                    highlights: null,
                    translationTarget: null,
                    translationMode: null,
                };
            }

            // Fetch file metadata (includes position and voice)
            const metaResponse = await this._fetch(
                `${serverUrl}/api/files/${this._encodeFileIdForUrl(actualFileIdOnServer)}`,
                {
                    method: "GET",
                    headers: { "Content-Type": "application/json" },
                },
            );

            let position = null;
            let voice = null;
            let translationTarget = null;
            let translationMode = null;

            if (metaResponse.ok) {
                const fileData = await metaResponse.json();
                position = fileData.reading_position ? parseInt(fileData.reading_position, 10) : null;
                voice = fileData.voice || null;
                translationTarget = (fileData.translation_target || "").trim() || null;
                translationMode = (fileData.translation_mode || "").trim() || null;
                // console.log(`[ServerSync] Loaded from server - position: ${position}, voice: ${voice}`);
            }

            // Fetch highlights
            const highlightsResponse = await this._fetch(
                `${serverUrl}/api/files/${this._encodeFileIdForUrl(actualFileIdOnServer)}/highlights`,
                {
                    method: "GET",
                    headers: { "Content-Type": "application/json" },
                },
            );

            let highlights = null;
            if (highlightsResponse.ok) {
                const highlightsData = await highlightsResponse.json();
                if (highlightsData.highlights && Array.isArray(highlightsData.highlights)) {
                    highlights = new Map();
                    highlightsData.highlights.forEach((h) => {
                        const idxRaw = h?.sentence_index ?? h?.sentenceIndex;
                        const idx = Number.isFinite(idxRaw) ? idxRaw : parseInt(String(idxRaw), 10);
                        if (!Number.isFinite(idx) || idx < 0) return;
                        highlights.set(idx, {
                            pageIndex: h?.page_index ?? h?.pageIndex,
                            wordStart: h?.word_start ?? h?.wordStart,
                            words: h?.words,
                            color: h?.color,
                            text: h?.text || "",
                            comment: typeof h?.comment === "string" ? h.comment : "",
                            annotationId: h?.annotation_id ?? h?.annotationId,
                            phraseSplitVersion: h?.phrase_split_version ?? h?.phraseSplitVersion,
                        });
                    });
                    // console.log(`[ServerSync] Loaded ${highlights.size} highlights from server`);
                }
            }

            return { position, voice, highlights, translationTarget, translationMode };
        } catch (error) {
            this._logServerError("[ServerSync] Failed to load data from server:", error);
            return { position: null, voice: null, highlights: null, translationTarget: null, translationMode: null };
        }
    }

    async findFileIdOnServer(localFileId) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) return null;

        // Extract actual filename from local file ID
        let actualFilename = localFileId;
        if (localFileId.startsWith("file::")) {
            const parts = localFileId.split("::");
            if (parts.length >= 2) {
                actualFilename = parts[1];
            }
        }
        actualFilename = this._normalizeActualFilename(actualFilename);

        try {
            const response = await this._fetch(`${serverUrl}/api/files`, {
                method: "GET",
                headers: { "Content-Type": "application/json" },
            });

            if (response.ok) {
                const data = await response.json();
                const serverFiles = data.files || [];

                // Find file by matching actual filename
                const matchingFile = serverFiles.find((f) => {
                    if (f && f.deleted) return false;
                    if (f.filename === localFileId) return true; // Exact match

                    // Check if actual filenames match
                    let serverActualName = f.filename;
                    if (f.filename.startsWith("file::")) {
                        const parts = f.filename.split("::");
                        if (parts.length >= 2) {
                            serverActualName = parts[1];
                        }
                    }
                    return this._normalizeActualFilename(serverActualName) === actualFilename;
                });

                return matchingFile ? matchingFile.filename : null;
            }
        } catch (error) {
            this._logServerError("[ServerSync] Failed to find file on server:", error);
        }

        return null;
    }

    async ensureFileOnServer() {
        const { state } = this.app;
        if (!this.isEnabled()) return false;

        const docType = state.currentDocumentType;
        if (!docType) return false;

        const fileId = docType === "epub" ? state.currentEpubKey : state.currentPdfKey;
        if (!fileId) return false;

        // Extract actual filename for existence check
        let actualFilename = fileId;
        if (fileId.startsWith("file::")) {
            const parts = fileId.split("::");
            if (parts.length >= 2) {
                actualFilename = parts[1];
            }
        }
        actualFilename = this._normalizeActualFilename(actualFilename);

        // First check if a file with the same actual filename already exists
        const serverUrl = this.getServerUrl();
        try {
            const response = await this._fetch(`${serverUrl}/api/files`, {
                method: "GET",
                headers: { "Content-Type": "application/json" },
            });

            if (response.ok) {
                const data = await response.json();
                const serverFiles = data.files || [];

                // Check if any server file matches the actual filename
                const existingFile = serverFiles.find((f) => {
                    if (f && f.deleted) return false;
                    if (f.filename === fileId) return true; // Exact match

                    // Check if actual filenames match
                    let serverActualName = f.filename;
                    if (f.filename.startsWith("file::")) {
                        const parts = f.filename.split("::");
                        if (parts.length >= 2) {
                            serverActualName = parts[1];
                        }
                    }
                    return this._normalizeActualFilename(serverActualName) === actualFilename;
                });

                if (existingFile) {
                    // console.log("[ServerSync] File with same name already exists on server:", existingFile.filename);
                    return true;
                }
            }
        } catch (error) {
            this._logServerError("[ServerSync] Failed to check for existing files:", error);
        }

        // File doesn't exist, upload it
        // console.log("[ServerSync] File not on server, uploading...");

        try {
            let file = null;
            const format = docType === "epub" ? "epub" : "pdf";

            // Try to get file from IndexedDB
            if (docType === "epub") {
                const record = await this.app.progressManager.loadEpubFromIndexedDB(fileId);
                file = record?.blob;
            } else {
                const record = await this.app.progressManager.loadPdfFromIndexedDB(fileId);
                file = record?.blob;
            }

            // Fallback 1: if the active document was opened from a File object, use it.
            if (!file && docType === "pdf") {
                const desc = state.currentPdfDescriptor;
                const candidate = desc?.type === "file" ? desc.fileObject : null;
                if (candidate instanceof Blob) {
                    file = candidate;
                    // Best-effort repair so future syncs can find it.
                    try {
                        await this.app.progressManager.savePdfToIndexedDB(file, fileId);
                    } catch {
                        // ignore
                    }
                }
            }

            // Fallback 2: the current key might point to progress/highlights, but the blob may be stored
            // under a sibling key (same filename+size, different timestamp). Try to locate it.
            if (!file && fileId.startsWith("file::")) {
                const target = this._parseFileKeyParts(fileId);
                if (target?.name && target.size > 0) {
                    const keys =
                        docType === "epub"
                            ? await this.app.progressManager.listSavedEPUBs()
                            : await this.app.progressManager.listSavedPDFs();

                    const candidates = keys.filter((k) => {
                        const p = this._parseFileKeyParts(k);
                        return p && p.name === target.name && p.size === target.size;
                    });

                    for (const k of candidates) {
                        try {
                            const record =
                                docType === "epub"
                                    ? await this.app.progressManager.loadEpubFromIndexedDB(k)
                                    : await this.app.progressManager.loadPdfFromIndexedDB(k);
                            if (record?.blob) {
                                file = record.blob;
                                // Best-effort repair for the active key.
                                if (k !== fileId && docType === "pdf") {
                                    try {
                                        await this.app.progressManager.savePdfToIndexedDB(file, fileId);
                                    } catch {
                                        // ignore
                                    }
                                }
                                break;
                            }
                        } catch {
                            // ignore and keep trying
                        }
                    }
                }
            }

            if (!file) {
                console.warn("[ServerSync] Cannot upload file - missing local blob", { fileId });
                return false;
            }

            const voice = state.currentPiperVoice;
            return await this.uploadFile(file, fileId, format, voice);
        } catch (error) {
            this._logServerError("[ServerSync] Error uploading file:", error, { level: "error" });
            return false;
        }
    }

    async syncAll() {
        if (this.isSyncing || !this.isEnabled()) return;

        const { state } = this.app;
        const docType = state.currentDocumentType;
        if (!docType) return;

        const fileId = docType === "epub" ? state.currentEpubKey : state.currentPdfKey;
        if (!fileId) return;

        this.isSyncing = true;

        try {
            // Ensure file is on server
            const fileOnServer = await this.ensureFileOnServer();
            if (!fileOnServer) {
                console.warn("[ServerSync] File not on server, skipping sync");
                this.isSyncing = false;
                return;
            }

            // Sync position
            if (state.currentSentenceIndex >= 0) {
                await this.syncPosition(fileId, state.currentSentenceIndex);
            }

            // Sync voice
            if (state.currentPiperVoice) {
                await this.syncVoice(fileId, state.currentPiperVoice);
            }

            // Sync highlights
            if (state.savedHighlights && state.savedHighlights.size > 0) {
                await this.syncHighlights(fileId, state.savedHighlights);
            }
            await this.syncRewards();

            this.lastSyncTime = Date.now();
        } catch (error) {
            this._logServerError("[ServerSync] Sync error:", error, { level: "error" });
        } finally {
            this.isSyncing = false;
        }
    }

    startAutoSync() {
        this.stopAutoSync();

        if (!this.isEnabled()) {
            // console.log("[ServerSync] Auto-sync disabled - no server configured");
            return;
        }
        this._autoSyncEnabled = true;

        const onWake = async () => {
            if (!this._autoSyncEnabled) return;
            await this._maybePullServerStateUpdates();
            await this.pullRewards();
            // Keep downloads up to date when the app regains focus/network.
            await this.syncFromServer();
        };

        // When the app becomes active again, do a lightweight pull + download.
        this._addAutoSyncListener(window, "focus", () => {
            onWake().catch(() => {});
        });
        this._addAutoSyncListener(window, "online", () => {
            onWake().catch(() => {});
        });
        this._addAutoSyncListener(document, "visibilitychange", () => {
            if (document.visibilityState === "visible") {
                onWake().catch(() => {});
            }
        });

        // Do initial sync: check server availability, pull server state (position/highlights), download books.
        setTimeout(async () => {
            const serverAvailable = await this.checkServerAvailability();

            if (serverAvailable) {
                // console.log("[ServerSync] Server is accessible, downloading books...");
                await this.pullServerStateUpdates();
                await this.pullRewards();
                await this.syncFromServer();
            } else {
                console.warn("[ServerSync] Server is not accessible");
            }
        }, 600);
    }

    stopAutoSync() {
        this._autoSyncEnabled = false;
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
        this._clearAutoSyncListeners();
        // console.log("[ServerSync] Auto-sync stopped");
    }

    async manualSync() {
        this.app.ui?.showInfo?.("Syncing to server...");
        await this.syncAll();
        await this.pullRewards();
        if (this.lastSyncTime > 0) {
            this.app.ui?.showInfo?.("Sync complete");
        }
    }

    async syncFromServer() {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) {
            return;
        }

        try {
            // Get list of files from server
            const response = await this._fetch(`${serverUrl}/api/files`, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                },
            });

            if (!response.ok) {
                console.warn("[ServerSync] Failed to fetch file list from server");
                return;
            }

            const data = await response.json();
            const serverFiles = data.files || [];
            const purgedCount = await this._purgeServerTombstones(serverFiles, { showMessages: true });

            // Get local files
            const localPdfKeys = await this.app.progressManager.listSavedPDFs();
            const localEpubKeys = await this.app.progressManager.listSavedEPUBs();
            const allLocalKeys = [...localPdfKeys, ...localEpubKeys];

            // Extract actual filenames from local keys
            const localActualFilenames = new Set();
            for (const key of allLocalKeys) {
                let actualName = key;
                if (key.startsWith("file::")) {
                    const parts = key.split("::");
                    if (parts.length >= 2) {
                        actualName = parts[1];
                    }
                }
                localActualFilenames.add(this._normalizeActualFilename(actualName));
            }

            // Find missing files by comparing actual filenames
            const missingFiles = serverFiles
                .filter((f) => f && !f.deleted)
                .filter((f) => {
                    let serverActualName = f.filename;
                    if (f.filename.startsWith("file::")) {
                        const parts = f.filename.split("::");
                        if (parts.length >= 2) {
                            serverActualName = parts[1];
                        }
                    }
                    return !localActualFilenames.has(this._normalizeActualFilename(serverActualName));
                });

            if (missingFiles.length === 0) {
                // console.log("[ServerSync] All server files are already cached locally");
                //this.app.ui?.showInfo?.("Already synced with server");
                if (purgedCount > 0) {
                    setTimeout(() => {
                        try {
                            if (typeof this.app.showSavedPDFs === "function") {
                                this.app.showSavedPDFs();
                            } else if (
                                this.app.pdfThumbnailCache &&
                                typeof this.app.pdfThumbnailCache.showSavedPDFs === "function"
                            ) {
                                this.app.pdfThumbnailCache.showSavedPDFs();
                            }
                        } catch (error) {
                            this._logServerError("[ServerSync] Failed to refresh library view:", error, {
                                level: "error",
                            });
                        }
                    }, 100);
                }
                return;
            }

            // console.log(`[ServerSync] Downloading ${missingFiles.length} missing files...`);
            this.app.ui?.showInfo?.(`Downloading ${missingFiles.length} files from server...`);

            // Download each missing file
            let downloaded = 0;
            for (const fileInfo of missingFiles) {
                try {
                    const ok = await this.downloadFile(fileInfo);
                    if (ok) {
                        downloaded++;
                        this.app.ui?.showInfo?.(`Downloaded ${downloaded}/${missingFiles.length} files`);
                    }
                } catch (error) {
                    this._logServerError(`[ServerSync] Failed to download ${fileInfo.filename}:`, error, {
                        level: "error",
                    });
                }
            }

            if (downloaded > 0 || purgedCount > 0) {
                if (downloaded > 0) {
                    this.app.ui?.showInfo?.(`Downloaded ${downloaded} files from server`);
                }
                // console.log(`[ServerSync] Download complete: ${downloaded}/${missingFiles.length} files`);

                // Refresh the saved PDFs view to show new downloads
                // console.log("[ServerSync] Refreshing library view with new downloads");
                // console.log("[ServerSync] Current document type:", this.app.state.currentDocumentType);
                // console.log("[ServerSync] App methods available:", {
                //showSavedPDFs: typeof this.app.showSavedPDFs,
                // pdfThumbnailCache: typeof this.app.pdfThumbnailCache,
                // showSavedPDFsOnCache: this.app.pdfThumbnailCache ? typeof this.app.pdfThumbnailCache.showSavedPDFs : 'undefined'
                // });

                setTimeout(() => {
                    try {
                        // console.log("[ServerSync] Attempting to refresh library...");

                        // Try to refresh the library view
                        if (typeof this.app.showSavedPDFs === "function") {
                            // console.log("[ServerSync] Calling app.showSavedPDFs()");
                            this.app.showSavedPDFs();
                        } else if (
                            this.app.pdfThumbnailCache &&
                            typeof this.app.pdfThumbnailCache.showSavedPDFs === "function"
                        ) {
                            // console.log("[ServerSync] Calling pdfThumbnailCache.showSavedPDFs()");
                            this.app.pdfThumbnailCache.showSavedPDFs();
                        } else {
                            console.warn("[ServerSync] No method found to refresh library view");
                        }

                        // console.log("[ServerSync] Library view refresh initiated");
                    } catch (error) {
                        this._logServerError("[ServerSync] Failed to refresh library view:", error, {
                            level: "error",
                        });
                        console.error("[ServerSync] Error details:", {
                            name: error.name,
                            message: error.message,
                            stack: error.stack,
                        });
                    }
                }, 1000);
            }
        } catch (error) {
            this._logServerError("[ServerSync] Sync from server failed:", error, { level: "error" });
            if (!this._isServerUnavailableError(error)) {
                this.app.ui?.showInfo?.("Failed to sync from server");
            }
        }
    }

    async downloadFile(fileInfo) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) return false;

        const { filename, title, format, reading_position, voice } = fileInfo;
        const safeFileId = this._sanitizeFileIdForUrl(filename);

        // Extract actual filename from file_id format (file::actualname::size::timestamp)
        let actualFilename = filename;
        if (filename.startsWith("file::")) {
            const parts = filename.split("::");
            if (parts.length >= 2) {
                actualFilename = parts[1]; // Get the actual filename without prefix
            }
        }
        actualFilename = this._normalizeActualFilename(actualFilename);

        // Download file blob
        const response = await this._fetch(`${serverUrl}/api/files/${this._encodeFileIdForUrl(safeFileId)}/download`, {
            method: "GET",
        });

        if (!response.ok) {
            if (response.status === 410) {
                const docType = format === "epub" ? "epub" : "pdf";
                await this._purgeLocalByActualFilename(actualFilename, docType);
                // Not an error: the server intentionally removed/excluded this file.
                return false;
            }

            if (response.status === 404) {
                console.warn("[ServerSync] File not found on server; skipping download", { filename });
                return false;
            }

            const details = await response.text().catch(() => "");
            throw new Error(`Download failed (${response.status}): ${details || response.statusText}`);
        }

        const blob = await response.blob();

        // Create a proper File object with correct type and name
        const fileType = format === "pdf" ? "application/pdf" : "application/epub+zip";
        const file = new File([blob], actualFilename, { type: fileType });

        // Save to IndexedDB using the full filename key from server.
        // Avoid duplicates: if it already exists under this key, don't save again.
        if (format === "pdf") {
            const existing = await this.app.progressManager.loadPdfFromIndexedDB(safeFileId);
            if (!existing) {
                await this.app.progressManager.savePdfToIndexedDB(file, safeFileId);
            }
        } else if (format === "epub") {
            const existing = await this.app.progressManager.loadEpubFromIndexedDB(safeFileId);
            if (!existing) {
                await this.app.progressManager.saveEpubToIndexedDB(file, safeFileId);
            }
        }

        // Restore progress if available
        const progressMap = this.app.progressManager.getProgressMap();
        const docType = format === "epub" ? "epub" : "pdf";
        const compoundKey = `${docType}::${safeFileId}`;

        progressMap[compoundKey] = {
            sentenceIndex: parseInt(reading_position, 10) || 0,
            updated: Date.now(),
            voice: voice || null,
            title: title || actualFilename,
            docType: docType,
        };

        this.app.progressManager.setProgressMap(progressMap);

        // Pull highlights from server and persist locally so the device has an offline copy
        // without needing to open the document.
        try {
            const highlightsResponse = await this._fetch(
                `${serverUrl}/api/files/${this._encodeFileIdForUrl(safeFileId)}/highlights`,
                { method: "GET", headers: { "Content-Type": "application/json" } },
            );
            if (highlightsResponse.ok) {
                const highlightsData = await highlightsResponse.json();
                if (highlightsData?.highlights && Array.isArray(highlightsData.highlights)) {
                    const highlightsMap = new Map();
                    for (const h of highlightsData.highlights) {
                        if (h && Number.isFinite(h.sentenceIndex)) {
                            highlightsMap.set(h.sentenceIndex, {
                                pageIndex: h.page_index ?? h.pageIndex,
                                wordStart: h.word_start ?? h.wordStart,
                                words: h.words,
                                color: h.color,
                                text: h.text || "",
                                comment: typeof h.comment === "string" ? h.comment : "",
                                annotationId: h.annotation_id ?? h.annotationId,
                                phraseSplitVersion: h.phrase_split_version ?? h.phraseSplitVersion,
                            });
                        }
                    }
                    this.app.highlightsStorage?.saveHighlights?.(safeFileId, highlightsMap);
                }
            }
        } catch (e) {
            this._logServerError("[ServerSync] Failed to fetch/save highlights:", e);
        }

        // console.log(`[ServerSync] Downloaded and cached: ${actualFilename}`);

        return true;
    }
}
