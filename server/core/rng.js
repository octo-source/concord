// Seeded PRNG (mulberry32). Used everywhere determinism matters: bootstrap
// resampling, MockModel, the demo-corpus generator. Never use Math.random()
// in code whose output lands in a project bundle or a test assertion.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Convenience: seeded integer in [0, n)
export function randInt(rand, n) {
  return Math.floor(rand() * n);
}
