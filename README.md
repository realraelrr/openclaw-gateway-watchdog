# OpenClaw Gateway Watchdog

Keep your local OpenClaw gateway recoverable on macOS.

OpenClaw Gateway Watchdog is a small `launchd` watchdog for one thing: checking `openclaw gateway status --json`, recovering the OpenClaw gateway when that health contract fails, and sending clear Feishu or Discord alerts. Sends Feishu and/or Discord webhook notifications when restart recovery starts, succeeds, or fails.

[中文文档](./README.zh-CN.md)

License: MIT

## Scope

Healthy means all of these are true in `openclaw gateway status --json`:

- `service.loaded == true`
- `service.runtime.status == "running"`
- `rpc.ok == true`
- `health.healthy == true`

Loaded-but-not-ready gateway states are treated as `neutral` so cold starts do not immediately trigger recovery. This watchdog manages only the local OpenClaw gateway through the OpenClaw CLI. It does not manage Hermes, cloudflared, proxies, DNS, OpenClaw upgrades, or remote chat commands.

Recovery uses `openclaw gateway restart`. If the service is not loaded or not installed, it falls back to `openclaw gateway install` and `openclaw gateway start`.

## Manual Restart

Trigger a local restart without waiting for passive probing:

```bash
bash gateway-watchdog.sh restart gateway
```

This is local CLI control only. There is no webhook receiver, chat command, or remote control endpoint.

## Install

Prerequisites: macOS, `openclaw`, `jq`, `curl`, `launchctl`, and a user-level OpenClaw gateway.

```bash
mkdir -p "$(dirname "${WATCHDOG_ENV_FILE:-$HOME/.openclaw/config/watchdog.env}")"
cp config.example.env "${WATCHDOG_ENV_FILE:-$HOME/.openclaw/config/watchdog.env}"
bash launchd/install-gateway-watchdog-launchagent.sh
launchctl list | rg "ai\.openclaw\.gateway-watchdog"
tail -n 20 "${WATCHDOG_LOG_DIR:-$HOME/.openclaw/logs}/gateway-watchdog.log"
```

The installer copies the runtime scripts to `${OPENCLAW_HOME:-$HOME/.openclaw}/watchdog/runtime/current` so `launchd` does not depend on a cloud-synced repository path.

## Configuration

Precedence: `process env > WATCHDOG_ENV_FILE > defaults`.

Common options:

- `WATCHDOG_DISPLAY_NAME`: alert title, useful when Hermes and OpenClaw both have watchdogs.
- `NOTIFIER`: `discord`, `feishu`, or `composite`.
- `FAIL_THRESHOLD`, `COOLDOWN_SEC`, `POST_RESTART_RETRIES`, `POST_RESTART_SLEEP_SEC`.
- `OPENCLAW_BIN`, `NODE_BIN`, `WATCHDOG_ENABLED`.
- `DISCORD_WATCHDOG_WEBHOOK_URL`, `FEISHU_WATCHDOG_WEBHOOK_URL`.

Path options include `OPENCLAW_HOME`, `WATCHDOG_STATE_DIR`, `WATCHDOG_LOG_DIR`, `WATCHDOG_ENV_FILE`, and `WATCHDOG_DISABLE_FILE`.

Webhook URLs are secrets and should live in the private env file. The env file is parsed through an allowlisted `key=value` reader; it is not sourced as shell code.

## Alerts

Alerts are multi-line user-facing messages with:

- watchdog display name and event status
- host and source (`passive watchdog` or `local CLI`)
- failing component and raw reason
- action taken
- final raw fields for troubleshooting

Example:

```text
[OpenClaw Gateway Watchdog] 自动重启已触发

主机: my-mac
来源: passive watchdog
故障环节: OpenClaw Gateway / 健康状态
原因: gateway_status_unhealthy - openclaw gateway status --json 未满足健康合同
动作: 重启 OpenClaw gateway
连续失败: 3
raw: event=restart_triggered host=my-mac failures=3 reason=gateway_status_unhealthy action=restart_gateway
```

Failure summaries include `gateway install failed`, `gateway start failed`, and `recovery timed out` when those failure points are known.

## Verify

```bash
bash -n gateway-watchdog.sh watchdog-core.sh config.sh probe.sh state.sh \
  notifiers/discord.sh notifiers/feishu.sh notifiers/composite.sh \
  launchd/install-gateway-watchdog-launchagent.sh \
  launchd/uninstall-gateway-watchdog-launchagent.sh
node --test tests/gateway-watchdog-core.test.mjs tests/gateway-watchdog-feishu.test.mjs
```

## Limits

- `NOTIFIER=composite` sends synchronously and serially.
- Probing is a local OpenClaw gateway contract check, not an external end-to-end client test.
- This repository intentionally targets `macOS + launchd + OpenClaw CLI`.
