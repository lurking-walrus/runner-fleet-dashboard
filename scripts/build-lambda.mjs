#!/usr/bin/env node
// Builds the AWS Lambda package (issue #28): dist/lambda.zip containing
//   index.mjs     src/aws/handler.ts bundled with esbuild (AWS SDK included, so its version is
//                 pinned by package-lock.json rather than by whatever the runtime ships)
//   migrations/   the same migrations D1 applies; the store applies them on S3 (src/aws/store.ts)
//   vars.json     wrangler.jsonc `vars`, so a setting has one home for both deployments
// Deterministic: fixed file times and order, so an unchanged source gives the same zip hash and
// the deploy does not update the function for nothing.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "lambda");
const zipPath = join(root, "dist", "lambda.zip");

rmSync(out, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(join(out, "migrations"), { recursive: true });

await build({
  entryPoints: [join(root, "src", "aws", "handler.ts")],
  outfile: join(out, "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  loader: { ".html": "text" },
  // The bundled AWS SDK is CommonJS in places; give it `require` inside an ES module.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});

for (const f of readdirSync(join(root, "migrations")).filter((n) => n.endsWith(".sql"))) {
  cpSync(join(root, "migrations", f), join(out, "migrations", f));
}

// wrangler.jsonc is JSON with // line comments (none inside its string values).
const jsonc = readFileSync(join(root, "wrangler.jsonc"), "utf8");
const config = JSON.parse(jsonc.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"));
writeFileSync(join(out, "vars.json"), `${JSON.stringify(config.vars, null, 2)}\n`);

const epoch = new Date("2020-01-01T00:00:00Z");
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    utimesSync(p, epoch, epoch);
    if (name.isDirectory()) walk(p);
    else files.push(p.slice(out.length + 1));
  }
})(out);
files.sort();
execFileSync("zip", ["-X", "-q", zipPath, ...files], { cwd: out });
console.log(`built ${zipPath} (${files.length} files)`);
