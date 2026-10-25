from pathlib import Path
path = Path('/usr/local/lib/python3.12/dist-packages/vllm/v1/worker/gpu/mm/encoder_runner.py')
source = path.read_text()
old = '        dummy_encoder_outputs = self.execute_mm_encoder(dummy_mm_inputs)'
assert source.count(old) == 1
source = source.replace(old, '        from cpu_vision_proxy import profile_mode\n        with profile_mode():\n            dummy_encoder_outputs = self.execute_mm_encoder(dummy_mm_inputs)')
path.write_text(source)
