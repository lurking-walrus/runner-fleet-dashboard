export interface Secrets {
  // GitHub App credentials (preferred; installation tokens are minted per poll, nothing to rotate).
  // GH_APP_PRIVATE_KEY is the .pem GitHub generates, PKCS#1 or PKCS#8. GH_APP_INSTALLATION_ID is
  // optional: when unset it is looked up from the first POLL_SCOPES entry.
  GH_APP_ID?: string;
  GH_APP_PRIVATE_KEY?: string;
  GH_APP_INSTALLATION_ID?: string;
  // Fallback fine-grained PAT, used only when no App is configured or minting an App token fails.
  GH_PAT?: string;
  // Gates the dashboard UI and API (HTTP Basic Auth).
  DASHBOARD_USER: string;
  DASHBOARD_PASSWORD: string;
  // Optional: a Slack/Discord-compatible incoming webhook URL. When set, poller failure and
  // recovery alerts are POSTed there as {text, content} in addition to being logged as events.
  ALERT_WEBHOOK_URL?: string;
  // Bearer token the host telemetry agents authenticate with.
  TELEMETRY_TOKEN: string;
}

export type Env = Cloudflare.Env & Secrets;

export interface GhRunner {
  id: number;
  name: string;
  os: string;
  status: string;
  busy: boolean;
  version: string;
  labels: { name: string; type: string }[];
}

export interface GhJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string;
  runner_name: string | null;
}

export interface GhRun {
  id: number;
  name: string;
  html_url: string;
  status: string;
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
