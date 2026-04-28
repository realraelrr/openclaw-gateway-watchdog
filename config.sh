#!/usr/bin/env bash

derive_watchdog_seed_paths() {
  : "${OPENCLAW_HOME:=$HOME/.openclaw}"
  : "${WATCHDOG_ENV_FILE:=$OPENCLAW_HOME/config/watchdog.env}"
}

derive_watchdog_paths() {
  derive_watchdog_seed_paths
  : "${WATCHDOG_STATE_DIR:=$OPENCLAW_HOME/.state/runtime}"
  : "${WATCHDOG_LOG_DIR:=$OPENCLAW_HOME/logs}"
  : "${STATE_FILE:=$WATCHDOG_STATE_DIR/gateway_watchdog_state.json}"
  : "${WATCHDOG_DISABLE_FILE:=$WATCHDOG_STATE_DIR/gateway_watchdog.disabled}"
  : "${WATCHDOG_LOCK_DIR:=$WATCHDOG_STATE_DIR/gateway_watchdog.lock}"
  : "${WATCHDOG_RUNTIME_TMP_DIR:=$WATCHDOG_STATE_DIR/tmp}"
  : "${LOG_FILE:=$WATCHDOG_LOG_DIR/gateway-watchdog.log}"
}

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
      OPENCLAW_HOME|WATCHDOG_STATE_DIR|WATCHDOG_LOG_DIR|WATCHDOG_ENV_FILE|STATE_FILE|WATCHDOG_DISABLE_FILE|WATCHDOG_LOCK_DIR|WATCHDOG_RUNTIME_TMP_DIR|LOG_FILE|WATCHDOG_DISPLAY_NAME|DISCORD_WATCHDOG_WEBHOOK_URL|FEISHU_WATCHDOG_WEBHOOK_URL|NOTIFIER|FAIL_THRESHOLD|COOLDOWN_SEC|POST_RESTART_RETRIES|POST_RESTART_SLEEP_SEC|OPENCLAW_BIN|NODE_BIN|WATCHDOG_ENABLED)
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
  : "${NOTIFIER:=composite}"
  : "${WATCHDOG_DISPLAY_NAME:=OpenClaw Gateway Watchdog}"
  : "${OPENCLAW_BIN:=}"
  : "${NODE_BIN:=}"
  : "${WATCHDOG_ENABLED:=1}"
  : "${DISCORD_WATCHDOG_WEBHOOK_URL:=}"
  : "${FEISHU_WATCHDOG_WEBHOOK_URL:=}"
}

load_watchdog_config() {
  derive_watchdog_seed_paths
  load_watchdog_env_file "$WATCHDOG_ENV_FILE"
  apply_watchdog_defaults
  derive_watchdog_paths

  DISCORD_WEBHOOK_URL="${DISCORD_WATCHDOG_WEBHOOK_URL:-}"
  FEISHU_WEBHOOK_URL="${FEISHU_WATCHDOG_WEBHOOK_URL:-}"
}
