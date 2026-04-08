#!/usr/bin/env bash

probe_gateway() {
  local out rc

  if [[ -z "$OPENCLAW_BIN_RESOLVED" ]] || [[ ! -x "$OPENCLAW_BIN_RESOLVED" ]]; then
    log WARN probe_fail "rc=127 summary=openclaw_bin_not_found"
    echo "fail"
    return 0
  fi

  rc=0
  out="$(run_openclaw gateway status --json 2>&1)" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    log WARN probe_fail "rc=$rc summary=$(printf '%s' "$out" | head -n 1 | tr ' ' '_')"
    echo "fail"
    return 0
  fi

  if jq -e '.service.loaded == true and .service.runtime.status == "running" and .rpc.ok == true and .health.healthy == true' >/dev/null 2>&1 <<<"$out"; then
    log INFO probe_ok "rc=0"
    echo "ok"
  elif jq -e '.service.loaded == true and (.service.runtime.status == "active" or .service.runtime.status == "running") and .rpc.ok != true and .health.healthy == true' >/dev/null 2>&1 <<<"$out"; then
    log INFO probe_neutral "reason=loaded_but_not_ready"
    echo "neutral"
  else
    log WARN probe_fail "rc=0 summary=json_contract_unhealthy"
    echo "fail"
  fi
}
