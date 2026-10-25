import sys,time,unittest,importlib.util,tempfile,contextlib
from pathlib import Path
from unittest.mock import patch,Mock
sys.path.insert(0,str(Path(__file__).parents[1]))
import residency

class ResidencyTests(unittest.TestCase):
    def test_experiment_failure_recovers_before_releasing_lease(self):
        spec=importlib.util.spec_from_file_location('residency_test_script',Path(__file__).parents[3]/'.workbench/scripts/test-llm-residency.py')
        script=importlib.util.module_from_spec(spec);spec.loader.exec_module(script)
        events=[]
        @contextlib.contextmanager
        def lease(*_):
            events.append('acquire')
            try:yield
            finally:events.append('release')
        def fail():events.append('test');raise RuntimeError('test failure')
        with tempfile.TemporaryDirectory() as directory,patch.object(script,'lease',lease),patch.object(script,'run_test',fail),patch.object(script,'recover',side_effect=lambda:events.append('recover')),patch.object(script,'REPORT',Path(directory)/'report.json'):
            with self.assertRaisesRegex(RuntimeError,'test failure'):script.main()
        self.assertEqual(events,['acquire','test','recover','release'])

    def test_unknown_sleep_state_stays_active(self):
        with patch.object(residency,'labelled',return_value=True),patch.object(residency,'request',side_effect=OSError('offline')):
            self.assertFalse(residency.sleeping())

    def test_insufficient_ram_skips_offload(self):
        policy=dict(enabled=True,models=['llm'],minimum_available_memory_gib=32)
        with patch.object(residency,'config',return_value=policy),patch.object(residency,'labelled',return_value=True),patch.object(residency,'available_memory',return_value=31*2**30),patch.object(residency,'request') as call:
            self.assertFalse(residency.sleep());call.assert_not_called()

    def test_excess_vram_fails_before_media_start(self):
        policy=dict(enabled=True,models=['llm'],minimum_available_memory_gib=32,minimum_remaining_memory_gib=16,maximum_sleep_vram_gib=3,transition_timeout_seconds=120)
        with patch.object(residency,'config',return_value=policy),patch.object(residency,'labelled',return_value=True),patch.object(residency,'available_memory',return_value=64*2**30),patch.object(residency,'request'),patch.object(residency,'sleeping',return_value=True),patch.object(residency,'vram_used',return_value=4*2**30),patch.object(residency.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'GPU memory'):residency.sleep()

if __name__=='__main__':unittest.main()
