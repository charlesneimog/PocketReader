import { GardenRenderer } from "../rewards/gardenRenderer.js";
import { copyReadingText, readingTextFromPhrases } from "./readingTextClipboard.js";
import { deterministicAvailableCell, gardenSquareSideWithFreeSpots } from "../rewards/gardenManager.js";
import {
    isTimestampInLocalPeriod,
    localCalendarPeriodBounds,
    localDateKey,
} from "../rewards/rewardDefinitions.js";
import {
    getAutomaticTreeTier,
    getPlantDefinition,
    getPlantStage,
} from "../rewards/plantDefinitions.js";

export function activeReadingMillisecondsForPeriod(
    activeTimeByDay,
    period,
    timestamp = Date.now(),
    weekStartsOn = 1,
) {
    const bounds = localCalendarPeriodBounds(period, timestamp, weekStartsOn);
    const startKey = localDateKey(bounds.start);
    const endKey = localDateKey(bounds.end);
    return Object.entries(activeTimeByDay || {}).reduce(
        (total, [dateKey, milliseconds]) =>
            dateKey >= startKey && dateKey < endKey
                ? total + Math.max(0, Number(milliseconds) || 0)
                : total,
        0,
    );
}

function quantity(value, singular, plural = `${singular}s`) {
    return `${value} ${value === 1 ? singular : plural}`;
}

export function gardenReadingTimeMessage(state, timestamp = Date.now(), weekStartsOn = 1) {
    const intervalSeconds = Math.max(
        1,
        Math.round(Number(getAutomaticTreeTier(state?.plants || []).definition.durationSeconds) || 0),
    );
    const minutes = Math.floor(intervalSeconds / 60);
    const seconds = intervalSeconds % 60;
    const interval = [
        minutes ? quantity(minutes, "minute") : "",
        seconds ? quantity(seconds, "second") : "",
    ].filter(Boolean).join(" and ");
    const periodMinutes = (period) => Math.floor(
        activeReadingMillisecondsForPeriod(
            state?.activeTimeByDay,
            period,
            timestamp,
            weekStartsOn,
        ) / 60000,
    );

    return [
        `You are reading in tree-growing intervals of ${interval}.`,
        `This week you read ${quantity(periodMinutes("week"), "minute")}.`,
        `This month you read ${quantity(periodMinutes("month"), "minute")}.`,
        `This year you read ${quantity(periodMinutes("year"), "minute")}.`,
    ].join("\n");
}

export function gardenPlantsForPeriod(
    plants,
    period,
    timestamp = Date.now(),
    weekStartsOn = 1,
) {
    return (Array.isArray(plants) ? plants : [])
        .filter(
            (plant) =>
                plant?.stage === "mature" &&
                !plant.deletedAt &&
                isTimestampInLocalPeriod(
                    plant.completedAt || plant.plantedAt,
                    period,
                    timestamp,
                    weekStartsOn,
                ),
        )
        .sort(
            (left, right) =>
                Number(left.completedAt || left.plantedAt || 0) -
                    Number(right.completedAt || right.plantedAt || 0) ||
                String(left.id).localeCompare(String(right.id)),
        );
}

export function projectPlantsIntoGarden(plants, plot) {
    const side = gardenSquareSideWithFreeSpots(
        plants.length,
        Math.max(1, Number(plot.rows) || 1, Number(plot.columns) || 1),
    );
    const projectedPlot = { ...plot, rows: side, columns: side };
    const positioned = [];
    for (const plant of plants) {
        const cell = deterministicAvailableCell(
            projectedPlot,
            positioned,
            gardenPositionSeedForPlant(plant),
        );
        positioned.push({
            ...plant,
            plotId: projectedPlot.id,
            cell,
        });
    }
    return {
        plot: projectedPlot,
        plants: positioned,
    };
}

export function gardenMinimumSideForPeriod(period, yearMinimumSide = 5) {
    const yearSide = Math.max(3, Math.floor(Number(yearMinimumSide) || 5));
    if (period === "week") return Math.max(2, yearSide - 2);
    if (period === "month") return Math.max(3, yearSide - 1);
    return yearSide;
}

export function gardenPositionSeedForPlant(plant) {
    const phrase = typeof plant?.reflectionText === "string"
        ? plant.reflectionText.trim()
        : "";
    return `${phrase || "tree"}:${plant?.id || "unknown"}`;
}

export function reflectionTextForPlant(plant, reflections) {
    const reflection = (Array.isArray(reflections) ? reflections : []).find((entry) =>
        (plant?.reflectionId && entry.id === plant.reflectionId) ||
        (!plant?.reflectionId && plant?.sessionId && entry.sessionId === plant.sessionId),
    );
    return typeof reflection?.text === "string" ? reflection.text.trim() : "";
}

