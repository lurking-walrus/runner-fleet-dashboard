import { annotationsFor, baselineFor, ANNOTATIONS, type Annotation, type Baseline } from "./timing-notes";
import { KEY_SEP, poolCounts, rankedStats, slotMinutesPerDay, SOURCES, statsSql, type SourceKind, type Stat } from "./timing-stats";

const DAY_MS = 86_400_000;
const ROLLUP_KINDS = ["job", "step", "pool_queue", "pool_run"] as const;
type RollupKind = (typeof ROLLUP_KINDS)[number];

export interface StatOut {
  key: string[];
  n: number;
  p50: number;
  p90: number;
  max: number;
  total_s: number;
  slot_min_per_day: number;
  baseline?: { seconds: number; label: string };
}

export interface PoolRow {
  pool: string;
  jobs: number;
  failed: number;
  queue: { n: number; p50: number; p90: number; max: number } | null;
  run: { n: number; p50: number; p90: number; max: number } | null;
}

export interface WindowReport {
  since: string;
  until: string;
  days: number;
  pools: PoolRow[];
  labels: StatOut[];
  jobs: StatOut[];
  steps: StatOut[];
}

export interface TrendSeries {
  kind: "job" | "step" | "pool_queue";
  key: string[];
  points: { day: string; n: number; p50: number; p90: number; partial?: boolean }[];
  baseline?: { seconds: number; label: string };
  annotations: Annotation[];
}

export interface TrendReport {
  since_day: string;
  series: TrendSeries[];
}

const out = (s: Stat, days: number, kind?: "job" | "step"): StatOut => {
  const baseline = kind ? baselineFor(kind, s.key) : undefined;
  return {
    key: s.key,
    n: s.n,
    p50: s.p50,
    p90: s.p90,
    max: s.max,
    total_s: s.total,
    slot_min_per_day: slotMinutesPerDay(s.total, days),
    ...(baseline ? { baseline: { seconds: baseline.seconds, label: baseline.label } } : {}),
  };
};

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Pool table + label table + slowest jobs/steps for [now - days, now]. */
export async function buildWindow(db: D1Database, now: number, days: number): Promise<WindowReport> {
  const since = toIso(now - days * DAY_MS);
  const until = toIso(now + 1000);
  const [queue, run, counts, labels, jobs, steps] = await Promise.all([
    rankedStats(db, "pool_queue", since, until, 50),
    rankedStats(db, "pool_run", since, until, 50),
    poolCounts(db, since, until),
    rankedStats(db, "label_queue", since, until, 20),
    rankedStats(db, "job", since, until, 40),
    rankedStats(db, "step", since, until, 40),
  ]);
  const q = new Map(queue.map((s) => [s.key[0]!, s]));
  const r = new Map(run.map((s) => [s.key[0]!, s]));
  const brief = (s: Stat | undefined) => (s ? { n: s.n, p50: s.p50, p90: s.p90, max: s.max } : null);
  const pools = counts
    .map((c) => ({
      pool: c.pool,
      jobs: c.jobs,
      failed: c.failed ?? 0,
      queue: brief(q.get(c.pool)),
      run: brief(r.get(c.pool)),
    }))
    .sort((a, b) => b.jobs - a.jobs || a.pool.localeCompare(b.pool));
  return {
    since,
    until,
    days,
    pools,
    labels: labels.map((s) => out(s, days)),
    jobs: jobs.map((s) => out(s, days, "job")),
    steps: steps.map((s) => out(s, days, "step")),
  };
}

// ---- Daily rollups -------------------------------------------------------------------------

/** UTC day string YYYY-MM-DD for a ms timestamp. */
export const dayOf = (ms: number): string => toIso(ms).slice(0, 10);

/** A day is rolled up once it has been over for this long, so jobs the sync was still draining are in. */
export const ROLLUP_MARGIN_MS = 2 * 3_600_000;

