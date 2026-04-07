#!/usr/bin/env bash

WATCHDOG_ENV_FILE="${WATCHDOG_ENV_FILE:-$HOME/.openclaw/config/watchdog.env}"

load_watchdog_env_file() {
  local file="$1" line key value

  [[ -f "$file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"

    case "$key" in
      DISCORD_WATCHDOG_WEBHOOK_URL|FEISHU_WATCHDOG_WEBHOOK_URL|NOTIFIER|FAIL_THRESHOLD|COOLDOWN_SEC|POST_RESTART_RETRIES|POST_RESTART_SLEEP_SEC|PROBE_CONFIRM_SLEEP_SEC|OPENCLAW_BIN|NODE_BIN|WATCHDOG_ENABLED|WATCHDOG_DISABLE_FILE|WATCHDOG_ENV_FILE)
        [[ -n "${!key:-}" ]] || printf -v "$key" '%s' "$value"
        ;;
      *)
        if declare -F log >/dev/null 2>&1; then
          log WARN config_key_ignored "key=$key source=env_file"
        fi
        ;;
    esac
  done < "$file"
}

apply_watchdog_defaults() {
  : "${FAIL_THRESHOLD:=3}"
  : "${COOLDOWN_SEC:=300}"
  : "${POST_RESTART_RETRIES:=3}"
  : "${POST_RESTART_SLEEP_SEC:=5}"
  : "${PROBE_CONFIRM_SLEEP_SEC:=2}"
  : "${NOTIFIER:=composite}"
  : "${OPENCLAW_BIN:=}"
  : "${NODE_BIN:=}"
  : "${WATCHDOG_ENABLED:=1}"
  : "${WATCHDOG_DISABLE_FILE:=/Users/rael/.openclaw/.state/runtime/gateway_watchdog.disabled}"
  : "${DISCORD_WATCHDOG_WEBHOOK_URL:=}"
  : "${FEISHU_WATCHDOG_WEBHOOK_URL:=}"
}

load_watchdog_config() {
  WATCHDOG_ENV_FILE="${WATCHDOG_ENV_FILE:-$HOME/.openclaw/config/watchdog.env}"
  load_watchdog_env_file "$WATCHDOG_ENV_FILE"
  apply_watchdog_defaults

  DISCORD_WEBHOOK_URL="${DISCORD_WATCHDOG_WEBHOOK_URL:-}"
  FEISHU_WEBHOOK_URL="${FEISHU_WATCHDOG_WEBHOOK_URL:-}"
}
