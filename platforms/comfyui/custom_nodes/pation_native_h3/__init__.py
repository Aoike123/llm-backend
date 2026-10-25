"""Expose native H3/Wan graphs in the single public ComfyUI workspace."""
import json
from pathlib import Path
import folder_paths
from server import PromptServer
from .relay import NativeRelay

HERE = Path(__file__).parent
schemas = {}
for model in ('h3', 'wan'):
    path = HERE / (model + '-schema.json')
    if path.exists():
        schemas[model] = json.loads(path.read_text())
relay = NativeRelay(PromptServer.instance, schemas, folder_paths.get_input_directory(),
                    folder_paths.get_output_directory(), folder_paths.get_temp_directory())
relay.install()
NODE_CLASS_MAPPINGS = {}
