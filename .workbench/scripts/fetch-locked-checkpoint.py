#!/usr/bin/env python3
"""Fetch a SHA-256 locked HF checkpoint to NVMe with resumable mirror downloads."""
import argparse
from concurrent.futures import ThreadPoolExecutor,wait,FIRST_COMPLETED
import hashlib
import json
from pathlib import Path
import subprocess
import time
from urllib.parse import quote


def digest(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lock',type=Path,required=True)
    parser.add_argument('--destination',type=Path,required=True)
    parser.add_argument('--workers',type=int,default=4)
    parser.add_argument('--endpoint',default='https://hf-mirror.com')
    parser.add_argument('--transfer-timeout',type=int,default=1800)
    args=parser.parse_args()
    lock=json.loads(args.lock.read_text());dest=args.destination.resolve();dest.mkdir(parents=True,exist_ok=True)
    started=time.monotonic();total=lock['download_bytes'];completed=0
    def fetch(row):
        relative=Path(row.get('destination',row['file']))
        if relative.is_absolute() or '..' in relative.parts:raise ValueError('Unsafe checkpoint path')
        path=dest/relative;path.parent.mkdir(parents=True,exist_ok=True)
        if path.is_file() and path.stat().st_size==row['bytes'] and digest(path)==row['sha256']:return row
        partial=path.with_name(path.name+'.partial')
        if partial.is_file() and partial.stat().st_size==row['bytes']:
            if digest(partial)==row['sha256']:partial.replace(path);return row
            partial.unlink()
        for endpoint in [args.endpoint.rstrip('/'),'https://huggingface.co']:
            url=endpoint+'/'+row.get('repository',lock['repository'])+'/resolve/'+row.get('revision',lock['revision'])+'/'+quote(row['file'])
            # Each transfer can resume its own partial shard after interruption.
            result=subprocess.run(['curl','-fL','--retry','3','--retry-delay','2','--connect-timeout','15','--max-time',str(args.transfer_timeout),'--speed-limit','16384','--speed-time','45','--continue-at','-','--silent','--show-error','--output',str(partial),url],capture_output=True,text=True)
            if result.returncode==0 and partial.stat().st_size==row['bytes']:
                if digest(partial)!=row['sha256']:
                    partial.unlink();continue
                partial.replace(path);return row
            print(f"Retry source: {row['file']} ({endpoint}, curl {result.returncode})",flush=True)
        raise RuntimeError('Download/verification failed: '+row['file'])
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        pending={pool.submit(fetch,row):row for row in lock['files']}
        while pending:
            done,_=wait(pending,timeout=15,return_when=FIRST_COMPLETED)
            for future in done:
                row=future.result();completed+=row['bytes'];pending.pop(future)
                print(f"Verified {completed/total:.1%} {completed/1e9:.3f}/{total/1e9:.3f} GB {row['file']}",flush=True)
            partial=0
            for row in pending.values():
                target=dest/Path(row.get('destination',row['file']))
                part=target.with_name(target.name+'.partial')
                try: partial+=part.stat().st_size
                except FileNotFoundError:
                    try: partial+=target.stat().st_size
                    except FileNotFoundError: pass
            transferred=completed+partial;elapsed=max(1,time.monotonic()-started)
            print(f"Progress incl. unverified partials: {transferred/total:.1%} {transferred/1e9:.3f}/{total/1e9:.3f} GB ({transferred/elapsed/1e6:.2f} MB/s incl. reuse)",flush=True)
    receipt={'repository':lock['repository'],'revision':lock['revision'],'bytes':completed,'files':len(lock['files']),'sha256_verified':True,'elapsed_seconds':time.monotonic()-started}
    (dest/'verification.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print('Checkpoint complete: '+str(dest),flush=True)


if __name__=='__main__':main()
