export class ControlsManager {
    constructor(app) {
        this.app = app;
        this._cacheDOMElements();
        this._setupEventListeners();

        // internal
        this.isLocked = false;

        // stopwatch
        this.autoStopDuration = 15 * 60; // default 15 min in seconds
        this.timeLeft = this.autoStopDuration;
        this.timerInterval = null;

        this._updateTimerDisplay();
    }

    getPlaybarIcon() {
        return this.playIcon;
    }

    // Cache all used DOM nodes once
    _cacheDOMElements() {
        this.serverLinkInput = document.getElementById("server-link");
        this.voiceSelect = document.getElementById("voice-select");
        this.textWidthFitToggle = document.getElementById("toggle-text-width-fit");
        this.speedSelect = document.getElementById("reading-speed");
        this.speedSelectValue = document.getElementById("reading-speed-value");
        this.btnDecreaseSpeed = document.getElementById("btn-speed-decrease");
        this.btnIncreaseSpeed = document.getElementById("btn-speed-increase");
        this.readingReminderSection = document.getElementById("reading-reminder-section");
        this.readingReminderToggle = document.getElementById("reading-reminder-enabled");
        this.readingReminderTime = document.getElementById("reading-reminder-time");
        this.readingReminderStatus = document.getElementById("reading-reminder-status");
        this.readingDigestEmailSection = document.getElementById("reading-digest-email-section");
        this.readingDigestEmailToggle = document.getElementById("reading-digest-email");
        this.readingDigestEmailStatus = document.getElementById("reading-digest-email-status");

        this.btnNextSentence = document.getElementById("next-sentence");
        this.btnPrevSentence = document.getElementById("prev-sentence");
        this.btnPlayToggle = document.getElementById("play-toggle");
        this.btnNextPage = document.getElementById("next-page");
        this.btnPrevPage = document.getElementById("prev-page");
        this.bntHelp =
            document.getElementById("toogle-help") ||
            document.getElementById("toggle-help") ||
            document.getElementById("help-button");
        this.bntHelpClose = document.getElementById("help-close");
        this.bntFullScreen = document.getElementById("toggle-fullscreen");

        this.saveHighlightBtn = document.getElementById("save-highlight");
        this.saveCommentBtn = document.getElementById("save-comment");
        this.exportHighlightsBtn = document.getElementById("export-highlights");
        this.highlightColorButtons = Array.from(document.querySelectorAll(".highlight-color-option"));
        this.infoBox = document.getElementById("info-box");
        this.ttsStatus = document.getElementById("tts-status");
        this.overlayHelp = document.getElementById("help-overlay");
        this.controlsToolbar = document.getElementById("controls");
        this.lockBtn = document.getElementById("lock-screen");

        // Translate
        this.toggleTranslateBtn = document.getElementById("toggle-translate");

        // Read translation (use translated sentence for TTS)
        this.toggleReadTranslationBtn = document.getElementById("toggle-read-translation");

        // Original-language subtitles
        this.toggleOriginalSubtitlesBtn = document.getElementById("toggle-original-subtitles");

        // Default highlight color
        this.app.highlightManager?.setSelectedHighlightColor("#ffda76");
        const icon = this.saveHighlightBtn?.querySelector(".material-symbols-outlined");
        if (icon) {
            icon.style.color = "#ffda76";
        }

        // cache
        this.btnClearCache = document.getElementById("clear-cache-btn");

        // stopwatch
        this.autoStopInput = document.getElementById("stopwatch-input");
        this.btnDecreaseTimer = document.getElementById("btn-timer-decrease");
        this.btnIncreaseTimer = document.getElementById("btn-timer-increase");
        this.btnPlayTimer = document.getElementById("btn-timer-play");
        this.btnStopTimer = document.getElementById("btn-timer-stop");
    }

