import { logEvent } from "./db";
import type { Env, PollScope } from "./types";

const API = "https://api.github.com";

// Installation tokens live 1h; refresh well before that so a poll never starts with one about to lapse.
const REFRESH_MARGIN_MS = 5 * 60_000;

let cached: { token: string; expiresAtMs: number; cacheKey: string } | null = null;

/**
 * Credential for GitHub API calls. A GitHub App is preferred (its installation tokens are minted
 * fresh from a non-expiring private key, so nothing needs rotating); GH_PAT is the fallback, used
 * when no App is configured or when minting an App token fails.
 */
export async function resolveGithubToken(env: Env, scopes: PollScope[]): Promise<string> {
  const appConfigured = Boolean(env.GH_APP_ID && env.GH_APP_PRIVATE_KEY);
  if (appConfigured) {
    try {
      return await installationToken(env, scopes);
    } catch (err) {
      if (!env.GH_PAT) throw err;
      console.warn(`GitHub App token failed, falling back to GH_PAT: ${err}`);
      await reportAppFallback(env, String(err));
    }
  }
  if (env.GH_PAT) return env.GH_PAT;
  throw new Error("No GitHub credentials configured: set GH_APP_ID + GH_APP_PRIVATE_KEY (preferred) or GH_PAT");
}

async function installationToken(env: Env, scopes: PollScope[]): Promise<string> {
  const cacheKey = `${env.GH_APP_ID}:${env.GH_APP_INSTALLATION_ID ?? "auto"}`;
  if (cached && cached.cacheKey === cacheKey && cached.expiresAtMs - Date.now() > REFRESH_MARGIN_MS) {
    return cached.token;
  }

  const jwt = await signAppJwt(env.GH_APP_ID!, env.GH_APP_PRIVATE_KEY!);
  const installationId = env.GH_APP_INSTALLATION_ID || (await discoverInstallationId(jwt, scopes));

  const res = await appFetch(`/app/installations/${installationId}/access_tokens`, jwt, { method: "POST" });
  const body = (await res.json()) as { token: string; expires_at: string };
  cached = { token: body.token, expiresAtMs: Date.parse(body.expires_at), cacheKey };
  return body.token;
}

/** With no GH_APP_INSTALLATION_ID set, look the installation up from the first poll scope. */
async function discoverInstallationId(jwt: string, scopes: PollScope[]): Promise<number> {
  const scope = scopes[0];
  if (!scope) throw new Error("GH_APP_INSTALLATION_ID is unset and POLL_SCOPES is empty, cannot discover the installation");
  const path =
    scope.kind === "org" ? `/orgs/${scope.owner}/installation` : `/repos/${scope.owner}/${scope.repo}/installation`;
  const res = await appFetch(path, jwt);
  return ((await res.json()) as { id: number }).id;
}

async function appFetch(path: string, jwt: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "runner-fleet-dashboard",
    },
  });
  if (!res.ok) throw new Error(`GitHub App ${path} -> ${res.status} ${await res.text()}`);
  return res;
}

async function signAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // iat backdated 60s for clock skew; GitHub caps exp at 10 minutes out.
  const header = b64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = b64urlJson({ iat: now - 60, exp: now + 9 * 60, iss: appId });
  const signingInput = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

/**
 * GitHub hands out keys as PKCS#1 ("BEGIN RSA PRIVATE KEY") but WebCrypto only imports PKCS#8, so
 * accept either and wrap PKCS#1 in the PKCS#8 envelope here rather than making anyone run openssl.
 * Also tolerates the key pasted with literal "\n" sequences instead of real newlines.
 */
export function pemToPkcs8(pem: string): ArrayBuffer {
  const normalized = pem.replace(/\\n/g, "\n");
  const isPkcs1 = normalized.includes("BEGIN RSA PRIVATE KEY");
  const der = Uint8Array.from(
    atob(normalized.replace(/-----(BEGIN|END)[A-Z ]*-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );
  const out = isPkcs1 ? wrapPkcs1(der) : der;
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

function wrapPkcs1(pkcs1: Uint8Array): Uint8Array {
  // PrivateKeyInfo ::= SEQUENCE { version 0, AlgorithmIdentifier(rsaEncryption, NULL), OCTET STRING(pkcs1) }
  const version = [0x02, 0x01, 0x00];
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length)];
  const bodyLen = version.length + algorithm.length + octet.length + pkcs1.length;
  return Uint8Array.from([0x30, ...derLength(bodyLen), ...version, ...algorithm, ...octet, ...pkcs1]);
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

/**
 * Surface a silent fallback as a dashboard event (at most hourly). Otherwise a broken App setup
 * looks identical to a bad PAT: the same GitHub 401, with the real cause only in Worker logs.
 */
async function reportAppFallback(env: Env, error: string) {
  try {
    const last = await env.DB.prepare(`SELECT ts FROM events WHERE kind = 'github_app_auth_failed' ORDER BY ts DESC LIMIT 1`).first<{
      ts: string;
    }>();
    const now = new Date();
    if (last && now.getTime() - Date.parse(last.ts) < 60 * 60_000) return;
    await logEvent(
      env.DB,
      {
        severity: "error",
        kind: "github_app_auth_failed",
        message: `GitHub App auth failed, using the GH_PAT fallback instead: ${error.slice(0, 300)}`,
      },
      now.toISOString(),
    );
  } catch (err) {
    console.warn(`could not record github_app_auth_failed: ${err}`);
  }
}
