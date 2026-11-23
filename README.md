# runner-fleet-dashboard

An auth-gated status page for a self-hosted GitHub Actions runner fleet: where
each runner lives, what it's running (with links to the run and PR), live
CPU/RAM/disk for the host it's on, and a feed of issues (offline runners,
failed jobs, long-running jobs, stale telemetry).

Cloudflare Worker (cron poller + API + HTML frontend) backed by D1, plus a
zero-dependency Node telemetry agent you run on each physical host.

**The code is public; a deployment is not.** Every route is behind HTTP Basic
Auth or a bearer token, and every credential — the GitHub PAT, the dashboard
password, the telemetry token — is a Worker secret set with `wrangler secret
put`, never a file in this repo. Host names in the examples below are
placeholders (`ci-host-a`, `ci-host-b`); a real deployment's host labels come
from each agent's own uncommitted `.env` via `LOCATION`.

## How it works

- A cron trigger polls the GitHub API every 2 minutes: runner status per
  configured scope, then cross-references busy runners against active
  workflow runs to find the repo/workflow/job/PR each one is doing. "Active"
  means `in_progress` **and** `queued`: GitHub keeps a run `queued` while any of
  its jobs is still waiting for a runner, even though others are running, so on
  a saturated fleet most busy runners belong to queued runs. Repos are scanned
  most recently pushed first, and the scan stops once every busy runner is
  matched or `POLL_MAX_GITHUB_CALLS` is spent; an unmatched busy runner is shown
  as "running a job (not identified yet)", never as "idle".
- Runners are grouped into a "pool" (one physical host) by stripping a
  trailing `-N` from the runner name — `ci-host-a-linux-3` groups
  under `ci-host-a-linux`.
- The `agent/` script runs on each physical host and pushes CPU/RAM/disk to
  `/api/telemetry`, keyed by that same pool name.
- Every 10 minutes (the 2-minute cron's tick on a multiple of 10, in place of
  that tick's poll — one trigger, because the Workers Free plan allows only 5
  per account) the Worker copies finished self-hosted jobs from GitHub's
  completed workflow runs into `job_history`, which feeds the per-pool usage stats.
  It reads GitHub's record rather than what the 2-minute poll happened to see,
  because ephemeral runners deregister the moment a job ends and most jobs
  finish between polls. At most `HISTORY_SYNC_MAX_RUNS` runs are fetched per
  tick; a backlog (e.g. right after deploying) drains over the next few ticks.
  `POST /api/sync-history-now` triggers one tick by hand.
- The same sync captures **timings** for each job: queue time (created to started), run time,
  requested labels, and every executed step's duration (`job_history`, `job_steps`). They come from
  the jobs payload the sync already fetches, so there are no extra GitHub calls, and each completed
  job is written once. Raw rows are pruned after `JOB_RETENTION_DAYS` (14).