    _setupEventListeners() {
        const { app } = this;
        const on = (el, type, fn) => el && el.addEventListener(type, fn, { passive: true });
        const isAuthButton = (el) => {
            if (!el) return false;
            const label = (el.getAttribute("aria-label") || el.title || "").toLowerCase();
            return label.includes("login") || label.includes("account") || label.includes("auth");
        };
        const isTouchLikeDevice = () => {
            try {
                return (
                    (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
                    (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0)
                );
            } catch {
                return false;
            }
        };
        const stopAndResetAudio = () => {
            app.audioManager.stopPlayback(true);
            app.state.autoAdvanceActive = false;
            app.ttsQueue.reset();
        };

        // Basic controls
        on(this.btnNextSentence, "click", () => app.nextSentence(true));
        on(this.btnPrevSentence, "click", () => app.prevSentence(true));
        on(this.btnPlayToggle, "click", () => app.togglePlay());
        on(this.bntFullScreen, "click", () => this.toggleFullscreen());

        // Help overlay
        on(this.bntHelp, "click", () => this.showHelpOverlay());
        on(this.bntHelpClose, "click", () => this.hideHelpOverlay());
        on(this.overlayHelp, "click", (event) => {
            if (event.target === this.overlayHelp) this.hideHelpOverlay();
        });

        // Page navigation
        on(this.btnNextPage, "click", () => {
            stopAndResetAudio();
            app.nextPageNav();
        });
        on(this.btnPrevPage, "click", () => {
            stopAndResetAudio();
            app.prevPageNav();
        });

        // Highlights
        if (this.saveHighlightBtn) {
            const LONG_PRESS_MS = 350;
            let longPressTimer = null;
            let longPressTriggered = false;

            // Avoid text selection / callout on long-press (mobile).
            try {
                this.saveHighlightBtn.style.userSelect = "none";
                this.saveHighlightBtn.style.webkitUserSelect = "none";
                this.saveHighlightBtn.style.webkitTouchCallout = "none";
                this.saveHighlightBtn.style.touchAction = "manipulation";
            } catch {}

            const clearLongPress = () => {
                if (longPressTimer) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
            };

            const startLongPress = () => {
                longPressTriggered = false;
                clearLongPress();
                longPressTimer = setTimeout(() => {
                    longPressTriggered = true;
                    // Use current highlight configuration (selected color etc.)
                    app.saveCurrentSentenceHighlight?.();
                }, LONG_PRESS_MS);
            };

            // Touch-only long press.
            if ("PointerEvent" in window) {
                this.saveHighlightBtn.addEventListener(
                    "pointerdown",
                    (e) => {
                        if (!isTouchLikeDevice()) return;
                        if (e.pointerType && e.pointerType !== "touch" && e.pointerType !== "pen") return;
                        // Prevent long-press text selection / callout.
                        e.preventDefault();
                        startLongPress();
                    },
                    { passive: false },
                );
                this.saveHighlightBtn.addEventListener(
                    "pointerup",
                    () => {
                        if (!isTouchLikeDevice()) return;
                        clearLongPress();
                    },
                    { passive: true },
                );
                this.saveHighlightBtn.addEventListener(
                    "pointercancel",
                    () => {
                        if (!isTouchLikeDevice()) return;
                        clearLongPress();
                    },
                    { passive: true },
                );
            } else {
                // Fallback for older mobile browsers
                this.saveHighlightBtn.addEventListener(
                    "touchstart",
                    (e) => {
                        if (!isTouchLikeDevice()) return;
                        // Prevent long-press text selection / callout.
                        e.preventDefault();
                        startLongPress();
                    },
                    { passive: false },
                );
                this.saveHighlightBtn.addEventListener(
                    "touchend",
                    () => {
                        if (!isTouchLikeDevice()) return;
                        clearLongPress();
                    },
                    { passive: true },
                );
                this.saveHighlightBtn.addEventListener(
                    "touchcancel",
                    () => {
                        if (!isTouchLikeDevice()) return;
                        clearLongPress();
                    },
                    { passive: true },
                );
            }

            // Short tap opens the menu; long press applies highlight and suppresses the click.
            this.saveHighlightBtn.addEventListener(
                "click",
                (e) => {
                    if (isTouchLikeDevice() && longPressTriggered) {
                        e.preventDefault();
                        e.stopPropagation();
                        longPressTriggered = false;
                        return;
                    }
                    app.ui?.showHighlightPopup?.();
                },
                { passive: false },
            );
        }
        // Note: the toolbar "person" button is used for Login/Account in index.html
        // (it currently reuses id="save-comment"). Avoid also opening comment UI on click.
        if (this.saveCommentBtn && !isAuthButton(this.saveCommentBtn)) {
            on(this.saveCommentBtn, "click", () => app.highlightManager.editCurrentSentenceComment());
        }
        on(this.exportHighlightsBtn, "click", () => app.exportManager.exportPdfWithHighlights());

        // Translate toggle (auto translate every spoken sentence)
        if (this.toggleTranslateBtn) {
            // Initialize UI from persisted value (app will also load into state).
            const raw = localStorage.getItem("config.autoTranslate");
            const enabled = raw === "1" || raw === "true";
            this.reflectAutoTranslateToggle(enabled);

            on(this.toggleTranslateBtn, "click", () => {
                const next = !app.isAutoTranslateEnabled?.();
                app.setAutoTranslateEnabled?.(next);
                this.showInfo(next ? "Auto-translate: ON" : "Auto-translate: OFF", 1500);
            });
        }

        // Read translation toggle (replace spoken text with translated text)
        if (this.toggleReadTranslationBtn) {
            const raw = localStorage.getItem("config.readTranslation");
            const enabled = raw === "1" || raw === "true";
            this.reflectReadTranslationToggle(enabled);

            on(this.toggleReadTranslationBtn, "click", () => {
                const next = !app.isReadTranslationEnabled?.();
                app.setReadTranslationEnabled?.(next);
                this.showInfo(next ? "Read translation: ON" : "Read translation: OFF", 1500);
            });
        }

        // Original-language subtitles toggle
        if (this.toggleOriginalSubtitlesBtn) {
            const raw = localStorage.getItem("config.originalSubtitles");
            const enabled = raw === "1" || raw === "true";
            this.reflectOriginalSubtitlesToggle(enabled);

            on(this.toggleOriginalSubtitlesBtn, "click", () => {
                const next = !app.isOriginalSubtitlesEnabled?.();
                app.setOriginalSubtitlesEnabled?.(next);
                this.showInfo(next ? "Original subtitles: ON" : "Original subtitles: OFF", 1500);
            });
        }

        if (this.highlightColorButtons?.length) {
            this.highlightColorButtons.forEach((btn) => {
                btn.setAttribute("aria-pressed", "false");
                btn.setAttribute("role", "button");
                on(btn, "click", () => {
                    const color = btn.dataset.highlightColor;
                    if (!color) return;
                    app.highlightManager?.setSelectedHighlightColor(color);
                    const icon = this.saveHighlightBtn?.querySelector(".material-symbols-outlined");
                    if (icon) icon.style.color = color;
                    this.reflectSelectedHighlightColor();
                });
            });
        }

        // Voice and speed
        on(this.textWidthFitToggle, "click", () => {
            const next = !app.isTextWidthFitEnabled?.();
            app.setTextWidthFitEnabled?.(next);
            this.showInfo(next ? "Maximize reading text: ON" : "Maximize reading text: OFF", 1500);
        });

        on(this.voiceSelect, "change", () => {
            app.audioManager.stopPlayback(true);
            app.state.autoAdvanceActive = false;
            app.cache.clearAudioFrom(app.state.currentSentenceIndex);
            app.ttsEngine.schedulePrefetch();
        });

        if (this.speedSelect) {
            const updateSpeedDisplay = () => {
                const val = parseFloat(this.speedSelect.value);
                this.speedSelectValue.textContent = `${(isNaN(val) ? 1 : val).toFixed(1)}x`;
            };

            on(this.speedSelect, "input", updateSpeedDisplay);
            on(this.btnDecreaseSpeed, "click", () => this._adjustReadingSpeed(-1));
            on(this.btnIncreaseSpeed, "click", () => this._adjustReadingSpeed(1));

            on(this.speedSelect, "change", () => {
                const val = parseFloat(this.speedSelect.value);
                app.state.CURRENT_SPEED = Math.abs(isNaN(val) ? 1.0 : val - 2); // original logic preserved
                app.audioManager.stopPlayback(true);
                app.state.autoAdvanceActive = false;
                app.cache.clearAudioFrom(app.state.currentSentenceIndex);
                app.ttsEngine.schedulePrefetch();
                updateSpeedDisplay();
            });

            // Initialize display
            const initVal = parseFloat(this.speedSelect.value);
            this.speedSelectValue.textContent = `${(isNaN(initVal) ? 1 : initVal).toFixed(1)}x`;
        }

        // Keyboard shortcuts
        window.addEventListener(
            "keydown",
            (e) => {
                const tag = e.target?.tagName || "";
                if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;

                const actions = {
                    Space: () => {
                        e.preventDefault();
                        app.togglePlay();
                    },
                    ArrowRight: () => app.nextSentence(true),
                    ArrowLeft: () => app.prevSentence(true),
                    KeyH: () => app.saveCurrentSentenceHighlight(),
                    KeyC: async () => {
                        // Don't hijack common browser/system shortcuts like Ctrl+C / Cmd+C.
                        if (e.ctrlKey || e.metaKey || e.altKey) return;
                        e.preventDefault();
                        const didSelection = await app.interactionHandler?.promptCommentForSelection?.();
                        if (!didSelection) await app.highlightManager?.editCurrentSentenceComment?.();
                    },
                    KeyT: () => app.translateCurrentSentence?.(),
                    KeyF: () => this.toggleFullscreen(),
                    Digit1: () => this._selectHighlightIndex(0),
                    Digit2: () => this._selectHighlightIndex(1),
                    Digit3: () => this._selectHighlightIndex(2),
                    Digit4: () => this._selectHighlightIndex(3),
                };

                const fn = actions[e.code];
                if (fn) fn();
            },
            { passive: false },
        );

        // Persist progress on unload
        window.addEventListener("beforeunload", () => app.progressManager.saveProgress());
        this.reflectSelectedHighlightColor();

        // Orientation
        this.lockBtn.addEventListener("click", async () => {
            if (!screen.orientation || !screen.orientation.lock) {
                alert("API de orientação não suportada neste navegador.");
                return;
            }

            if (!document.fullscreenElement) {
                await this.toggleFullscreen();
            }

            this.lockBtn.classList.toggle("bg-primary/10");
            this.lockBtn.classList.toggle("text-primary");

            if (screen.orientation.lock) {
                if (!this.isLocked) {
                    try {
                        await screen.orientation.lock(screen.orientation.type);
                    } catch (e) {}
                    this.isLocked = true;
                } else {
                    try {
                        screen.orientation.unlock();
                    } catch (e) {}
                    this.isLocked = false;
                }
            }
        });

        // Handle orientation change: fit PDF to new container width
        this._orientationTimer = null;
        this._lastContainerWidth = null;
        this.orientationChange = this.orientationChange.bind(this);
        window.addEventListener("orientationchange", this.orientationChange, { passive: true });

        //
        on(this.btnClearCache, "click", () => {
            {
                const confirmed = confirm("Are you sure you want to clear all pdfs saved?");
                if (confirmed) {
                    this.app.progressManager.clearPDFCache();
                }
            }
        });

        // Stop Watch
        this.btnPlayTimer?.addEventListener("click", () => this._toggleTimer());
        this.btnStopTimer?.addEventListener("click", () => this._stopTimer());
        this.btnDecreaseTimer?.addEventListener("click", () => this._adjustTimerMinutes(-1));
        this.btnIncreaseTimer?.addEventListener("click", () => this._adjustTimerMinutes(1));
        this.autoStopInput?.addEventListener("change", (e) => {
            const minutes = this._parseTimerMinutes(e.target.value);
            if (minutes > 0) {
                this.autoStopDuration = minutes * 60;
                this.timeLeft = this.autoStopDuration;
            }
            this._updateTimerDisplay();
        });

        // Server Link Configuration
        if (this.serverLinkInput) {
            // Load saved server link from localStorage
            const savedServerLink = localStorage.getItem("config.serverLink");
            this.serverLinkInput.value = savedServerLink || this.getDefaultServerLink();
            // Save server link on change
            on(this.serverLinkInput, "change", () => {
                const serverLink = this.serverLinkInput.value.trim();
                if (serverLink) {
                    localStorage.setItem("config.serverLink", serverLink);
                    this.showInfo("Server link saved");
                } else {
                    localStorage.removeItem("config.serverLink");
                }
                void this.refreshReadingDigestPreference();
            });
        }

        this.readingReminderToggle?.addEventListener("change", () => {
            void this._saveReadingReminderPreference();
        });
        this.readingReminderTime?.addEventListener("change", () => {
            void this._saveReadingReminderPreference();
        });
        this.readingDigestEmailToggle?.addEventListener("change", () => {
            this._saveReadingDigestPreference(this.readingDigestEmailToggle.checked);
        });
    }

    _getBrowserTimezone() {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        } catch {
            return "UTC";
        }
    }

