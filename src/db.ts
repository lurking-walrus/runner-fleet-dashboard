import type { GhRunner, ResolvedJob } from "./types";
import { derivePool, type CompletedSelfHostedJob } from "./github";

export async function upsertRunner(db: D1Database, runner: GhRunner, scopeLabel: string, now: string) {
  await db
    .prepare(
      `INSERT INTO runners (name, scope, os, status, busy, version, labels_json, pool, first_seen, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         scope = excluded.scope, os = excluded.os, status = excluded.status,
         busy = excluded.busy, version = excluded.version, labels_json = excluded.labels_json,
         pool = excluded.pool, updated_at = excluded.updated_at`,
    )
    .bind(
      runner.name,
      scopeLabel,
      runner.os ?? "",
      runner.status,
      runner.busy ? 1 : 0,
      // A JIT runner that has just registered can briefly report version: null; the column is
      // NOT NULL, and one such runner used to abort the whole poll.
      runner.version ?? "",
      JSON.stringify(runner.labels.map((l) => l.name)),
      derivePool(runner.name),
      now,
      now,
    )
    .run();
}

export async function pruneVanishedRunners(db: D1Database, seenNames: string[], now: string) {
  if (seenNames.length === 0) {
    await db.prepare(`DELETE FROM current_jobs`).run();
    await db.prepare(`DELETE FROM runners`).run();
    return;
  }
  const placeholders = seenNames.map(() => "?").join(",");
  await db
    .prepare(`DELETE FROM current_jobs WHERE runner_name NOT IN (${placeholders})`)
    .bind(...seenNames)
    .run();
  await db
    .prepare(`DELETE FROM runners WHERE name NOT IN (${placeholders})`)
    .bind(...seenNames)
    .run();
  void now;
}

export async function upsertCurrentJob(db: D1Database, job: ResolvedJob, now: string) {
  await db
    .prepare(
      `INSERT INTO current_jobs (runner_name, repo, run_id, run_url, job_id, job_name, workflow_name, job_started_at, pr_number, pr_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(runner_name) DO UPDATE SET
         repo = excluded.repo, run_id = excluded.run_id, run_url = excluded.run_url,
         job_id = excluded.job_id, job_name = excluded.job_name, workflow_name = excluded.workflow_name,
         job_started_at = excluded.job_started_at, pr_number = excluded.pr_number, pr_url = excluded.pr_url,
         updated_at = excluded.updated_at`,
    )
    .bind(
      job.runnerName,
      job.repo,
      job.runId,
      job.runUrl,
      job.jobId,
      job.jobName,
      job.workflowName,
      job.jobStartedAt,
      job.prNumber,
      job.prUrl,
      now,
    )
    .run();
}

export async function currentJobRunnerNames(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare(`SELECT runner_name FROM current_jobs`).all<{ runner_name: string }>();
  return new Set(results.map((r) => r.runner_name));
}

export async function loadSyncedRunKeys(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare(`SELECT run_key FROM synced_runs`).all<{ run_key: string }>();
  return new Set(results.map((r) => r.run_key));
}

// D1 allows at most 100 bound parameters per statement.
const STEP_ROWS_PER_STATEMENT = 16; // 6 params each

/**
 * Writes a completed run's self-hosted jobs (with their queue time, labels and per-step durations)
 * to job_history/job_steps and marks the run synced, atomically.
 *
 * Idempotent: a job that already has a row (written before timings existed, or by an overlapping
 * sync) only has its missing timing columns filled in; its steps are inserted OR IGNOREd. Returns
 * only the jobs that did NOT exist before, so re-fetching old runs never double-logs events.
 */
export async function recordSyncedRun(
  db: D1Database,
  runKey: string,
  jobs: CompletedSelfHostedJob[],
  now: string,
): Promise<CompletedSelfHostedJob[]> {
  const existing = new Set<number>();
  if (jobs.length > 0) {
    const { results } = await db
      .prepare(`SELECT job_id FROM job_history WHERE job_id IN (${jobs.map(() => "?").join(",")})`)
      .bind(...jobs.map((j) => j.jobId))
      .all<{ job_id: number }>();
    for (const r of results) existing.add(r.job_id);
  }

  const stmts: D1PreparedStatement[] = [];
  for (const j of jobs) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO job_history (job_id, pool, runner_name, repo, workflow_name, job_name, run_url, started_at, finished_at, duration_s, conclusion, created_at, queue_s, labels)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(job_id) DO UPDATE SET
             created_at = COALESCE(job_history.created_at, excluded.created_at),
             queue_s = COALESCE(job_history.queue_s, excluded.queue_s),
             labels = COALESCE(job_history.labels, excluded.labels)`,
        )
        .bind(
          j.jobId,
          derivePool(j.runnerName),
          j.runnerName,
          j.repo,
          j.workflowName,
          j.jobName,
          j.runUrl,
          j.startedAt,
          j.finishedAt,
          Math.max(0, Math.round((Date.parse(j.finishedAt) - Date.parse(j.startedAt)) / 1000)),
          j.conclusion,
          j.createdAt,
          j.queueS,
          j.labels,
        ),
    );
    for (let i = 0; i < j.steps.length; i += STEP_ROWS_PER_STATEMENT) {
      const chunk = j.steps.slice(i, i + STEP_ROWS_PER_STATEMENT);
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO job_steps (job_id, seq, name, duration_s, conclusion) VALUES ${chunk
              .map(() => "(?, ?, ?, ?, ?)")
              .join(", ")}`,
          )
          .bind(...chunk.flatMap((st) => [j.jobId, st.seq, st.name, st.durationS, st.conclusion])),
      );
    }
  }
  stmts.push(db.prepare(`INSERT OR IGNORE INTO synced_runs (run_key, synced_at) VALUES (?, ?)`).bind(runKey, now));
  await db.batch(stmts);
  return jobs.filter((j) => !existing.has(j.jobId));
}

