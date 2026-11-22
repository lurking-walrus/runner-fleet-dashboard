-- Job history is now synced from GitHub's completed workflow runs instead of being inferred from
-- busy runners the poller happened to see. The old approach recorded almost nothing for an
-- ephemeral fleet: a JIT runner deregisters the moment its job ends, so the poller pruned it (and
-- its current_jobs row) before it could log the finished job, and jobs shorter than the 2-minute
-- poll interval were never seen at all.

-- One row per (run, attempt) whose jobs have been copied into job_history, so each completed run
-- is fetched once. Pruned once a run falls out of the 24h lookback window (plus a day of margin).
CREATE TABLE synced_runs (
  run_key TEXT PRIMARY KEY,     -- "<owner>/<repo>#<run_id>.<run_attempt>"
  synced_at TEXT NOT NULL
);
