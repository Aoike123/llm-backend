"""Adapt vendor Torch SDK initialization to 10.1 without importing Torch."""
import ast
import importlib.util
import shutil
from pathlib import Path
from rocm_sdk import _dist_info

spec=importlib.util.find_spec('torch')
assert spec and spec.submodule_search_locations
path=Path(next(iter(spec.submodule_search_locations)))/'_rocm_init.py'
if path.exists():
    source=path.read_text()
    tree=ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and node.func.attr=='initialize_process':
            for keyword in node.keywords:
                if keyword.arg=='preload_shortnames':
                    names=ast.literal_eval(keyword.value)
                    missing=set(names)-set(_dist_info.ALL_LIBRARIES)
                    # ROCm SMI has been superseded by AMD SMI in 10.1.
                    assert missing <= {'rocm_smi64'},missing
                    keyword.value=ast.List(elts=[ast.Constant(name) for name in names if name not in missing],ctx=ast.Load())
                elif keyword.arg=='check_version':
                    keyword.value=ast.Constant('10.1.0')
    path.write_text(ast.unparse(tree)+'\n')
    print('Updated vendor Torch SDK initialization:',path)

# MoRI in the vendor image is compiled against the removed ROCm SMI library.
# It only serves distributed expert communication on gfx942/gfx950, not R9700.
# Hide the optional package so vLLM's has_mori() probe selects its normal path.
mori=importlib.util.find_spec('mori')
if mori and mori.submodule_search_locations:
    directory=Path(next(iter(mori.submodule_search_locations)))
    disabled=Path('/opt/paiton/disabled-rocm100-components/mori')
    disabled.parent.mkdir(parents=True,exist_ok=True)
    assert not disabled.exists(),str(disabled)
    shutil.move(str(directory),str(disabled))
    print('Disabled unsupported optional ROCm 10.0 MoRI package:',disabled)
