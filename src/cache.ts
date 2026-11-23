/**
 * Memoises a computed JSON section in D1 (`report_cache`) for `ttlMs`.
 *
 * Why this exists: the account is on D1's FREE plan, which stops ALL queries for the rest of the UTC
 * day once 5M rows have been read (code 7500). That happened on 2026-11-23 by 15:49Z, which also
 * failed the deploy's migration step. An aggregation over job_history/job_steps reads tens of
 * thousands of rows, and a dashboard tab refreshing every 20 s would repeat it thousands of times a
 * day, so anything that scans more than a handful of rows goes through here.
 */
export async function cached<T>(db: D1Database, name: string, ttlMs: number, now: number, compute: () => Promise<T>): Promise<T> {
  const row = await db
    .prepare(`SELECT computed_at, body FROM report_cache WHERE name = ?`)
    .bind(name)
    .first<{ computed_at: string; body: string }>();
  if (row && now - Date.parse(row.computed_at) < ttlMs) return JSON.parse(row.body) as T;
  const fresh = await compute();
  await db
    .prepare(`INSERT OR REPLACE INTO report_cache (name, computed_at, body) VALUES (?, ?, ?)`)
    .bind(name, new Date(now).toISOString(), JSON.stringify(fresh))
    .run();
  return fresh;
}
