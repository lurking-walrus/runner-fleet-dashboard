// The D1 API the app uses (prepare/bind/first/all/run/batch), over node:sqlite. D1 is SQLite, so
// the app's SQL runs here unchanged. This is the production adapter on AWS AND the database the
// unit tests run against (test/d1-sqlite.ts), so the tests exercise exactly this code.
import type { DatabaseSync } from "node:sqlite";

type Param = string | number | bigint | null | Uint8Array;

interface Meta {
  changes: number;
}

class Stmt {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: Param[] = [],
  ) {}

  bind(...params: Param[]): Stmt {
    return new Stmt(this.db, this.sql, params);
  }

  /** Synchronous run used by batch(). A SELECT in a batch returns its rows, like D1. */
  runSync(): { success: true; results: unknown[]; meta: Meta } {
    if (/^\s*(SELECT|WITH)\b/i.test(this.sql)) {
      return { success: true, results: this.db.prepare(this.sql).all(...this.params) as unknown[], meta: { changes: 0 } };
    }
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes) } };
  }

  async run() {
    return this.runSync();
  }

  async all<T = Record<string, unknown>>() {
    const results = this.db.prepare(this.sql).all(...this.params) as T[];
    return { success: true as const, results, meta: { changes: 0 } };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column === undefined ? row : (row[column] as unknown)) as T;
  }
}

/** Wraps an open node:sqlite connection as a D1Database. */
export function d1Over(db: DatabaseSync): D1Database {
  const adapter = {
    prepare: (sql: string) => new Stmt(db, sql),
    // D1 runs a batch as one transaction: all statements or none.
    async batch(stmts: Stmt[]) {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.runSync());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return adapter as unknown as D1Database;
}
