"""Install or control the user systemd workbench services."""
import argparse,os,subprocess,sys
from pathlib import Path
import json
from urllib.request import urlopen
from urllib.error import URLError
ROOT=Path(__file__).resolve().parents[2];HERE=Path(__file__).resolve().parent
UNITS=['ai-workbench-gateway.service','ai-workbench-comfyui.service','ai-workbench-monitoring.service']
p=argparse.ArgumentParser();p.add_argument('action',choices=['install','start','stop','restart','status','logs']);a=p.parse_args()
def run(*cmd):return subprocess.run(list(cmd),check=True)
if a.action=='install':
 target=Path.home()/'.config/systemd/user';target.mkdir(parents=True,exist_ok=True)
 for source in [*(HERE/u for u in UNITS),HERE/'ai-workbench.target']:
  dest=target/source.name
  if dest.exists() or dest.is_symlink():
   if dest.is_symlink() and dest.resolve()==source.resolve():continue
   raise SystemExit('Existing different unit: '+str(dest))
  dest.symlink_to(source)
 run('systemctl','--user','daemon-reload')
 run('systemctl','--user','enable','ai-workbench.target',*UNITS)
 print('Installed. Start: ./lab services start')
elif a.action=='logs':run('journalctl','--user','-u',UNITS[0],'-n','60','--no-pager')
elif a.action=='status':
 subprocess.run(['systemctl','--user','status',*UNITS,'--no-pager'])
 subprocess.run(['loginctl','show-user',str(os.getuid()),'-p','Linger'])
else:
 if a.action in ('stop','restart'):
  for url in ('http://127.0.0.1:18982/status','http://127.0.0.1:8188/queue'):
   try:
    with urlopen(url,timeout=3) as response:state=json.load(response)
   except URLError as error:
    if not isinstance(error.reason,ConnectionRefusedError):raise SystemExit('Cannot verify service idle: '+str(error))
    continue
   if any(state.get(k) for k in ('leased','switching','queued','queue_running','queue_pending')):
    raise SystemExit('Active/queued work: wait before stopping or restarting services')
 # Explicitly act on all units: stopping a target alone does not stop its Wants.
 if a.action=='stop':
  run('systemctl','--user','stop','ai-workbench.target',*reversed(UNITS))
  run(str(ROOT/'lab'),'stop')
 elif a.action=='restart':
  run('systemctl','--user','daemon-reload')
  run('systemctl','--user','restart',*UNITS)
 else:
  run('systemctl','--user','daemon-reload')
  run('systemctl','--user','start','ai-workbench.target',*UNITS)
