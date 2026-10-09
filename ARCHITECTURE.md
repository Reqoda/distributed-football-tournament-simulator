# ARCHITECTURE

> Draft. Each stage adds its own decisions to this file.
> The **[OPEN]** tag marks decisions that are not final yet.
> This document describes the target design. Look at [Road Map](ROADMAP.md) to what is ready.

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
separate repository (`distributed-football-tournament-simulator`) and shipped as `.npy` weights;
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
- The worker does not check the response code of its result upload; a rejected
  result is only logged. (stage 2)
- If a worker dies, its task stays `running` forever; nothing returns it to the
  queue. (stage 2)
- Tasks live in memory and are lost when the coordinator restarts. (stage 3)
- `claimNext` scans from the oldest task, so it slows down as finished tasks
  pile up. (stage 3, with an index)

## Task unit **[OPEN]**

To be reviewed in stage 4. Current leaning: the unit of distribution should
not be a single match but an "N iterations with this seed" batch. One task per
match would make network cost larger than the work itself. Batch size will be
decided with measurements.

## Out of scope

- Minute-by-minute event engine
- Coordinator replication (Raft)
- Kubernetes
