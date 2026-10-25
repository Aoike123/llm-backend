#!/usr/bin/env python3
"""CosyVoice 3 speech service: zero-shot cloning, instruct, pinyin tags.

Runs inside the TTS container on 127.0.0.1:18986. The model stays resident and
up to ``--concurrency`` requests share it: CosyVoice keeps per-request state by
uuid, so only the LLM token sampler needs isolating. Each request samples from
its own seeded CUDA generator, which keeps seeds reproducible under concurrency.
"""
import argparse
import base64
import io
import json
import sys
import threading
import time

import torch

sys.path[:0] = ['/tts/CosyVoice-main', '/tts/CosyVoice-main/third_party/Matcha-TTS']

# gfx1201: flash/efficient SDPA kernels are unreliable, math is the safe path.
torch.backends.cuda.enable_flash_sdp(False)
torch.backends.cuda.enable_mem_efficient_sdp(False)
torch.backends.cuda.enable_math_sdp(True)

import soundfile as sf
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from pinyin_tags import convert

app = FastAPI(title='Paiton TTS', version='1.0')
state = {'model': None, 'model_dir': None, 'model_name': 'Fun-CosyVoice3-0.5B-rl',
         'sample_rate': 24000, 'lock': threading.Lock(), 'requests': 0, 'active': 0,
         'concurrency': 1, 'slots': threading.BoundedSemaphore(1)}
PROMPT_MARKER = '<|endofprompt|>'
sampler = threading.local()


def isolate_sampling():
    """Give every request its own token-sampling generator.

    The flow decoder and causal HiFT use fixed noise buffers at inference, so the
    LLM sampler's ``multinomial`` is the only random draw. CosyVoice runs that
    sampler in a worker thread it starts per request, so the generator is handed
    from the request thread to that worker when it is created.
    """
    import types
    import cosyvoice.cli.model as model_module
    import cosyvoice.utils.common as common

    class SeededThread(threading.Thread):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.generator = getattr(sampler, 'generator', None)

        def run(self):
            sampler.generator = self.generator
            super().run()

    model_module.threading = types.SimpleNamespace(Thread=SeededThread, Lock=threading.Lock)

    def nucleus_sampling(weighted_scores, top_p=0.8, top_k=25):
        prob, indices = [], []
        cum_prob = 0.0
        sorted_value, sorted_idx = weighted_scores.softmax(dim=0).sort(descending=True, stable=True)
        for i in range(len(sorted_idx)):
            if cum_prob < top_p and len(prob) < top_k:
                cum_prob += sorted_value[i]
                prob.append(sorted_value[i])
                indices.append(sorted_idx[i])
            else:
                break
        prob = torch.tensor(prob).to(weighted_scores)
        indices = torch.tensor(indices, dtype=torch.long).to(weighted_scores.device)
        return indices[prob.multinomial(1, replacement=True, generator=getattr(sampler, 'generator', None))].item()

    def random_sampling(weighted_scores, decoded_tokens, sampling):
        return weighted_scores.softmax(dim=0).multinomial(
            1, replacement=True, generator=getattr(sampler, 'generator', None)).item()

    # ras_sampling looks both helpers up as module globals at call time.
    common.nucleus_sampling, common.random_sampling = nucleus_sampling, random_sampling


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    reference_path: str | None = None
    reference_text: str | None = None
    instruct: str | None = None
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    seed: int | None = None


def load_model(model_dir: str):
    from cosyvoice.cli.cosyvoice import CosyVoice3
    isolate_sampling()
    started = time.time()
    model = CosyVoice3(model_dir, load_trt=False, load_vllm=False, fp16=False)
    state.update(model=model, model_dir=model_dir, sample_rate=model.sample_rate)
    print(json.dumps({'event': 'loaded', 'model_dir': model_dir,
                      'seconds': round(time.time() - started, 1)}), flush=True)


def synthesize(req: SpeechRequest):
    model = state['model']
    if model is None:
        raise HTTPException(status_code=503, detail='model not ready')
    if not req.reference_path:
        raise HTTPException(status_code=400, detail='reference_path is required for zero-shot cloning')
    text = convert(req.text).strip()
    if not text:
        raise HTTPException(status_code=400, detail='empty text after normalization')
    # Instruct2 treats the instruction as the LLM prompt: the marker belongs to
    # the instruction, never to the sentence (otherwise the style text is read
    # into the spoken prompt).
    instruct = (req.instruct or '').strip()
    if instruct:
        # CosyVoice3 was trained with this exact prefix; without it the model
        # treats the instruction as content and reads it aloud.
        if not instruct.startswith('You are a helpful assistant'):
            instruct = 'You are a helpful assistant. ' + instruct
        if PROMPT_MARKER not in instruct:
            instruct += PROMPT_MARKER
    elif PROMPT_MARKER not in text:
        text += PROMPT_MARKER
    started = time.time()
    with state['slots']:
        with state['lock']:
            state['active'] += 1
        try:
            sampler.generator = None
            if req.seed is not None:
                sampler.generator = torch.Generator(device=model.model.device).manual_seed(req.seed)
            chunks = []
            if instruct:
                stream = model.inference_instruct2(text, instruct, req.reference_path,
                                                   stream=True, speed=req.speed)
            else:
                stream = model.inference_zero_shot(text, req.reference_text or '',
                                                   req.reference_path, stream=True, speed=req.speed)
            for chunk in stream:
                chunks.append(chunk['tts_speech'])
            with state['lock']:
                state['requests'] += 1
        finally:
            sampler.generator = None
            with state['lock']:
                state['active'] -= 1
    if not chunks:
        raise HTTPException(status_code=500, detail='model produced no audio')
    audio = torch.cat(chunks, dim=1)
    seconds = audio.shape[1] / state['sample_rate']
    with io.BytesIO() as buffer:
        sf.write(buffer, audio.squeeze(0).float().cpu().numpy(), state['sample_rate'],
                 format='WAV', subtype='PCM_16')
        payload = base64.b64encode(buffer.getvalue()).decode('ascii')
    elapsed = time.time() - started
    return {'audio_base64': payload, 'sample_rate': state['sample_rate'],
            'duration_seconds': round(seconds, 2), 'infer_seconds': round(elapsed, 2),
            'rtf': round(elapsed / seconds, 2) if seconds else None,
            'model': state['model_name'],
            'text': text, 'peak_gib': round(torch.cuda.max_memory_allocated() / 2**30, 2)}


@app.get('/health')
def health():
    return {'ok': state['model'] is not None, 'model': state['model_name'],
            'model_dir': state['model_dir'], 'sample_rate': state['sample_rate'],
            'requests': state['requests'], 'busy': state['active'] > 0,
            'active': state['active'], 'concurrency': state['concurrency'],
            'gpu': torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}


@app.get('/metrics')
def metrics():
    return {'requests': state['requests'],
            'peak_gib': round(torch.cuda.max_memory_allocated() / 2**30, 2) if torch.cuda.is_available() else None}


@app.post('/v1/audio/speech')
def speech(req: SpeechRequest):
    return synthesize(req)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=18986)
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--concurrency', type=int, default=3,
                        help='requests sharing the resident model; 1 restores strict serial execution')
    args = parser.parse_args()
    if args.concurrency < 1:
        parser.error('--concurrency must be at least 1')
    state.update(concurrency=args.concurrency, slots=threading.BoundedSemaphore(args.concurrency))
    load_model(args.model_dir)
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level='warning')


if __name__ == '__main__':
    main()
