import { constantTimeEqual, readCookie, SESSION_COOKIE, verifySession } from "./session";

/** The dashboard's browser login (src/aws/login.ts) is configured: all three values are set. */
export interface SessionConfig {
  DASHBOARD_ADMIN_USER?: string;
  DASHBOARD_ADMIN_PASSWORD_HASH?: string;
  SESSION_SIGNING_KEY?: string;
}

export type DashboardAuthMode = "session" | "basic" | "unconfigured";

/**
 * Which login the dashboard uses. The login page (`session`) once its three SSM values exist; until
 * then the legacy Basic Auth, so a deploy never locks the owner out before the values are written.
 * A half-written login config refuses rather than falling back, so deleting one value cannot
 * quietly re-open Basic Auth.
 */
export function dashboardAuthMode(env: SessionConfig & { DASHBOARD_USER?: string; DASHBOARD_PASSWORD?: string }): DashboardAuthMode {
  const s = [env.DASHBOARD_ADMIN_USER, env.DASHBOARD_ADMIN_PASSWORD_HASH, env.SESSION_SIGNING_KEY];
  if (s.every(Boolean)) return "session";
  if (s.some(Boolean)) return "unconfigured";
  return env.DASHBOARD_USER && env.DASHBOARD_PASSWORD ? "basic" : "unconfigured";
}

/**
 * Gates every dashboard page and /api/* route except telemetry. null means allowed. A browser
 * without a session is sent to /login (pages) or answered 401 JSON (/api/*, which the pages turn
 * into a redirect).
 */
export async function requireDashboardAuth(
  req: Request,
  env: SessionConfig & { DASHBOARD_USER?: string; DASHBOARD_PASSWORD?: string },
): Promise<Response | null> {
  const mode = dashboardAuthMode(env);
  if (mode === "unconfigured") return new Response("not configured", { status: 503 });
  if (mode === "basic") return requireBasicAuth(req, env.DASHBOARD_USER!, env.DASHBOARD_PASSWORD!);

  const token = readCookie(req, SESSION_COOKIE);
  if (token && (await verifySession(env.SESSION_SIGNING_KEY!, env.DASHBOARD_ADMIN_USER!, token))) return null;

  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) {
    return Response.json({ error: "login required", login: "/login" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  const next = url.pathname + url.search;
  const location = next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

export async function requireBasicAuth(req: Request, user: string, password: string): Promise<Response | null> {
  // Unset secrets would otherwise compare as "" and admit `Basic Og==` (#32): refuse instead.
  if (!user || !password) return new Response("not configured", { status: 503 });
  const header = req.headers.get("Authorization");
  if (header?.startsWith("Basic ")) {
    const decoded = atob(header.slice(6));
    const sep = decoded.indexOf(":");
    const gotUser = decoded.slice(0, sep);
    const gotPass = decoded.slice(sep + 1);
    if ((await constantTimeEqual(gotUser, user)) && (await constantTimeEqual(gotPass, password))) {
      return null;
    }
  }
  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="runner-fleet-dashboard"' },
  });
}

export async function requireBearer(req: Request, token: string): Promise<Response | null> {
  if (!token) return new Response("not configured", { status: 503 });
  const header = req.headers.get("Authorization");
  const got = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (got && (await constantTimeEqual(got, token))) return null;
  return new Response("Unauthorized", { status: 401 });
}
