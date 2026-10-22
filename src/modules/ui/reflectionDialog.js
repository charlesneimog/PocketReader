import { copyReadingText, readingTextFromPhrases } from "./readingTextClipboard.js";

export class ReflectionDialog {
    constructor({ minimumCharacters, onSave, onSaved }) {
        this.minimumCharacters = minimumCharacters;
        this.onSave = onSave;
        this.onSaved = onSaved;
        this.session = null;
        this.dialog = document.createElement("dialog");
        this.dialog.className =
            "rewards-dialog reflection-dialog w-[94vw] max-w-sm rounded-xl border " +
            "border-slate-200 dark:border-slate-700 bg-background-light dark:bg-background-dark " +
            "p-4 text-left text-slate-800 dark:text-slate-200 shadow-lg";
        this.dialog.setAttribute("aria-labelledby", "reading-note-title");
        this.dialog.innerHTML = `
            <form class="reflection-dialog__form grid gap-3">
                <header class="flex items-start gap-3">
                    <span class="material-symbols-outlined mt-1 text-primary" aria-hidden="true">park</span>
                    <div class="min-w-0 flex-1">
                        <h2 id="reading-note-title" class="text-sm font-bold text-slate-900 dark:text-slate-100">Tree planted</h2>
                        <p data-summary class="mt-1 text-xs text-slate-500 dark:text-slate-400"></p>
                    </div>
                </header>
                <section data-highlights class="reflection-dialog__highlights grid gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-gray-900 p-3">
                    <h3 class="text-xs font-semibold text-slate-700 dark:text-slate-300">Your highlights from this reading session</h3>
                    <div data-highlight-list class="reflection-dialog__highlight-list grid gap-2 text-xs text-slate-600 dark:text-slate-300"></div>
                </section>
                <div>
                    <button type="button" data-copy
                        class="inline-flex items-center justify-center gap-1 rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-white/10">
                        <span class="material-symbols-outlined text-base" aria-hidden="true">content_copy</span>
                        <span data-copy-label>Copy reading text</span>
                    </button>
                    <p data-copy-status class="hidden mt-2 text-xs" aria-live="polite"></p>
                </div>
                <label class="grid gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
                    Write what you were reading
                    <textarea rows="4" data-text required placeholder="What did you read during these five minutes?"
                        class="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-slate-800 dark:text-slate-200 outline-none focus:ring-2 focus:ring-primary"></textarea>
                </label>
                <p class="text-xs text-slate-500 dark:text-slate-400">
                    This paragraph is required. Write at least ${this.minimumCharacters} non-space characters to continue reading.
                </p>
                <footer class="flex justify-end gap-2">
                    <button type="submit" data-save disabled
                        class="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-white">Save and continue</button>
                </footer>
            </form>`;
        document.body.appendChild(this.dialog);
        this.dialog.addEventListener("cancel", (event) => event.preventDefault());
        this.dialog.querySelector("[data-copy]").addEventListener("click", () => {
            this._copyReadingText();
        });

        const form = this.dialog.querySelector("form");
        const area = this.dialog.querySelector("[data-text]");
        const save = this.dialog.querySelector("[data-save]");
        area.addEventListener("input", () => {
            save.disabled = area.value.replace(/\s/g, "").length < this.minimumCharacters;
        });
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (save.disabled) return;
            save.disabled = true;
            try {
                const session = this.session;
                const saved = await this.onSave(session, area.value);
                if (!saved) return;
                this.close();
                await this.onSaved?.(session, saved);
            } finally {
                save.disabled = area.value.replace(/\s/g, "").length < this.minimumCharacters;
            }
        });
    }

    isOpen() {
        return this.dialog.open;
    }

    open(session, summary = "", highlights = []) {
        if (!session || this.isOpen()) return false;
        this.session = session;
        this.dialog.querySelector("[data-summary]").textContent = summary;
        this._updateCopyButton();
        this._renderHighlights(highlights);
        const area = this.dialog.querySelector("[data-text]");
        area.value = "";
        area.dispatchEvent(new Event("input"));
        this.dialog.showModal();
        area.focus();
        return true;
    }

    _updateCopyButton() {
        const text = readingTextFromPhrases(this.session?.readingPhrases);
        const button = this.dialog.querySelector("[data-copy]");
        button.disabled = !text;
        button.title = text
            ? "Copy all text read while growing this tree"
            : "Text was not recorded for this tree.";
        this.dialog.querySelector("[data-copy-label]").textContent = text
            ? "Copy reading text"
            : "No recorded text";
        const status = this.dialog.querySelector("[data-copy-status]");
        status.textContent = "";
        status.classList.add("hidden");
    }

    async _copyReadingText() {
        const session = this.session;
        const text = readingTextFromPhrases(session?.readingPhrases);
        if (!text) return false;
        const button = this.dialog.querySelector("[data-copy]");
        button.disabled = true;
        const copied = await copyReadingText(text, this.dialog);
        if (this.session === session) {
            button.disabled = false;
            const status = this.dialog.querySelector("[data-copy-status]");
            status.textContent = copied
                ? "Reading text copied."
                : "Could not copy reading text. Please try again.";
            status.classList.remove("hidden");
        }
        return copied;
    }

    _renderHighlights(highlights) {
        const list = this.dialog.querySelector("[data-highlight-list]");
        list.replaceChildren();
        const items = Array.isArray(highlights)
            ? highlights.map((value) => {
                const item = value && typeof value === "object" ? value : { text: value };
                return {
                    text: String(item.text || "").trim(),
                    color: typeof item.color === "string" ? item.color.trim() : "",
                };
            }).filter((item) => item.text)
            : [];
        if (!items.length) {
            const empty = document.createElement("p");
            empty.className = "italic text-slate-500 dark:text-slate-400";
            empty.textContent = "You did not add any highlights during this session.";
            list.appendChild(empty);
            return;
        }
        for (const item of items) {
            const quote = document.createElement("blockquote");
            quote.className = "border-l-2 border-primary/50 pl-3 whitespace-pre-wrap";
            if (item.color && globalThis.CSS?.supports?.("color", item.color)) {
                quote.style.borderLeftColor = item.color;
            }
            quote.textContent = item.text;
            list.appendChild(quote);
        }
    }

    close() {
        if (this.dialog.open) this.dialog.close();
        this.session = null;
    }
}
