// The AWS deployment (issue #28): SQLite files on S3 behind the D1 adapter, and the Lambda handler
// around the UNCHANGED Worker handlers. Runs against an in-memory BlobStore with S3's
// conditional-write semantics, so conflict handling is exercised for real.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { MemoryBlobStore, WriteConflict } from "../src/aws/blob-store";
import { createApp, handle, loadMigrations, type FunctionUrlEvent } from "../src/aws/handler";
import { settingsFrom } from "../src/aws/config";
import { MAIN_KEY, SqliteOnS3, TELEMETRY_KEY, TELEMETRY_TABLES } from "../src/aws/store";
import { MIGRATIONS_DIR } from "./d1-sqlite";

const migrations = loadMigrations(MIGRATIONS_DIR);
const tmp = () => mkdtempSync(join(tmpdir(), "rfd-"));

function tablesIn(blobs: MemoryBlobStore, key: string): string[] {
  const dir = tmp();
  const p = join(dir, key);
  writeFileSync(p, blobs.objects.get(key)!.body);
  const db = new DatabaseSync(p);
  const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
  db.close();
  return names;
}

const SECRETS = { DASHBOARD_USER: "u", DASHBOARD_PASSWORD: "p", TELEMETRY_TOKEN: "t" };
const basic = `Basic ${Buffer.from("u:p").toString("base64")}`;

function app(blobs = new MemoryBlobStore(), secrets: Record<string, string> = SECRETS, extra: Record<string, string> = {}) {
  return {
    blobs,
    app: createApp({
      blobs,
      migrations,
      dir: tmp(),
      settings: settingsFrom({ POLL_SCOPES: "org:Example", ...extra }, {}),
      secrets: async () => secrets,
    }),
  };
}

