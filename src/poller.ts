import {
  currentJobRunnerNames,
  deleteCurrentJob,
  logEvent,
  recordJobHistory,
  pruneVanishedRunners,
  recordPoll,
  upsertCurrentJob,
  upsertRunner,
} from "./db";
import { derivePool, fetchJobConclusion, listOrgRepos, listRunnersForScope, parseScopes, resolveJobsInRepo } from "./github";
import { alertIfPollerFailing, alertIfPollerRecovered } from "./alerts";
import { resolveGithubToken } from "./github-auth";
import type { Env, PollScope } from "./types";

export async function runPoll(env: Env) {
  const now = new Date().toISOString();
  try {
    const scopes = parseScopes(env.POLL_SCOPES);
    const ghToken = await resolveGithubToken(env, scopes);
    const allRunners: { runner: import("./types").GhRunner; scopeLabel: string; scope: PollScope }[] = [];

    for (const scope of scopes) {
      const runners = await listRunnersForScope(scope, ghToken);
      for (const r of runners) allRunners.push({ ...r, scope });
    }

    // Load previous status so we can log online/offline transitions.
    const prevStatus = new Map<string, { status: string; version: string }>();
    const { results: prevRows } = await env.DB.prepare(`SELECT name, status, version FROM runners`).all<{
      name: string;
      status: string;
      version: string;
    }>();
    for (const row of prevRows) prevStatus.set(row.name, row);

    for (const { runner, scopeLabel } of allRunners) {
      await upsertRunner(env.DB, runner, scopeLabel, now);
      const prev = prevStatus.get(runner.name);
      if (prev && prev.status !== runner.status) {
        await logEvent(
          env.DB,
          {
            severity: runner.status === "offline" ? "warning" : "info",
            kind: runner.status === "offline" ? "runner_offline" : "runner_online",
            runnerName: runner.name,
            message: `${runner.name} went ${runner.status}`,
          },
          now,
        );
      }
      if (prev && prev.version !== runner.version) {
        await logEvent(
          env.DB,
          {
            severity: "info",
            kind: "version_changed",
            runnerName: runner.name,
            message: `${runner.name} runner version changed ${prev.version} -> ${runner.version}`,
          },
          now,
        );
      }
    }
    await pruneVanishedRunners(
      env.DB,
      allRunners.map((r) => r.runner.name),
      now,
    );

    // Resolve what each busy runner is currently doing.
    const busyByScope = new Map<string, Set<string>>();
    for (const { runner, scope } of allRunners) {
      if (!runner.busy) continue;
      const key = scope.kind === "org" ? scope.owner : `${scope.owner}/${scope.repo}`;
      if (!busyByScope.has(key)) busyByScope.set(key, new Set());
      busyByScope.get(key)!.add(runner.name);
    }

    const resolved = new Map<string, import("./types").ResolvedJob>();
    for (const scope of scopes) {
      const key = scope.kind === "org" ? scope.owner : `${scope.owner}/${scope.repo}`;
      const busyNames = busyByScope.get(key);
      if (!busyNames || busyNames.size === 0) continue;

      const repos = scope.kind === "org" ? await listOrgRepos(scope.owner, ghToken) : [scope.repo!];
      for (const repo of repos) {
        if (busyNames.size === 0) break; // all resolved already
        const jobs = await resolveJobsInRepo(scope.owner, repo, busyNames, ghToken);
        for (const job of jobs) {
          resolved.set(job.runnerName, job);
          busyNames.delete(job.runnerName);
        }
      }
    }

    const previouslyTracked = await currentJobRunnerNames(env.DB);
    for (const job of resolved.values()) {
      await upsertCurrentJob(env.DB, job, now);
    }
    for (const [runnerName, prevJob] of previouslyTracked) {
      if (resolved.has(runnerName)) continue;
      // This runner's job left in_progress since the last poll — log its outcome once.
      const [prevOwner = "", prevRepo = ""] = prevJob.repo.split("/");
      const result = await fetchJobConclusion(prevOwner, prevRepo, prevJob.jobId, ghToken);
      if (result) {
        if (result.conclusion) {
          await recordJobHistory(env.DB, {
            ...prevJob,
            runnerName,
            pool: derivePool(runnerName),
            finishedAt: result.completedAt ?? now,
            conclusion: result.conclusion,
          });
        }
        await logEvent(
          env.DB,
          {
            severity: result.conclusion === "failure" ? "error" : "info",
            kind: result.conclusion === "failure" ? "job_failed" : "job_succeeded",
            runnerName,
            repo: prevJob.repo,
            message: `job on ${prevJob.repo} finished: ${result.conclusion ?? "unknown"}`,
          },
          now,
        );
      }
      await deleteCurrentJob(env.DB, runnerName);
    }

    await detectIssues(env, now);
    await alertIfPollerRecovered(env, now);
    await recordPoll(env.DB, true, null, now);
  } catch (err) {
    await recordPoll(env.DB, false, String(err), now);
    await alertIfPollerFailing(env, String(err), now);
    throw err;
  }
}

