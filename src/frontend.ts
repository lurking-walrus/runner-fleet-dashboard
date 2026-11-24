import { BRAND_CSS, FAVICON_LINK, brandTitle } from "./brand";

export const FRONTEND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Runner Fleet</title>
${FAVICON_LINK}
<style>
  :root {
    color-scheme: light dark;
    --bg: #0b0e14; --panel: #12151d; --border: #232838; --text: #e6e9f0; --muted: #8a92a6;
    --green: #3ecf8e; --amber: #e8b339; --red: #e5534b; --blue: #5b8def;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg: #f5f6f8; --panel: #ffffff; --border: #e2e5ec; --text: #1a1d29; --muted: #5c6270; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 24px 16px 64px; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 8px; }
  h1 { font-size: 20px; margin: 0; }
  ${BRAND_CSS}
  .status-line { color: var(--muted); font-size: 12px; }
  .status-line.stale { color: var(--red); }
  .pool { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .pool-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
  .pool-name { font-weight: 600; font-size: 15px; }
  .pool-location { color: var(--muted); font-size: 12px; }
  .meters { display: flex; gap: 16px; flex-wrap: wrap; }
  .meter { min-width: 110px; }
  .meter-label { font-size: 11px; color: var(--muted); display: flex; justify-content: space-between; }
  .meter-bar { height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; margin-top: 3px; }
  .meter-fill { height: 100%; border-radius: 3px; background: var(--blue); }
  .meter-fill.warn { background: var(--amber); }
  .meter-fill.crit { background: var(--red); }
  .runner-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--border); flex-wrap: wrap; }
  .runner-row:first-of-type { border-top: none; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot.online { background: var(--green); }
  .dot.offline { background: var(--red); }
  .runner-name { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12.5px; }
  .pill { font-size: 10.5px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .pill.busy { color: var(--blue); border-color: var(--blue); }
  .job-info { flex: 1; min-width: 200px; font-size: 12.5px; color: var(--muted); }
  .job-info a { color: var(--blue); text-decoration: none; }
  .job-info a:hover { text-decoration: underline; }
  .last-job { font-size: 11.5px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .last-job a { color: inherit; }
  .last-job.idle-slot { color: var(--amber); }
  .empty { color: var(--muted); font-size: 12.5px; }
  .feed { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .feed h2 { font-size: 14px; margin: 0 0 12px; }
  .event { display: flex; gap: 10px; padding: 6px 0; border-top: 1px solid var(--border); font-size: 12.5px; }
  .event:first-of-type { border-top: none; }
  .event-sev { width: 6px; border-radius: 3px; flex-shrink: 0; }
  .event-sev.info { background: var(--blue); }
  .event-sev.warning { background: var(--amber); }
  .event-sev.error { background: var(--red); }
  .event-ts { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${brandTitle("Runner Fleet")}</h1>
    <div><a href="/timing" style="color:var(--blue);font-size:12px">Timings</a> · <span id="statusLine" class="status-line">loading…</span> · <form method="post" action="/logout" style="display:inline"><button type="submit" style="background:none;border:0;padding:0;color:var(--blue);font:inherit;font-size:12px;cursor:pointer">Sign out</button></form></div>
  </header>
  <div id="queue" class="pool"></div>
  <div id="pools"></div>
  <div class="feed">
    <h2>Recent activity &amp; issues</h2>
    <div id="events" class="empty">loading…</div>
  </div>
</div>
<script>
// Optional fallback labels for pools, matched against a runner's derived pool
// name. Prefer setting LOCATION in each host's agent .env instead: that value
// arrives as telemetry.location and takes precedence below, which keeps real
// host names out of this (public) repo. Anything unlabelled renders as its raw
// pool name, so this map is cosmetic and may stay empty.
const POOL_LOCATIONS = {
  // "ci-host-a-linux": "Build host A — Linux fleet",
};

function fmtBytes(mb) {
  if (mb == null) return "—";
  return mb > 1024 ? (mb / 1024).toFixed(1) + " GB" : Math.round(mb) + " MB";
}
function fmtAge(iso) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.round(s) + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  return Math.round(s / 3600) + "h ago";
}
function meterClass(pct) {
  if (pct >= 90) return "crit";
  if (pct >= 75) return "warn";
  return "";
}
function meter(label, pct, sub) {
  const cls = pct == null ? "" : meterClass(pct);
  return \`<div class="meter">
    <div class="meter-label"><span>\${label}</span><span>\${pct == null ? "—" : Math.round(pct) + "%"}</span></div>
    <div class="meter-bar"><div class="meter-fill \${cls}" style="width:\${pct == null ? 0 : pct}%"></div></div>
    \${sub ? \`<div class="meter-label">\${sub}</div>\` : ""}
  </div>\`;
}

function renderRunner(r) {
  const job = r.current_job;
  // "busy" is GitHub's own flag. A busy runner whose job the poller could not match (or has not
  // matched yet) must not read "idle" — that contradiction is exactly what the pill next to it
  // used to show.
  let jobHtml = r.busy
    ? '<span class="empty">running a job (not identified yet)</span>'
    : r.status === "online"
      ? '<span class="empty">idle</span>'
      : '<span class="empty">—</span>';
  if (job) {
    const started = fmtAge(job.job_started_at);
    const prLink = job.pr_url ? \` · <a href="\${job.pr_url}" target="_blank" rel="noopener">PR #\${job.pr_number}</a>\` : "";
    jobHtml = \`<a href="\${job.run_url}" target="_blank" rel="noopener">\${job.workflow_name} › \${job.job_name}</a>
      on <strong>\${job.repo}</strong>\${prLink} · started \${started}\`;
  }
  return \`<div class="runner-row">
    <span class="dot \${r.status}"></span>
    <span class="runner-name">\${r.name}</span>
    <span class="pill">\${r.os}</span>
    <span class="pill \${r.busy ? "busy" : ""}">\${r.status}\${r.busy ? " · busy" : ""}</span>
    <span class="job-info">\${jobHtml}</span>
    \${renderLastJob(r)}
  </div>\`;
}

// The slot's last finished job (from GitHub's completed runs, synced every 10 minutes) and how many
// jobs it ran, so an unused slot stands out. Ephemeral runners get a new name per job; the slot is
// the name without that suffix.
function renderLastJob(r) {
  const l = r.last_job;
  if (!l) return '<span class="last-job idle-slot" title="slot ' + esc(r.slot) + '">no job in 7d</span>';
  const ageS = (Date.now() - new Date(l.last_job_at).getTime()) / 1000;
  const cls = ageS > 6 * 3600 ? "last-job idle-slot" : "last-job";
  const title = "slot " + r.slot + " · last: " + l.workflow_name + " › " + l.job_name + " on " + l.repo + (l.conclusion ? " (" + l.conclusion + ")" : "");
  return '<span class="' + cls + '" title="' + esc(title) + '">last job <a href="' + esc(l.run_url) + '" target="_blank" rel="noopener">' + fmtAge(l.last_job_at) + "</a> · " + l.jobs_24h + " in 24h · " + l.jobs_7d + " in 7d</span>";
}

function fmtDur(s) {
  if (!s) return "0m";
  return s >= 3600 ? (s / 3600).toFixed(1) + "h" : Math.round(s / 60) + "m";
}
function renderMetrics(m) {
  if (!m) return '<div class="pool-location">usage: no finished jobs recorded yet</div>';
  const failed = m.failed_7d ? \` (\${m.failed_7d} failed)\` : "";
  const cpu = m.cpu_avg_24h != null ? \` · CPU avg \${Math.round(m.cpu_avg_24h)}% / peak \${Math.round(m.cpu_peak_24h)}% (24h)\` : "";
  return \`<div class="pool-location">usage: \${m.jobs_24h || 0} jobs / \${fmtDur(m.busy_s_24h)} busy (24h) · \${m.jobs_7d || 0} jobs / \${fmtDur(m.busy_s_7d)} busy (7d)\${failed} · last job \${fmtAge(m.last_job_at)}\${cpu}</div>\`;
}

function renderPool(poolName, runners, metrics) {
  const telemetry = runners.find((r) => r.telemetry)?.telemetry;
  const location = telemetry?.location || POOL_LOCATIONS[poolName] || poolName;
  const meters = telemetry
    ? \`<div class="meters">
        \${meter("CPU", telemetry.cpu_pct, telemetry.load_avg_1m != null ? "load " + telemetry.load_avg_1m.toFixed(2) : "")}
        \${meter("Memory", telemetry.mem_total_mb ? (telemetry.mem_used_mb / telemetry.mem_total_mb) * 100 : null, fmtBytes(telemetry.mem_used_mb) + " / " + fmtBytes(telemetry.mem_total_mb))}
        \${meter("Disk", telemetry.disk_total_gb ? (telemetry.disk_used_gb / telemetry.disk_total_gb) * 100 : null, telemetry.disk_used_gb != null ? telemetry.disk_used_gb.toFixed(0) + " / " + telemetry.disk_total_gb.toFixed(0) + " GB" : "")}
      </div>
      <div class="pool-location">telemetry \${fmtAge(telemetry.updated_at)}</div>\`
    : '<div class="pool-location">no telemetry agent reporting for this host</div>';

  return \`<div class="pool">
    <div class="pool-head">
      <div><div class="pool-name">\${location}</div></div>
      \${meters}
    </div>
    \${renderMetrics(metrics)}
    \${runners.map(renderRunner).join("")}
  </div>\`;
}

function fmtWait(s) {
  if (s < 90) return Math.round(s) + "s";
  if (s < 5400) return Math.round(s / 60) + " min";
  return (s / 3600).toFixed(1) + " h";
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function renderQueue(q) {
  if (!q) return '<div class="pool-name">Waiting for a runner</div><div class="pool-location">no snapshot yet (taken every 10 minutes)</div>';
  const ageS = (Date.now() - new Date(q.taken_at).getTime()) / 1000;
  const stale = ageS > 25 * 60;
  const head = q.waiting === 0
    ? "nothing waiting"
    : q.waiting + (q.partial ? "+" : "") + " job" + (q.waiting === 1 ? "" : "s") + " waiting · oldest " + fmtWait(q.oldest_s);
  const note = [
    "as of " + fmtAge(q.taken_at) + (stale ? " (STALE: the snapshot tick has not run)" : ""),
    q.partial ? "partial: GitHub-call budget ran out, so the real count is at least this" : "",
    q.repos_skipped ? q.repos_skipped + " repos not read" : "",
    q.ghost_runs ? q.ghost_runs + " run(s) queued over 3 days ignored" : "",
  ].filter(Boolean).join(" · ");
  const labels = q.by_labels.map(function (l) {
    return '<span class="pill">' + esc(l.labels) + " · " + l.n + " · oldest " + fmtWait(l.oldest_s) + "</span>";
  }).join(" ");
  const oldest = q.oldest.map(function (j) {
    return '<div class="runner-row"><span class="runner-name">' + fmtWait(j.waiting_s) + '</span><span class="job-info"><a href="' + esc(j.url) + '" target="_blank" rel="noopener">' + esc(j.workflow) + " › " + esc(j.job) + "</a> on <strong>" + esc(j.repo) + "</strong> · " + esc(j.labels) + "</span></div>";
  }).join("");
  return '<div class="pool-head"><div class="pool-name">Waiting for a runner: ' + head + '</div></div><div class="pool-location">' + esc(note) + "</div>" + (labels ? "<div style='margin:8px 0'>" + labels + "</div>" : "") + oldest;
}

function renderEvent(e) {
  return \`<div class="event">
    <span class="event-sev \${e.severity}"></span>
    <span class="event-ts">\${fmtAge(e.ts)}</span>
    <span>\${e.message}\${e.repo ? \` <span class="empty">(\${e.repo})</span>\` : ""}</span>
  </div>\`;
}

async function refresh() {
  const res = await fetch("/api/state");
  if (res.status === 401 && res.headers.get("content-type")?.includes("json")) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname);
    return;
  }
  if (!res.ok) {
    document.getElementById("statusLine").textContent = "failed to load (" + res.status + ")";
    document.getElementById("statusLine").classList.add("stale");
    return;
  }
  const data = await res.json();

  document.getElementById("queue").innerHTML = renderQueue(data.queue);

  const pools = {};
  for (const r of data.runners) {
    (pools[r.pool] ??= []).push(r);
  }
  const poolsEl = document.getElementById("pools");
  poolsEl.innerHTML = Object.keys(pools).sort().map((p) => renderPool(p, pools[p], data.metrics && data.metrics[p])).join("") || '<div class="empty">no runners seen yet</div>';

  const eventsEl = document.getElementById("events");
  eventsEl.innerHTML = data.events.length ? data.events.map(renderEvent).join("") : '<div class="empty">nothing to report</div>';

  const pollOk = data.poll && data.poll.last_ok;
  const statusEl = document.getElementById("statusLine");
  statusEl.textContent = "poller " + (pollOk ? "healthy" : "FAILING") + " · last run " + fmtAge(data.poll && data.poll.last_run_at) + " · page refreshed " + new Date().toLocaleTimeString();
  statusEl.classList.toggle("stale", !pollOk);
}

refresh();
// A tab left open in the background must not poll: every poll reads D1 rows, and the free plan
// stops all queries for the day at 5M reads. Refresh once when the tab comes back.
setInterval(function () { if (!document.hidden) refresh(); }, 20000);
document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
</script>
</body>
</html>`;
