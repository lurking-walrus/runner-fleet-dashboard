// SQLite files on S3 as the dashboard's database on AWS (issue #28).
//
// Each invocation downloads the file(s) it needs (a warm container keeps a pristine copy and asks S3
// only "has it changed?"), runs the app's UNCHANGED code against them through the D1 adapter, and,
// if it wrote anything, uploads the file with a conditional write on the ETag it read. If another
// invocation wrote first, the write is refused (WriteConflict) and the whole unit of work is redone
// on the new copy (`retry`), or, for a page view whose only write is a cache row, dropped (`drop`).
// That is a transaction per invocation, with S3 as the commit log.
//
// TWO FILES, because of who writes how often:
//   main.db       everything except telemetry. Written by the 2-minute cron, which holds it for the
//                 several seconds its GitHub calls take.
//   telemetry.db  `telemetry` and `telemetry_samples`. Written by every host's agent every 30 s.
// In one file, every telemetry write would invalidate the cron's write and the cron would retry for
// ever. Here each write path writes ONE file. The `main` scope opens main.db and ATTACHes
// telemetry.db as `tel`; SQLite resolves an unqualified table name in main first, then in attached
// databases, and main.db has no telemetry tables, so the app's SQL reads both without a change.
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WriteConflict, type BlobStore } from "./blob-store";
import { d1Over } from "./sqlite-d1";

export const MAIN_KEY = "main.db";
export const TELEMETRY_KEY = "telemetry.db";
/** Tables that live in telemetry.db. A migration may CREATE them (they are moved); see migrate(). */
export const TELEMETRY_TABLES = ["telemetry", "telemetry_samples"] as const;
const LEDGER = "_aws_migrations";

export interface Migration {
  name: string;
  sql: string;
}

/** `main`: the app's normal view (main.db + telemetry.db read through ATTACH). `telemetry`: telemetry.db alone. */
export type Scope = "main" | "telemetry";
/** What a lost conditional write means: redo the work on the new copy, or drop the write (cache rows only). */
export type OnConflict = "retry" | "drop";

interface Pristine {
  etag: string;
  path: string;
}

interface Loaded {
  key: string;
  etag: string | null; // null: the object does not exist yet
  work: string;
  hash: string | null;
}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

export class SqliteOnS3 {
  private readonly pristine = new Map<string, Pristine>();

  constructor(
    private readonly blobs: BlobStore,
    private readonly migrations: readonly Migration[],
    private readonly dir: string,
    private readonly maxAttempts = 3,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  /** Runs `fn` against the scope's database and commits what it wrote. See the file header. */
  async run<T>(scope: Scope, onConflict: OnConflict, fn: (db: D1Database) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const keys = scope === "main" ? [MAIN_KEY, TELEMETRY_KEY] : [TELEMETRY_KEY];
      const files = await Promise.all(keys.map((k) => this.load(k)));
      if (scope === "telemetry" && files[0]!.etag === null) {
        // Nothing exists yet: the main scope creates both files (with every migration) first.
        this.discard(files);
        await this.run("main", "retry", async () => undefined);
        continue;
      }

      // D1 has no rollback across statements: what a handler wrote before it threw stays written
      // (runPoll records its own failure, then rethrows). So commit first, then rethrow.
      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, value: await this.session(scope, files, fn) };
      } catch (error) {
        outcome = { ok: false, error };
      }
      const settle = (): T => {
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
      };