/**
 * Drops raw job and step rows older than `olderThan` (by the job's finish time). Steps first, while
 * the job rows that say which steps are old still exist.
 */
export async function pruneJobTimings(db: D1Database, olderThan: string) {
  await db.batch([
    db
      .prepare(`DELETE FROM job_steps WHERE job_id IN (SELECT job_id FROM job_history WHERE finished_at < ?)`)
      .bind(olderThan),
    db.prepare(`DELETE FROM job_history WHERE finished_at < ?`).bind(olderThan),
  ]);
}

export async function pruneSyncedRuns(db: D1Database, olderThan: string) {
  await db.prepare(`DELETE FROM synced_runs WHERE synced_at < ?`).bind(olderThan).run();
}

export async function deleteCurrentJob(db: D1Database, runnerName: string) {
  await db.prepare(`DELETE FROM current_jobs WHERE runner_name = ?`).bind(runnerName).run();
}

export async function logEvent(
  db: D1Database,
  event: { severity: "info" | "warning" | "error"; kind: string; runnerName?: string; repo?: string; message: string },
  now: string,
) {
  await db
    .prepare(`INSERT INTO events (ts, severity, kind, runner_name, repo, message) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(now, event.severity, event.kind, event.runnerName ?? null, event.repo ?? null, event.message)
    .run();
}

export async function recordPoll(db: D1Database, ok: boolean, error: string | null, now: string) {
  await db
    .prepare(
      `UPDATE poll_state SET last_run_at = ?, last_ok = ?, last_error = ?,
         consecutive_failures = CASE WHEN ?2 = 1 THEN 0 ELSE consecutive_failures + 1 END
       WHERE id = 1`,
    )
    .bind(now, ok ? 1 : 0, error)
    .run();
}

export async function getPollFailureState(db: D1Database) {
  return db
    .prepare(`SELECT consecutive_failures, last_alert_at FROM poll_state WHERE id = 1`)
    .first<{ consecutive_failures: number; last_alert_at: string | null }>();
}

export async function setPollAlertedAt(db: D1Database, at: string) {
  await db.prepare(`UPDATE poll_state SET last_alert_at = ? WHERE id = 1`).bind(at).run();
}

export async function upsertTelemetry(
  db: D1Database,
  t: {
    host: string;
    location: string | null;
    cpuPct: number;
    cpuCount: number;
    loadAvg1m: number;
    memUsedMb: number;
    memTotalMb: number;
    diskUsedGb: number;
    diskTotalGb: number;
    uptimeS: number;
    agentVersion: string;
  },
  now: string,
) {
  await db
    .prepare(
      `INSERT INTO telemetry (host, location, cpu_pct, cpu_count, load_avg_1m, mem_used_mb, mem_total_mb, disk_used_gb, disk_total_gb, uptime_s, agent_version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(host) DO UPDATE SET
         location = excluded.location, cpu_pct = excluded.cpu_pct, cpu_count = excluded.cpu_count,
         load_avg_1m = excluded.load_avg_1m, mem_used_mb = excluded.mem_used_mb, mem_total_mb = excluded.mem_total_mb,
         disk_used_gb = excluded.disk_used_gb, disk_total_gb = excluded.disk_total_gb, uptime_s = excluded.uptime_s,
         agent_version = excluded.agent_version, updated_at = excluded.updated_at`,
    )
    .bind(
      t.host,
      t.location,
      t.cpuPct,
      t.cpuCount,
      t.loadAvg1m,
      t.memUsedMb,
      t.memTotalMb,
      t.diskUsedGb,
      t.diskTotalGb,
      t.uptimeS,
      t.agentVersion,
      now,
    )
    .run();

  // Thin time series for the metrics view: at most one sample per host per ~5 minutes.
  const last = await db
    .prepare(`SELECT ts FROM telemetry_samples WHERE host = ? ORDER BY ts DESC LIMIT 1`)
    .bind(t.host)
    .first<{ ts: string }>();
  if (!last || Date.parse(now) - Date.parse(last.ts) >= 5 * 60_000) {
    await db
      .prepare(`INSERT INTO telemetry_samples (host, ts, cpu_pct, mem_pct, load_avg_1m) VALUES (?, ?, ?, ?, ?)`)
      .bind(t.host, now, t.cpuPct, t.memTotalMb ? (t.memUsedMb / t.memTotalMb) * 100 : 0, t.loadAvg1m)
      .run();
    await db
      .prepare(`DELETE FROM telemetry_samples WHERE host = ? AND ts < ?`)
      .bind(t.host, new Date(Date.parse(now) - 7 * 86_400_000).toISOString())
      .run();
  }
}
