export const LEGACY_PHRASE_SPLIT_VERSION = 1;
export const CURRENT_PHRASE_SPLIT_VERSION = 3;

// Append new entries; never rewrite or remove an existing version. Saved
// highlights use these versions to rebuild the phrase indexes they were made with.
export const PHRASE_SPLIT_HISTORY = Object.freeze([
    Object.freeze({
        version: 1,
        name: "legacy-sentence-boundaries",
        pdf: "Sentence punctuation; short semicolon lead-ins remain attached",
        epub: "Intl sentence boundaries without semicolon phrase splitting",
    }),
    Object.freeze({
        version: 2,
        name: "semicolon-phrase-boundaries",
        pdf: "Every semicolon ends a phrase",
        epub: "Every semicolon ends a phrase after sentence segmentation",
    }),
    Object.freeze({
        version: 3,
        name: "parenthesis-aware-phrase-boundaries",
        pdf: "Sentence and semicolon punctuation inside parentheses stays in the phrase",
        epub: "Sentence and semicolon punctuation inside parentheses stays in the phrase",
    }),
]);

const knownVersions = new Set(PHRASE_SPLIT_HISTORY.map(({ version }) => version));

export function normalizePhraseSplitVersion(value, fallback = CURRENT_PHRASE_SPLIT_VERSION) {
    const version = Number(value);
    return knownVersions.has(version) ? version : fallback;
}

export function usesSemicolonPhraseBoundaries(version) {
    return normalizePhraseSplitVersion(version) >= 2;
}

export function ignoresParenthesizedPunctuation(version) {
    return normalizePhraseSplitVersion(version) >= 3;
}
