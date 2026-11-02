"""Use release feature defaults while testing a derived image, before activation."""
import importlib.util
import sys
from pathlib import Path
root = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('paiton_controller',root/'engines/shared/paiton/controller.py')
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)
controller.require_docker()
controller.require_idle()
controller.model_env('llm-throughput')
# A built but not yet activated tag can be passed as the first argument.
image = sys.argv[1] if len(sys.argv) > 1 else controller.images.active('llm')
controller.ENV['PAITON_FEATURE_IMAGE'] = image
controller.run([sys.executable,Path(__file__).with_name('controller.py'),image])
args = list(controller.PROFILES['llm-throughput']['args'])
pos = args.index('--image')
args[pos+1] = image
args += ['--vision','--kv-cache-memory-bytes','8589934592']
controller.run(['bash',controller.PAITON/'models/Qwen3.8-MXFP4-DFlash2/run-3bit.sh',*args])
