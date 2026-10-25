#!/usr/bin/env python3
"""Check a local OpenAI-compatible service and retain actual responses."""
import argparse
import datetime
import json
from pathlib import Path
import time
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:18982')
    parser.add_argument('--wait', type=int, default=600)
    args = parser.parse_args()
    base = args.url.rstrip('/')
    deadline = time.monotonic() + args.wait
    while True:
        try:
            with urlopen(base + '/health', timeout=5) as response:
                if response.status == 200:
                    break
        except OSError:
            if time.monotonic() >= deadline:
                raise SystemExit('服务未就绪；请检查 docker logs paiton-qwen38')
        time.sleep(5)
    with urlopen(base + '/v1/models', timeout=10) as response:
        models = json.load(response)
    model = models['data'][0]['id']
    results = []
    for prompt, expected in [
        ('请用中文用一句话介绍你自己。', None),
        ('计算 17 × 23，只输出整数结果。', '391'),
        ('写一个 Python 函数 add(a, b)，返回两数之和。只输出代码。', None),
    ]:
        payload = dict(model=model, messages=[dict(role='user', content=prompt)],
                       max_tokens=128, temperature=0,
                       chat_template_kwargs=dict(enable_thinking=False))
        started = time.monotonic()
        request = Request(base + '/v1/chat/completions',
                          data=json.dumps(payload).encode(),
                          headers={'Content-Type': 'application/json'})
        with urlopen(request, timeout=180) as response:
            result = json.load(response)
        content = result['choices'][0]['message'].get('content') or ''
        passed = bool(content.strip()) and (expected is None or content.strip() == expected)
        results.append(dict(prompt=prompt, response=result,
                            elapsed_seconds=time.monotonic() - started, passed=passed))
        print(content, flush=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    output = Path(__file__).resolve().parents[2] / 'workspace/reports/llm/paiton' / ('smoke-' + stamp + '.json')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(dict(url=base, models=models, checks=results,
                                     scope='Basic API smoke check; not a quality or speed benchmark'),
                                 ensure_ascii=False, indent=2) + '\n')
    print('报告：', output)
    if not all(result['passed'] for result in results):
        raise SystemExit('基础推理检查未全部通过，查看报告中的原始响应。')


if __name__ == '__main__':
    main()
