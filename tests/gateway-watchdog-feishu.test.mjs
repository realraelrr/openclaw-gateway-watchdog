import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const launchdDir = path.join(repoRoot, 'launchd');

const core = fs.readFileSync(path.join(repoRoot, 'watchdog-core.sh'), 'utf8');
const discord = fs.readFileSync(path.join(repoRoot, 'notifiers', 'discord.sh'), 'utf8');
const feishu = fs.readFileSync(path.join(repoRoot, 'notifiers', 'feishu.sh'), 'utf8');
const composite = fs.readFileSync(path.join(repoRoot, 'notifiers', 'composite.sh'), 'utf8');
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const readmeZhCN = fs.readFileSync(path.join(repoRoot, 'README.zh-CN.md'), 'utf8');
const installLaunchAgent = fs.readFileSync(
  path.join(launchdDir, 'install-gateway-watchdog-launchagent.sh'),
  'utf8',
);
const plistTemplate = fs.readFileSync(
  path.join(launchdDir, 'ai.openclaw.gateway-watchdog.plist.template'),
  'utf8',
);

function countMatches(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function runBash(script, { env = {} } = {}) {
  return spawnSync('/bin/bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('notify: core loads notifier modules through whitelist case mapping', () => {
  assert.match(core, /load_notifier\(\) \{/);
  assert.match(core, /discord\)\s+notifier_file="\$SCRIPT_DIR\/notifiers\/discord\.sh"/);
  assert.match(core, /feishu\)\s+notifier_file="\$SCRIPT_DIR\/notifiers\/feishu\.sh"/);
  assert.match(core, /composite\)\s+notifier_file="\$SCRIPT_DIR\/notifiers\/composite\.sh"/);
  assert.match(core, /log WARN notifier_unknown "notifier=\$\{NOTIFIER:-unset\}"/);
});

