export interface Secrets {
  // GitHub App credentials (preferred; installation tokens are minted per poll, nothing to rotate).
  // GH_APP_PRIVATE_KEY is the .pem GitHub generates, PKCS#1 or PKCS#8. GH_APP_INSTALLATION_ID is
  // optional: when unset it is looked up from the first POLL_SCOPES entry.
  GH_APP_ID?: string;
  GH_APP_PRIVATE_KEY?: string;
  GH_APP_INSTALLATION_ID?: string;
  // Fallback fine-grained PAT, used only when no App is configured or minting an App token fails.
  GH_PAT?: string;
  // The dashboard's browser login (src/aws/login.ts, src/session.ts): the one admin's username, a
  // salted scrypt hash of the password (scripts/store-admin-login.sh writes both), and the key the
  // session cookie is signed with. When all three are set, Basic Auth is off.
  DASHBOARD_ADMIN_USER?: string;
  DASHBOARD_ADMIN_PASSWORD_HASH?: string;
  SESSION_SIGNING_KEY?: string;
  // Legacy HTTP Basic Auth, used only while the login above is not configured.
  DASHBOARD_USER?: string;
  DASHBOARD_PASSWORD?: string;
  // Set when the dashboard sits behind Cloudflare (runners.uresu.com): every HTTP request must carry
  // it in X-Origin-Auth, which a Cloudflare Transform Rule adds, so the bare Function URL is closed.
  ORIGIN_SECRET?: string;
  // Optional: a Slack/Discord-compatible incoming webhook URL. When set, poller failure and
  // recovery alerts are POSTed there as {text, content} in addition to being logged as events.
  ALERT_WEBHOOK_URL?: string;
  // Bearer token the host telemetry agents authenticate with.
  TELEMETRY_TOKEN: string;
  // Not a secret: an optional setting the AWS deployment sets (src/aws/config.ts) and the Worker
  // does not. Seconds a host's telemetry snapshot is kept before another report overwrites it.
  TELEMETRY_MIN_WRITE_SECONDS?: string;
}

export type Env = Cloudflare.Env & Secrets;

export interface GhRunner {
  id: number;
  name: string;
  os: string | null;
  status: string;
  busy: boolean;
  version: string | null;
  labels: { name: string; type: string }[];
}

export interface GhJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  created_at?: string | null;
  started_at: string;
  completed_at: string | null;
  runner_name: string | null;
  runner_group_name: string | null;
  labels: string[];
  // Present on the same jobs-list response; completed jobs carry final timestamps per step.
  steps?: {
    number: number;
    name: string;
    status?: string;
    conclusion: string | null;
    started_at: string | null;
    completed_at: string | null;
  }[];
}

export interface GhRun {
  id: number;
  name: string;
  html_url: string;
  status: string;
  run_attempt: number;
  created_at?: string;
  pull_requests: { number: number; url: string }[];
}

export interface ResolvedJob {
  runnerName: string;
  repo: string;
  runId: number;
  runUrl: string;
  jobId: number;
  jobName: string;
  workflowName: string;
  jobStartedAt: string;
  prNumber: number | null;
  prUrl: string | null;
}

export interface PollScope {
  kind: "org" | "repo";
  owner: string;
  repo?: string;
}
