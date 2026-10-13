// worker/simulate.js: the actual work a worker does.
//
// This is the pluggable part of the system. v1: simple statistics.
// v2: ML model. The rest of the worker never changes; only runTask() does.

// Draws a random number from a Poisson distribution (Knuth's method).
// The classic model for "how many goals does a team score in a match".

const { createRng } = require('./rng');

function poisson(lambda, rng) {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

// payload: { home, away }  ->  result: { home, away, homeGoals, awayGoals }
function runTask(payload) {
  const rng = createRng(payload.seed)
  return {
    home: payload.home,
    away: payload.away,
    homeGoals: poisson(1.4, rng),
    awayGoals: poisson(1.1, rng),
  };
}

module.exports = { runTask };
