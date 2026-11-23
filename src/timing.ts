// Pure helpers that turn one GitHub job payload into the timing rows we store. No imports besides
// types, so they are unit-testable without a Worker.

export interface GhStepLike {
  number: number;
  name: string;
  status?: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface StepTiming {
  seq: number;
  name: string;
  durationS: number;
  conclusion: string | null;
}

/** Whole seconds between two ISO timestamps, never negative; null when either is unusable. */
export function secondsBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 1000));
}

/**
 * Queue time is created -> started. Jobs created before GitHub started reporting created_at, or
 * whose timestamps are unusable, have no queue time (null) rather than a made-up 0.
 */
export function queueSeconds(createdAt: string | null | undefined, startedAt: string | null | undefined): number | null {
  return secondsBetween(createdAt, startedAt);
}

/**
 * The requested runs-on label set as one stable string. `runs-on: [self-hosted, Linux]` and
 * `[Linux, self-hosted]` ask for the same thing, so order is canonicalised: "self-hosted" first,
 * then the rest case-insensitively. Empty for a job that reports no labels.
 */
export function labelsKey(labels: readonly string[] | null | undefined): string {
  if (!labels || labels.length === 0) return "";
  const uniq = [...new Set(labels)];
  uniq.sort((x, y) => {
    if (x === "self-hosted") return y === "self-hosted" ? 0 : -1;
    if (y === "self-hosted") return 1;
    return x.toLowerCase().localeCompare(y.toLowerCase());
  });
  return uniq.join(",");
}

/**
 * The steps of a COMPLETED job that actually ran. Skipped steps carry no timestamps and are
 * dropped. Everything else is kept, including 0-second steps: dropping them would bias every
 * percentile upward for steps that are usually instant.
 */
export function stepTimings(steps: readonly GhStepLike[] | null | undefined): StepTiming[] {
  const out: StepTiming[] = [];
  for (const s of steps ?? []) {
    const durationS = secondsBetween(s.started_at, s.completed_at);
    if (durationS === null) continue;
    out.push({ seq: s.number, name: s.name, durationS, conclusion: s.conclusion });
  }
  return out;
}
