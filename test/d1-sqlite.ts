// A D1Database over an in-memory node:sqlite database with every migration applied, so tests run
// the REAL migrations and the REAL SQL (window functions included) instead of mocking query
// shapes. It is the same adapter the AWS deployment runs on (src/aws/sqlite-d1.ts).
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { d1Over } from "../src/aws/sqlite-d1";

export const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

export function migratedDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS_DIR).filter((n: string) => n.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }
  return { db: d1Over(raw), raw };
}
