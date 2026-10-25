"""ROCm 10.1 VMM scalar reads: stage through a native pool during weight load.

Only injected into sleep-enabled test/worker containers. Large weight backups
continue to use vLLM's allocator; no model weights or kernels are changed.
"""
from contextlib import contextmanager
import torch
from vllm.device_allocator.cumem import CuMemAllocator

_original_pool=CuMemAllocator.use_memory_pool
_original_item=torch.Tensor.item
_original_equal=torch.equal
_original_bool=torch.Tensor.__bool__
_depth=0
_staging_pool=None

@contextmanager
def memory_pool(self,tag=None):
    global _depth
    with _original_pool(self,tag):
        if tag=='weights':_depth+=1
        try:yield
        finally:
            if tag=='weights':_depth-=1

def item(tensor,*args):
    global _staging_pool
    if _depth and tensor.is_cuda:
        if _staging_pool is None:_staging_pool=torch.cuda.MemPool()
        with torch.cuda.use_mem_pool(_staging_pool):
            staged=tensor.clone()
            return _original_item(staged,*args)
    return _original_item(tensor,*args)

def equal(first,second):
    global _staging_pool
    if _depth and (first.is_cuda or second.is_cuda):
        if _staging_pool is None:_staging_pool=torch.cuda.MemPool()
        with torch.cuda.use_mem_pool(_staging_pool):
            return _original_equal(first,second)
    return _original_equal(first,second)

def boolean(tensor):
    if _depth and tensor.is_cuda:
        if tensor.numel()!=1:return _original_bool(tensor)
        return bool(item(tensor))
    return _original_bool(tensor)

CuMemAllocator.use_memory_pool=memory_pool
torch.Tensor.item=item
torch.equal=equal
torch.Tensor.equal=equal
torch.Tensor.__bool__=boolean
