#!/usr/bin/env bash
set -euo pipefail
mcp_app="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mcp_node="${WORKBENCH_NODE:-$(command -v node || true)}"
if [[ -z "$mcp_node" ]] || ! "$mcp_node" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||a===22&&b>=19?0:1)'; then
  mcp_node=""
  for candidate in "$HOME"/.nvm/versions/node/v*/bin/node; do
    if [[ -x "$candidate" ]] && "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||a===22&&b>=19?0:1)'; then mcp_node="$candidate"; fi
  done
fi
if [[ -z "$mcp_node" ]]; then echo 'Node.js >=22.19 required; set WORKBENCH_NODE.' >&2; exit 1; fi
exec "$mcp_node" "$mcp_app/cli.mjs" "$@"
