# Gateway Watchdog

`gateway-watchdog.sh` is the stable launchd entrypoint for OpenClaw gateway health checks.
`watchdog-core.sh` now holds the implementation details behind that entrypoint.

Configuration precedence is fixed as `process env > watchdog env file > defaults`.
The non-secret example file is `config.example.env`; the default env file path is `$HOME/.openclaw/config/watchdog.env`.
The watchdog env file is parsed through an allowlisted `key=value` reader; the script does not `source` secret env files.

Execution model:

1. launchd keeps invoking `gateway-watchdog.sh` as the stable wrapper entrypoint.
2. The wrapper resolves `SCRIPT_DIR`, sources `watchdog-core.sh`, and calls `watchdog_main`.
3. `watchdog-core.sh` loads config, probe/state/notifier modules, and owns the runtime flow.

Current behavior:

1. Probe every invocation via `openclaw gateway status --json`.
2. Treat only `service.loaded=true`, `service.runtime.status="running"`, `rpc.ok=true`, and `health.healthy=true` as healthy; loaded-but-not-ready states are `neutral`.
3. Track consecutive failures in `.state/runtime/gateway_watchdog_state.json`.
4. Use a single lock directory and private runtime temp directory under `.state/runtime/`.
5. Restart gateway when failures reach threshold (`3`) with cooldown protection (`300s`).
6. Send Discord and/or Feishu webhook notifications only for:
   - restart triggered
   - restart succeeded/failed
   - delivery is validated by HTTP status (non-2xx is logged as `notify_failed`)
7. Write structured logs to `logs/gateway-watchdog.log`.

Trade-off:

1. `NOTIFIER=composite` stays synchronous and serial in this revision.
2. Each provider call is capped at `4s` (`--connect-timeout 2 --max-time 4`), but repeated notify failures can still eat into the `StartInterval=30` budget and cause tick drift.
3. This is an explicit first-phase trade-off; async notification is a follow-up task, not part of the current rollout.

Environment variables:

1. `DISCORD_WATCHDOG_WEBHOOK_URL`: Incoming webhook URL for watchdog alerts.
2. `FEISHU_WATCHDOG_WEBHOOK_URL`: Feishu custom bot webhook URL for watchdog alerts.
3. `NOTIFIER` (optional): Current notifier selector. Defaults to `composite`.
4. `WATCHDOG_ENV_FILE` (optional): Path to the watchdog env file parsed with allowlisted keys only.
5. `FAIL_THRESHOLD` (optional): Consecutive failure threshold before restart.
6. `COOLDOWN_SEC` (optional): Cooldown window after restart.
7. `POST_RESTART_RETRIES` (optional): Post-restart probe attempts.
8. `POST_RESTART_SLEEP_SEC` (optional): Sleep interval between post-restart probes.
9. `PROBE_CONFIRM_SLEEP_SEC` (optional): Retry delay (seconds) for transient loaded-state recheck.
10. `OPENCLAW_BIN` (optional): Absolute path to `openclaw` CLI binary. If unset, script auto-discovers from PATH and common install locations (including latest NVM version).
11. `NODE_BIN` (optional): Absolute path to Node runtime used to execute OpenClaw CLI in launchd context. If unset, script auto-discovers from PATH and common install locations (including latest NVM version).
12. `WATCHDOG_ENABLED` (optional): Set to `0` to disable actions during maintenance windows.
13. `WATCHDOG_DISABLE_FILE` (optional): Sentinel file path; when file exists, watchdog is disabled.

Runtime files:

1. State: `.state/runtime/gateway_watchdog_state.json`
2. Log: `logs/gateway-watchdog.log`
3. Lock: `.state/runtime/gateway_watchdog.lock/`
4. Runtime temp files: `.state/runtime/tmp/`

## Standalone Repo Notes

This directory is already close to being a standalone repository, but there are two different targets:

1. Personal backup repo: feasible now with minimal cleanup.
2. General-purpose shared repo: feasible, but should not be published with the current user-specific paths as-is.

For a personal backup/share repo, the minimum useful file set is:

1. `gateway-watchdog.sh`
2. `watchdog-core.sh`
3. `config.sh`
4. `probe.sh`
5. `state.sh`
6. `notifiers/`
7. `config.example.env`
8. `README.md`
9. `tests/`
10. `ai.openclaw.gateway-watchdog.plist.template`
11. `install-gateway-watchdog-launchagent.sh`
12. `uninstall-gateway-watchdog-launchagent.sh`

## Quick Start

1. Copy `config.example.env` to a private env file such as `$HOME/.openclaw/config/watchdog.env`.
2. Fill in webhook values and optional overrides in that private env file.
3. Install the LaunchAgent:
   - `bash scripts/watchdog/install-gateway-watchdog-launchagent.sh`
4. Verify the service is loaded:
   - `launchctl list | rg "ai\\.openclaw\\.gateway-watchdog"`
5. Verify live ticks in the watchdog log:
   - `tail -n 20 /Users/rael/.openclaw/logs/gateway-watchdog.log`

## Security Notes

1. Do not commit the private watchdog env file; only commit `config.example.env`.
2. Webhook URLs are secrets and should live in the private env file or in LaunchAgent environment variables.
3. Notifier loading is whitelist-based and restricted to the controlled `notifiers/` directory, but it is still shell `source`-based rather than subprocess-isolated.
4. If this is published as a shared repo, prefer templated paths over user-specific absolute paths before distribution.

Before publishing as a more reusable public repo, it is worth doing one more cleanup pass:

1. Replace user-specific absolute paths like `/Users/rael/.openclaw/...` with documented variables such as `OPENCLAW_HOME`, `WATCHDOG_STATE_DIR`, and `WATCHDOG_LOG_DIR`.

If the goal is backup and sharing your own working setup, adding this README guidance is enough.
If the goal is broader reuse by other people, path template cleanup is the next thing to do before splitting it into a dedicated GitHub repository.