    async refreshReadingDigestPreference() {
        void this.refreshReadingReminderPreference();
        const toggle = this.readingDigestEmailToggle;
        const status = this.readingDigestEmailStatus;
        if (!toggle || !status) return;
        const hasServer = !!this.app.serverSync?.getServerUrl?.();
        if (this.readingDigestEmailSection) {
            this.readingDigestEmailSection.hidden = !hasServer;
        }
        if (!hasServer) {
            toggle.disabled = true;
            return;
        }
        const authenticated = hasServer && !!localStorage.getItem("localreaderAuthToken");
        if (!authenticated) {
            toggle.disabled = true;
            status.textContent = "Sign in to configure email summaries.";
            return;
        }

        toggle.disabled = true;
        status.textContent = "Loading email preference…";
        try {
            const preference = await this.app.serverSync.getReadingDigestPreference();
            toggle.checked = preference?.enabled !== false;
            const timezone = this._getBrowserTimezone();
            if (preference?.timezone !== timezone) {
                await this.app.serverSync.updateReadingDigestPreference(toggle.checked, timezone);
            }
            status.textContent = toggle.checked
                ? "Reading summary emails are enabled."
                : "Reading summary emails are turned off.";
            toggle.disabled = false;
        } catch (error) {
            toggle.disabled = true;
            status.textContent = "Email preference is unavailable.";
            console.warn("[ReadingDigest] Unable to load preference", error);
        }
    }

