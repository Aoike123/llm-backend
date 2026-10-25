#!/usr/bin/env python3
"""CosyVoice 3 (RL) speech worker lifecycle and synthesis client.

The worker keeps the model resident on 127.0.0.1:18986. It reuses the vendor
torch image (ROCm 10.1) and the prepared venv/models under workspace/data/tts.
"""
import argparse
import base64
import json
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / 'workspace/data/audio/cosyvoice3'
MODEL = DATA / 'models/Fun-CosyVoice3-0.5B-rl'
MEDIA = Path.home() / '文档/llm-backend/MCP'
RUNTIME = Path(__file__).resolve().parent / 'runtime'
REPORTS = ROOT / 'workspace/reports/audio/cosyvoice3'
OUTPUTS = ROOT / 'workspace/outputs/audio/cosyvoice3'
IMAGE = 'local-ai/pation-qwen38-cpu-vision:20261013-r2'
NAME = 'paiton-tts'
API = 'http://127.0.0.1:18986'
GPU_NAMES = {'paiton-tts', 'paiton-h3', 'paiton-qwen-image21', 'paiton-flux2', 'paiton-qwen38', 'ai-vbench'}


def docker(*args, capture=False):
    return subprocess.run(['docker', *map(str, args)], check=True, text=True, capture_output=capture)


def active_containers():
    rows = docker('ps', '--format', '{{.Names}}', capture=True).stdout.split()
    return set(rows)


def post(path, payload, timeout=600):
    request = Request(API + path, data=json.dumps(payload).encode(),
                      headers={'Content-Type': 'application/json'}, method='POST')
    with urlopen(request, timeout=timeout) as response:
        return json.load(response)


def health(timeout=2):
    with urlopen(API + '/health', timeout=timeout) as response:
        return json.load(response)


def wait_ready(deadline=300):
    started = time.time()
    while time.time() - started < deadline:
        try:
            if health().get('ok'):
                return health()
        except Exception:
            time.sleep(2)
    raise RuntimeError('TTS worker did not become ready in %ss' % deadline)


def start(model_dir=MODEL):
    if NAME in active_containers():
        print('语音服务已运行：' + API)
        return
    occupied = active_containers() & (GPU_NAMES - {NAME})
    if 'paiton-qwen38' in occupied:
        sys.path.insert(0, str(ROOT / 'platforms/scheduler'))
        try:
            import residency
            if residency.sleeping():
                occupied.discard('paiton-qwen38')
        except Exception:
            pass
    if occupied:
        raise RuntimeError('请先停止其他单卡模型服务：' + ', '.join(sorted(occupied)))
    old = docker('ps', '-a', '--filter', 'name=^/' + NAME + '$', '--format', '{{.Names}}', capture=True).stdout.strip()
    if old:
        docker('rm', NAME)
    try:
        render_gid = Path('/dev/kfd').stat().st_gid
    except FileNotFoundError:  # sandboxed shells do not see host devices
        render_gid = 992
    docker(
        'run', '-d', '--name', NAME, '--restart', 'no',
        '--entrypoint', '/tts/venv/bin/python',
        '--device', '/dev/kfd', '--device', '/dev/dri', '--group-add', render_gid,
        '--ipc=host', '-p', '127.0.0.1:18986:18986',
        '-v', str(DATA) + ':/tts',
        '-v', str(MEDIA) + ':' + str(MEDIA) + ':ro',
        '-v', '/media/aoike/Resource_Trad/Assets:/media/aoike/Resource_Trad/Assets:ro',
        '-v', str(RUNTIME / 'server.py') + ':/srv/server.py:ro',
        '-v', str(RUNTIME / 'pinyin_tags.py') + ':/srv/pinyin_tags.py:ro',
        '-e', 'PYTHONUNBUFFERED=1',
        IMAGE, '-u', '/srv/server.py',
        '--host', '0.0.0.0', '--port', '18986', '--model-dir', str(model_dir).replace(str(DATA), '/tts'),
    )
    print('语音服务正在加载：' + API + '；使用 check 查看就绪状态')


def container_path(path):
    resolved = Path(path).resolve()
    if resolved.is_relative_to(DATA.resolve()):
        return '/tts/' + str(resolved.relative_to(DATA.resolve()))
    if resolved.is_relative_to(MEDIA.resolve()):
        return str(resolved)
    raise RuntimeError('参考音频必须位于 workspace/data/tts 或媒体库内：' + str(resolved))


def generate(text, reference, reference_text='', instruct=None, speed=1.0, seed=42, output=None):
    payload = {'text': text, 'reference_path': container_path(reference), 'reference_text': reference_text,
               'speed': speed, 'seed': seed}
    if instruct:
        payload['instruct'] = instruct
    result = post('/v1/audio/speech', payload)
    OUTPUTS.mkdir(parents=True, exist_ok=True)
    destination = Path(output) if output else OUTPUTS / ('tts-' + time.strftime('%Y%m%d-%H%M%S') + '.wav')
    destination.write_bytes(base64.b64decode(result['audio_base64']))
    result.pop('audio_base64', None)
    result['output'] = str(destination)
    print(json.dumps(result, ensure_ascii=False))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'start', 'stop', 'status', 'check', 'logs', 'generate'])
    parser.add_argument('--text')
    parser.add_argument('--reference', type=Path)
    parser.add_argument('--reference-text', default='')
    parser.add_argument('--instruct')
    parser.add_argument('--speed', type=float, default=1.0)
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--model-dir', type=Path, default=MODEL)
    args = parser.parse_args()

    if args.command == 'prepare':
        missing = [str(path) for path in (DATA / 'venv', DATA / 'CosyVoice-main', MODEL / 'llm.pt') if not path.exists()]
        if missing:
            print('缺少运行物料：')
            for item in missing:
                print('  ' + item)
            print('参考 docs/TTS_OPTIONS.md 与 workspace/data/tts 下的准备记录。')
            return 1
        print('运行物料齐全：venv / CosyVoice-main / ' + MODEL.name)
        return 0
    if args.command == 'start':
        start(args.model_dir)
        return 0
    if args.command == 'stop':
        docker('stop', NAME)
        return 0
    if args.command == 'status':
        docker('ps', '-a', '--filter', 'name=^/' + NAME + '$')
        return 0
    if args.command == 'logs':
        docker('logs', '--tail', '50', NAME)
        return 0
    if args.command == 'check':
        info = wait_ready()
        print(json.dumps(info, ensure_ascii=False))
        return 0
    if args.command == 'generate':
        if not args.text or not args.reference:
            raise SystemExit('generate 需要 --text 与 --reference')
        generate(args.text, args.reference, args.reference_text, args.instruct,
                 args.speed, args.seed, args.output)
        return 0


if __name__ == '__main__':
    sys.exit(main())
