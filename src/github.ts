import { labelsKey, queueSeconds, stepTimings, type StepTiming } from "./timing";
import type { GhJob, GhRun, GhRunner, PollScope, ResolvedJob } from "./types";

const API = "https://api.github.com";

/**
 * A cap on how many GitHub calls one invocation may still make. Workers limit subrequests per
 * invocation (50 on the Free plan), and going over throws "Too many subrequests" — which used to
 * fail the WHOLE poll, so runner status was lost along with the job details. Callers check
 * `take()` before an optional call and simply stop resolving when it says no.
 */
export class CallBudget {
  constructor(public remaining: number) {}
  take(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining -= 1;
    return true;
  }
}

async function gh(path: string, token: string): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "runner-fleet-dashboard",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub ${path} -> ${res.status} ${await res.text()}`);
  }
  return res;
}

export function parseScopes(raw: string): PollScope[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [kind, rest = ""] = s.split(":", 2);
      if (kind === "org") return { kind: "org", owner: rest } as PollScope;
      const [owner, repo] = rest.split("/");
      return { kind: "repo", owner, repo } as PollScope;
    });
}

/**
 * Runner name minus a trailing "-N" slot index — groups a fleet of runners back to one physical host.
 * Ephemeral (JIT) runners get a unix-timestamp suffix per registration, e.g.
 * "mac-linux-arm64-1-1791294671"; strip that first so they group as "mac-linux-arm64".
 */
export function derivePool(name: string): string {
  return name.replace(/-\d{9,}$/, "").replace(/-\d+$/, "");
}

export async function listRunnersForScope(
  scope: PollScope,
  token: string,
): Promise<{ runner: GhRunner; scopeLabel: string }[]> {
  const path =
    scope.kind === "org"
      ? `/orgs/${scope.owner}/actions/runners?per_page=100`
      : `/repos/${scope.owner}/${scope.repo}/actions/runners?per_page=100`;
  const res = await gh(path, token);
  const body = (await res.json()) as { runners: GhRunner[] };
  const scopeLabel = scope.kind === "org" ? `org:${scope.owner}` : `repo:${scope.owner}/${scope.repo}`;
  return body.runners.map((runner) => ({ runner, scopeLabel }));
}

/**
 * Every repo an org-scoped runner fleet could plausibly be running a job for, most recently
 * pushed first — the repos with live runs are almost always at the front, so a busy-runner scan
 * that stops as soon as every runner is accounted for rarely reaches the tail.
 */
export async function listOrgRepos(org: string, token: string): Promise<string[]> {
  const repos: string[] = [];
  let page = 1;
  for (;;) {
    const res = await gh(`/orgs/${org}/repos?per_page=100&page=${page}&sort=pushed&direction=desc`, token);
    const body = (await res.json()) as { name: string }[];
    repos.push(...body.map((r) => r.name));
    if (body.length < 100) break;
    page += 1;
  }
  return repos;
}

/**
 * Run statuses that can hold a job that is running on a runner right now. `in_progress` first:
 * those are the likeliest to hold a busy runner.
 */
const ACTIVE_RUN_STATUSES = ["in_progress", "queued"] as const;

/**
 * Finds the job currently occupying each of `busyRunnerNames` in one repo.
 *
 * Looks at `queued` runs as well as `in_progress` ones. GitHub keeps a run `queued` while ANY of its
 * jobs is still waiting for a runner, even though its other jobs are already running — so on a busy
 * fleet (a CI run fans out to more jobs than there are free runners) many busy runners belong to
 * `queued` runs. Filtering on `in_progress` alone left those runners unresolved and the dashboard
 * drew them as "online · busy" next to "idle" (measured 2026-11-22: 5 of 7 busy runners were in
 * queued runs).
 *
 * One call per status, NOT one unfiltered list: a page of 50 unfiltered runs is ~700 KB of JSON
 * (measured on the busiest repo), and parsing that for every repo would blow the Workers Free
 * plan's 10 ms CPU limit. The filtered lists are 15-45 KB.
 *
 * Every GitHub call is taken from `budget`; when it runs out the scan stops and returns what it
 * found, and the caller shows the rest as busy with an unidentified job rather than failing.
 */
export async function resolveJobsInRepo(
  owner: string,
  repo: string,
  busyRunnerNames: Set<string>,
  token: string,
  budget: CallBudget,
): Promise<ResolvedJob[]> {
  const pending = new Set(busyRunnerNames);
  const runs: GhRun[] = [];
  for (const status of ACTIVE_RUN_STATUSES) {
    if (!budget.take()) break;
    const runsRes = await gh(`/repos/${owner}/${repo}/actions/runs?status=${status}&per_page=100`, token);
    const runsBody = (await runsRes.json()) as { workflow_runs: GhRun[] };
    runs.push(...runsBody.workflow_runs);
  }

  const found: ResolvedJob[] = [];
  for (const run of runs) {
    if (pending.size === 0) break;
    const jobs = await listRunJobs(owner, repo, run.id, token, "latest", budget);
    if (jobs === null) break; // budget exhausted
    for (const job of jobs) {
      if (job.status !== "in_progress" || !job.runner_name) continue;
      if (!pending.has(job.runner_name)) continue;
      pending.delete(job.runner_name);
      const pr = run.pull_requests[0] ?? null;
      found.push({
        runnerName: job.runner_name,
        repo: `${owner}/${repo}`,
        runId: run.id,
        runUrl: run.html_url,
        jobId: job.id,
        jobName: job.name,
        workflowName: run.name,
        jobStartedAt: job.started_at,
        prNumber: pr?.number ?? null,
        prUrl: pr ? `https://github.com/${owner}/${repo}/pull/${pr.number}` : null,
      });
    }
  }
  return found;
}

