import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const watchdogDir = path.resolve(__dirname, '..');
const fixturesDir = path.join(__dirname, 'fixtures');
const wrapperPath = path.join(watchdogDir, 'gateway-watchdog.sh');
const corePath = path.join(watchdogDir, 'watchdog-core.sh');
const statePath = path.join(watchdogDir, 'state.sh');
const sampleGatewayStatusPath = path.join(fixturesDir, 'gateway-status.sample.json');
const sampleGatewayStatus = JSON.parse(readFile(sampleGatewayStatusPath));

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function runBash(script, { env = {} } = {}) {
  return execFileSync('/bin/bash', ['-lc', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('wrapper: gateway-watchdog.sh is a thin entrypoint shell', () => {
  const script = readFile(wrapperPath);

  assert.match(script, /^#!\/usr\/bin\/env bash/m);
  assert.match(script, /^set -euo pipefail$/m);
  assert.match(
    script,
    /SCRIPT_DIR="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" && pwd\)"/,
  );
  assert.match(script, /source "\$SCRIPT_DIR\/watchdog-core\.sh"/);
  assert.match(script, /watchdog_main "\$@"/);

  assert.doesNotMatch(script, /probe_gateway\(\)/);
  assert.doesNotMatch(script, /restart_gateway\(\)/);
  assert.doesNotMatch(script, /notify_webhook\(\)/);
  assert.doesNotMatch(script, /main\(\)/);
});

test('wrapper: sourcing watchdog-core.sh exposes watchdog_main', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-core-home-'));

  const output = runBash(
    `
      export HOME="${tempHome}"
      source "${corePath}"
      declare -F watchdog_main
    `,
  );

  assert.match(output, /watchdog_main/);
});

test('config precedence: process env overrides WATCHDOG_ENV_FILE and defaults', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-config-'));
  const envFile = path.join(tempDir, 'watchdog.env');

  fs.writeFileSync(
    envFile,
    [
      'FAIL_THRESHOLD=9',
      'COOLDOWN_SEC=111',
      'POST_RESTART_RETRIES=7',
      'POST_RESTART_SLEEP_SEC=8',
      'NOTIFIER=discord',
      'WATCHDOG_ENABLED=0',
      '',
    ].join('\n'),
  );

  const output = runBash(
    `
      source "${corePath}"
      load_watchdog_config
      printf '%s\\n' \
        "FAIL_THRESHOLD=$FAIL_THRESHOLD" \
        "COOLDOWN_SEC=$COOLDOWN_SEC" \
        "POST_RESTART_RETRIES=$POST_RESTART_RETRIES" \
        "POST_RESTART_SLEEP_SEC=$POST_RESTART_SLEEP_SEC" \
        "NOTIFIER=$NOTIFIER" \
        "WATCHDOG_ENABLED=$WATCHDOG_ENABLED"
    `,
    {
      env: {
        HOME: tempDir,
        WATCHDOG_ENV_FILE: envFile,
        FAIL_THRESHOLD: '5',
        NOTIFIER: 'feishu',
      },
    },
  );

  assert.match(output, /FAIL_THRESHOLD=5/);
  assert.match(output, /COOLDOWN_SEC=111/);
  assert.match(output, /POST_RESTART_RETRIES=7/);
  assert.match(output, /POST_RESTART_SLEEP_SEC=8/);
  assert.match(output, /NOTIFIER=feishu/);
  assert.match(output, /WATCHDOG_ENABLED=0/);
});

test('config precedence: defaults apply when neither env source sets a key', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-config-defaults-'));
  const envFile = path.join(tempDir, 'watchdog.env');

  fs.writeFileSync(envFile, 'DISCORD_WATCHDOG_WEBHOOK_URL=https://example.invalid/hook\n');

  const output = runBash(
    `
      source "${corePath}"
      load_watchdog_config
      printf '%s\\n' \
        "FAIL_THRESHOLD=$FAIL_THRESHOLD" \
        "COOLDOWN_SEC=$COOLDOWN_SEC" \
        "POST_RESTART_RETRIES=$POST_RESTART_RETRIES" \
        "POST_RESTART_SLEEP_SEC=$POST_RESTART_SLEEP_SEC" \
        "NOTIFIER=$NOTIFIER" \
        "WATCHDOG_DISPLAY_NAME=$WATCHDOG_DISPLAY_NAME"
    `,
    {
      env: {
        HOME: tempDir,
        WATCHDOG_ENV_FILE: envFile,
      },
    },
  );

  assert.match(output, /FAIL_THRESHOLD=3/);
  assert.match(output, /COOLDOWN_SEC=300/);
  assert.match(output, /POST_RESTART_RETRIES=3/);
  assert.match(output, /POST_RESTART_SLEEP_SEC=5/);
  assert.match(output, /NOTIFIER=composite/);
  assert.match(output, /WATCHDOG_DISPLAY_NAME=OpenClaw Gateway Watchdog/);
});

