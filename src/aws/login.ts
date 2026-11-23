// The login page for the one dashboard admin (replaces Basic Auth for browsers).
//
//   GET  /login    the form
//   POST /login    username + password -> a signed session cookie (src/session.ts) and a redirect
//   POST /logout   clears the cookie
//
// The password is never stored: SSM holds a salted scrypt hash (DASHBOARD_ADMIN_PASSWORD_HASH,
// written by scripts/store-admin-login.sh). A wrong username and a wrong password get the same
// answer and take the same time (the hash is computed either way). Failed attempts are counted in
// S3 (auth/login-failures.json, conditional writes like the database) so the limit holds across
// Lambda containers: at most FAILURES_PER_IP per client and FAILURES_GLOBAL in total per window.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { clearedSessionCookie, constantTimeEqual, sessionCookie, signSession } from "../session";
import { WriteConflict, type BlobStore } from "./blob-store";

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

// --- Password hashes -----------------------------------------------------------------------------

/** OWASP's scrypt floor is N=2^17,r=8,p=1; 2^15 keeps a login under ~0.3 s on a 512 MB Lambda. */
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const MAXMEM = 128 * 1024 * 1024;
// A well-formed hash of a random value, verified against when the stored hash is unusable, so a
// broken configuration costs the same time as a real check (and never matches).
const DUMMY = { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, salt: randomBytes(16), hash: randomBytes(32) };

/** `scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>`. */
export async function hashPassword(password: string, params = SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, { ...params, maxmem: MAXMEM });
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function parseHash(stored: string) {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4]!, "base64");
  const hash = Buffer.from(parts[5]!, "base64");
  if (!N || !r || !p || N > 2 ** 20 || r > 32 || p > 16 || salt.length < 16 || hash.length < 16) return null;
  return { N, r, p, salt, hash };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  const h = parsed ?? DUMMY;
  const got = await scrypt(password, h.salt, h.hash.length, { N: h.N, r: h.r, p: h.p, maxmem: MAXMEM });
  return timingSafeEqual(got, h.hash) && parsed !== null;
}

// --- Rate limit ----------------------------------------------------------------------------------

export const LIMIT_KEY = "auth/login-failures.json";
export const WINDOW_MS = 15 * 60_000;
export const FAILURES_PER_IP = 5;
export const FAILURES_GLOBAL = 20;
const MAX_KEPT = 200;

interface Failure {
  ip: string;
  at: number;
}

export class LoginLimiter {
  constructor(private readonly blobs: BlobStore) {}

  private async read(now: number): Promise<{ etag: string | null; failures: Failure[] }> {
    const res = await this.blobs.get(LIMIT_KEY);
    if (res.status !== "ok") return { etag: null, failures: [] };
    let failures: Failure[] = [];
    try {
      failures = (JSON.parse(new TextDecoder().decode(res.body)) as { failures?: Failure[] }).failures ?? [];
    } catch {
      failures = [];
    }
    return { etag: res.etag, failures: failures.filter((f) => now - f.at < WINDOW_MS) };
  }

  /** Seconds until another attempt is allowed; 0 when one is allowed now. */
  async retryAfter(ip: string, now = Date.now()): Promise<number> {
    const { failures } = await this.read(now);
    const mine = failures.filter((f) => f.ip === ip);
    const blocking = mine.length >= FAILURES_PER_IP ? mine : failures.length >= FAILURES_GLOBAL ? failures : [];
    if (blocking.length === 0) return 0;
    const oldest = Math.min(...blocking.map((f) => f.at));
    return Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
  }

  async recordFailure(ip: string, now = Date.now()) {
    await this.update(now, (fs) => [...fs, { ip, at: now }].slice(-MAX_KEPT));
  }

  async recordSuccess(ip: string, now = Date.now()) {
    await this.update(now, (fs) => fs.filter((f) => f.ip !== ip), true);
  }

  private async update(now: number, change: (fs: Failure[]) => Failure[], onlyIfChanged = false) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { etag, failures } = await this.read(now);
      const next = change(failures);
      if (onlyIfChanged && next.length === failures.length) return;
      try {
        await this.blobs.put(LIMIT_KEY, new TextEncoder().encode(JSON.stringify({ failures: next })), etag);
        return;
      } catch (err) {
        if (!(err instanceof WriteConflict)) throw err;
      }
    }
    throw new Error("could not record a login attempt (too much contention)");
  }
}

