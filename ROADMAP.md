# ROADMAP

Each stage ends with something that runs. Completed stages are marked `[x]`.

- [x] **1. Core loop:** add a task, a worker pulls it, the result is stored (in memory)
- [ ] **2. Fault tolerance:** if a worker dies, its task returns to the queue after a timeout (heartbeat + timeout); re-runnable tasks via seeded randomness
- [ ] **3. PostgreSQL:** tasks survive a coordinator restart
- [ ] **4. Real workload** ⚠️ *to be reviewed*: tournament simulation (Poisson / Dixon-Coles), iterations split into batches. The task unit and scope will be re-evaluated when this stage is reached.
- [ ] **5. Multi-machine:** Ryzen, i5 and Athlon run on a real network; packaged with Docker Compose
- [ ] **6. Measurement:** Prometheus metrics, speedup-vs-worker-count chart, Athlon bottleneck analysis
- [ ] **7. Frontend panel**
- [ ] **8. v2:** ML model inside `runTask()` (from the `football-strength-model` repo)

Order: this project first, then the ML project. The main goal is a distributed-systems calling card; most of the value is in stages 2 to 6.
