import test from "node:test";
import assert from "node:assert/strict";

import { mergeSegmentsInsideParentheses, splitSegmentsOnSemicolons } from "../src/modules/epub/sentenceSegmentation.js";

const intlSegments = (text) =>
    [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)].map(({ segment, index }) => ({
        text: segment.trim(),
        start: index + segment.length - segment.trimStart().length,
        end: index + segment.trimEnd().length,
    }));

const protectParentheses = (text, segments = intlSegments(text)) =>
    splitSegmentsOnSemicolons(text, mergeSegmentsInsideParentheses(text, segments), {
        ignoreParenthesizedPunctuation: true,
    });

const assertOffsets = (text, segments) => {
    for (const segment of segments) {
        assert.equal(text.slice(segment.start, segment.end).replace(/\s+/g, " ").trim(), segment.text);
    }
};

test("splits EPUB sentence segments at semicolons and preserves offsets", () => {
    const text = "First phrase;  second phrase. Third phrase; fourth.";
    const segments = [
        { text: "First phrase; second phrase.", start: 0, end: 29 },
        { text: "Third phrase; fourth.", start: 30, end: text.length },
    ];

    assert.deepEqual(splitSegmentsOnSemicolons(text, segments), [
        { text: "First phrase;", start: 0, end: 13 },
        { text: "second phrase.", start: 15, end: 29 },
        { text: "Third phrase;", start: 30, end: 43 },
        { text: "fourth.", start: 44, end: 51 },
    ]);
});

test("keeps an author abbreviation and year inside the same EPUB phrase", () => {
    const text = "then to continuous audio descriptors by the Audio Oracle (Dubnov et al. 2007),";

    assert.deepEqual(protectParentheses(text), [{ text, start: 0, end: text.length }]);
});

test("ignores sentence punctuation and semicolons inside nested parentheses", () => {
    const text = "Intro (Alpha (Beta. Gamma); Delta) continues. Next; last.";
    const phrases = protectParentheses(text);

    assert.deepEqual(phrases.map(({ text }) => text), [
        "Intro (Alpha (Beta. Gamma); Delta) continues.",
        "Next;",
        "last.",
    ]);
    assertOffsets(text, phrases);
});

test("distinguishes a period before a closing parenthesis from one after it", () => {
    const internal = "Intro (Alpha.) Next.";
    const boundary = internal.indexOf(")") + 1;
    const original = [
        { text: internal.slice(0, boundary), start: 0, end: boundary },
        { text: "Next.", start: boundary + 1, end: internal.length },
    ];
    assert.deepEqual(protectParentheses(internal, original), [
        { text: internal, start: 0, end: internal.length },
    ]);

    const external = "Intro (Alpha). Next.";
    const phrases = protectParentheses(external);
    assert.deepEqual(phrases.map(({ text }) => text), ["Intro (Alpha).", "Next."]);
    assertOffsets(external, phrases);
});

test("distinguishes a semicolon before a closing parenthesis from one after it", () => {
    const text = "Intro (Alpha;) continues; (Beta); next.";
    const phrases = protectParentheses(text);

    assert.deepEqual(phrases.map(({ text }) => text), ["Intro (Alpha;) continues;", "(Beta);", "next."]);
    assertOffsets(text, phrases);
});

test("merges fallback sentence segments without changing UTF-16 offsets", () => {
    const text = "  🎧 Intro (Alpha.\n  Beta; Gamma) continues.  Next.";
    const firstEnd = text.indexOf(".") + 1;
    const secondEnd = text.indexOf("continues.") + "continues.".length;
    const segments = [
        { text: "🎧 Intro (Alpha.", start: 2, end: firstEnd },
        { text: "Beta; Gamma) continues.", start: text.indexOf("Beta"), end: secondEnd },
        { text: "Next.", start: text.indexOf("Next"), end: text.length },
    ];

    const phrases = protectParentheses(text, segments);
    assert.deepEqual(phrases, [
        { text: "🎧 Intro (Alpha. Beta; Gamma) continues.", start: 2, end: secondEnd },
        { text: "Next.", start: text.indexOf("Next"), end: text.length },
    ]);
    assertOffsets(text, phrases);
});

test("keeps legacy semicolon splitting inside parentheses unless opted in", () => {
    const text = "Intro (Alpha; Beta) continues.";
    const segments = [{ text, start: 0, end: text.length }];

    assert.deepEqual(splitSegmentsOnSemicolons(text, segments).map(({ text }) => text), [
        "Intro (Alpha;",
        "Beta) continues.",
    ]);
    assert.deepEqual(splitSegmentsOnSemicolons(text, segments, {
        ignoreParenthesizedPunctuation: true,
    }), segments);
});
