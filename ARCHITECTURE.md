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

### Tasks must be re-runnable (idempotent)
If a worker dies, its task is handed to another worker. Randomness is
derived from a seed that travels with the task, so running the same task
twice produces the same result.

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
two workers can never receive the same task. This holds because Node.js runs
JavaScript on a single thread and the loop contains no `await`, so no other
request can run between the check and the update. A database will not give this
for free: stage 3 has to guarantee it explicitly.
 
### Completing a task that is not running returns 409
`POST /tasks/:id/result` only succeeds for a running task. A pending or already
finished task gets `409 Conflict`, an unknown id gets `404`. This keeps a late
or duplicate result from overwriting the first one, which matters as soon as
stage 2 can hand the same task to a second worker.
 
### `store.js` is a four-function contract
`server.js` only knows `add`, `get`, `claimNext` and `complete`, and the shapes
they return (`complete` gives `{ ok, task }` or `{ ok: false, reason }`). It
does not know where tasks are kept. Stage 3 replaces the in-memory `Map` with
PostgreSQL behind the same four functions, so `server.js` does not change.
 
### Known limitations
- Tasks live in memory and are lost when the coordinator restarts. (stage 3)
- `claimNext` scans from the oldest task, so it slows down as finished tasks
  pile up. (stage 3, with an index)

## Stage 2: fault tolerance

What exists: a task that a worker takes but never finishes goes back to the
queue, and running the same task twice gives the same result.

### A claim is a lease
When `claimNext` gives a task to a worker it also sets `leaseExpiresAt` to
`now + LEASE_MS` (default 30 s, override with the `LEASE_MS` environment
variable) and increases `attempts`. If the result does not arrive before the
deadline, the coordinator takes the task back. Only the coordinator ever
compares times, using its own clock, so the clocks of the workers do not matter.

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
If a worker finishes after its lease ran out, the coordinator answers `409`
when the task is already done. The worker logs it, throws the result away and
asks for new work, without waiting: this is a normal situation, not an error.
Any other unexpected status is treated as an error, like a failed request.

### Tests
- `npm run fault`: needs a fresh coordinator started with `LEASE_MS=1000` and no
  worker. A fake worker takes a task and never reports; a second one gets it
  after the lease expires.
- `npm run determinism`: same seed gives the same result, different seeds give
  different scores, and every new task gets a seed.

### Known limitations
- There is no heartbeat. A worker cannot extend its lease, so `LEASE_MS` must be
  longer than the longest task. Node.js runs a worker's computation on one
  thread, so a timer that sends heartbeats cannot run while the computation is
  running. This will matter in stage 4, when tasks get longer. A heartbeat would
  need the computation to run in a separate thread (`worker_threads`) or a longer
  lease.
- `GET /tasks/:id` shows the stored state. A task whose lease has run out still
  looks `running` until the next worker asks for work.
- A late result is accepted if the task is `running` again under another worker,
  because `complete` only checks the status, not who sent the result. This is
  harmless because both results are the same, but `workerId` then names the
  worker that claimed the task last, which is not always the one that delivered
  the result.
- `attempts` is counted but nothing limits it. A task that crashes every worker
  is retried forever.
- `requeueExpired` goes through all tasks on every claim, like the search for
  the next pending task. (stage 3, with an index)

## Task unit **[OPEN]**

To be reviewed in stage 4. Current leaning: the unit of distribution should
not be a single match but an "N iterations with this seed" batch. One task per
match would make network cost larger than the work itself. Batch size will be
decided with measurements.

## Out of scope

- Minute-by-minute event engine
- Coordinator replication (Raft)
- Kubernetes
