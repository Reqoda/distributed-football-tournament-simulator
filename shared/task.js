// shared/task.js: the task format that coordinator and workers agree on.
const { randomUUID } = require('node:crypto');

// Task lifecycle: pending -> running -> done
//   pending: waiting in the queue
//   running: handed to a worker, result not received yet
//   done:    result received
// Stage 2 will add a way for 'running' tasks to return to 'pending'
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
//   status:    STATUS value,
//   workerId:  string | null, // which worker took it
//   result:    object | null, // what the worker sent back
//   createdAt: number,        // ms since epoch
// }
function createTask(payload) {
  return {
    id: randomUUID(),
    payload,
    status: STATUS.PENDING,
    workerId: null,
    result: null,
    createdAt: Date.now(),
  };
}

// A payload must be a plain JSON object (not null, not an array).
function isValidPayload(payload) {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload);
}

module.exports = { STATUS, createTask, isValidPayload };