test('public paths: OPENCLAW_HOME drives env file lookup and derived state/log paths', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-public-home-'));
  const configDir = path.join(tempHome, 'config');

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'watchdog.env'),
    ['FAIL_THRESHOLD=9', 'NOTIFIER=feishu', ''].join('\n'),
  );

  const output = runBash(`
    source "${corePath}"
    OPENCLAW_HOME="${tempHome}"
    load_watchdog_config
    printf '%s\\n' \
      "WATCHDOG_ENV_FILE=$WATCHDOG_ENV_FILE" \
      "WATCHDOG_DISABLE_FILE=$WATCHDOG_DISABLE_FILE" \
      "STATE_FILE=$STATE_FILE" \
      "LOG_FILE=$LOG_FILE" \
      "FAIL_THRESHOLD=$FAIL_THRESHOLD" \
      "NOTIFIER=$NOTIFIER"
  `);

  assert.match(output, new RegExp(`WATCHDOG_ENV_FILE=${escapeForRegex(path.join(tempHome, 'config', 'watchdog.env'))}`));
  assert.match(
    output,
    new RegExp(`WATCHDOG_DISABLE_FILE=${escapeForRegex(path.join(tempHome, '.state', 'runtime', 'gateway_watchdog.disabled'))}`),
  );
  assert.match(
    output,
    new RegExp(`STATE_FILE=${escapeForRegex(path.join(tempHome, '.state', 'runtime', 'gateway_watchdog_state.json'))}`),
  );
  assert.match(output, new RegExp(`LOG_FILE=${escapeForRegex(path.join(tempHome, 'logs', 'gateway-watchdog.log'))}`));
  assert.match(output, /FAIL_THRESHOLD=9/);
  assert.match(output, /NOTIFIER=feishu/);
});

test('config precedence: env file path overrides replace derived default state/log paths when process env leaves them unset', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-public-override-'));
  const envFile = path.join(tempDir, 'watchdog.env');
  const stateDirOverride = path.join(tempDir, 'custom-state');
  const logDirOverride = path.join(tempDir, 'custom-logs');

  fs.writeFileSync(
    envFile,
    [
      `WATCHDOG_STATE_DIR=${stateDirOverride}`,
      `WATCHDOG_LOG_DIR=${logDirOverride}`,
      '',
    ].join('\n'),
  );

  const output = runBash(
    `
      source "${corePath}"
      load_watchdog_config
      printf '%s\\n' \
        "WATCHDOG_STATE_DIR=$WATCHDOG_STATE_DIR" \
        "WATCHDOG_LOG_DIR=$WATCHDOG_LOG_DIR" \
        "STATE_FILE=$STATE_FILE" \
        "LOG_FILE=$LOG_FILE"
    `,
    {
      env: {
        WATCHDOG_ENV_FILE: envFile,
      },
    },
  );

  assert.match(output, new RegExp(`WATCHDOG_STATE_DIR=${escapeForRegex(stateDirOverride)}`));
  assert.match(output, new RegExp(`WATCHDOG_LOG_DIR=${escapeForRegex(logDirOverride)}`));
  assert.match(
    output,
    new RegExp(`STATE_FILE=${escapeForRegex(path.join(stateDirOverride, 'gateway_watchdog_state.json'))}`),
  );
  assert.match(
    output,
    new RegExp(`LOG_FILE=${escapeForRegex(path.join(logDirOverride, 'gateway-watchdog.log'))}`),
  );
});

test('probe: sampled fixture uses real gateway status field names', () => {
  assert.equal(sampleGatewayStatus.service.loaded, true);
  assert.equal(sampleGatewayStatus.service.runtime.status, 'running');
  assert.equal(sampleGatewayStatus.rpc.ok, false);
  assert.equal(sampleGatewayStatus.health.healthy, true);
});

test('probe: returns ok for healthy json contract', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-probe-ok-'));
  const jsonPath = path.join(tempDir, 'gateway-status.json');
  const healthyStatus = structuredClone(sampleGatewayStatus);

  healthyStatus.rpc.ok = true;
  fs.writeFileSync(jsonPath, `${JSON.stringify(healthyStatus)}\n`);

  const output = runBash(`
    source "${corePath}"
    log() { :; }
    OPENCLAW_BIN_RESOLVED="/bin/echo"
    run_openclaw() { cat "${jsonPath}"; }
    printf '%s\\n' "$(probe_gateway)"
  `);

  assert.equal(output.trim(), 'ok');
});

test('probe: returns neutral for loaded running gateway that is not rpc-ready', () => {
  const output = runBash(`
    source "${corePath}"
    log() { :; }
    OPENCLAW_BIN_RESOLVED="/bin/echo"
    run_openclaw() { cat "${sampleGatewayStatusPath}"; }
    printf '%s\\n' "$(probe_gateway)"
  `);

  assert.equal(output.trim(), 'neutral');
});

test('probe: returns fail when health reports unhealthy even if service is running', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-probe-unhealthy-'));
  const jsonPath = path.join(tempDir, 'gateway-status.json');
  const unhealthyStatus = structuredClone(sampleGatewayStatus);

  unhealthyStatus.rpc.ok = true;
  unhealthyStatus.health.healthy = false;
  fs.writeFileSync(jsonPath, `${JSON.stringify(unhealthyStatus)}\n`);

  const output = runBash(`
    source "${corePath}"
    log() { :; }
    OPENCLAW_BIN_RESOLVED="/bin/echo"
    run_openclaw() { cat "${jsonPath}"; }
    printf '%s\\n' "$(probe_gateway)"
  `);

  assert.equal(output.trim(), 'fail');
});

