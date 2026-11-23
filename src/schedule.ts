import { runPoll, snapshotQueue, syncJobHistory } from "./poller";
import type { Env } from "./types";

// The history sync runs on the 2-minute cron's ticks that land on a multiple of 10 minutes, in
// place of that tick's runner poll. It used to be its own "*/10" cron, but this account is on the
// Workers Free plan (5 cron triggers per ACCOUNT) and other Workers hold the other four: every
// deploy since that cron was added failed with "reached the Workers Free limit of 5 cron
// triggers", and the */10 schedule was never registered, so job_history (the per-pool usage line
// and job_failed events) stopped filling. One trigger, two jobs, still one job per invocation, so
// each keeps its own subrequest budget.
const HISTORY_SYNC_EVERY_MINUTES = 10;
// The queued-jobs snapshot takes the tick 4 minutes after each history sync (also one job per
// invocation, so it has its own GitHub-call budget). The runner poll keeps the other three ticks of
// every five, so it still runs at least every 4 minutes.
const QUEUE_SNAPSHOT_MINUTE_OFFSET = 4;

export type ScheduledJob = "history" | "queue" | "poll";

/**
 * Which job a tick of the one 2-minute schedule runs. One job per invocation, so the history sync's
 * GitHub calls don't eat into the runner poll's per-invocation budget. Shared by the Worker's cron
 * and the AWS EventBridge rule (src/aws/handler.ts), so both deployments run the same job each tick.
 */
export function scheduledJobFor(scheduledTimeMs: number): ScheduledJob {
  const minute = new Date(scheduledTimeMs).getUTCMinutes();
  if (minute % HISTORY_SYNC_EVERY_MINUTES === 0) return "history";
  if (minute % HISTORY_SYNC_EVERY_MINUTES === QUEUE_SNAPSHOT_MINUTE_OFFSET) return "queue";
  return "poll";
}

export function runScheduledJob(env: Env, job: ScheduledJob): Promise<void> {
  if (job === "history") return syncJobHistory(env);
  if (job === "queue") return snapshotQueue(env);
  return runPoll(env);
}

