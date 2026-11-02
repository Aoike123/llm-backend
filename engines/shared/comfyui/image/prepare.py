"""Host-side check before a ComfyUI image build: pinned sources and wheels are exactly what is locked."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[4]
DATA = ROOT / "workspace/data/runtime/comfy"
H3 = ROOT / "engines/shared/paiton/upstream/models/MiniMax-H3"
SOURCES = {ROOT / ".workbench/vendor/comfyui": "efa6c8f804bff78b46a0fd458ebd2e47bba07a30",
           DATA / "frontend": "e7d1c7fc6823e330fdab524610b0000394cb1dbc"}

lock = json.loads((DATA / "wheels/wheels.lock.json").read_text())
requirements = {line for line in (H3 / "requirements.lock.txt").read_text().splitlines() if line and not line.startswith("#")}
assert requirements == {row["package"] + "==" + row["version"] for row in lock["files"]}, "wheels.lock.json does not match requirements.lock.txt"
for row in lock["files"]:
    assert hashlib.sha256((DATA / "wheels" / row["filename"]).read_bytes()).hexdigest() == row["sha256"], row["filename"]
for path, sha in SOURCES.items():
    head = subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
    assert head == sha, f"{path} is at {head}, expected {sha}"
print(f"ComfyUI inputs verified: {len(lock['files'])} wheels, {len(SOURCES)} pinned sources")
