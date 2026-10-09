-- Consecutive failed polls, so a broken credential raises an alert instead of just a red label
-- on a page nobody is looking at. last_alert_at throttles repeat alerts for a long outage.
ALTER TABLE poll_state ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE poll_state ADD COLUMN last_alert_at TEXT;
