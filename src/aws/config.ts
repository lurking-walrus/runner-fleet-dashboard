// The Worker's `env`, assembled on AWS: the same non-secret settings as wrangler.jsonc `vars` (the
// build copies them, so there is one place to change a setting), Lambda environment overrides, and
// secrets from SSM Parameter Store (SecureString under SSM_PREFIX), cached for a few minutes.
import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";
import { dashboardAuthMode } from "../auth";
import type { Secrets } from "../types";

/** Secrets the app reads, and the only parameter names under SSM_PREFIX that are loaded. */
export const SECRET_KEYS = [
  "GH_APP_PRIVATE_KEY",
  "GH_PAT",
  "DASHBOARD_ADMIN_USER",
  "DASHBOARD_ADMIN_PASSWORD_HASH",
  "SESSION_SIGNING_KEY",
  "ORIGIN_SECRET",
  "DASHBOARD_USER",
  "DASHBOARD_PASSWORD",
  "TELEMETRY_TOKEN",
  "ALERT_WEBHOOK_URL",
] as const;

/** Non-secret settings the Lambda environment may set on top of wrangler.jsonc's vars. */
export const SETTING_KEYS = ["GH_APP_ID", "GH_APP_INSTALLATION_ID", "TELEMETRY_MIN_WRITE_SECONDS"] as const;

/**
 * Without these the app's auth checks would compare against empty strings: refuse instead. The
 * dashboard login is checked separately (auth.ts dashboardAuthMode): the login page's three
 * values, or, until they exist, the legacy DASHBOARD_USER/DASHBOARD_PASSWORD.
 */
export const REQUIRED_SECRETS = ["TELEMETRY_TOKEN"] as const;

const SECRETS_TTL_MS = 10 * 60_000;

export type Settings = Record<string, string>;

export function settingsFrom(vars: Settings, processEnv: Record<string, string | undefined>): Settings {
  const out: Settings = { ...vars };
  for (const k of [...Object.keys(vars), ...SETTING_KEYS]) {
    const v = processEnv[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

export type SecretLoader = () => Promise<Partial<Secrets>>;

export function ssmSecretLoader(prefix: string, ssm = new SSMClient({})): SecretLoader {
  const path = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return async () => {
    const out: Record<string, string> = {};
    let next: string | undefined;
    do {
      const res = await ssm.send(new GetParametersByPathCommand({ Path: path, WithDecryption: true, Recursive: false, NextToken: next }));
      for (const p of res.Parameters ?? []) {
        const name = p.Name?.slice(path.length) ?? "";
        if ((SECRET_KEYS as readonly string[]).includes(name) && p.Value) out[name] = p.Value;
      }
      next = res.NextToken;
    } while (next);
    return out as Partial<Secrets>;
  };
}

/** Caches the loaded secrets for SECRETS_TTL_MS, so a rotation reaches a warm container within minutes. */
export function cachedSecrets(load: SecretLoader, ttlMs = SECRETS_TTL_MS): SecretLoader {
  let cache: { at: number; value: Partial<Secrets> } | null = null;
  return async () => {
    if (cache && Date.now() - cache.at < ttlMs) return cache.value;
    cache = { at: Date.now(), value: await load() };
    return cache.value;
  };
}

export function missingRequired(secrets: Partial<Secrets>): string[] {
  const missing: string[] = REQUIRED_SECRETS.filter((k) => !secrets[k]);
  if (dashboardAuthMode(secrets) === "unconfigured") {
    missing.push("DASHBOARD_ADMIN_USER + DASHBOARD_ADMIN_PASSWORD_HASH + SESSION_SIGNING_KEY (or the legacy DASHBOARD_USER + DASHBOARD_PASSWORD)");
  }
  return missing;
}