test('probe: returns fail on non-zero openclaw exit', () => {
  const output = runBash(`
    source "${corePath}"
    log() { :; }
    OPENCLAW_BIN_RESOLVED="/bin/echo"
    run_openclaw() {
      printf 'gateway closed\\n' >&2
      return 2
    }
    printf '%s\\n' "$(probe_gateway)"
  `);

  assert.equal(output.trim(), 'fail');
});

test('notify format: automatic restart message identifies OpenClaw service, source, reason, and action', () => {
  const output = runBash(`
    source "${corePath}"
    WATCHDOG_DISPLAY_NAME="OpenClaw Gateway Watchdog"
    POST_RESTART_RETRIES=6
    format_notification restart_triggered 3 gateway_status_unhealthy restart_gateway
  `);

  assert.match(output, /\[OpenClaw Gateway Watchdog\] 自动重启已触发/);
  assert.match(output, /来源: passive watchdog/);
  assert.match(output, /故障环节: OpenClaw Gateway \/ 健康状态/);
  assert.match(output, /原因: gateway_status_unhealthy - openclaw gateway status --json 未满足健康合同/);
  assert.match(output, /动作: 重启 OpenClaw gateway/);
  assert.match(output, /连续失败: 3/);
  assert.match(output, /raw: event=restart_triggered .* failures=3 reason=gateway_status_unhealthy action=restart_gateway/);
});

test('manual restart: restart gateway triggers OpenClaw restart and user-facing notifications', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-manual-restart-'));
  const notificationsFile = path.join(tempDir, 'notifications.log');
  const callsFile = path.join(tempDir, 'calls.log');

  const output = runBash(`
    source "${corePath}"
    WATCHDOG_LOCK_DIR="${path.join(tempDir, 'gateway.lock')}"
    WATCHDOG_RUNTIME_TMP_DIR="${path.join(tempDir, 'tmp')}"
    LOG_FILE="${path.join(tempDir, 'watchdog.log')}"
    STATE_FILE="${path.join(tempDir, 'state.json')}"
    WATCHDOG_DISABLE_FILE="${path.join(tempDir, 'disabled')}"
    WATCHDOG_DISPLAY_NAME="OpenClaw Gateway Watchdog"
    POST_RESTART_RETRIES=2
    POST_RESTART_SLEEP_SEC=0
    WATCHDOG_ENABLED=1
    log() { printf '%s %s %s %s\\n' "$1" "$2" "$3" "\${4:-}" >> "$LOG_FILE"; }
    load_watchdog_config() { :; DISCORD_WEBHOOK_URL=""; FEISHU_WEBHOOK_URL=""; }
    load_notifier() { :; }
    notifier_init() { :; }
    notifier_cleanup() { :; }
    resolve_openclaw_bin() { OPENCLAW_BIN_RESOLVED="/bin/echo"; }
    resolve_node_bin() { NODE_BIN_RESOLVED=""; }
    notify_send() { printf '%s\\n' "$1" >> "${notificationsFile}"; }
    init_runtime_paths() {
      mkdir -p "$WATCHDOG_RUNTIME_TMP_DIR"
      RESTART_OUTPUT_FILE="$WATCHDOG_RUNTIME_TMP_DIR/restart.out"
      NOTIFY_OUTPUT_FILE="$WATCHDOG_RUNTIME_TMP_DIR/notify.out"
    }
    run_openclaw() {
      printf '%s %s\\n' "$1" "$2" >> "${callsFile}"
      case "$1 $2" in
        "gateway restart")
          printf 'restarted\\n'
          return 0
          ;;
      esac
      return 99
    }
    watchdog_main restart gateway
    cat "$LOG_FILE"
    printf '\\n--- notifications ---\\n'
    cat "${notificationsFile}"
  `);

  assert.match(fs.readFileSync(callsFile, 'utf8'), /gateway restart/);
  assert.match(output, /manual_restart_triggered target=gateway action=restart_gateway/);
  assert.match(output, /manual_restart_succeeded target=gateway action=restart_gateway/);
  assert.match(output, /\[OpenClaw Gateway Watchdog\] 手动重启已触发/);
  assert.match(output, /\[OpenClaw Gateway Watchdog\] 手动重启成功/);
  assert.match(output, /来源: local CLI/);
  assert.match(output, /动作: 重启 OpenClaw gateway/);
});

test('manual restart: invalid target returns usage without taking the lock', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-manual-invalid-'));
  const lockDir = path.join(tempDir, 'gateway.lock');
  const result = spawnSync(
    '/bin/bash',
    [
      '-lc',
      `
        source "${corePath}"
        WATCHDOG_LOCK_DIR="${lockDir}"
        watchdog_main restart cloudflared
      `,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 64);
  assert.match(result.stderr, /Usage: .*restart gateway/);
  assert.equal(fs.existsSync(lockDir), false);
});

