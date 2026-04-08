# OpenClaw Gateway Watchdog

Keep your local OpenClaw gateway recoverable on macOS.

OpenClaw Gateway Watchdog is a small, production-minded `launchd` watchdog that probes `openclaw gateway status --json`, restarts or repairs the gateway when it goes unhealthy, and sends Feishu or Discord alerts when recovery begins, succeeds, or fails.

[中文文档](./README.zh-CN.md)

License: MIT

## Why It Exists

`launchd KeepAlive` can restart a crashed process, but it cannot tell the difference between:

- a healthy gateway
- a loaded-but-not-ready gateway
- a broken gateway that still has a process

This project adds health-check driven recovery on top of macOS `launchd`, without adding another daemon, container, or external monitoring stack.

## What It Does

- Probes `openclaw gateway status --json` on every tick instead of relying on PID checks.
- Treats `service.loaded=true`, `service.runtime.status="running"`, `rpc.ok=true`, and `health.healthy=true` as the healthy contract.
- Treats loaded-but-not-ready states as `neutral` so cold starts do not immediately trigger a restart.
- Applies cooldown protection so the gateway is not restarted in a tight loop.
- Uses `openclaw gateway restart` first, then falls back to `gateway install` plus `gateway start` when the service is not loaded.
- Sends Feishu and/or Discord webhook notifications for restart triggered, restart succeeded, and restart failed.

## Support Scope

This repository intentionally supports only:

- macOS
- `launchd`
- OpenClaw CLI
- Discord and Feishu webhooks

It is not a generic process supervisor and it is not a cross-platform watchdog.

## Prerequisites

- `openclaw`
- `jq`
- `curl`
- `launchctl`

## Quick Start

1. Create a private env file from the example:
   - `mkdir -p "$(dirname "${WATCHDOG_ENV_FILE:-$HOME/.openclaw/config/watchdog.env}")"`
   - `cp config.example.env "${WATCHDOG_ENV_FILE:-$HOME/.openclaw/config/watchdog.env}"`
2. Fill in webhook values and any optional overrides in that private env file.
3. Install the LaunchAgent:
   - `bash launchd/install-gateway-watchdog-launchagent.sh`
4. Verify the service is loaded:
   - `launchctl list | rg "ai\.openclaw\.gateway-watchdog"`
5. Verify live ticks in the watchdog log:
   - `tail -n 20 "${WATCHDOG_LOG_DIR:-$HOME/.openclaw/logs}/gateway-watchdog.log"`

## Example Notifications

```text
[WATCHDOG] Gateway unhealthy, restarting (failures=3 host=My-Mac)
[WATCHDOG] Restart succeeded (host=My-Mac retries=6)
[WATCHDOG] Restart failed: gateway install failed (host=My-Mac retries=6)
[WATCHDOG] Restart failed: gateway start failed (host=My-Mac retries=6)
[WATCHDOG] Restart failed: recovery timed out (host=My-Mac retries=6)
```

Restart failed notifications include `gateway install failed`, `gateway start failed`, or `recovery timed out` when the watchdog can determine the reason.

## How It Works

1. `launchd` invokes `gateway-watchdog.sh` as the stable wrapper entrypoint.
2. The wrapper sources `watchdog-core.sh` and calls `watchdog_main`.
3. The watchdog probes `openclaw gateway status --json` on every tick.
4. Consecutive failures are tracked in `gateway_watchdog_state.json`.
5. When the failure threshold is reached, the watchdog sends a restart-triggered notification, attempts recovery, then sends either a success or failure notification.

## Configuration

Configuration precedence is fixed as `process env > watchdog env file > defaults`.

Public path variables:

- `OPENCLAW_HOME`
- `WATCHDOG_STATE_DIR`
- `WATCHDOG_LOG_DIR`
- `WATCHDOG_ENV_FILE`

Runtime and behavior variables:

- `NOTIFIER`
- `FAIL_THRESHOLD`
- `COOLDOWN_SEC`
- `POST_RESTART_RETRIES`
- `POST_RESTART_SLEEP_SEC`
- `OPENCLAW_BIN`
- `NODE_BIN`
- `WATCHDOG_ENABLED`
- `WATCHDOG_DISABLE_FILE`
- `DISCORD_WATCHDOG_WEBHOOK_URL`
- `FEISHU_WATCHDOG_WEBHOOK_URL`

The watchdog env file is parsed through an allowlisted `key=value` reader. It does not `source` secret env files.

## Security Notes

1. Do not commit the private watchdog env file; only commit `config.example.env`.
2. Webhook URLs are secrets and should live in the private env file.
3. Notifier loading is whitelist-based and restricted to the controlled `notifiers/` directory.
4. Secret env files are parsed, not executed.

## Verification

```bash
bash -n gateway-watchdog.sh
bash -n watchdog-core.sh
bash -n config.sh
bash -n probe.sh
bash -n state.sh
bash -n notifiers/discord.sh
bash -n notifiers/feishu.sh
bash -n notifiers/composite.sh
bash -n launchd/install-gateway-watchdog-launchagent.sh
bash -n launchd/uninstall-gateway-watchdog-launchagent.sh
node --test tests/gateway-watchdog-feishu.test.mjs tests/gateway-watchdog-core.test.mjs
launchctl list | rg "ai\.openclaw\.gateway-watchdog"
tail -n 20 "${WATCHDOG_LOG_DIR:-$HOME/.openclaw/logs}/gateway-watchdog.log"
```

## FAQ

### Why use a separate `watchdog.env` instead of reusing the whole OpenClaw `.env`?

Because the watchdog only needs a small, explicit allowlisted subset of settings. Keeping a dedicated env file reduces coupling, limits secret exposure, and makes the public repository reusable.

### Why `launchd` instead of another always-on daemon?

Because v1 is intentionally a native macOS tool. `launchd` already exists, survives login sessions correctly, and is the right lifecycle owner for a user-level service on macOS.

### Can I use this for non-OpenClaw services?

Not without modification. The current probe and repair logic are intentionally built around `openclaw gateway status --json` and related OpenClaw CLI commands.

## Known Limitations

1. `NOTIFIER=composite` is synchronous and serial, so repeated notify failures can still cause tick drift.
2. Notifier loading remains source-based rather than subprocess-isolated.
3. This repository targets `macOS + launchd + OpenClaw CLI` only.

## Repository

Public GitHub repository: `https://github.com/realraelrr/openclaw-gateway-watchdog`