async function detectIssues(env: Env, now: string) {
  const longRunningMs = Number(env.LONG_RUNNING_JOB_MINUTES) * 60_000;
  const staleTelemetryMs = Number(env.TELEMETRY_STALE_MINUTES) * 60_000;

  const { results: longJobs } = await env.DB.prepare(
    `SELECT runner_name, repo, job_started_at FROM current_jobs`,
  ).all<{ runner_name: string; repo: string; job_started_at: string }>();
  for (const job of longJobs) {
    const ageMs = Date.parse(now) - Date.parse(job.job_started_at);
    if (ageMs < longRunningMs) continue;
    const { results: recent } = await env.DB.prepare(
      `SELECT 1 FROM events WHERE kind = 'long_running_job' AND runner_name = ? AND ts > datetime('now', '-1 hour')`,
    )
      .bind(job.runner_name)
      .all();
    if (recent.length > 0) continue;
    await logEvent(
      env.DB,
      {
        severity: "warning",
        kind: "long_running_job",
        runnerName: job.runner_name,
        repo: job.repo,
        message: `job on ${job.repo} has been running ${Math.round(ageMs / 60000)}m`,
      },
      now,
    );
  }

  const { results: runners } = await env.DB.prepare(`SELECT name, status, pool FROM runners`).all<{
    name: string;
    status: string;
    pool: string;
  }>();
  const offlineStuckMs = Number(env.OFFLINE_STUCK_MINUTES) * 60_000;
  for (const runner of runners) {
    if (runner.status !== "offline") continue;
    const lastTransition = await env.DB.prepare(
      `SELECT ts FROM events WHERE kind = 'runner_offline' AND runner_name = ? ORDER BY ts DESC LIMIT 1`,
    )
      .bind(runner.name)
      .first<{ ts: string }>();
    // No recorded transition means it was already offline before this poller ever saw it
    // online — duration is unknown, but "unknown and still offline" is itself worth flagging.
    const offlineForMs = lastTransition ? Date.parse(now) - Date.parse(lastTransition.ts) : Infinity;
    if (offlineForMs < offlineStuckMs) continue;
    const { results: recent } = await env.DB.prepare(
      `SELECT 1 FROM events WHERE kind = 'runner_stuck_offline' AND runner_name = ? AND ts > datetime('now', '-1 hour')`,
    )
      .bind(runner.name)
      .all();
    if (recent.length > 0) continue;
    const durationMsg = Number.isFinite(offlineForMs) ? `for ${Math.round(offlineForMs / 60000)}m` : "for an unknown duration (offline since before this dashboard started tracking it)";
    await logEvent(
      env.DB,
      {
        severity: "error",
        kind: "runner_stuck_offline",
        runnerName: runner.name,
        message: `${runner.name} has been offline ${durationMsg} — check the host (e.g. \`docker ps\` for a container runner)`,
      },
      now,
    );
  }

  const pools = new Set(runners.map((r) => r.pool));
  const { results: telemetryRows } = await env.DB.prepare(`SELECT host, updated_at FROM telemetry`).all<{
    host: string;
    updated_at: string;
  }>();
  const telemetryByHost = new Map(telemetryRows.map((t) => [t.host, t.updated_at]));

  for (const pool of pools) {
    const poolOnline = runners.some((r) => r.pool === pool && r.status === "online");
    if (!poolOnline) continue; // don't flag telemetry for a fully-offline host
    const lastSeen = telemetryByHost.get(pool);
    const stale = !lastSeen || Date.parse(now) - Date.parse(lastSeen) > staleTelemetryMs;
    if (!stale) continue;
    const { results: recent } = await env.DB.prepare(
      `SELECT 1 FROM events WHERE kind = 'stale_telemetry' AND runner_name = ? AND ts > datetime('now', '-1 hour')`,
    )
      .bind(pool)
      .all();
    if (recent.length > 0) continue;
    await logEvent(
      env.DB,
      {
        severity: "warning",
        kind: "stale_telemetry",
        runnerName: pool,
        message: lastSeen
          ? `no telemetry from ${pool} since ${lastSeen}`
          : `no telemetry ever received from ${pool} — is the agent installed and running?`,
      },
      now,
    );
  }
}
