import { afterEach, describe, expect, it, vi } from "vitest";
import { pruneJobTimings, recordSyncedRun } from "../src/db";
import { listUnsyncedCompletedRuns, type CompletedSelfHostedJob } from "../src/github";
import { migratedDb } from "./d1-sqlite";

function job(over: Partial<CompletedSelfHostedJob> = {}): CompletedSelfHostedJob {
  return {
    runKey: "o/r#1.1",
    jobId: 100,
    runnerName: "wsl-ephemeral-3-1791294671",
    repo: "o/r",
    workflowName: "CI",
    jobName: "Vitest",
    runUrl: "https://github.com/o/r/actions/runs/1",
    startedAt: "2026-11-23T10:00:10Z",
    finishedAt: "2026-11-23T10:05:10Z",
    conclusion: "success",
    createdAt: "2026-11-23T10:00:00Z",
    queueS: 10,
    labels: "self-hosted,Linux",
    steps: [
      { seq: 1, name: "Set up job", durationS: 1, conclusion: "success" },
      { seq: 2, name: "pnpm test", durationS: 290, conclusion: "success" },
    ],
    ...over,
  };
}

describe("recordSyncedRun", () => {
  it("stores the job's timings and its steps, and reports it as new", async () => {
    const { db, raw } = migratedDb();
    const fresh = await recordSyncedRun(db, "o/r#1.1", [job()], "2026-11-23T10:06:00Z");
    expect(fresh.map((j) => j.jobId)).toEqual([100]);
    expect(raw.prepare(`SELECT pool, queue_s, duration_s, labels FROM job_history`).get()).toMatchObject({
      pool: "wsl-ephemeral-3".replace(/-3$/, ""),
      queue_s: 10,
      duration_s: 300,
      labels: "self-hosted,Linux",
    });
    expect(raw.prepare(`SELECT name, duration_s FROM job_steps ORDER BY seq`).all()).toEqual([
      { name: "Set up job", duration_s: 1 },
      { name: "pnpm test", duration_s: 290 },
    ]);
    expect(raw.prepare(`SELECT count(*) c FROM synced_runs`).get()).toEqual({ c: 1 });
  });

  it("fills in a pre-existing timing-less row without reporting it as new", async () => {
    const { db, raw } = migratedDb();
    raw.exec(`INSERT INTO job_history (job_id, pool, runner_name, repo, workflow_name, job_name, run_url, started_at, finished_at, duration_s, conclusion)
      VALUES (100, 'wsl-ephemeral', 'x', 'o/r', 'CI', 'Vitest', 'u', '2026-11-23T10:00:10Z', '2026-11-23T10:05:10Z', 300, 'failure')`);
    const fresh = await recordSyncedRun(db, "o/r#1.1", [job()], "2026-11-23T10:06:00Z");
    expect(fresh).toEqual([]); // no duplicate job_failed event on a re-fetch
    expect(raw.prepare(`SELECT queue_s, labels FROM job_history WHERE job_id = 100`).get()).toMatchObject({
      queue_s: 10,
      labels: "self-hosted,Linux",
    });
    expect(raw.prepare(`SELECT count(*) c FROM job_steps`).get()).toEqual({ c: 2 });
  });

  it("is idempotent: a second pass adds no rows", async () => {
    const { db, raw } = migratedDb();
    await recordSyncedRun(db, "o/r#1.1", [job()], "t");
    const again = await recordSyncedRun(db, "o/r#1.1", [job()], "t");
    expect(again).toEqual([]);
    expect(raw.prepare(`SELECT count(*) c FROM job_history`).get()).toEqual({ c: 1 });
    expect(raw.prepare(`SELECT count(*) c FROM job_steps`).get()).toEqual({ c: 2 });
  });

  it("splits a long step list into statements under D1's 100-parameter limit", async () => {
    const { db, raw } = migratedDb();
    const steps = Array.from({ length: 50 }, (_, i) => ({ seq: i + 1, name: `step ${i}`, durationS: i, conclusion: "success" }));
    await recordSyncedRun(db, "o/r#1.1", [job({ steps })], "t");
    expect(raw.prepare(`SELECT count(*) c FROM job_steps`).get()).toEqual({ c: 50 });
  });

  it("marks a run with no self-hosted jobs synced", async () => {
    const { db, raw } = migratedDb();
    expect(await recordSyncedRun(db, "o/r#2.1", [], "t")).toEqual([]);
    expect(raw.prepare(`SELECT count(*) c FROM synced_runs`).get()).toEqual({ c: 1 });
  });
});

describe("pruneJobTimings", () => {
  it("removes old jobs and their steps, keeps recent ones", async () => {
    const { db, raw } = migratedDb();
    await recordSyncedRun(db, "a", [job({ jobId: 1, finishedAt: "2026-11-01T00:00:00Z", startedAt: "2026-11-01T00:00:00Z" })], "t");
    await recordSyncedRun(db, "b", [job({ jobId: 2 })], "t");
    await pruneJobTimings(db, "2026-11-10T00:00:00Z");
    expect(raw.prepare(`SELECT job_id FROM job_history`).all()).toEqual([{ job_id: 2 }]);
    expect(raw.prepare(`SELECT DISTINCT job_id FROM job_steps`).all()).toEqual([{ job_id: 2 }]);
  });
});

describe("listUnsyncedCompletedRuns", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads queue time, labels and steps from the ONE jobs call per run (no extra GitHub calls)", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (url.includes("/actions/runs?")) {
        return Response.json({ workflow_runs: [{ id: 7, name: "CI", html_url: "h", status: "completed", run_attempt: 1, pull_requests: [] }] });
      }
      return Response.json({
        total_count: 2,
        jobs: [
          {
            id: 70, name: "Build", status: "completed", conclusion: "success",
            created_at: "2026-11-23T10:00:00Z", started_at: "2026-11-23T10:00:30Z", completed_at: "2026-11-23T10:04:00Z",
            runner_name: "mac-linux-arm64-1-1791294671", runner_group_name: "Default", labels: ["Linux", "self-hosted", "container"],
            steps: [{ number: 1, name: "Set up job", conclusion: "success", started_at: "2026-11-23T10:00:30Z", completed_at: "2026-11-23T10:00:31Z" }],
          },
          {
            id: 71, name: "hosted", status: "completed", conclusion: "success",
            created_at: "2026-11-23T10:00:00Z", started_at: "2026-11-23T10:00:01Z", completed_at: "2026-11-23T10:00:05Z",
            runner_name: "GitHub Actions 5", runner_group_name: "GitHub Actions", labels: ["ubuntu-latest"], steps: [],
          },
        ],
      });
    });
    const runs = await listUnsyncedCompletedRuns("o", "r", 86_400_000, new Set(), "tok", 20);
    expect(urls.filter((u) => u.includes("/jobs"))).toHaveLength(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.jobs).toHaveLength(1); // GitHub-hosted job excluded
    expect(runs[0]!.jobs[0]).toMatchObject({
      queueS: 30,
      labels: "self-hosted,container,Linux",
      steps: [{ seq: 1, name: "Set up job", durationS: 1 }],
    });
  });
});
