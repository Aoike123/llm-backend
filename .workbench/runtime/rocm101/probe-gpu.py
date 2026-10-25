"""Small GPU sanity probe, to be run only after host upgrade and reboot."""
import json
import torch

assert torch.cuda.is_available()
torch.manual_seed(42)
with torch.inference_mode():
    a=torch.randn(512,512,device='cuda',dtype=torch.bfloat16)
    b=torch.randn_like(a)
    for _ in range(4):
        result=a@b
    assert torch.isfinite(result).all().item()
    image=torch.randn(1,4,64,64,device='cuda',dtype=torch.bfloat16)
    kernel=torch.randn(8,4,3,3,device='cuda',dtype=torch.bfloat16)
    convolution=torch.nn.functional.conv2d(image,kernel,padding=1)
    assert torch.isfinite(convolution).all().item()
    torch.cuda.synchronize()
print(json.dumps({'device':torch.cuda.get_device_name(),'gemm_finite':True,
                  'convolution_finite':True,'peak_allocated_bytes':torch.cuda.max_memory_allocated()}))
