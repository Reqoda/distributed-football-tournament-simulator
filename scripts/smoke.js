// scripts/smoke.js: end-to-end check of the core loop.
//
// Start the coordinator and at least one worker first, then run:
//   node scripts/smoke.js        (or: npm run smoke)
//
// It adds a task, waits for a worker to finish it and checks the result.
// It also checks the error cases of the two result endpoints.
const COORDINATOR = process.env.COORDINATOR_URL || 'http://localhost:3000';
const TIMEOUT_MS = 10_000;

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
  // 1. add a task
  const created = await call('POST', '/tasks', { payload: { home: 'TUR', away: 'BRA' } });
  check('POST /tasks returns 201 and an id', created.status === 201 && created.body?.id, `got ${created.status}`);
  const id = created.body?.id;
  if (!id) process.exit(1);

  // 2. wait until a worker finishes it
  const deadline = Date.now() + TIMEOUT_MS;
  let task = null;
  while (Date.now() < deadline) {
    const res = await call('GET', `/tasks/${id}`);
    if (res.status !== 200) {
      check('GET /tasks/:id returns 200 for an existing task', false, `got ${res.status}`);
      break;
    }
    task = res.body;
    if (task.status === 'done') break;
    await sleep(300);
  }

  check('task reaches status "done" (is a worker running?)', task?.status === 'done', `status: ${task?.status}`);
  check(
    'result has goal counts',
    Number.isInteger(task?.result?.homeGoals) && Number.isInteger(task?.result?.awayGoals),
    JSON.stringify(task?.result)
  );
  check('task remembers which worker ran it', typeof task?.workerId === 'string', `workerId: ${task?.workerId}`);

  // 3. error cases
  const missing = await call('GET', '/tasks/does-not-exist');
  check('GET /tasks/:id for an unknown id returns 404', missing.status === 404, `got ${missing.status}`);

  const noTask = await call('POST', '/tasks/does-not-exist/result', { homeGoals: 1 });
  check('POST result for an unknown id returns 404', noTask.status === 404, `got ${noTask.status}`);

  const twice = await call('POST', `/tasks/${id}/result`, { homeGoals: 9, awayGoals: 9 });
  check('POST result for an already finished task is rejected (409)', twice.status === 409, `got ${twice.status}`);

  const after = await call('GET', `/tasks/${id}`);
  check('rejected second result did not overwrite the first', after.body?.result?.homeGoals !== 9, JSON.stringify(after.body?.result));

  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test could not run:', err.message);
  process.exit(1);
});
