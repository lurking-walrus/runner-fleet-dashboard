import { describe, expect, it } from "vitest";
import { annotationsFor, baselineFor } from "../src/timing-notes";
import {
  buildTimingReport,
  buildTrend,
  buildWindow,
  dayOf,
  dueDays,
  pruneRollups,
  rollupDay,
  rollupPendingDay,
} from "../src/timing-report";
import { KEY_SEP, rankedStats, slotMinutesPerDay } from "../src/timing-stats";
import { migratedDb } from "./d1-sqlite";

let nextId = 1;
type Seed = {
  pool?: string;
  repo?: string;
  workflow?: string;
  job?: string;
  finished: string; // ISO
  run?: number;
  queue?: number | null;
  labels?: string | null;
  conclusion?: string;
  steps?: [string, number][];
};

function seed(raw: import("node:sqlite").DatabaseSync, rows: Seed[]) {
  for (const r of rows) {
    const id = nextId++;
    const run = r.run ?? 10;
    raw
      .prepare(
        `INSERT INTO job_history (job_id, pool, runner_name, repo, workflow_name, job_name, run_url, started_at, finished_at, duration_s, conclusion, queue_s, labels)
         VALUES (?, ?, 'r', ?, ?, ?, 'u', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        r.pool ?? "wsl",
        r.repo ?? "o/r",
        r.workflow ?? "CI",
        r.job ?? "Build",
        r.finished,
        r.finished,
        run,
        r.conclusion ?? "success",
        r.queue === undefined ? 0 : r.queue,
        r.labels === undefined ? "self-hosted,Linux" : r.labels,
      );
    (r.steps ?? []).forEach(([name, d], i) =>
      raw.prepare(`INSERT INTO job_steps (job_id, seq, name, duration_s) VALUES (?, ?, ?, ?)`).run(id, i + 1, name, d),
    );
  }
}

const NOW = Date.parse("2026-11-23T12:00:00Z");
const T = (hhmm: string, day = "2026-11-23") => `${day}T${hhmm}:00Z`;
const SINCE = "2026-11-23T00:00:00.000Z";
const UNTIL = "2026-11-24T00:00:00.000Z";

describe("nearest-rank percentiles (SQL)", () => {
  it("p50/p90 of 1..10 are 5 and 9; max and total are exact", async () => {
    const { db, raw } = migratedDb();
    seed(raw, Array.from({ length: 10 }, (_, i) => ({ finished: T("10:00"), queue: i + 1 })));
    const [s] = await rankedStats(db, "pool_queue", SINCE, UNTIL, 10);
    expect(s).toMatchObject({ key: ["wsl"], n: 10, p50: 5, p90: 9, max: 10, total: 55 });
  });

  it("p50 of [1,2,3,4] is 2 (rank ceil(0.5*4)), p90 is 4", async () => {
    const { db, raw } = migratedDb();
    seed(raw, [1, 2, 3, 4].map((q) => ({ finished: T("10:00"), queue: q })));
    const [s] = await rankedStats(db, "pool_queue", SINCE, UNTIL, 10);
    expect([s!.p50, s!.p90]).toEqual([2, 4]);
  });

  it("one value is every percentile; ties are stable", async () => {
    const { db, raw } = migratedDb();
    seed(raw, [{ finished: T("10:00"), queue: 7 }, { finished: T("10:01"), pool: "mac", queue: 3 }, { finished: T("10:02"), pool: "mac", queue: 3 }]);
    const stats = await rankedStats(db, "pool_queue", SINCE, UNTIL, 10);
    const by = Object.fromEntries(stats.map((s) => [s.key[0], s]));
    expect(by.wsl).toMatchObject({ p50: 7, p90: 7, max: 7 });
    expect(by.mac).toMatchObject({ p50: 3, p90: 3, n: 2 });
  });

  it("ignores jobs with no queue time rather than counting them as 0", async () => {
    const { db, raw } = migratedDb();
    seed(raw, [{ finished: T("10:00"), queue: null }, { finished: T("10:00"), queue: 100 }]);
    const [s] = await rankedStats(db, "pool_queue", SINCE, UNTIL, 10);
    expect(s).toMatchObject({ n: 1, p50: 100 });
  });

  it("the window is half-open [since, until)", async () => {
    const { db, raw } = migratedDb();
    seed(raw, [
      { finished: "2026-11-23T00:00:00Z", queue: 1 }, // in (== since)
      { finished: "2026-11-23T23:59:59Z", queue: 1 }, // in
      { finished: "2026-11-24T00:00:00Z", queue: 1 }, // out (== until)
      { finished: "2026-11-22T23:59:59Z", queue: 1 }, // out
    ]);
    const [s] = await rankedStats(db, "pool_queue", SINCE, UNTIL, 10);
    expect(s!.n).toBe(2);
  });

  it("groups queue time by requested label set", async () => {
    const { db, raw } = migratedDb();
    seed(raw, [
      { finished: T("10:00"), queue: 10, labels: "self-hosted,Linux" },
      { finished: T("10:00"), queue: 30, labels: "self-hosted,Linux" },
      { finished: T("10:00"), queue: 500, labels: "self-hosted,Linux,container" },
      { finished: T("10:00"), queue: 9, labels: null },
    ]);
    const stats = await rankedStats(db, "label_queue", SINCE, UNTIL, 10);
    expect(stats.map((s) => [s.key[0], s.n, s.p50])).toEqual([
      ["self-hosted,Linux,container", 1, 500],
      ["self-hosted,Linux", 2, 10],
    ]);
  });
});

describe("ranking by total time consumed", () => {
  it("ranks a frequent medium job above a rare slow one when it costs more slot time", async () => {
    const { db, raw } = migratedDb();
    seed(raw, [
      { job: "Lint", run: 100, finished: T("09:00") },
      { job: "Lint", run: 100, finished: T("09:10") },
      { job: "Lint", run: 100, finished: T("09:20") },
      { job: "Lint", run: 100, finished: T("09:30") }, // total 400
      { job: "Plan", run: 300, finished: T("09:40") }, // total 300, but slowest per run
    ]);
    const jobs = await rankedStats(db, "job", SINCE, UNTIL, 10);
    expect(jobs.map((j) => j.key[2])).toEqual(["Lint", "Plan"]);
    expect(jobs[0]).toMatchObject({ n: 4, p50: 100, max: 100, total: 400 });
    expect(jobs[1]).toMatchObject({ p50: 300, max: 300 });
  });

  it("keeps the same job on two pools apart, since fixes are per pool", async () => {
    const { db, raw } = migratedDb();
    seed(raw, [
      { job: "Vitest", pool: "wsl", run: 500, finished: T("09:00") },
      { job: "Vitest", pool: "mac", run: 300, finished: T("09:00") },
    ]);
    const jobs = await rankedStats(db, "job", SINCE, UNTIL, 10);
    expect(jobs.map((j) => [j.key[3], j.total])).toEqual([["wsl", 500], ["mac", 300]]);
  });

  it("ranks steps within their job and respects the limit", async () => {
    const { db, raw } = migratedDb();
    seed(raw, [
      { job: "Plan", finished: T("09:00"), steps: [["tofu init", 600], ["setup-node", 20]] },
      { job: "Plan", finished: T("09:30"), steps: [["tofu init", 800], ["setup-node", 40]] },
      { job: "Build", finished: T("09:40"), steps: [["pnpm build", 100]] },
    ]);
    const steps = await rankedStats(db, "step", SINCE, UNTIL, 2);
    expect(steps.map((s) => [s.key[2], s.key[4], s.total])).toEqual([["Plan", "tofu init", 1400], ["Build", "pnpm build", 100]]);
    expect(steps[0]).toMatchObject({ n: 2, p50: 600, p90: 800, max: 800 });
  });

  it("slot-minutes per day divides total seconds by the window length", () => {
    expect(slotMinutesPerDay(600, 1)).toBe(10);
    expect(slotMinutesPerDay(7 * 600, 7)).toBe(10);
    expect(slotMinutesPerDay(100, 1)).toBe(1.7);
  });
});

describe("buildWindow", () => {
  it("combines per-pool queue, run and failure counts", async () => {
    const { db, raw } = migratedDb();
    seed(raw, [
      { pool: "wsl", queue: 10, run: 40, finished: T("10:00") },
      { pool: "wsl", queue: 900, run: 60, finished: T("10:05"), conclusion: "failure" },
      { pool: "mac", queue: 4, run: 15, finished: T("10:05") },
    ]);
    const w = await buildWindow(db, NOW, 1);
    expect(w.pools.map((p) => p.pool)).toEqual(["wsl", "mac"]);
    expect(w.pools[0]).toMatchObject({ jobs: 2, failed: 1, queue: { p50: 10, p90: 900, max: 900 }, run: { p50: 40, p90: 60 } });
    expect(w.pools[1]).toMatchObject({ jobs: 1, failed: 0, queue: { p50: 4 } });
  });
});

describe("daily rollups and trend", () => {
  it("rolls a day up into exact per-key rows and marks it done", async () => {
    const { db, raw } = migratedDb();
    seed(raw, [
      { job: "Lint", run: 100, finished: "2026-11-21T10:00:00Z", steps: [["pnpm lint", 90]] },
      { job: "Lint", run: 300, finished: "2026-11-21T11:00:00Z", steps: [["pnpm lint", 280]] },
      { job: "Lint", run: 999, finished: "2026-11-22T11:00:00Z" }, // another day
    ]);
    await rollupDay(db, "2026-11-21", "now");
    const rows = raw.prepare(`SELECT kind, key, n, p50, p90, max_s, total_s FROM timing_daily WHERE kind IN ('job','step') ORDER BY kind`).all() as Record<string, unknown>[];
    expect(rows).toEqual([
      { kind: "job", key: ["o/r", "CI", "Lint", "wsl"].join(KEY_SEP), n: 2, p50: 100, p90: 300, max_s: 300, total_s: 400 },
      { kind: "step", key: ["o/r", "CI", "Lint", "wsl", "pnpm lint"].join(KEY_SEP), n: 2, p50: 90, p90: 280, max_s: 280, total_s: 370 },
    ]);
    expect(raw.prepare(`SELECT day FROM timing_daily_done`).all()).toEqual([{ day: "2026-11-21" }]);
  });

  it("re-rolling a day replaces its rows, never duplicates", async () => {
    const { db, raw } = migratedDb();
    seed(raw, [{ finished: "2026-11-21T10:00:00Z", run: 50 }]);
    await rollupDay(db, "2026-11-21", "a");
    await rollupDay(db, "2026-11-21", "b");
    expect(raw.prepare(`SELECT count(*) c FROM timing_daily WHERE kind='job'`).get()).toEqual({ c: 1 });
  });

  it("only complete days (past the margin) are due, oldest first, and done ones are skipped", () => {
    const now = Date.parse("2026-11-23T01:00:00Z"); // 1 h into the 23rd
    // yesterday (22nd) ended 1 h ago: inside the 2 h margin, not due yet
    expect(dueDays(now, 3, new Set())).toEqual(["2026-11-20", "2026-11-21"]);
    const later = Date.parse("2026-11-23T02:00:00Z");
    expect(dueDays(later, 3, new Set(["2026-11-21"]))).toEqual(["2026-11-20", "2026-11-22"]);
  });

  it("rolls one pending day per call and then reports nothing to do", async () => {
    const { db } = migratedDb();
    const now = Date.parse("2026-11-23T12:00:00Z");
    const seen: (string | null)[] = [];
    for (let i = 0; i < 4; i++) seen.push(await rollupPendingDay(db, now, 2));
    expect(seen).toEqual(["2026-11-21", "2026-11-22", null, null]);
  });

  it("prunes old rollups", async () => {
    const { db, raw } = migratedDb();
    await rollupDay(db, "2026-01-01", "x");
    await rollupDay(db, "2026-11-22", "x");
    await pruneRollups(db, NOW, 90);
    expect(raw.prepare(`SELECT day FROM timing_daily_done`).all()).toEqual([{ day: "2026-11-22" }]);
  });

  it("trend = stored days + today so far (partial), so a fix shows as a drop", async () => {
    const { db, raw } = migratedDb();
    const key = ["o/r", "CI", "Plan and classify", "mac"];
    seed(raw, [
      { job: "Plan and classify", pool: "mac", run: 1057, finished: "2026-11-22T10:00:00Z" },
      { job: "Plan and classify", pool: "mac", run: 23, finished: "2026-11-23T10:00:00Z" },
    ]);
    await rollupDay(db, "2026-11-22", "x");
    const t = await buildTrend(db, NOW, 30, [key], [], ["mac"]);
    const job = t.series.find((s) => s.kind === "job")!;
    expect(job.points).toEqual([
      { day: "2026-11-22", n: 1, p50: 1057, p90: 1057 },
      { day: "2026-11-23", n: 1, p50: 23, p90: 23, partial: true },
    ]);
    expect(t.series.find((s) => s.kind === "pool_queue")!.key).toEqual(["mac"]);
    expect(t.since_day).toBe("2026-10-25");
  });
});

describe("report cache", () => {
  it("serves the cached section inside its TTL and recomputes after it", async () => {
    const { db, raw } = migratedDb();
    seed(raw, [{ queue: 5, finished: T("11:00") }]);
    const first = await buildTimingReport(db, NOW);
    expect(first.windows["24h"].pools[0]!.queue!.p50).toBe(5);
    seed(raw, [{ queue: 5, finished: T("11:30") }]);
    const cached = await buildTimingReport(db, NOW + 60_000);
    expect(cached.windows["24h"].pools[0]!.jobs).toBe(1); // still the cached answer
    const fresh = await buildTimingReport(db, NOW + 31 * 60_000); // past the 30 min 24 h TTL
    expect(fresh.windows["24h"].pools[0]!.jobs).toBe(2);
    expect(fresh.windows["7d"].pools[0]!.jobs).toBe(1); // 7 d keeps its own, longer TTL
  });
});

describe("baselines and annotations", () => {
  it("matches a baseline by repo and exact job name, or by step text", () => {
    const cm = "Lurking-Walrus/career-manager";
    expect(baselineFor("job", [cm, "CI", "Vitest", "wsl"])?.seconds).toBe(546);
    expect(baselineFor("job", [cm, "CI", "Vitest (shard 2)", "wsl"])).toBeUndefined();
    expect(baselineFor("job", ["other/repo", "CI", "Vitest", "wsl"])).toBeUndefined();
    expect(baselineFor("step", [cm, "Infra", "Plan and classify", "mac", "Run tofu init"])?.seconds).toBe(699);
  });

  it("scopes annotations to a pool or a name, and leaves fleet-wide ones everywhere", () => {
    const names = (a: ReturnType<typeof annotationsFor>) => a.map((x) => x.label);
    expect(names(annotationsFor("pool", ["wsl-ephemeral"]))).toEqual(["WSL tool cache + CPU quota (#314)"]);
    expect(names(annotationsFor("job", ["o/r", "CI", "Plan and classify", "mac-linux-arm64"]))).toEqual([
      "Mac image: tool cache seeded, memory cap 6 GB",
      "Gate tofu cache (Plan 1,057 s to about 23 s)",
    ]);
  });
});

describe("dayOf", () => {
  it("is the UTC date", () => expect(dayOf(Date.parse("2026-11-23T23:59:59Z"))).toBe("2026-11-23"));
});
