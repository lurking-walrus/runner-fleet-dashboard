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
    const jobsRes = await gh(`/repos/${owner}/${repo}/actions/runs/${run.id}/jobs`, token);
    const jobsBody = (await jobsRes.json()) as { jobs: GhJob[] };
    for (const job of jobsBody.jobs) {
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

/** Final conclusion of one job, used to log an event once a tracked job leaves in_progress. */
export async function fetchJobConclusion(
  owner: string,
  repo: string,
  jobId: number,
  token: string,
): Promise<{ conclusion: string | null; htmlUrl: string; completedAt: string | null } | null> {
  try {
    const res = await gh(`/repos/${owner}/${repo}/actions/jobs/${jobId}`, token);
    const body = (await res.json()) as { conclusion: string | null; html_url: string; completed_at: string | null };
    return { conclusion: body.conclusion, htmlUrl: body.html_url, completedAt: body.completed_at };
  } catch {
    return null;
  }
}
