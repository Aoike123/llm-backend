# Build step for the LLM image: route Qwen's vision tower to the CPU encoder service.
set -eu
here=/src/.workbench/runtime/cpu-vision
site=/usr/local/lib/python3.12/dist-packages
cp "$here/proxy.py" "$site/cpu_vision_proxy.py"
mkdir -p /opt/cpu-vision
cp "$here/server.py" /opt/cpu-vision/server.py
python3 -S "$here/patch.py"
python3 -S "$here/patch-profile.py"
echo "CPU vision proxy installed"
