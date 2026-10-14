# ARCHITECTURE

> Draft. Each stage adds its own decisions to this file.
> The **[OPEN]** tag marks decisions that are not final yet.
> This document describes the target design. See [Road Map](ROADMAP.md) to what is ready.

## Goal

Run three home machines as a single cluster and execute a World Cup
simulation with a real computational load, in a distributed way. This is not
a "DevOps tool": the point is to actually face and solve distributed-systems
problems such as task distribution, fault tolerance and measurement.

## Hardware

| Machine | Role |
|---|---|
| Ryzen 5 2600 + 16GB | Coordinator + frontend |
| i5 2450M + 4GB | Worker |
| Athlon 64 X2 5200+ + 4GB | Worker (deliberately slow, to observe hardware bottlenecks) |

The machines are heterogeneous. This is not a limitation but a deliberate
part of the design: a slow worker must not break the system, it should simply
receive less work.

## Components

```
 Ryzen 5                         Workers (i5, Athlon, ...)
┌───────────────────┐  ask work  ┌──────────────┐
│    Coordinator    │◄───────────│    Worker    │
│   (task queue)    │───────────►│  runTask()   │
│        │          │    task    └──────────────┘
│   PostgreSQL      │◄───────────  sends result
└───────────────────┘
```

- **Coordinator:** stores tasks, hands them out to workers, tracks their state.
- **Worker:** pulls work from the coordinator, runs it, sends the result back.
  The actual work lives in `runTask()`, which is pluggable.
- **PostgreSQL:** persistent state for tasks and configuration.
- **Frontend:** control panel (deliberately left for last).

## Decisions

### Pull model: workers ask for work, the coordinator does not push
The coordinator never needs to know worker addresses; adding a worker only
requires giving it the coordinator's address. A fast worker polls often and a
slow one polls rarely, so load balancing emerges on its own without a
separate mechanism. Cost: idle workers send empty requests (mitigated with a
short sleep between polls).

### The coordinator is a single point of failure (SPOF), by design
Multiple coordinators would need consensus (Raft), which would expand the
scope of this project considerably. If the coordinator crashes, the system
stops; since state lives in PostgreSQL, it resumes where it left off after a
restart. Raft-based replication is left as a possible future extension.

### Configuration changes apply to new tasks only
Running tasks never change their parameters. The settings a task ran with are
always known, so results stay reproducible.

### Tasks must be re-runnable, and a result is recorded once
If a worker dies, its task is handed to another worker. Two separate rules make
that safe:

- **Deterministic execution.** Randomness is derived from a seed that travels
  with the task, so running the same task twice produces the same result.
- **Idempotent result commit.** The coordinator accepts a result only for a
  running task, and only from the worker that currently holds it. Every other
  result is rejected, so the first valid one is the only one recorded.

Determinism alone is not enough: two identical results would still be stored
twice. The commit rule is what guarantees a result is recorded once.

### Pluggable `runTask()`
v1 uses a statistical model (Poisson / Dixon-Coles); v2 uses an ML model.
The worker and the coordinator do not change. The ML model is trained in a
separate repository (`football-strength-model`) and shipped as `.npy` weights;
workers run inference with NumPy only, so old CPUs like the Athlon do not
hit AVX dependency problems.

### Technology choices
- **Node.js** for coordinator and worker. Go is only a separate learning track.
- **PostgreSQL** for queue and state. Redis is added only if a real need appears.
- **Docker Compose** for deployment. Kubernetes would be unnecessary
  complexity for three machines and is out of scope for v1.
- **Prometheus** for metrics.

## Stage 1: core loop

What exists: a coordinator with an in-memory task store, workers that pull
tasks over HTTP, and a smoke test that checks the whole loop.

### Task lifecycle
A task moves `pending -> running -> done`. The coordinator makes both
transitions: `claimNext` marks a task running when a worker asks for work, and
`complete` marks it done when the result arrives. A worker never changes a
task's status itself; it only asks for work and reports a result.

### Claiming a task is atomic
`claimNext` finds the oldest pending task and marks it running in one step, so
two workers can never receive the same task. In the in-memory store this holds
because Node.js runs JavaScript on a single thread and the loop contains no
`await`, so no other request can run between the check and the update. A
database does not give this for free; the PostgreSQL store guarantees it with a
single SQL statement (see stage 3).

### Completing a task that is not running returns 409
`POST /tasks/:id/result` only succeeds for a running task. A pending or already
finished task gets `409 Conflict`, an unknown id gets `404`. This keeps a late
or duplicate result from overwriting the first one, which matters as soon as
stage 2 can hand the same task to a second worker.

