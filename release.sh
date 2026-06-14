#!/usr/bin/env bash
# Build + dual-publish the extension. One .vsix reaches the whole VS Code family:
# - VS Code Marketplace (official MS VS Code)        → needs VSCE_PAT
# - Open VSX (Cursor, Windsurf, Antigravity, …forks) → needs OVSX_PAT
set -euo pipefail

npm run compile
npx @vscode/vsce package

echo "▸ Publishing to VS Code Marketplace…"
npx @vscode/vsce publish

echo "▸ Publishing to Open VSX (covers Cursor / Windsurf / Antigravity / forks)…"
npx ovsx publish ./*.vsix

echo "✓ Published to both registries."
