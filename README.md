# distributed-football-tournament-simulator

A small distributed task-processing system that runs on four machines in my
home network and uses them to simulate a World Cup tournament.

The simulation is the workload, not the point. The point is the distributed
systems problems around it: task distribution across heterogeneous machines,
fault tolerance, persistence and measurement.

## Status

Early development. **Stage 1 of 8** (core loop) is in progress.
See [ROADMAP.md](ROADMAP.md) for the plan and [ARCHITECTURE.md](ARCHITECTURE.md)
for the design decisions and their trade-offs.

## Running it

Requires Node.js 20 or newer. There are no dependencies to install.

```bash
npm run coordinator        # terminal 1: task queue on port 3000
npm run worker             # terminal 2: pulls tasks and runs them
npm run smoke              # terminal 3: end-to-end check of the core loop
```

A worker on another machine only needs the coordinator's address:

```bash
COORDINATOR_URL=http://192.168.1.10:3000 WORKER_ID=athlon npm run worker
```

## Layout

```
coordinator/   task queue and HTTP API
worker/        pull loop, and simulate.js with the pluggable runTask()
shared/        task format shared by both sides
scripts/       smoke test (more tooling later)
```

## Overview

- **Coordinator** holds the task queue and hands tasks out to workers.
- **Workers** pull tasks, run them and send results back. Adding a worker only
  requires the coordinator's address.
- **PostgreSQL** keeps task state so the coordinator can restart without
  losing work.
- The machines are deliberately heterogeneous (including a slow Athlon 64 X2)
  to observe how the system behaves around hardware bottlenecks.

A later version (v2) will plug an ML model into the workers. That model is
trained in a separate project, `football-strength-model`.

## License

[MIT](LICENSE)
