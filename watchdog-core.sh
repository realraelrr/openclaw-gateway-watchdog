#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
source "$SCRIPT_DIR/config.sh"
source "$SCRIPT_DIR/probe.sh"
source "$SCRIPT_DIR/state.sh"

STATE_FILE=""
LOG_FILE=""
RESTART_OUTPUT_FILE=""
NOTIFY_OUTPUT_FILE=""
OPENCLAW_BIN_RESOLVED=""
NODE_BIN_RESOLVED=""
DISCORD_WEBHOOK_URL=""
RESTART_FAILURE_REASON=""
PROBE_REASON="ok"
PROBE_STATUS="ok"
RUN_PROBE_RESULT=""

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

short_hostname() {
  hostname -s 2>/dev/null || hostname
}

event_title() {
  case "$1" in
    restart_triggered) printf '自动重启已触发\n' ;;
    restart_succeeded) printf '自动重启已恢复\n' ;;
    restart_failed) printf '自动重启失败\n' ;;
    manual_restart_triggered) printf '手动重启已触发\n' ;;
    manual_restart_succeeded) printf '手动重启成功\n' ;;
    manual_restart_failed) printf '手动重启失败\n' ;;
    *) printf '%s\n' "$1" ;;
  esac
}

event_source() {
  case "$1" in
    manual_restart_*) printf 'local CLI\n' ;;
    *) printf 'passive watchdog\n' ;;
  esac
}

reason_component() {
  case "$1" in
    openclaw_bin_not_found|node_missing) printf 'Watchdog 运行环境\n' ;;
    openclaw_status_failed) printf 'OpenClaw CLI / gateway status\n' ;;
    gateway_status_unhealthy|loaded_but_not_ready|recovery_timeout) printf 'OpenClaw Gateway / 健康状态\n' ;;
    gateway_restart_failed|gateway_install_failed|gateway_start_failed) printf 'OpenClaw Gateway / 恢复命令\n' ;;
    manual_request) printf '本地主动控制\n' ;;
    ok) printf '健康检查\n' ;;
    *) printf '未知环节\n' ;;
  esac
}

reason_summary() {
  case "$1" in
    openclaw_bin_not_found) printf '找不到可执行的 openclaw CLI\n' ;;
    node_missing) printf '找不到可执行的 node；如果 openclaw 本身可执行，仍会尝试直接运行\n' ;;
    openclaw_status_failed) printf 'openclaw gateway status --json 执行失败\n' ;;
    gateway_status_unhealthy) printf 'openclaw gateway status --json 未满足健康合同\n' ;;
    loaded_but_not_ready) printf 'gateway 已加载但 RPC 尚未 ready\n' ;;
    gateway_restart_failed) printf 'openclaw gateway restart 执行失败\n' ;;
    gateway_install_failed) printf 'gateway install failed\n' ;;
    gateway_start_failed) printf 'gateway start failed\n' ;;
    recovery_timeout) printf '重启命令返回后健康检查仍未恢复\n' ;;
    manual_request) printf '本地手动请求\n' ;;
    ok) printf '健康检查通过\n' ;;
    *) printf '未分类原因\n' ;;
  esac
}

action_summary() {
  case "$1" in
    restart_gateway) printf '重启 OpenClaw gateway\n' ;;
    none|"") printf '不执行重启\n' ;;
    *) printf '%s\n' "$1" ;;
  esac
}

format_notification() {
  local event="$1"
  local failure_count="$2"
  local reason="${3:-${PROBE_REASON:-unknown}}"
  local action="${4:-restart_gateway}"
  local host title source component summary action_text

  host="$(short_hostname)"
  title="$(event_title "$event")"
  source="$(event_source "$event")"
  component="$(reason_component "$reason")"
  summary="$(reason_summary "$reason")"
  action_text="$(action_summary "$action")"

  printf '[%s] %s\n\n主机: %s\n来源: %s\n故障环节: %s\n原因: %s - %s\n动作: %s\n连续失败: %s\nraw: event=%s host=%s failures=%s reason=%s action=%s\n' \
    "${WATCHDOG_DISPLAY_NAME:-OpenClaw Gateway Watchdog}" \
    "$title" \
    "$host" \
    "$source" \
    "$component" \
    "$reason" \
    "$summary" \
    "$action_text" \
    "$failure_count" \
    "$event" \
    "$host" \
    "$failure_count" \
    "$reason" \
    "$action"
}

usage() {
  printf 'Usage: %s [restart gateway]\n' "${0##*/}" >&2
}

is_manual_restart_command() {
  [[ "${1:-}" == "restart" || "${1:-}" == "--restart" ]]
}

manual_restart_action_for_target() {
  case "${1:-}" in
    gateway) printf 'restart_gateway\n' ;;
    *) return 1 ;;
  esac
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

