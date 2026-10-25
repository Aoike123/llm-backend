"""Keep the CPU encoder available before starting its GPU client."""
import json
import subprocess
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
def ensure(image):
    try:
        with urllib.request.urlopen('http://127.0.0.1:18984/health', timeout=2) as response:
            status=json.load(response)
            if status.get('device') == 'cpu' and status.get('threads') == 43:
                return
    except Exception:
        pass
    running = subprocess.check_output(['docker','ps','--format','{{.Names}}'], text=True).splitlines()
    if 'ai-vision-cpu' in running:
        subprocess.run(['docker','stop','ai-vision-cpu'],check=True)

    subprocess.run(['docker','rm','ai-vision-cpu'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['docker','run','-d','--name','ai-vision-cpu','--restart','unless-stopped','--network','host','--memory','8g',
                    '--cpuset-cpus','0-42','-e','VISION_THREADS=43','-e','HIP_VISIBLE_DEVICES=-1',
                    '-e','CUDA_VISIBLE_DEVICES=-1','-v',str(ROOT/'workspace/data/llm/paiton/models/qwen38-nvfp4')+':/models/target:ro',
                    '-v',str(Path(__file__).parent)+':/cpu-vision:ro','--entrypoint','python3',image,'/cpu-vision/server.py'], check=True)
    for _ in range(120):
        try:
            with urllib.request.urlopen('http://127.0.0.1:18984/health', timeout=2) as response:
                if json.load(response).get('threads') == 43:
                    return
        except Exception:
            time.sleep(1)
    raise RuntimeError('CPU vision encoder failed to become ready; inspect docker logs ai-vision-cpu')

if __name__ == '__main__':
    import sys
    ensure(sys.argv[1])
