import type { Env } from "./types";

export async function buildState(env: Env) {
  const [runners, jobs, telemetry, events, pollState] = await Promise.all([
    env.DB.prepare(`SELECT * FROM runners ORDER BY pool, name`).all(),
    env.DB.prepare(`SELECT * FROM current_jobs`).all(),
    env.DB.prepare(`SELECT * FROM telemetry`).all(),
    env.DB.prepare(`SELECT * FROM events ORDER BY ts DESC LIMIT 100`).all(),
    env.DB.prepare(`SELECT last_run_at, last_ok, last_error FROM poll_state WHERE id = 1`).first(),
  ]);

  const jobByRunner = new Map((jobs.results as Record<string, unknown>[]).map((j) => [j.runner_name as string, j]));
  const telemetryByHost = new Map(
    (telemetry.results as Record<string, unknown>[]).map((t) => [t.host as string, t]),
  );

  const enrichedRunners = (runners.results as Record<string, unknown>[]).map((r) => ({
    ...r,
    labels: JSON.parse(r.labels_json as string),
    current_job: jobByRunner.get(r.name as string) ?? null,
    telemetry: telemetryByHost.get(r.pool as string) ?? null,
  }));

  return {
    runners: enrichedRunners,
    metrics: await buildMetrics(env),
    events: events.results,
    poll: pollState,
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
