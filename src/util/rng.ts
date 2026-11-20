/** Seeded random numbers (mulberry32), so the same seed replays the same Feeds. */

/** Uniform in [0, 1), deterministic for a given seed. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The seed from `?seed=<n>` in a query string, else a fresh one from `crypto.getRandomValues`. */
export function seedFromSearch(search: string): number {
  const raw = new URLSearchParams(search).get('seed');
  const given = raw === null || raw.trim() === '' ? NaN : Number(raw);
  if (Number.isFinite(given)) return given >>> 0;
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}
