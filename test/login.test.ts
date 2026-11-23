// The browser login (src/aws/login.ts, src/session.ts, src/auth.ts) through the Lambda handler.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryBlobStore } from "../src/aws/blob-store";
import { createApp, handle, loadMigrations, type FunctionUrlEvent, type FunctionUrlResult } from "../src/aws/handler";
import { settingsFrom } from "../src/aws/config";
import { FAILURES_GLOBAL, FAILURES_PER_IP, hashPassword, LIMIT_KEY, safeNext, verifyPassword } from "../src/aws/login";
import { SESSION_COOKIE, signSession, verifySession } from "../src/session";
import { MIGRATIONS_DIR } from "./d1-sqlite";

const migrations = loadMigrations(MIGRATIONS_DIR);
const USER = "admin@example.com";
const PASSWORD = "correct horse battery staple, 46 characters...";
const FAST = { N: 2 ** 10, r: 8, p: 1 } as const; // tests only; production uses SCRYPT_PARAMS
const HASH = await hashPassword(PASSWORD, FAST);
const SECRETS = { DASHBOARD_ADMIN_USER: USER, DASHBOARD_ADMIN_PASSWORD_HASH: HASH, SESSION_SIGNING_KEY: "k".repeat(43), TELEMETRY_TOKEN: "t" };

function app(secrets: Record<string, string> = SECRETS, blobs = new MemoryBlobStore()) {
  return {
    blobs,
    app: createApp({
      blobs,
      migrations,
      dir: mkdtempSync(join(tmpdir(), "rfd-login-")),
      settings: settingsFrom({ POLL_SCOPES: "org:Example" }, {}),
      secrets: async () => secrets,
    }),
  };
}

function ev(method: string, path: string, o: { query?: string; form?: Record<string, string>; cookies?: string[]; headers?: Record<string, string>; ip?: string } = {}): FunctionUrlEvent {
  return {
    version: "2.0",
    rawPath: path,
    rawQueryString: o.query ?? "",
    headers: { host: "example.lambda-url.us-west-2.on.aws", ...(o.form ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...o.headers },
    cookies: o.cookies,
    body: o.form ? new URLSearchParams(o.form).toString() : undefined,
    isBase64Encoded: false,
    requestContext: { http: { method, sourceIp: o.ip ?? "203.0.113.7" } },
  };
}

const login = (a: ReturnType<typeof app>["app"], username: string, password: string, extra: Parameters<typeof ev>[2] = {}) =>
  handle(a, ev("POST", "/login", { ...extra, form: { username, password, next: "/timing" } })) as Promise<FunctionUrlResult>;

const cookieOf = (r: FunctionUrlResult) => r.cookies?.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(";")[0];

describe("password hashes", () => {
  it("verifies the right password and rejects others", async () => {
    expect(HASH).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword(PASSWORD, HASH)).toBe(true);
    expect(await verifyPassword(`${PASSWORD}x`, HASH)).toBe(false);
    expect(await verifyPassword(PASSWORD, "garbage")).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword(PASSWORD, FAST)).not.toBe(await hashPassword(PASSWORD, FAST));
  });
});

describe("session tokens", () => {
  it("accept a fresh token and refuse a tampered, expired, foreign or other-user one", async () => {
    const t = await signSession("key", USER, 1000, 60);
    expect(await verifySession("key", USER, t, 1010)).toMatchObject({ u: USER });
    expect(await verifySession("key", USER, t, 1061)).toBeNull();
    expect(await verifySession("other", USER, t, 1010)).toBeNull();
    expect(await verifySession("key", "someone@else", t, 1010)).toBeNull();
    const [p, s] = t.split(".");
    expect(await verifySession("key", USER, `${p}x.${s}`, 1010)).toBeNull();
    expect(await verifySession("key", USER, `${p}.${s!.slice(0, -2)}AA`, 1010)).toBeNull();
  });
});

