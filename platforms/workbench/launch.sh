#!/usr/bin/env bash
set -euo pipefail
workbench_app="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
workbench_node="${WORKBENCH_NODE:-$(command -v node || true)}"
if [[ -z "$workbench_node" ]] || ! "$workbench_node" -e 'process.exit((() => { const [a,b] = process.versions.node.split(".").map(Number); return a > 22 || a === 22 && b >= 19; })() ? 0 : 1)'; then
  workbench_node=""
  for candidate in "$HOME"/.nvm/versions/node/v*/bin/node; do
    if [[ -x "$candidate" ]] && "$candidate" -e 'process.exit((() => { const [a,b] = process.versions.node.split(".").map(Number); return a > 22 || a === 22 && b >= 19; })() ? 0 : 1)'; then workbench_node="$candidate"; fi
  done
fi
if [[ -z "$workbench_node" ]]; then echo 'Node.js >=22.19 required. Set WORKBENCH_NODE to its absolute path.' >&2; exit 1; fi
export NODE_ENV=production
exec "$workbench_node" "$workbench_app/server.mjs"
