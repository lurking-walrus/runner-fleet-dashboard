#!/usr/bin/env node
// Builds the AWS Lambda package (issue #28): dist/lambda.zip containing
//   index.mjs     src/aws/handler.ts bundled with esbuild (AWS SDK included, so its version is
//                 pinned by package-lock.json rather than by whatever the runtime ships)
//   migrations/   the same migrations D1 applies; the store applies them on S3 (src/aws/store.ts)
//   vars.json     wrangler.jsonc `vars`, so a setting has one home for both deployments
// Deterministic: fixed order and timestamps, so an unchanged source gives the same zip hash on any
// machine and the deploy does not update the function for nothing.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";
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

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else files.push(p.slice(out.length + 1));
  }
})(out);
files.sort();
writeFileSync(zipPath, zip(files.map((name) => ({ name, data: readFileSync(join(out, name)) }))));
console.log(`built ${zipPath} (${files.length} files)`);

/**
 * A plain deflate zip, written here rather than with the `zip` CLI (not on every runner image) and
 * with one fixed timestamp (1980-01-01, the DOS epoch) and no extra fields, so the bytes depend
 * only on the file names and contents.
 */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(0, 10); // time 00:00
    header.writeUInt16LE(0x21, 12); // date 1980-01-01
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    locals.push(header, nameBuf, packed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(0x0314, 4); // made by: unix, 2.0
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += header.length + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}
