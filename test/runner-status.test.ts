import { describe, expect, it } from "vitest";
import { upsertRunner } from "../src/db";
import { effectiveRunnerStatus } from "../src/runner-status";
import type { GhRunner } from "../src/types";
import { migratedDb } from "./d1-sqlite";

const online = { status: "online", busy: 1, offline_reports: 0 };

describe("effectiveRunnerStatus", () => {
  it("holds one offline report for an online runner, keeping it busy", () => {
    expect(effectiveRunnerStatus({ status: "offline", busy: false }, online, 2)).toEqual({
      status: "online",
      busy: true,
      offlineReports: 1,
      held: true,
    });
  });

  it("shows it offline on the second report in a row", () => {
    const held = { ...online, offline_reports: 1 };
    expect(effectiveRunnerStatus({ status: "offline", busy: false }, held, 2)).toMatchObject({
      status: "offline",
      busy: false,
      offlineReports: 2,
      held: false,
    });
  });

  it("resets the count when GitHub reports it online again", () => {
    const held = { ...online, offline_reports: 1 };
    expect(effectiveRunnerStatus({ status: "online", busy: false }, held, 2)).toEqual({
      status: "online",
      busy: false,
      offlineReports: 0,
      held: false,
    });
  });

  it("takes GitHub's word for a runner it has never seen, or one already offline", () => {
    expect(effectiveRunnerStatus({ status: "offline", busy: false }, undefined, 2).status).toBe("offline");
    const off = { status: "offline", busy: 0, offline_reports: 5 };
    expect(effectiveRunnerStatus({ status: "offline", busy: false }, off, 2)).toMatchObject({
      status: "offline",
      offlineReports: 6,
    });
  });

  it("does not debounce when confirmPolls is 1", () => {
    expect(effectiveRunnerStatus({ status: "offline", busy: false }, online, 1).status).toBe("offline");
  });
});

describe("upsertRunner", () => {
  it("stores the offline report count", async () => {
    const { db, raw } = migratedDb();
    const runner: GhRunner = { id: 1, name: "wsl-ephemeral-1-1", os: "Linux", status: "online", busy: true, version: "2.330.0", labels: [] };
    await upsertRunner(db, runner, "org:o", "2026-11-24T03:30:00Z", 1);
    expect(raw.prepare(`SELECT status, busy, offline_reports FROM runners`).get()).toEqual({
      status: "online",
      busy: 1,
      offline_reports: 1,
    });
    await upsertRunner(db, runner, "org:o", "2026-11-24T03:32:00Z");
    expect(raw.prepare(`SELECT offline_reports FROM runners`).get()).toEqual({ offline_reports: 0 });
  });
});

describe("the 2026-11-24 flap, replayed", () => {
  it("keeps a runner online through two offline polls with confirmPolls 3", () => {
    let prev = { status: "online", busy: 1, offline_reports: 0 };
    for (const reported of ["offline", "offline", "online"]) {
      const eff = effectiveRunnerStatus({ status: reported, busy: false }, prev, 3);
      expect(eff.status).toBe("online");
      prev = { status: eff.status, busy: eff.busy ? 1 : 0, offline_reports: eff.offlineReports };
    }
  });

  it("shows a real outage offline on the third poll", () => {
    let prev = { status: "online", busy: 0, offline_reports: 0 };
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const eff = effectiveRunnerStatus({ status: "offline", busy: false }, prev, 3);
      seen.push(eff.status);
      prev = { status: eff.status, busy: 0, offline_reports: eff.offlineReports };
    }
    expect(seen).toEqual(["online", "online", "offline"]);
  });
});