    async refreshReadingReminderPreference() {
        const toggle = this.readingReminderToggle;
        const time = this.readingReminderTime;
        const status = this.readingReminderStatus;
        if (!toggle || !time || !status) return;
        const hasServer = !!this.app.serverSync?.getServerUrl?.();
        this.readingReminderSection.hidden = !hasServer;
        toggle.disabled = time.disabled = true;
        this.readingReminderPreference = null;
        if (!hasServer || !localStorage.getItem("localreaderAuthToken")) {
            toggle.checked = false;
            status.textContent = "Sign in to configure reminders.";
            return;
        }
        status.textContent = "Loading reminders…";
        try {
            let preference = await this.app.serverSync.getReadingReminderPreference();
            const timezone = this._getBrowserTimezone();
            if (preference.enabled && preference.timezone !== timezone) {
                preference = await this.app.serverSync.updateReadingReminderPreference({ ...preference, timezone });
            }
            this._reflectReadingReminderPreference(preference);
            toggle.disabled = time.disabled = false;
        } catch (error) {
            status.textContent = "Reading reminders are unavailable.";
            console.warn("[ReadingReminder] Unable to load preference", error);
        }
    }

    _reflectReadingReminderPreference(preference) {
        this.readingReminderPreference = preference;
        this.readingReminderToggle.checked = preference.enabled;
        this.readingReminderTime.value = preference.time;
        this.readingReminderStatus.textContent = preference.enabled
            ? `Daily email at ${preference.time} (${preference.timezone}), if you haven't read.`
            : "Reading reminders are turned off.";
    }

