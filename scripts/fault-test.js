// scripts/fault-test.js: checks that a task is taken back from a dead worker.
//
// Start a FRESH coordinator with a short lease and NO worker:
//   LEASE_MS=1000 node coordinator/server.js
// then run:
//   LEASE_MS=1000 node scripts/fault-test.js        (or: npm run fault)
//
// It plays two workers by hand. "ghost" takes a task and never reports back
// (like a worker that crashed). "rescuer" asks for work later.
const COORDINATOR = process.env.COORDINATOR_URL || 'http://localhost:3000';
const LEASE_MS = Number(process.env.LEASE_MS) || 1000; // must match the coordinator

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = 0;

function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  ${detail}`}`);
  if (!condition) failed++;
}

async function call(method, path, body) {
  const res = await fetch(`${COORDINATOR}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function main() {
  const created = await call('POST', '/tasks', { payload: { home: 'TUR', away: 'BRA' } });
  const id = created.body?.id;
  if (!id) throw new Error(`could not add a task (HTTP ${created.status})`);

  // 1. ghost takes the task and goes silent
  const ghost = await call('GET', '/tasks/next?worker=ghost');
  if (ghost.body?.id !== id) {
    throw new Error('the queue was not empty: restart the coordinator and run the test again');
  }
  check('ghost gets the task (attempt 1)', ghost.status === 200 && ghost.body.attempts === 1, JSON.stringify(ghost.body));

  // 2. while the lease is still valid, nobody else can take it
  const early = await call('GET', '/tasks/next?worker=rescuer');
  check('task is NOT handed out again before the lease runs out', early.status === 204, `got ${early.status}`);

  // 3. after the lease has run out, the task comes back
  await sleep(LEASE_MS + 300);
  const late = await call('GET', '/tasks/next?worker=rescuer');
  check('task goes back to the queue after the lease runs out', late.status === 200 && late.body?.id === id, `got ${late.status}`);
  check('rescuer is now the owner', late.body?.workerId === 'rescuer', `workerId: ${late.body?.workerId}`);
  check('attempts counts both claims', late.body?.attempts === 2, `attempts: ${late.body?.attempts}`);

  // 4. rescuer finishes it
  const done = await call('POST', `/tasks/${id}/result`, { homeGoals: 1, awayGoals: 0 });
  check('rescuer can report the result', done.status === 200, `got ${done.status}`);
  const final = await call('GET', `/tasks/${id}`);
  check('task is done and the lease is cleared', final.body?.status === 'done' && final.body?.leaseExpiresAt === null, JSON.stringify(final.body));

  // 5. ghost wakes up late and reports too: it must not overwrite anything
  const stale = await call('POST', `/tasks/${id}/result`, { homeGoals: 9, awayGoals: 9 });
  check('a late result from ghost is rejected (409)', stale.status === 409, `got ${stale.status}`);

  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('fault test could not run:', err.message);
  process.exit(1);
});