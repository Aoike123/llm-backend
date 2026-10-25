"""Thread-safe operational counters for the CPU encoder; no model inputs are retained."""
import os
import threading
import time
from pathlib import Path


class Telemetry:
    def __init__(self):
        self.lock = threading.Lock()
        self.values = dict(requests=0, failures=0, hits=0, encodes=0, image_tokens=0,
                           inflight=0, active=0, encode_seconds=0., queue_seconds=0., last_encode_seconds=0.)

    def add(self, **values):
        with self.lock:
            for key, value in values.items():
                self.values[key] += value

    def encoded(self, seconds, tokens):
        with self.lock:
            self.values['encodes'] += 1
            self.values['encode_seconds'] += seconds
            self.values['last_encode_seconds'] = seconds
            self.values['image_tokens'] += tokens

    def snapshot(self):
        with self.lock:
            return dict(self.values)

    def prometheus(self, *, threads, cache_bytes, cache_limit, cache_entries):
        v = self.snapshot()
        rows = []
        def metric(name, value, kind='gauge'):
            rows.extend([f'# TYPE cpu_vision_{name} {kind}', f'cpu_vision_{name} {value}'])
        for key in ['requests', 'failures', 'hits', 'encodes', 'image_tokens']:
            metric(key+'_total', v[key], 'counter')
        metric('encode_seconds_sum', v['encode_seconds'], 'counter')
        metric('queue_seconds_sum', v['queue_seconds'], 'counter')
        for key in ['inflight', 'active', 'last_encode_seconds']:
            metric(key, v[key])
        metric('waiting', max(0, v['inflight']-v['active']))
        metric('threads', threads)
        metric('cache_bytes', cache_bytes)
        metric('cache_limit_bytes', cache_limit)
        metric('cache_entries', cache_entries)
        metric('process_cpu_seconds_total', time.process_time(), 'counter')
        try:
            metric('process_memory_bytes', int(Path('/proc/self/statm').read_text().split()[1])*os.sysconf('SC_PAGE_SIZE'))
        except (OSError, ValueError, IndexError):
            pass
        for file, name in [('memory.current', 'container_memory_bytes'), ('memory.max', 'container_memory_limit_bytes')]:
            try:
                metric(name, int(Path('/sys/fs/cgroup', file).read_text()))
            except (OSError, ValueError):
                pass
        return ('\n'.join(rows)+'\n').encode()
