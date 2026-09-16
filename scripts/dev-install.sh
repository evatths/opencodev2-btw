#!/usr/bin/env bash
# Dev-install this checkout as a real plugin package in the OpenCode config
# directory. v2.0.3 only loads package plugins from real directories there —
# it silently skips symlinks — so we rsync the sources and point the copied
# package's node_modules back at this checkout (Node/Bun resolve through it).
# Re-run after source changes, then restart the service:
#   opencode service restart
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
dest="${OPENCODE_CONFIG:-$HOME/.config/opencode}/plugins/btw"

if [ ! -d "$repo/node_modules" ]; then
  echo "node_modules missing — run npm install first" >&2
  exit 1
fi

mkdir -p "$dest"
# Flatten src/ to the package root: the v2.0.3 local-dir loader resolves
# <dir>/index.ts directly (exports-driven src/ resolution came later).
rsync -a --delete "$repo/src/" "$dest/"
# package.json with flat exports to match the flattened layout.
sed 's#\./src/#./#g' "$repo/package.json" > "$dest/package.json"
ln -sfn "$repo/node_modules" "$dest/node_modules"
echo "Installed: $dest -> $repo (restart opencode service to reload)"
