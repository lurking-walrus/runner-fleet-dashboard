// A minimal D1Database backed by node:sqlite, so tests run the REAL migrations and the REAL SQL
// (window functions included) instead of mocking query shapes.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Param = string | number | null;

class Stmt {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: Param[] = [],
  ) {}
  bind(...params: Param[]) {
    return new Stmt(this.db, this.sql, params);
  }
  runSync() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes) } };
  }
  async run() {
    return this.runSync();
  }
  async all<T = Record<string, unknown>>() {
    const results = this.db.prepare(this.sql).all(...this.params) as T[];
    return { success: true, results, meta: { changes: 0 } };
  }
  async first<T = Record<string, unknown>>() {
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }
}

export function migratedDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  const dir = join(import.meta.dirname, "..", "migrations");
  for (const f of readdirSync(dir).filter((n: string) => n.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(join(dir, f), "utf8"));
  }
  const fake = {
    prepare: (sql: string) => new Stmt(raw, sql),
    async batch(stmts: Stmt[]) {
      raw.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.runSync());
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { db: fake as unknown as D1Database, raw };
}
