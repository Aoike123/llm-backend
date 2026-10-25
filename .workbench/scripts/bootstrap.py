"""Restore pinned official repositories without resetting existing checkouts."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def patch_loopback():
    for model, variable in (("Wan2.2", "PAITON_WAN_PORT"), ("MiniMax-H3", "PAITON_H3_PORT")):
        path = ROOT / "engines/shared/paiton/upstream/models" / model / "compose.yaml"
        source = path.read_text()
        original = '0.0.0.0:${' + variable
        patched = '127.0.0.1:${' + variable
        if original in source:
            path.write_text(source.replace(original, patched))
        elif patched not in source:
            raise RuntimeError(f"上游 Compose 端口格式已变化：{path}")
        source=path.read_text()
        if '      USER: ai-workbench' not in source:
            path.write_text(source.replace('      HF_HUB_OFFLINE: \"1\"','      USER: ai-workbench\n      HOME: /data/user\n      TORCHINDUCTOR_CACHE_DIR: /data/cache/inductor\n      TRITON_CACHE_DIR: /data/cache/triton\n      XDG_CACHE_HOME: /data/cache/xdg\n      HF_HUB_OFFLINE: \"1\"'))
        source=path.read_text()
        marker='      HF_HUB_OFFLINE: "1"\n'
        additions='      HSA_ENABLE_SDMA: "0"\n      TORCH_BLAS_PREFER_HIPBLASLT: "0"\n'
        if '      HSA_ENABLE_SDMA:' not in source:
            if marker not in source:raise RuntimeError(f"上游 Compose 环境格式已变化：{path}")
            path.write_text(source.replace(marker,marker+additions))


def patch_model_alias():
    path = ROOT / "engines/shared/paiton/upstream/models/Qwen3.8-MXFP4-DFlash2/launch-rocm10.py"
    source = path.read_text()
    original = "'--served-model-name', 'Qwen3.8'"
    patched = "'--served-model-name', os.environ.get('PAITON_SERVED_MODEL_NAME', 'Qwen3.8')"
    if original in source:
        path.write_text(source.replace(original, patched))
    elif patched not in source:
        raise RuntimeError(f"上游 API 模型别名格式已变化：{path}")


def patch_local_runtime():
    models = ROOT / "engines/shared/paiton/upstream/models"
    path=models/'MiniMax-H3/Dockerfile.local'
    source=path.read_text()
    original='RUN python3 -m pip install --no-cache-dir --no-deps --target /opt/h3-deps'
    replacement='ARG PAITON_PIP_INDEX_URL=https://pypi.org/simple\nRUN python3 -m pip install --index-url ${PAITON_PIP_INDEX_URL} --no-cache-dir --no-deps --target /opt/h3-deps'
    if original in source:path.write_text(source.replace(original,replacement))
    for model in ["Wan2.2", "MiniMax-H3"]:
        path = models / model / "image.sh"
        source = path.read_text()
        path.write_text(source.replace('docker build --provenance=false', 'docker build'))
        path=models/model/'run.sh'
        source=path.read_text()
        marker='exec docker run --rm --init --device /dev/kfd --device /dev/dri \\\n'
        if '-e HSA_ENABLE_SDMA=0' not in source:
            assert marker in source,str(path)
            path.write_text(source.replace(marker,marker+'  -e "HF_HUB_OFFLINE=${HF_HUB_OFFLINE:-0}" -e HSA_ENABLE_SDMA=0 -e TORCH_BLAS_PREFER_HIPBLASLT=0 \\\n'))
    path=models/'Wan2.2/Dockerfile'
    source=path.read_text()
    original='FROM ghcr.io/eliovp/paiton-vllm-plugin@sha256:c56baf54aca1ad229829c1de26e8792806608e65ee9d06ee210b79cd49f70bc9'
    replacement='ARG PAITON_RUNTIME_BASE_IMAGE=ghcr.io/eliovp/paiton-vllm-plugin@sha256:c56baf54aca1ad229829c1de26e8792806608e65ee9d06ee210b79cd49f70bc9\nFROM ${PAITON_RUNTIME_BASE_IMAGE}'
    if original in source:path.write_text(source.replace(original,replacement))
    source=path.read_text()
    original='    VLLM_USE_PAITON_PLATFORM=0 VLLM_DISABLE_PAITON_PLATFORM=1 \\\n'
    replacement='    VLLM_USE_PAITON_PLATFORM=0 VLLM_DISABLE_PAITON_PLATFORM=1 PAITON_W3_A4=0 PAITON_W3_DECODE=0 PAITON_W3_PREFILL=0 \\\n'
    if original in source:path.write_text(source.replace(original,replacement))
    path=models/'Wan2.2/image.sh'
    source=path.read_text()
    original='docker build -t "$PAITON_WAN_BASE_IMAGE"'
    replacement='docker build --build-arg "PAITON_RUNTIME_BASE_IMAGE=${PAITON_RUNTIME_BASE_IMAGE:-ghcr.io/eliovp/paiton-vllm-plugin@sha256:c56baf54aca1ad229829c1de26e8792806608e65ee9d06ee210b79cd49f70bc9}" -t "$PAITON_WAN_BASE_IMAGE"'
    if original in source:path.write_text(source.replace(original,replacement))
    path = models / "FLUX.2-klein/compose.yaml"
    source=path.read_text()
    if '    HSA_ENABLE_SDMA:' not in source:
        path.write_text(source.replace('    HF_HUB_OFFLINE: "1"','    HF_HUB_OFFLINE: "1"\n    HSA_ENABLE_SDMA: "0"\n    TORCH_BLAS_PREFER_HIPBLASLT: "0"'))
    path = models / "FLUX.2-klein/launch.sh"
    source = path.read_text()
    original = '  "${compose[@]}" pull "${services[@]}"'
    replacement = '  if [[ "${PAITON_SKIP_PULL:-0}" != 1 ]]; then "${compose[@]}" pull "${services[@]}"; fi'
    if original in source:
        path.write_text(source.replace(original, replacement))
    elif replacement not in source:
        raise RuntimeError(f"上游镜像拉取格式已变化：{path}")
    path = models / 'Qwen3.8-MXFP4-DFlash2/launch-rocm10.py'
    source = path.read_text()
    original = "    name, _, digest = image.partition('@')"
    replacement = "    if image == os.environ.get('PAITON_FEATURE_IMAGE'):\n        image = os.environ['PAITON_FEATURE_BASE_IMAGE']\n" + original
    if replacement not in source:
        if original not in source:
            raise RuntimeError(f"上游镜像特征检测格式已变化：{path}")
        path.write_text(source.replace(original, replacement))


def main():
    lock = json.loads((ROOT / ".workbench/sources.lock.json").read_text())
    for name, info in lock.items():
        dest = ROOT / info.get("path", ".workbench/vendor/" + name)
        if not dest.exists():
            subprocess.run(["git", "clone", "--no-checkout", info["url"], str(dest)], check=True)
            subprocess.run(["git", "-C", str(dest), "checkout", "--detach", info["commit"]], check=True)
        else:
            revision = subprocess.check_output(["git", "-C", str(dest), "rev-parse", "HEAD"], text=True).strip()
            if revision != info["commit"]:
                raise RuntimeError(f"{name} 版本不匹配；保留现有文件，请先检查。")
        print(f"OK {name}: {info['commit']}")
    patch_loopback()
    patch_model_alias()
    patch_local_runtime()


if __name__ == "__main__":
    main()
