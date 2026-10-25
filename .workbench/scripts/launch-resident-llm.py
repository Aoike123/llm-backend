"""Extend the pinned launcher command without modifying vendor source."""
import json,os,subprocess,sys
from pathlib import Path

def command(launcher,args):
    from importlib.util import spec_from_file_location, module_from_spec
    spec=spec_from_file_location('configured_llm',Path(__file__).with_name('launch-configured-llm.py'))
    configured=module_from_spec(spec);spec.loader.exec_module(configured)
    argv=configured.command(launcher,args)
    # Retain failed workers for diagnosis; the controller removes them on stop.
    if '--rm' in argv:argv.remove('--rm')
    if argv[:2]!=['docker','run'] or 'serve' not in argv:raise ValueError('Unexpected launcher command')
    image=argv.index('serve')-1
    runtime=Path(__file__).resolve().parents[2]/'platforms/scheduler'
    site='/usr/local/lib/python3.12/dist-packages/'
    # The vendor fraction guard counts VMM private pools twice; use physical
    # allocation limits, plus the scheduler's RAM/VRAM budgets, in sleep mode.
    argv[image:image]=['--label','ai.workbench.resident=true','-e','VLLM_SERVER_DEV_MODE=1','-e','HSA_ENABLE_SDMA=0','-e','PYTORCH_ALLOC_CONF=max_split_size_mb:64',
                       '-v',str(runtime/'runtime_residency_patch.py')+':'+site+'runtime_residency_patch.py:ro',
                       '-v',str(runtime/'runtime_residency.pth')+':'+site+'zz_workbench_residency.pth:ro']
    argv.append('--enable-sleep-mode')
    return argv

if __name__=='__main__':
    argv=command(Path(sys.argv[1]),sys.argv[2:])
    os.execvp(argv[0],argv)
