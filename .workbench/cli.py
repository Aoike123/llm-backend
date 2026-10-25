#!/usr/bin/env python3
"""Shared dispatcher for independent local inference engines."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DEPLOYMENT = "pation-model-qwen38-27b-w3a4"
ALIASES = {
    "paiton": DEFAULT_DEPLOYMENT,
    "qwen38-27b-r9700": DEFAULT_DEPLOYMENT,
    "flux": "pation-model-flux2-klein",
    "qwen-image": "pation-model-qwen-image-21",
    "minimax-h3": "pation-model-minimax-h3",
}


def locations():
    return json.loads((ROOT / ".workbench/config/engines.json").read_text())


def registry():
    return {name: json.loads((ROOT / location / "engine.json").read_text()) for name, location in locations().items()}


def node():
    """Node.js >=22.19 from WORKBENCH_NODE, PATH or nvm; systemd units do not load the nvm PATH."""
    check = "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||a===22&&b>=19?0:1)"
    usable = lambda path: path and subprocess.run([path, "-e", check], capture_output=True).returncode == 0
    found = os.environ.get("WORKBENCH_NODE") or shutil.which("node")
    if usable(found):
        return found
    version = lambda path: tuple(int(part) for part in path.parts[-3].lstrip("v").split(".") if part.isdigit())
    installed = sorted(Path.home().glob(".nvm/versions/node/v*/bin/node"), key=version)
    candidates = [str(path) for path in installed if usable(str(path))]
    if not candidates:
        raise RuntimeError("Node.js >=22.19 required; set WORKBENCH_NODE.")
    return candidates[-1]


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if args:
        args[0] = ALIASES.get(args[0], args[0])
    engines = registry()
    common = {
        "mcp": ["bash", str(ROOT / "platforms/mcp/launch.sh")],
        "services": [sys.executable, str(ROOT / "platforms/services/controller.py")],
        "scheduler": [node, str(ROOT / "platforms/workbench/cli.mjs")],
        "runtime": [sys.executable, str(ROOT / ".workbench/runtime/rocm101/controller.py")],
        "comfyui": [sys.executable, str(ROOT / "platforms/comfyui/controller.py")],
        "monitor": [sys.executable, str(ROOT / "platforms/monitoring/controller.py")],
        "smoke": [sys.executable, str(ROOT / ".workbench/scripts/smoke-llm.py")],
        "check": [sys.executable, str(ROOT / ".workbench/scripts/check-project.py")],
        "install-host": ["bash", str(ROOT / ".workbench/scripts/install-host.sh")],
        "evaluate-media": ["bash", str(ROOT / ".workbench/scripts/evaluate-media.sh")],
    }
    if args and args[0] in common:
        command = [part() if callable(part) else part for part in common[args[0]]]
        return subprocess.run([*command, *args[1:]], cwd=ROOT).returncode
    if not args or args[0] in ("-h", "--help"):
        print("AMD 本地 AI 工作台")
        print("用法：./lab engines | models [ENGINE] | ENGINE COMMAND [ARGS]")
        print("示例：./lab pation-model-qwen38-27b-w3a4 start w3a4")
        print("运行状态：./lab status    推理检查：./lab smoke    项目检查：./lab check")
        print("常驻服务：./lab services install | start | stop | restart | status | logs")
        print("媒体 MCP：./lab mcp setup | stdio | check")
        print("调度：./lab scheduler status | switch llm | switch h3")
        print("ComfyUI：./lab comfyui build | start | status | check")
        print("ROCm 10.1 镜像：./lab runtime build | status | check --engine ENGINE")
        print("监控平台：./lab monitor start | status | check | export")
        print("模型／缓存／输出／报告：workspace/    使用说明：docs/")
        print("引擎：" + ", ".join(engines))
        print("默认部署为 Qwen3.8 27B W3A4；MXFP4 使用独立部署入口。")
        return 0
    if args[0] == "engines":
        for category in ("llm", "image", "video", "audio"):
            print(f"[{category}]")
            for name, info in engines.items():
                if info["category"] == category:
                    print(f"  {name:12} {info['name']:24} {info['status']}")
        return 0
    if args[0] == "models":
        selected = [ALIASES.get(name, name) for name in args[1:]] or list(engines)
        for name in selected:
            if name not in engines:
                raise RuntimeError(f"未知引擎：{name}")
            path = ROOT / locations()[name] / "config/models.json"
            print(f"[{name}]")
            models = json.loads(path.read_text())
            if not models:
                print("  本地模型未发现，首次启动由上游准备")
            for model in models:
                print(f"  {model['id']} ({model['format']})")
                for folder in model["paths"]:
                    print(f"    {folder}")
        return 0
    explicit_engine = args[0] in engines
    name = args.pop(0) if explicit_engine else DEFAULT_DEPLOYMENT
    engine = engines[name]
    if not engine.get("entrypoint"):
        raise RuntimeError(f"{engine['name']} 已分类，运行入口待配置。见 {locations()[name]}/README.md。")
    if engine.get("profiles") and args and args[0] in ("start", "stop", "status"):
        if len(args) == 1 and engine.get("default_profile") and (args[0] == "start" or explicit_engine):
            args += ([engine["default_profile"]] if args[0] == "start" else ["--profile", engine["default_profile"]])
        if len(args) > 1 and args[1] in engine["profiles"]:
            selected = engine["profiles"][args[1]]
            args[1:] = ([selected] if args[0] == "start" else ["--profile", selected]) + args[2:]
        elif args[0] == "start" and (len(args) < 2 or args[1] not in ("llm", "llm-fast", "--help", "-h")):
            raise RuntimeError("请选择运行配置：start " + " 或 start ".join(engine["profiles"]))
    profile = engine.get("delegate_profile")
    if profile:
        if args and args[0] == "start":
            if "--help" in args or "-h" in args:
                args = ["start", "--help"]
            else:
                args.insert(1, profile)
        elif args and args[0] in ("stop", "status"):
            args += ["--profile", profile]
        elif args and args[0] == "bench":
            kind = {"image": "image", "image-hq": None, "video-audio": "video-audio"}[profile]
            if kind is None:
                raise RuntimeError("此配置尚未提供对应的独立测速入口，见 docs/EVALUATION.md。")
            args.insert(1, kind)
        elif args and args[0] not in ("stop", "status", "doctor", "--help", "-h"):
            raise RuntimeError("媒体引擎支持 start、stop、status、doctor 及已接入的 bench。")
    entrypoint = ROOT / engine["entrypoint"]
    return subprocess.run([sys.executable, str(entrypoint), *(args or ["--help"])], cwd=ROOT).returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
