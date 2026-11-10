// Shared by the browser and the server. The number is derived from the clock
// alone, so every viewer arrives at the same value without asking a server
// first, and two people on opposite sides of the world cannot disagree.

export const ROUND_MS = 5 * 60 * 1000;
export const DIGITS = 6;

export const bucketAt = (ms) => Math.floor(ms / ROUND_MS);
export const roundStart = (bucket) => bucket * ROUND_MS;
export const roundEnd = (bucket) => (bucket + 1) * ROUND_MS;
export const nextChangeAt = (ms) => roundEnd(bucketAt(ms));

// Mulberry32: tiny, deterministic, and identical in Node and the browser.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function numberFor(bucket) {
  const mixed = Math.imul(bucket ^ 0x2545f491, 0x9e3779b1) >>> 0;
  const random = mulberry32(mixed);
  random(); // discard the first value, which is weakly mixed for nearby seeds
  return String(Math.floor(random() * 10 ** DIGITS)).padStart(DIGITS, '0');
}

export function roundInfo(ms) {
  const bucket = bucketAt(ms);
  return {
    bucket,
    number: numberFor(bucket),
    startsAt: roundStart(bucket),
    endsAt: roundEnd(bucket),
  };
}

export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
