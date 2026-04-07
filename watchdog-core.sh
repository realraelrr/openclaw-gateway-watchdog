#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
source "$SCRIPT_DIR/config.sh"
source "$SCRIPT_DIR/probe.sh"
source "$SCRIPT_DIR/state.sh"

STATE_FILE="/Users/rael/.openclaw/.state/runtime/gateway_watchdog_state.json"
LOG_FILE="/Users/rael/.openclaw/logs/gateway-watchdog.log"
RESTART_OUTPUT_FILE=""
NOTIFY_OUTPUT_FILE=""
OPENCLAW_BIN_RESOLVED=""
NODE_BIN_RESOLVED=""
DISCORD_WEBHOOK_URL=""
FEISHU_WEBHOOK_URL=""

notifier_init() { return 0; }
notify_send() { return 0; }
notifier_cleanup() { return 0; }

load_notifier() {
  local notifier_file=""

  notifier_init() { return 0; }
  notify_send() { return 0; }
  notifier_cleanup() { return 0; }

  case "${NOTIFIER:-composite}" in
    discord) notifier_file="$SCRIPT_DIR/notifiers/discord.sh" ;;
    feishu) notifier_file="$SCRIPT_DIR/notifiers/feishu.sh" ;;
    composite) notifier_file="$SCRIPT_DIR/notifiers/composite.sh" ;;
    *) log WARN notifier_unknown "notifier=${NOTIFIER:-unset}" ;;
  esac

  [[ -n "$notifier_file" ]] || return 0
  source "$notifier_file"
}

log() {
  printf '%s level=%s event=%s %s\n' "$(date -u +%FT%TZ)" "$1" "$2" "${3:-}" >> "$LOG_FILE"
}

