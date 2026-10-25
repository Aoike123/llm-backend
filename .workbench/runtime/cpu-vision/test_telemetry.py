"""Concurrent counters and compute-only latency regressions."""
import unittest
from concurrent.futures import ThreadPoolExecutor
from telemetry import Telemetry


class TelemetryTests(unittest.TestCase):
    def test_parallel_counters_and_compute_only_latency(self):
        meter = Telemetry()
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda _: meter.add(requests=1, hits=1), range(1000)))
        meter.add(requests=1)
        meter.encoded(2.5, 16)
        self.assertEqual(meter.snapshot()['requests'], 1001)
        self.assertEqual(meter.snapshot()['hits'], 1000)
        self.assertEqual(meter.snapshot()['encodes'], 1)
        self.assertEqual(meter.snapshot()['encode_seconds'], 2.5)
        raw = meter.prometheus(threads=16, cache_bytes=42, cache_limit=1024, cache_entries=1).decode()
        self.assertIn('# TYPE cpu_vision_requests_total counter', raw)
        self.assertIn('cpu_vision_image_tokens_total 16', raw)
        self.assertIn('cpu_vision_waiting 0', raw)
        self.assertIn('cpu_vision_cache_limit_bytes 1024', raw)


if __name__ == '__main__':
    unittest.main()
