import { cached } from "./cache";
import { deriveSlot } from "./github";
import type { Env } from "./types";

const METRICS_TTL_MS = 15 * 60_000;
// job_history only changes on the 10-minute history sync, so a shorter TTL buys nothing.
const SLOTS_TTL_MS = 5 * 60_000;

export async function buildState(env: Env) {
  const [runners, jobs, telemetry, events, pollState, queue] = await Promise.all([
    env.DB.prepare(`SELECT * FROM runners ORDER BY pool, name`).all(),
    env.DB.prepare(`SELECT * FROM current_jobs`).all(),
    env.DB.prepare(`SELECT * FROM telemetry`).all(),
    env.DB.prepare(`SELECT * FROM events ORDER BY ts DESC LIMIT 100`).all(),
    env.DB.prepare(`SELECT last_run_at, last_ok, last_error FROM poll_state WHERE id = 1`).first(),
    env.DB.prepare(`SELECT body FROM queue_snapshot WHERE id = 1`).first<{ body: string }>(),
  ]);

  const jobByRunner = new Map((jobs.results as Record<string, unknown>[]).map((j) => [j.runner_name as string, j]));
  const telemetryByHost = new Map(
    (telemetry.results as Record<string, unknown>[]).map((t) => [t.host as string, t]),
  );

  const slots = await cached(env.DB, "slot_usage", SLOTS_TTL_MS, Date.now(), () => buildSlotUsage(env.DB, Date.now()));

  const enrichedRunners = (runners.results as Record<string, unknown>[]).map((r) => {
    const slot = deriveSlot(r.name as string);
    return {
      ...r,
      labels: JSON.parse(r.labels_json as string),
      current_job: jobByRunner.get(r.name as string) ?? null,
      telemetry: telemetryByHost.get(r.pool as string) ?? null,
      slot,
      last_job: slots[slot] ?? null,
    };
  });

  return {
    runners: enrichedRunners,
    // job_history and telemetry_samples are scanned for these figures (thousands of rows), so they
    // are recomputed at most every 15 minutes, not on every 20-second dashboard poll.
    metrics: await cached(env.DB, "metrics", METRICS_TTL_MS, Date.now(), () => buildMetrics(env)),
    events: events.results,
    poll: pollState,
    queue: queue ? JSON.parse(queue.body) : null,
    generated_at: new Date().toISOString(),
  };
}

// Per-pool usage stats. Two grouped queries over indexed windows, not per-pool loops,
// to keep D1 rows_read small (see migration 0002).
async function buildMetrics(env: Env) {
  const day = new Date(Date.now() - 86_400_000).toISOString();
  const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [jobs, samples, last] = await Promise.all([
    env.DB.prepare(
      `SELECT pool,
              COUNT(*) AS jobs_7d,
              SUM(finished_at >= ?1) AS jobs_24h,
              SUM(conclusion = 'failure') AS failed_7d,
              SUM(duration_s) AS busy_s_7d,
              SUM(CASE WHEN finished_at >= ?1 THEN duration_s ELSE 0 END) AS busy_s_24h
       FROM job_history WHERE finished_at >= ?2 GROUP BY pool`,
    )
      .bind(day, week)
      .all(),
    env.DB.prepare(
      `SELECT host, AVG(cpu_pct) AS cpu_avg_24h, MAX(cpu_pct) AS cpu_peak_24h, AVG(mem_pct) AS mem_avg_24h, COUNT(*) AS samples_24h
       FROM telemetry_samples WHERE ts >= ? GROUP BY host`,
    )
      .bind(day)
      .all(),
    env.DB.prepare(`SELECT pool, MAX(finished_at) AS last_job_at FROM job_history GROUP BY pool`).all(),
  ]);
  const byPool: Record<string, Record<string, unknown>> = {};
  for (const r of jobs.results as Record<string, unknown>[]) byPool[r.pool as string] = { ...r };
  for (const r of samples.results as Record<string, unknown>[]) {
    byPool[r.host as string] = { ...(byPool[r.host as string] ?? {}), ...r };
  }
  for (const r of last.results as Record<string, unknown>[]) {
    byPool[r.pool as string] = { ...(byPool[r.pool as string] ?? {}), last_job_at: r.last_job_at };
  }
  return byPool;
}

export interface SlotUsage {
  last_job_at: string;
  repo: string;
  workflow_name: string;
  job_name: string;
  run_url: string;
  conclusion: string | null;
  jobs_24h: number;
  jobs_7d: number;
}

/**
 * The last finished job and job counts per runner slot (deriveSlot), so the page can show whether
 * work fans out across every slot of a pool. Ephemeral runners re-register with a new name per
 * job, so this groups by slot, not by the registration the runners table holds.
 */
export async function buildSlotUsage(db: D1Database, now: number): Promise<Record<string, SlotUsage>> {
  const day = new Date(now - 86_400_000).toISOString();
  const week = new Date(now - 7 * 86_400_000).toISOString();
  // SQLite returns the other bare columns from the row that holds MAX(finished_at).
  const { results } = await db
    .prepare(
      `SELECT runner_name, MAX(finished_at) AS last_job_at, repo, workflow_name, job_name, run_url, conclusion,
              COUNT(*) AS jobs_7d, SUM(finished_at >= ?1) AS jobs_24h
       FROM job_history WHERE finished_at >= ?2 GROUP BY runner_name`,
    )
    .bind(day, week)
    .all<SlotUsage & { runner_name: string }>();
  const bySlot: Record<string, SlotUsage> = {};
  for (const { runner_name, ...row } of results) {
    const slot = deriveSlot(runner_name);
    const prev = bySlot[slot];
    if (!prev) {
      bySlot[slot] = { ...row };
      continue;
    }
    const latest = row.last_job_at > prev.last_job_at ? row : prev;
    bySlot[slot] = { ...latest, jobs_24h: prev.jobs_24h + row.jobs_24h, jobs_7d: prev.jobs_7d + row.jobs_7d };
  }
  return bySlot;
}