/** Days (oldest first) in the retention window that are complete, not yet rolled up. */
export function dueDays(now: number, retentionDays: number, done: ReadonlySet<string>): string[] {
  const days: string[] = [];
  const todayStart = Date.parse(`${dayOf(now)}T00:00:00Z`);
  for (let i = retentionDays; i >= 1; i--) {
    const start = todayStart - i * DAY_MS;
    const day = dayOf(start);
    if (now >= start + DAY_MS + ROLLUP_MARGIN_MS && !done.has(day)) days.push(day);
  }
  return days;
}

export async function rollupDay(db: D1Database, day: string, now: string): Promise<void> {
  const since = `${day}T00:00:00.000Z`;
  const until = toIso(Date.parse(since) + DAY_MS);
  const stmts = ROLLUP_KINDS.map((kind) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO timing_daily (day, kind, key, n, p50, p90, max_s, total_s)
         SELECT ?3, ?4, k, n, p50, p90, mx, total FROM (${statsSql(SOURCES[SOURCE_FOR[kind]])})`,
      )
      .bind(since, until, day, kind),
  );
  stmts.push(db.prepare(`INSERT OR REPLACE INTO timing_daily_done (day, rolled_at) VALUES (?, ?)`).bind(day, now));
  await db.batch(stmts);
}

const SOURCE_FOR: Record<RollupKind, SourceKind> = {
  job: "job",
  step: "step",
  pool_queue: "pool_queue",
  pool_run: "pool_run",
};

/** Rolls up the oldest complete, not-yet-done day (one per call: bounded work per sync tick). */
export async function rollupPendingDay(db: D1Database, nowMs: number, retentionDays: number): Promise<string | null> {
  const from = dayOf(nowMs - retentionDays * DAY_MS);
  const { results } = await db.prepare(`SELECT day FROM timing_daily_done WHERE day >= ?`).bind(from).all<{ day: string }>();
  const due = dueDays(nowMs, retentionDays, new Set(results.map((r) => r.day)));
  const day = due[0];
  if (!day) return null;
  await rollupDay(db, day, toIso(nowMs));
  return day;
}

export async function pruneRollups(db: D1Database, nowMs: number, keepDays: number): Promise<void> {
  const cutoff = dayOf(nowMs - keepDays * DAY_MS);
  await db.batch([
    db.prepare(`DELETE FROM timing_daily WHERE day < ?`).bind(cutoff),
    db.prepare(`DELETE FROM timing_daily_done WHERE day < ?`).bind(cutoff),
  ]);
}

// ---- Trend ---------------------------------------------------------------------------------

/**
 * Daily p50/p90 for the chosen keys: complete days from timing_daily, plus today so far computed
 * from raw rows (marked partial). `keys` are composite keys (parts joined by KEY_SEP).
 */
export async function buildTrend(
  db: D1Database,
  now: number,
  trendDays: number,
  jobKeys: string[][],
  stepKeys: string[][],
  poolKeys: string[],
): Promise<TrendReport> {
  const sinceDay = dayOf(now - (trendDays - 1) * DAY_MS);
  const wanted: { kind: "job" | "step" | "pool_queue"; key: string[] }[] = [
    ...jobKeys.map((key) => ({ kind: "job" as const, key })),
    ...stepKeys.map((key) => ({ kind: "step" as const, key })),
    ...poolKeys.map((p) => ({ kind: "pool_queue" as const, key: [p] })),
  ];
  const series = new Map<string, TrendSeries>();
  for (const w of wanted) {
    series.set(`${w.kind}|${w.key.join(KEY_SEP)}`, {
      kind: w.kind,
      key: w.key,
      points: [],
      ...(w.kind !== "pool_queue" && baselineFor(w.kind, w.key)
        ? { baseline: { seconds: baselineFor(w.kind, w.key)!.seconds, label: baselineFor(w.kind, w.key)!.label } }
        : {}),
      annotations: annotationsFor(w.kind === "pool_queue" ? "pool" : w.kind, w.key),
    });
  }

  // One query per kind for the stored days.
  for (const kind of ["job", "step", "pool_queue"] as const) {
    const keys = wanted.filter((w) => w.kind === kind).map((w) => w.key.join(KEY_SEP));
    if (keys.length === 0) continue;
    const { results } = await db
      .prepare(
        `SELECT day, key, n, p50, p90 FROM timing_daily
         WHERE kind = ?1 AND day >= ?2 AND key IN (${keys.map((_, i) => `?${i + 3}`).join(",")}) ORDER BY day`,
      )
      .bind(kind, sinceDay, ...keys)
      .all<{ day: string; key: string; n: number; p50: number; p90: number }>();
    for (const r of results) series.get(`${kind}|${r.key}`)?.points.push({ day: r.day, n: r.n, p50: r.p50, p90: r.p90 });
  }

  // Today so far, from raw rows.
  const todayStart = `${dayOf(now)}T00:00:00.000Z`;
  const until = toIso(now + 1000);
  for (const kind of ["job", "step", "pool_queue"] as const) {
    const keys = wanted.filter((w) => w.kind === kind).map((w) => w.key.join(KEY_SEP));
    if (keys.length === 0) continue;
    const { results } = await db
      .prepare(
        `SELECT k, n, p50, p90 FROM (${statsSql(SOURCES[SOURCE_FOR[kind]])}) WHERE k IN (${keys.map((_, i) => `?${i + 3}`).join(",")})`,
      )
      .bind(todayStart, until, ...keys)
      .all<{ k: string; n: number; p50: number; p90: number }>();
    for (const r of results) {
      const s = series.get(`${kind}|${r.k}`);
      if (s && !s.points.some((p) => p.day === dayOf(now))) {
        s.points.push({ day: dayOf(now), n: r.n, p50: r.p50, p90: r.p90, partial: true });
      }
    }
  }
  return { since_day: sinceDay, series: [...series.values()] };
}

// ---- Cache + assembly ----------------------------------------------------------------------

async function cached<T>(db: D1Database, name: string, ttlMs: number, now: number, compute: () => Promise<T>): Promise<T> {
  const row = await db
    .prepare(`SELECT computed_at, body FROM report_cache WHERE name = ?`)
    .bind(name)
    .first<{ computed_at: string; body: string }>();
  if (row && now - Date.parse(row.computed_at) < ttlMs) return JSON.parse(row.body) as T;
  const fresh = await compute();
  await db
    .prepare(`INSERT OR REPLACE INTO report_cache (name, computed_at, body) VALUES (?, ?, ?)`)
    .bind(name, toIso(now), JSON.stringify(fresh))
    .run();
  return fresh;
}

// How stale each section may get. A 7 d step aggregation reads ~100k rows, so it is recomputed
// rarely; the 24 h view is the "did my fix work" one and is kept fresher.
export const TTL = { w24h: 15 * 60_000, w7d: 2 * 3_600_000, trend: 60 * 60_000 } as const;

export interface TimingReport {
  generated_at: string;
  windows: { "24h": WindowReport; "7d": WindowReport };
  trend: TrendReport;
  annotations: Annotation[];
}

export async function buildTimingReport(db: D1Database, now: number = Date.now()): Promise<TimingReport> {
  const [w24, w7] = await Promise.all([
    cached(db, "timing:24h", TTL.w24h, now, () => buildWindow(db, now, 1)),
    cached(db, "timing:7d", TTL.w7d, now, () => buildWindow(db, now, 7)),
  ]);
  const trend = await cached(db, "timing:trend", TTL.trend, now, () =>
    buildTrend(
      db,
      now,
      30,
      w7.jobs.slice(0, 8).map((s) => s.key),
      w7.steps.slice(0, 12).map((s) => s.key),
      w7.pools.map((p) => p.pool),
    ),
  );
  return { generated_at: toIso(now), windows: { "24h": w24, "7d": w7 }, trend, annotations: ANNOTATIONS };
}

export type { Baseline };
