import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const watchdogDir = path.resolve(__dirname, '..');

const core = fs.readFileSync(path.join(watchdogDir, 'watchdog-core.sh'), 'utf8');
const discord = fs.readFileSync(path.join(watchdogDir, 'notifiers', 'discord.sh'), 'utf8');
const feishu = fs.readFileSync(path.join(watchdogDir, 'notifiers', 'feishu.sh'), 'utf8');
const composite = fs.readFileSync(path.join(watchdogDir, 'notifiers', 'composite.sh'), 'utf8');
const readme = fs.readFileSync(path.join(watchdogDir, 'README.md'), 'utf8');
const plistTemplate = fs.readFileSync(
  path.join(watchdogDir, 'ai.openclaw.gateway-watchdog.plist.template'),
  'utf8',
);

function countMatches(haystack, needle) {
  return haystack.split(needle).length - 1;
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

test('notify: watchdog restart flow now uses notify_send at the three alert call sites', () => {
  assert.equal(countMatches(core, 'notify_send "[WATCHDOG]'), 3);
  assert.equal(countMatches(core, 'notify_all "[WATCHDOG]'), 0);
  assert.equal(countMatches(core, 'notify_discord "[WATCHDOG]'), 0);
});

test('notify: core keeps no-op notifier defaults for fail-open startup', () => {
  assert.match(core, /notifier_init\(\) \{ return 0; \}/);
  assert.match(core, /notify_send\(\) \{ return 0; \}/);
  assert.match(core, /notifier_cleanup\(\) \{ return 0; \}/);
});

test('notify: README still documents Discord and Feishu delivery', () => {
  assert.match(readme, /Send Discord and\/or Feishu webhook notifications only for:/);
  assert.match(readme, /FEISHU_WATCHDOG_WEBHOOK_URL/);
});

test('notify: LaunchAgent template still exposes both webhook environment variables', () => {
  assert.match(plistTemplate, /<key>DISCORD_WATCHDOG_WEBHOOK_URL<\/key>/);
  assert.match(plistTemplate, /<key>FEISHU_WATCHDOG_WEBHOOK_URL<\/key>/);
});
