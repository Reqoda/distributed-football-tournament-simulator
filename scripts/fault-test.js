// scripts/fault-test.js: checks that a task is taken back from a dead worker,
// and that only the worker that currently holds a task can report its result.
//
// Start a FRESH coordinator with a short lease and NO worker:
//   LEASE_MS=1000 node coordinator/server.js
// then run:
//   LEASE_MS=1000 node scripts/fault-test.js        (or: npm run fault)
//
// It plays workers by hand. "ghost" takes a task and never reports back
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

async function addTask() {
  const created = await call('POST', '/tasks', { payload: { home: 'TUR', away: 'BRA' } });
  const id = created.body?.id;
  if (!id) throw new Error(`could not add a task (HTTP ${created.status})`);
  return id;
}

const claim = (worker) => call('GET', `/tasks/next?worker=${worker}`);
const report = (id, worker, result) => call('POST', `/tasks/${id}/result?worker=${worker}`, result);

async function main() {
  console.log('--- a task is taken back from a dead worker');
  const id = await addTask();

  // 1. ghost takes the task and goes silent
  const ghost = await claim('ghost');
  if (ghost.body?.id !== id) {
    throw new Error('the queue was not empty: restart the coordinator and run the test again');
  }
  check('ghost gets the task (attempt 1)', ghost.status === 200 && ghost.body.attempts === 1, JSON.stringify(ghost.body));

  // 2. while the lease is still valid, nobody else can take it
  const early = await claim('rescuer');
  check('task is NOT handed out again before the lease runs out', early.status === 204, `got ${early.status}`);

  // 3. after the lease has run out, the task comes back
  await sleep(LEASE_MS + 300);
  const late = await claim('rescuer');
  check('task goes back to the queue after the lease runs out', late.status === 200 && late.body?.id === id, `got ${late.status}`);
  check('rescuer is now the owner', late.body?.workerId === 'rescuer', `workerId: ${late.body?.workerId}`);
  check('attempts counts both claims', late.body?.attempts === 2, `attempts: ${late.body?.attempts}`);

  // 4. rescuer finishes it
  const done = await report(id, 'rescuer', { homeGoals: 1, awayGoals: 0 });
  check('rescuer can report the result', done.status === 200, `got ${done.status}`);
  const final = await call('GET', `/tasks/${id}`);
  check('task is done and the lease is cleared', final.body?.status === 'done' && final.body?.leaseExpiresAt === null, JSON.stringify(final.body));

  // 5. ghost wakes up late and reports too: it must not overwrite anything
  const stale = await report(id, 'ghost', { homeGoals: 9, awayGoals: 9 });
  check('a late result from ghost is rejected (409)', stale.status === 409, `got ${stale.status}`);

  console.log('--- only the current holder of a task can report its result');
  const id2 = await addTask();
  const first = await claim('old-holder');
  check('old-holder gets the task', first.body?.id === id2, JSON.stringify(first.body));
  await sleep(LEASE_MS + 300);
  const second = await claim('new-holder');
  check('new-holder gets the same task (attempt 2)', second.body?.id === id2 && second.body?.attempts === 2, JSON.stringify(second.body));

  // old-holder wakes up while new-holder is still working on it
  const intruder = await report(id2, 'old-holder', { homeGoals: 9, awayGoals: 9 });
  check('a result from the old holder is rejected while the task runs again (409)', intruder.status === 409, `got ${intruder.status}`);
  const mid = await call('GET', `/tasks/${id2}`);
  check('the rejected result was not stored', mid.body?.status === 'running' && mid.body?.result === null, JSON.stringify(mid.body));

  const ok = await report(id2, 'new-holder', { homeGoals: 2, awayGoals: 1 });
  check('the current holder can report', ok.status === 200, `got ${ok.status}`);
  const stored = await call('GET', `/tasks/${id2}`);
  check(
    'owner and result come from the same worker',
    stored.body?.workerId === 'new-holder' && stored.body?.result?.homeGoals === 2,
    JSON.stringify(stored.body)
  );

  console.log('--- a late result is still accepted when nobody else took the task');
  const id3 = await addTask();
  const only = await claim('slow-worker');
  check('slow-worker gets the task', only.body?.id === id3, JSON.stringify(only.body));
  await sleep(LEASE_MS + 300); // lease runs out, but no other worker asks for work
  const lateOk = await report(id3, 'slow-worker', { homeGoals: 0, awayGoals: 0 });
  check('its result is accepted, the work is not wasted', lateOk.status === 200, `got ${lateOk.status}`);

  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('fault test could not run:', err.message);
  process.exit(1);
});