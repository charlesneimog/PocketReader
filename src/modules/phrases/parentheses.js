// Depth before each UTF-16 character, plus the final depth at text.length.
// Keeping the depth at the punctuation itself also protects endings like ".)".
export function getParenthesisDepths(text, initialDepth = 0) {
    const depths = new Uint32Array(text.length + 1);
    let depth = initialDepth;
    for (let index = 0; index < text.length; index++) {
        depths[index] = depth;
        if (text[index] === "(") depth++;
        else if (text[index] === ")") depth = Math.max(0, depth - 1);
    }
    depths[text.length] = depth;
    return depths;
}
