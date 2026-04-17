#!/bin/bash
# hard_restart_mac.sh — Force restart Antigravity on macOS
# Equivalent to hard_restart.ps1 on Windows.
#
# Usage: bash hard_restart_mac.sh <exec_path> [workspace_path]

EXEC_PATH="$1"
WORKSPACE_PATH="$2"

# Wait for 2 seconds to allow Feishu messages to be sent and extension to initiate shutdown
sleep 2

# Extract process name from the executable path
PROCESS_NAME=$(basename "$EXEC_PATH" | sed 's/\.[^.]*$//')

# Forcefully terminate all processes matching the executable name
echo "Force killing all processes named: $PROCESS_NAME"
pkill -9 -f "$PROCESS_NAME" 2>/dev/null || true

# Additional brief sleep to ensure OS fully releases resources
sleep 1

# Restart the application with the workspace path
if [ -z "$WORKSPACE_PATH" ]; then
    open "$EXEC_PATH"
else
    open "$EXEC_PATH" --args "$WORKSPACE_PATH"
fi