describe("login flow", () => {
  it("sends a browser without a session to /login, and /api/* gets 401 JSON", async () => {
    const { app: a, blobs } = app();
    const page = await handle(a, ev("GET", "/timing"));
    expect(page).toMatchObject({ statusCode: 302, headers: { location: "/login?next=%2Ftiming" } });
    const api = await handle(a, ev("GET", "/api/state"));
    expect(api).toMatchObject({ statusCode: 401 });
    expect(api!.headers["content-type"]).toContain("json");
    expect(blobs.objects.size).toBe(0);
  });

  it("ignores Basic Auth once the login page is configured", async () => {
    const { app: a } = app({ ...SECRETS, DASHBOARD_USER: "u", DASHBOARD_PASSWORD: "p" });
    const res = await handle(a, ev("GET", "/api/state", { headers: { authorization: `Basic ${Buffer.from("u:p").toString("base64")}` } }));
    expect(res).toMatchObject({ statusCode: 401 });
  });

  it("serves the form with no-store and a strict CSP", async () => {
    const { app: a } = app();
    const res = (await handle(a, ev("GET", "/login", { query: "next=%2Ftiming" })))!;
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="password"');
    expect(res.body).toContain('value="/timing"');
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("logs in, sets a hardened cookie, and the cookie opens the dashboard and the API", async () => {
    const { app: a } = app();
    const res = await login(a, USER.toUpperCase(), PASSWORD);
    expect(res).toMatchObject({ statusCode: 303, headers: { location: "/timing" } });
    const set = res.cookies!.join("\n");
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age="]) expect(set).toContain(attr);
    const cookie = cookieOf(res)!;
    expect((await handle(a, ev("GET", "/", { cookies: [cookie] })))!.statusCode).toBe(200);
    expect((await handle(a, ev("GET", "/api/timing", { cookies: ["other=1", cookie] })))!.statusCode).toBe(200);
  });

  it("gives the same answer for a wrong username and a wrong password", async () => {
    const { app: a } = app();
    const wrongUser = await login(a, "nobody@example.com", PASSWORD);
    const wrongPass = await login(a, USER, "nope");
    expect(wrongUser.statusCode).toBe(401);
    expect(wrongPass.statusCode).toBe(401);
    expect(wrongUser.body.replace(/value="[^"]*"/g, "")).toBe(wrongPass.body.replace(/value="[^"]*"/g, ""));
    expect(wrongUser.cookies).toBeUndefined();
  });

  it("never redirects off the site after login", () => {
    for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example", "", "/login", "/logout"]) expect(safeNext(bad)).toBe("/");
    expect(safeNext("/timing?w=7d")).toBe("/timing?w=7d");
  });

  it("logout clears the cookie", async () => {
    const { app: a } = app();
    const res = (await handle(a, ev("POST", "/logout")))!;
    expect(res).toMatchObject({ statusCode: 303, headers: { location: "/login" } });
    expect(res.cookies![0]).toMatch(new RegExp(`^${SESSION_COOKIE}=; .*Max-Age=0`));
  });

  it("rate-limits failures per client, even for the right password, and resets on success", async () => {
    const { app: a, blobs } = app();
    for (let i = 0; i < FAILURES_PER_IP; i++) expect((await login(a, USER, "wrong")).statusCode).toBe(401);
    const limited = await login(a, USER, PASSWORD);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // Another client is not affected, and its success clears only its own record.
    expect((await login(a, USER, PASSWORD, { ip: "198.51.100.1" })).statusCode).toBe(303);
    expect((await login(a, USER, PASSWORD)).statusCode).toBe(429);
    expect(blobs.objects.has(LIMIT_KEY)).toBe(true);
  });

  it("caps failures across all clients", async () => {
    const { app: a } = app();
    for (let i = 0; i < FAILURES_GLOBAL; i++) await login(a, USER, "wrong", { ip: `192.0.2.${i}` });
    expect((await login(a, USER, PASSWORD, { ip: "192.0.2.250" })).statusCode).toBe(429);
  });

  it("refuses a half-written login configuration instead of falling back to Basic Auth", async () => {
    const { app: a } = app({ DASHBOARD_ADMIN_USER: USER, TELEMETRY_TOKEN: "t", DASHBOARD_USER: "u", DASHBOARD_PASSWORD: "p" });
    expect(await handle(a, ev("GET", "/"))).toMatchObject({ statusCode: 503 });
  });

  it("keeps the telemetry bearer token as it was", async () => {
    const { app: a } = app();
    const body = JSON.stringify({ host: "h", cpu_pct: 1, cpu_count: 1, mem_used_mb: 1, mem_total_mb: 2 });
    const ok = await handle(a, { ...ev("POST", "/api/telemetry", { headers: { authorization: "Bearer t" } }), body });
    expect(ok).toMatchObject({ statusCode: 204 });
    const no = await handle(a, { ...ev("POST", "/api/telemetry", { headers: { authorization: "Bearer x" } }), body });
    expect(no).toMatchObject({ statusCode: 401 });
  });
});

describe("origin secret (Cloudflare in front)", () => {
  const secrets = { ...SECRETS, ORIGIN_SECRET: "edge-secret" };

  it("refuses requests that did not come through Cloudflare, telemetry included", async () => {
    const { app: a } = app(secrets);
    expect(await handle(a, ev("GET", "/login"))).toMatchObject({ statusCode: 403 });
    expect(await handle(a, ev("POST", "/api/telemetry", { headers: { authorization: "Bearer t", "x-origin-auth": "wrong" } }))).toMatchObject({ statusCode: 403 });
  });

  it("serves requests that carry the header, and limits by Cloudflare's client address", async () => {
    const { app: a } = app(secrets);
    const edge = (ip: string) => ({ "x-origin-auth": "edge-secret", "cf-connecting-ip": ip });
    expect((await handle(a, ev("GET", "/login", { headers: edge("1.1.1.1") })))!.statusCode).toBe(200);
    for (let i = 0; i < FAILURES_PER_IP; i++) await login(a, USER, "wrong", { headers: edge("1.1.1.1"), ip: "172.70.0.1" });
    expect((await login(a, USER, PASSWORD, { headers: edge("1.1.1.1"), ip: "172.70.0.1" })).statusCode).toBe(429);
    expect((await login(a, USER, PASSWORD, { headers: edge("2.2.2.2"), ip: "172.70.0.1" })).statusCode).toBe(303);
  });
});
