#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_FILE="$SCRIPT_DIR/ai.openclaw.gateway-watchdog.plist.template"
TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET_FILE="$TARGET_DIR/ai.openclaw.gateway-watchdog.plist"
SERVICE_LABEL="gui/$(id -u)/ai.openclaw.gateway-watchdog"
WATCHDOG_ENV_FILE_DEFAULT="/Users/rael/.openclaw/config/watchdog.env"

if [[ ! -f "$TEMPLATE_FILE" ]]; then
  echo "Template not found: $TEMPLATE_FILE" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
cp "$TEMPLATE_FILE" "$TARGET_FILE"

launchctl bootout "$SERVICE_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$TARGET_FILE"
launchctl kickstart -k "$SERVICE_LABEL"

echo "Installed: $TARGET_FILE"
echo "Service: $SERVICE_LABEL"
echo "WATCHDOG_ENV_FILE default: $WATCHDOG_ENV_FILE_DEFAULT"