    async _saveReadingReminderPreference() {
        const toggle = this.readingReminderToggle;
        const time = this.readingReminderTime;
        const previous = this.readingReminderPreference;
        if (!previous) return;
        if (!time.value || !time.checkValidity()) {
            time.reportValidity();
            this._reflectReadingReminderPreference(previous);
            return;
        }
        toggle.disabled = time.disabled = true;
        this.readingReminderStatus.textContent = "Saving reminder…";
        try {
            const preference = await this.app.serverSync.updateReadingReminderPreference({
                enabled: toggle.checked, time: time.value, timezone: this._getBrowserTimezone(),
            });
            this._reflectReadingReminderPreference(preference);
        } catch (error) {
            this._reflectReadingReminderPreference(previous);
            this.readingReminderStatus.textContent = "Unable to save reminder. Your previous setting is unchanged.";
            console.warn("[ReadingReminder] Unable to save preference", error);
        } finally {
            toggle.disabled = time.disabled = false;
        }
    }

    async _saveReadingDigestPreference(enabled) {
        const toggle = this.readingDigestEmailToggle;
        const status = this.readingDigestEmailStatus;
        if (!toggle || !status) return;
        toggle.disabled = true;
        status.textContent = "Saving email preference…";
        try {
            await this.app.serverSync.updateReadingDigestPreference(enabled, this._getBrowserTimezone());
            toggle.checked = !!enabled;
            status.textContent = enabled
                ? "Reading summary emails are enabled."
                : "Reading summary emails are turned off.";
            this.showInfo(enabled ? "Reading emails enabled" : "Reading emails turned off");
        } catch (error) {
            toggle.checked = !enabled;
            status.textContent = "Unable to save email preference.";
            console.warn("[ReadingDigest] Unable to save preference", error);
        } finally {
            toggle.disabled = false;
        }
    }

