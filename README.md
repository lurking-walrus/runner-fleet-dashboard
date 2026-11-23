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

## Known limitations (v1)

- GitHub API polling only sees org-level runners and any `repo:`-scoped
  entries you add to `POLL_SCOPES` — it does not auto-discover repo-level
  runners across every repo in either account (that would mean scanning
  dozens of repos every 2 minutes for no reason, since almost none of them
  have a repo-level runner registered).
- Telemetry is per physical host, not per runner process — if two runners on
  the same box are both busy, they share the same CPU/RAM/disk numbers,
  because they're literally sharing the same hardware.
- No charts yet. Each pool shows 24h/7d usage (jobs run, busy time, failures, last job, avg/peak CPU), built from `job_history` (synced from GitHub's completed runs, 24h lookback, so the 7d figures fill in over the first week) and `telemetry_samples` (one per host per ~5 min, kept 7 days).
- Ephemeral/JIT runners (`<prefix>-<slot>-<unix-ts>`) group by stripping the timestamp, then the slot, so the agent's `HOST_ID` is the bare prefix (e.g. `mac-linux-arm64`).
