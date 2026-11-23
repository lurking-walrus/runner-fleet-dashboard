import { requireBasicAuth, requireBearer } from "./auth";
import { FRONTEND_HTML } from "./frontend";
import { runPoll, snapshotQueue, syncJobHistory } from "./poller";
import { runScheduledJob, scheduledJobFor } from "./schedule";
import { buildState } from "./state";
import { buildTimingReport } from "./timing-report";
import { TIMING_HTML } from "./timing-page";
import { upsertTelemetry } from "./db";
import type { Env } from "./types";

interface TelemetryPayload {
  host: string;
  location?: string;
  cpu_pct: number;
  cpu_count: number;
  load_avg_1m: number;
  mem_used_mb: number;
  mem_total_mb: number;
  disk_used_gb: number;
  disk_total_gb: number;
  uptime_s: number;
  agent_version: string;
}

function isTelemetryPayload(v: unknown): v is TelemetryPayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.host === "string" &&
    typeof p.cpu_pct === "number" &&
    typeof p.cpu_count === "number" &&
    typeof p.mem_used_mb === "number" &&
    typeof p.mem_total_mb === "number"
  );
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/telemetry" && req.method === "POST") {
      const denied = await requireBearer(req, env.TELEMETRY_TOKEN);
      if (denied) return denied;
      let payload: unknown;
      try {
        payload = await req.json();
      } catch {
        return new Response("invalid json", { status: 400 });
      }
      if (!isTelemetryPayload(payload)) return new Response("invalid payload", { status: 400 });
      const now = new Date().toISOString();
      if (await telemetryIsFresh(env, payload.host, now)) return new Response(null, { status: 204 });
      await upsertTelemetry(
        env.DB,
        {
          host: payload.host,
          location: payload.location ?? null,
          cpuPct: payload.cpu_pct,
          cpuCount: payload.cpu_count,
          loadAvg1m: payload.load_avg_1m ?? 0,
          memUsedMb: payload.mem_used_mb,
          memTotalMb: payload.mem_total_mb,
          diskUsedGb: payload.disk_used_gb ?? 0,
          diskTotalGb: payload.disk_total_gb ?? 0,
          uptimeS: payload.uptime_s ?? 0,
          agentVersion: payload.agent_version ?? "unknown",
        },
        now,
      );
      return new Response(null, { status: 204 });
    }

    // Everything else is the private dashboard — gate it.
    const denied = await requireBasicAuth(req, env.DASHBOARD_USER, env.DASHBOARD_PASSWORD);
    if (denied) return denied;

    if (url.pathname === "/api/state") {
      const state = await buildState(env);
      return Response.json(state);
    }

    if (url.pathname === "/api/timing") {
      return Response.json(await buildTimingReport(env.DB));
    }

    if (url.pathname === "/timing") {
      return new Response(TIMING_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/api/poll-now" && req.method === "POST") {
      await runPoll(env);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/api/queue-now" && req.method === "POST") {
      await snapshotQueue(env);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/api/sync-history-now" && req.method === "POST") {
      await syncJobHistory(env);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/") {
      return new Response(FRONTEND_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledJob(env, scheduledJobFor(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;

/**
 * TELEMETRY_MIN_WRITE_SECONDS (unset on Cloudflare, so a no-op there): accept a host's report but skip
 * the write when its stored snapshot is younger than this. On AWS every write is an S3 PUT, the
 * largest cost line (issue #28); 60 s keeps the live numbers within a minute and changes nothing
 * the stale-telemetry check (10 min) or the 5-minute samples can see.
 */
async function telemetryIsFresh(env: Env, host: string, now: string): Promise<boolean> {
  const floorS = Number(env.TELEMETRY_MIN_WRITE_SECONDS) || 0;
  if (floorS <= 0) return false;
  const row = await env.DB.prepare(`SELECT updated_at FROM telemetry WHERE host = ?`).bind(host).first<{ updated_at: string }>();
  return !!row && Date.parse(now) - Date.parse(row.updated_at) < floorS * 1000;
}
