// coordinator/store.js: where tasks live.
//
// In memory for now. Stage 3 replaces this file with a PostgreSQL version that
// exposes the same four functions, so server.js does not have to change.
const { STATUS, createTask } = require('../shared/task');

// A Map keeps insertion order, so the oldest pending task is found first (FIFO).
const tasks = new Map();

// How long a worker may hold a task before the coordinator takes it back.
// Override with LEASE_MS (the fault test uses a short one).
const LEASE_MS = Number(process.env.LEASE_MS) || 30_000;

function add(payload) {
  const task = createTask(payload);
  tasks.set(task.id, task);
  return task;
}

// Returns the task, or null if there is no such id.
function get(id) {
  return tasks.get(id) ?? null;
}

// Called when a worker asks for work (POST /tasks/claim).
// Picks the oldest pending task, marks it running for that worker and returns it.
// Returns null if there is nothing to do.
// Note: this scans from the oldest task, so it slows down as finished tasks
// pile up. That is fine for now; the database version fixes it with an index.
function claimNext(workerId) {
  const now = Date.now();
  requeueExpired(now);

  for (const task of tasks.values()) {
    if (task.status === STATUS.PENDING) {
      task.status = STATUS.RUNNING;
      task.workerId = workerId;
      task.leaseExpiresAt = now + LEASE_MS;
      task.attempts += 1;
      return task;
    }
  }
  return null;
}

// Puts every running task whose lease has run out back in the queue.
function requeueExpired(now) {
  for (const task of tasks.values()) {
    if (task.status === STATUS.RUNNING && task.leaseExpiresAt <= now){
      task.status = STATUS.PENDING;
      task.workerId = null;
      task.leaseExpiresAt = null;
    }
  }
}

// Stores a worker's result. Only a running task can be completed.
// Returns { ok: true, task } or { ok: false, reason }, where reason is
// 'not_found', 'not_running' or 'not_owner'.
function complete(id, workerId, result) {
  const task = tasks.get(id);
  if (!task) return { ok: false, reason: 'not_found' };
  if (task.status !== STATUS.RUNNING) return { ok: false, reason: 'not_running' };
  if (task.workerId !== workerId) return { ok: false, reason: 'not_owner'};

  task.status = STATUS.DONE;
  task.result = result;
  task.leaseExpiresAt = null;
  return { ok: true, task };
}

module.exports = { add, get, claimNext, complete };
