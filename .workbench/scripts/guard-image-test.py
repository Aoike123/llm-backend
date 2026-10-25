#!/usr/bin/env python3
"""Stop the owned image worker on a new kernel GPU fault during a smoke test."""
import datetime
import os
from pathlib import Path
import re
import subprocess
import sys
import threading

ROOT=Path(__file__).resolve().parents[2]
REPORT=ROOT/'workspace/reports/image/qwen-image21'
REPORT.mkdir(parents=True,exist_ok=True)
stamp=datetime.datetime.now().strftime('%Y%m%dT%H%M%S')
journal=subprocess.Popen(['journalctl','-k','-f','-n','0','--no-pager'],stdout=subprocess.PIPE,text=True,bufsize=1)
fault=threading.Event()
worker=os.environ.get('GPU_GUARD_WORKER','paiton-qwen-image21')
def watch():
    with (REPORT/('guard-'+stamp+'.log')).open('w') as logfile:
        for line in journal.stdout:
            logfile.write(line);logfile.flush()
            if re.search(r'page fault|GPU reset|ring .*timeout',line,re.I):
                fault.set()
                print('New GPU kernel fault: stopping '+worker,flush=True)
                subprocess.run(['docker','stop','-t','1',worker],timeout=15)
                break
thread=threading.Thread(target=watch,daemon=True);thread.start()
try:
    command = sys.argv[2:] if len(sys.argv)>1 and sys.argv[1]=='--command' else [str(ROOT/'lab'),'pation-model-qwen-image-21','generate',*sys.argv[1:]]
    result=subprocess.run(command,timeout=int(os.environ.get('GPU_GUARD_TIMEOUT','600')))
    if result.returncode==0 and '--output' in sys.argv:
        from PIL import Image
        output=Path(sys.argv[sys.argv.index('--output')+1])
        image=Image.open(output)
        extrema=image.getextrema()
        print('Output pixel extrema:',extrema,flush=True)
        if all(lo==hi==0 for lo,hi in extrema):
            print('FAIL: output is entirely zero; API success does not qualify generation',flush=True)
            sys.exit(3)
    sys.exit(2 if fault.is_set() else result.returncode)
except subprocess.TimeoutExpired:
    subprocess.run(['docker','stop','-t','1',worker],timeout=15)
    raise
finally:
    journal.terminate()
    journal.wait(timeout=5)
