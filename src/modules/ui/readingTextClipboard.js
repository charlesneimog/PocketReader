export function readingTextFromPhrases(phrases) {
    return (Array.isArray(phrases) ? phrases : [])
        .map((phrase) => typeof phrase?.text === "string" ? phrase.text : "")
        .filter((text) => text.trim())
        .join("\n\n");
}

export async function copyReadingText(text, container) {
    if (!text) return false;
    try {
        if (globalThis.navigator?.clipboard?.writeText) {
            await globalThis.navigator.clipboard.writeText(text);
            return true;
        }
    } catch (_) {
        // Try a selection when clipboard access is unavailable.
    }

    const doc = container?.ownerDocument || globalThis.document;
    const previousFocus = doc?.activeElement;
    let textarea;
    try {
        textarea = doc.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        // A modal makes elements outside it inert, including a textarea in body.
        (container || doc.body).appendChild(textarea);
        textarea.focus();
        textarea.select();
        return Boolean(doc.execCommand?.("copy"));
    } catch (_) {
        return false;
    } finally {
        textarea?.remove();
        previousFocus?.focus?.({ preventScroll: true });
    }
}