    reflectAutoTranslateToggle(enabled) {
        if (!this.toggleTranslateBtn) return;

        const active = !!enabled;
        this.toggleTranslateBtn.setAttribute("aria-pressed", active ? "true" : "false");

        // Match the styling used by other toggles (e.g. fullscreen).
        this.toggleTranslateBtn.classList.toggle("bg-primary/10", active);
        this.toggleTranslateBtn.classList.toggle("text-primary", active);
    }

    reflectReadTranslationToggle(enabled) {
        if (!this.toggleReadTranslationBtn) return;
        const active = !!enabled;
        this.toggleReadTranslationBtn.setAttribute("aria-pressed", active ? "true" : "false");
        this.toggleReadTranslationBtn.classList.toggle("bg-primary/10", active);
        this.toggleReadTranslationBtn.classList.toggle("text-primary", active);
    }

    reflectOriginalSubtitlesToggle(enabled) {
        if (!this.toggleOriginalSubtitlesBtn) return;
        const active = !!enabled;
        this.toggleOriginalSubtitlesBtn.setAttribute("aria-pressed", active ? "true" : "false");
        this.toggleOriginalSubtitlesBtn.title = active
            ? "Hide original-language subtitles"
            : "Show original-language subtitles";
        this.toggleOriginalSubtitlesBtn.setAttribute(
            "aria-label",
            active ? "Hide original-language subtitles" : "Show original-language subtitles",
        );
        this.toggleOriginalSubtitlesBtn.classList.toggle("bg-primary/10", active);
        this.toggleOriginalSubtitlesBtn.classList.toggle("text-primary", active);

        const icon = this.toggleOriginalSubtitlesBtn.querySelector(".material-symbols-outlined");
        if (icon) icon.textContent = active ? "subtitles" : "subtitles_off";
    }

    reflectTextWidthFitToggle(enabled) {
        if (!this.textWidthFitToggle) return;
        const active = !!enabled;
        this.textWidthFitToggle.setAttribute("aria-pressed", active ? "true" : "false");
        this.textWidthFitToggle.title = active
            ? "Restore full PDF page width"
            : "Maximize focused PDF text width";
        this.textWidthFitToggle.setAttribute("aria-label", this.textWidthFitToggle.title);
        this.textWidthFitToggle.classList.toggle("bg-primary/10", active);
        this.textWidthFitToggle.classList.toggle("text-primary", active);
        const icon = this.textWidthFitToggle.querySelector(".material-symbols-outlined");
        icon?.classList.toggle("text-primary", active);
        icon?.classList.toggle("text-slate-600", !active);
        icon?.classList.toggle("dark:text-slate-300", !active);
    }

