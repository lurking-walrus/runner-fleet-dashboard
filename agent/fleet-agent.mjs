#!/usr/bin/env node
// Zero-dependency telemetry agent for one physical runner host.
// Reports CPU/RAM/disk/uptime to the runner-fleet-dashboard Worker.
//
// Config via env vars (see .env.example):
//   DASHBOARD_URL       e.g. https://runner-fleet-dashboard.<account>.workers.dev. Comma-separate
//                            several dashboards (the Worker and the AWS deployment, issue #28) to
//                            report to each; one that is down does not stop the others.
//   TELEMETRY_TOKEN      bearer token, matches the Worker's TELEMETRY_TOKEN secret
//   HOST_ID               the runner pool this machine's readings belong to: the runner name with
//                            any trailing "-N" (and JIT "-<unix-ts>") stripped,
//                            e.g. runners "ci-host-a-linux[-2..-4]" -> HOST_ID=ci-host-a-linux.
//                            Comma-separate several pools that share this machine's resources,
//                            e.g. HOST_ID=mac-linux-arm64,mac-native-signing; the same reading is
//                            reported for each.
//   LOCATION               optional free-text label, e.g. "Build host A (Linux)"
//   INTERVAL_SECONDS       default 30; ignored in --once mode
//
// Usage:
//   node fleet-agent.mjs            # runs forever, posts every INTERVAL_SECONDS
//   node fleet-agent.mjs --once     # single reading then exit (for cron / Task Scheduler)

import os from "node:os";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const AGENT_VERSION = "0.3.0";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

const DASHBOARD_URLS = requireEnv("DASHBOARD_URL")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);
// A target that hangs must not hold up the next reading or the other targets.
const POST_TIMEOUT_MS = 10_000;
const TELEMETRY_TOKEN = requireEnv("TELEMETRY_TOKEN");
const HOST_IDS = requireEnv("HOST_ID")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const LOCATION = process.env.LOCATION ?? undefined;
const INTERVAL_MS = Number(process.env.INTERVAL_SECONDS ?? 30) * 1000;
const ONCE = process.argv.includes("--once");

function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

async function cpuPercent() {
  const a = cpuSnapshot();
  await new Promise((r) => setTimeout(r, 500));
  const b = cpuSnapshot();
  const idleDelta = b.idle - a.idle;
  const totalDelta = b.total - a.total;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta)));
}

// os.freemem() only counts strictly-idle pages. Both macOS and Linux use most
// "free" RAM for reclaimable disk cache, so that alone overstates usage by a
// lot (macOS especially -- it routinely shows <5% truly free while the box is
// fine). Compute actual available memory the way each OS's own tools do.
function memUsedMb(totalMem) {
  try {
    if (process.platform === "darwin") {
      const res = spawnSync("vm_stat", [], { encoding: "utf8" });
      const pageSize = Number(res.stdout.match(/page size of (\d+) bytes/)[1]);
      const pages = (label) => Number(res.stdout.match(new RegExp(`${label}:\\s+(\\d+)\\.`))[1]);
      const available =
        (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable")) *
        pageSize;
      return (totalMem - available) / 1e6;
    }
    if (process.platform === "linux") {
      const meminfo = spawnSync("cat", ["/proc/meminfo"], { encoding: "utf8" }).stdout;
      const totalKb = Number(meminfo.match(/MemTotal:\s+(\d+)/)[1]);
      const availableKb = Number(meminfo.match(/MemAvailable:\s+(\d+)/)[1]);
      return (totalKb - availableKb) / 1e3;
    }
  } catch (err) {
    console.error("platform-specific memory check failed, falling back to os.freemem():", err.message);
  }
  return (totalMem - os.freemem()) / 1e6;
}

function diskUsageGb() {
  try {
    if (process.platform === "win32") {
      const res = spawnSync(
        "powershell",
        ["-NoProfile", "-Command", "Get-PSDrive -Name C | Select-Object Used,Free | ConvertTo-Json"],
        { encoding: "utf8" },
      );
      const parsed = JSON.parse(res.stdout);
      const usedGb = parsed.Used / 1e9;
      const totalGb = (parsed.Used + parsed.Free) / 1e9;
      return { usedGb, totalGb };
    }
    // On macOS 10.15+ "/" is the sealed, read-only system volume (~10-15 GB used no matter how
    // full the disk is). User data, Docker images and runner work dirs live on the Data volume,
    // which shares the same APFS container, so that's the one that fills up.
    const mount = process.platform === "darwin" && existsSync("/System/Volumes/Data") ? "/System/Volumes/Data" : "/";
    const res = spawnSync("df", ["-Pk", mount], { encoding: "utf8" });
    const line = res.stdout.trim().split("\n")[1];
    const parts = line.trim().split(/\s+/);
    const usedKb = Number(parts[2]);
    const totalKb = Number(parts[1]);
    return { usedGb: usedKb / 1e6, totalGb: totalKb / 1e6 };
  } catch (err) {
    console.error("disk usage check failed:", err.message);
    return { usedGb: 0, totalGb: 0 };
  }
}

async function readTelemetry() {
  const disk = diskUsageGb();
  const totalMem = os.totalmem();
  return {
    location: LOCATION,
    cpu_pct: await cpuPercent(),
    cpu_count: os.cpus().length,
    load_avg_1m: os.loadavg()[0] ?? 0,
    mem_used_mb: memUsedMb(totalMem),
    mem_total_mb: totalMem / 1e6,
    disk_used_gb: disk.usedGb,
    disk_total_gb: disk.totalGb,
    uptime_s: os.uptime(),
    agent_version: AGENT_VERSION,
  };
}

async function postOne(url, host, reading) {
  try {
    const res = await fetch(`${url}/api/telemetry`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TELEMETRY_TOKEN}`,
      },
      body: JSON.stringify({ host, ...reading }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (res.ok) return true;
    console.error(`telemetry post for ${host} to ${url} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  } catch (err) {
    console.error(`telemetry post for ${host} to ${url} failed: ${err.message} ${err.cause?.code ?? ""}`);
  }
  return false;
}

async function reportOnce() {
  const reading = await readTelemetry();
  const results = await Promise.all(HOST_IDS.flatMap((host) => DASHBOARD_URLS.map((url) => postOne(url, host, reading))));
  if (results.every(Boolean)) {
    console.log(`reported ${HOST_IDS.join(",")}: cpu ${reading.cpu_pct.toFixed(0)}% mem ${(reading.mem_used_mb / reading.mem_total_mb * 100).toFixed(0)}% disk ${(reading.disk_used_gb / reading.disk_total_gb * 100).toFixed(0)}%`);
  } else {
    // --once mode: a non-zero exit so the scheduler's status shows it.
    process.exitCode = 1;
  }
}

if (ONCE) {
  // One line on failure (e.g. the network is down), not a crash trace; the scheduler retries.
  await reportOnce().catch((err) => {
    console.error("report failed:", err.message, err.cause?.code ?? "");
    process.exitCode = 1;
  });
} else {
  console.log(`fleet-agent starting: hosts=${HOST_IDS.join(",")} interval=${INTERVAL_MS / 1000}s targets=${DASHBOARD_URLS.join(",")}`);
  for (;;) {
    await reportOnce().catch((err) => console.error("report failed:", err.message));
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}
