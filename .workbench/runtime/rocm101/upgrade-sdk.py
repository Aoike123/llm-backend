"""Replace ROCm SDK components while preserving engine-specific Torch/vLLM ABI."""
import importlib.metadata as metadata
import importlib
from pathlib import Path
import subprocess
import sys
import shutil

directory=Path('/tmp/rocm101/packages')
distributions=[d for d in metadata.distributions()
     if d.metadata.get('Name','').lower().startswith('rocm-sdk-') or d.metadata.get('Name','').lower()=='rocm']
roots={Path(d.locate_file('')).resolve() for d in distributions}
sdk_root=next((Path(d.locate_file('')).resolve() for d in distributions if d.metadata['Name'].lower()=='rocm-sdk-core'),None)
assert sdk_root is not None, 'Base image has no ROCm SDK core'
old=[d.metadata['Name'] for d in distributions]
if old:subprocess.run([sys.executable,'-m','pip','uninstall','-y',*sorted(set(old))],check=True)
# Vendor overlays are outside the active venv; pip intentionally leaves them.
# Remove only SDK-owned package directories from those image-local roots.
for root in roots:
    for pattern in ['rocm_sdk*','_rocm_sdk*','rocm-*.dist-info']:
        for path in root.glob(pattern):
            if path.is_symlink():path.unlink()
            elif path.is_dir():shutil.rmtree(path)
files=[str(p) for p in sorted(directory.glob('*.whl'))]+[str(directory/'rocm-10.1.0.tar.gz')]
subprocess.run([sys.executable,'-m','pip','install','--target',str(sdk_root),'--upgrade','--no-cache-dir','--no-deps','--no-index','--no-build-isolation',*files],check=True)
importlib.invalidate_caches()
for name in ['rocm','rocm-sdk-core','rocm-sdk-libraries','rocm-sdk-device-gfx1201','rocm-sdk-devel']:
    assert metadata.version(name)=='10.1.0',(name,metadata.version(name))
for d in metadata.distributions():
    if d.metadata.get('Name','').lower().startswith('rocm-sdk-'):
        assert d.version=='10.1.0',(d.metadata['Name'],d.version)
print('ROCm SDK components consistently upgraded to 10.1.0')
subprocess.run([sys.executable,'-m','rocm_sdk','init'],check=True)
root=Path(subprocess.check_output([sys.executable,'-m','rocm_sdk','path','--root'],text=True).strip())
link=Path('/opt/rocm101')
if link.is_symlink():link.unlink()
link.symlink_to(root,target_is_directory=True)