- Every 10 minutes (the tick 4 minutes after each history sync, again in place of that tick's poll)
  a **queued-jobs snapshot** lists the `queued` runs of the 20 most recently pushed repos and their
  `queued` jobs that ask for the fleet (`self-hosted`, or a non-GitHub-hosted label such as
  `dependabot`), and the status page shows "N waiting, oldest M min, by label". Budget
  `QUEUE_MAX_GITHUB_CALLS` (35); over budget it says `N+` and "partial" rather than failing. Runs queued
  over 3 days are counted and ignored (a run can sit `queued` with no jobs for weeks).
  `POST /api/queue-now` takes one by hand. The runner poll still runs at least every 4 minutes.
- The dashboard (HTTP Basic Auth-gated) polls `/api/state` every 20s.

## Deploy

```bash
npm install
npx wrangler d1 migrations apply runner-fleet-dashboard --remote
```

Set secrets (run these yourself — never paste tokens through an agent):

```bash
# GitHub App (preferred — no expiring tokens to rotate); key is the .pem GitHub downloads
npx wrangler secret put GH_APP_ID
npx wrangler secret put GH_APP_PRIVATE_KEY < path/to/app.private-key.pem
npx wrangler secret put GH_APP_INSTALLATION_ID   # optional; auto-discovered from POLL_SCOPES if unset

npx wrangler secret put DASHBOARD_USER
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put TELEMETRY_TOKEN     # any long random string; agents send this as a bearer token
npx wrangler secret put ALERT_WEBHOOK_URL   # optional Slack/Discord webhook for poller failure alerts

# Optional fallback if no App is configured, or minting an App token fails:
npx wrangler secret put GH_PAT              # fine-grained PAT, same permissions as below
```

**GitHub App permissions** (create it under the `Lurking-Walrus` org, no webhook, install on the org):
- Organization permissions: **Self-hosted runners: Read-only**, **Administration: Read-only** (to list org repos)
- Repository permissions: **Actions: Read-only**, **Metadata: Read-only** (Metadata is added automatically)
- Install on all repositories (or every repo the fleet might run jobs on). To poll personal `kornsour/*`
  repos via `repo:` scopes, set the App's visibility to "Any account", install it there too, and add
  **Administration: Read-only** at repo level for the runner list.

The `GH_PAT` fallback needs the same permissions, as a fine-grained PAT:
- Organization permissions on `Lurking-Walrus`: **Self-hosted runners: Read-only**, **Administration: Read-only**
- Repository permissions on every repo the fleet might run jobs on: **Actions: Read-only**, **Metadata: Read-only**
- For personal-repo scopes in `POLL_SCOPES`: the same repo permissions plus **Self-hosted runners: Read-only** at repo level

```bash
npx wrangler deploy
```

## Running on AWS (issue #28)

The same code also runs as an AWS Lambda, for when D1's free-plan read limit is the constraint.
`src/aws/` is a thin Node entry point around the UNCHANGED Worker handlers:

- `handler.ts`: a Lambda Function URL request becomes the Worker's `fetch()`; an EventBridge rule
  on `cron(*/2 * * * ? *)` becomes its `scheduled()` (`src/schedule.ts` picks the same job per
  tick on both).
- `store.ts`: the database is SQLite files in S3 (`main.db`, and `telemetry.db` for the agents'
  frequent writes), opened with `node:sqlite` through the same D1 API (`sqlite-d1.ts`, which is also
  what the tests run against). Writes are S3 conditional writes on the ETag that was read; a lost
  race redoes the work (cron, telemetry) or drops a cache write (page views). Migrations are the
  same files D1 applies.
- `config.ts`: settings are `wrangler.jsonc` `vars` (copied into the package), secrets are SSM
  SecureString parameters under `SSM_PREFIX`.
- `login.ts`: the sign-in page for the one admin (below).

### Sign-in

Browsers sign in at `/login` with one admin account. SSM holds only the username
(`DASHBOARD_ADMIN_USER`), a salted scrypt hash of the password (`DASHBOARD_ADMIN_PASSWORD_HASH`)
and the cookie-signing key (`SESSION_SIGNING_KEY`); `scripts/store-admin-login.sh` writes all three
from `DASHBOARD_ADMIN_USERNAME`/`DASHBOARD_ADMIN_PASSWORD` in the gitignored `.env` without printing
the password. A login is a signed `__Host-` cookie (HttpOnly, Secure, SameSite=Lax) valid for 7 days;
"Sign out" clears it, and `--rotate-session-key` ends every session. A wrong email and a wrong
password get the same answer; failures are limited per client and in total (5 and 20 per 15
minutes, counted in S3). `/api/*` without a session answers 401 JSON and the pages send you to
`/login`. Telemetry agents keep their bearer token. Until the three values exist the old
`DASHBOARD_USER`/`DASHBOARD_PASSWORD` Basic Auth applies; once they do, it is off.

With `ORIGIN_SECRET` set, every request must carry it in `X-Origin-Auth` (a Cloudflare Transform
Rule on the public hostname adds it), so the bare Function URL answers 403.

`npm run build:lambda` writes `dist/lambda.zip`. Our deployment of it (infrastructure, deploy
workflow, secrets) is not in this public repository; it lives in the org's private config repo.

## Configure what gets polled

`wrangler.jsonc` → `vars.POLL_SCOPES`, comma-separated:

```
org:Lurking-Walrus,repo:kornsour/gh-automation
```

Currently only `org:Lurking-Walrus` is set — the org's the only place with
self-hosted runners as of 2026-08-27 (`gh api orgs/Lurking-Walrus/actions/runners`).
Add `repo:kornsour/<name>` entries here if/when personal-account runners come
back; `gh api repos/kornsour/<repo>/actions/runners` tells you which repos
have any.

## Install the telemetry agent

See [`agent/README.md`](./agent/README.md). One agent per physical machine,
whatever it runs — a Linux box, WSL on Windows, or a Mac hosting containers.

## Local development

```bash
npm install
npx wrangler d1 migrations apply runner-fleet-dashboard --local
cp .dev.vars.example .dev.vars   # fill in a local GH_PAT (e.g. `gh auth token`) or GitHub App values and dev secrets
npx wrangler dev --test-scheduled
curl -u dev:<DASHBOARD_PASSWORD> -X POST http://localhost:8787/api/poll-now   # trigger a poll on demand
```

## Timings: how long work takes and what to speed up next

`/timing` (and `GET /api/timing`, behind the same auth) shows, for 24 h and 7 d:

- **Per pool**: queue (created to started) and run (started to completed) p50/p90/max, jobs, failures.
- **Queue by requested label set** (`self-hosted,Linux`, `self-hosted,Linux,container`, `dependabot`, ...).
- **Slowest jobs** and **slowest steps**: p50/p90/max and slot-minutes per day, ranked by total time
  consumed. That ranking, not p50, is the "what to speed up next" list.
- **Daily trend** (30 days) of p50/p90 for the top jobs, steps and each pool's queue, with the
  pre-fix baselines and known changes from `Lurking-Walrus/.github-private` docs/RUNNER-FLEET.md
  drawn on it (`src/timing-notes.ts`; add a line there when something ships).

Percentiles are exact nearest-rank, computed in SQL (window functions), so any number can be
reproduced by hand. A UTC day is rolled up into `timing_daily` once it is over; today is computed live
and drawn partial.

### D1 row-read budget

The account is on D1's free plan: **5M rows read per UTC day, then every query fails until 00:00Z**
(`code: 7500`; it did on 2026-11-23 by 15:49Z, and the deploy's migration step failed with it). So:
the 20-second `/api/state` poll no longer recomputes its usage metrics (cached 15 min), pages stop
polling while their tab is hidden, and the timing report sections are cached in `report_cache`
(24 h: 30 min, 7 d: 6 h, trend: 2 h). Anything new that scans more than a few hundred rows goes
through `src/cache.ts`.

## Known limitations (v1)

- GitHub API polling only sees org-level runners and any `repo:`-scoped
  entries you add to `POLL_SCOPES` — it does not auto-discover repo-level
  runners across every repo in either account (that would mean scanning
  dozens of repos every 2 minutes for no reason, since almost none of them
  have a repo-level runner registered).
- Telemetry is per physical host, not per runner process — if two runners on
  the same box are both busy, they share the same CPU/RAM/disk numbers,
  because they're literally sharing the same hardware.
- Charts are only on `/timing` (small SVG trends). Each pool on the status page shows 24h/7d usage (jobs run, busy time, failures, last job, avg/peak CPU), built from `job_history` (synced from GitHub's completed runs, 24h lookback, so the 7d figures fill in over the first week) and `telemetry_samples` (one per host per ~5 min, kept 7 days).
- Ephemeral/JIT runners (`<prefix>-<slot>-<unix-ts>`) group by stripping the timestamp, then the slot, so the agent's `HOST_ID` is the bare prefix (e.g. `mac-linux-arm64`).
