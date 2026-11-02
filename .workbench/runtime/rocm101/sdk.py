"""The shared ROCm SDK: one read-only host copy mounted into every GPU container.

Runtime images keep only symlinks at <site-packages>/_rocm_sdk_{core,devel,libraries} that point
into /opt/rocm101-sdk, so an SDK upgrade is `install` of a new version directory plus a switch of
sdk.json, never an image rebuild. Each version is installed from the wheels pinned in
packages.lock.json and verified against its own SHA256SUMS.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
STORE = ROOT / "workspace/data/runtime/rocm101/sdk"
PACKAGES = ROOT / "workspace/data/runtime/rocm101/packages"
TARGET = "/opt/rocm101-sdk"
HEAVY = ("_rocm_sdk_core", "_rocm_sdk_devel", "_rocm_sdk_libraries")
PYTHON = ROOT / ".workbench/envs/tools/bin/python"


def active_version():
    return json.loads((HERE / "sdk.json").read_text())["active"]


def path():
    """The active SDK directory on the host; refuses to start a container without it."""
    root = STORE / active_version()
    if not (root / "_rocm_sdk_devel/lib/libamdhip64.so").exists():
        raise RuntimeError(f"共享 ROCm SDK 不完整：{root}。执行 ./lab runtime sdk install。")
    return root


def mount():
    """docker run arguments that mount the active SDK read-only."""
    return ["-v", f"{path()}:{TARGET}:ro"]


def checksums(root):
    files = sorted(p for p in root.rglob("*") if p.is_file() and not p.is_symlink() and p.name != "SHA256SUMS" and "__pycache__" not in p.parts)
    return "".join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(root)}\n" for p in files)


def install(version):
    """Install the pinned wheels into STORE/<version>, run rocm_sdk init, record SHA256SUMS."""
    lock = json.loads((HERE / "packages.lock.json").read_text())
    for row in lock:
        digest = hashlib.sha256((PACKAGES / row["filename"]).read_bytes()).hexdigest()
        if digest != row["sha256"]:
            raise RuntimeError(f"SDK 包校验失败：{row['filename']}")
    final, staging = STORE / version, STORE / f".{version}.staging"
    if final.exists():
        raise RuntimeError(f"{final} 已存在；先确认没有运行时在用，再删除后重装")
    shutil.rmtree(staging, ignore_errors=True)
    subprocess.run([PYTHON, "-m", "pip", "install", "-q", "--target", staging, "--no-deps", "--no-index",
                    "--no-build-isolation", *[PACKAGES / row["filename"] for row in lock]], check=True)
    subprocess.run([PYTHON, "-m", "rocm_sdk", "init"], check=True, env={**os.environ, "PYTHONPATH": str(staging)})
    # Console scripts point at the host interpreter; images keep their own.
    shutil.rmtree(staging / "bin", ignore_errors=True)
    for cache in list(staging.rglob("__pycache__")):
        shutil.rmtree(cache, ignore_errors=True)
    if not (staging / "_rocm_sdk_devel/lib/libamdhip64.so").exists():
        raise RuntimeError("rocm_sdk init 没有生成 libamdhip64.so")
    (staging / "SHA256SUMS").write_text(checksums(staging))
    staging.rename(final)
    print(f"已安装 ROCm SDK {version}：{final}。切换：修改 {HERE / 'sdk.json'} 的 active。")


def verify():
    root = path()
    expected, actual = (root / "SHA256SUMS").read_text(), checksums(root)
    if expected != actual:
        raise RuntimeError(f"{root} 与 SHA256SUMS 不一致")
    print(f"ROCm SDK {root.name}：{len(actual.splitlines())} 个文件校验一致")


if __name__ == "__main__":
    print(path())