test('retries: POST_RESTART_RETRIES drives the main recovery loop count before any neutral grace probe', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-retries-'));
  const countFile = path.join(tempDir, 'probe-count');

  const output = runBash(`
    source "${corePath}"
    log() { :; }
    count_file="${countFile}"
    : > "$count_file"
    probe_gateway() {
      local count
      count="$(cat "$count_file" 2>/dev/null || printf '0')"
      count=$((count + 1))
      printf '%s\n' "$count" > "$count_file"
      printf 'fail\\n'
    }
    sleep() { :; }
    POST_RESTART_RETRIES=5
    if wait_for_gateway_recovery; then
      result=ok
    else
      result=fail
    fi
    printf 'probe_calls=%s result=%s\\n' "$(cat "$count_file")" "$result"
  `);

  assert.match(output, /probe_calls=5/);
  assert.match(output, /result=fail/);
});

test('restart: returns success when install/start repair succeeds after restart reports service not loaded', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-restart-repair-'));
  const restartOutputFile = path.join(tempDir, 'restart.out');

  const output = runBash(`
    source "${corePath}"
    log() { :; }
    RESTART_OUTPUT_FILE="${restartOutputFile}"
    run_openclaw() {
      case "$1 $2" in
        "gateway restart")
          printf 'service not loaded\\n'
          return 3
          ;;
        "gateway install")
          printf 'installed\\n'
          return 0
          ;;
        "gateway start")
          printf 'started\\n'
          return 0
          ;;
      esac
      return 99
    }
    if restart_gateway; then
      printf 'status=0\\n'
    else
      printf 'status=%s\\n' "$?"
    fi
  `);

  assert.match(output, /status=0/);
});

test('restart: returns install rc when repair install fails after restart reports service not loaded', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-restart-install-fail-'));
  const restartOutputFile = path.join(tempDir, 'restart.out');
  const callsFile = path.join(tempDir, 'calls.log');

  const output = runBash(`
    source "${corePath}"
    log() { :; }
    RESTART_OUTPUT_FILE="${restartOutputFile}"
    run_openclaw() {
      printf '%s %s\\n' "$1" "$2" >> "${callsFile}"
      case "$1 $2" in
        "gateway restart")
          printf 'service not loaded\\n'
          return 3
          ;;
        "gateway install")
          printf 'install failed\\n'
          return 11
          ;;
        "gateway start")
          printf 'started\\n'
          return 0
          ;;
      esac
      return 99
    }
    if restart_gateway; then
      printf 'status=0\\n'
    else
      printf 'status=%s\\n' "$?"
    fi
  `);

  assert.match(output, /status=11/);
  const calls = fs.readFileSync(callsFile, 'utf8');
  assert.match(calls, /gateway restart/);
  assert.match(calls, /gateway install/);
  assert.doesNotMatch(calls, /gateway start/);
});

test('restart: returns start rc when repair start fails after install succeeds', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-restart-start-fail-'));
  const restartOutputFile = path.join(tempDir, 'restart.out');

  const output = runBash(`
    source "${corePath}"
    log() { :; }
    RESTART_OUTPUT_FILE="${restartOutputFile}"
    run_openclaw() {
      case "$1 $2" in
        "gateway restart")
          printf 'service not loaded\\n'
          return 3
          ;;
        "gateway install")
          printf 'installed\\n'
          return 0
          ;;
        "gateway start")
          printf 'start failed\\n'
          return 17
          ;;
      esac
      return 99
    }
    if restart_gateway; then
      printf 'status=0\\n'
    else
      printf 'status=%s\\n' "$?"
    fi
  `);

  assert.match(output, /status=17/);
});

