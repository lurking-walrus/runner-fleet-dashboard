#!/usr/bin/env bash
# Stores the dashboard's admin login in SSM (AWS deployment) WITHOUT storing or printing the password.
#
# Reads DASHBOARD_ADMIN_USERNAME and DASHBOARD_ADMIN_PASSWORD from this repository's .env
# (gitignored), and writes, as SecureString parameters under $SSM_PREFIX:
#   DASHBOARD_ADMIN_USER            the username (an email address)
#   DASHBOARD_ADMIN_PASSWORD_HASH   scrypt$N$r$p$salt$hash, a fresh random salt each run (src/aws/login.ts)
#   SESSION_SIGNING_KEY             32 random bytes that sign the session cookie; created once and kept
#                                   on later runs (changing the password does not log you out), unless
#                                   --rotate-session-key is given (which ends every session)
# Once all three exist the Lambda serves the login page and stops accepting Basic Auth (within the
# 10-minute secrets cache).
#
# Usage: AWS_PROFILE=<admin profile> scripts/store-admin-login.sh [--rotate-session-key]
#   SSM_PREFIX (default /runner-fleet-dashboard), AWS_REGION (default us-west-2)
set -euo pipefail
cd "$(dirname "$0")/.."
prefix="${SSM_PREFIX:-/runner-fleet-dashboard}"
region="${AWS_REGION:-us-west-2}"
rotate=false
[[ "${1:-}" == "--rotate-session-key" ]] && rotate=true

[[ -f .env ]] || { echo "no .env in $(pwd)" >&2; exit 1; }
aws sts get-caller-identity --region "$region" >/dev/null || { echo "AWS credentials are not valid (aws sso login?)" >&2; exit 1; }

umask 077
work="$(mktemp -d)"
[[ -n "$work" && -d "$work" ]] || exit 1
cleanup() { rm -f -- "$work/user" "$work/hash" "$work/key"; rmdir -- "$work"; }
trap cleanup EXIT

# Node reads .env itself, so the password never becomes a shell variable, an argument or output.
# It writes only the username and the hash, each to a private temp file.
node --input-type=module - "$work" <<'JS'
import { randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (!m) continue;
  let v = m[2];
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
  env[m[1]] = v;
}
const user = (env.DASHBOARD_ADMIN_USERNAME ?? "").trim();
let password = env.DASHBOARD_ADMIN_PASSWORD ?? "";
delete env.DASHBOARD_ADMIN_PASSWORD;
if (!user || !password) { console.error("DASHBOARD_ADMIN_USERNAME and DASHBOARD_ADMIN_PASSWORD must both be set in .env"); process.exit(1); }
if (password.length < 16) { console.error("DASHBOARD_ADMIN_PASSWORD is shorter than 16 characters; use a generated one"); process.exit(1); }
// Must match SCRYPT_PARAMS in src/aws/login.ts (the verifier reads N, r, p from the hash itself).
const N = 2 ** 15, r = 8, p = 1;
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32, { N, r, p, maxmem: 128 * 1024 * 1024 });
password = "";
const dir = process.argv[2];
writeFileSync(`${dir}/user`, user);
writeFileSync(`${dir}/hash`, `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`);
JS

put() { aws ssm put-parameter --region "$region" --type SecureString --overwrite --name "$prefix/$1" --value "file://$2" >/dev/null; }
put DASHBOARD_ADMIN_USER "$work/user"
put DASHBOARD_ADMIN_PASSWORD_HASH "$work/hash"
echo "SSM: $prefix/DASHBOARD_ADMIN_USER and $prefix/DASHBOARD_ADMIN_PASSWORD_HASH written"

if $rotate || ! aws ssm get-parameter --region "$region" --name "$prefix/SESSION_SIGNING_KEY" >/dev/null 2>&1; then
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' >"$work/key"
  put SESSION_SIGNING_KEY "$work/key"
  echo "SSM: $prefix/SESSION_SIGNING_KEY written (every existing session is now invalid)"
else
  echo "SSM: $prefix/SESSION_SIGNING_KEY kept"
fi
echo "The login applies within 10 minutes (the Lambda's secrets cache), or at once after a redeploy."
