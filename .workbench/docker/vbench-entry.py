"""Runtime compatibility settings; upstream VBench metrics remain unchanged."""
import runpy
import torch
torch.set_num_threads(4)
torch.backends.cuda.enable_flash_sdp(False)
torch.backends.cuda.enable_mem_efficient_sdp(False)
torch.backends.cuda.enable_cudnn_sdp(False)
torch.backends.cuda.enable_math_sdp(True)
runpy.run_path('/opt/vbench-source/evaluate.py',run_name='__main__')
