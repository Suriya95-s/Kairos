#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
#  tui.sh — launch the Kairos TUI
#
#  Usage:
#    ./tui.sh                 # use settings below
#    ./tui.sh --port 5180
#    ./tui.sh --compact
#
#  Edit the LOCAL MODEL section below to match your setup, then just run:
#    bash tui.sh
# ──────────────────────────────────────────────────────────────────────────────

# ── LOCAL MODEL ───────────────────────────────────────────────────────────────
# Uncomment the block that matches your local server.

# Ollama (http://localhost:11434)
export AGENT_BASE_URL="http://localhost:11434/v1"
export AGENT_MODEL="qwen2.5-coder:32b"
export AGENT_API_KEY="ollama"

# LM Studio (http://localhost:1234)
# export AGENT_BASE_URL="http://localhost:1234/v1"
# export AGENT_MODEL="qwen2.5-coder-32b-instruct"
# export AGENT_API_KEY="lm-studio"

# vLLM (http://localhost:8000)
# export AGENT_BASE_URL="http://localhost:8000/v1"
# export AGENT_MODEL="qwen3-coder-30b"
# export AGENT_NO_THINKING=1

# llama.cpp server (http://localhost:8080)
# export AGENT_BASE_URL="http://localhost:8080/v1"
# export AGENT_MODEL="qwen2.5-coder-32b"

# ── TUI PORT ──────────────────────────────────────────────────────────────────
TUI_PORT="${TUI_PORT:-5180}"

# ── PATHS ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TUI_DIR="$SCRIPT_DIR/apps/tui"

# ── CHECKS ────────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "ERROR: node is not installed or not in PATH"
  exit 1
fi

if [ ! -f "$TUI_DIR/index.js" ]; then
  echo "ERROR: $TUI_DIR/index.js not found"
  exit 1
fi

# ── LAUNCH ────────────────────────────────────────────────────────────────────
echo "Starting Kairos TUI on port $TUI_PORT..."
echo "Model : $AGENT_MODEL"
echo "Server: $AGENT_BASE_URL"
echo ""

exec node "$TUI_DIR/index.js" --port "$TUI_PORT" "$@"
