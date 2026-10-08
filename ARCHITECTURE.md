# ARCHITECTURE

> Draft. Each stage adds its own decisions to this file.
> The **[OPEN]** tag marks decisions that are not final yet.

## Goal

Run four home machines as a single cluster and execute a World Cup
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
  complexity for four machines and is out of scope for v1.
- **Prometheus** for metrics.

## Task unit **[OPEN]**

To be reviewed in stage 4. Current leaning: the unit of distribution should
not be a single match but an "N iterations with this seed" batch. One task per
match would make network cost larger than the work itself. Batch size will be
decided with measurements.

## Out of scope

- Minute-by-minute event engine
- Coordinator replication (Raft)
- Kubernetes
