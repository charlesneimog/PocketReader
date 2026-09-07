import { ServerSync } from "./serverSync.js";
import { GoogleDriveSync } from "./googleDriveSync.js";

export class SyncManager {
    constructor(app) {
        this.app = app;
        this.server = new ServerSync(app);
        this.drive = new GoogleDriveSync(app);
    }

    getBackend() {
        return localStorage.getItem("config.syncBackend") === "google-drive" ? "google-drive" : "server";
    }

    setBackend(backend) {
        this.stopAutoSync();
        const value = backend === "google-drive" ? "google-drive" : "server";
        localStorage.setItem("config.syncBackend", value);
        this.startAutoSync();
        return value;
    }

    get active() { return this.getBackend() === "google-drive" ? this.drive : this.server; }
    isEnabled() { return this.active.isEnabled(); }
    queuePositionSync(...args) { return this.active.queuePositionSync(...args); }
    queueVoiceSync(...args) { return this.active.queueVoiceSync(...args); }
    syncPosition(...args) { return this.active.syncPosition(...args); }
    syncVoice(...args) { return this.active.syncVoice(...args); }
    syncHighlights(...args) { return this.active.syncHighlights(...args); }
    syncTranslationSettings(...args) { return this.active.syncTranslationSettings(...args); }
    queueRewardsSync(...args) { return this.active.queueRewardsSync?.(...args); }
    syncRewards(...args) { return this.active.syncRewards?.(...args); }
    pullRewards(...args) { return this.active.pullRewards?.(...args); }
    loadPositionAndHighlightsFromServer(...args) { return this.active.loadPositionAndHighlightsFromServer(...args); }
    ensureFileOnServer(...args) { return this.active.ensureFileOnServer(...args); }
    pullServerStateUpdates(...args) { return this.active.pullServerStateUpdates(...args); }
    deleteFileOnServer(...args) { return this.active.deleteFileOnServer(...args); }
    checkServerAvailability(...args) { return this.active.checkServerAvailability(...args); }
    syncAll(...args) { return this.active.syncAll(...args); }
    syncFromServer(...args) { return this.active.syncFromServer(...args); }
    manualSync(...args) { return this.active.manualSync(...args); }

    startAutoSync() {
        this.server.stopAutoSync();
        this.drive.stopAutoSync();
        return this.active.startAutoSync();
    }

    stopAutoSync() {
        this.server.stopAutoSync();
        this.drive.stopAutoSync();
    }

    async listRemoteFiles() {
        if (this.getBackend() === "google-drive") return this.drive.listRemoteFiles();
        const data = await this.server.apiFetch("/api/files", { method: "GET", withAuth: true });
        const files = Array.isArray(data?.files) ? data.files : [];
        await this.server._purgeServerTombstones?.(files, { showMessages: true });
        return files;
    }

    getServerUrl(...args) { return this.server.getServerUrl(...args); }
    apiFetch(...args) { return this.server.apiFetch(...args); }
    authMe(...args) { return this.server.authMe(...args); }
    authLogin(...args) { return this.server.authLogin(...args); }
    authSignup(...args) { return this.server.authSignup(...args); }
    requestPasswordReset(...args) { return this.server.requestPasswordReset(...args); }
    resetPassword(...args) { return this.server.resetPassword(...args); }
    getReadingReminderPreference(...args) { return this.server.getReadingReminderPreference(...args); }
    updateReadingReminderPreference(...args) { return this.server.updateReadingReminderPreference(...args); }
    getReadingDigestPreference(...args) { return this.server.getReadingDigestPreference(...args); }
    updateReadingDigestPreference(...args) { return this.server.updateReadingDigestPreference(...args); }
    clearAuthToken(...args) { return this.server.clearAuthToken(...args); }
    pingServer(...args) { return this.server.pingServer(...args); }
    translateText(...args) { return this.server.translateText(...args); }
    checkTranslationAvailability(...args) { return this.server.checkTranslationAvailability(...args); }
    connectGoogleDrive(...args) { return this.drive.connect(...args); }
    disconnectGoogleDrive(...args) { return this.drive.disconnect(...args); }
    isGoogleDriveConnected() { return this.drive.isConnected(); }
    importGoogleDriveFolder(...args) { return this.drive.importConvertedFolder(...args); }
}
