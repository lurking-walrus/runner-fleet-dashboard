// Aggregations over job_history / job_steps. Percentiles are computed IN SQL with window
// functions (D1 is SQLite; the Worker has a 10 ms CPU budget on the Free plan, so it must not sort
// tens of thousands of values itself). Every query takes a half-open window [since, until).
//
// Percentile definition: nearest rank. For n values sorted ascending, p50 is the value at rank
// ceil(0.50 * n) and p90 at rank ceil(0.90 * n). p50 of [1,2,3,4] is 2, p90 of 1..10 is 9.
// Exact (not interpolated, not approximate) so a number here can be reproduced by hand.

export const KEY_SEP = "\u001f"; // char(31): joins composite keys, cannot appear in a job or step name in practice

export interface Stat {
  key: string[];
  n: number;
  p50: number;
  p90: number;
  max: number;
  total: number; // sum of the values, seconds
}

/**
 * Wraps a source query yielding (k TEXT, v INTEGER) in the percentile aggregation. `k` partitions
 * the values; the result is one row per k with n, total, max, p50, p90.
 */
export function statsSql(source: string): string {
  return `
  SELECT k, COUNT(*) AS n, SUM(v) AS total, MAX(v) AS mx,
         MIN(CASE WHEN rn >= (cnt * 50 + 99) / 100 THEN v END) AS p50,
         MIN(CASE WHEN rn >= (cnt * 90 + 99) / 100 THEN v END) AS p90
  FROM (
    SELECT k, v, ROW_NUMBER() OVER (PARTITION BY k ORDER BY v) AS rn, COUNT(*) OVER (PARTITION BY k) AS cnt
    FROM (${source})
  )
  GROUP BY k`;
}

const SEP_SQL = "char(31)";
const JOB_KEY = `j.repo || ${SEP_SQL} || j.workflow_name || ${SEP_SQL} || j.job_name || ${SEP_SQL} || j.pool`;
const STEP_KEY = `${JOB_KEY} || ${SEP_SQL} || s.name`;
const WINDOW = `j.finished_at >= ?1 AND j.finished_at < ?2`;

/** Source queries, each yielding (k, v) for the window bound as ?1 (since) and ?2 (until). */
export const SOURCES = {
  pool_queue: `SELECT j.pool AS k, j.queue_s AS v FROM job_history j WHERE ${WINDOW} AND j.queue_s IS NOT NULL`,
  pool_run: `SELECT j.pool AS k, j.duration_s AS v FROM job_history j WHERE ${WINDOW}`,
  label_queue: `SELECT j.labels AS k, j.queue_s AS v FROM job_history j WHERE ${WINDOW} AND j.queue_s IS NOT NULL AND j.labels IS NOT NULL AND j.labels <> ''`,
  job: `SELECT ${JOB_KEY} AS k, j.duration_s AS v FROM job_history j WHERE ${WINDOW}`,
  step: `SELECT ${STEP_KEY} AS k, s.duration_s AS v FROM job_history j JOIN job_steps s ON s.job_id = j.job_id WHERE ${WINDOW}`,
} as const;
export type SourceKind = keyof typeof SOURCES;

interface Row {
  k: string;
  n: number;
  total: number;
  mx: number;
  p50: number;
  p90: number;
}

function toStat(r: Row): Stat {
  return { key: r.k.split(KEY_SEP), n: r.n, p50: r.p50, p90: r.p90, max: r.mx, total: r.total };
}

/** All keys' stats for one source over a window, ranked by total time consumed (descending). */
export async function rankedStats(
  db: D1Database,
  kind: SourceKind,
  since: string,
  until: string,
  limit: number,
): Promise<Stat[]> {
  const { results } = await db
    .prepare(`${statsSql(SOURCES[kind])} ORDER BY total DESC, k LIMIT ?3`)
    .bind(since, until, limit)
    .all<Row>();
  return results.map(toStat);
}

/** Per-pool failure counts and job totals for a window (cheap: one pass over job_history). */
export async function poolCounts(db: D1Database, since: string, until: string) {
  const { results } = await db
    .prepare(
      `SELECT j.pool AS pool, COUNT(*) AS jobs, SUM(j.conclusion IN ('failure','timed_out')) AS failed, SUM(j.duration_s) AS busy_s
       FROM job_history j WHERE ${WINDOW} GROUP BY j.pool`,
    )
    .bind(since, until)
    .all<{ pool: string; jobs: number; failed: number; busy_s: number }>();
  return results;
}

/**
 * Slot-minutes per day for a ranked stat: total seconds over the window, in minutes, per day of
 * the window. A "day" is `windowDays` long (1 for 24 h, 7 for 7 d).
 */
export function slotMinutesPerDay(totalSeconds: number, windowDays: number): number {
  return Math.round((totalSeconds / 60 / windowDays) * 10) / 10;
}
