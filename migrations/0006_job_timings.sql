-- Per-job queue time and per-step durations, so the dashboard can say how long work takes and
-- which jobs/steps are worth speeding up.
--
-- Both come from the jobs API response the history sync already fetches (created_at, labels and
-- steps[] are in the same payload as started_at/completed_at), so capturing them costs ZERO extra
-- GitHub calls. A completed job's steps never change, so they are written once, with the job.

ALTER TABLE job_history ADD COLUMN created_at TEXT;   -- when the job was created (queued)
ALTER TABLE job_history ADD COLUMN queue_s INTEGER;   -- started_at - created_at, never negative
ALTER TABLE job_history ADD COLUMN labels TEXT;       -- requested runs-on labels, canonical order, comma-joined
-- job_history.duration_s is already the run time (started -> completed).

-- Windowed reads filter on finished_at alone (the existing index leads with pool).
CREATE INDEX idx_job_history_finished ON job_history(finished_at);

-- One row per executed step (skipped steps have no timestamps and are not stored).
CREATE TABLE job_steps (
  job_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,          -- GitHub's step number within the job
  name TEXT NOT NULL,
  duration_s INTEGER NOT NULL,   -- completed_at - started_at, never negative
  conclusion TEXT,
  PRIMARY KEY (job_id, seq)
) WITHOUT ROWID;

-- The jobs already in job_history were written without timings. Forget which runs were synced so
-- the next ticks re-fetch the last 24 h once and fill them in (the history sync keeps its usual
-- per-tick cap, newest runs first, so the backlog drains over a few hours). Jobs that already
-- exist keep their row and event history; only the new columns and their steps are added.
DELETE FROM synced_runs;
