// scripts/determinism-test.js: checks that a task can be re-run with the same result.
// No servers needed:  node scripts/determinism-test.js   (or: npm run determinism)
const { createTask } = require('../shared/task');
const { runTask } = require('../worker/simulate');

let failed = 0;
function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  ${detail}`}`);
  if (!condition) failed++;
}

// runTask must not touch Math.random (it would make runs unrepeatable).
function runWithoutMathRandom(payload) {
  const original = Math.random;
  Math.random = () => { throw new Error('Math.random was used'); };
  try {
    return runTask(payload);
  } finally {
    Math.random = original;
  }
}

function main() {
  const seeds = Array.from({ length: 2000 }, (_, i) => i + 1);

  let sameEveryTime = true;
  let usedMathRandom = null;
  for (const seed of seeds) {
    try {
      const a = runWithoutMathRandom({ home: 'TUR', away: 'BRA', seed });
      const b = runWithoutMathRandom({ home: 'TUR', away: 'BRA', seed });
      if (JSON.stringify(a) !== JSON.stringify(b)) sameEveryTime = false;
    } catch (err) {
      usedMathRandom = err.message;
      break;
    }
  }
  check('runTask does not use Math.random', usedMathRandom === null, usedMathRandom ?? '');
  check('same seed gives the same result (2000 seeds)', usedMathRandom === null && sameEveryTime);

  const results = seeds.map((seed) => runTask({ home: 'TUR', away: 'BRA', seed }));
  const distinct = new Set(results.map((r) => `${r.homeGoals}-${r.awayGoals}`));
  check('different seeds give different scores', distinct.size > 10, `distinct scores: ${distinct.size}`);

  const mean = (f) => results.reduce((sum, r) => sum + f(r), 0) / results.length;
  check('home goals average is close to 1.4', Math.abs(mean((r) => r.homeGoals) - 1.4) < 0.15, `got ${mean((r) => r.homeGoals).toFixed(2)}`);
  check('away goals average is close to 1.1', Math.abs(mean((r) => r.awayGoals) - 1.1) < 0.15, `got ${mean((r) => r.awayGoals).toFixed(2)}`);

  // The two teams must be drawn independently. If both used a fresh generator
  // with the same seed they would move together and draws would be far too common.
  const drawRate = results.filter((r) => r.homeGoals === r.awayGoals).length / results.length;
  check('home and away goals are independent (draw rate below 35%)', drawRate < 0.35, `draw rate ${(drawRate * 100).toFixed(0)}%`);

  const t1 = createTask({ home: 'TUR', away: 'BRA' });
  const t2 = createTask({ home: 'TUR', away: 'BRA' });
  check('a new task gets a seed', Number.isInteger(t1.payload.seed), `seed: ${t1.payload.seed}`);
  check('two new tasks get different seeds', t1.payload.seed !== t2.payload.seed);
  check('a seed given by the caller is kept', createTask({ home: 'TUR', away: 'BRA', seed: 42 }).payload.seed === 42);

  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main();