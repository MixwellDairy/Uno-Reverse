#!/usr/bin/env bash
set -euo pipefail

echo "==> uno-reverse install script"
echo "==> Checking requirements..."

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is not installed. Please install Node.js 18+."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "❌ npm is not installed. Please install npm 9+."
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "${NODE_MAJOR}" -lt 18 ]; then
  echo "❌ Node.js 18+ is required. Found: $(node -v)"
  exit 1
fi

echo "✅ Node: $(node -v)"
echo "✅ npm:  $(npm -v)"
echo "==> Installing dependencies..."

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

echo "✅ Install complete."
echo "Run: npm start"
