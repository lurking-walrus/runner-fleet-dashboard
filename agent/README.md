# fleet-agent

Zero-dependency Node script that reports one physical host's CPU/RAM/disk/uptime
to the dashboard. Run one instance per **physical machine**, not per runner —
several runner processes on the same box (e.g. the four `ci-host-a-linux*`
runners) share one host and therefore one agent.

`HOST_ID` must equal the runner pool name — the runner name with any trailing `-N`
slot and, for ephemeral/JIT runners, the `-<unix-ts>` suffix stripped. That's how
the dashboard groups a runner fleet back to the resources it runs on:

| Runners | HOST_ID |
|---|---|
| `ci-host-a-linux`, `-2`, `-3`, `-4` | `ci-host-a-linux` |
| `ci-host-b-arm64-1-1791294671`, `-2-1791294702` (ephemeral) | `ci-host-b-arm64` |

A mismatch fails silently: the agent posts fine, but the dashboard shows "no
telemetry agent reporting" for the pool and raises `stale_telemetry`. When a
fleet is re-registered under new names, update `HOST_ID` too.

### Several pools on one machine

If two pools share the same resources (e.g. container runners and a native
runner on one Mac), list both: `HOST_ID=ci-host-b-arm64,ci-host-b-signing`.
The agent takes one reading and reports it under each pool.

If a pool runs inside a resource-capped VM (WSL2 with a `.wslconfig` memory /
`processors` cap, or a Docker Desktop VM), report what its runners can actually
use: run the agent *inside* the VM for that pool, and a second agent on the
host for any pool that runs natively there. For example, on a Windows PC with
ephemeral WSL runners and a native Windows runner, run one agent in WSL with
`HOST_ID=<wsl pool>` and one on Windows with `HOST_ID=<windows pool>`.

On macOS the agent reads disk usage from `/System/Volumes/Data`, not `/`
(which is the read-only system volume, ~10–15 GB used no matter how full the
disk is).

## Config

Copy `.env.example` to `.env` (or export the vars however your platform prefers)
and fill in:

- `DASHBOARD_URL` — the deployed Worker URL
- `TELEMETRY_TOKEN` — same value as the Worker's `TELEMETRY_TOKEN` secret
- `HOST_ID` — see table above
- `LOCATION` — optional, e.g. `"Build host A (Linux)"`

## Run it

```bash
node fleet-agent.mjs           # daemon, reports every 30s
node fleet-agent.mjs --once    # single reading, for cron / Task Scheduler
```

### Linux / WSL — systemd user timer (recommended over a long-running daemon)

```ini
# ~/.config/systemd/user/fleet-agent.service
[Unit]
Description=fleet-agent telemetry report

[Service]
Type=oneshot
EnvironmentFile=%h/fleet-agent/.env
ExecStart=/usr/bin/node %h/fleet-agent/fleet-agent.mjs --once
```

```ini
# ~/.config/systemd/user/fleet-agent.timer
[Unit]
Description=Run fleet-agent every 30s

[Timer]
OnBootSec=10
OnUnitActiveSec=30s

[Install]
WantedBy=timers.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now fleet-agent.timer
```

### macOS — launchd

```xml
<!-- ~/Library/LaunchAgents/com.example.fleet-agent.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.fleet-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/opt/fleet-agent/fleet-agent.mjs</string>
    <string>--once</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DASHBOARD_URL</key><string>https://runner-fleet-dashboard.YOUR-SUBDOMAIN.workers.dev</string>
    <key>TELEMETRY_TOKEN</key><string>REPLACE_ME</string>
    <key>HOST_ID</key><string>ci-host-b-arm64</string>
  </dict>
  <key>StartInterval</key><integer>30</integer>
  <key>StandardErrorPath</key><string>/tmp/fleet-agent.err.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.example.fleet-agent.plist
```

### Windows — Task Scheduler

```powershell
$action = New-ScheduledTaskAction -Execute "node.exe" -Argument "C:\fleet-agent\fleet-agent.mjs --once" -WorkingDirectory "C:\fleet-agent"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Seconds 30) -RepetitionDuration ([TimeSpan]::MaxValue)
Register-ScheduledTask -TaskName "fleet-agent" -Action $action -Trigger $trigger
```

Set `DASHBOARD_URL`, `TELEMETRY_TOKEN`, `HOST_ID` as system environment
variables first (`setx` or System Properties → Environment Variables) so the
scheduled task inherits them.
