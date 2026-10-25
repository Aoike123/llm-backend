"""Run only with the FLUX image and no other GPU model active."""
import torch
from torch.nn.attention import sdpa_kernel,SDPBackend
q=torch.randn(1,24,16,128,dtype=torch.bfloat16,device='cuda');k=torch.randn(1,8,16,128,dtype=torch.bfloat16,device='cuda');v=torch.randn_like(k)
for backend in [SDPBackend.MATH,SDPBackend.FLASH_ATTENTION]:
    try:
        with sdpa_kernel(backend):out=torch.nn.functional.scaled_dot_product_attention(q,k,v,is_causal=True,enable_gqa=True)
        torch.cuda.synchronize();print(backend,'finite',out.isfinite().all().item(),flush=True)
    except Exception as e:print(backend,type(e).__name__,str(e),flush=True)
