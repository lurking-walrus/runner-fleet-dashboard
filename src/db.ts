import type { GhRunner, ResolvedJob } from "./types";
import { derivePool } from "./github";

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
      runner.os,
      runner.status,
      runner.busy ? 1 : 0,
      runner.version,
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

export interface TrackedJob {
  repo: string;
  jobId: number;
  runUrl: string;
  jobName: string;
  workflowName: string;
  startedAt: string;
}

export async function currentJobRunnerNames(db: D1Database): Promise<Map<string, TrackedJob>> {
  const { results } = await db
    .prepare(`SELECT runner_name, repo, job_id, run_url, job_name, workflow_name, job_started_at FROM current_jobs`)
    .all<{
      runner_name: string;
      repo: string;
      job_id: number;
      run_url: string;
      job_name: string;
      workflow_name: string;
      job_started_at: string;
    }>();
  return new Map(
    results.map((r) => [
      r.runner_name,
      {
        repo: r.repo,
        jobId: r.job_id,
        runUrl: r.run_url,
        jobName: r.job_name,
        workflowName: r.workflow_name,
        startedAt: r.job_started_at,
      },
    ]),
  );
}

export async function recordJobHistory(
  db: D1Database,
  j: TrackedJob & { runnerName: string; pool: string; finishedAt: string; conclusion: string | null },
) {
  const durationS = Math.max(0, Math.round((Date.parse(j.finishedAt) - Date.parse(j.startedAt)) / 1000));
  await db
    .prepare(
      `INSERT OR IGNORE INTO job_history (job_id, pool, runner_name, repo, workflow_name, job_name, run_url, started_at, finished_at, duration_s, conclusion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(j.jobId, j.pool, j.runnerName, j.repo, j.workflowName, j.jobName, j.runUrl, j.startedAt, j.finishedAt, durationS, j.conclusion)
    .run();
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
    .prepare(`UPDATE poll_state SET last_run_at = ?, last_ok = ?, last_error = ? WHERE id = 1`)
    .bind(now, ok ? 1 : 0, error)
    .run();
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
