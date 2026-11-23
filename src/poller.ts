import {
  currentJobRunnerNames,
  deleteCurrentJob,
  loadSyncedRunKeys,
  logEvent,
  pruneJobTimings,
  pruneSyncedRuns,
  pruneVanishedRunners,
  recordPoll,
  recordSyncedRun,
  upsertCurrentJob,
  upsertRunner,
} from "./db";
import {
  CallBudget,
  listOrgRepos,
  listQueuedJobs,
  listRunnersForScope,
  listUnsyncedCompletedRuns,
  parseScopes,
  resolveJobsInRepo,
} from "./github";
import { summarizeQueue } from "./queue";
import { pruneRollups, rollupPendingDay } from "./timing-report";
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
      if (prev && prev.version && runner.version && prev.version !== runner.version) {
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

    // Repos that held a running job at the last poll go first: a job usually outlives one poll.
    const { results: lastRepos } = await env.DB.prepare(`SELECT DISTINCT repo FROM current_jobs`).all<{
      repo: string;
    }>();
    const budget = new CallBudget(Number(env.POLL_MAX_GITHUB_CALLS) || 40);
    const resolved = new Map<string, import("./types").ResolvedJob>();
    for (const scope of scopes) {
      const key = scope.kind === "org" ? scope.owner : `${scope.owner}/${scope.repo}`;
      const busyNames = busyByScope.get(key);
      if (!busyNames || busyNames.size === 0) continue;

      let repos = scope.kind === "org" ? await listOrgRepos(scope.owner, ghToken) : [scope.repo!];
      const first = lastRepos
        .map((r) => r.repo)
        .filter((r) => r.startsWith(`${scope.owner}/`))
        .map((r) => r.slice(scope.owner.length + 1))
        .filter((r) => repos.includes(r));
      repos = [...first, ...repos.filter((r) => !first.includes(r))];
      for (const repo of repos) {
        if (busyNames.size === 0 || budget.remaining <= 0) break; // all resolved, or out of calls
        const jobs = await resolveJobsInRepo(scope.owner, repo, busyNames, ghToken, budget);
        for (const job of jobs) {
          resolved.set(job.runnerName, job);
          busyNames.delete(job.runnerName);
        }
      }
    }

    // current_jobs mirrors what's in progress right now. Finished jobs are recorded by
    // syncJobHistory() from GitHub's completed runs, not inferred here: an ephemeral runner
    // deregisters as soon as its job ends, and most jobs finish between two polls anyway.
    const previouslyTracked = await currentJobRunnerNames(env.DB);
    for (const job of resolved.values()) {
      await upsertCurrentJob(env.DB, job, now);
    }
    for (const runnerName of previouslyTracked) {
      if (!resolved.has(runnerName)) await deleteCurrentJob(env.DB, runnerName);
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
  // Bound as an ISO string, the same format events.ts values are stored in. SQLite's datetime('now', ...)
  // returns "YYYY-MM-DD HH:MM:SS", and since "T" sorts after " ", every event from the same UTC
  // day compared as newer than it — so "re-flag hourly" really meant "once per UTC day".
  const hourAgo = new Date(Date.parse(now) - 3_600_000).toISOString();
  const staleTelemetryMs = Number(env.TELEMETRY_STALE_MINUTES) * 60_000;

  const { results: longJobs } = await env.DB.prepare(
    `SELECT runner_name, repo, job_started_at FROM current_jobs`,
  ).all<{ runner_name: string; repo: string; job_started_at: string }>();
  for (const job of longJobs) {
    const ageMs = Date.parse(now) - Date.parse(job.job_started_at);
    if (ageMs < longRunningMs) continue;
    const { results: recent } = await env.DB.prepare(
      `SELECT 1 FROM events WHERE kind = 'long_running_job' AND runner_name = ? AND ts > ?`,
    )
      .bind(job.runner_name, hourAgo)
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
      `SELECT 1 FROM events WHERE kind = 'runner_stuck_offline' AND runner_name = ? AND ts > ?`,
    )
      .bind(runner.name, hourAgo)
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
      `SELECT 1 FROM events WHERE kind = 'stale_telemetry' AND runner_name = ? AND ts > ?`,
    )
      .bind(pool, hourAgo)
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

const HISTORY_LOOKBACK_MS = 24 * 3_600_000;

/**
 * Copies finished self-hosted jobs from GitHub into job_history, which feeds the per-pool usage
 * stats. Runs from its own cron (every 10 min) so it has its own subrequest budget, separate from
 * the 2-minute runner poll. Each completed (run, attempt) is fetched once and remembered in
 * synced_runs; `HISTORY_SYNC_MAX_RUNS` caps the job-list calls per tick, and anything left over is
 * picked up on the next tick.
 */
export async function syncJobHistory(env: Env) {
  const now = new Date().toISOString();
  const scopes = parseScopes(env.POLL_SCOPES);
  const ghToken = await resolveGithubToken(env, scopes);
  const maxRuns = Number(env.HISTORY_SYNC_MAX_RUNS) || 20;
  const synced = await loadSyncedRunKeys(env.DB);
  let budget = maxRuns;
  let jobsRecorded = 0;

  for (const scope of scopes) {
    const repos = scope.kind === "org" ? await listOrgRepos(scope.owner, ghToken) : [scope.repo!];
    for (const repo of repos) {
      if (budget <= 0) break;
      const runs = await listUnsyncedCompletedRuns(scope.owner, repo, HISTORY_LOOKBACK_MS, synced, ghToken, budget);
      budget -= runs.length;
      for (const { runKey, jobs } of runs) {
        const inserted = await recordSyncedRun(env.DB, runKey, jobs, now);
        jobsRecorded += inserted.length;
        for (const j of inserted) {
          if (j.conclusion !== "failure" && j.conclusion !== "timed_out") continue;
          await logEvent(
            env.DB,
            {
              severity: "error",
              kind: "job_failed",
              runnerName: j.runnerName,
              repo: j.repo,
              message: `${j.workflowName} › ${j.jobName} on ${j.repo} finished: ${j.conclusion}`,
            },
            j.finishedAt,
          );
        }
      }
    }
  }

  // synced_runs only needs to cover the lookback window (plus a day of margin).
  await pruneSyncedRuns(env.DB, new Date(Date.parse(now) - HISTORY_LOOKBACK_MS - 86_400_000).toISOString());
  // Raw per-job and per-step rows are bounded: nothing older than JOB_RETENTION_DAYS is kept.
  const retentionDays = Number(env.JOB_RETENTION_DAYS) || 14;
  await pruneJobTimings(env.DB, new Date(Date.parse(now) - retentionDays * 86_400_000).toISOString());
  // Roll up one finished day per tick (bounded work), and keep the rollups 90 days.
  const rolled = await rollupPendingDay(env.DB, Date.parse(now), retentionDays);
  await pruneRollups(env.DB, Date.parse(now), 90);
  if (rolled) console.log(`timing rollup: ${rolled}`);
  console.log(`history sync: ${maxRuns - budget} runs, ${jobsRecorded} self-hosted jobs recorded`);
}

const GHOST_RUN_AFTER_MS = 3 * 86_400_000;

/**
 * Snapshots what is waiting for a self-hosted runner right now into queue_snapshot. Its own tick
 * (see index.ts) so it has its own GitHub-call budget, separate from the runner poll's.
 */
export async function snapshotQueue(env: Env) {
  const nowMs = Date.now();
  const scopes = parseScopes(env.POLL_SCOPES);
  const ghToken = await resolveGithubToken(env, scopes);
  const budget = new CallBudget(Number(env.QUEUE_MAX_GITHUB_CALLS) || 35);
  const jobs = [];
  let runsScanned = 0;
  let reposSkipped = 0;
  let ghostRuns = 0;
  let partial = false;
  for (const scope of scopes) {
    if (scope.kind !== "org") continue; // personal repo scopes have no org-wide repo list to scan
    const repos = await listOrgRepos(scope.owner, ghToken);
    budget.take(); // the repo list above was one call
    const r = await listQueuedJobs(scope.owner, repos, ghToken, budget, nowMs, {
      maxRepos: Number(env.QUEUE_MAX_REPOS) || 20,
      ghostAfterMs: GHOST_RUN_AFTER_MS,
    });
    jobs.push(...r.jobs);
    runsScanned += r.runsScanned;
    reposSkipped += r.reposSkipped;
    ghostRuns += r.ghostRuns;
    partial ||= r.partial;
  }
  const summary = summarizeQueue(jobs, nowMs, { partial, runsScanned, reposSkipped, ghostRuns });
  await env.DB.prepare(`INSERT OR REPLACE INTO queue_snapshot (id, taken_at, body) VALUES (1, ?, ?)`)
    .bind(summary.taken_at, JSON.stringify(summary))
    .run();
  console.log(`queue snapshot: ${summary.waiting} waiting, oldest ${summary.oldest_s}s, partial=${partial}`);
}
