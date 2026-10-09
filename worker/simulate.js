// worker/simulate.js: the actual work a worker does.
//
// This is the pluggable part of the system. v1: simple statistics.
// v2: ML model. The rest of the worker never changes; only runTask() does.

// Draws a random number from a Poisson distribution (Knuth's method).
// The classic model for "how many goals does a team score in a match".
function poisson(lambda) {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > limit);
  return k - 1;
}

// payload: { home, away }  ->  result: { home, away, homeGoals, awayGoals }
function runTask(payload) {
  return {
    home: payload.home,
    away: payload.away,
    homeGoals: poisson(1.4),
    awayGoals: poisson(1.1),
  };
}

module.exports = { runTask };
