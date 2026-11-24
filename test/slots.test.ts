import { describe, expect, it } from "vitest";
import { derivePool, deriveSlot } from "../src/github";
import { buildSlotUsage } from "../src/state";
import { migratedDb } from "./d1-sqlite";

describe("deriveSlot", () => {
  it("strips only the ephemeral registration timestamp", () => {
    expect(deriveSlot("wsl-ephemeral-3-1795490600")).toBe("wsl-ephemeral-3");
    expect(deriveSlot("mac-linux-arm64-1-1795490581")).toBe("mac-linux-arm64-1");
    expect(deriveSlot("win-desktop-1795470145")).toBe("win-desktop");
    expect(deriveSlot("ci-host-a-linux-3")).toBe("ci-host-a-linux-3");
    expect(derivePool("wsl-ephemeral-3-1795490600")).toBe("wsl-ephemeral");
  });
});

describe("buildSlotUsage", () => {
  const now = Date.parse("2026-11-24T04:00:00Z");
  function insert(raw: import("node:sqlite").DatabaseSync, id: number, runner: string, finished: string, repo = "o/r") {
    raw
      .prepare(
        `INSERT INTO job_history (job_id, pool, runner_name, repo, workflow_name, job_name, run_url, started_at, finished_at, duration_s, conclusion)
         VALUES (?, ?, ?, ?, 'CI', 'test', ?, ?, ?, 60, 'success')`,
      )
      .run(id, derivePool(runner), runner, repo, `https://github.com/${repo}/actions/runs/${id}`, finished, finished);
  }

  it("merges every registration of a slot and keeps the latest job", async () => {
    const { db, raw } = migratedDb();
    insert(raw, 1, "wsl-ephemeral-1-1795480000", "2026-11-24T03:00:00Z", "o/old");
    insert(raw, 2, "wsl-ephemeral-1-1795490000", "2026-11-24T03:50:00Z", "o/new");
    insert(raw, 3, "wsl-ephemeral-1-1795400000", "2026-11-21T03:00:00Z");
    insert(raw, 4, "wsl-ephemeral-2-1795490001", "2026-11-24T02:00:00Z");
    insert(raw, 5, "wsl-ephemeral-3-1795000000", "2026-11-10T00:00:00Z"); // older than 7 days
    const slots = await buildSlotUsage(db, now);
    expect(slots["wsl-ephemeral-1"]).toMatchObject({
      last_job_at: "2026-11-24T03:50:00Z",
      repo: "o/new",
      run_url: "https://github.com/o/new/actions/runs/2",
      jobs_24h: 2,
      jobs_7d: 3,
    });
    expect(slots["wsl-ephemeral-2"]).toMatchObject({ jobs_24h: 1, jobs_7d: 1 });
    expect(slots["wsl-ephemeral-3"]).toBeUndefined();
  });
});
