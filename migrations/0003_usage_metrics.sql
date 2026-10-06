-- Finished jobs, one row per job, written by the poller when a busy runner's job
-- leaves in_progress. Feeds the per-pool "how much is this host actually used" stats.
CREATE TABLE job_history (
  job_id INTEGER PRIMARY KEY,
  pool TEXT NOT NULL,
  runner_name TEXT NOT NULL,
  repo TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  job_name TEXT NOT NULL,
  run_url TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_s INTEGER NOT NULL,
  conclusion TEXT
);
CREATE INDEX idx_job_history_pool_finished ON job_history(pool, finished_at DESC);

-- Telemetry time series, thinned to one sample per host per ~5 minutes and pruned
-- after 7 days (the `telemetry` table only keeps the latest snapshot).
CREATE TABLE telemetry_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  ts TEXT NOT NULL,
  cpu_pct REAL NOT NULL,
  mem_pct REAL NOT NULL,
  load_avg_1m REAL
);
CREATE INDEX idx_telemetry_samples_host_ts ON telemetry_samples(host, ts DESC);
