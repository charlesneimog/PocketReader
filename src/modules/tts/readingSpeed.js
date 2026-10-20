// Piper's length scale is the inverse of the reading-speed multiplier.
export function readingSpeedToLengthScale(value) {
    const parsed = Number.parseFloat(value);
    const multiplier = Number.isFinite(parsed) ? Math.min(2, Math.max(0.5, parsed)) : 1;
    return 1 / multiplier;
}
