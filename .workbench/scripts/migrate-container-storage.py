#!/usr/bin/env python3
"""Move this host's Docker/containerd stores to the data partition (root only)."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from urllib.request import urlopen


def run(*args, capture=False):
    print('+', ' '.join(map(str, args)), flush=True)
    result = subprocess.run(list(map(str, args)), check=True, text=True,
                            stdout=subprocess.PIPE if capture else None)
    return result.stdout if capture else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--destination', default='/mnt/Code/.runtime')
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    if not args.apply or os.geteuid() != 0:
        parser.error('Requires root and --apply; stops containers during the final sync.')
    root = Path(args.destination).resolve()
    report = Path(args.report).resolve()
    report.mkdir(parents=True, exist_ok=True)
    lock = open('/run/lock/workbench-container-storage.lock', 'w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if root != Path('/mnt/Code/.runtime') or not os.path.ismount('/mnt/Code'):
        raise RuntimeError('Expected the mounted /mnt/Code data partition')
    if os.stat('/mnt/Code').st_dev == os.stat('/').st_dev:
        raise RuntimeError('Destination is on the system partition')
    if shutil.disk_usage('/mnt/Code').free < 230 * 1024**3:
        raise RuntimeError('At least 230 GiB free is required for this migration')
    current = run('docker', 'info', '--format', '{{.DockerRootDir}}', capture=True).strip()
    if current != '/var/lib/docker':
        raise RuntimeError('Unexpected Docker root: ' + current)
    containerd_config = Path('/etc/containerd/config.toml')
    if containerd_config.exists():
        raise RuntimeError('Existing containerd configuration needs explicit review')
    queues = {}
    for port in (8188, 8190):
        with urlopen(f'http://127.0.0.1:{port}/queue', timeout=5) as response:
            queues[port] = json.load(response)
        if queues[port].get('queue_running') or queues[port].get('queue_pending'):
            raise RuntimeError('ComfyUI queue is busy on port ' + str(port))
    ids = run('docker', 'ps', '-q', capture=True).split()
    all_ids = run('docker', 'ps', '-aq', capture=True).split()
    inspected = json.loads(run('docker', 'inspect', *all_ids, capture=True))
    inventory = [{'id': c['Id'], 'name': c['Name'], 'image': c['Image'],
                  'running': c['State']['Running'], 'mounts': c['Mounts']}
                 for c in inspected]
    (report / 'migration-inventory.json').write_text(json.dumps(inventory, indent=2))
    pairs = [(Path('/var/lib/docker'), root / 'docker'),
             (Path('/var/lib/containerd'), root / 'containerd')]
    for source, target in pairs:
        if not source.is_dir() or source.is_symlink() or target.exists():
            raise RuntimeError('Unexpected source or existing destination: ' + str(target))
    root.mkdir(parents=True, exist_ok=True)
    configs = {
        Path('/etc/docker/daemon.json'): None,
        containerd_config: None,
        Path('/etc/systemd/system/docker.service.d/storage-mount.conf'): None,
        Path('/etc/systemd/system/containerd.service.d/storage-mount.conf'): None,
    }
    for path in configs:
        if path.exists():
            configs[path] = path.read_bytes()
            (report / (str(path).replace('/', '_') + '.before')).write_bytes(configs[path])
    daemon = json.loads(configs[Path('/etc/docker/daemon.json')] or b'{}')
    if daemon.get('data-root', '/var/lib/docker') != '/var/lib/docker':
        raise RuntimeError('Docker data-root does not match the current store')
    status = {'stage': 'precopy', 'destination': str(root), 'running_containers': ids}

    def receipt(stage):
        status['stage'] = stage
        (report / 'migration-status.json').write_text(json.dumps(status, indent=2) + '\n')
        print('STAGE:', stage, flush=True)

    def sync(source, target, final=False):
        options = ['rsync', '-aHAXx', '--numeric-ids', '--info=stats2']
        if final:
            options.append('--delete')
        run(*options, str(source) + '/', str(target) + '/')

    def restore_running():
        if ids:
            run('docker', 'start', *ids)

    stopped = False
    renamed = []
    try:
        receipt('precopy')
        for source, target in pairs:
            sync(source, target)
        # Check again immediately before stopping; never interrupt a queued render.
        for port in (8188, 8190):
            with urlopen(f'http://127.0.0.1:{port}/queue', timeout=5) as response:
                queue = json.load(response)
            if queue.get('queue_running') or queue.get('queue_pending'):
                raise RuntimeError('Render started during precopy; retry after it completes')
        receipt('stopping')
        stopped = True
        if ids:
            run('docker', 'stop', '--time', '45', *ids)
        run('systemctl', 'stop', 'docker.socket', 'docker.service')
        run('systemctl', 'stop', 'containerd.service')
        receipt('final-sync')
        for source, target in pairs:
            sync(source, target, final=True)
            changes = run('rsync', '-aHAXxni', '--numeric-ids', '--delete',
                          str(source) + '/', str(target) + '/', capture=True)
            if changes.strip():
                raise RuntimeError('Source/destination differ after sync: ' + changes[:1000])
        daemon['data-root'] = str(root / 'docker')
        payloads = {
            Path('/etc/docker/daemon.json'): json.dumps(daemon, indent=2) + '\n',
            containerd_config: 'version = 2\nroot = "' + str(root / 'containerd') + '"\nstate = "/run/containerd"\n',
            Path('/etc/systemd/system/docker.service.d/storage-mount.conf'):
                '[Unit]\nRequiresMountsFor=/mnt/Code\n',
            Path('/etc/systemd/system/containerd.service.d/storage-mount.conf'):
                '[Unit]\nRequiresMountsFor=/mnt/Code\n',
        }
        for path, text in payloads.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
            os.chmod(path, 0o644)
        # Rename old stores so ignored configuration cannot silently reuse them.
        for source, target in pairs:
            backup = source.with_name(source.name + '.before-workbench-move')
            if backup.exists():
                raise RuntimeError('Backup directory already exists: ' + str(backup))
            source.rename(backup)
            renamed.append((source, backup))
        run('systemctl', 'daemon-reload')
        run('systemctl', 'start', 'containerd.service')
        run('systemctl', 'start', 'docker.socket', 'docker.service')
        actual = run('docker', 'info', '--format', '{{.DockerRootDir}}', capture=True).strip()
        if actual != str(root / 'docker'):
            raise RuntimeError('Docker did not switch to the new data root')
        moved = json.loads(run('docker', 'inspect', *all_ids, capture=True))
        if {c['Id']: c['Image'] for c in moved} != {c['Id']: c['Image'] for c in inspected}:
            raise RuntimeError('Container/image identities changed')
        restore_running()
        receipt('verifying')
        deadline = time.monotonic() + 240
        while True:
            try:
                running = set(run('docker', 'ps', '-q', '--no-trunc', capture=True).split())
                expected = {c['Id'] for c in inspected if c['State']['Running']}
                if not expected.issubset(running):
                    raise RuntimeError('An original service is not running')
                for port in (8188, 8190):
                    with urlopen(f'http://127.0.0.1:{port}/system_stats', timeout=5) as response:
                        json.load(response)
                break
            except Exception:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(5)
        receipt('verified')
    except Exception as error:
        status['error'] = str(error)
        if stopped:
            receipt('rolling-back')
            subprocess.run(['systemctl', 'stop', 'docker.socket', 'docker.service', 'containerd.service'])
            for path, original in configs.items():
                if original is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_bytes(original)
            for source, backup in reversed(renamed):
                if source.exists():
                    raise RuntimeError('Rollback destination unexpectedly exists: ' + str(source)) from error
                backup.rename(source)
            run('systemctl', 'daemon-reload')
            run('systemctl', 'start', 'containerd.service', 'docker.socket', 'docker.service')
            restore_running()
            receipt('rolled-back')
        else:
            receipt('aborted')
        raise
    # The new stores have passed identity and service checks. Only remove old copies.
    mounts = run('findmnt', '-rn', '-o', 'TARGET', capture=True).splitlines()
    for source, backup in renamed:
        if any(m == str(backup) or m.startswith(str(backup) + '/') for m in mounts):
            raise RuntimeError('Old store still has a mount; retained: ' + str(backup))
        if backup.is_symlink() or backup.parent != Path('/var/lib'):
            raise RuntimeError('Unexpected old-store path')
        print('Removing verified old copy:', backup, flush=True)
        shutil.rmtree(backup)
    receipt('complete')
    run('df', '-h', '/', '/mnt/Code')


if __name__ == '__main__':
    main()
