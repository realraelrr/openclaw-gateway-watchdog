#!/usr/bin/env bash

probe_emit() {
  PROBE_STATUS="$1"
  PROBE_REASON="$2"
  printf '%s\n' "$1"
}

probe_gateway() {
  local out rc

  if [[ -z "$OPENCLAW_BIN_RESOLVED" ]] || [[ ! -x "$OPENCLAW_BIN_RESOLVED" ]]; then
    log WARN probe_fail "rc=127 summary=openclaw_bin_not_found"
    probe_emit fail openclaw_bin_not_found
    return 0
  fi

  rc=0
  out="$(run_openclaw gateway status --json 2>&1)" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    log WARN probe_fail "rc=$rc summary=$(printf '%s' "$out" | head -n 1 | tr ' ' '_')"
    probe_emit fail openclaw_status_failed
    return 0
  fi

  if jq -e '.service.loaded == true and .service.runtime.status == "running" and .rpc.ok == true and .health.healthy == true' >/dev/null 2>&1 <<<"$out"; then
    log INFO probe_ok "rc=0"
    probe_emit ok ok
  elif jq -e '.service.loaded == true and (.service.runtime.status == "active" or .service.runtime.status == "running") and .rpc.ok != true and .health.healthy == true' >/dev/null 2>&1 <<<"$out"; then
    log INFO probe_neutral "reason=loaded_but_not_ready"
    probe_emit neutral loaded_but_not_ready
  else
    log WARN probe_fail "rc=0 summary=json_contract_unhealthy"
    probe_emit fail gateway_status_unhealthy
  fi
}
