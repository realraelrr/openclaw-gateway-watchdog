#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE_FILE="$SCRIPT_DIR/ai.openclaw.gateway-watchdog.plist.template"
TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET_FILE="$TARGET_DIR/ai.openclaw.gateway-watchdog.plist"
SERVICE_LABEL="gui/$(id -u)/ai.openclaw.gateway-watchdog"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
WATCHDOG_ENV_FILE="${WATCHDOG_ENV_FILE:-$OPENCLAW_HOME/config/watchdog.env}"
WATCHDOG_LOG_DIR="${WATCHDOG_LOG_DIR:-$OPENCLAW_HOME/logs}"
WATCHDOG_LOG_FILE="$WATCHDOG_LOG_DIR/gateway-watchdog.log"
WATCHDOG_SCRIPT_PATH="$REPO_ROOT/gateway-watchdog.sh"

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[&]/\\&/g'
}

if [[ ! -f "$TEMPLATE_FILE" ]]; then
  echo "Template not found: $TEMPLATE_FILE" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR" "$WATCHDOG_LOG_DIR"
sed \
  -e "s|__WATCHDOG_SCRIPT_PATH__|$(escape_sed_replacement "$WATCHDOG_SCRIPT_PATH")|g" \
  -e "s|__WATCHDOG_ENV_FILE__|$(escape_sed_replacement "$WATCHDOG_ENV_FILE")|g" \
  -e "s|__WATCHDOG_LOG_FILE__|$(escape_sed_replacement "$WATCHDOG_LOG_FILE")|g" \
  "$TEMPLATE_FILE" > "$TARGET_FILE"

launchctl bootout "$SERVICE_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$TARGET_FILE"
launchctl kickstart -k "$SERVICE_LABEL"

echo "Installed: $TARGET_FILE"
echo "Service: $SERVICE_LABEL"
echo "WATCHDOG_ENV_FILE: $WATCHDOG_ENV_FILE"
echo "WATCHDOG_LOG_FILE: $WATCHDOG_LOG_FILE"
