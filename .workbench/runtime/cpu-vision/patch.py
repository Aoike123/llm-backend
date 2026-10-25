from pathlib import Path

path = Path('/usr/local/lib/python3.12/dist-packages/vllm/model_executor/models/qwen3_5.py')
source = path.read_text()
old = 'self.visual = Qwen3_VisionTransformer('
assert source.count(old) == 2
source = 'from cpu_vision_proxy import CPUVisionProxy\n' + source.replace(old, 'self.visual = CPUVisionProxy(')
old = 'return loader.load_weights(weights, mapper=self.hf_to_vllm_mapper)'
assert old in source
source = source.replace(old, 'return loader.load_weights(((n, w) for n, w in weights if not n.startswith(("model.visual.", "visual."))), mapper=self.hf_to_vllm_mapper)')
path.write_text(source)
