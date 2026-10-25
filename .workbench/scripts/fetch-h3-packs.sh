#!/usr/bin/env bash
# Restore the third-party ComfyUI node packs pinned in h3_packs/manifest.json (not tracked in Git).
set -euo pipefail
packs="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../platforms/comfyui/worker_nodes/h3_packs" && pwd)"
python3 -c 'import json,sys;[print(n,p["repository"],p["commit"]) for n,p in json.load(open(sys.argv[1]))["packs"].items()]' "$packs/manifest.json" |
while read -r name repository commit; do
  if [[ -d "$packs/$name" ]]; then echo "保留已有：$name"; continue; fi
  git clone --quiet --filter=blob:none "$repository" "$packs/$name"
  git -C "$packs/$name" checkout --quiet "$commit"
  echo "已获取：$name @ ${commit:0:7}"
done
