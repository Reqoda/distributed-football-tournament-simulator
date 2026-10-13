// shared/task.js: the task format that coordinator and workers agree on.
const { randomUUID, randomInt } = require('node:crypto');

// Task lifecycle: pending -> running -> done
//   pending: waiting in the queue
//   running: handed to a worker, result not received yet
//   done:    result received
// If a worker dies, its task's lease runs out and the task goes back to 'pending' so another worker can take it.
// when a worker dies.
const STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
});

// Shape of a task:
// {
//   id:        string,        // unique id
//   payload:   object,        // what to compute, e.g. { home: 'TUR', away: 'BRA' }
//                             // seed is added automatically if the caller does not give one
//   status:    STATUS value,
//   workerId:  string | null, // which worker took it
//   result:    object | null, // what the worker sent back
//   createdAt: number,        // ms since epoch
//   leaseExpiresAt: number | null, // while running: when the claim runs out (ms since epoch)
//   attempts:  number        // how many times a worker has claimed it
function createTask(payload) {
  return {
    id: randomUUID(),
    payload: { seed: randomInt(0, 2 ** 31 - 1), ...payload},
    status: STATUS.PENDING,
    workerId: null,
    result: null,
    createdAt: Date.now(),
    leaseExpiresAt: null,
    attempts: 0
  };
}

// A payload must be a plain JSON object (not null, not an array).
function isValidPayload(payload) {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload);
}

module.exports = { STATUS, createTask, isValidPayload };
