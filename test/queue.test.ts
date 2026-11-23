import { afterEach, describe, expect, it, vi } from "vitest";
import { listQueuedJobs, CallBudget } from "../src/github";
import { isFleetLabelSet, summarizeQueue, type QueuedJob } from "../src/queue";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const q = (over: Partial<QueuedJob>): QueuedJob => ({
  repo: "o/r", workflow: "CI", job: "Build", labels: "self-hosted,Linux", createdAt: "2026-11-23T11:59:00Z", url: "u", ...over,
});
const meta = { partial: false, runsScanned: 3, reposSkipped: 0, ghostRuns: 0 };

describe("isFleetLabelSet", () => {
  it("recognises the fleet and excludes GitHub-hosted images", () => {
    expect(isFleetLabelSet(["self-hosted", "Linux"])).toBe(true);
    expect(isFleetLabelSet(["dependabot"])).toBe(true);
    expect(isFleetLabelSet(["ubuntu-latest"])).toBe(false);
    expect(isFleetLabelSet(["ubuntu-24.04-arm"])).toBe(false);
    expect(isFleetLabelSet(["windows-2025"])).toBe(false);
    expect(isFleetLabelSet(["macos-15"])).toBe(false);
    expect(isFleetLabelSet([])).toBe(false);
  });
});

describe("summarizeQueue", () => {
  it("counts waiting jobs, the oldest wait and groups by label set", () => {
    const s = summarizeQueue(
      [
        q({ job: "a", createdAt: "2026-11-23T11:50:00Z" }), // 10 min
        q({ job: "b", createdAt: "2026-11-23T11:58:00Z" }), // 2 min
        q({ job: "c", labels: "self-hosted,Linux,container", createdAt: "2026-11-23T11:48:00Z" }), // 12 min
      ],
      NOW,
      meta,
    );
    expect(s.waiting).toBe(3);
    expect(s.oldest_s).toBe(720);
    expect(s.by_labels).toEqual([
      { labels: "self-hosted,Linux", n: 2, oldest_s: 600 },
      { labels: "self-hosted,Linux,container", n: 1, oldest_s: 720 },
    ]);
    expect(s.oldest.map((j) => j.job)).toEqual(["c", "a", "b"]);
  });

  it("an empty queue is zero waiting, oldest 0", () => {
    const s = summarizeQueue([], NOW, meta);
    expect([s.waiting, s.oldest_s, s.by_labels, s.oldest]).toEqual([0, 0, [], []]);
  });

  it("limits the oldest list and passes the partial flag through", () => {
    const jobs = Array.from({ length: 12 }, (_, i) => q({ job: `j${i}`, createdAt: new Date(NOW - (i + 1) * 60_000).toISOString() }));
    const s = summarizeQueue(jobs, NOW, { ...meta, partial: true });
    expect(s.oldest).toHaveLength(8);
    expect(s.partial).toBe(true);
    expect(s.waiting).toBe(12);
  });

  it("never reports a negative wait", () => {
    expect(summarizeQueue([q({ createdAt: "2026-11-23T12:00:05Z" })], NOW, meta).oldest_s).toBe(0);
  });
});

describe("listQueuedJobs", () => {
  afterEach(() => vi.unstubAllGlobals());
  const opts = { maxRepos: 20, ghostAfterMs: 3 * 86_400_000 };

  function stub() {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (url.includes("/actions/runs?status=queued")) {
        return Response.json({
          workflow_runs: [
            { id: 1, name: "CI", html_url: "h1", status: "queued", run_attempt: 1, pull_requests: [], created_at: "2026-11-23T11:55:00Z" },
            { id: 2, name: "Dependency sweep", html_url: "h2", status: "queued", run_attempt: 1, pull_requests: [], created_at: "2026-10-07T00:00:00Z" },
          ],
        });
      }
      return Response.json({
        total_count: 3,
        jobs: [
          { id: 10, name: "Vitest", status: "queued", labels: ["self-hosted", "Linux"], created_at: "2026-11-23T11:55:00Z", conclusion: null, started_at: "", completed_at: null, runner_name: null, runner_group_name: null },
          { id: 11, name: "hosted", status: "queued", labels: ["ubuntu-latest"], created_at: "2026-11-23T11:55:00Z", conclusion: null, started_at: "", completed_at: null, runner_name: null, runner_group_name: null },
          { id: 12, name: "Lint", status: "in_progress", labels: ["self-hosted", "Linux"], created_at: "2026-11-23T11:55:00Z", conclusion: null, started_at: "x", completed_at: null, runner_name: "r", runner_group_name: null },
        ],
      });
    });
    return urls;
  }

  it("keeps only queued fleet jobs and skips ghost runs without spending calls on them", async () => {
    const urls = stub();
    const r = await listQueuedJobs("o", ["r"], "t", new CallBudget(10), NOW, opts);
    expect(r.jobs.map((j) => [j.job, j.labels])).toEqual([["Vitest", "self-hosted,Linux"]]);
    expect(r.ghostRuns).toBe(1);
    expect(r.runsScanned).toBe(1);
    expect(r.partial).toBe(false);
    expect(urls).toHaveLength(2); // one runs list + one jobs list; the ghost run costs nothing
  });

  it("reports a partial result, not an error, when the budget runs out", async () => {
    stub();
    const r = await listQueuedJobs("o", ["a", "b", "c"], "t", new CallBudget(2), NOW, opts);
    expect(r.partial).toBe(true);
    expect(r.jobs).toHaveLength(1); // what was read before running out is kept
    expect(r.reposSkipped).toBeGreaterThan(0);
  });

  it("only reads maxRepos repos and says how many were left out", async () => {
    stub();
    const r = await listQueuedJobs("o", ["a", "b", "c"], "t", new CallBudget(50), NOW, { ...opts, maxRepos: 1 });
    expect(r.reposSkipped).toBe(2);
  });
});
