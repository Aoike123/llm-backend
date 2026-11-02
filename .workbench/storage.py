"""Where everything is stored, from the single `storage` block of platforms/platform.json.

state      workspace/data/media on the internal NVMe: job records, imported materials, telemetry.
artifacts  generated media on the resource disk:
           <kind>/<YYYY-MM>/<job_id>/  durable API/MCP jobs (images, videos, audio)
           api/                        synchronous API results (/artifacts/*)
           canvas/                     the ComfyUI canvas (container /outputs)
           manual/<owner>/             maintenance commands, acceptance runs and benchmarks
The artifacts root must contain the marker file; without it the resource disk counts as offline
and nothing is written, so an unmounted disk can never fill the root partition.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "platforms/platform.json").read_text())["storage"]


def _path(value):
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def state():
    return _path(CONFIG["state"])


def artifacts(require=True):
    root = _path(CONFIG["artifacts"])
    if require and not (root / CONFIG["marker"]).is_file():
        raise RuntimeError(f"作品盘未挂载或缺少标记文件：{root / CONFIG['marker']}")
    return root


def _dir(path):
    path.mkdir(parents=True, exist_ok=True)
    return path


def canvas():
    return _dir(artifacts() / "canvas")


def api():
    return _dir(artifacts() / "api")


def manual(owner):
    """Outputs of maintenance commands for one engine package, runtime or tool."""
    return _dir(artifacts() / "manual" / owner)


def mounts():
    """Read-only mounts that let a container open materials and artifacts by their host paths."""
    return [part for root in (state(), artifacts()) for part in ("-v", f"{root}:{root}:ro")]


def owned(manifest):
    """Directories an engine package or runtime recipe owns (models, caches), as absolute paths."""
    return [_path(path) for path in manifest.get("storage", {}).get("data", [])]