// --- Routes --------------------------------------------------------------------------------------

export interface LoginConfig {
  DASHBOARD_ADMIN_USER: string;
  DASHBOARD_ADMIN_PASSWORD_HASH: string;
  SESSION_SIGNING_KEY: string;
}

export interface LoginResult {
  status: number;
  headers: Record<string, string>;
  cookies: string[];
  body: string;
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

/** Only a same-site path: never `//host`, `/\host` or a full URL (an open redirect). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next.startsWith("/login") || next.startsWith("/logout")) return "/";
  return next;
}

export async function handleLogin(req: Request, cfg: LoginConfig, limiter: LoginLimiter, clientIp: string): Promise<LoginResult> {
  const url = new URL(req.url);
  if (req.method === "GET" || req.method === "HEAD") {
    return page(200, loginPage({ next: safeNext(url.searchParams.get("next")) }));
  }
  if (req.method !== "POST") return { status: 405, headers: { allow: "GET, POST" }, cookies: [], body: "method not allowed" };

  const form = new URLSearchParams(await req.text());
  const next = safeNext(form.get("next"));
  const username = (form.get("username") ?? "").trim();
  const password = form.get("password") ?? "";

  const wait = await limiter.retryAfter(clientIp);
  if (wait > 0) {
    const minutes = Math.ceil(wait / 60);
    const res = page(429, loginPage({ next, username, error: `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` }));
    res.headers["retry-after"] = String(wait);
    return res;
  }

  // Both checks always run, so a wrong username takes as long as a wrong password.
  const [userOk, passOk] = await Promise.all([
    constantTimeEqual(username.toLowerCase(), cfg.DASHBOARD_ADMIN_USER.toLowerCase()),
    verifyPassword(password, cfg.DASHBOARD_ADMIN_PASSWORD_HASH),
  ]);
  if (!(userOk && passOk)) {
    await limiter.recordFailure(clientIp);
    return page(401, loginPage({ next, username, error: "Incorrect email or password." }));
  }

  await limiter.recordSuccess(clientIp);
  const token = await signSession(cfg.SESSION_SIGNING_KEY, cfg.DASHBOARD_ADMIN_USER);
  return { status: 303, headers: { location: next, "cache-control": "no-store" }, cookies: [sessionCookie(token)], body: "" };
}

export function handleLogout(): LoginResult {
  return { status: 303, headers: { location: "/login", "cache-control": "no-store" }, cookies: [clearedSessionCookie()], body: "" };
}

function page(status: number, body: string): LoginResult {
  return { status, headers: { ...PAGE_HEADERS }, cookies: [], body };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function loginPage(o: { next: string; username?: string; error?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Runner Fleet · Sign in</title>
<style>
  :root { --bg: #0b0e14; --panel: #12151d; --border: #232838; --text: #e6e9f0; --muted: #8a92a6; --accent: #4c8dff; --err: #ff6b6b; color-scheme: dark; }
  @media (prefers-color-scheme: light) {
    :root { --bg: #f5f6f8; --panel: #ffffff; --border: #e2e5ec; --text: #1a1d29; --muted: #5c6270; --accent: #2563eb; --err: #c62828; color-scheme: light; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 360px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 28px 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { color: var(--muted); margin: 0 0 20px; font-size: 13px; }
  label { display: block; font-size: 13px; color: var(--muted); margin: 14px 0 6px; }
  input { width: 100%; padding: 10px 12px; font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { width: 100%; margin-top: 20px; padding: 10px; font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: 6px; cursor: pointer; }
  .err { color: var(--err); font-size: 13px; margin: 0 0 4px; }
</style>
</head>
<body>
<main>
  <h1>Runner Fleet</h1>
  <p class="sub">Sign in to the dashboard.</p>
  ${o.error ? `<p class="err" role="alert">${esc(o.error)}</p>` : ""}
  <form method="post" action="/login">
    <input type="hidden" name="next" value="${esc(o.next)}">
    <label for="username">Email</label>
    <input id="username" name="username" type="email" autocomplete="username" required value="${esc(o.username ?? "")}"${o.username ? "" : " autofocus"}>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required${o.username ? " autofocus" : ""}>
    <button type="submit">Sign in</button>
  </form>
</main>
</body>
</html>
`;
}
