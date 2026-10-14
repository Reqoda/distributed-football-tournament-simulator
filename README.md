# distributed-football-tournament-simulator

A small distributed task-processing system that runs on three machines in my
home network and uses them to simulate a World Cup tournament.

The simulation is the workload, not the point. The point is the distributed
systems problems around it: task distribution across heterogeneous machines,
fault tolerance, persistence and measurement.

## Status

Early development. **Stages 1 to 3 of 8** (core loop, fault tolerance,
PostgreSQL) are done; stage 4 (a real workload) is next.
See [ROADMAP.md](ROADMAP.md) for the plan and [ARCHITECTURE.md](ARCHITECTURE.md)
for the design decisions and their trade-offs.

## Running it

Requires Node.js 20 or newer. Run `npm install` once (the only dependency is
`pg`, used by the PostgreSQL store).

The coordinator keeps its tasks in memory by default. Set `DATABASE_URL` and it
uses PostgreSQL instead (see below).

```bash
npm run coordinator        # terminal 1: task queue on port 3000
npm run worker             # terminal 2: pulls tasks and runs them
npm run smoke              # terminal 3: end-to-end check of the core loop
npm run determinism        # needs no servers: same seed, same result
npm run store:memory       # needs no servers: the in-memory store follows its contract
```

The fault test needs its own coordinator with a short lease and no worker:

```bash
LEASE_MS=1000 npm run coordinator   # terminal 1
LEASE_MS=1000 npm run fault         # terminal 2
```

### With PostgreSQL

```bash
docker compose up -d       # PostgreSQL 17, reachable on 127.0.0.1:5433
export DATABASE_URL=postgres://tournament:tournament@127.0.0.1:5433/tournament
npm run coordinator        # prints "(store: postgres)" when it is used
npm run store:pg           # same contract test as the memory store; EMPTIES the tasks table
```

Tasks now survive a coordinator restart. That also means a new run starts with
whatever the last one left behind: before `npm run fault`, empty the table with
`docker compose exec postgres psql -U tournament -c 'TRUNCATE tasks'`.
`db/schema.sql` is loaded only when the database is created; after changing it,
run `docker compose down -v` and start again. The password in
`docker-compose.yml` is for local development only.

A worker on another machine only needs the coordinator's address:

```bash
COORDINATOR_URL=http://192.168.1.10:3000 WORKER_ID=athlon npm run worker
```

## Layout

```
coordinator/   HTTP API and the task store (memory or PostgreSQL)
worker/        pull loop, and simulate.js with the pluggable runTask()
shared/        task format shared by both sides
db/            schema.sql, the tasks table
scripts/       smoke, fault, determinism and store contract tests
docker-compose.yml   local PostgreSQL for development
```

## Overview

- **Coordinator** holds the task queue and hands tasks out to workers.
- **Workers** pull tasks, run them and send results back. Adding a worker only
  requires the coordinator's address.
- **PostgreSQL** keeps task state so the coordinator can restart without
  losing work. Without `DATABASE_URL` the same code runs with an in-memory store.
- The machines are deliberately heterogeneous (including a slow Athlon 64 X2)
  to observe how the system behaves around hardware bottlenecks.

A later version (v2) will plug an ML model into the workers. That model is
trained in a separate project, `football-strength-model`.

## License

[MIT](LICENSE)