run_probe_gateway() {
  local output_file output temp_dir

  temp_dir="${WATCHDOG_RUNTIME_TMP_DIR:-${TMPDIR:-/tmp}}"
  mkdir -p "$temp_dir"
  output_file="$(mktemp "$temp_dir/probe.XXXXXX")"

  PROBE_REASON=""
  PROBE_STATUS=""
  RUN_PROBE_RESULT=""

  probe_gateway > "$output_file"
  output="$(tail -n 1 "$output_file" 2>/dev/null || true)"
  rm -f "$output_file"

  if [[ -z "${PROBE_STATUS:-}" ]]; then
    PROBE_STATUS="$output"
  fi

  RUN_PROBE_RESULT="${PROBE_STATUS:-fail}"
}

restart_gateway() {
  local rc=0 install_rc=0 start_rc=0

  RESTART_FAILURE_REASON=""

  run_openclaw gateway restart >"$RESTART_OUTPUT_FILE" 2>&1 || rc=$?
  if grep -Eqi 'service not loaded|service unit not found|not installed' "$RESTART_OUTPUT_FILE"; then
    log WARN restart_repair "action=install_then_start"
    run_openclaw gateway install >>"$RESTART_OUTPUT_FILE" 2>&1 || install_rc=$?
    rc=0
    if (( install_rc != 0 )); then
      RESTART_FAILURE_REASON="gateway_install_failed"
      rc="$install_rc"
    else
      run_openclaw gateway start >>"$RESTART_OUTPUT_FILE" 2>&1 || start_rc=$?
      if (( start_rc != 0 )); then
        RESTART_FAILURE_REASON="gateway_start_failed"
        rc="$start_rc"
      fi
    fi
  elif (( rc != 0 )); then
    RESTART_FAILURE_REASON="gateway_restart_failed"
  fi

  return "$rc"
}

wait_for_gateway_recovery() {
  local attempt=1
  local post_restart_retries="${POST_RESTART_RETRIES:-3}"
  local post_restart_sleep_sec="${POST_RESTART_SLEEP_SEC:-5}"
  local probe_result=""

  while (( attempt <= post_restart_retries )); do
    sleep "$post_restart_sleep_sec"
    run_probe_gateway
    probe_result="$RUN_PROBE_RESULT"
    if [[ "$probe_result" == "ok" ]]; then
      return 0
    fi
    attempt=$((attempt + 1))
  done

  if [[ "$probe_result" == "neutral" ]]; then
    sleep "$post_restart_sleep_sec"
    run_probe_gateway
    if [[ "$RUN_PROBE_RESULT" == "ok" ]]; then
      return 0
    fi
  fi

  return 1
}

watchdog_cleanup() {
  notifier_cleanup || true
  cleanup_runtime_paths
  release_lock
}

watchdog_finalize() {
  trap - EXIT
  watchdog_cleanup
}

watchdog_manual_restart() {
  local target="${1:-}" action="" rc=0

  if ! action="$(manual_restart_action_for_target "$target")"; then
    usage
    return 64
  fi

  load_watchdog_config
  load_notifier
  notifier_init || true
  mkdir -p "$(dirname "$LOG_FILE")"
  touch "$LOG_FILE"
  if ! acquire_watchdog_lock; then
    return 0
  fi
  trap 'watchdog_cleanup' EXIT
  init_runtime_paths

  if ! resolve_openclaw_bin; then
    RESTART_FAILURE_REASON="openclaw_bin_not_found"
    log ERROR manual_restart_failed "target=$target action=$action reason=$RESTART_FAILURE_REASON"
    notify_send "$(format_notification manual_restart_failed 0 "$RESTART_FAILURE_REASON" "$action")" || true
    watchdog_finalize
    return 1
  fi
  if ! resolve_node_bin; then
    log WARN node_missing "hint=set_NODE_BIN"
  fi

  log INFO manual_restart_triggered "target=$target action=$action"
  notify_send "$(format_notification manual_restart_triggered 0 manual_request "$action")" || true
  restart_gateway || rc=$?

  if (( rc == 0 )); then
    log INFO manual_restart_succeeded "target=$target action=$action"
    notify_send "$(format_notification manual_restart_succeeded 0 manual_request "$action")" || true
  else
    log ERROR manual_restart_failed "target=$target action=$action reason=${RESTART_FAILURE_REASON:-gateway_restart_failed}"
    notify_send "$(format_notification manual_restart_failed 0 "${RESTART_FAILURE_REASON:-gateway_restart_failed}" "$action")" || true
  fi

  watchdog_finalize
  return "$rc"
}

