import ast
from contextlib import nullcontext
import importlib.util
import json
import math
from dataclasses import dataclass
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace
import unittest

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('workbench_runtime', root / '.workbench/runtime/rocm101/workbench_runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeTest(unittest.TestCase):
    def test_image_backend_migration_preserves_explicit_selection(self):
        self.assertEqual(runtime.image_processor_kwargs({'use_fast':True}), {'backend':'torchvision'})
        self.assertEqual(runtime.image_processor_kwargs({'use_fast':False}), {'backend':'pil'})
        self.assertEqual(runtime.image_processor_kwargs({'use_fast':True, 'backend':'pil', 'max_pixels':123}),
                         {'backend':'pil', 'max_pixels':123})
        # Callers that only configure video must gain no image backend argument.
        self.assertEqual(runtime.image_processor_kwargs({'cap_pixels_per_frame':True}), {'cap_pixels_per_frame':True})

    def test_dflash_entrypoint_retains_setup_and_calls_supported_launcher(self):
        source = (root / 'engines/shared/paiton/upstream/paiton_vllm_plugin/dflash/serve.py').read_text()
        patched = runtime.server_source(source)
        tree = ast.parse(patched)
        main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        calls = []
        settings = SimpleNamespace(sample_method='greedy', rerank=0, block_candidates=8, verify_cap=0)
        scope = {'os':SimpleNamespace(environ={}), 'sys':SimpleNamespace(argv=['serve', '--model', 'target']),
                 'json':json, 'prepare_server_args':lambda argv, env:argv,
                 'Settings':SimpleNamespace(from_environment=lambda env:settings), '__package__':'paiton_vllm_plugin.dflash'}
        modules = {'paiton_vllm_plugin.activation':SimpleNamespace(activate=lambda *a:None),
                   'paiton_vllm_plugin.dflash':SimpleNamespace(install=lambda:calls.append('install')),
                   'vllm.entrypoints.launchers.api_server.entry':SimpleNamespace(main=lambda:calls.append('launch'))}
        with patch.dict('sys.modules', modules):
            exec(compile(ast.Module(body=[main], type_ignores=[]), '<server>', 'exec'), scope)
            scope['main']()
        self.assertEqual(calls, ['install', 'launch'])
        self.assertEqual(scope['sys'].argv[1:], ['--model', 'target'])
        self.assertNotIn('vllm.entrypoints.openai.api_server', patched)
        with self.assertRaisesRegex(RuntimeError, 'Unsupported DFlash'):
            runtime.server_source('changed vendor implementation')

    def test_hip_stays_hip_across_repeated_sync_and_conflicts_are_rejected(self):
        source = (root / 'engines/shared/paiton/upstream/paiton_vllm_plugin/_vendor/qwen38/compat/overlays/vllm/platforms/rocm.py').read_text()
        patched = runtime.hip_source(source)
        tree = ast.parse(patched)
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_sync_hip_cuda_env_vars')
        warnings = []
        environment = {'HIP_VISIBLE_DEVICES': '0'}
        scope = {'os': SimpleNamespace(environ=environment), 'logger': SimpleNamespace(warning_once=lambda *a, **kw: warnings.append(a))}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<sync>', 'exec'), scope)
        scope['_sync_hip_cuda_env_vars']()
        scope['_sync_hip_cuda_env_vars']()
        self.assertEqual(environment, {'HIP_VISIBLE_DEVICES': '0'})
        self.assertEqual(warnings, [])
        self.assertIn('device_control_env_var: str = "HIP_VISIBLE_DEVICES"', patched)
        environment['CUDA_VISIBLE_DEVICES'] = '1'
        with self.assertRaisesRegex(ValueError, 'Inconsistent'):
            scope['_sync_hip_cuda_env_vars']()

    def test_finder_only_delegates_forward_to_preserve_vendor_hook_order(self):
        finder = runtime.Finder()
        visited = []
        upstream = SimpleNamespace(find_spec=lambda *a: self.fail('delegated back to an outer finder'))
        original = SimpleNamespace(create_module=lambda spec:None, exec_module=lambda module:None)
        spec = SimpleNamespace(loader=original)
        downstream = SimpleNamespace(find_spec=lambda *a: (visited.append(a[0]), spec)[1])
        with patch('sys.meta_path', [upstream, finder, downstream]):
            result = finder.find_spec('vllm.v1.worker.gpu_worker')
        self.assertEqual(visited, ['vllm.v1.worker.gpu_worker'])
        self.assertIs(result.loader.original, original)

    def test_plugin_environment_is_registered_and_reads_live_value(self):
        module = SimpleNamespace(environment_variables={})
        loader = runtime.Loader(SimpleNamespace(exec_module=lambda module:None), 'vllm.envs')
        loader.exec_module(module)
        read = module.environment_variables['VLLM_DISABLE_PAITON_PLATFORM']
        with patch.dict('os.environ', {'VLLM_DISABLE_PAITON_PLATFORM':'1'}):
            self.assertTrue(read())
        with patch.dict('os.environ', {'VLLM_DISABLE_PAITON_PLATFORM':'0'}):
            self.assertFalse(read())

    def test_sparse_default_requires_indexed_attention(self):
        source = (root / 'engines/shared/paiton/upstream/paiton_vllm_plugin/_vendor/qwen38/compat/overlays/vllm/platforms/rocm.py').read_text()
        tree = ast.parse(runtime.hip_source(source))
        platform = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'RocmPlatform')
        method = next(n for n in platform.body if isinstance(n, ast.FunctionDef) and n.name == 'apply_config_platform_defaults')
        method.decorator_list = []
        ops = SimpleNamespace(is_fused_moe_enabled=lambda:False, is_linear_fp8_enabled=lambda:False,
                              is_fusion_moe_shared_experts_enabled=lambda:False)
        scope = {}
        exec(compile(ast.Module(body=[method], type_ignores=[]), '<platform>', 'exec'), scope)
        for text_config, expected in ((SimpleNamespace(), []), (SimpleNamespace(index_topk=2048), ['+sparse_attn_indexer'])):
            config = SimpleNamespace(model_config=SimpleNamespace(hf_text_config=text_config),
                                     compilation_config=SimpleNamespace(custom_ops=[]))
            with patch.dict('sys.modules', {'vllm._aiter_ops':SimpleNamespace(rocm_aiter_ops=ops)}):
                scope['apply_config_platform_defaults'](None, config)
            self.assertEqual(config.compilation_config.custom_ops, expected)

    def test_warmup_includes_gated_verifier_without_changing_gate(self):
        calls = []
        lp = SimpleNamespace(_radiance_fast_ok=False,
                             _radiance_fast_head=lambda head, hidden, bias:calls.append(('fast', hidden)))
        model = SimpleNamespace(logits_processor=lp, lm_head=object(), compute_logits=lambda hidden:calls.append(('exact', hidden)))
        model.modules = lambda:[model]
        runner = SimpleNamespace(speculator=object(), decode_query_len=8, max_num_tokens=16, max_num_reqs=1,
                                 model=model, _dummy_run=lambda size, **kw:(None, size))
        torch = SimpleNamespace(inference_mode=nullcontext, accelerator=SimpleNamespace(synchronize=lambda:calls.append(('sync', None))))
        with patch.dict('sys.modules', {'torch':torch}), patch('builtins.print'):
            runtime.warmup_worker(SimpleNamespace(model_runner=runner))
        sizes = runtime.warmup_sizes(16, 1, 8)
        self.assertEqual(calls, [(branch, size) for size in sizes for branch in ('exact', 'fast')] + [('sync', None)])
        self.assertFalse(lp._radiance_fast_ok)

    def test_dflash_warmup_covers_reachable_block_classes(self):
        for budget, lanes in ((1024, 2), (4096, 8), (16, 1)):
            sizes = runtime.warmup_sizes(budget, lanes, 8)
            self.assertTrue(all(1 <= size <= budget for size in sizes))
            blocks = {min(256, 2 ** (max(1, (size + min(size, lanes) - 1) // min(size, lanes) + 8) - 1).bit_length()) for size in sizes}
            reachable = {min(256, 2 ** (length + 8 - 1).bit_length()) for length in range(1, budget // lanes + 1)}
            self.assertTrue(reachable.issubset(blocks), (sizes, blocks, reachable))

    def test_forecast_replans_short_and_long_layouts_and_restores_config(self):
        @dataclass(frozen=True)
        class Mamba:
            num_speculative_blocks: int = 1
            block_size: int = 1600
            page_size_bytes: int = 1792000
            def max_memory_usage_bytes(self, config):
                return self.page_size_bytes * (1 + self.num_speculative_blocks)
        group = SimpleNamespace(layer_names=['gdn'], kv_cache_spec=Mamba())
        cache = SimpleNamespace(kv_cache_groups=[group], num_blocks=618)
        config = SimpleNamespace(model_config=SimpleNamespace(max_model_len=65536),
                                 scheduler_config=SimpleNamespace(max_num_seqs=6, max_num_batched_tokens=4096),
                                 num_speculative_tokens=7, cache_config=SimpleNamespace(kv_cache_memory_bytes=8859648000))
        calls = []
        def groups(cfg, specs):
            calls.append((cfg.model_config.max_model_len, cfg.scheduler_config.max_num_batched_tokens,
                          specs['gdn'].num_speculative_blocks, cfg.model_config.enforce_eager))
            return [SimpleNamespace(layer_names=['gdn'], kv_cache_spec=specs['gdn'])]
        module = SimpleNamespace(logger=SimpleNamespace(disabled=False),
            _get_per_layer_spec=lambda g, name:g.kv_cache_spec,
            get_kv_cache_groups=groups, _get_kv_cache_bytes_per_block=lambda groups:14336000,
            get_kv_cache_config_from_groups=lambda cfg, groups, budget:SimpleNamespace(kv_cache_groups=groups, num_blocks=budget//14336000),
            get_kv_cache_capacity=lambda cfg, cache:(cache.num_blocks, 0))
        with patch.dict('sys.modules', {'vllm.v1.kv_cache_interface':SimpleNamespace(MambaSpec=Mamba)}):
            plan = runtime.forecast(module, config, cache)
        self.assertEqual(plan['version'],2)
        self.assertEqual(len(plan['matrix']),4096)
        self.assertEqual(plan['coverage'],{'limit':262144,'planned':4096,'failed':0})
        self.assertFalse(plan['matrix']['196608:2:graph']['enforce_eager'])
        self.assertTrue(plan['matrix']['196608:2:eager']['enforce_eager'])
        self.assertEqual(plan['matrix']['65536:6:graph']['gdn'],'lazy')
        self.assertEqual(plan['matrix']['65536:6:eager']['gdn'],'eager')
        self.assertLess(plan['matrix']['65536:6:graph']['blocks_per_request'],plan['matrix']['65536:6:eager']['blocks_per_request'])
        self.assertEqual(config.scheduler_config.max_num_seqs,6)
        self.assertFalse(config.model_config.enforce_eager)
        self.assertIn((65536,4096,1,False), calls)
        self.assertIn((196608,1024,7,False), calls)
        self.assertEqual(config.model_config.max_model_len,65536)
        self.assertEqual(config.scheduler_config.max_num_batched_tokens,4096)
        self.assertFalse(module.logger.disabled)
        config.cache_config.enable_prefix_caching = True
        with patch.dict('sys.modules', {'vllm.v1.kv_cache_interface':SimpleNamespace(MambaSpec=Mamba)}):
            cached = runtime.forecast(module, config, cache)
        self.assertTrue(cached['prefix_caching'])
        self.assertEqual(cached['matrix']['65536:6:graph']['gdn'], 'eager')
        self.assertEqual(cached['matrix']['65536:6:graph']['blocks_per_request'],
                         cached['matrix']['65536:6:eager']['blocks_per_request'])
        def fail(*args):raise ValueError('planner failed')
        module.get_kv_cache_groups=fail
        errors=[]
        with patch.dict('sys.modules', {'vllm.v1.kv_cache_interface':SimpleNamespace(MambaSpec=Mamba)}):
            with patch('sys.stderr', new=SimpleNamespace(write=errors.append, flush=lambda:None)):
                broken = runtime.forecast(module,config,cache)
        # A layout the planner rejects must be left out, not guessed, and must not
        # abort the preview for every other configuration.
        self.assertEqual(broken['matrix'],{})
        self.assertTrue(any('layout combinations could not be planned' in chunk for chunk in errors))
        self.assertEqual(config.model_config.max_model_len,65536)
        self.assertEqual(config.scheduler_config.max_num_batched_tokens,4096)
        self.assertFalse(module.logger.disabled)


if __name__ == '__main__':
    unittest.main()