test('notify: watchdog_main reports install failure explicitly in restart_failed notification', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-notify-install-fail-'));
  const notificationsFile = path.join(tempDir, 'notifications.log');

  const output = runBash(`
    source "${corePath}"
    WATCHDOG_LOCK_DIR="${path.join(tempDir, 'gateway.lock')}"
    WATCHDOG_RUNTIME_TMP_DIR="${path.join(tempDir, 'tmp')}"
    LOG_FILE="${path.join(tempDir, 'watchdog.log')}"
    STATE_FILE="${path.join(tempDir, 'state.json')}"
    WATCHDOG_DISABLE_FILE="${path.join(tempDir, 'disabled')}"
    FAIL_THRESHOLD=1
    COOLDOWN_SEC=300
    POST_RESTART_RETRIES=2
    POST_RESTART_SLEEP_SEC=0
    WATCHDOG_ENABLED=1
    log() { :; }
    load_watchdog_config() { :; DISCORD_WEBHOOK_URL=""; FEISHU_WEBHOOK_URL=""; }
    load_notifier() { :; }
    notifier_init() { :; }
    notifier_cleanup() { :; }
    resolve_openclaw_bin() { OPENCLAW_BIN_RESOLVED="/bin/echo"; }
    resolve_node_bin() { NODE_BIN_RESOLVED=""; }
    notify_send() { printf '%s\\n' "$1" >> "${notificationsFile}"; }
    init_runtime_paths() {
      mkdir -p "$WATCHDOG_RUNTIME_TMP_DIR"
      RESTART_OUTPUT_FILE="$WATCHDOG_RUNTIME_TMP_DIR/restart.out"
      NOTIFY_OUTPUT_FILE="$WATCHDOG_RUNTIME_TMP_DIR/notify.out"
    }
    ensure_state() { :; }
    read_state_field() {
      case "$1" in
        ".consecutive_failures"|".cooldown_until_epoch") printf '0\\n' ;;
        *) printf '\\n' ;;
      esac
    }
    write_state() { cat >/dev/null; }
    probe_gateway() {
      if [[ ! -f "${path.join(tempDir, 'probe-once')}" ]]; then
        : > "${path.join(tempDir, 'probe-once')}"
        printf 'fail\\n'
      else
        printf 'fail\\n'
      fi
    }
    run_openclaw() {
      case "$1 $2" in
        "gateway restart")
          printf 'service not loaded\\n'
          return 3
          ;;
        "gateway install")
          printf 'install failed\\n'
          return 11
          ;;
      esac
      return 99
    }
    watchdog_main
    cat "${notificationsFile}"
  `);

  assert.match(output, /\[OpenClaw Gateway Watchdog\] 自动重启已触发/);
  assert.match(output, /reason=gateway_status_unhealthy action=restart_gateway/);
  assert.match(output, /\[OpenClaw Gateway Watchdog\] 自动重启失败/);
  assert.match(output, /gateway_install_failed - gateway install failed/);
});

test('notify: watchdog_main preserves probe reason when openclaw status command fails', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-notify-status-fail-'));
  const notificationsFile = path.join(tempDir, 'notifications.log');

  const output = runBash(`
    source "${corePath}"
    WATCHDOG_LOCK_DIR="${path.join(tempDir, 'gateway.lock')}"
    WATCHDOG_RUNTIME_TMP_DIR="${path.join(tempDir, 'tmp')}"
    LOG_FILE="${path.join(tempDir, 'watchdog.log')}"
    STATE_FILE="${path.join(tempDir, 'state.json')}"
    WATCHDOG_DISABLE_FILE="${path.join(tempDir, 'disabled')}"
    FAIL_THRESHOLD=1
    COOLDOWN_SEC=300
    POST_RESTART_RETRIES=1
    POST_RESTART_SLEEP_SEC=0
    WATCHDOG_ENABLED=1
    log() { :; }
    load_watchdog_config() { :; DISCORD_WEBHOOK_URL=""; FEISHU_WEBHOOK_URL=""; }
    load_notifier() { :; }
    notifier_init() { :; }
    notifier_cleanup() { :; }
    resolve_openclaw_bin() { OPENCLAW_BIN_RESOLVED="/bin/echo"; }
    resolve_node_bin() { NODE_BIN_RESOLVED=""; }
    notify_send() { printf '%s\\n' "$1" >> "${notificationsFile}"; }
    init_runtime_paths() {
      mkdir -p "$WATCHDOG_RUNTIME_TMP_DIR"
      RESTART_OUTPUT_FILE="$WATCHDOG_RUNTIME_TMP_DIR/restart.out"
      NOTIFY_OUTPUT_FILE="$WATCHDOG_RUNTIME_TMP_DIR/notify.out"
    }
    ensure_state() { :; }
    read_state_field() {
      case "$1" in
        ".consecutive_failures"|".cooldown_until_epoch") printf '0\\n' ;;
        *) printf '\\n' ;;
      esac
    }
    write_state() { cat >/dev/null; }
    run_openclaw() {
      case "$1 $2" in
        "gateway status")
          printf 'gateway status failed\\n' >&2
          return 2
          ;;
        "gateway restart")
          printf 'restarted\\n'
          return 0
          ;;
      esac
      return 99
    }
    watchdog_main
    cat "${notificationsFile}"
  `);

  assert.match(output, /故障环节: OpenClaw CLI \/ gateway status/);
  assert.match(output, /reason=openclaw_status_failed action=restart_gateway/);
});

