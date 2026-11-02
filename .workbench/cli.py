#!/usr/bin/env python3
"""Shared dispatcher for independent local inference engines."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.error import URLError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
import registry as engine_registry  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DEPLOYMENT = "pation-model-qwen38-27b-w3a4"
ALIASES = {
    "paiton": DEFAULT_DEPLOYMENT,
    "qwen38-27b-r9700": DEFAULT_DEPLOYMENT,
    "qwen-image": "pation-model-qwen-image-21",
    "minimax-h3": "pation-model-minimax-h3",
}


def registry():
    return engine_registry.manifests()


def engine_command(args):
    """List engine packages or switch one on/off: through the gateway when it runs, so it can
    check the engine is idle and stop its container; otherwise in the state file."""
    console = "http://127.0.0.1:%d/api/platform" % engine_registry.PLATFORM["management_port"]
    action = args[0] if args else "list"
    if action == "list":
        for name, info in registry().items():
            platform = info.get("platform")
            if not platform:
                print(f"  {name:32} 仅命令行（未接入网关）")
                continue
            mark = "启用" if engine_registry.enabled(name, info) else "停用"
            models = ", ".join(m["id"] + "[" + "/".join(m["capabilities"]) + "]" for m in platform["models"]) or platform["engine"]
            print(f"  {name:32} {mark}  {models}")
        return 0
    if action == "status":
        return engine_status(args[1:])
    if action == "remove":
        return engine_remove(args[1:])
    if action not in ("enable", "disable") or len(args) != 2:
        raise RuntimeError("用法：./lab engine list | status [PACKAGE] | enable PACKAGE | disable PACKAGE | remove PACKAGE [--apply]")
    name, wanted = args[1], action == "enable"
    if not registry().get(name, {}).get("platform"):
        raise RuntimeError(f"未知或未接入网关的引擎包：{name}")
    body = json.dumps({"enabled": wanted}).encode()
    request = Request(f"{console}/engines/{name}", data=body, method="POST", headers={"Content-Type": "application/json", "Host": "127.0.0.1"})
    try:
        with urlopen(request, timeout=900) as response:
            json.load(response)
        print(("已启用 " if wanted else "已停用 ") + name + "（网关已生效）")
        return 0
    except URLError as error:
        if not isinstance(getattr(error, "reason", None), ConnectionRefusedError):
            raise RuntimeError(f"网关拒绝了请求：{error}")
    state = engine_registry.state()
    state.setdefault("engines", {}).setdefault(name, {})["enabled"] = wanted
    state.setdefault("routing", {})
    engine_registry.STATE.parent.mkdir(parents=True, exist_ok=True)
    engine_registry.STATE.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n")
    print(("已启用 " if wanted else "已停用 ") + name + "（网关未运行，下次启动生效）")
    return 0


def du(path):
    """Apparent size of a directory or file, in bytes (0 when absent)."""
    if not path.exists():
        return 0
    result = subprocess.run(["du", "-sb", str(path)], capture_output=True, text=True)
    # du still prints the total when some cache files are unreadable (root-owned).
    return int(result.stdout.split()[0]) if result.stdout else 0


def resources(name, manifests):
    """What one engine package owns, and what it only shares with other packages."""
    import storage
    sys.path.insert(0, str(ROOT / ".workbench/runtime"))
    import images
    manifest, others = manifests[name], {k: v for k, v in manifests.items() if k != name}
    runtime = manifest.get("platform", {}).get("runtime", {}).get("id")
    shared_runtime = runtime and any(v.get("platform", {}).get("runtime", {}).get("id") == runtime for v in others.values())
    claimed = {p for v in others.values() for p in storage.owned(v)}
    row = images.state().get(runtime, {}) if runtime else {}
    return {"runtime": runtime, "shared_runtime": bool(shared_runtime), "recipe": images.recipes().get(runtime, {}).get("_file"),
            "images": [tag for tag in (row.get("image"), row.get("previous")) if tag],
            "data": [(p, p in claimed) for p in storage.owned(manifest)], "dir": manifest["_dir"]}


def engine_status(args):
    manifests = registry()
    for name in args or manifests:
        if name not in manifests:
            raise RuntimeError(f"未知引擎包：{name}")
        r = resources(name, manifests)
        print(f"[{name}] {r['dir'].relative_to(ROOT)}" + ("" if manifests[name].get("platform") else "（仅命令行）"))
        if r["runtime"]:
            print(f"  运行时 {r['runtime']}" + ("（与其他引擎共用）" if r["shared_runtime"] else "") + (f"，配方 {r['recipe']}" if r["recipe"] else ""))
            for tag in r["images"]:
                print(f"  镜像   {tag}")
        for path, shared in r["data"]:
            print(f"  数据   {path.relative_to(ROOT)}  {du(path) / 2**30:.1f} GiB" + ("（共用）" if shared else ""))
    return 0


def engine_remove(args):
    """Uninstall a package: disable it, delete its directory, the data and runtime images only it
    used. Shared data and runtimes stay; generated artifacts are never touched."""
    apply = "--apply" in args
    names = [a for a in args if a != "--apply"]
    if len(names) != 1:
        raise RuntimeError("用法：./lab engine remove PACKAGE [--apply]")
    name, manifests = names[0], registry()
    if name not in manifests:
        raise RuntimeError(f"未知引擎包：{name}")
    r = resources(name, manifests)
    data = [p for p, shared in r["data"] if not shared]
    drop_images = r["images"] if r["runtime"] and not r["shared_runtime"] else []
    print(f"删除引擎包 {name}：")
    print(f"  目录   {r['dir'].relative_to(ROOT)}")
    for path in data:
        print(f"  数据   {path.relative_to(ROOT)}  {du(path) / 2**30:.1f} GiB")
    for tag in drop_images:
        print(f"  镜像   {tag}")
    for path, shared in r["data"]:
        if shared:
            print(f"  保留   {path.relative_to(ROOT)}（其他引擎在用）")
    if r["runtime"] and r["shared_runtime"]:
        print(f"  保留   运行时 {r['runtime']}（其他引擎在用）")
    if not apply:
        print("以上为预览；加 --apply 执行。作品不会删除。")
        return 0
    if manifests[name].get("platform") and engine_registry.enabled(name, manifests[name]):
        engine_command(["disable", name])
    sys.path.insert(0, str(ROOT / ".workbench/runtime"))
    import images
    for tag in drop_images:
        subprocess.run(["docker", "rmi", tag], check=False)
    if drop_images:
        state = images.state()
        state.pop(r["runtime"], None)
        images.save(state)
    for path in data:
        # Containers write as root; a throwaway container removes what the user cannot.
        subprocess.run(["docker", "run", "--rm", "-v", f"{path.parent}:/x", "ubuntu:24.04", "rm", "-rf", "/x/" + path.name], check=True)
    shutil.rmtree(r["dir"])
    state = engine_registry.state()
    state.get("engines", {}).pop(name, None)
    engine_registry.STATE.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n")
    print(f"已删除 {name}。用 git 提交目录删除；如果它的配方也随包删除，运行时镜像已一并清理。")
    return 0


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
        "runtime": [sys.executable, str(ROOT / ".workbench/runtime/images.py")],
        "comfyui": [sys.executable, str(ROOT / "engines/shared/comfyui/controller.py")],
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
        print("常驻服务：./lab services install | start | stop | restart | deploy | status | logs")
        print("媒体 MCP：./lab mcp setup | stdio | check")
        print("调度：./lab scheduler status | switch llm | switch h3")
        print("ComfyUI：./lab comfyui start | stop | status | check | sync（按需启动，不常驻）")
        print("运行时镜像：./lab runtime status | build RUNTIME | activate RUNTIME TAG | prune [--apply] | sdk install|verify")
        print("监控平台：./lab monitor start | status | check | export")
        print("引擎包：./lab engine list | status [PACKAGE] | enable PACKAGE | disable PACKAGE | remove PACKAGE [--apply]")
        print("存储：platforms/platform.json 的 storage 段；作品在 workspace/outputs（作品盘）    使用说明：docs/")
        print("引擎：" + ", ".join(engines))
        print("默认部署为 Qwen3.8 27B W3A4；MXFP4 使用独立部署入口。")
        return 0
    if args[0] == "engine":
        return engine_command(args[1:])
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
            path = engines[name]["_dir"] / "config/models.json"
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
        raise RuntimeError(f"{engine['name']} 已分类，运行入口待配置。见 {engine['_dir'].relative_to(ROOT)}/README.md。")
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
            kind = {"image-hq": None, "video-audio": "video-audio"}[profile]
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
