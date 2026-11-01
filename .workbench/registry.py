"""Engine packages as seen by Python tools: the same engine.json files the gateway registers."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLATFORM = json.loads((ROOT / "platforms/platform.json").read_text())
STATE = ROOT / PLATFORM["state_file"]


def manifests():
    """Every engine package, keyed by deployment id (or directory name)."""
    found = {}
    for file in sorted(ROOT.glob("engines/*/*/engine.json")):
        manifest = json.loads(file.read_text())
        found[manifest.get("deployment_id", file.parent.name)] = {**manifest, "_dir": file.parent}
    return found


def state():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def enabled(package_id, manifest):
    saved = state().get("engines", {}).get(package_id, {})
    return saved.get("enabled", manifest.get("platform", {}).get("default_enabled", False))


def native_runtime():
    """The enabled runtime that hosts the native ComfyUI canvas, with the engines that share it."""
    for package_id, manifest in manifests().items():
        runtime = manifest.get("platform", {}).get("runtime", {})
        if runtime.get("native_ui") and enabled(package_id, manifest):
            engines = [m["platform"]["engine"] for p, m in manifests().items()
                       if m.get("platform", {}).get("runtime", {}).get("id") == runtime["id"] and enabled(p, m)]
            return {**runtime, "engines": engines}
    raise RuntimeError("没有启用提供 ComfyUI 原生界面的引擎")