test('notify: watchdog_main reports start failure explicitly in restart_failed notification', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-notify-start-fail-'));
  const notificationsFile = path.join(tempDir, 'notifications.log');

  const output = runBash(`
    source "${corePath}"
    WATCHDOG_LOCK_DIR="${path.join(tempDir, 'gateway.lock')}"
    WATCHDOG_RUNTIME_TMP_DIR="${path.join(tempDir, 'tmp')}"
    LOG_FILE="${path.join(tempDir, 'watchdog.log')}"
    STATE_FILE="${path.join(tempDir, 'state.json')}"
    WATCHDOG_DISABLE_FILE="${path.join(tempDir, 'disabled')}"
    FAIL_THRESHOLD=1
    COOLDOWN_SEC=300
    POST_RESTART_RETRIES=2
    POST_RESTART_SLEEP_SEC=0
    WATCHDOG_ENABLED=1
    log() { :; }
    load_watchdog_config() { :; DISCORD_WEBHOOK_URL=""; FEISHU_WEBHOOK_URL=""; }
    load_notifier() { :; }
    notifier_init() { :; }
    notifier_cleanup() { :; }
    resolve_openclaw_bin() { OPENCLAW_BIN_RESOLVED="/bin/echo"; }
    resolve_node_bin() { NODE_BIN_RESOLVED=""; }
    notify_send() { printf '%s\\n' "$1" >> "${notificationsFile}"; }
    init_runtime_paths() {
      mkdir -p "$WATCHDOG_RUNTIME_TMP_DIR"
      RESTART_OUTPUT_FILE="$WATCHDOG_RUNTIME_TMP_DIR/restart.out"
      NOTIFY_OUTPUT_FILE="$WATCHDOG_RUNTIME_TMP_DIR/notify.out"
    }
    ensure_state() { :; }
    read_state_field() {
      case "$1" in
        ".consecutive_failures"|".cooldown_until_epoch") printf '0\\n' ;;
        *) printf '\\n' ;;
      esac
    }
    write_state() { cat >/dev/null; }
    probe_gateway() { printf 'fail\\n'; }
    run_openclaw() {
      case "$1 $2" in
        "gateway restart")
          printf 'service not loaded\\n'
          return 3
          ;;
        "gateway install")
          printf 'installed\\n'
          return 0
          ;;
        "gateway start")
          printf 'start failed\\n'
          return 17
          ;;
      esac
      return 99
    }
    watchdog_main
    cat "${notificationsFile}"
  `);

  assert.match(output, /\[OpenClaw Gateway Watchdog\] 自动重启已触发/);
  assert.match(output, /reason=gateway_status_unhealthy action=restart_gateway/);
  assert.match(output, /\[OpenClaw Gateway Watchdog\] 自动重启失败/);
  assert.match(output, /gateway_start_failed - gateway start failed/);
});

test('notify: watchdog_main reports recovery timeout explicitly after a clean restart rc', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-notify-recovery-timeout-'));
  const notificationsFile = path.join(tempDir, 'notifications.log');

  const output = runBash(`
    source "${corePath}"
    WATCHDOG_LOCK_DIR="${path.join(tempDir, 'gateway.lock')}"
    WATCHDOG_RUNTIME_TMP_DIR="${path.join(tempDir, 'tmp')}"
    LOG_FILE="${path.join(tempDir, 'watchdog.log')}"
    STATE_FILE="${path.join(tempDir, 'state.json')}"
    WATCHDOG_DISABLE_FILE="${path.join(tempDir, 'disabled')}"
    FAIL_THRESHOLD=1
    COOLDOWN_SEC=300
    POST_RESTART_RETRIES=2
    POST_RESTART_SLEEP_SEC=0
    WATCHDOG_ENABLED=1
    log() { :; }
    load_watchdog_config() { :; DISCORD_WEBHOOK_URL=""; FEISHU_WEBHOOK_URL=""; }
    load_notifier() { :; }
    notifier_init() { :; }
    notifier_cleanup() { :; }
    resolve_openclaw_bin() { OPENCLAW_BIN_RESOLVED="/bin/echo"; }
    resolve_node_bin() { NODE_BIN_RESOLVED=""; }
    notify_send() { printf '%s\\n' "$1" >> "${notificationsFile}"; }
    init_runtime_paths() {
      mkdir -p "$WATCHDOG_RUNTIME_TMP_DIR"
      RESTART_OUTPUT_FILE="$WATCHDOG_RUNTIME_TMP_DIR/restart.out"
      NOTIFY_OUTPUT_FILE="$WATCHDOG_RUNTIME_TMP_DIR/notify.out"
    }
    ensure_state() { :; }
    read_state_field() {
      case "$1" in
        ".consecutive_failures"|".cooldown_until_epoch") printf '0\\n' ;;
        *) printf '\\n' ;;
      esac
    }
    write_state() { cat >/dev/null; }
    probe_gateway() {
      if [[ ! -f "${path.join(tempDir, 'probe-once')}" ]]; then
        : > "${path.join(tempDir, 'probe-once')}"
        printf 'fail\\n'
      else
        printf 'fail\\n'
      fi
    }
    run_openclaw() {
      case "$1 $2" in
        "gateway restart")
          printf 'restarted\\n'
          return 0
          ;;
      esac
      return 99
    }
    watchdog_main
    cat "${notificationsFile}"
  `);

  assert.match(output, /\[OpenClaw Gateway Watchdog\] 自动重启已触发/);
  assert.match(output, /reason=gateway_status_unhealthy action=restart_gateway/);
  assert.match(output, /\[OpenClaw Gateway Watchdog\] 自动重启失败/);
  assert.match(output, /recovery_timeout - 重启命令返回后健康检查仍未恢复/);
});

