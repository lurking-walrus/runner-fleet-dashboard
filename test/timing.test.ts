import { describe, expect, it } from "vitest";
import { labelsKey, queueSeconds, secondsBetween, stepTimings } from "../src/timing";

describe("secondsBetween / queueSeconds", () => {
  it("measures whole seconds", () => {
    expect(secondsBetween("2026-11-23T10:00:00Z", "2026-11-23T10:00:21Z")).toBe(21);
    expect(queueSeconds("2026-11-23T10:00:00Z", "2026-11-23T10:16:05Z")).toBe(965);
  });
  it("never goes negative (clock skew between GitHub services)", () => {
    expect(queueSeconds("2026-11-23T10:00:05Z", "2026-11-23T10:00:00Z")).toBe(0);
  });
  it("is null, not 0, when a timestamp is missing or unusable", () => {
    expect(queueSeconds(undefined, "2026-11-23T10:00:00Z")).toBeNull();
    expect(queueSeconds("2026-11-23T10:00:00Z", null)).toBeNull();
    expect(queueSeconds("nope", "2026-11-23T10:00:00Z")).toBeNull();
  });
});

describe("labelsKey", () => {
  it("treats runs-on order as irrelevant and puts self-hosted first", () => {
    expect(labelsKey(["Linux", "self-hosted"])).toBe("self-hosted,Linux");
    expect(labelsKey(["self-hosted", "Linux"])).toBe("self-hosted,Linux");
    expect(labelsKey(["X64", "self-hosted", "linux"])).toBe("self-hosted,linux,X64");
  });
  it("de-duplicates and handles no labels", () => {
    expect(labelsKey(["dependabot", "dependabot"])).toBe("dependabot");
    expect(labelsKey([])).toBe("");
    expect(labelsKey(undefined)).toBe("");
  });
});

describe("stepTimings", () => {
  it("keeps executed steps, including instant ones, and drops skipped ones", () => {
    const steps = stepTimings([
      { number: 1, name: "Set up job", conclusion: "success", started_at: "2026-11-23T10:00:00Z", completed_at: "2026-11-23T10:00:02Z" },
      { number: 2, name: "actions/setup-node", conclusion: "success", started_at: "2026-11-23T10:00:02Z", completed_at: "2026-11-23T10:00:02Z" },
      { number: 3, name: "Skipped", conclusion: "skipped", started_at: null, completed_at: null },
      { number: 4, name: "pnpm build", conclusion: "failure", started_at: "2026-11-23T10:00:02Z", completed_at: "2026-11-23T10:02:50Z" },
    ]);
    expect(steps).toEqual([
      { seq: 1, name: "Set up job", durationS: 2, conclusion: "success" },
      { seq: 2, name: "actions/setup-node", durationS: 0, conclusion: "success" },
      { seq: 4, name: "pnpm build", durationS: 168, conclusion: "failure" },
    ]);
  });
  it("tolerates a payload with no steps", () => {
    expect(stepTimings(undefined)).toEqual([]);
  });
});
