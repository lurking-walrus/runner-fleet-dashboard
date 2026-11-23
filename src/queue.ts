// Pure: turns the queued jobs the snapshot found into the numbers the panel shows.

export interface QueuedJob {
  repo: string;
  workflow: string;
  job: string;
  labels: string; // canonical requested label set (labelsKey)
  createdAt: string;
  url: string;
}

export interface QueueSummary {
  taken_at: string;
  /** True when the GitHub-call budget ran out before every repo was read: the counts are a floor. */
  partial: boolean;
  waiting: number;
  oldest_s: number;
  by_labels: { labels: string; n: number; oldest_s: number }[];
  oldest: { repo: string; workflow: string; job: string; labels: string; waiting_s: number; url: string }[];
  runs_scanned: number;
  repos_skipped: number;
  /** Queued runs older than the ghost cutoff, ignored (a run can sit `queued` with no jobs for weeks). */
  ghost_runs: number;
}

/** GitHub-hosted runner labels (ubuntu-latest, windows-2025, macos-15, ubuntu-24.04-arm, ...). */
const HOSTED = /^(ubuntu|windows|macos)(-|$)/i;

/**
 * Does a job with these requested labels wait for the self-hosted fleet? `self-hosted` says so, and so
 * does any label that is not a GitHub-hosted image name (Dependabot jobs ask for `dependabot` alone).
 */
export function isFleetLabelSet(labels: readonly string[]): boolean {
  if (labels.length === 0) return false;
  if (labels.includes("self-hosted")) return true;
  return labels.some((l) => !HOSTED.test(l));
}

export function summarizeQueue(
  jobs: readonly QueuedJob[],
  nowMs: number,
  meta: { partial: boolean; runsScanned: number; reposSkipped: number; ghostRuns: number },
  maxOldest = 8,
): QueueSummary {
  const waitS = (j: QueuedJob) => Math.max(0, Math.round((nowMs - Date.parse(j.createdAt)) / 1000));
  const groups = new Map<string, { n: number; oldest_s: number }>();
  for (const j of jobs) {
    const g = groups.get(j.labels) ?? { n: 0, oldest_s: 0 };
    g.n += 1;
    g.oldest_s = Math.max(g.oldest_s, waitS(j));
    groups.set(j.labels, g);
  }
  const ranked = [...jobs].sort((a, b) => waitS(b) - waitS(a));
  return {
    taken_at: new Date(nowMs).toISOString(),
    partial: meta.partial,
    waiting: jobs.length,
    oldest_s: ranked[0] ? waitS(ranked[0]) : 0,
    by_labels: [...groups.entries()]
      .map(([labels, g]) => ({ labels, ...g }))
      .sort((a, b) => b.n - a.n || b.oldest_s - a.oldest_s || a.labels.localeCompare(b.labels)),
    oldest: ranked.slice(0, maxOldest).map((j) => ({
      repo: j.repo,
      workflow: j.workflow,
      job: j.job,
      labels: j.labels,
      waiting_s: waitS(j),
      url: j.url,
    })),
    runs_scanned: meta.runsScanned,
    repos_skipped: meta.reposSkipped,
    ghost_runs: meta.ghostRuns,
  };
}
