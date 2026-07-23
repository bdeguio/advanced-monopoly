/**
 * Deterministic RNG. Every draw is a pure function of (seed, stream, index),
 * which makes the whole game replayable from the event log: no hidden RNG state.
 */
export const enum Stream {
  Dice = 1,
  ShuffleChance = 2,
  ShuffleChest = 3,
  UtilityRoll = 4,
}

/** SplitMix64-style avalanche hash over 32-bit lanes; returns uint32. */
function hash(seed: number, stream: number, index: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ stream, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13) ^ index, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x27d4eb2f) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

/** Uniform integer in [1, 6]. */
export function die(seed: number, stream: Stream, index: number): number {
  return (hash(seed, stream, index) % 6) + 1;
}

/** Deterministic Fisher-Yates shuffle of [0, n). */
export function shuffledIndices(seed: number, stream: Stream, n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = hash(seed, stream, i) % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