test('notify: watchdog_main reports restart succeeded when final recovery grace catches a late ok after neutral probes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-notify-recovery-grace-'));
  const notificationsFile = path.join(tempDir, 'notifications.log');
  const probeCountFile = path.join(tempDir, 'probe-count');

  const output = runBash(`
    source "${corePath}"
    WATCHDOG_LOCK_DIR="${path.join(tempDir, 'gateway.lock')}"
    WATCHDOG_RUNTIME_TMP_DIR="${path.join(tempDir, 'tmp')}"
    LOG_FILE="${path.join(tempDir, 'watchdog.log')}"
    STATE_FILE="${path.join(tempDir, 'state.json')}"
    WATCHDOG_DISABLE_FILE="${path.join(tempDir, 'disabled')}"
    FAIL_THRESHOLD=1
    COOLDOWN_SEC=300
    POST_RESTART_RETRIES=2
    POST_RESTART_SLEEP_SEC=0
    WATCHDOG_ENABLED=1
    log() { :; }
    load_watchdog_config() { :; DISCORD_WEBHOOK_URL=""; FEISHU_WEBHOOK_URL=""; }
    load_notifier() { :; }
    notifier_init() { :; }
    notifier_cleanup() { :; }
    resolve_openclaw_bin() { OPENCLAW_BIN_RESOLVED="/bin/echo"; }
    resolve_node_bin() { NODE_BIN_RESOLVED=""; }
    notify_send() { printf '%s\\n' "$1" >> "${notificationsFile}"; }
    init_runtime_paths() {
      mkdir -p "$WATCHDOG_RUNTIME_TMP_DIR"
      RESTART_OUTPUT_FILE="$WATCHDOG_RUNTIME_TMP_DIR/restart.out"
      NOTIFY_OUTPUT_FILE="$WATCHDOG_RUNTIME_TMP_DIR/notify.out"
    }
    ensure_state() { :; }
    read_state_field() {
      case "$1" in
        ".consecutive_failures"|".cooldown_until_epoch") printf '0\\n' ;;
        *) printf '\\n' ;;
      esac
    }
    write_state() { cat >/dev/null; }
    sleep() { :; }
    probe_gateway() {
      local count
      count="$(cat "${probeCountFile}" 2>/dev/null || printf '0')"
      count=$((count + 1))
      printf '%s\\n' "$count" > "${probeCountFile}"
      case "$count" in
        1) printf 'fail\\n' ;;
        2|3) printf 'neutral\\n' ;;
        4) printf 'ok\\n' ;;
        *) printf 'fail\\n' ;;
      esac
    }
    run_openclaw() {
      case "$1 $2" in
        "gateway restart")
          printf 'restarted\\n'
          return 0
          ;;
      esac
      return 99
    }
    watchdog_main
    printf '\\nprobe_calls=%s\\n' "$(cat "${probeCountFile}")"
    cat "${notificationsFile}"
  `);

  assert.match(output, /probe_calls=4/);
  assert.match(output, /\[OpenClaw Gateway Watchdog\] 自动重启已触发/);
  assert.match(output, /reason=gateway_status_unhealthy action=restart_gateway/);
  assert.match(output, /\[OpenClaw Gateway Watchdog\] 自动重启已恢复/);
  assert.doesNotMatch(output, /recovery timed out/);
});

test('lock: stale lock is reaped and reacquired before taking ownership', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-lock-stale-'));
  const lockDir = path.join(tempDir, 'gateway.lock');

  const output = runBash(`
    source "${corePath}"
    log() { :; }
    WATCHDOG_LOCK_DIR="${lockDir}"
    WATCHDOG_LOCK_STALE_SEC=1
    mkdir -p "$WATCHDOG_LOCK_DIR"
    printf '999999\\n' > "$WATCHDOG_LOCK_DIR/pid"
    printf '0\\n' > "$WATCHDOG_LOCK_DIR/started_at"
    if acquire_watchdog_lock; then
      result=acquired
    else
      result=locked
    fi
    printf 'result=%s pid=%s\\n' "$result" "$(cat "$WATCHDOG_LOCK_DIR/pid")"
  `);

  assert.match(output, /result=acquired/);
  assert.doesNotMatch(output, /pid=999999/);
});

test('lock: orphaned lock dir without metadata is reaped after staleness threshold', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-lock-orphaned-'));
  const lockDir = path.join(tempDir, 'gateway.lock');

  fs.mkdirSync(lockDir, { recursive: true });
  fs.utimesSync(lockDir, new Date(0), new Date(0));

  const output = runBash(`
    source "${corePath}"
    log() { :; }
    WATCHDOG_LOCK_DIR="${lockDir}"
    WATCHDOG_LOCK_STALE_SEC=1
    if acquire_watchdog_lock; then
      result=acquired
    else
      result=locked
    fi
    printf 'result=%s\\n' "$result"
  `);

  assert.match(output, /result=acquired/);
});

test('lock: second instance logs watchdog_locked and exits without taking lock', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-lock-contended-'));
  const lockDir = path.join(tempDir, 'gateway.lock');
  const logFile = path.join(tempDir, 'watchdog.log');

  const output = runBash(`
    source "${corePath}"
    LOG_FILE="${logFile}"
    mkdir -p "$(dirname "$LOG_FILE")"
    touch "$LOG_FILE"
    WATCHDOG_LOCK_DIR="${lockDir}"
    acquire_lock
    if acquire_watchdog_lock; then
      result=acquired
    else
      result=locked
    fi
    printf 'result=%s\\n' "$result"
    cat "$LOG_FILE"
  `);

  assert.match(output, /result=locked/);
  assert.match(output, /event=watchdog_locked/);
});

