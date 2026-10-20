const REQUEST_TIMEOUT_MS = 60000;
const ACTIVATION_TIMEOUT_MS = 120000;
const CLOSE_TIMEOUT_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 30000;

function abortError() {
    const error = new Error("Speech request cancelled");
    error.name = "AbortError";
    return error;
}

function serverError(message, code = "TTS_SERVER_UNAVAILABLE", status) {
    const error = new Error(message);
    error.code = code;
    if (status) error.status = status;
    return error;
}

function validLengthScale(value) {
    const scale = Number(value);
    if (!Number.isFinite(scale) || scale < 0.5 || scale > 2) {
        throw serverError("Invalid speech length scale", "TTS_INVALID_SETTINGS");
    }
    return scale;
}

function waitForConfiguration(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}

export class ServerTtsClient {
    constructor(app, options = {}) {
        this.app = app;
        this.availableVoices = null;
        this.capabilities = null;
        this.sessionId = null;
        this.voiceId = null;
        this.lengthScale = 1;
        this._session = null;
        this._generation = 0;
        this._controllers = new Set();
        this._configurationPromise = Promise.resolve();
        this._heartbeatTimer = null;
        this._heartbeatInFlight = false;
        this._modelRevision = null;
        this._supportedVoices = new Set();
        this._fetch = options.fetch || ((...args) => globalThis.fetch(...args));
        this._requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
        this._activationTimeoutMs = options.activationTimeoutMs ?? ACTIVATION_TIMEOUT_MS;
        this._closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
        this._heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    }

    get ready() {
        return !!this._session?.ready;
    }

    _connection() {
        const baseUrl = this.app.serverSync?.getServerUrl?.()?.replace(/\/$/, "");
        if (!baseUrl) throw serverError("No speech server configured");
        const token = this.app.serverSync?.server?._getAuthToken?.() || this.app.serverSync?._getAuthToken?.();
        if (!token) throw serverError("Sign in to use server speech", "TTS_SERVER_AUTH_REQUIRED", 401);
        return { baseUrl, token };
    }

    _assertActive(generation, signal) {
        if (generation !== this._generation || signal?.aborted) throw abortError();
    }

