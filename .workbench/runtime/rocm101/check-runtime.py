"""CPU-only ABI and shared-library checks; no GPU device is passed to Docker."""
import ctypes
import importlib.metadata as metadata
import json
from pathlib import Path
import torch

names=['rocm','rocm-sdk-core','rocm-sdk-libraries','rocm-sdk-device-gfx1201','rocm-sdk-devel']
versions={name:metadata.version(name) for name in names}
assert set(versions.values())=={'10.1.0'},versions
library=Path('/opt/rocm101/lib/libamdhip64.so')
assert library.exists(),library
hip=ctypes.CDLL(str(library))
runtime_version=ctypes.c_int()
assert hip.hipRuntimeGetVersion(ctypes.byref(runtime_version))==0
loaded=sorted({line.split()[-1] for line in Path('/proc/self/maps').read_text().splitlines()
               if any(name in line for name in ['libamdhip64.so','libhipblaslt.so','librocblas.so','libMIOpen.so'])})
assert loaded, 'ROCm libraries were not loaded'
assert all('/_rocm_sdk_' in name for name in loaded),loaded
print(json.dumps({'sdk':versions,'torch':torch.__version__,'torch_compiled_hip':torch.version.hip,
                  'hip_runtime_version':runtime_version.value,'loaded_libraries':loaded,
                  'gpu_qualified':False},indent=2))
