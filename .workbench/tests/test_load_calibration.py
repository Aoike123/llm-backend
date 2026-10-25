import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / 'cache/dsh-probe/load-calibration.py'
spec = importlib.util.spec_from_file_location('load_calibration', path)
load = importlib.util.module_from_spec(spec)
spec.loader.exec_module(load)


class LoadCalibrationTest(unittest.TestCase):
    def test_peak_is_aggregated_from_records_and_requires_real_overlap(self):
        rows = [{'time': t, 'used_bytes': 20 + t, 'free_bytes': 12 - t,
                 'running': 6, 'kv_fraction': .95} for t in range(5)]
        results = [{'success': True}] * 6
        summary = load.summarize(rows, 6, .9, results, False)
        self.assertEqual(summary['vram_peak_bytes'], 24)
        self.assertEqual(summary['min_free_bytes'], 8)
        self.assertTrue(summary['valid_full_load_sample'])
        self.assertFalse(load.summarize(rows, 6, .9, results, True)['valid_full_load_sample'])
        self.assertFalse(load.summarize(rows, 6, .9, results[:-1], False)['valid_full_load_sample'])

    def test_queued_lanes_and_discontinuous_residency_do_not_count_as_full_load(self):
        rows = [{'time': t, 'used_bytes': 20, 'free_bytes': 12,
                 'running': 5, 'kv_fraction': .95} for t in range(8)]
        results = [{'success': True}] * 6
        self.assertFalse(load.summarize(rows, 6, .9, results, False)['valid_full_load_sample'])
        for i, row in enumerate(rows):
            row['running'] = 6
            row['kv_fraction'] = .95 if i % 3 else .2
        self.assertFalse(load.summarize(rows, 6, .9, results, False)['valid_full_load_sample'])
