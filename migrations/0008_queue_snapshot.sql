-- The latest "what is waiting for a runner right now" snapshot: one row, replaced each time it is
-- taken, so the dashboard's 20-second poll reads one row, not GitHub.
CREATE TABLE queue_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  taken_at TEXT NOT NULL,
  body TEXT NOT NULL
);