resolve_latest_nvm_binary() {
  local tool="$1"
  local candidate

  candidate="$(ls -1 "$HOME"/.nvm/versions/node/*/bin/"$tool" 2>/dev/null | sort -V | tail -n 1 || true)"
  if [[ -n "$candidate" ]] && [[ -x "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  return 1
}

watchdog_is_disabled() {
  if [[ "$WATCHDOG_ENABLED" == "0" ]]; then
    return 0
  fi
  if [[ -f "$WATCHDOG_DISABLE_FILE" ]]; then
    return 0
  fi
  return 1
}

resolve_openclaw_bin() {
  local candidate

  if [[ -n "$OPENCLAW_BIN" ]] && [[ -x "$OPENCLAW_BIN" ]]; then
    OPENCLAW_BIN_RESOLVED="$OPENCLAW_BIN"
    return 0
  fi

  candidate="$(command -v openclaw 2>/dev/null || true)"
  if [[ -n "$candidate" ]] && [[ -x "$candidate" ]]; then
    OPENCLAW_BIN_RESOLVED="$candidate"
    return 0
  fi

  candidate="$(resolve_latest_nvm_binary openclaw || true)"
  if [[ -n "$candidate" ]] && [[ -x "$candidate" ]]; then
    OPENCLAW_BIN_RESOLVED="$candidate"
    return 0
  fi

  if [[ -x "/opt/homebrew/bin/openclaw" ]]; then
    OPENCLAW_BIN_RESOLVED="/opt/homebrew/bin/openclaw"
    return 0
  fi

  if [[ -x "/usr/local/bin/openclaw" ]]; then
    OPENCLAW_BIN_RESOLVED="/usr/local/bin/openclaw"
    return 0
  fi

  OPENCLAW_BIN_RESOLVED=""
  return 1
}

resolve_node_bin() {
  local candidate

  if [[ -n "$NODE_BIN" ]] && [[ -x "$NODE_BIN" ]]; then
    NODE_BIN_RESOLVED="$NODE_BIN"
    return 0
  fi

  candidate="$(command -v node 2>/dev/null || true)"
  if [[ -n "$candidate" ]] && [[ -x "$candidate" ]]; then
    NODE_BIN_RESOLVED="$candidate"
    return 0
  fi

  candidate="$(resolve_latest_nvm_binary node || true)"
  if [[ -n "$candidate" ]] && [[ -x "$candidate" ]]; then
    NODE_BIN_RESOLVED="$candidate"
    return 0
  fi

  if [[ -x "/opt/homebrew/bin/node" ]]; then
    NODE_BIN_RESOLVED="/opt/homebrew/bin/node"
    return 0
  fi

  if [[ -x "/usr/local/bin/node" ]]; then
    NODE_BIN_RESOLVED="/usr/local/bin/node"
    return 0
  fi

  NODE_BIN_RESOLVED=""
  return 1
}

run_openclaw() {
  if [[ -z "$OPENCLAW_BIN_RESOLVED" ]] || [[ ! -x "$OPENCLAW_BIN_RESOLVED" ]]; then
    return 127
  fi
  if [[ -n "$NODE_BIN_RESOLVED" ]] && [[ -x "$NODE_BIN_RESOLVED" ]]; then
    "$NODE_BIN_RESOLVED" "$OPENCLAW_BIN_RESOLVED" "$@"
    return $?
  fi
  "$OPENCLAW_BIN_RESOLVED" "$@"
}

restart_gateway() {
  local rc=0 install_rc=0 start_rc=0

  run_openclaw gateway restart >"$RESTART_OUTPUT_FILE" 2>&1 || rc=$?
  if grep -Eqi 'service not loaded|service unit not found|not installed' "$RESTART_OUTPUT_FILE"; then
    log WARN restart_repair "action=install_then_start"
    run_openclaw gateway install >>"$RESTART_OUTPUT_FILE" 2>&1 || install_rc=$?
    run_openclaw gateway start >>"$RESTART_OUTPUT_FILE" 2>&1 || start_rc=$?
    if (( rc == 0 && install_rc != 0 )); then
      rc="$install_rc"
    fi
    if (( rc == 0 && start_rc != 0 )); then
      rc="$start_rc"
    fi
  fi

  return "$rc"
}

wait_for_gateway_recovery() {
  local attempt=1
  local post_restart_retries="${POST_RESTART_RETRIES:-3}"
  local post_restart_sleep_sec="${POST_RESTART_SLEEP_SEC:-5}"

  while (( attempt <= post_restart_retries )); do
    sleep "$post_restart_sleep_sec"
    if [[ "$(probe_gateway)" == "ok" ]]; then
      return 0
    fi
    attempt=$((attempt + 1))
  done

  return 1
}

watchdog_cleanup() {
  notifier_cleanup || true
  cleanup_runtime_paths
  release_lock
}

watchdog_main() {
  local now_iso now_epoch probe
  local consecutive_failures cooldown_until_epoch last_ok_at last_failure_at last_restart_at
  local restart_rc restart_summary recovered
  local restarted=0

  load_watchdog_config
  load_notifier
  notifier_init || true
  mkdir -p "$(dirname "$LOG_FILE")"
  touch "$LOG_FILE"
  if ! acquire_watchdog_lock; then
    return 0
  fi
  init_runtime_paths
  ensure_state

  now_iso="$(date -u +%FT%TZ)"
  now_epoch="$(date +%s)"
  log INFO tick_start "message=watchdog_tick"
  if ! resolve_openclaw_bin; then
    log ERROR openclaw_missing "hint=set_OPENCLAW_BIN"
  fi
  if ! resolve_node_bin; then
    log ERROR node_missing "hint=set_NODE_BIN"
  fi

  consecutive_failures="$(read_state_field '.consecutive_failures')"
  cooldown_until_epoch="$(read_state_field '.cooldown_until_epoch')"
  last_ok_at="$(read_state_field '.last_ok_at')"
  last_failure_at="$(read_state_field '.last_failure_at')"
  last_restart_at="$(read_state_field '.last_restart_at')"

  if watchdog_is_disabled; then
    log WARN watchdog_disabled "enabled=$WATCHDOG_ENABLED sentinel=$([[ -f "$WATCHDOG_DISABLE_FILE" ]] && echo 1 || echo 0)"
    consecutive_failures=0
    write_state <<JSON
{"consecutive_failures":$consecutive_failures,"last_ok_at":"$last_ok_at","last_failure_at":"$last_failure_at","last_restart_at":"$last_restart_at","cooldown_until_epoch":$cooldown_until_epoch}
JSON
    watchdog_cleanup
    return 0
  fi

  probe="$(probe_gateway)"
  if [[ "$probe" == "ok" ]]; then
    consecutive_failures=0
    last_ok_at="$now_iso"
    log INFO state_update "consecutive_failures=0"
    write_state <<JSON
{"consecutive_failures":$consecutive_failures,"last_ok_at":"$last_ok_at","last_failure_at":"$last_failure_at","last_restart_at":"$last_restart_at","cooldown_until_epoch":$cooldown_until_epoch}
JSON
    watchdog_cleanup
    return 0
  elif [[ "$probe" == "neutral" ]]; then
    log INFO state_hold "reason=probe_neutral failures=$consecutive_failures"
    watchdog_cleanup
    return 0
  fi

  consecutive_failures=$((consecutive_failures + 1))
  last_failure_at="$now_iso"
  log WARN state_update "consecutive_failures=$consecutive_failures"

  if (( now_epoch < cooldown_until_epoch )); then
    log WARN cooldown_skip "until=$cooldown_until_epoch failures=$consecutive_failures"
    write_state <<JSON
{"consecutive_failures":$consecutive_failures,"last_ok_at":"$last_ok_at","last_failure_at":"$last_failure_at","last_restart_at":"$last_restart_at","cooldown_until_epoch":$cooldown_until_epoch}
JSON
    watchdog_cleanup
    return 0
  fi

  if (( consecutive_failures >= FAIL_THRESHOLD )); then
    restarted=1
    log ERROR restart_triggered "failures=$consecutive_failures"
    notify_send "[WATCHDOG] Gateway unhealthy, restarting (failures=$consecutive_failures host=$(hostname -s))" || true
    restart_rc=0
    if [[ -z "$OPENCLAW_BIN_RESOLVED" ]] || [[ ! -x "$OPENCLAW_BIN_RESOLVED" ]]; then
      restart_rc=127
      printf 'openclaw binary unavailable\n' >"$RESTART_OUTPUT_FILE"
    else
      restart_gateway || restart_rc=$?
    fi
    restart_summary="$(head -n 1 "$RESTART_OUTPUT_FILE" 2>/dev/null | tr ' ' '_')"

    recovered=0
    if wait_for_gateway_recovery; then
      recovered=1
    fi

    last_restart_at="$now_iso"
    cooldown_until_epoch=$((now_epoch + COOLDOWN_SEC))
    if (( recovered == 1 )); then
      consecutive_failures=0
      last_ok_at="$(date -u +%FT%TZ)"
      log INFO restart_succeeded "restart_rc=$restart_rc summary=${restart_summary:-none} cooldown_until=$cooldown_until_epoch"
      notify_send "[WATCHDOG] Restart succeeded (host=$(hostname -s) retries=$POST_RESTART_RETRIES)" || true
    else
      log ERROR restart_failed "restart_rc=$restart_rc summary=${restart_summary:-none} cooldown_until=$cooldown_until_epoch"
      notify_send "[WATCHDOG] Restart failed (host=$(hostname -s) retries=$POST_RESTART_RETRIES)" || true
    fi
  fi

  if (( restarted == 0 )); then
    log WARN threshold_not_reached "failures=$consecutive_failures threshold=$FAIL_THRESHOLD"
  fi

  write_state <<JSON
{"consecutive_failures":$consecutive_failures,"last_ok_at":"$last_ok_at","last_failure_at":"$last_failure_at","last_restart_at":"$last_restart_at","cooldown_until_epoch":$cooldown_until_epoch}
JSON
  watchdog_cleanup
}

main() {
  watchdog_main "$@"
}
