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
        "NOTIFIER=$NOTIFIER"
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

test('retries: POST_RESTART_RETRIES drives recovery loop count', () => {
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