      // An empty file is SQLite opening a path that did not exist and writing nothing: never upload it.
      const changed = files.filter((f) => existsSync(f.work) && statSync(f.work).size > 0 && f.hash !== sha256(f.work));
      if (scope === "telemetry" && changed.some((f) => f.key !== TELEMETRY_KEY)) throw new Error("telemetry scope wrote outside telemetry.db");
      try {
        // telemetry.db first: it only changes in the main scope when a migration creates it.
        changed.sort((a, b) => (a.key === TELEMETRY_KEY ? -1 : b.key === TELEMETRY_KEY ? 1 : 0));
        for (const f of changed) await this.commit(f);
        this.discard(files.filter((f) => !changed.includes(f)));
        return settle();
      } catch (err) {
        this.discard(files);
        if (!(err instanceof WriteConflict)) throw err;
        if (onConflict === "drop") {
          console.log(`dropped a write that lost to a concurrent one (${err.message})`);
          return settle();
        }
        if (attempt >= this.maxAttempts) throw err;
        console.log(`retrying after a concurrent write (attempt ${attempt}): ${err.message}`);
      }
    }
  }

  private async session<T>(scope: Scope, files: Loaded[], fn: (db: D1Database) => Promise<T>): Promise<T> {
    const [first, tel] = files;
    if (scope === "main") this.migrate(first!.work, tel!.work);
    const conn = new DatabaseSync(first!.work);
    try {
      conn.exec("PRAGMA journal_mode = DELETE"); // the file alone is the whole database; no -wal beside it
      if (scope === "main") conn.prepare("ATTACH DATABASE ? AS tel").run(tel!.work);
      return await fn(d1Over(conn));
    } finally {
      conn.close();
    }
  }

  /**
   * Applies pending migrations to main.db (one ledger, in main.db) with telemetry.db attached, then
   * moves any telemetry table a migration created in main.db into telemetry.db. A later migration
   * that ALTERs a telemetry table resolves the unqualified name to tel.<table> and changes
   * telemetry.db directly; test/aws-store.test.ts pins that no migration does that today, because
   * such a migration writes BOTH files and needs more care (see that test).
   */
  private migrate(mainPath: string, telPath: string) {
    const conn = new DatabaseSync(mainPath);
    try {
      conn.exec("PRAGMA journal_mode = DELETE");
      conn.exec(`CREATE TABLE IF NOT EXISTS ${LEDGER} (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
      const done = new Set((conn.prepare(`SELECT name FROM ${LEDGER}`).all() as { name: string }[]).map((r) => r.name));
      const pending = this.migrations.filter((m) => !done.has(m.name));
      if (pending.length === 0) return;
      conn.prepare("ATTACH DATABASE ? AS tel").run(telPath);
      conn.exec("PRAGMA tel.journal_mode = DELETE");
      for (const m of pending) {
        conn.exec("BEGIN");
        try {
          conn.exec(m.sql);
          this.moveTelemetryTables(conn);
          conn.prepare(`INSERT INTO ${LEDGER} (name, applied_at) VALUES (?, ?)`).run(m.name, new Date().toISOString());
          conn.exec("COMMIT");
        } catch (err) {
          conn.exec("ROLLBACK");
          throw new Error(`migration ${m.name} failed: ${err}`);
        }
        console.log(`applied migration ${m.name}`);
      }
    } finally {
      conn.close();
    }
  }

  private moveTelemetryTables(conn: DatabaseSync) {
    for (const table of TELEMETRY_TABLES) {
      const inMain = conn.prepare(`SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?`).get(table);
      if (!inMain) continue;
      const inTel = conn.prepare(`SELECT 1 FROM tel.sqlite_master WHERE type = 'table' AND name = ?`).get(table);
      if (!inTel) {
        const objects = conn
          .prepare(`SELECT type, name, sql FROM main.sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type = 'index'`)
          .all(table) as { type: string; name: string; sql: string }[];
        for (const o of objects) {
          const qualified =
            o.type === "table"
              ? o.sql.replace(/^CREATE\s+TABLE\s+("?)(\w+)\1/i, `CREATE TABLE tel."$2"`)
              : o.sql.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+("?)(\w+)\2/i, (_m, u: string | undefined, _q, n: string) => `CREATE ${u ?? ""}INDEX tel."${n}"`);
          conn.exec(qualified);
        }
        conn.exec(`INSERT INTO tel."${table}" SELECT * FROM main."${table}"`);
      }
      conn.exec(`DROP TABLE main."${table}"`);
    }
  }

  /** A private working copy of `key` for this attempt, from the pristine cache when S3 says it is current. */
  private async load(key: string): Promise<Loaded> {
    const cached = this.pristine.get(key);
    const res = await this.blobs.get(key, cached?.etag);
    const work = join(this.dir, `work-${randomUUID()}-${key}`);
    if (res.status === "missing") {
      this.pristine.delete(key);
      return { key, etag: null, work, hash: null };
    }
    if (res.status === "ok") {
      const path = join(this.dir, `pristine-${key}`);
      writeFileSync(path, res.body);
      this.pristine.set(key, { etag: res.etag, path });
    }
    const p = this.pristine.get(key)!;
    copyFileSync(p.path, work);
    return { key, etag: p.etag, work, hash: sha256(work) };
  }

  private async commit(f: Loaded) {
    const body = readFileSync(f.work);
    const etag = await this.blobs.put(f.key, body, f.etag);
    // What we just wrote is now the current version: keep it as the pristine copy.
    const path = join(this.dir, `pristine-${f.key}`);
    copyFileSync(f.work, path);
    rmSync(f.work, { force: true });
    this.pristine.set(f.key, { etag, path });
  }

  private discard(files: Loaded[]) {
    for (const f of files) if (existsSync(f.work)) rmSync(f.work, { force: true });
  }

  /** Copies main.db to backups/<YYYY-MM-DD>.db (the bucket's lifecycle expires them). */
  async backup(day: string) {
    await this.blobs.copy(MAIN_KEY, `backups/${day}.db`);
  }
}