/**
 * Every job in a run, paginated (the API defaults to 30 per page, which cuts off big matrices).
 * History wants `all` attempts — a re-run's first-attempt jobs used runner time too; resolving what
 * is running NOW only needs the `latest`. With a `budget`, returns null once it is exhausted.
 */
async function listRunJobs(owner: string, repo: string, runId: number, token: string): Promise<GhJob[]>;
async function listRunJobs(
  owner: string,
  repo: string,
  runId: number,
  token: string,
  filter: "all" | "latest",
  budget: CallBudget,
): Promise<GhJob[] | null>;
async function listRunJobs(
  owner: string,
  repo: string,
  runId: number,
  token: string,
  filter: "all" | "latest" = "all",
  budget?: CallBudget,
): Promise<GhJob[] | null> {
  const jobs: GhJob[] = [];
  for (let page = 1; ; page++) {
    if (budget && !budget.take()) return null;
    const res = await gh(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs?filter=${filter}&per_page=100&page=${page}`, token);
    const body = (await res.json()) as { jobs: GhJob[]; total_count: number };
    jobs.push(...body.jobs);
    if (body.jobs.length < 100 || jobs.length >= body.total_count) return jobs;
  }
}

export interface CompletedSelfHostedJob {
  runKey: string;
  jobId: number;
  runnerName: string;
  repo: string;
  workflowName: string;
  jobName: string;
  runUrl: string;
  startedAt: string;
  finishedAt: string;
  conclusion: string | null;
  createdAt: string | null;
  queueS: number | null;
  labels: string;
  steps: StepTiming[];
}

/**
 * Completed runs created in the last `lookbackMs` whose (run, attempt) isn't in `alreadySynced`,
 * returned per run with the self-hosted jobs they contain (at most `maxRuns` runs, newest first). A run with no self-hosted jobs still
 * comes back (with an empty job list) so the caller can mark it synced and skip it next time.
 */
export async function listUnsyncedCompletedRuns(
  owner: string,
  repo: string,
  lookbackMs: number,
  alreadySynced: Set<string>,
  token: string,
  maxRuns: number,
): Promise<{ runKey: string; jobs: CompletedSelfHostedJob[] }[]> {
  const since = new Date(Date.now() - lookbackMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const out: { runKey: string; jobs: CompletedSelfHostedJob[] }[] = [];
  for (let page = 1; ; page++) {
    const res = await gh(
      `/repos/${owner}/${repo}/actions/runs?status=completed&created=${encodeURIComponent(`>=${since}`)}&per_page=100&page=${page}`,
      token,
    );
    const body = (await res.json()) as { workflow_runs: GhRun[] };
    for (const run of body.workflow_runs) {
      const runKey = `${owner}/${repo}#${run.id}.${run.run_attempt}`;
      if (alreadySynced.has(runKey)) continue;
      if (out.length >= maxRuns) return out;
      const jobs: CompletedSelfHostedJob[] = [];
      for (const job of await listRunJobs(owner, repo, run.id, token)) {
        // Skipped/cancelled-while-queued jobs never got a runner. GitHub-hosted jobs report the
        // "GitHub Actions" runner group. Don't filter on the "self-hosted" label: Dependabot jobs
        // land on the fleet with runs-on: [dependabot] and no such label.
        if (!job.runner_name || !job.started_at || !job.completed_at) continue;
        if (job.runner_group_name === "GitHub Actions" || job.runner_name.startsWith("GitHub Actions ")) continue;
        jobs.push({
          runKey,
          jobId: job.id,
          runnerName: job.runner_name,
          repo: `${owner}/${repo}`,
          workflowName: run.name,
          jobName: job.name,
          runUrl: run.html_url,
          startedAt: job.started_at,
          finishedAt: job.completed_at,
          conclusion: job.conclusion,
          createdAt: job.created_at ?? null,
          queueS: queueSeconds(job.created_at, job.started_at),
          labels: labelsKey(job.labels),
          steps: stepTimings(job.steps),
        });
      }
      out.push({ runKey, jobs });
    }
    if (body.workflow_runs.length < 100) return out;
  }
}
