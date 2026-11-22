import type { GhJob, GhRun, GhRunner, PollScope, ResolvedJob } from "./types";

const API = "https://api.github.com";

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

/** Every repo an org-scoped runner fleet could plausibly be running a job for. */
export async function listOrgRepos(org: string, token: string): Promise<string[]> {
  const repos: string[] = [];
  let page = 1;
  for (;;) {
    const res = await gh(`/orgs/${org}/repos?per_page=100&page=${page}`, token);
    const body = (await res.json()) as { name: string }[];
    repos.push(...body.map((r) => r.name));
    if (body.length < 100) break;
    page += 1;
  }
  return repos;
}

/**
 * Scans a repo's in-progress workflow runs and returns the job currently
 * occupying each of `busyRunnerNames`. Cheap when the repo has no in-progress
 * runs — one list call and nothing further.
 */
export async function resolveJobsInRepo(
  owner: string,
  repo: string,
  busyRunnerNames: Set<string>,
  token: string,
): Promise<ResolvedJob[]> {
  const runsRes = await gh(`/repos/${owner}/${repo}/actions/runs?status=in_progress&per_page=20`, token);
  const runsBody = (await runsRes.json()) as { workflow_runs: GhRun[] };
  if (runsBody.workflow_runs.length === 0) return [];

  const found: ResolvedJob[] = [];
  for (const run of runsBody.workflow_runs) {
    for (const job of await listRunJobs(owner, repo, run.id, token)) {
      if (job.status !== "in_progress" || !job.runner_name) continue;
      if (!busyRunnerNames.has(job.runner_name)) continue;
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
 * Every job in a run across all attempts, paginated (the API defaults to 30 per page, which cuts off
 * big matrices). All attempts, not just the latest: a re-run's first-attempt jobs used runner time too.
 */
async function listRunJobs(owner: string, repo: string, runId: number, token: string): Promise<GhJob[]> {
  const jobs: GhJob[] = [];
  for (let page = 1; ; page++) {
    const res = await gh(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs?filter=all&per_page=100&page=${page}`, token);
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
        });
      }
      out.push({ runKey, jobs });
    }
    if (body.workflow_runs.length < 100) return out;
  }
}
