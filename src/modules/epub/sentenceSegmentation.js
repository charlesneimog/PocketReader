import { getParenthesisDepths } from "../phrases/parentheses.js";

export function mergeSegmentsInsideParentheses(text, segments) {
    const depths = getParenthesisDepths(text);
    const merged = [];
    let pending = null;
    const append = ({ start, end }) => merged.push({
        text: text.slice(start, end).replace(/\s+/g, " ").trim(),
        start,
        end,
    });

    for (const segment of segments) {
        const start = pending?.start ?? segment.start;
        const end = segment.end;
        pending = { start, end };

        // Closing parentheses belong to the preceding punctuation. Inspect its
        // position so an internal "word.)" differs from an external "word).".
        let punctuationIndex = end - 1;
        while (punctuationIndex >= start && /[\s"'”’»›)\]}]/u.test(text[punctuationIndex])) {
            punctuationIndex--;
        }
        const endsInsideParentheses =
            punctuationIndex >= start &&
            /[.!?…]/u.test(text[punctuationIndex]) &&
            depths[punctuationIndex] > 0;

        if (!endsInsideParentheses) {
            append(pending);
            pending = null;
        }
    }

    if (pending) append(pending);
    return merged;
}

export function splitSegmentsOnSemicolons(text, segments, { ignoreParenthesizedPunctuation = false } = {}) {
    const depths = ignoreParenthesizedPunctuation ? getParenthesisDepths(text) : null;
    const phrases = [];
    const append = (start, end) => {
        while (start < end && /\s/u.test(text[start])) start++;
        while (end > start && /\s/u.test(text[end - 1])) end--;
        if (end <= start) return;
        phrases.push({
            text: text.slice(start, end).replace(/\s+/g, " ").trim(),
            start,
            end,
        });
    };

    for (const segment of segments) {
        let start = segment.start;
        const source = text.slice(segment.start, segment.end);
        const separator = /;["'”’»›\)\]\}]*/gu;
        let match;
        while ((match = separator.exec(source))) {
            if (depths && depths[segment.start + match.index] > 0) continue;
            const end = segment.start + match.index + match[0].length;
            append(start, end);
            start = end;
        }
        append(start, segment.end);
    }
    return phrases;
}
