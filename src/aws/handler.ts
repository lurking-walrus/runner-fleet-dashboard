// AWS Lambda entry point (issue #28): the Worker's fetch() and scheduled() handlers, UNCHANGED,
// behind a Lambda Function URL and an EventBridge rule, with the database in S3 (store.ts).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../index";
import { runScheduledJob, scheduledJobFor } from "../schedule";
import { dashboardAuthMode, requireBearer, requireDashboardAuth } from "../auth";
import { constantTimeEqual } from "../session";
import { handleLogin, handleLogout, LoginLimiter, type LoginConfig, type LoginResult } from "./login";
import type { Env } from "../types";
import { S3BlobStore, type BlobStore } from "./blob-store";
import { cachedSecrets, missingRequired, settingsFrom, ssmSecretLoader, type SecretLoader, type Settings } from "./config";
import { SqliteOnS3, type Migration } from "./store";

/** Lambda Function URL event, payload format 2.0 (the fields used here). */
export interface FunctionUrlEvent {
  version: "2.0";
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  /** Function URLs move the Cookie header here (payload 2.0). */
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { domainName?: string; http: { method: string; sourceIp?: string } };
}

/** EventBridge scheduled event (the fields used here). */
export interface ScheduledEvent {
  source: "aws.events";
  "detail-type": "Scheduled Event";
  time: string;
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  /** Set-Cookie values (Function URLs send each as its own header). */
  cookies?: string[];
  body: string;
  isBase64Encoded: boolean;
}

export interface App {
  store: SqliteOnS3;
  limiter: LoginLimiter;
  settings: Settings;
  secrets: SecretLoader;
}

export function createApp(opts: { blobs: BlobStore; migrations: Migration[]; dir: string; settings: Settings; secrets: SecretLoader }): App {
  return {
    store: new SqliteOnS3(opts.blobs, opts.migrations, opts.dir),
    limiter: new LoginLimiter(opts.blobs),
    settings: opts.settings,
    secrets: opts.secrets,
  };
}

function isScheduled(event: unknown): event is ScheduledEvent {
  const e = event as Partial<ScheduledEvent>;
  return e?.source === "aws.events" && e["detail-type"] === "Scheduled Event";
}

async function envFor(app: App, db: D1Database): Promise<Env> {
  return { ...app.settings, ...(await app.secrets()), DB: db } as unknown as Env;
}

export async function handle(app: App, event: FunctionUrlEvent | ScheduledEvent): Promise<FunctionUrlResult | void> {
  if (isScheduled(event)) {
    const at = Date.parse(event.time);
    const job = scheduledJobFor(at);
    await app.store.run("main", "retry", async (db) => runScheduledJob(await envFor(app, db), job));
    // One backup a day, from the first history-sync tick of the UTC day.
    const t = new Date(at);
    if (job === "history" && t.getUTCHours() === 0 && t.getUTCMinutes() === 0) {
      await app.store.backup(t.toISOString().slice(0, 10));
    }
    return;
  }
  return handleHttp(app, event);
}

async function handleHttp(app: App, event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const secrets = await app.secrets();
  const missing = missingRequired(secrets);
  if (missing.length > 0) {
    console.error(`refusing requests: secrets not set under the SSM prefix: ${missing.join(", ")}`);
    return text(503, "not configured");
  }

  const method = event.requestContext.http.method.toUpperCase();
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers.set(k, v);

  // Behind Cloudflare (runners.uresu.com) a Transform Rule adds X-Origin-Auth; with ORIGIN_SECRET
  // set, a request that did not come through it (the bare Function URL) is refused outright.
  const viaEdge = !!secrets.ORIGIN_SECRET && (await constantTimeEqual(headers.get("x-origin-auth") ?? "", secrets.ORIGIN_SECRET));
  if (secrets.ORIGIN_SECRET && !viaEdge) return text(403, "forbidden: use the dashboard's own hostname");
  headers.delete("x-origin-auth");
  if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));
  // Cloudflare's client address is trustworthy only on a request proven to come through Cloudflare.
  const clientIp = (viaEdge && headers.get("cf-connecting-ip")) || event.requestContext.http.sourceIp || "unknown";

  const host = headers.get("host") ?? event.requestContext.domainName ?? "localhost";
  const url = `https://${host}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`;
  const body =
    event.body === undefined || method === "GET" || method === "HEAD"
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : event.body;
  const makeRequest = () => new Request(url, { method, headers, body });

  // The login page and logout: no database, only the S3 failure counter.
  if (event.rawPath === "/login" || event.rawPath === "/logout") {
    if (dashboardAuthMode(secrets) !== "session") return { statusCode: 302, headers: { location: "/" }, body: "", isBase64Encoded: false };
    const r = event.rawPath === "/logout" ? handleLogout() : await handleLogin(makeRequest(), secrets as LoginConfig, app.limiter, clientIp);
    return fromLogin(r);
  }

  // Authenticate BEFORE touching the database: an anonymous request must not cost an S3 read.
  // index.ts checks again; this is the same function with the same secrets, run earlier.
  const isTelemetry = event.rawPath === "/api/telemetry" && method === "POST";
  const denied = isTelemetry ? await requireBearer(makeRequest(), secrets.TELEMETRY_TOKEN!) : await requireDashboardAuth(makeRequest(), secrets);
  if (denied) return toResult(denied);

  // A page view only ever writes cache rows (report_cache): losing that race is harmless.
  const onConflict = method === "GET" || method === "HEAD" ? "drop" : "retry";
  const res = await app.store.run(isTelemetry ? "telemetry" : "main", onConflict, async (db) => {
    const r = await worker.fetch(makeRequest(), await envFor(app, db));
    // Read the body inside the session: the Response must not outlive the database it was built from.
    return { status: r.status, headers: r.headers, body: await r.text() };
  });
  return { statusCode: res.status, headers: Object.fromEntries(res.headers), body: res.body, isBase64Encoded: false };
}

async function toResult(r: Response): Promise<FunctionUrlResult> {
  return { statusCode: r.status, headers: Object.fromEntries(r.headers), body: await r.text(), isBase64Encoded: false };
}

function fromLogin(r: LoginResult): FunctionUrlResult {
  return { statusCode: r.status, headers: r.headers, ...(r.cookies.length ? { cookies: r.cookies } : {}), body: r.body, isBase64Encoded: false };
}

function text(status: number, body: string): FunctionUrlResult {
  return { statusCode: status, headers: { "content-type": "text/plain" }, body, isBase64Encoded: false };
}

/** Migrations and vars.json are packaged next to the bundle by scripts/build-lambda.mjs. */
export function loadMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

let app: App | null = null;

function productionApp(): App {
  const root = import.meta.dirname;
  const bucket = process.env.DATA_BUCKET;
  const prefix = process.env.SSM_PREFIX;
  if (!bucket || !prefix) throw new Error("DATA_BUCKET and SSM_PREFIX must be set");
  const vars = JSON.parse(readFileSync(join(root, "vars.json"), "utf8")) as Settings;
  return createApp({
    blobs: new S3BlobStore(bucket),
    migrations: loadMigrations(join(root, "migrations")),
    dir: "/tmp/runner-fleet-dashboard",
    settings: settingsFrom(vars, process.env),
    secrets: cachedSecrets(ssmSecretLoader(prefix)),
  });
}

export async function handler(event: FunctionUrlEvent | ScheduledEvent): Promise<FunctionUrlResult | void> {
  app ??= productionApp();
  return handle(app, event);
}
