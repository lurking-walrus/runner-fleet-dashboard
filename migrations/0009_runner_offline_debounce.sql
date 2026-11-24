-- Consecutive polls in which GitHub has reported this runner offline. GitHub's runners API can
-- report every runner offline for minutes at a time while they run jobs (2026-11-24 from 03:02 UTC),
-- so a runner is shown offline only once this reaches OFFLINE_CONFIRM_POLLS.
ALTER TABLE runners ADD COLUMN offline_reports INTEGER NOT NULL DEFAULT 0;
