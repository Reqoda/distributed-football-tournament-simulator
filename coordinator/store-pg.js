// coordinator/store-pg.js: tasks kept in PostgreSQL (table: db/schema.sql).
//
// Same functions and same return values as store-memory.js. Used when the
// DATABASE_URL environment variable is set (see store.js).
//
// Two rules for every query in this file:
//  - values go in as $1, $2, ... parameters, never glued into the SQL text;
//  - one statement does one whole state change (claim, requeue, complete), so
//    two coordinators or two requests can never both win the same task.
const { Pool } = require('pg');
const { createTask } = require('../shared/task');

const name = 'postgres';

const LEASE_MS = Number(process.env.LEASE_MS) || 30_000;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// An idle connection can break (database restarted, network cut). Without this
// handler Node treats the pool's 'error' event as uncaught and kills the process.
pool.on('error', (err) => console.error('postgres pool error:', err.message));

// The id column is a uuid. Asking Postgres for id = 'abc' is an error, not an
// empty result, so ids that cannot exist are answered here.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Database row (snake_case, Date objects) -> task shape from shared/task.js
// (camelCase, ms since epoch), so callers see the same thing as with the memory store.
function toTask(row) {
  return {
    id: row.id,
    payload: row.payload,
    status: row.status,
    workerId: row.worker_id,
    result: row.result,
    createdAt: row.created_at.getTime(),
    leaseExpiresAt: row.lease_expires_at ? row.lease_expires_at.getTime() : null,
    attempts: row.attempts,
  };
}

async function add(payload) {
  const task = createTask(payload); // makes the id and adds the seed
  const { rows } = await pool.query(
    'INSERT INTO tasks (id, payload) VALUES ($1, $2::jsonb) RETURNING *',
    [task.id, JSON.stringify(task.payload)]
  );
  return toTask(rows[0]);
}

// Returns the task, or null if there is no such id.
async function get(id) {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
  return rows[0] ? toTask(rows[0]) : null;
}

// Puts every running task whose lease has run out back in the queue.
// One set-based UPDATE; the partial index tasks_running_lease_idx finds them.
async function requeueExpired() {
  await pool.query(
    `UPDATE tasks
        SET status = 'pending', worker_id = NULL, claimed_at = NULL, lease_expires_at = NULL
      WHERE status = 'running' AND lease_expires_at <= now()`
  );
}

// Oldest pending task -> running for this worker. Returns it, or null.
// FOR UPDATE SKIP LOCKED: if another claim is already holding the oldest row,
// this one skips it and takes the next, instead of waiting or taking the same one.
async function claimNext(workerId) {
  await requeueExpired();
  const { rows } = await pool.query(
    `UPDATE tasks
        SET status = 'running', worker_id = $1, claimed_at = now(),
            lease_expires_at = now() + $2::double precision * interval '1 millisecond',
            attempts = attempts + 1
      WHERE id = (SELECT id FROM tasks
                   WHERE status = 'pending'
                   ORDER BY created_at
                   LIMIT 1
                   FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [workerId, LEASE_MS]
  );
  return rows[0] ? toTask(rows[0]) : null;
}

// Stores a worker's result. Only a running task can be completed, and only by
// the worker that holds it.
// Returns { ok: true, task } or { ok: false, reason }, where reason is
// 'not_found', 'not_running' or 'not_owner'.
async function complete(id, workerId, result) {
  if (!UUID_RE.test(id)) return { ok: false, reason: 'not_found' };

  // The rule is in the WHERE clause, so checking and updating are one step.
  const { rows } = await pool.query(
    `UPDATE tasks
        SET status = 'done', result = $3::jsonb, finished_at = now(), lease_expires_at = NULL
      WHERE id = $1 AND status = 'running' AND worker_id = $2
      RETURNING *`,
    [id, workerId, JSON.stringify(result)]
  );
  if (rows[0]) return { ok: true, task: toTask(rows[0]) };

  // Nothing was updated. Look again only to tell the caller why. The task can
  // change between the two statements; the reason is then slightly out of date,
  // which is fine for an error message.
  const { rows: found } = await pool.query('SELECT status FROM tasks WHERE id = $1', [id]);
  if (!found[0]) return { ok: false, reason: 'not_found' };
  if (found[0].status !== 'running') return { ok: false, reason: 'not_running' };
  return { ok: false, reason: 'not_owner' };
}

// Closes all connections (scripts and tests call this so the process can exit).
async function close() {
  await pool.end();
}

module.exports = { name, add, get, claimNext, complete, close };