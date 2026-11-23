// Known changes and known "before" numbers, seeded from Lurking-Walrus/.github-private
// docs/RUNNER-FLEET.md ("What changed", "Before and after"). They are drawn on the trend charts so a
// fix shows up as a drop right where it landed. Pure data plus two matchers; no imports.

export interface Annotation {
  date: string; // YYYY-MM-DD (UTC)
  label: string;
  /** Show only on series of this pool (exact). Omit for fleet-wide. */
  pool?: string;
  /** Show only on series whose job or step name contains this text (case-insensitive). */
  text?: string;
}

export interface Baseline {
  kind: "job" | "step";
  repo: string;
  /** Job name equals (kind job) or step name contains (kind step), case-insensitive. */
  name: string;
  seconds: number;
  label: string;
}

export const ANNOTATIONS: Annotation[] = [
  { date: "2026-11-22", pool: "mac-linux-arm64", label: "Mac image: tool cache seeded, memory cap 6 GB" },
  { date: "2026-11-23", pool: "wsl-ephemeral", label: "WSL tool cache + CPU quota (#314)" },
  { date: "2026-11-23", text: "Plan and classify", label: "Gate tofu cache (Plan 1,057 s to about 23 s)" },
  { date: "2026-11-23", text: "tofu init", label: "Gate tofu cache" },
];

const CM = "Lurking-Walrus/career-manager";
export const BASELINES: Baseline[] = [
  { kind: "job", repo: CM, name: "Vitest", seconds: 546, label: "before 2026-11-22: avg 546 s" },
  { kind: "job", repo: CM, name: "Semgrep", seconds: 364, label: "before 2026-11-22: avg 364 s" },
  { kind: "job", repo: CM, name: "Build", seconds: 228, label: "before 2026-11-22: avg 228 s" },
  { kind: "job", repo: CM, name: "Type check", seconds: 144, label: "before 2026-11-22: avg 144 s" },
  { kind: "job", repo: CM, name: "Lint", seconds: 106, label: "before 2026-11-22: avg 106 s" },
  { kind: "job", repo: CM, name: "Plan and classify", seconds: 1057, label: "before gate tofu cache: 1,057 s (run 45082181950)" },
  { kind: "job", repo: CM, name: "Apply", seconds: 729, label: "before gate tofu cache: 729 s (run 45082181950)" },
  { kind: "step", repo: CM, name: "tofu init", seconds: 699, label: "before gate tofu cache: 699 s (run 45082181950)" },
];

/** Key layout: [repo, workflow, job, pool] for jobs, [repo, workflow, job, pool, step] for steps. */
export function baselineFor(kind: "job" | "step", key: readonly string[]): Baseline | undefined {
  const [repo = "", , job = "", , step = ""] = key;
  return BASELINES.find((b) => {
    if (b.kind !== kind || b.repo.toLowerCase() !== repo.toLowerCase()) return false;
    return kind === "job"
      ? job.toLowerCase() === b.name.toLowerCase()
      : step.toLowerCase().includes(b.name.toLowerCase()) && job.length > 0;
  });
}

export function annotationsFor(kind: "job" | "step" | "pool", key: readonly string[]): Annotation[] {
  const pool = kind === "pool" ? (key[0] ?? "") : (key[3] ?? "");
  const hay = (kind === "pool" ? "" : kind === "job" ? (key[2] ?? "") : `${key[2] ?? ""} ${key[4] ?? ""}`).toLowerCase();
  return ANNOTATIONS.filter((a) => {
    if (a.pool && a.pool !== pool) return false;
    if (a.text && !hay.includes(a.text.toLowerCase())) return false;
    return true;
  });
}
