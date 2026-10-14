# ROADMAP

Each stage ends with something that runs. Completed stages are marked `[x]`.

- [x] **1. Core loop:** add a task, a worker pulls it, the result is stored (in memory)
- [x] **2. Fault tolerance:** if a worker dies, its task returns to the queue after a lease timeout; re-runnable tasks via seeded randomness
- [x] **3. PostgreSQL:** tasks survive a coordinator restart; the queue is claimed with SQL, behind the same store contract as the in-memory version
- [ ] **4. Real workload** ⚠️ *to be reviewed*: tournament simulation (Poisson / Dixon-Coles), iterations split into batches. The task unit and scope will be re-evaluated when this stage is reached. Long tasks will also need a heartbeat or a longer lease (see stage 2).
- [ ] **5. Multi-machine:** Ryzen, i5 and Athlon run on a real network; packaged with Docker Compose
- [ ] **6. Measurement:** Prometheus metrics, speedup-vs-worker-count chart, Athlon bottleneck analysis. Workers measure their own compute time and send it next to the result; the coordinator stores it in a separate `duration_ms` column (not inside `result`, which must stay deterministic)
- [ ] **7. Frontend panel**
- [ ] **8. v2:** ML model inside `runTask()` (from the `football-strength-model` repo)

Order: this project first, then the ML project. The main goal is a distributed-systems calling card; most of the value is in stages 2 to 6.