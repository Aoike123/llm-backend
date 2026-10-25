import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

spec = importlib.util.spec_from_file_location('configured', Path(__file__).parents[1] / 'scripts/launch-configured-llm.py')
configured = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configured)


class ConfiguredWorkerTest(unittest.TestCase):
    def test_explicit_serving_defaults_preserve_sampling_and_processor_options(self):
        argv = ['docker', 'run', '-e', 'OMP_NUM_THREADS=6', 'image', 'serve', '/models/target',
                '--max-model-len', '204800', '--max-num-seqs', '2',
                '--kv-cache-memory-bytes', '8859648000',
                '--compilation-config', json.dumps({'cudagraph_capture_sizes': [1, 8, 16]}),
                '--speculative-config', json.dumps({'num_speculative_tokens': 7}),
                '--no-enable-prefix-caching', '--mamba-cache-mode', 'align',
                '--override-generation-config', '{"temperature":0.7,"top_k":20,"top_p":0.95}',
                '--mm-processor-kwargs', '{"max_pixels":1048576}']
        result = configured.configure(argv)
        self.assertEqual(result.count('OMP_NUM_THREADS=1'), 1)
        self.assertNotIn('OMP_NUM_THREADS=6', result)
        self.assertLess(result.index('OMP_NUM_THREADS=1'), result.index('image'))
        self.assertEqual(result[result.index('--generation-config') + 1], 'vllm')
        self.assertEqual(result[result.index('--mamba-cache-mode') + 1], 'none')
        self.assertEqual(json.loads(result[result.index('--override-generation-config') + 1]),
                         {'temperature': 0.7, 'top_k': 20, 'top_p': 0.95})
        i = result.index('--mm-processor-kwargs') + 1
        self.assertEqual(json.loads(result[i]), {'max_pixels': 1048576, 'cap_pixels_per_frame': True})
        # An explicitly selected processor behavior must still win.
        result[i] = '{"cap_pixels_per_frame":false}'
        configured.configure(result)
        self.assertFalse(json.loads(result[result.index('--mm-processor-kwargs') + 1])['cap_pixels_per_frame'])

    def test_graph_limits_follow_concurrency_and_head_is_explicit(self):
        for sequences in (1, 2, 3, 4, 8):
            argv = ['docker', 'run', '-e', 'CUDA_VISIBLE_DEVICES=0', '-e', 'HIP_VISIBLE_DEVICES=0',
                    '-e', 'ROCR_VISIBLE_DEVICES=GPU-selected', 'image', 'serve', '/models/target',
                    '--max-model-len', '65536', '--max-num-seqs', str(sequences), '--kv-cache-memory-bytes', '8859648000',
                    '--compilation-config', json.dumps({'cudagraph_capture_sizes': [1, 2, 4, 8, 16, 24, 32, 40, 48, 56, 64]}),
                    '--speculative-config', json.dumps({'num_speculative_tokens': 7})]
            result = configured.configure(argv)
            sizes = json.loads(result[result.index('--compilation-config') + 1])['cudagraph_capture_sizes']
            self.assertEqual(max(sizes), sequences * 8)
            self.assertIn('PAITON_LMHEAD_W8=0', result)
            self.assertIn('RADIANCE_NVFP4_LMHEAD=bf16', result)
            self.assertLess(result.index('PAITON_LMHEAD_W8=0'), result.index('image'))
            self.assertFalse(any(value.startswith('CUDA_VISIBLE_DEVICES') for value in result))
            self.assertIn('HIP_VISIBLE_DEVICES=0', result)
            self.assertIn('ROCR_VISIBLE_DEVICES=GPU-selected', result)

    def test_eager_disables_capture_and_preserves_custom_pool(self):
        argv = ['docker', 'run', '-e', 'RADIANCE_GDN_LAZY=1', 'image', 'serve',
                '--max-model-len', '65536', '--max-num-seqs', '2',
                '--kv-cache-memory-bytes', str(10 * 2**30), '--no-enforce-eager',
                '--compilation-config', json.dumps({'cudagraph_capture_sizes': [1, 8, 16]}),
                '--speculative-config', json.dumps({'num_speculative_tokens': 7})]
        result = configured.configure(argv, True)
        self.assertIn('--enforce-eager', result)
        self.assertNotIn('--no-enforce-eager', result)
        self.assertIn('RADIANCE_GDN_LAZY=0', result)
        self.assertEqual(json.loads(result[result.index('--compilation-config')+1])['cudagraph_mode'], 'NONE')
        self.assertEqual(result[result.index('--kv-cache-memory-bytes')+1], str(10 * 2**30))

    def test_incorrect_fixed_kv_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'official KV budget'):
            configured.configure(['docker', 'run', 'image', 'serve', '--max-model-len', '65536', '--max-num-seqs', '2',
                                  '--kv-cache-memory-bytes', '1024'])

    def test_repeated_policy_flags_keep_the_last_value(self):
        # The controller appends the saved policy after the profile args, so the
        # launcher argv carries each overridden flag twice. Only the last value
        # may reach the worker launcher.
        argv = ['--mode', 'long-kv4', '--context', '262144', '--max-num-seqs', '8',
                '--kv-cache-memory-bytes', '8589934592', '--eager-mode', 'on',
                '--context', '65536', '--max-num-seqs', '6',
                '--kv-cache-memory-bytes', '8859648000', '--eager-mode', 'off']
        calls = []
        stub = ['docker', 'run', '--rm', 'image', 'serve', '/models/target',
                '--max-model-len', '65536', '--max-num-seqs', '6', '--kv-cache-memory-bytes', '8859648000',
                '--compilation-config', json.dumps({'cudagraph_capture_sizes': [1, 2]}),
                '--speculative-config', json.dumps({'num_speculative_tokens': 7})]

        def fake_run(command, **kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command, 0, stdout=json.dumps(stub), stderr='')

        original = configured.subprocess.run
        configured.subprocess.run = fake_run
        try:
            configured.command('launcher.py', argv)
        finally:
            configured.subprocess.run = original
        launcher_args = calls[0][calls[0].index('launcher.py') + 1:]
        # The worker launcher rejects --eager-mode outright, so it must not reach it.
        self.assertNotIn('--eager-mode', launcher_args)
        # Only the saved policy may survive; the profile defaults must be gone.
        self.assertEqual(launcher_args.count('--context'), 1)
        self.assertEqual(launcher_args[launcher_args.index('--context') + 1], '65536')
        self.assertEqual(launcher_args.count('--max-num-seqs'), 1)
        self.assertEqual(launcher_args[launcher_args.index('--max-num-seqs') + 1], '6')
        # command() appends its own computed pair last, which argparse resolves last-wins.
        self.assertEqual(launcher_args[launcher_args.index('--kv-cache-memory-bytes') + 1], '8859648000')
        self.assertEqual(launcher_args[launcher_args.index('--kv-cache-memory-bytes', launcher_args.index('--kv-cache-memory-bytes') + 1) + 1], '8859648000')
        self.assertNotIn('8589934592', launcher_args)
        # command() appends its own computed mode and GDN state last; later wins.
        self.assertEqual(launcher_args[-launcher_args[::-1].index('--mode')], 'long-kv4')
        self.assertEqual(launcher_args[-launcher_args[::-1].index('--gdn-state')], 'eager')
        self.assertEqual(launcher_args[-launcher_args[::-1].index('--prefix-caching')], 'on')
    def test_repeated_image_flag_collapses_before_serve(self):
        argv = ['docker', 'run', '--image', 'first', '--image', 'second', 'second', 'serve', '/models/target',
                '--max-model-len', '65536', '--max-num-seqs', '6', '--kv-cache-memory-bytes', '8859648000',
                '--compilation-config', json.dumps({'cudagraph_capture_sizes': [1, 2]}),
                '--speculative-config', json.dumps({'num_speculative_tokens': 7})]
        result = configured.configure(argv)
        self.assertEqual(result.count('--image'), 1)
        self.assertEqual(result[result.index('serve') - 1], 'second')

    def test_missing_worker_flag_is_reported(self):
        argv = ['docker', 'run', 'image', 'serve', '/models/target', '--max-model-len', '65536']
        with self.assertRaisesRegex(ValueError, 'missing --max-num-seqs'):
            configured.configure(argv)