### The store is a four-function contract
`server.js` only knows `add`, `get`, `claimNext` and `complete`, and the shapes
they return (`complete` gives `{ ok, task }` or `{ ok: false, reason }`). It
does not know where tasks are kept. Stage 3 put PostgreSQL behind the same four
functions; they became asynchronous and `server.js` gained `await`, nothing else.

### Known limitations
- Tasks live in memory and are lost when the coordinator restarts. (solved by the
  PostgreSQL store in stage 3)
- `claimNext` scans from the oldest task, so it slows down as finished tasks
  pile up. (solved in the PostgreSQL store with an index; the in-memory store
  still scans)

## Stage 2: fault tolerance

What exists: a task that a worker takes but never finishes goes back to the
queue, and running the same task twice gives the same result.

### A claim is a lease
When `claimNext` gives a task to a worker it also sets `leaseExpiresAt` to
`now + LEASE_MS` (default 30 s, override with the `LEASE_MS` environment
variable) and increases `attempts`. If the result does not arrive before the
deadline, the coordinator takes the task back. Only the coordinator ever
compares times, using its own clock, so the clocks of the workers do not matter.
(With PostgreSQL the clock is the database's, see stage 3.)

### Expired leases are noticed when a worker asks for work
`claimNext` first calls `requeueExpired(now)`, which puts every running task
whose lease has run out back to `pending`, and only then looks for a task to
hand out. There is no background timer, so there is no second thing that can
run at the same time as the claim loop. A requeued task keeps its place in the
queue, so it is the first one to be retried. `attempts` is not reset: it counts
how many times the task has been claimed.

### Re-running is safe because of seeds
The seed is stored in the task's payload (`payload.seed`). `createTask` adds a
random one unless the caller provides one, and `runTask` builds a replayable
random number generator from it (`worker/rng.js`), so the same payload always
gives the same result. If two workers end up running the same task, they
produce the same answer.

### A worker drops a result the coordinator rejects
If a worker finishes after it lost its task (the lease ran out and the task is done
or runs under another worker), the coordinator answers `409`. The worker logs it,
throws the result away and asks for new work, without waiting: this is a normal
situation, not an error. Any other unexpected status is treated as an error, like a
failed request.

### Tests
- `npm run fault`: needs a fresh coordinator started with `LEASE_MS=1000` and no
  worker. A fake worker takes a task and never reports; a second one gets the task
  after the lease expires. It also checks that only the current holder of a task
  can report its result. With PostgreSQL the table must be empty first.
- `npm run determinism`: same seed gives the same result, different seeds give
  different scores, and every new task gets a seed.

### Only the worker that holds a task can report its result
A result is sent as `POST /tasks/:id/result?worker=<name>`, and `complete`
accepts it only if the task is running and its `workerId` is that worker. A late
worker is rejected with `409` even while the task runs under someone else, so a
stale result can never overwrite or be mixed with the current holder's. If the
lease ran out but nobody else took the task, the late result is still accepted:
the work is not wasted. Status codes: `404` unknown task, `409` not running or
not the owner, `400` missing `?worker`.

### Claiming is a POST
Claiming changes state (it starts a lease), so it is `POST /tasks/claim?worker=<name>`
and not a GET, which must be safe to repeat or retry. It answers `200` with the
task, `204` when there is no work, and `400` when `?worker` is missing.

### Known limitations
- There is no heartbeat. A worker cannot extend its lease, so `LEASE_MS` must be
  longer than the longest task. Node.js runs a worker's computation on one
  thread, so a timer that sends heartbeats cannot run while the computation is
  running. This will matter in stage 4, when tasks get longer. A heartbeat would
  need the computation to run in a separate thread (`worker_threads`) or a longer
  lease.
- `GET /tasks/:id` shows the stored state. A task whose lease has run out still
  looks `running` until the next worker asks for work.
- `attempts` is counted but nothing limits it. A task that crashes every worker
  is retried forever.
- `requeueExpired` goes through all tasks on every claim in the in-memory store.
  (solved in the PostgreSQL store with an index)
- Worker ids are names chosen by the workers, not authenticated. Two workers with
  the same id are treated as one.

## Stage 3: PostgreSQL

What exists: tasks live in a PostgreSQL table and survive a coordinator
restart. Without `DATABASE_URL` the coordinator still runs with the in-memory
store, which keeps development and the quick tests free of Docker.

### Two stores, one contract
`coordinator/store.js` only picks one of two modules: `store-pg.js` when
`DATABASE_URL` is set, `store-memory.js` otherwise. Both export the same four
functions and return the same task shape (camelCase fields, times as ms since
epoch), and every function is `async`, so a caller that forgets `await` breaks
with both. `npm run store:memory` and `npm run store:pg` run the same checks
against each, so the two cannot drift apart silently. The `pg` module is loaded
only when PostgreSQL is used.

### The schema carries rules, not only data
`db/schema.sql` creates one table, `tasks`. Besides the columns it holds three
`CHECK` rules: `status` is one of `pending`, `running`, `done`; a `running` task
always has an owner and a lease deadline; a `done` task always has a result and
a finish time. A bug that writes a half-finished row is refused by the database
instead of being stored. `created_at` defaults to `clock_timestamp()` rather than
`now()`: `now()` is frozen for a whole transaction, so tasks inserted together
would tie and lose their first-in-first-out order.

`claimed_at` and `finished_at` are for information and nothing reads them yet.
`finished_at` is the moment the coordinator accepted the result, not the moment
the worker finished computing, and `claimed_at` is the latest claim only. They
are not a measure of compute time. That will come from the worker itself
(stage 6, see the roadmap).

### One statement per state change
Claiming, requeueing and completing are each a single SQL statement, so two
requests, or two coordinators, can never both win the same task:

- **Claim:** `UPDATE ... WHERE id = (SELECT id ... WHERE status = 'pending'
  ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`.
- **Requeue:** one set-based `UPDATE` for every running task whose lease has
  run out. It runs at the start of each claim, so expiry is still noticed lazily,
  as in stage 2.
- **Complete:** the commit rule from stage 2 is the `WHERE` clause
  (`id = $1 AND status = 'running' AND worker_id = $2`). When it matches no row,
  a second `SELECT` only works out the reason (`not_found`, `not_running` or
  `not_owner`) for the error message. The task can change between the two
  statements, so the reason can be slightly out of date. That is fine for a
  message; the commit itself is never affected.

`SKIP LOCKED` is about speed, not correctness. Without it PostgreSQL also never
hands one task to two claims: a claim that waits on a locked row re-checks it and
moves on. But claims then queue behind each other. In a local micro-benchmark
(16 clients, each holding its row for 10 ms) the claim query ran at about 1270
transactions per second with `SKIP LOCKED` and about 88 without. Treat the numbers
as an indication for one machine, not a result.

Two partial indexes keep these queries small however many finished tasks pile up:
one on pending tasks by `created_at` (the oldest pending task), one on running
tasks by `lease_expires_at` (expired leases). This replaces the full scans of the
in-memory store.

### The database clock decides when a lease ends
`lease_expires_at` is set with `now() + LEASE_MS` and compared with `now()`, both
on the database. The coordinator does not compare times in this store, so
nothing depends on its clock either.

### Errors: 400 for the client, 500 for us
An error the client caused (bad JSON, a body over 1 MB) is created with
`status = 400` and sent back with its message. Any other error is a bug or a
failure on our side, such as a database that cannot be reached: it is logged on
the server and the client only gets `{ "error": "internal server error" }`, so
table and column names never leave the coordinator. The request URL is parsed
inside the `try` block, so a malformed request line or `Host` header gets an
answer instead of crashing the process. A body that is too large is also `400`,
not `413`, because the connection is closed to stop reading it and the client
would never see the status.

The PostgreSQL pool has an `error` handler. A broken idle connection (database
restarted, network cut) emits an event on the pool, and an unhandled one would
terminate the process.

### Ids
`id` is a `uuid`. Asking PostgreSQL for `id = 'abc'` is an error, not an empty
result, so `get` and `complete` answer ids that cannot exist with "not found"
before touching the database.

### Tests
- `npm run store:memory` and `npm run store:pg` (the second one empties the
  table): adding, claiming in order, ownership, leases, a late result, and 30
  simultaneous claims for 20 tasks.
- The other tests (`smoke`, `determinism`, `fault`) pass with both stores.
- Checked by hand: kill the coordinator with tasks running and pending; after the
  restart both are still there, and the running one goes to another worker once
  its lease runs out (`attempts` 2).

### Known limitations
- There are no migrations. `db/schema.sql` is loaded only when the database is
  created, so a change means `docker compose down -v` and losing the data. This
  is acceptable while the schema is still moving.
- Expired leases are still noticed only when a worker asks for work, so
  `GET /tasks/:id` can show a stale `running`.
- A finished run leaves its tasks in the table, so the next `fault` run needs an
  empty one.
- The coordinator is still a single process (see the SPOF decision above). The
  database could support several, but nothing has been designed or tested for it.
- The connection string and password in `docker-compose.yml` are for local
  development only.

## Task unit **[OPEN]**

To be reviewed in stage 4. Current leaning: the unit of distribution should
not be a single match but an "N iterations with this seed" batch. One task per
match would make network cost larger than the work itself. Batch size will be
decided with measurements.

## Out of scope

- Minute-by-minute event engine
- Coordinator replication (Raft)
- Kubernetes