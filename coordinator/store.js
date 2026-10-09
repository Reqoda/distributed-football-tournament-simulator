// coordinator/store.js: where tasks live.
//
// In memory for now. Stage 3 replaces this file with a PostgreSQL version that
// exposes the same four functions, so server.js does not have to change.
const { STATUS, createTask } = require('../shared/task');

// A Map keeps insertion order, so the oldest pending task is found first (FIFO).
const tasks = new Map();

function add(payload) {
  const task = createTask(payload);
  tasks.set(task.id, task);
  return task;
}

// Returns the task, or null if there is no such id.
function get(id) {
  return tasks.get(id) ?? null;
}

// Called when a worker asks for work (GET /tasks/next).
// Picks the oldest pending task, marks it running for that worker and returns it.
// Returns null if there is nothing to do.
// Note: this scans from the oldest task, so it slows down as finished tasks
// pile up. That is fine for now; the database version fixes it with an index.
function claimNext(workerId) {
  for (const task of tasks.values()) {
    if (task.status === STATUS.PENDING) {
      task.status = STATUS.RUNNING;
      task.workerId = workerId;
      return task;
    }
  }
  return null;
}

// Stores a worker's result. Only a running task can be completed.
// Returns { ok: true, task } or { ok: false, reason }, where reason is
// 'not_found' or 'not_running'.
function complete(id, result) {
  const task = tasks.get(id);
  if (!task) return { ok: false, reason: 'not_found' };
  if (task.status !== STATUS.RUNNING) return { ok: false, reason: 'not_running' };

  task.status = STATUS.DONE;
  task.result = result;
  return { ok: true, task };
}

module.exports = { add, get, claimNext, complete };
