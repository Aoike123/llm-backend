"""Refresh the stored native node schema of the shared ComfyUI runtime through the GPU scheduler."""
import json
from pathlib import Path
import sys
from urllib.request import urlopen
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'platforms/scheduler'))
sys.path.insert(0,str(ROOT/'.workbench'))
from client import lease  # noqa: E402
import registry  # noqa: E402
runtime=registry.native_runtime()
with lease(runtime['engines'][0]):
    with urlopen(f"http://127.0.0.1:{runtime['port']}/object_info",timeout=20) as response:
        schema=json.load(response)
assert isinstance(schema,dict) and 'SaveVideo' in schema and 'KSampler' in schema
path=ROOT/'engines/shared/comfyui/schema/h3.json'
temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(schema,ensure_ascii=False,indent=2)+'\n');temporary.replace(path)
print(len(schema),'node definitions saved to',path.relative_to(ROOT))
