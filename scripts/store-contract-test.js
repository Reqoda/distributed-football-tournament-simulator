// scripts/store-contract-test.js: runs the same checks against a store, so the
// memory store and the PostgreSQL store are held to the same rules.
//
//   node scripts/store-contract-test.js memory
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/tournament \
//     node scripts/store-contract-test.js pg          (EMPTIES the tasks table!)
//
// It talks to the store directly, no coordinator and no worker needed.
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const which = process.argv[2];
if (which !== 'memory' && which !== 'pg') {
  console.error('usage: node scripts/store-contract-test.js memory|pg');
  process.exit(2);
}
if (which === 'pg' && !process.env.DATABASE_URL) {
  console.error('pg needs DATABASE_URL (and it will EMPTY the tasks table there)');
  process.exit(2);
}

// Short lease so the lease checks do not take long. Must be set before the
// store is loaded, because the store reads it once at load time.
const LEASE_MS = 300;
process.env.LEASE_MS = String(LEASE_MS);
const store = require(`../coordinator/store-${which === 'pg' ? 'pg' : 'memory'}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = 0;

function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!condition) failed++;
}

// Starts a group from an empty queue: every pending task is claimed and finished.
async function drain() {
  let task;
  while ((task = await store.claimNext('drain'))) {
    await store.complete(task.id, 'drain', {});
  }
}

const TASK_KEYS = ['attempts', 'createdAt', 'id', 'leaseExpiresAt', 'payload', 'result', 'status', 'workerId'];

async function main() {
  if (which === 'pg') {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query('TRUNCATE tasks');
    await pool.end();
  }
  console.log(`--- store: ${store.name}`);

  console.log('--- add and get');
  const added = await store.add({ home: 'TUR', away: 'BRA' });
  check('add returns a pending task', added.status === 'pending' && added.attempts === 0, added);
  check('a new task has no owner, result or lease',
    added.workerId === null && added.result === null && added.leaseExpiresAt === null, added);
  check('the task has exactly the agreed fields', isDeepStrictEqual(Object.keys(added).sort(), TASK_KEYS), Object.keys(added));
  check('payload is kept and a seed is added', added.payload.home === 'TUR' && typeof added.payload.seed === 'number', added.payload);
  check('createdAt is a number (ms)', typeof added.createdAt === 'number' && Math.abs(added.createdAt - Date.now()) < 5000, added.createdAt);
  const seeded = await store.add({ home: 'A', away: 'B', seed: 42 });
  check('a seed given by the caller is kept', seeded.payload.seed === 42, seeded.payload);
  const fetched = await store.get(added.id);
  check('get returns the task', fetched !== null && fetched.id === added.id && fetched.payload.home === 'TUR', fetched);
  check('get of an unknown id returns null', (await store.get(randomUUID())) === null);
  check('get of something that is not even an id returns null', (await store.get('abc')) === null);

  console.log('--- claiming');
  await drain();
  const first = await store.add({ n: 1 });
  const second = await store.add({ n: 2 });
  const third = await store.add({ n: 3 });
  const c1 = await store.claimNext('w1');
  check('the oldest pending task is claimed first', c1 && c1.id === first.id, c1);
  check('a claimed task is running, owned, counted and leased',
    c1.status === 'running' && c1.workerId === 'w1' && c1.attempts === 1 &&
    c1.leaseExpiresAt > Date.now() && c1.leaseExpiresAt <= Date.now() + LEASE_MS + 1000, c1);
  const c2 = await store.claimNext('w2');
  check('the next claim gets the next task', c2 && c2.id === second.id, c2);
  const c3 = await store.claimNext('w3');
  check('and the next', c3 && c3.id === third.id, c3);
  check('nothing left: claim returns null', (await store.claimNext('w4')) === null);
  for (const t of [c1, c2, c3]) await store.complete(t.id, t.workerId, {});

  console.log('--- completing');
  await drain();
  const task = await store.add({ home: 'ESP', away: 'GER' });
  check('a task nobody claimed cannot be completed', (await store.complete(task.id, 'w1', {})).reason === 'not_running');
  await store.claimNext('w1');
  check('a worker that does not hold the task is refused', (await store.complete(task.id, 'w2', {})).reason === 'not_owner');
  check('an unknown id is not found', (await store.complete(randomUUID(), 'w1', {})).reason === 'not_found');
  check('something that is not an id is not found', (await store.complete('abc', 'w1', {})).reason === 'not_found');
  const result = { homeGoals: 2, awayGoals: 1 };
  const done = await store.complete(task.id, 'w1', result);
  check('the owner can complete', done.ok === true, done);
  check('the task is done, with the result and no lease',
    done.task.status === 'done' && isDeepStrictEqual(done.task.result, result) && done.task.leaseExpiresAt === null &&
    done.task.workerId === 'w1', done.task);
  const again = await store.get(task.id);
  check('get shows the stored result', again.status === 'done' && isDeepStrictEqual(again.result, result), again);
  check('a second result for a finished task is refused', (await store.complete(task.id, 'w1', { homeGoals: 9, awayGoals: 9 })).reason === 'not_running');
  check('and did not overwrite the first', isDeepStrictEqual((await store.get(task.id)).result, result));

  console.log('--- lease');
  await drain();
  const leased = await store.add({ home: 'FRA', away: 'ARG' });
  const ghost = await store.claimNext('ghost');
  check('ghost gets the task', ghost && ghost.id === leased.id, ghost);
  check('it is not handed out again before the lease runs out', (await store.claimNext('rescuer')) === null);
  await sleep(LEASE_MS + 150);
  const rescued = await store.claimNext('rescuer');
  check('after the lease runs out another worker gets it', rescued && rescued.id === leased.id, rescued);
  check('with the new owner and attempts 2', rescued.workerId === 'rescuer' && rescued.attempts === 2, rescued);
  check('a late result from the old holder is refused', (await store.complete(leased.id, 'ghost', {})).reason === 'not_owner');
  check('the current holder can report', (await store.complete(leased.id, 'rescuer', result)).ok === true);

  console.log('--- late result, nobody else took the task');
  await drain();
  const slow = await store.add({ home: 'ITA', away: 'NED' });
  await store.claimNext('slow-worker');
  await sleep(LEASE_MS + 150);
  check('a late result is accepted while the task is still its own',
    (await store.complete(slow.id, 'slow-worker', result)).ok === true);

  console.log('--- many claims at the same time');
  await drain();
  for (let i = 0; i < 20; i++) await store.add({ n: i });
  const claims = await Promise.all(Array.from({ length: 30 }, (_, i) => store.claimNext(`par-${i}`)));
  const got = claims.filter(Boolean);
  check('20 tasks, 30 simultaneous claims: 20 workers get a task', got.length === 20, got.length);
  check('no task was handed out twice', new Set(got.map((t) => t.id)).size === 20);
  check('the other 10 get null', claims.length - got.length === 10);
  for (const t of got) await store.complete(t.id, t.workerId, {});

  if (store.close) await store.close();
  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('test crashed:', err);
  process.exit(1);
});