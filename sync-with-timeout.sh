#!/usr/bin/env bash
#
# sync-with-timeout.sh - Wrapper for granola-obsidian-sync with timeout protection
#
# This script prevents the sync from hanging indefinitely by:
# 1. Running the sync with a timeout (default 10 minutes)
# 2. Killing any stuck processes
# 3. Logging the outcome
# 4. Sending error notifications via Pushover/Slack on failure
#

set -uo pipefail

# Source shared notification library
NOTIFY_LIB="$HOME/.config/josh-automations/notify.sh"
if [[ -f "$NOTIFY_LIB" ]]; then
    source "$NOTIFY_LIB"
fi

# Configuration
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SYNC_SCRIPT="$SCRIPT_DIR/sync.ts"
readonly BUN_PATH="/Users/joshroman/.bun/bin/bun"
readonly LOG_FILE="$SCRIPT_DIR/logs/obsidian-sync.log"
readonly TIMEOUT_SECONDS=${SYNC_TIMEOUT:-600}  # 10 minutes default
readonly LOCK_FILE="/tmp/granola-obsidian-sync.lock"

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

log() {
    local timestamp=$(TZ='America/New_York' date '+%Y-%m-%d %H:%M:%S %Z')
    echo "[$timestamp] $1" | tee -a "$LOG_FILE"
}

# Check for stale lock file (process died without cleanup)
check_stale_lock() {
    if [[ -f "$LOCK_FILE" ]]; then
        local pid=$(cat "$LOCK_FILE" 2>/dev/null)
        if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
            log "CLEANUP: Removing stale lock file (PID $pid no longer running)"
            rm -f "$LOCK_FILE"
        fi
    fi
}

# Cleanup function
cleanup() {
    rm -f "$LOCK_FILE"
}
trap cleanup EXIT

# Main execution
main() {
    check_stale_lock

    # Check if already running
    if [[ -f "$LOCK_FILE" ]]; then
        local existing_pid=$(cat "$LOCK_FILE" 2>/dev/null)
        if kill -0 "$existing_pid" 2>/dev/null; then
            log "SKIP: Sync already running (PID $existing_pid)"

            # Check if it's been running too long (stuck)
            local lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || echo 0) ))
            if [[ $lock_age -gt $TIMEOUT_SECONDS ]]; then
                log "TIMEOUT: Previous sync stuck for ${lock_age}s (> ${TIMEOUT_SECONDS}s). Killing PID $existing_pid"
                kill -9 "$existing_pid" 2>/dev/null || true
                # Also kill any child bun processes
                pkill -9 -P "$existing_pid" 2>/dev/null || true
                rm -f "$LOCK_FILE"
                sleep 2
            else
                exit 0
            fi
        fi
    fi

    # Write our PID
    echo $$ > "$LOCK_FILE"

    cd "$SCRIPT_DIR"

    log "Starting sync (timeout: ${TIMEOUT_SECONDS}s)..."

    # Run sync with timeout using background process + wait
    "$BUN_PATH" "$SYNC_SCRIPT" &
    local sync_pid=$!

    # Update lock file with actual sync PID
    echo "$sync_pid" > "$LOCK_FILE"

    local elapsed=0
    local check_interval=5

    while kill -0 "$sync_pid" 2>/dev/null; do
        sleep $check_interval
        elapsed=$((elapsed + check_interval))

        if [[ $elapsed -ge $TIMEOUT_SECONDS ]]; then
            log "TIMEOUT: Sync exceeded ${TIMEOUT_SECONDS}s. Killing PID $sync_pid"
            kill -9 "$sync_pid" 2>/dev/null || true
            # Kill any child processes
            pkill -9 -P "$sync_pid" 2>/dev/null || true
            send_error_notification "Granola → Obsidian Sync" "Sync timed out after ${TIMEOUT_SECONDS}s"
            exit 1
        fi
    done

    # Get exit code
    wait "$sync_pid"
    local exit_code=$?

    if [[ $exit_code -eq 0 ]]; then
        log "Sync completed successfully"
    else
        log "Sync failed with exit code $exit_code"
        local last_error=$(tail -5 "$LOG_FILE" 2>/dev/null | grep -v "^\[" | head -1 || echo "Exit code $exit_code")
        send_error_notification "Granola → Obsidian Sync" "Sync failed: $last_error"
    fi

    return $exit_code
}

main "$@"
