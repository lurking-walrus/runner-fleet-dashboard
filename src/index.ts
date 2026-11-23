import { requireBasicAuth, requireBearer } from "./auth";
import { FRONTEND_HTML } from "./frontend";
import { runPoll, syncJobHistory } from "./poller";
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

// The history sync runs on the 2-minute cron's ticks that land on a multiple of 10 minutes, in
// place of that tick's runner poll. It used to be its own "*/10" cron, but this account is on the
// Workers Free plan (5 cron triggers per ACCOUNT) and other Workers hold the other four: every
// deploy since that cron was added failed with "reached the Workers Free limit of 5 cron
// triggers", and the */10 schedule was never registered, so job_history (the per-pool usage line
// and job_failed events) stopped filling. One trigger, two jobs, still one job per invocation, so
// each keeps its own subrequest budget.
const HISTORY_SYNC_EVERY_MINUTES = 10;

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
        new Date().toISOString(),
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
    // Separate crons = separate invocations, so the history sync's GitHub calls don't eat into the
    // runner poll's per-invocation subrequest limit.
    const minute = new Date(controller.scheduledTime).getUTCMinutes();
    if (minute % HISTORY_SYNC_EVERY_MINUTES === 0) ctx.waitUntil(syncJobHistory(env));
    else ctx.waitUntil(runPoll(env));
  },
} satisfies ExportedHandler<Env>;
