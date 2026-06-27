#!/bin/bash
# flash-edl.sh — Detect all boards in Qualcomm EDL mode and flash them.
#
# Can be run standalone from the terminal or called by the web app.
# Requires: arduino-flasher-cli (in the same directory as this script)
#           system_profiler (macOS built-in)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLASHER_CLI="$SCRIPT_DIR/arduino-flasher-cli"
TEMP_DIR="$SCRIPT_DIR/.flash-tmp"

# ── Sanity checks ──────────────────────────────────────────────────────────────
if [ ! -x "$FLASHER_CLI" ]; then
    echo "ERROR: arduino-flasher-cli not found or not executable at $FLASHER_CLI"
    exit 1
fi

if ! command -v system_profiler > /dev/null 2>&1; then
    echo "ERROR: system_profiler not found — EDL device detection requires macOS."
    exit 1
fi

# ── Find local image or fall back to 'latest' ──────────────────────────────────
LOCAL_IMAGE=$(ls -t "$SCRIPT_DIR"/arduino-unoq-debian-image-* 2>/dev/null | head -1)
if [ -n "$LOCAL_IMAGE" ]; then
    echo "Local image: $LOCAL_IMAGE"
    FLASH_TARGET="$LOCAL_IMAGE"
else
    echo "No local image found — will download latest."
    FLASH_TARGET="latest"
fi

# ── Detect EDL devices ─────────────────────────────────────────────────────────
echo ""
echo "Detecting EDL devices (USB Product ID 0x9008)..."

SERIALS=$(
    system_profiler SPUSBHostDataType 2>/dev/null \
    | grep -B 15 "USB Product ID: 0x9008" \
    | grep -oE 'SN:[0-9A-Fa-f]+' \
    | sed 's/SN://' \
    | tr '[:lower:]' '[:upper:]' \
    | sort -u
)

if [ -z "$SERIALS" ]; then
    echo "No EDL devices found. Put boards in EDL mode and try again."
    exit 1
fi

COUNT=$(echo "$SERIALS" | wc -l | tr -d ' ')
echo "Found $COUNT board(s) in EDL mode:"
while IFS= read -r S; do
    echo "  $S"
done <<< "$SERIALS"

# ── Flash each board ───────────────────────────────────────────────────────────
mkdir -p "$TEMP_DIR"
FAILED=0
SUCCESS=0

while IFS= read -r SERIAL; do
    echo ""
    echo "════════════════════════════════════════"
    echo "Flashing $SERIAL..."
    CMD="$FLASHER_CLI flash $FLASH_TARGET --serial $SERIAL --yes --temp-dir $TEMP_DIR"
    echo "$ $CMD"
    echo ""
    if $CMD; then
        echo ""
        echo "✓ $SERIAL — flashed successfully"
        SUCCESS=$((SUCCESS + 1))
    else
        RC=$?
        echo ""
        echo "✗ $SERIAL — FAILED (exit $RC)"
        FAILED=$((FAILED + 1))
    fi
done <<< "$SERIALS"

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
echo "Done: $SUCCESS succeeded, $FAILED failed."
[ "$FAILED" -eq 0 ]
