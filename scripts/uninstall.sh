#!/usr/bin/env bash
set -euo pipefail

echo "==> uno-reverse uninstall script"
echo "==> Removing installed artifacts..."

rm -rf node_modules
rm -f package-lock.json

echo "✅ Removed node_modules and package-lock.json"
echo "Project source files were kept."
