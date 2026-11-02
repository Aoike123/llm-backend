# Build step for the ComfyUI image: offline Python deps, pinned ComfyUI and frontend sources, H3 node.
set -eu
data=/src/workspace/data/runtime/comfy
h3=/src/engines/shared/paiton/upstream/models/MiniMax-H3
python3 -m pip install --no-cache-dir --no-index --find-links "$data/wheels" --no-deps --target /opt/h3-deps -r "$h3/requirements.lock.txt"
copy() { rm -rf "$2"; mkdir -p "$2"; tar -C "$1" --exclude=.git --exclude=__pycache__ --exclude=node_modules -cf - . | tar -C "$2" -xf -; }
copy /src/.workbench/vendor/comfyui /opt/comfyui
copy "$data/frontend" /opt/comfyui-frontend-source
copy "$h3/comfyui/paiton_h3" /opt/comfyui/custom_nodes/paiton_h3
copy "$h3/comfyui/workflows" /opt/comfyui/custom_nodes/paiton_h3/example_workflows
echo "ComfyUI assembled"