test('cleanup: watchdog_main releases lock when state write fails after lock acquisition', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-cleanup-trap-'));
  const lockDir = path.join(tempDir, 'gateway.lock');
  const result = spawnSync(
    '/bin/bash',
    [
      '-lc',
      `
        source "${corePath}"
        WATCHDOG_LOCK_DIR="${lockDir}"
        WATCHDOG_RUNTIME_TMP_DIR="${path.join(tempDir, 'tmp')}"
        LOG_FILE="${path.join(tempDir, 'watchdog.log')}"
        STATE_FILE="${path.join(tempDir, 'state.json')}"
        WATCHDOG_DISABLE_FILE="${path.join(tempDir, 'disabled')}"
        FAIL_THRESHOLD=3
        COOLDOWN_SEC=300
        POST_RESTART_RETRIES=1
        POST_RESTART_SLEEP_SEC=0
        WATCHDOG_ENABLED=1
        log() { :; }
        load_watchdog_config() { :; DISCORD_WEBHOOK_URL=""; FEISHU_WEBHOOK_URL=""; }
        load_notifier() { :; }
        notifier_init() { :; }
        notifier_cleanup() { :; }
        resolve_openclaw_bin() { OPENCLAW_BIN_RESOLVED="/bin/echo"; }
        resolve_node_bin() { NODE_BIN_RESOLVED=""; }
        probe_gateway() { printf 'ok\\n'; }
        init_runtime_paths() { :; }
        ensure_state() { :; }
        read_state_field() {
          case "$1" in
            ".consecutive_failures"|".cooldown_until_epoch") printf '0\\n' ;;
            *) printf '\\n' ;;
          esac
        }
        write_state() { return 1; }
        watchdog_main
      `,
    ],
    { encoding: 'utf8' },
  );

  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(lockDir), false);
});

test('state: write_state uses atomic temp file without leaving fixed .tmp artifact', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-state-'));
  const stateFile = path.join(tempDir, 'gateway_watchdog_state.json');

  runBash(`
    source "${corePath}"
    STATE_FILE="${stateFile}"
    init_state
    cat <<'JSON' | write_state
{"consecutive_failures":2,"last_ok_at":"ok","last_failure_at":"fail","last_restart_at":"restart","cooldown_until_epoch":123}
JSON
  `);

  const files = fs.readdirSync(tempDir);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

  assert.equal(state.consecutive_failures, 2);
  assert.equal(state.cooldown_until_epoch, 123);
  assert.ok(files.includes('gateway_watchdog_state.json'));
  assert.equal(files.some((file) => file.endsWith('.tmp')), false);
});

test('tmp: runtime temp files are created under watchdog runtime tmp dir', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-runtime-tmp-'));
  const runtimeTmpDir = path.join(tempDir, 'runtime-tmp');

  const output = runBash(`
    source "${corePath}"
    WATCHDOG_RUNTIME_TMP_DIR="${runtimeTmpDir}"
    init_runtime_paths
    printf 'restart=%s\\nnotify=%s\\n' "$RESTART_OUTPUT_FILE" "$NOTIFY_OUTPUT_FILE"
  `);

  assert.match(output, new RegExp(`restart=${runtimeTmpDir.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/restart\\.`));
  assert.match(output, new RegExp(`notify=${runtimeTmpDir.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/notify\\.`));
});

test('cleanup: empty temp-file variables do not delete matching hidden files from the current directory', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-cleanup-empty-'));
  const keepBody = path.join(tempDir, '.keep.body');
  const keepErr = path.join(tempDir, '.keep.err');

  fs.writeFileSync(keepBody, 'body\n');
  fs.writeFileSync(keepErr, 'err\n');

  runBash(`
    source "${corePath}"
    cd "${tempDir}"
    RESTART_OUTPUT_FILE=""
    NOTIFY_OUTPUT_FILE=""
    cleanup_runtime_paths
  `);

  assert.equal(fs.existsSync(keepBody), true);
  assert.equal(fs.existsSync(keepErr), true);
});

test('tmp: watchdog scripts no longer use fixed /tmp/gateway-watchdog paths', () => {
  const coreScript = readFile(corePath);
  const stateScript = readFile(statePath);

  assert.doesNotMatch(coreScript, /\/tmp\/gateway-watchdog-/);
  assert.doesNotMatch(stateScript, /\/tmp\/gateway-watchdog-/);
});

test('repo: public repo files contain no hard-coded private home paths outside explicit fixtures', () => {
  const privatePathNeedle = '/Users' + '/rael';
  const leakScan = spawnSync(
    'rg',
    [
      '--hidden',
      '-n',
      privatePathNeedle,
      '.',
      '--glob',
      '!tests/fixtures/gateway-status.sample.json',
      '--glob',
      '!.git/**',
    ],
    { cwd: watchdogDir, encoding: 'utf8' },
  );

  assert.equal(leakScan.status, 1, leakScan.stdout || leakScan.stderr);
  assert.equal(leakScan.stdout.trim(), '');
});
