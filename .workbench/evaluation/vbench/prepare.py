"""Host-side check before a VBench image build: every wheel matches its locked SHA256."""
import hashlib
import json
from pathlib import Path

WHEELS = Path(__file__).resolve().parents[3] / "workspace/data/runtime/vbench/wheels"
lock = json.loads((WHEELS / "wheels.lock.json").read_text())
for row in lock["files"]:
    assert hashlib.sha256((WHEELS / row["filename"]).read_bytes()).hexdigest() == row["sha256"], row["filename"]
print(f"VBench wheels verified: {len(lock['files'])}")
