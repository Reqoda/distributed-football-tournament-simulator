# worldcup-cluster

A small distributed task-processing system that runs on four machines in my
home network and uses them to simulate a World Cup tournament.

The simulation is the workload, not the point. The point is the distributed
systems problems around it: task distribution across heterogeneous machines,
fault tolerance, persistence and measurement.

## Status

Early development. **Stage 1 of 8**, nothing to run yet.
See [ROADMAP.md](ROADMAP.md) for the plan and [ARCHITECTURE.md](ARCHITECTURE.md)
for the design decisions and their trade-offs.

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