function http(method: string, path: string, opts: { auth?: string; body?: unknown } = {}): FunctionUrlEvent {
  return {
    version: "2.0",
    rawPath: path,
    rawQueryString: "",
    headers: { host: "example.lambda-url.us-west-2.on.aws", ...(opts.auth ? { authorization: opts.auth } : {}), "content-type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
    requestContext: { http: { method } },
  };
}

const telemetry = (host: string, cpu = 12) => ({
  host,
  cpu_pct: cpu,
  cpu_count: 8,
  load_avg_1m: 1,
  mem_used_mb: 100,
  mem_total_mb: 200,
  disk_used_gb: 1,
  disk_total_gb: 2,
  uptime_s: 3,
  agent_version: "test",
});

describe("SqliteOnS3", () => {
  it("creates both files on first use, with the telemetry tables only in telemetry.db", async () => {
    const blobs = new MemoryBlobStore();
    const store = new SqliteOnS3(blobs, migrations, tmp());
    await store.run("main", "retry", async (db) => db.prepare(`SELECT 1`).first());
    const main = tablesIn(blobs, MAIN_KEY);
    const tel = tablesIn(blobs, TELEMETRY_KEY);
    for (const t of TELEMETRY_TABLES) {
      expect(main).not.toContain(t);
      expect(tel).toContain(t);
    }
    expect(main).toEqual(expect.arrayContaining(["runners", "job_history", "job_steps", "events", "_aws_migrations"]));
  });

  it("reads telemetry through the main scope without qualifying the table name", async () => {
    const blobs = new MemoryBlobStore();
    const store = new SqliteOnS3(blobs, migrations, tmp());
    await store.run("telemetry", "retry", async (db) => {
      await db.prepare(`INSERT INTO telemetry (host, updated_at) VALUES ('h1', '2026-01-01T00:00:00Z')`).run();
    });
    const rows = await store.run("main", "drop", async (db) => (await db.prepare(`SELECT host FROM telemetry`).all()).results);
    expect(rows).toEqual([{ host: "h1" }]);
  });

  it("does not write when nothing changed", async () => {
    const blobs = new MemoryBlobStore();
    const store = new SqliteOnS3(blobs, migrations, tmp());
    await store.run("main", "retry", async () => undefined);
    const puts = blobs.puts;
    await store.run("main", "retry", async (db) => db.prepare(`SELECT COUNT(*) AS n FROM runners`).first());
    expect(blobs.puts).toBe(puts);
  });

  it("redoes the work when another writer committed first, and keeps both writes", async () => {
    const blobs = new MemoryBlobStore();
    const a = new SqliteOnS3(blobs, migrations, tmp());
    const b = new SqliteOnS3(blobs, migrations, tmp());
    await a.run("main", "retry", async () => undefined);
    let attempts = 0;
    await a.run("main", "retry", async (db) => {
      attempts++;
      await db.prepare(`INSERT INTO events (ts, severity, kind, message) VALUES ('t', 'info', 'k', 'from a')`).run();
      // b commits while a's attempt is in flight (only the first time)
      if (attempts === 1) {
        await b.run("main", "retry", async (db2) => {
          await db2.prepare(`INSERT INTO events (ts, severity, kind, message) VALUES ('t', 'info', 'k', 'from b')`).run();
        });
      }
    });
    expect(attempts).toBe(2);
    const msgs = await b.run("main", "drop", async (db) => (await db.prepare(`SELECT message FROM events ORDER BY message`).all()).results);
    expect(msgs).toEqual([{ message: "from a" }, { message: "from b" }]);
  });

  it("drops a losing write under the drop policy instead of redoing it", async () => {
    const blobs = new MemoryBlobStore();
    const a = new SqliteOnS3(blobs, migrations, tmp());
    const b = new SqliteOnS3(blobs, migrations, tmp());
    await a.run("main", "retry", async () => undefined);
    let attempts = 0;
    const out = await a.run("main", "drop", async (db) => {
      attempts++;
      await db.prepare(`INSERT INTO report_cache (name, computed_at, body) VALUES ('x', 't', '{}')`).run();
      await b.run("main", "retry", async (db2) => {
        await db2.prepare(`INSERT INTO events (ts, severity, kind, message) VALUES ('t', 'info', 'k', 'b')`).run();
      });
      return "result";
    });
    expect(out).toBe("result");
    expect(attempts).toBe(1);
  });

  it("gives up after the attempt limit", async () => {
    const blobs = new MemoryBlobStore();
    const store = new SqliteOnS3(blobs, migrations, tmp(), 2);
    await store.run("main", "retry", async () => undefined);
    const other = new SqliteOnS3(blobs, migrations, tmp());
    await expect(
      store.run("main", "retry", async (db) => {
        await db.prepare(`INSERT INTO events (ts, severity, kind, message) VALUES ('t', 'info', 'k', 'm')`).run();
        await other.run("main", "retry", async (d2) => {
          await d2.prepare(`INSERT INTO events (ts, severity, kind, message) VALUES ('t', 'info', 'k', 'o')`).run();
        });
      }),
    ).rejects.toBeInstanceOf(WriteConflict);
  });

  it("applies a new migration once, to the existing data", async () => {
    const blobs = new MemoryBlobStore();
    await new SqliteOnS3(blobs, migrations, tmp()).run("main", "retry", async (db) => {
      await db.prepare(`INSERT INTO events (ts, severity, kind, message) VALUES ('t', 'info', 'k', 'kept')`).run();
    });
    const next = [...migrations, { name: "9999_test.sql", sql: "ALTER TABLE events ADD COLUMN extra TEXT;" }];
    const store = new SqliteOnS3(blobs, next, tmp());
    const rows = await store.run("main", "retry", async (db) => (await db.prepare(`SELECT message, extra FROM events`).all()).results);
    expect(rows).toEqual([{ message: "kept", extra: null }]);
  });

  it("no migration after the ones that created them touches the telemetry tables", () => {
    // A migration that ALTERs a telemetry table would write BOTH files in one invocation, and the
    // store commits files one at a time (src/aws/store.ts, migrate()). If you need one, make the
    // telemetry change idempotent (CREATE ... IF NOT EXISTS, or a new table) and update this test.
    const allowed = new Set(["0001_init.sql", "0003_usage_metrics.sql"]);
    for (const m of migrations) {
      if (allowed.has(m.name)) continue;
      for (const t of TELEMETRY_TABLES) expect(m.sql, `${m.name} touches ${t}`).not.toMatch(new RegExp(`\\b${t}\\b`));
    }
  });
});

describe("Lambda handler", () => {
  it("refuses every request when the dashboard secrets are not set", async () => {
    const { app: a } = app(new MemoryBlobStore(), {});
    const res = await handle(a, http("GET", "/api/state", { auth: basic }));
    expect(res).toMatchObject({ statusCode: 503 });
  });

  it("rejects bad credentials before reading the database", async () => {
    const { app: a, blobs } = app();
    const res = await handle(a, http("GET", "/api/state", { auth: `Basic ${Buffer.from("u:wrong").toString("base64")}` }));
    expect(res).toMatchObject({ statusCode: 401 });
    expect(res && res.headers["www-authenticate"]).toContain("Basic");
    expect(blobs.objects.size).toBe(0);
    const tel = await handle(a, http("POST", "/api/telemetry", { auth: "Bearer nope", body: telemetry("h") }));
    expect(tel).toMatchObject({ statusCode: 401 });
    expect(blobs.objects.size).toBe(0);
  });

  it("stores telemetry and serves it in /api/state, like the Worker", async () => {
    const { app: a, blobs } = app();
    const post = await handle(a, http("POST", "/api/telemetry", { auth: "Bearer t", body: telemetry("ci-host-a") }));
    expect(post).toMatchObject({ statusCode: 204 });
    expect(blobs.objects.has(TELEMETRY_KEY)).toBe(true);
    const res = await handle(a, http("GET", "/api/state", { auth: basic }));
    expect(res).toMatchObject({ statusCode: 200 });
    const state = JSON.parse(res!.body);
    expect(state.runners).toEqual([]);
    expect(state.poll).toMatchObject({ last_ok: 1 });
    expect(state.metrics).toMatchObject({ "ci-host-a": { samples_24h: 1 } });
  });

  it("skips telemetry writes inside TELEMETRY_MIN_WRITE_SECONDS", async () => {
    const { app: a, blobs } = app(new MemoryBlobStore(), SECRETS, { TELEMETRY_MIN_WRITE_SECONDS: "60" });
    await handle(a, http("POST", "/api/telemetry", { auth: "Bearer t", body: telemetry("h", 10) }));
    const before = blobs.objects.get(TELEMETRY_KEY)!.etag;
    const second = await handle(a, http("POST", "/api/telemetry", { auth: "Bearer t", body: telemetry("h", 90) }));
    expect(second).toMatchObject({ statusCode: 204 });
    expect(blobs.objects.get(TELEMETRY_KEY)!.etag).toBe(before);
  });

  it("serves the pages", async () => {
    const { app: a } = app();
    const index = await handle(a, http("GET", "/", { auth: basic }));
    expect(index).toMatchObject({ statusCode: 200 });
    expect(index!.headers["content-type"]).toContain("text/html");
    const timing = await handle(a, http("GET", "/api/timing", { auth: basic }));
    expect(timing).toMatchObject({ statusCode: 200 });
    expect(JSON.parse(timing!.body)).toHaveProperty("windows");
  });

  it("runs the same job per tick as the Worker's cron, and backs up at 00:00Z", async () => {
    const { app: a, blobs } = app();
    // No GitHub credentials: the poll records its failure and rethrows, as on the Worker, and the
    // record is committed even though the job threw (D1 has no rollback across statements).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(handle(a, { source: "aws.events", "detail-type": "Scheduled Event", time: "2026-11-23T10:02:00Z" })).rejects.toThrow(
      "No GitHub credentials",
    );
    const state = await handle(a, http("GET", "/api/state", { auth: basic }));
    expect(JSON.parse(state!.body).poll).toMatchObject({ last_ok: 0 });
    expect(JSON.parse(state!.body).poll.last_error).toContain("No GitHub credentials");

    await expect(handle(a, { source: "aws.events", "detail-type": "Scheduled Event", time: "2026-11-24T00:00:00Z" })).rejects.toThrow(
      "No GitHub credentials",
    );
    expect(blobs.objects.has("backups/2026-11-24.db")).toBe(false); // the sync failed, so no backup
  });

  it("takes a daily backup after the 00:00Z history sync succeeds", async () => {
    const { app: a, blobs } = app(new MemoryBlobStore(), { ...SECRETS, GH_PAT: "test-token" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    // An org with no repositories: the sync runs end to end and records nothing.
    vi.stubGlobal("fetch", async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    try {
      await handle(a, { source: "aws.events", "detail-type": "Scheduled Event", time: "2026-11-24T00:00:00Z" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(blobs.objects.has("backups/2026-11-24.db")).toBe(true);
  });
});
