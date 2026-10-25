"""Generate the official GenEval prompt suite through the local Qwen-Image API."""
import argparse
import base64
import datetime
import json
from pathlib import Path
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]


def export(metadata_path, output, endpoint, limit=None, samples=4, size=1024):
    if samples < 1 or (limit is not None and limit < 1):
        raise ValueError("samples 和 limit 必须大于零")
    records = [json.loads(line) for line in metadata_path.read_text().splitlines() if line.strip()]
    if limit is not None:
        records = records[:limit]
    output.mkdir(parents=True, exist_ok=False)
    protocol = {"endpoint": endpoint, "samples_per_prompt": samples, "size": size,
                "prompt_count": len(records), "partial_suite": limit is not None,
                "steps": 40, "guidance": 1.0, "seed_rule": "42 + prompt_index * samples + sample_index",
                "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "sources": json.loads((ROOT / ".workbench/sources.lock.json").read_text())}
    (output / "protocol.json").write_text(json.dumps(protocol, indent=2))
    for index, metadata in enumerate(records):
        folder = output / f"{index:05d}"
        (folder / "samples").mkdir(parents=True)
        (folder / "metadata.jsonl").write_text(json.dumps(metadata) + "\n")
        for sample in range(samples):
            payload = {"prompt": metadata["prompt"], "size": f"{size}x{size}",
                       "n": 1, "seed": 42 + index * samples + sample, "steps": 40, "guidance": 1.0}
            request = Request(endpoint, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
            started = time.perf_counter()
            with urlopen(request, timeout=900) as response:
                receipt = json.load(response)
            png = base64.b64decode(receipt["data"][0]["b64_json"], validate=True)
            if not png.startswith(b"\x89PNG\r\n\x1a\n"):
                raise ValueError("图像 API 没有返回 PNG")
            (folder / "samples" / f"{sample:05d}.png").write_bytes(png)
            receipt["data"][0].pop("b64_json")
            receipt.update({"request": payload, "http_seconds": time.perf_counter() - started})
            (folder / f"receipt-{sample:05d}.json").write_text(json.dumps(receipt, indent=2))
            print(f"{index+1}/{len(records)} prompt, sample {sample+1}/{samples}", flush=True)
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--samples", type=int, default=4)
    parser.add_argument("--size", type=int, choices=(1024, 2048), default=1024)
    parser.add_argument("--endpoint", default="http://127.0.0.1:8191/v1/images/generations")
    args = parser.parse_args()
    output = ROOT / "workspace/outputs/geneval" / datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    print(export(ROOT / ".workbench/vendor/geneval/prompts/evaluation_metadata.jsonl", output, args.endpoint, args.limit, args.samples, args.size))