watchdog_main() {
  local now_iso now_epoch probe incident_reason
  local consecutive_failures cooldown_until_epoch last_ok_at last_failure_at last_restart_at
  local restart_failures
  local restart_rc restart_summary recovered
  local restarted=0

  if is_manual_restart_command "${1:-}"; then
    watchdog_manual_restart "${2:-}"
    return $?
  fi

  load_watchdog_config
  load_notifier
  notifier_init || true
  mkdir -p "$(dirname "$LOG_FILE")"
  touch "$LOG_FILE"
  if ! acquire_watchdog_lock; then
    return 0
  fi
  trap 'watchdog_cleanup' EXIT
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
  restart_failures="$(read_state_field '.restart_failures')"
  [[ "$restart_failures" =~ ^-?[0-9]+$ ]] || restart_failures=0
  cooldown_until_epoch="$(read_state_field '.cooldown_until_epoch')"
  last_ok_at="$(read_state_field '.last_ok_at')"
  last_failure_at="$(read_state_field '.last_failure_at')"
  last_restart_at="$(read_state_field '.last_restart_at')"

  if watchdog_is_disabled; then
    log WARN watchdog_disabled "enabled=$WATCHDOG_ENABLED sentinel=$([[ -f "$WATCHDOG_DISABLE_FILE" ]] && echo 1 || echo 0)"
    consecutive_failures=0
    write_state <<JSON
{"consecutive_failures":$consecutive_failures,"restart_failures":$restart_failures,"last_ok_at":"$last_ok_at","last_failure_at":"$last_failure_at","last_restart_at":"$last_restart_at","cooldown_until_epoch":$cooldown_until_epoch}
JSON
    watchdog_finalize
    return 0
  fi

  run_probe_gateway
  probe="$RUN_PROBE_RESULT"
  if [[ "$probe" == "ok" ]]; then
    consecutive_failures=0
    restart_failures=0
    last_ok_at="$now_iso"
    log INFO state_update "consecutive_failures=0"
    write_state <<JSON
{"consecutive_failures":$consecutive_failures,"restart_failures":$restart_failures,"last_ok_at":"$last_ok_at","last_failure_at":"$last_failure_at","last_restart_at":"$last_restart_at","cooldown_until_epoch":$cooldown_until_epoch}
JSON
    watchdog_finalize
    return 0
  elif [[ "$probe" == "neutral" ]]; then
    log INFO state_hold "reason=${PROBE_REASON:-probe_neutral} failures=$consecutive_failures"
    watchdog_finalize
    return 0
  fi

  consecutive_failures=$((consecutive_failures + 1))
  last_failure_at="$now_iso"
  log WARN state_update "consecutive_failures=$consecutive_failures"
  if [[ "${PROBE_REASON:-ok}" == "ok" ]]; then
    PROBE_REASON="gateway_status_unhealthy"
  fi

  if (( now_epoch < cooldown_until_epoch )); then
    log WARN cooldown_skip "until=$cooldown_until_epoch failures=$consecutive_failures"
    write_state <<JSON
{"consecutive_failures":$consecutive_failures,"restart_failures":$restart_failures,"last_ok_at":"$last_ok_at","last_failure_at":"$last_failure_at","last_restart_at":"$last_restart_at","cooldown_until_epoch":$cooldown_until_epoch}
JSON
    watchdog_finalize
    return 0
  fi

  if (( consecutive_failures >= FAIL_THRESHOLD )); then
    if (( ${MAX_RESTART_FAILURES:-10} > 0 && restart_failures >= ${MAX_RESTART_FAILURES:-10} )); then
      log ERROR restart_limit_reached "restart_failures=$restart_failures max_restart_failures=${MAX_RESTART_FAILURES:-10} reason=${PROBE_REASON:-gateway_status_unhealthy}"
      write_state <<JSON
{"consecutive_failures":$consecutive_failures,"restart_failures":$restart_failures,"last_ok_at":"$last_ok_at","last_failure_at":"$last_failure_at","last_restart_at":"$last_restart_at","cooldown_until_epoch":$cooldown_until_epoch}
JSON
      watchdog_finalize
      return 0
    fi

    restarted=1
    incident_reason="${PROBE_REASON:-gateway_status_unhealthy}"
    log ERROR restart_triggered "failures=$consecutive_failures"
    notify_send "$(format_notification restart_triggered "$consecutive_failures" "$incident_reason" restart_gateway)" || true
    restart_rc=0
    if [[ -z "$OPENCLAW_BIN_RESOLVED" ]] || [[ ! -x "$OPENCLAW_BIN_RESOLVED" ]]; then
      restart_rc=127
      RESTART_FAILURE_REASON="openclaw_bin_not_found"
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
      restart_failures=0
      last_ok_at="$(date -u +%FT%TZ)"
      log INFO restart_succeeded "restart_rc=$restart_rc summary=${restart_summary:-none} cooldown_until=$cooldown_until_epoch"
      notify_send "$(format_notification restart_succeeded 0 "$incident_reason" restart_gateway)" || true
    else
      restart_failures=$((restart_failures + 1))
      if (( restart_rc == 0 )); then
        RESTART_FAILURE_REASON="recovery_timeout"
      fi
      log ERROR restart_failed "restart_rc=$restart_rc summary=${restart_summary:-none} cooldown_until=$cooldown_until_epoch"
      notify_send "$(format_notification restart_failed "$consecutive_failures" "${RESTART_FAILURE_REASON:-gateway_restart_failed}" restart_gateway)" || true
    fi
  fi

  if (( restarted == 0 )); then
    log WARN threshold_not_reached "failures=$consecutive_failures threshold=$FAIL_THRESHOLD"
  fi

  write_state <<JSON
{"consecutive_failures":$consecutive_failures,"restart_failures":$restart_failures,"last_ok_at":"$last_ok_at","last_failure_at":"$last_failure_at","last_restart_at":"$last_restart_at","cooldown_until_epoch":$cooldown_until_epoch}
JSON
  watchdog_finalize
}

main() {
  watchdog_main "$@"
}
