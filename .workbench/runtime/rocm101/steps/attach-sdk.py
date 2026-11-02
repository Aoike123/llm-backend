"""Build step: replace the vendor ROCm SDK with the shared host SDK mounted at /opt/rocm101-sdk.

The small Python packages and dist-info of the SDK are copied into the image (pip metadata and
version checks keep working); the heavy _rocm_sdk_* trees become symlinks into the mount, and
/opt/rocm101 points at the devel tree. Then the vendor torch is adapted to the new SDK.
"""
import importlib
import importlib.metadata as metadata
from pathlib import Path
import runpy
import shutil

SDK = Path("/opt/rocm101-sdk")
HEAVY = ("_rocm_sdk_core", "_rocm_sdk_devel", "_rocm_sdk_libraries")
assert (SDK / "_rocm_sdk_devel/lib/libamdhip64.so").exists(), "shared SDK is not mounted"

owned = [d for d in metadata.distributions() if d.metadata.get("Name", "").lower() in ("rocm",) or d.metadata.get("Name", "").lower().startswith("rocm-sdk-")]
roots = {Path(d.locate_file("")).resolve() for d in owned}
core = next((Path(d.locate_file("")).resolve() for d in owned if d.metadata["Name"].lower() == "rocm-sdk-core"), None)
assert core is not None, "the base image has no ROCm SDK to replace"
# Console scripts the vendor SDK installed outside site-packages (as pip uninstall would remove).
for dist in owned:
    for entry in dist.files or []:
        path = Path(dist.locate_file(entry)).resolve()
        if not any(path.is_relative_to(root) for root in roots) and path.is_file():
            path.unlink()
# Remove every vendor SDK package and its metadata, wherever the vendor installed it.
for root in roots:
    for pattern in ("rocm_sdk*", "_rocm_sdk*", "rocm-*.dist-info"):
        for item in root.glob(pattern):
            if item.is_symlink() or item.is_file():
                item.unlink()
            else:
                shutil.rmtree(item)
for item in SDK.iterdir():
    if item.name == "SHA256SUMS":
        continue
    target = core / item.name
    if item.name in HEAVY:
        target.symlink_to(item, target_is_directory=True)
    else:
        shutil.copytree(item, target, symlinks=True)
link = Path("/opt/rocm101")
if link.is_symlink() or link.exists():
    link.unlink()
link.symlink_to(core / "_rocm_sdk_devel", target_is_directory=True)
importlib.invalidate_caches()
expected = metadata.Distribution.at(next(SDK.glob("rocm_sdk_core-*.dist-info"))).version
for name in ("rocm", "rocm-sdk-core", "rocm-sdk-libraries", "rocm-sdk-device-gfx1201", "rocm-sdk-devel"):
    assert metadata.version(name) == expected, (name, metadata.version(name), expected)
print("ROCm SDK attached at", core)
runpy.run_path(str(Path(__file__).with_name("patch-torch-init.py")), run_name="__main__")