    showHelpOverlay() {
        if (!this.overlayHelp) return;
        this.overlayHelp.classList.remove("hidden");
        this.overlayHelp.setAttribute("aria-hidden", "false");
    }

    hideHelpOverlay() {
        if (!this.overlayHelp) return;
        this.overlayHelp.classList.add("hidden");
        this.overlayHelp.setAttribute("aria-hidden", "true");
    }

    orientationChange() {
        if (this.isLocked) return; // don't alter layout when orientation is locked

        if (this._orientationTimer) clearTimeout(this._orientationTimer);
        this._orientationTimer = setTimeout(async () => {
            const { state, pdfRenderer } = this.app;
            if (!state?.pdf || !pdfRenderer) return;

            const container = document.getElementById("pdf-doc-container");
            const containerWidth = Math.max(1, container?.clientWidth || window.innerWidth);
            if (this._lastContainerWidth && Math.abs(containerWidth - this._lastContainerWidth) < 2) {
                // width didn't change meaningfully; skip work
                return;
            }
            this._lastContainerWidth = containerWidth;

            try {
                await pdfRenderer.refreshPdfRendering({ containerWidth, forceFullRescale: true });
            } catch (err) {
                console.warn("[orientationChange] Refresh failed", err);
            }
        }, 160);
    }

    _selectHighlightIndex = (index) => {
        const btn = this.highlightColorButtons?.[index];
        if (!btn) return;
        const color = btn.dataset.highlightColor;
        if (!color) return;
        this.app.highlightManager?.setSelectedHighlightColor(color);
        const icon = this.saveHighlightBtn?.querySelector(".material-symbols-outlined");
        if (icon) icon.style.color = color;
        this.reflectSelectedHighlightColor();
    };

    _adjustReadingSpeed(delta) {
        if (!this.speedSelect) return;

        const min = Number.parseFloat(this.speedSelect.min || "0.5");
        const max = Number.parseFloat(this.speedSelect.max || "2");
        const step = Number.parseFloat(this.speedSelect.step || "0.1");
        const current = Number.parseFloat(this.speedSelect.value || "1");

        const next = Math.min(max, Math.max(min, current + delta * step));
        this.speedSelect.value = next.toFixed(1);
        this.speedSelect.dispatchEvent(new Event("input", { bubbles: true }));
        this.speedSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }

    toggleCollapsedState() {
        if (!this.controlsToolbar) return;
        this.controlsToolbar.classList.toggle("toolbar--collapsed");
    }

    _isSmartphone() {
        try {
            const ua = navigator.userAgent || "";
            const smartphoneUA = /iPhone|iPod|Android.*Mobile|Windows Phone|BlackBerry|IEMobile|Opera Mini|Mobi/i.test(
                ua,
            );
            const narrowCoarsePointer =
                window.matchMedia?.("(pointer: coarse)")?.matches &&
                window.matchMedia?.("(max-width: 767px)")?.matches;
            return smartphoneUA || narrowCoarsePointer;
        } catch {
            return false;
        }
    }

    _getFullscreenElement(doc = document) {
        return doc.fullscreenElement || doc.mozFullScreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement;
    }

    async requestSmartphoneReaderLock() {
        if (!this._isSmartphone()) return;

        const doc = document;
        const docEl = doc.documentElement;
        const requestFull =
            docEl.requestFullscreen ||
            docEl.mozRequestFullScreen ||
            docEl.webkitRequestFullscreen ||
            docEl.msRequestFullscreen;

        if (!this._getFullscreenElement(doc) && requestFull) {
            try {
                await requestFull.call(docEl);
                this.bntFullScreen?.classList.add("bg-primary/10", "text-primary");
            } catch (err) {
                console.warn("[requestSmartphoneReaderLock] Fullscreen request failed", err);
            }
        }

        try {
            await this.enableWakeLock();
        } catch (err) {
            console.warn("[requestSmartphoneReaderLock] Wake lock request failed", err);
        }
    }

