#!/usr/bin/env bash

WATCHDOG_LOCK_STALE_SEC="${WATCHDOG_LOCK_STALE_SEC:-120}"

init_state() {
  mkdir -p "$(dirname "$STATE_FILE")"
  cat > "$STATE_FILE" <<'JSON'
{"consecutive_failures":0,"last_ok_at":"","last_failure_at":"","last_restart_at":"","cooldown_until_epoch":0}
JSON
}

ensure_state() {
  if [[ ! -f "$STATE_FILE" ]]; then
    init_state
    return
  fi
  if ! jq -e . >/dev/null 2>&1 <"$STATE_FILE"; then
    log WARN state_corrupt "message=reinitialize_state_file"
    init_state
  fi
}

read_state_field() {
  jq -r "$1" "$STATE_FILE"
}

write_state() {
  local state_dir tmp_file

  state_dir="$(dirname "$STATE_FILE")"
  mkdir -p "$state_dir"
  tmp_file="$(mktemp "$state_dir/gateway_watchdog_state.XXXXXX")"
  cat > "$tmp_file"
  mv "$tmp_file" "$STATE_FILE"
}

reap_stale_lock_if_needed() {
  local started_at now pid dir_mtime

  [[ -d "$WATCHDOG_LOCK_DIR" ]] || return 0

  now="$(date +%s)"
  if [[ ! -f "$WATCHDOG_LOCK_DIR/pid" || ! -f "$WATCHDOG_LOCK_DIR/started_at" ]]; then
    dir_mtime="$(stat -f %m "$WATCHDOG_LOCK_DIR" 2>/dev/null || echo 0)"
    if (( now - dir_mtime > WATCHDOG_LOCK_STALE_SEC )); then
      rm -rf "$WATCHDOG_LOCK_DIR"
    fi
    return 0
  fi

  started_at="$(cat "$WATCHDOG_LOCK_DIR/started_at" 2>/dev/null || echo 0)"
  pid="$(cat "$WATCHDOG_LOCK_DIR/pid" 2>/dev/null || echo '')"

  if (( now - started_at > WATCHDOG_LOCK_STALE_SEC )) && { [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; }; then
    rm -f "$WATCHDOG_LOCK_DIR/pid" "$WATCHDOG_LOCK_DIR/started_at"
    rmdir "$WATCHDOG_LOCK_DIR" 2>/dev/null || rm -rf "$WATCHDOG_LOCK_DIR"
  fi
}

acquire_lock() {
  mkdir -p "$(dirname "$WATCHDOG_LOCK_DIR")"
  mkdir "$WATCHDOG_LOCK_DIR" 2>/dev/null || return 1
  printf '%s\n' "$$" > "$WATCHDOG_LOCK_DIR/pid"
  date +%s > "$WATCHDOG_LOCK_DIR/started_at"
}

acquire_watchdog_lock() {
  reap_stale_lock_if_needed
  if acquire_lock; then
    return 0
  fi

  log WARN watchdog_locked "lock_dir=$WATCHDOG_LOCK_DIR"
  return 1
}

release_lock() {
  rm -f "$WATCHDOG_LOCK_DIR/pid" "$WATCHDOG_LOCK_DIR/started_at"
  rmdir "$WATCHDOG_LOCK_DIR" 2>/dev/null || true
}

init_runtime_paths() {
  mkdir -p "$WATCHDOG_RUNTIME_TMP_DIR"
  RESTART_OUTPUT_FILE="$(mktemp "$WATCHDOG_RUNTIME_TMP_DIR/restart.XXXXXX")"
  NOTIFY_OUTPUT_FILE="$(mktemp "$WATCHDOG_RUNTIME_TMP_DIR/notify.XXXXXX")"
}

cleanup_runtime_paths() {
  rm -f "$RESTART_OUTPUT_FILE" "$NOTIFY_OUTPUT_FILE"
  rm -f "${NOTIFY_OUTPUT_FILE}".*.body "${NOTIFY_OUTPUT_FILE}".*.err 2>/dev/null || true
}
