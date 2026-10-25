"""Initialize missing SDK files once; otherwise only repair the runtime symlink."""
from pathlib import Path
import subprocess
import sys
from rocm_sdk._devel import get_devel_root

root = Path(get_devel_root())
if not (root / 'lib/libamdhip64.so').is_file():
    subprocess.run([sys.executable, '-m', 'rocm_sdk', 'init'], check=True)
    root = Path(get_devel_root())
if not (root / 'lib/libamdhip64.so').is_file():
    raise RuntimeError('ROCm SDK initialization did not provide libamdhip64.so')
link = Path('/opt/rocm101')
if not link.is_symlink() or link.resolve() != root.resolve():
    link.unlink(missing_ok=True)
    link.symlink_to(root, target_is_directory=True)
