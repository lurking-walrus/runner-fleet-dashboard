-- Daily per-key rollups (exact nearest-rank p50/p90, max, total) written once when a UTC day is
-- complete, so a multi-week trend reads a few hundred small rows instead of every raw step row.
-- kind: 'job' | 'step' | 'pool_queue' (key = pool) | 'pool_run' (key = pool).
-- Job/step keys are repo, workflow, job[, step] and pool joined by char(31).
CREATE TABLE timing_daily (
  day TEXT NOT NULL,            -- YYYY-MM-DD (UTC, by the job's finish time)
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  n INTEGER NOT NULL,
  p50 INTEGER NOT NULL,
  p90 INTEGER NOT NULL,
  max_s INTEGER NOT NULL,
  total_s INTEGER NOT NULL,
  PRIMARY KEY (day, kind, key)
) WITHOUT ROWID;

-- Which days have been rolled up (a day with no jobs has no timing_daily rows but is still done).
CREATE TABLE timing_daily_done (
  day TEXT PRIMARY KEY,
  rolled_at TEXT NOT NULL
);

-- Computed report sections, so a page load never re-aggregates raw rows more often than the TTL.
-- D1 free allows 5M rows read/day and a 7 d step aggregation reads ~100k.
CREATE TABLE report_cache (
  name TEXT PRIMARY KEY,
  computed_at TEXT NOT NULL,
  body TEXT NOT NULL
);