    async _request(path, {
        connection = this._session || this._connection(),
        method = "GET",
        body,
        signal,
        timeoutMs = this._requestTimeoutMs,
        binary = false,
        keepalive = false,
        track = true,
    } = {}) {
        if (signal?.aborted) throw abortError();
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        if (track) this._controllers.add(controller);
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        const headers = { Authorization: `Bearer ${connection.token}`, Accept: binary ? "audio/mpeg" : "application/json" };
        if (body !== undefined) headers["Content-Type"] = "application/json";

        try {
            const response = await this._fetch(`${connection.baseUrl}${path}`, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
                keepalive,
                cache: "no-store",
            });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw serverError(data.error || `Speech server returned ${response.status}`, data.code || "TTS_SERVER_ERROR", response.status);
            }
            if (!binary) return response.status === 204 ? {} : await response.json();
            const mimeType = (response.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
            if (mimeType !== "audio/mpeg") {
                throw serverError("Speech server returned an unsupported audio format", "TTS_SERVER_INVALID_AUDIO");
            }
            const encodedBuffer = await response.arrayBuffer();
            if (!encodedBuffer.byteLength) throw serverError("Speech server returned empty audio", "TTS_SERVER_INVALID_AUDIO");
            return { encodedBuffer, mimeType };
        } catch (error) {
            if (timedOut) throw serverError("Speech server timed out", "TTS_SERVER_TIMEOUT");
            if (controller.signal.aborted || signal?.aborted || error.name === "AbortError") throw abortError();
            if (error.code) throw error;
            throw serverError(error.message || "Unable to reach speech server");
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", onAbort);
            if (track) this._controllers.delete(controller);
        }
    }

    _queueConfiguration(operation) {
        const generation = this._generation;
        const task = this._configurationPromise.catch(() => {}).then(() => {
            this._assertActive(generation);
            return operation(generation);
        });
        this._configurationPromise = task;
        return task;
    }

    init({ voiceId, lengthScale = 1, modelRevision } = {}) {
        return this._queueConfiguration((generation) => this._initialize({ voiceId, lengthScale, modelRevision }, generation));
    }

    async _initialize({ voiceId, lengthScale, modelRevision }, generation) {
        const scale = validLengthScale(lengthScale);
        const expectedRevision = modelRevision || this._modelRevision;
        const connection = this._connection();
        if (this._session?.ready && this._session.baseUrl === connection.baseUrl && this._session.token === connection.token) {
            if (expectedRevision && expectedRevision !== (this.capabilities?.modelRevision || this.capabilities?.revision)) {
                throw serverError("Server voice models do not match this app", "TTS_MODEL_MISMATCH");
            }
            return this._configure({ voiceId, lengthScale: scale }, generation);
        }
        const capabilities = await this._request("/api/tts/capabilities", { connection });
        this._assertActive(generation);
        this.capabilities = capabilities;
        if (!capabilities.enabled) throw serverError("Server speech is unavailable", "TTS_SERVER_DISABLED");
        const revision = capabilities.modelRevision || capabilities.revision;
        if (expectedRevision && revision !== expectedRevision) {
            throw serverError("Server voice models do not match this app", "TTS_MODEL_MISMATCH");
        }
        this._modelRevision = expectedRevision || revision || null;
        this.availableVoices = Array.isArray(capabilities.voices)
            ? Object.fromEntries(capabilities.voices.map((id) => [id, { id }]))
            : capabilities.voices || {};
        this._supportedVoices = new Set(Object.keys(this.availableVoices));
        if (!this._supportedVoices.has(voiceId)) {
            throw serverError("The selected voice is unavailable on the server", "TTS_VOICE_UNAVAILABLE");
        }
        if (this._session) await this._deleteSession(this._session);
        this._assertActive(generation);
        const session = { ...connection, id: globalThis.crypto.randomUUID(), ready: false };
        this._session = session;
        this.sessionId = session.id;
        try {
            const data = await this._request("/api/tts/sessions", {
                connection: session,
                method: "POST",
                body: { id: session.id, voice: voiceId, lengthScale: scale, ...(expectedRevision ? { modelRevision: expectedRevision } : {}) },
                timeoutMs: this._activationTimeoutMs,
            });
            this._assertActive(generation);
            if (data.id !== session.id) throw serverError("Speech server returned an invalid session", "TTS_SESSION_MISMATCH");
            session.ready = true;
            this.voiceId = voiceId;
            this.lengthScale = scale;
            this._startHeartbeat();
            return data;
        } catch (error) {
            if (this._session === session) this._forgetSession();
            void this._deleteSession(session);
            throw error;
        }
    }

    configure({ voiceId, lengthScale = this.lengthScale } = {}) {
        return this._queueConfiguration((generation) => this._configure({ voiceId, lengthScale }, generation));
    }

    async _configure({ voiceId, lengthScale }, generation) {
        const scale = validLengthScale(lengthScale);
        const session = this._session;
        if (!session?.ready) return this._initialize({ voiceId, lengthScale: scale }, generation);
        if (!this._supportedVoices.has(voiceId)) {
            throw serverError("The selected voice is unavailable on the server", "TTS_VOICE_UNAVAILABLE");
        }
        if (this.voiceId === voiceId && this.lengthScale === scale) return { id: session.id, voice: voiceId };
        let data;
        try {
            data = await this._request(`/api/tts/sessions/${encodeURIComponent(session.id)}`, {
                connection: session,
                method: "PUT",
                body: { voice: voiceId, lengthScale: scale },
                timeoutMs: this._activationTimeoutMs,
            });
        } catch (error) {
            if ((error.status === 404 || error.status === 410) && this._session === session) this._forgetSession();
            throw error;
        }
        this._assertActive(generation);
        this.voiceId = voiceId;
        this.lengthScale = scale;
        return data;
    }

    async synthesize(text, lengthScale = this.lengthScale, _espeakVoice, { signal, createBlob = true } = {}) {
        const generation = this._generation;
        const configuration = this._configurationPromise;
        await waitForConfiguration(configuration, signal);
        this._assertActive(generation, signal);
        const session = this._session;
        if (!session?.ready) throw serverError("Speech session expired", "TTS_SESSION_EXPIRED", 404);
        const voice = this.voiceId;
        const scale = validLengthScale(lengthScale);
        let result;
        try {
            result = await this._request(`/api/tts/sessions/${encodeURIComponent(session.id)}/phrases`, {
                connection: session,
                method: "POST",
                body: { text, voice, lengthScale: scale },
                signal,
                binary: true,
            });
        } catch (error) {
            if ((error.status === 404 || error.status === 410) && this._session === session) this._forgetSession();
            throw error;
        }
        this._assertActive(generation, signal);
        if (createBlob) result.blob = new Blob([result.encodedBuffer], { type: result.mimeType });
        return result;
    }

    _startHeartbeat() {
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = setInterval(() => {
            const session = this._session;
            if (!session?.ready || this._heartbeatInFlight) return;
            this._heartbeatInFlight = true;
            this._request(`/api/tts/sessions/${encodeURIComponent(session.id)}/heartbeat`, {
                connection: session,
                method: "POST",
                timeoutMs: 10000,
            }).catch((error) => {
                if ((error.status === 404 || error.status === 410) && this._session === session) this._forgetSession();
            }).finally(() => {
                this._heartbeatInFlight = false;
            });
        }, this._heartbeatIntervalMs);
        this._heartbeatTimer.unref?.();
    }

    _forgetSession() {
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
        this._session = null;
        this.sessionId = null;
        this.voiceId = null;
    }

    async _deleteSession(session) {
        try {
            await this._request(`/api/tts/sessions/${encodeURIComponent(session.id)}`, {
                connection: session,
                method: "DELETE",
                timeoutMs: this._closeTimeoutMs,
                keepalive: true,
                track: false,
            });
            return true;
        } catch {
            // A lost phone connection is covered by the server's expiring lease.
            return false;
        }
    }

    async close() {
        this._generation += 1;
        for (const controller of this._controllers) controller.abort();
        const session = this._session;
        this._forgetSession();
        this._configurationPromise = Promise.resolve();
        if (session) await this._deleteSession(session);
    }
}
