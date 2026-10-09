// worker/worker.js: asks the coordinator for work, runs it, sends the result back.
// Run: node worker/worker.js   (or: npm run worker)
// From another machine:
//   COORDINATOR_URL=http://192.168.1.10:3000 WORKER_ID=athlon node worker/worker.js
const { runTask } = require('./simulate');

const COORDINATOR = process.env.COORDINATOR_URL || 'http://localhost:3000';
const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}`;
const IDLE_WAIT_MS = 1000; // wait this long when there is no work
const ERROR_WAIT_MS = 2000; // wait this long after an error (e.g. coordinator down)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log(`${WORKER_ID} started, coordinator: ${COORDINATOR}`);

  while (true) {
    try {
      const res = await fetch(`${COORDINATOR}/tasks/next?worker=${encodeURIComponent(WORKER_ID)}`);

      if (res.status === 204) {
        await sleep(IDLE_WAIT_MS);
        continue;
      }
      if (res.status !== 200) {
        throw new Error(`unexpected HTTP ${res.status} from /tasks/next`);
      }

      const task = await res.json();
      const result = runTask(task.payload);

      const post = await fetch(`${COORDINATOR}/tasks/${task.id}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      });

      console.log(`task ${task.id.slice(0, 8)} -> result sent (HTTP ${post.status})`);
    } catch (err) {
      console.error('error:', err.message);
      await sleep(ERROR_WAIT_MS);
    }
  }
}

main();