export function readingTextForPlant(plant, sessions) {
    const session = plant?.sessionId
        ? (Array.isArray(sessions) ? sessions : [])
            .find((entry) => entry.id === plant.sessionId)
        : null;
    const phrases = Array.isArray(plant?.readingPhrases)
        ? plant.readingPhrases
        : session?.readingPhrases;
    return readingTextFromPhrases(phrases);
}

export class GardenDialog {
    constructor({ weekStartsOn = 1, minimumRows = 5, now = Date.now, onRemove = null } = {}) {
        this.weekStartsOn = weekStartsOn;
        this.minimumRows = Math.max(1, Number(minimumRows) || 5);
        this.now = now;
        this.onRemove = typeof onRemove === "function" ? onRemove : null;
        this.selectedPlantId = null;
        this.period = "week";
        this.dialog = document.createElement("dialog");
        this.dialog.className =
            "rewards-dialog garden-dialog w-[94vw] max-w-xl max-h-[88vh] p-0 rounded-xl " +
            "border border-slate-200 dark:border-slate-700 bg-background-light dark:bg-background-dark " +
            "text-slate-800 dark:text-slate-200 text-center shadow-2xl";
        this.dialog.innerHTML = `
            <section class="grid gap-2 px-3 pb-3 pt-2 overflow-y-auto max-h-[88vh]">
                <header class="flex items-center justify-between gap-3">
                    <h2 class="pl-1 text-base font-semibold text-slate-900 dark:text-slate-100">Reading garden</h2>
                    <button type="button" data-close aria-label="Close"
                        class="flex h-8 w-8 items-center justify-center rounded-md bg-transparent text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10">
                        <span class="material-symbols-outlined" aria-hidden="true">close</span>
                    </button>
                </header>
                <div class="flex justify-center gap-2" role="group" aria-label="Garden time period">
                    <button type="button" data-period="week" aria-pressed="true">Week</button>
                    <button type="button" data-period="month" aria-pressed="false">Month</button>
                    <button type="button" data-period="year" aria-pressed="false">Year</button>
                </div>
                <p data-reading-time class="rounded-lg bg-primary/10 px-3 py-2 text-left text-xs leading-relaxed text-slate-600 dark:text-slate-300 whitespace-pre-line"></p>
                <div class="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 bg-white/50 dark:bg-black/20">
                    <canvas class="garden-canvas block w-full max-w-full bg-transparent" aria-label="Reading garden grid"></canvas>
                </div>
                <div class="rounded-lg bg-slate-100 dark:bg-slate-800 p-3 text-sm text-slate-600 dark:text-slate-300" aria-live="polite">
                    <p data-tooltip>Select a tree for details.</p>
                    <blockquote data-comment class="hidden mt-2 border-l-2 border-primary/50 pl-3 text-left italic whitespace-pre-wrap"></blockquote>
                    <div class="mt-3 flex flex-wrap justify-end gap-2">
                        <button type="button" data-copy class="hidden items-center justify-center gap-1 rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-white/70 disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-white/10">
                            <span class="material-symbols-outlined text-base" aria-hidden="true">content_copy</span>
                            <span data-copy-label>Copy reading text</span>
                        </button>
                        <button type="button" data-remove class="garden-remove-button hidden items-center justify-center gap-1 rounded-md border border-red-300 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/30">
                            <span class="material-symbols-outlined text-base" aria-hidden="true">delete</span>
                            <span>Remove tree</span>
                        </button>
                    </div>
                    <p data-copy-status class="hidden mt-2 text-xs"></p>
                </div>
            </section>`;
        document.body.appendChild(this.dialog);
        this.dialog.querySelector("[data-close]").addEventListener("click", () => this.dialog.close());
        this.dialog.querySelectorAll("[data-period]").forEach((button) => {
            button.addEventListener("click", () => {
                this.period = button.dataset.period;
                this.renderer.selectedIndex = -1;
                this._resetDetails();
                this.update(this.state, this.summary);
            });
        });
        this.dialog.querySelector("[data-remove]").addEventListener("click", () => {
            this._removeSelectedTree().catch((error) => {
                console.error("[GardenDialog] Failed to remove tree", error);
            });
        });
        this.dialog.querySelector("[data-copy]").addEventListener("click", () => {
            this._copySelectedTreeText();
        });
        this.renderer = new GardenRenderer(this.dialog.querySelector("canvas"), {
            onSelect: (area) => {
                this._showDetails(area);
            },
        });
    }

    open(state, summary) {
        this.renderer.selectedIndex = -1;
        this._resetDetails();
        this.update(state, summary);
        this.dialog.showModal();
    }

