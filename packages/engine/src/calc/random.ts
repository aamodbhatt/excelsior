/** 32-bit string hash (FNV-1a) used to derive per-cell random streams. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function splitmix32(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x9e3779b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/**
 * xoshiro128** seeded through splitmix32. Returns doubles in [0, 1) with 53 bits of randomness,
 * so seeded RAND/RANDARRAY are reproducible across machines and recalculations.
 */
export function xoshiro128(seed: number): () => number {
  const sm = splitmix32(seed);
  let a = sm();
  let b = sm();
  let c = sm();
  let d = sm();
  const next = (): number => {
    const result = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = b << 9;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = rotl(d, 11);
    return result;
  };
  return () => ((next() >>> 5) * 67108864 + (next() >>> 6)) / 9007199254740992;
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}