    async toggleFullscreen() {
        this.toggleCollapsedState();

        const doc = document;
        const docEl = doc.documentElement;
        const requestFull =
            docEl.requestFullscreen ||
            docEl.mozRequestFullScreen ||
            docEl.webkitRequestFullscreen ||
            docEl.msRequestFullscreen;
        const exitFull =
            doc.exitFullscreen || doc.mozCancelFullScreen || doc.webkitExitFullscreen || doc.msExitFullscreen;

        const isFull = this._getFullscreenElement(doc);

        try {
            if (!isFull) {
                await requestFull.call(docEl);
                await this.enableWakeLock();
                this.bntFullScreen.classList.add("bg-primary/10", "text-primary");
            } else {
                await exitFull.call(doc);
                this.disableWakeLock();
                this.bntFullScreen.classList.remove("bg-primary/10", "text-primary");
            }
        } catch (err) {
            console.warn("[toggleFullscreen] Fullscreen toggle failed", err);
        }

        this._lastContainerWidth = null;
        if (this.app?.pdfRenderer?.refreshPdfRendering) {
            try {
                await this.app.pdfRenderer.refreshPdfRendering({ forceFullRescale: true });
            } catch (err) {
                console.warn("[toggleFullscreen] Refresh failed", err);
            }
        }
    }

    async enableWakeLock() {
        if ("wakeLock" in navigator) {
            this.wakeLock = await navigator.wakeLock.request("screen");
            this.wakeLock.addEventListener("release", () => {});
        }
    }

    disableWakeLock() {
        if (this.wakeLock) {
            this.wakeLock.release();
            this.wakeLock = null;
        }
    }

    reflectSelectedHighlightColor() {
        if (!this.highlightColorButtons?.length) return;
        const selectedColor = this.app.state?.selectedHighlightColor;
        let activeButton =
            (selectedColor && this.highlightColorButtons.find((btn) => btn.dataset.highlightColor === selectedColor)) ||
            this.highlightColorButtons[0];

        this.highlightColorButtons.forEach((btn) => {
            const isActive = btn === activeButton;
            btn.classList.toggle("is-active", isActive);
            btn.setAttribute("aria-pressed", isActive ? "true" : "false");
        });
    }

    _toggleTimer() {
        const playIcon = this.btnPlayTimer?.querySelector("span");
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
            if (playIcon) playIcon.textContent = "play_arrow";
        } else {
            if (playIcon) playIcon.textContent = "pause";
            this.timerInterval = setInterval(() => {
                if (this.timeLeft > 0) {
                    this.timeLeft--;
                    this._updateTimerDisplay();
                } else {
                    this._stopTimer();
                    this.app.audioManager.stopPlayback(true);
                }
            }, 1000);
        }
    }

    _stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
            this.disableWakeLock();
        }
        this.timeLeft = this.autoStopDuration;
        this._updateTimerDisplay();
        if (this.btnPlayTimer) this.btnPlayTimer.querySelector("span").textContent = "play_arrow";
    }

    _parseTimerMinutes(value) {
        const raw = String(value || "").trim();
        if (!raw) return Math.max(1, Math.ceil(this.autoStopDuration / 60));
        const minutes = Number.parseInt(raw, 10);
        if (!Number.isFinite(minutes)) return Math.max(1, Math.ceil(this.autoStopDuration / 60));
        return Math.max(1, minutes);
    }

    _adjustTimerMinutes(delta) {
        const next = Math.max(60, this.autoStopDuration + delta * 60);
        this.autoStopDuration = next;
        this.timeLeft = next;
        this._updateTimerDisplay();
    }

    _updateTimerDisplay() {
        if (!this.autoStopInput) return;
        this.autoStopInput.value = String(Math.max(1, Math.ceil(this.timeLeft / 60)));
    }

    showInfo(message, duration = 2000) {
        if (!this.infoBox) return;
        this.infoBox.textContent = message;
        this.infoBox.classList.remove("hidden");
        setTimeout(() => this.infoBox.classList.add("hidden"), duration);
    }

    getDefaultServerLink() {
        try {
            if (window.location.protocol === "http:" || window.location.protocol === "https:") {
                return window.location.origin.replace(/\/$/, "");
            }
        } catch {
            // ignore
        }
        return "";
    }

    getServerLink() {
        const saved = localStorage.getItem("config.serverLink") || "";
        return saved.trim() || this.getDefaultServerLink();
    }
}
