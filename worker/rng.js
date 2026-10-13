// worker/rng.js: a random number generator you can replay.
//
// Math.random() cannot be seeded: two runs never give the same numbers.
// createRng(seed) returns a function that behaves like Math.random() (a number
// in [0, 1)), but the same seed always produces the same sequence.
// Algorithm: mulberry32, a small and well-known 32-bit generator.
function createRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { createRng };