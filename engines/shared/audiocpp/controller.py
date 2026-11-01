#!/usr/bin/env python3
"""audio.cpp runtime shared by the audio engine packages (Drama 3, BS-RoFormer, Qwen3-ASR).

One container serves every model on 127.0.0.1:18986 with lazy loading and at most one model
resident, so switching between speech, separation and transcription needs no restart. The
ROCm 10.1 libraries come read-only from the host; the media library is mounted at its own path
so request paths are the gateway's paths.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / ".workbench"))
import registry  # noqa: E402

DATA = ROOT / "workspace/data/audio/audiocpp"
NAME = "paiton-audiocpp"
PORT = 18986
IMAGE = "ubuntu:24.04"
ROCM = Path("/opt/rocm/core-10.1")
MEDIA = Path("/media/aoike/Resource_Trad/Assets")
# Every model the server can load; the gateway routes only to enabled packages.
MODELS = [
    {"id": "fish-drama3", "family": "fish_drama3", "path": "models/Drama-3-GGUF/drama-3-backbone-8bit-F32-routers-experts-Q4_K_S.gguf", "task": "clon",
     "session_options": {"fish_drama3.cpu_expert_layers": "0", "fish_drama3.perf_mode": "cuda_perf"}},
    {"id": "bs-roformer", "family": "bs_roformer", "path": "models/bs-roformer-ep368-q8_0.gguf", "task": "sep"},
    {"id": "qwen3-asr", "family": "qwen3_asr", "path": "models/qwen3-asr-1.7b-q8_0.gguf", "task": "asr"},
]


def docker(*args, capture=False, check=True):
    return subprocess.run(["docker", *map(str, args)], check=check, text=True, capture_output=capture)


def running():
    return set(docker("ps", "--format", "{{.Names}}", capture=True).stdout.split())


def config():
    """Drama 3 Q4 alone fills ~24 GiB, so only one model stays resident at a time."""
    return {"host": "0.0.0.0", "port": PORT, "backend": "hip", "device": 0, "threads": 16, "lazy_load": True, "max_loaded_models": 1,
            "models": [{**model, "path": "/audiocpp/" + model["path"], "mode": "offline"} for model in MODELS]}


def health(timeout=2):
    with urlopen(f"http://127.0.0.1:{PORT}/health", timeout=timeout) as response:
        return json.load(response)


def prepare():
    missing = [str(DATA / m["path"]) for m in MODELS if not (DATA / m["path"]).exists()]
    missing += [str(p) for p in (DATA / "bin/audiocpp_server", ROCM / "lib/libamdhip64.so.7") if not p.exists()]
    for item in missing:
        print("缺少：" + item)
    return 1 if missing else 0


def start():
    if NAME in running():
        print("audio.cpp 已运行：http://127.0.0.1:%d" % PORT)
        return 0
    # Other engines' containers hold the GPU; the gateway drains them before starting this one.
    others = set()
    for package_id, manifest in registry.manifests().items():
        runtime = manifest.get("platform", {}).get("runtime", {})
        if runtime and runtime.get("container") != NAME:
            others.update([runtime["container"], *runtime.get("extra_containers", [])])
    busy = running() & others
    if busy:
        raise RuntimeError("请先停止其他 GPU 引擎：" + ", ".join(sorted(busy)))
    if prepare():
        raise RuntimeError("audio.cpp 运行物料不完整")
    (DATA / "config.json").write_text(json.dumps(config(), indent=2, ensure_ascii=False) + "\n")
    docker("rm", "-f", NAME, capture=True, check=False)
    render = Path("/dev/kfd").stat().st_gid
    docker("run", "-d", "--name", NAME, "--restart", "no", "--device", "/dev/kfd", "--device", "/dev/dri", "--group-add", render,
           "--ipc=host", "-p", f"127.0.0.1:{PORT}:{PORT}", "-v", f"{DATA}:/audiocpp", "-v", f"{ROCM}:{ROCM}:ro",
           "-v", f"{MEDIA}:{MEDIA}:ro", "-e", f"LD_LIBRARY_PATH={ROCM}/lib", "-w", "/audiocpp",
           IMAGE, "/audiocpp/bin/audiocpp_server", "--config", "/audiocpp/config.json", capture=True)
    for _ in range(60):
        try:
            if health().get("status") == "ok":
                print("audio.cpp 已就绪：http://127.0.0.1:%d" % PORT)
                return 0
        except OSError:
            time.sleep(1)
    raise RuntimeError("audio.cpp 未能在 60 秒内就绪；查看 ./lab fish-drama3 logs")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "start", "stop", "status", "logs", "check"])
    args = parser.parse_args()
    if args.command == "prepare":
        return prepare()
    if args.command == "start":
        return start()
    if args.command == "stop":
        if NAME in running():
            docker("stop", NAME, capture=True)
        docker("rm", "-f", NAME, capture=True, check=False)
        return 0
    if args.command == "status":
        docker("ps", "-a", "--filter", f"name=^/{NAME}$")
        return 0
    if args.command == "logs":
        docker("logs", "--tail", "60", NAME, check=False)
        return 0
    print(json.dumps(health(5), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
