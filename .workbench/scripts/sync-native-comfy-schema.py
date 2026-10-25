"""Refresh persistent native node schemas through the existing GPU scheduler."""
import argparse
import json
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'platforms/comfyui/custom_nodes'))
from pation_scheduler.client import lease
from urllib.request import urlopen
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--model',choices=['h3','all'],default='all')
args=parser.parse_args()
for model in (('h3',) if args.model=='all' else (args.model,)):
    with lease(model):
        port=json.loads((ROOT/'platforms/runtime-topology.json').read_text())['runtimes']['comfy']['port']
        with urlopen(f'http://127.0.0.1:{port}/object_info',timeout=20) as response:
            schema=json.load(response)
        assert isinstance(schema,dict) and 'SaveVideo' in schema
        path=ROOT/'platforms/comfyui/custom_nodes/pation_native_h3'/(model+'-schema.json')
        temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(schema,ensure_ascii=False,indent=2)+'\n');temporary.replace(path)
        print(model,len(schema),'node definitions saved')
