#!/usr/bin/env bash
set -euo pipefail

echo "==> uno-reverse update script"

if ! command -v npm >/dev/null 2>&1; then
  echo "❌ npm is not installed."
  exit 1
fi

echo "==> Updating dependencies..."
npm update

echo "==> Running npm audit fix (best effort)..."
npm audit fix || true

echo "✅ Update complete."
echo "Tip: run tests / smoke checks after updating."
