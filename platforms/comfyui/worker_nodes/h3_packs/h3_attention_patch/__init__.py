"""Route the Qwen3-VL language encoder's attention to ComfyUI's chunked kernel.

ComfyUI's ``optimized_attention_for_device(..., small_input=True)`` returns
``attention_basic`` for every text encoder, which materialises the full
``[batch*heads, tokens, tokens]`` float32 score matrix. A MiniMax-H3 reference
prompt with six 1.5 MP reference images expands to ~1.2 万 Qwen3-VL tokens, so
that matrix alone needs ~23 GiB and text encoding OOMs on the 32 GB R9700.

``attention_sub_quad`` computes the same softmax in query chunks sized from the
free VRAM (peak ~1 GiB for the same tokens). Only
``comfy.text_encoders.llama`` is switched: the Qwen3-VL vision tower keeps
``attention_basic`` and the diffusion model keeps the Comfy Kitchen int8
attention selected by ``--use-ck-attention``.

Measured on 2026-10-23 with six 1.5 MP references (warm page cache): the encode
spends ~250 s in the Qwen3-VL vision tower (6084 patch tokens per image, fp32
activations, memory-bound), ~28 s in VAE encodes and ~90 s in the language
encoder. Running the vision tower in bfloat16 was tried and only saved ~25 s, so
it is not enabled here. Flash SDPA for the language encoder is unusable on this
ROCm 10.0 / gfx1201 build: the causal flash kernel returns
``hipErrorInvalidValue`` on its second launch in the same process (non-causal
launches repeat fine).
"""
import inspect
import logging

import torch
import sys

import comfy.ldm.modules.attention as attention_module

_ORIGINAL_FOR_DEVICE = attention_module.optimized_attention_for_device


def optimized_attention_for_device(device, mask=False, small_input=False):
    if small_input:
        caller = inspect.currentframe().f_back
        if (caller.f_globals.get("__name__") or "").endswith("text_encoders.llama"):
            return attention_module.attention_sub_quad
    return _ORIGINAL_FOR_DEVICE(device, mask=mask, small_input=small_input)


attention_module.optimized_attention_for_device = optimized_attention_for_device
for _name, _module in list(sys.modules.items()):
    if _name.startswith("comfy.text_encoders") and getattr(_module, "optimized_attention_for_device", None) is _ORIGINAL_FOR_DEVICE:
        _module.optimized_attention_for_device = optimized_attention_for_device

logging.info("[h3-attention-patch] llama text-encoder attention -> chunked (sub-quadratic)")


# Sub-quadratic attention picks kv_chunk_size = sqrt(k_tokens) (118 at 14k tokens)
# whenever free VRAM is tight, which multiplies the inner loop count by ~10x.
# A 1024-token kv chunk costs ~33 MiB at most and is 7x faster in that regime.
import comfy.ldm.modules.sub_quadratic_attention as _sub_quad
_ORIGINAL_EDPA = _sub_quad.efficient_dot_product_attention
_KV_CHUNK_FLOOR = 1024


def efficient_dot_product_attention(query, key_t, value, query_chunk_size=1024,
                                    kv_chunk_size=None, *args, **kwargs):
    k_tokens = key_t.shape[-1]
    if kv_chunk_size is None or kv_chunk_size < _KV_CHUNK_FLOOR:
        kv_chunk_size = min(_KV_CHUNK_FLOOR, k_tokens)
    return _ORIGINAL_EDPA(query, key_t, value, query_chunk_size=query_chunk_size,
                          kv_chunk_size=kv_chunk_size, *args, **kwargs)


# attention.py binds the function at import time, so patch both namespaces.
_sub_quad.efficient_dot_product_attention = efficient_dot_product_attention
attention_module.efficient_dot_product_attention = efficient_dot_product_attention


# --- Vision-tower embedding cache -------------------------------------------
# ``MiniMaxQwen3VL.preprocess_embed`` maps a resized reference image to Qwen3-VL
# vision embeddings. It depends only on the image tensor, never on the prompt,
# yet ComfyUI re-runs it for every new prompt (~250 s for six 1.5 MP references).
# Keying it by image content lets a batch that shares references but changes
# prompts pay the vision tower once. Entries are kept on CPU so the cache does
# not compete with the diffusion model for VRAM.
import collections
import hashlib

import torch

from comfy.text_encoders import minimax as _minimax

_ORIGINAL_PREPROCESS = _minimax.MiniMaxQwen3VL.preprocess_embed
_VISION_CACHE = collections.OrderedDict()
_VISION_CACHE_MAX = 12


def _cache_to_cpu(value):
    if torch.is_tensor(value):
        return value.detach().to("cpu")
    if isinstance(value, dict):
        return {k: _cache_to_cpu(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(_cache_to_cpu(v) for v in value)
    return value


def _cache_to_device(value, device):
    if torch.is_tensor(value):
        return value.to(device)
    if isinstance(value, dict):
        return {k: _cache_to_device(v, device) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(_cache_to_device(v, device) for v in value)
    return value


def preprocess_embed_cached(self, embed, device):
    if embed.get("type") != "image":
        return _ORIGINAL_PREPROCESS(self, embed, device)
    data = embed["data"]
    digest = hashlib.blake2b(
        data.contiguous().cpu().numpy().tobytes(), digest_size=16
    ).hexdigest()
    key = (digest, tuple(data.shape), str(data.dtype))
    cached = _VISION_CACHE.get(key)
    if cached is not None:
        _VISION_CACHE.move_to_end(key)
        logging.info("[h3-attention-patch] vision cache hit (%d entries)", len(_VISION_CACHE))
        return _cache_to_device(cached, device)
    result = _ORIGINAL_PREPROCESS(self, embed, device)
    _VISION_CACHE[key] = _cache_to_cpu(result)
    _VISION_CACHE.move_to_end(key)
    while len(_VISION_CACHE) > _VISION_CACHE_MAX:
        _VISION_CACHE.popitem(last=False)
    logging.info("[h3-attention-patch] vision cache store (%d entries)", len(_VISION_CACHE))
    return result


_minimax.MiniMaxQwen3VL.preprocess_embed = preprocess_embed_cached
logging.info("[h3-attention-patch] reference vision embeddings cached by image content")


# --- Anima LLM adapter attention ---------------------------------------------
# ``comfy.ldm.anima.model.Attention`` calls ``F.scaled_dot_product_attention``
# directly instead of ComfyUI's selected kernel. On this ROCm 10.0 / gfx1201
# build the flash and memory-efficient SDPA kernels both fail with
# ``hipErrorInvalidValue`` (masked and unmasked); only the math backend runs.
# The adapter attends over text tokens only (a few hundred), so math SDPA is
# cheap here. The Anima diffusion blocks keep ComfyUI's attention selection.
from torch.nn.attention import SDPBackend, sdpa_kernel
from comfy.ldm.anima import model as _anima

_ORIGINAL_ANIMA_ATTENTION = _anima.Attention.forward


def anima_attention_forward(self, *args, **kwargs):
    with sdpa_kernel([SDPBackend.MATH]):
        return _ORIGINAL_ANIMA_ATTENTION(self, *args, **kwargs)


_anima.Attention.forward = anima_attention_forward
logging.info("[h3-attention-patch] Anima LLM adapter SDPA -> math backend")

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