    update(state, summary) {
        this.state = state;
        this.summary = summary;
        const plot = state.gardenPlots[0];
        if (!plot) return;
        this._updatePeriodButtons();

        const timestamp = this.now();
        this.dialog.querySelector("[data-reading-time]").textContent = gardenReadingTimeMessage(
            state,
            timestamp,
            this.weekStartsOn,
        );
        const periodPlants = gardenPlantsForPeriod(
            state.plants,
            this.period,
            timestamp,
            this.weekStartsOn,
        );
        const positionablePlants = periodPlants.map((plant) => ({
            ...plant,
            reflectionText: reflectionTextForPlant(plant, state.reflections),
        }));
        const periodSide = gardenMinimumSideForPeriod(this.period, this.minimumRows);
        const projection = projectPlantsIntoGarden(positionablePlants, {
            id: plot.id,
            name: plot.name,
            rows: periodSide,
            columns: periodSide,
        });
        this.renderer.render(projection);
    }

    _showDetails(area) {
        const tooltip = this.dialog.querySelector("[data-tooltip]");
        const comment = this.dialog.querySelector("[data-comment]");
        const remove = this.dialog.querySelector("[data-remove]");
        if (!area.plant) {
            this._resetDetails();
            tooltip.textContent = `Cell ${area.cell.x + 1}, ${area.cell.y + 1} is available.`;
            return;
        }
        this.selectedPlantId = area.plant.id;
        tooltip.textContent = this._plantLabel(area.plant);
        comment.textContent = area.plant.reflectionText || "No reading note was saved for this tree.";
        comment.classList.remove("hidden");
        remove.classList.remove("hidden");
        remove.classList.add("flex");
        this._updateCopyButton(area.plant);
    }

    _resetDetails() {
        const tooltip = this.dialog.querySelector("[data-tooltip]");
        const comment = this.dialog.querySelector("[data-comment]");
        const remove = this.dialog.querySelector("[data-remove]");
        this.selectedPlantId = null;
        tooltip.textContent = "Select a tree for details.";
        comment.textContent = "";
        comment.classList.add("hidden");
        remove.classList.add("hidden");
        remove.classList.remove("flex");
        this._updateCopyButton(null);
    }

    _updateCopyButton(plant) {
        const button = this.dialog.querySelector("[data-copy]");
        const label = this.dialog.querySelector("[data-copy-label]");
        const status = this.dialog.querySelector("[data-copy-status]");
        const hasText = Boolean(readingTextForPlant(plant, this.state?.sessions));
        button.classList.toggle("hidden", !plant);
        button.classList.toggle("flex", Boolean(plant));
        button.disabled = !hasText;
        button.title = hasText
            ? "Copy all text read while growing this tree"
            : "Text was not recorded for this tree.";
        label.textContent = hasText ? "Copy reading text" : "No recorded text";
        status.textContent = "";
        status.classList.add("hidden");
    }

    async _copySelectedTreeText() {
        const plantId = this.selectedPlantId;
        const plant = this.state?.plants?.find((candidate) => candidate.id === plantId);
        const text = readingTextForPlant(plant, this.state?.sessions);
        if (!plantId || !text) return false;

        const button = this.dialog.querySelector("[data-copy]");
        button.disabled = true;
        const copied = await copyReadingText(text, this.dialog);

        if (this.selectedPlantId === plantId) {
            button.disabled = false;
            const status = this.dialog.querySelector("[data-copy-status]");
            status.textContent = copied
                ? "Reading text copied."
                : "Could not copy reading text. Please try again.";
            status.classList.remove("hidden");
        }
        return copied;
    }

    async _removeSelectedTree() {
        const plantId = this.selectedPlantId;
        if (!plantId || !this.onRemove) return false;
        const plant = this.state?.plants?.find((candidate) => candidate.id === plantId);
        if (!plant) return false;
        const definition = getPlantDefinition(plant.speciesId);
        const confirmed = globalThis.confirm?.(
            `Remove ${definition.name} from your garden? Your reading time and earned points will be kept.`,
        );
        if (!confirmed) return false;

        const button = this.dialog.querySelector("[data-remove]");
        button.disabled = true;
        try {
            const removed = await this.onRemove(plantId);
            if (!removed) return false;
            this.renderer.selectedIndex = -1;
            this._resetDetails();
            return true;
        } finally {
            button.disabled = false;
        }
    }

    _updatePeriodButtons() {
        this.dialog.querySelectorAll("[data-period]").forEach((button) => {
            const active = button.dataset.period === this.period;
            button.className = active
                ? "rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white"
                : "rounded-md border border-slate-200 dark:border-slate-700 px-4 py-2 text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-primary/10";
            button.setAttribute("aria-pressed", String(active));
        });
    }

    _plantLabel(plant) {
        const definition = getPlantDefinition(plant.speciesId);
        const stage = getPlantStage(plant.speciesId, plant.pointsInvested, plant.growthProgress);
        return `${definition.name}, ${stage.label}`;
    }
}
