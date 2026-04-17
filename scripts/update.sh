#!/usr/bin/env bash
set -euo pipefail

echo "==> uno-reverse update script"

if ! command -v npm >/dev/null 2>&1; then
  echo "❌ npm is not installed."
  exit 1
fi

echo "==> Pulling latest code..."
git pull --ff-only || true

echo "==> Updating dependencies..."
npm update

echo "==> Running npm audit fix (best effort)..."
npm audit fix || true

echo "==> Restarting app cleanly..."
pkill -f "node .*server.js" || true
sleep 1
OLLAMA_PORT="${OLLAMA_PORT:-11435}" PANEL_PORT="${PANEL_PORT:-6741}" nohup npm start > ~/uno-reverse/uno-reverse.log 2>&1 &
sleep 1

echo "==> Health checks..."
curl -fsS "http://127.0.0.1:${PANEL_PORT:-6741}/health" || true
curl -fsS "http://127.0.0.1:${OLLAMA_PORT:-11435}/api/tags" || true

echo
echo "✅ Update complete."
echo "Control panel: http://localhost:${PANEL_PORT:-6741}"
echo "Fake Ollama:   http://localhost:${OLLAMA_PORT:-11435}"
echo "Log file:      ~/uno-reverse/uno-reverse.log"
