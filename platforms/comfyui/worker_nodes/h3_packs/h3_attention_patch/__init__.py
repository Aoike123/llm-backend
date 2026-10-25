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
ROCm 10.0 / gfx1201 build: no non-math SDPA kernel runs at all (see the
container-wide SDPA section below).
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


# --- Container-wide SDPA: math backend, query-chunked ---------------------------
# On this ROCm 10.0 / gfx1201 build every non-math ``scaled_dot_product_attention``
# kernel fails with ``hipErrorInvalidValue`` (flash and memory-efficient; causal
# or not, masked or not, head dims 64/128/512, bf16/fp16/fp32; reproduced
# 2026-10-25 in fresh processes on the first launch). ComfyUI still enables
# PyTorch attention for gfx1201 and ``comfy.ops`` puts flash first, so any code
# that calls SDPA directly crashed: the Anima LLM adapter, the H3 audio VAE
# causal attention (reference-video audio) and the SelfLift H3 upscaler block.
# The paths that already worked never reach SDPA (sub-quadratic / Comfy Kitchen
# attention, split attention in VAEs), so routing SDPA to math changes nothing
# for them.
#
# Math SDPA materialises a [B, H, Lq, Lk] score matrix. Callers like the
# upscaler attend over every latent position with one head, so queries are
# processed in chunks whenever that matrix would exceed _SDPA_SCORE_BUDGET.
from torch.nn.attention import SDPBackend, sdpa_kernel
import torch.nn.functional as _F

_ORIGINAL_SDPA = _F.scaled_dot_product_attention
_SDPA_SCORE_BUDGET = 1 << 30


def _math_sdpa(q, k, v, attn_mask=None, dropout_p=0.0, is_causal=False, scale=None, enable_gqa=False):
    with sdpa_kernel([SDPBackend.MATH]):
        return _ORIGINAL_SDPA(q, k, v, attn_mask=attn_mask, dropout_p=dropout_p, is_causal=is_causal, scale=scale, enable_gqa=enable_gqa)


def scaled_dot_product_attention(query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False, scale=None, enable_gqa=False):
    lq, lk = query.shape[-2], key.shape[-2]
    rows = query.numel() // (query.shape[-1] * lq)
    # Scores and softmax are float32 in the math path.
    chunk = max(1, _SDPA_SCORE_BUDGET // max(1, rows * lk * 4))
    if chunk >= lq:
        return _math_sdpa(query, key, value, attn_mask, dropout_p, is_causal, scale, enable_gqa)
    out = []
    positions = torch.arange(lk, device=query.device)
    for start in range(0, lq, chunk):
        stop = min(lq, start + chunk)
        mask = None
        if attn_mask is not None:
            mask = attn_mask[..., start:stop, :] if attn_mask.shape[-2] == lq else attn_mask
        if is_causal:
            # PyTorch's is_causal is the top-left aligned lower triangle.
            causal = positions[None, :] <= torch.arange(start, stop, device=query.device)[:, None]
            if mask is None:
                mask = causal
            elif mask.dtype == torch.bool:
                mask = mask & causal
            else:
                mask = mask.masked_fill(~causal, float("-inf"))
        out.append(_math_sdpa(query[..., start:stop, :], key, value, mask, dropout_p, False, scale, enable_gqa))
    return torch.cat(out, dim=-2)


_F.scaled_dot_product_attention = scaled_dot_product_attention
torch.nn.functional.scaled_dot_product_attention = scaled_dot_product_attention
logging.info("[h3-attention-patch] all SDPA -> math backend (query-chunked above %d MiB of scores)", _SDPA_SCORE_BUDGET >> 20)

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
