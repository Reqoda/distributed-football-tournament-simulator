-- db/schema.sql: the tasks table (stage 3).
--
-- Loaded automatically by docker-compose the first time the database is
-- created. After changing this file: `docker compose down -v`, then `up -d`.

CREATE TABLE tasks (
  id               uuid        PRIMARY KEY,
  payload          jsonb       NOT NULL,
  status           text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'running', 'done')),
  worker_id        text,        -- who holds (or last held) the task
  result           jsonb,       -- set when the task is done
  attempts         integer     NOT NULL DEFAULT 0,  -- how many times it was claimed
  -- clock_timestamp() instead of now(): now() is frozen for the whole
  -- transaction, so tasks inserted together would tie and lose their FIFO order.
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at       timestamptz,
  finished_at      timestamptz,
  lease_expires_at timestamptz,

  -- A running task always has an owner and a deadline.
  CONSTRAINT running_has_owner_and_lease
    CHECK (status <> 'running' OR (worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)),
  -- A finished task always has a result and a finish time.
  CONSTRAINT done_has_result
    CHECK (status <> 'done' OR (result IS NOT NULL AND finished_at IS NOT NULL))
);

-- claimNext: "oldest pending task". Partial index = only pending rows are
-- indexed, so it stays small however many finished tasks pile up.
CREATE INDEX tasks_pending_idx ON tasks (created_at) WHERE status = 'pending';

-- requeueExpired: "running tasks whose lease has run out".
CREATE INDEX tasks_running_lease_idx ON tasks (lease_expires_at) WHERE status = 'running';