test('discord: module defines notify_send with Discord payload and tightened timeout', () => {
  assert.match(discord, /notify_send\(\) \{/);
  assert.match(discord, /\{content:\$content\}/);
  assert.match(discord, /--connect-timeout 2 --max-time 4/);
});

test('feishu: module defines notify_send with Feishu payload and tightened timeout', () => {
  assert.match(feishu, /notify_send\(\) \{/);
  assert.match(feishu, /\{msg_type:"text",content:\{text:\$text\}\}/);
  assert.match(feishu, /--connect-timeout 2 --max-time 4/);
});

test('notify: provider modules keep provider-qualified temp files and provider logs', () => {
  assert.match(discord, /notify_body_file="\$\{NOTIFY_OUTPUT_FILE\}\.\$\{provider\}\.body"/);
  assert.match(discord, /notify_err_file="\$\{NOTIFY_OUTPUT_FILE\}\.\$\{provider\}\.err"/);
  assert.match(discord, /log ERROR notify_failed "provider=\$provider reason=transport/);
  assert.match(discord, /log ERROR notify_failed "provider=\$provider reason=http_status/);
  assert.match(discord, /log INFO notify_ok "provider=\$provider status=\$http_code"/);
  assert.match(feishu, /log ERROR notify_failed "provider=\$provider reason=transport/);
  assert.match(feishu, /log INFO notify_ok "provider=\$provider status=\$http_code"/);
});

test('composite: module sources both providers and aggregates success across them', () => {
  assert.match(composite, /source "\$SCRIPT_DIR\/notifiers\/discord\.sh"/);
  assert.match(composite, /source "\$SCRIPT_DIR\/notifiers\/feishu\.sh"/);
  assert.match(composite, /overall_success=1/);
  assert.match(composite, /if notify_discord "\$text"; then overall_success=0; fi/);
  assert.match(composite, /if notify_feishu "\$text"; then overall_success=0; fi/);
  assert.match(composite, /return "\$overall_success"/);
});

test('notify: watchdog restart flow uses the shared user-facing notification formatter', () => {
  assert.equal(countMatches(core, 'notify_send "$(format_notification'), 7);
  assert.doesNotMatch(core, /notify_send "\[WATCHDOG\]/);
  assert.doesNotMatch(core, /format_restart_failed_notification/);
  assert.equal(countMatches(core, 'notify_all "[WATCHDOG]'), 0);
  assert.equal(countMatches(core, 'notify_discord "[WATCHDOG]'), 0);
});

test('notify: core keeps no-op notifier defaults for fail-open startup', () => {
  assert.match(core, /notifier_init\(\) \{ return 0; \}/);
  assert.match(core, /notify_send\(\) \{ return 0; \}/);
  assert.match(core, /notifier_cleanup\(\) \{ return 0; \}/);
});

test('notify: README still documents product scope and Discord or Feishu delivery', () => {
  assert.match(readme, /Keep your local OpenClaw gateway recoverable on macOS/);
  assert.match(readme, /Sends Feishu and\/or Discord webhook notifications/);
  assert.match(readme, /FEISHU_WATCHDOG_WEBHOOK_URL/);
  assert.match(readme, /WATCHDOG_DISPLAY_NAME/);
  assert.match(readme, /bash gateway-watchdog\.sh restart gateway/);
  assert.match(readme, /gateway install failed/);
  assert.match(readme, /gateway start failed/);
  assert.match(readme, /recovery timed out/);
});

test('notify: README treats the private env file as the supported webhook secret source', () => {
  assert.match(readme, /Webhook URLs are secrets and should live in the private env file/);
  assert.doesNotMatch(readme, /LaunchAgent environment variables/);
});

test('docs: repository includes a Chinese README linked from the main README', () => {
  assert.match(readme, /\[中文文档\]\(\.\/README\.zh-CN\.md\)/);
  assert.match(readmeZhCN, /让你的本地 OpenClaw gateway 在 macOS 上更容易恢复/);
  assert.match(readmeZhCN, /\[English README\]\(\.\/README\.md\)/);
  assert.match(readmeZhCN, /FEISHU_WATCHDOG_WEBHOOK_URL/);
  assert.match(readmeZhCN, /bash gateway-watchdog\.sh restart gateway/);
  assert.match(readmeZhCN, /OpenClaw Gateway Watchdog/);
});

test('notify: LaunchAgent template no longer carries empty webhook placeholders', () => {
  assert.doesNotMatch(plistTemplate, /DISCORD_WATCHDOG_WEBHOOK_URL/);
  assert.doesNotMatch(plistTemplate, /FEISHU_WATCHDOG_WEBHOOK_URL/);
});

test('launchd: plist template uses placeholders instead of user-specific absolute paths', () => {
  assert.match(plistTemplate, /__WATCHDOG_SCRIPT_PATH__/);
  assert.match(plistTemplate, /__WATCHDOG_WORKING_DIR__/);
  assert.match(plistTemplate, /__WATCHDOG_ENV_FILE__/);
  assert.match(plistTemplate, /__WATCHDOG_LOG_FILE__/);
  assert.doesNotMatch(plistTemplate, /\/Users\/rael\/\.openclaw/);
});

test('launchd: install script derives repo-root watchdog paths instead of fixed user defaults', () => {
  assert.match(installLaunchAgent, /REPO_ROOT="\$\(cd "\$SCRIPT_DIR\/\.\." && pwd\)"/);
  assert.match(installLaunchAgent, /OPENCLAW_HOME="\$\{OPENCLAW_HOME:-\$HOME\/\.openclaw\}"/);
  assert.match(installLaunchAgent, /WATCHDOG_ENV_FILE="\$\{WATCHDOG_ENV_FILE:-\$OPENCLAW_HOME\/config\/watchdog\.env\}"/);
  assert.match(installLaunchAgent, /WATCHDOG_LOG_DIR="\$\{WATCHDOG_LOG_DIR:-\$OPENCLAW_HOME\/logs\}"/);
  assert.match(installLaunchAgent, /WATCHDOG_RUNTIME_DIR="\$\{WATCHDOG_RUNTIME_DIR:-\$OPENCLAW_HOME\/watchdog\/runtime\/current\}"/);
  assert.match(installLaunchAgent, /WATCHDOG_SCRIPT_PATH="\$WATCHDOG_RUNTIME_DIR\/gateway-watchdog\.sh"/);
  assert.match(installLaunchAgent, /sync_runtime_tree\(\)/);
  assert.doesNotMatch(installLaunchAgent, /WATCHDOG_ENV_FILE_DEFAULT="\/Users\/rael/);
});

test('launchd: install script renders plist and invokes launchctl bootstrap flow with derived paths', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-launchd-home-'));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-launchd-bin-'));
  const callsFile = path.join(tempHome, 'launchctl.calls');
  const expectedEnvFile = path.join(tempHome, '.openclaw', 'config', 'watchdog.env');
  const expectedLogFile = path.join(tempHome, '.openclaw', 'logs', 'gateway-watchdog.log');
  const expectedRuntimeDir = path.join(tempHome, '.openclaw', 'watchdog', 'runtime', 'current');
  const targetFile = path.join(tempHome, 'Library', 'LaunchAgents', 'ai.openclaw.gateway-watchdog.plist');

  fs.writeFileSync(
    path.join(fakeBinDir, 'launchctl'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${callsFile}"
exit 0
`,
    { mode: 0o755 },
  );

  const result = runBash(
    `"${path.join(launchdDir, 'install-gateway-watchdog-launchagent.sh')}"`,
    {
      env: {
        HOME: tempHome,
        PATH: `${fakeBinDir}:${process.env.PATH}`,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Installed:/);
  assert.equal(fs.existsSync(targetFile), true);
  assert.equal(fs.existsSync(path.join(tempHome, '.openclaw', 'logs')), true);
  const renderedPlist = fs.readFileSync(targetFile, 'utf8');
  assert.match(renderedPlist, new RegExp(expectedEnvFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(renderedPlist, new RegExp(expectedLogFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(renderedPlist, new RegExp(expectedRuntimeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.existsSync(path.join(expectedRuntimeDir, 'gateway-watchdog.sh')), true);
  assert.equal(fs.existsSync(path.join(expectedRuntimeDir, 'watchdog-core.sh')), true);
  assert.equal(fs.existsSync(path.join(expectedRuntimeDir, 'notifiers', 'feishu.sh')), true);
  const calls = fs.readFileSync(callsFile, 'utf8');
  assert.match(calls, /bootout gui\/\d+\/ai\.openclaw\.gateway-watchdog/);
  assert.match(calls, /bootstrap gui\/\d+ .*ai\.openclaw\.gateway-watchdog\.plist/);
  assert.match(calls, /kickstart -k gui\/\d+\/ai\.openclaw\.gateway-watchdog/);
});

test('notify: discord notifier succeeds against mocked webhook transport', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-discord-notify-'));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-discord-bin-'));
  const curlLog = path.join(tempDir, 'curl.log');
  const notifyBase = path.join(tempDir, 'notify');
  const logFile = path.join(tempDir, 'watchdog.log');

  fs.writeFileSync(
    path.join(fakeBinDir, 'curl'),
    `#!/usr/bin/env bash
out_file=""
while (($#)); do
  if [[ "$1" == "-o" ]]; then
    out_file="$2"
    shift 2
    continue
  fi
  shift
done
printf 'curl ok\\n' > "$out_file"
printf '%s\\n' "$*" >> "${curlLog}"
printf '204'
`,
    { mode: 0o755 },
  );

  const result = runBash(
    `
      source "${path.join(repoRoot, 'notifiers', 'discord.sh')}"
      LOG_FILE="${logFile}"
      NOTIFY_OUTPUT_FILE="${notifyBase}"
      DISCORD_WEBHOOK_URL="https://example.invalid/discord"
      log() { printf '%s %s %s %s\\n' "$1" "$2" "$3" "$4" >> "$LOG_FILE"; }
      if notify_send "hello discord"; then
        printf 'status=0\\n'
      else
        printf 'status=%s\\n' "$?"
      fi
    `,
    {
      env: {
        PATH: `${fakeBinDir}:${process.env.PATH}`,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status=0/);
  const log = fs.readFileSync(logFile, 'utf8');
  assert.match(log, /INFO notify_ok provider=discord status=204/);
  assert.equal(fs.existsSync(`${notifyBase}.discord.body`), true);
});

test('notify: feishu notifier records http-status failures against mocked webhook transport', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-feishu-notify-'));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-feishu-bin-'));
  const notifyBase = path.join(tempDir, 'notify');
  const logFile = path.join(tempDir, 'watchdog.log');

  fs.writeFileSync(
    path.join(fakeBinDir, 'curl'),
    `#!/usr/bin/env bash
out_file=""
while (($#)); do
  if [[ "$1" == "-o" ]]; then
    out_file="$2"
    shift 2
    continue
  fi
  shift
done
printf 'upstream failed\\n' > "$out_file"
printf '500'
`,
    { mode: 0o755 },
  );

  const result = runBash(
    `
      source "${path.join(repoRoot, 'notifiers', 'feishu.sh')}"
      LOG_FILE="${logFile}"
      NOTIFY_OUTPUT_FILE="${notifyBase}"
      FEISHU_WEBHOOK_URL="https://example.invalid/feishu"
      log() { printf '%s %s %s %s\\n' "$1" "$2" "$3" "$4" >> "$LOG_FILE"; }
      if notify_send "hello feishu"; then
        printf 'status=0\\n'
      else
        printf 'status=%s\\n' "$?"
      fi
    `,
    {
      env: {
        PATH: `${fakeBinDir}:${process.env.PATH}`,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status=1/);
  const log = fs.readFileSync(logFile, 'utf8');
  assert.match(log, /ERROR notify_failed provider=feishu reason=http_status status=500 summary=upstream_failed/);
});
