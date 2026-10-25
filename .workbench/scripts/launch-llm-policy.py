"""Extend the pinned W3A4 launcher with an explicit DFlash policy."""
import json,os,subprocess,sys
from pathlib import Path

def command(launcher,args,policy):
    method=policy['draft_sample_method'];pool=policy['draft_rerank']
    if method not in ('greedy','probabilistic') or pool not in (0,128):raise ValueError('Unsupported DFlash policy')
    if pool and method!='probabilistic':raise ValueError('R128 requires probabilistic proposals')
    overrides=policy.get('environment',{})
    if set(overrides)-{'RADIANCE_FAST_DRAFT','RADIANCE_VERIFY_HEAD'} or any(v not in ('0','1') for v in overrides.values()):raise ValueError('Unsupported runtime override')
    if pool and overrides.get('RADIANCE_FAST_DRAFT')=='0':raise ValueError('R128 requires the fast draft head')
    if overrides.get('RADIANCE_FAST_DRAFT')=='0' and overrides.get('RADIANCE_VERIFY_HEAD')!='0':raise ValueError('Full draft requires the approximate verifier head disabled')
    result=subprocess.run([sys.executable,str(launcher),'--release','65k','--name','paiton-qwen38','--weights','w3a4',*args,'--dry-run'],check=True,capture_output=True,text=True)
    if result.stderr:print(result.stderr,file=sys.stderr,end='')
    argv=json.loads(result.stdout)
    if argv[:2]!=['docker','run'] or 'serve' not in argv:raise ValueError('Unexpected launcher command')
    image=argv.index('serve')-1
    argv[image:image]=['-e','PAITON_DFLASH_DRAFT_SAMPLE_METHOD='+method,'-e','PAITON_DFLASH_RERANK='+str(pool)]
    image=argv.index('serve')-1
    extra=[]
    for key,value in sorted(overrides.items()):extra+=['-e',key+'='+value]
    argv[image:image]=extra
    return argv

if __name__=='__main__':
    policy=json.loads(Path(sys.argv[2]).read_text())
    argv=command(Path(sys.argv[1]),sys.argv[3:],policy)
    os.execvp(argv[0],argv)
