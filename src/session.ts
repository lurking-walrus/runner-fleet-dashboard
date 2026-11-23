// The browser session: a signed cookie issued by the login page (src/aws/login.ts) and checked on
// every dashboard page and /api/* request (except /api/telemetry, which keeps its bearer token).
//
// The cookie is `__Host-rfd_session=<payload>.<signature>`:
//   payload    base64url JSON { u: username, iat, exp } (seconds since the epoch)
//   signature  base64url HMAC-SHA256(payload) under SESSION_SIGNING_KEY (SSM)
// HttpOnly, Secure, SameSite=Lax, Path=/, no Domain (the __Host- prefix makes the browser enforce
// the last three). Stateless: logging out clears the cookie in that browser; rotating
// SESSION_SIGNING_KEY ends every session everywhere.
//
// WebCrypto only, so this runs anywhere the app's handlers run.

export const SESSION_COOKIE = "__Host-rfd_session";
/** How long a login lasts. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface SessionClaims {
  u: string;
  iat: number;
  exp: number;
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmac(key: string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

/** Constant-time over two SHA-256 digests, so neither the content nor the length of `b` leaks. */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const xa = new Uint8Array(x);
  const ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i]! ^ ya[i]!;
  return diff === 0;
}

export async function signSession(key: string, username: string, nowS = Math.floor(Date.now() / 1000), ttlS = SESSION_TTL_SECONDS): Promise<string> {
  const claims: SessionClaims = { u: username, iat: nowS, exp: nowS + ttlS };
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  return `${payload}.${b64url(await hmac(key, payload))}`;
}

/** The claims of a valid, unexpired token for `username`; null for anything else. */
export async function verifySession(key: string, username: string, token: string, nowS = Math.floor(Date.now() / 1000)): Promise<SessionClaims | null> {
  if (!key || !token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, dot);
  const expected = b64url(await hmac(key, payload));
  if (!(await constantTimeEqual(token.slice(dot + 1), expected))) return null;
  const raw = fromB64url(payload);
  if (!raw) return null;
  let claims: SessionClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(raw)) as SessionClaims;
  } catch {
    return null;
  }
  if (typeof claims.exp !== "number" || typeof claims.u !== "string" || claims.exp <= nowS) return null;
  // A token minted for a previous admin username is not valid for the current one.
  if (claims.u !== username) return null;
  return claims;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function sessionCookie(token: string, maxAgeS = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
