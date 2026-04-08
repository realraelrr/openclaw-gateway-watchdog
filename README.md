# OpenClaw Gateway Watchdog

macOS `launchd` watchdog for OpenClaw gateway health checks.

License: MIT

## Support Scope

- macOS
- `launchd`
- OpenClaw CLI
- Discord and Feishu webhooks

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

## Behavior

1. `launchd` invokes `gateway-watchdog.sh` as the stable wrapper entrypoint.
2. The wrapper sources `watchdog-core.sh` and calls `watchdog_main`.
3. The watchdog probes `openclaw gateway status --json` on every tick.
4. Healthy means:
   - `service.loaded=true`
   - `service.runtime.status="running"`
   - `rpc.ok=true`
   - `health.healthy=true`
5. Loaded-but-not-ready states are treated as `neutral`.
6. Consecutive failures are tracked in `gateway_watchdog_state.json`.
7. Gateway restarts are cooldown-protected.
8. Send Discord and/or Feishu webhook notifications only for:
   - restart triggered
   - restart succeeded
   - restart failed
   - restart failed notifications include `gateway install failed`, `gateway start failed`, or `recovery timed out` when the watchdog can determine the reason

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

## Known Limitations

1. `NOTIFIER=composite` is synchronous and serial, so repeated notify failures can still cause tick drift.
2. Notifier loading remains source-based rather than subprocess-isolated.
3. This repository targets `macOS + launchd + OpenClaw CLI` only.

## Repository

Public GitHub repository: `https://github.com/realraelrr/openclaw-gateway-watchdog`
