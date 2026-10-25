"""Local HIP device selection and predictions from the live KV planner."""
import importlib.abc
from dataclasses import replace
import json
import os
from pathlib import Path
import sys


def server_source(source):
    """Use the supported API launcher while keeping Paiton's DFlash setup."""
    old = "    sys.argv = ['vllm.entrypoints.openai.api_server', *args]\n    runpy.run_module('vllm.entrypoints.openai.api_server', run_name='__main__')"
    if source.count(old) != 1:
        raise RuntimeError('Unsupported DFlash server entrypoint')
    return source.replace(old, "    sys.argv = ['vllm.entrypoints.launchers.api_server.entry', *args]\n    from vllm.entrypoints.launchers.api_server.entry import main as launch_server\n    launch_server()")


def image_processor_kwargs(kwargs):
    """Translate the image-only option at the image loader, never at video input."""
    kwargs = dict(kwargs)
    if 'use_fast' in kwargs:
        fast = kwargs.pop('use_fast')
        kwargs.setdefault('backend', 'torchvision' if fast else 'pil')
    return kwargs


def hip_source(source):
    old = '    elif hip_val is not None:\n        os.environ["CUDA_VISIBLE_DEVICES"] = hip_val\n'
    control = 'device_control_env_var: str = "CUDA_VISIBLE_DEVICES"'
    if source.count(old) != 1 or source.count(control) != 1:
        raise RuntimeError('Unsupported ROCm visibility implementation')
    source = source.replace(old, '    elif hip_val is not None:\n        pass\n')
    old = '        os.environ["HIP_VISIBLE_DEVICES"] = cuda_val\n'
    if source.count(old) != 1:
        raise RuntimeError('Unsupported ROCm visibility fallback')
    source = source.replace(old, old + '    os.environ.pop("CUDA_VISIBLE_DEVICES", None)\n')
    env_import = 'import vllm.envs as envs'
    if source.count(env_import) != 1:
        raise RuntimeError('Unsupported ROCm environment import')
    source = source.replace(env_import, env_import + '\nenvs.environment_variables.setdefault("HIP_VISIBLE_DEVICES", lambda: os.environ.get("HIP_VISIBLE_DEVICES"))')
    sparse = '        compilation_config.custom_ops.append("+sparse_attn_indexer")'
    if source.count(sparse) != 1:
        raise RuntimeError('Unsupported ROCm sparse attention default')
    source = source.replace(sparse, '        if getattr(vllm_config.model_config.hf_text_config, "index_topk", None) is not None:\n    ' + sparse)
    return source.replace(control, 'device_control_env_var: str = "HIP_VISIBLE_DEVICES"')


def warmup_sizes(max_tokens, lanes, query):
    # DFlash chooses BLOCK_SIZE from (target tokens per request + query).
    # Exercise every block class reachable under the configured batch budget.
    sizes = {1, min(max_tokens, lanes * query), max_tokens}
    for block in (16, 32, 64, 128, 256):
        per_request = max(1, block // 2 + 1 - query)
        size = lanes * per_request
        if size <= max_tokens:
            sizes.add(size)
    return sorted(sizes)


def warmup_worker(worker):
    import torch
    runner = worker.model_runner
    if getattr(runner, 'speculator', None) is None:
        return
    query = runner.decode_query_len
    sizes = warmup_sizes(runner.max_num_tokens, runner.max_num_reqs, query)
    with torch.inference_mode():
        for size in sizes:
            _, hidden = runner._dummy_run(size, skip_eplb=True)
            if hidden is not None:
                runner.model.compute_logits(hidden)
                # Dummy batches leave the verifier on its exact fallback. Warm
                # its gated fast head explicitly without changing the live gate.
                for model in runner.model.modules():
                    lp = getattr(model, 'logits_processor', None)
                    head = getattr(model, 'lm_head', None)
                    fast = getattr(lp, '_radiance_fast_head', None)
                    if fast is not None and head is not None:
                        fast(head, hidden, None)
        torch.accelerator.synchronize()
    print(f'[workbench.warmup] DFlash inputs and exact rerank ready: {sizes}', flush=True)


def worker_source(source):
    anchor = '        # All warmup is done — start monitoring for unexpected JIT'
    if source.count(anchor) != 1:
        raise RuntimeError('Unsupported worker warmup implementation')
    return source.replace(anchor, '        from workbench_runtime import warmup_worker\n        warmup_worker(self)\n\n' + anchor)


def forecast(module, config, cache):
    """Replan serving layouts from the measured layer specs, without GPU work.

    The whole configured 1K-256K x 1-8 lane space is planned so the panel can show
    a predicted VRAM result before a restart; only the context/concurrency really in
    use is ever allocated. An over-budget pool cannot be previewed by trying it,
    because the worker would be killed by the OOM before it could report anything.
    """
    from vllm.v1.kv_cache_interface import MambaSpec
    original = config.model_config.max_model_len
    prefill = config.scheduler_config.max_num_batched_tokens
    disabled = module.logger.disabled
    layer_specs = {name: module._get_per_layer_spec(group, name)
                   for group in cache.kv_cache_groups for name in group.layer_names}
    sequences = config.scheduler_config.max_num_seqs
    eager = getattr(config.model_config, 'enforce_eager', False)
    budget = config.cache_config.kv_cache_memory_bytes
    limit = getattr(getattr(config.model_config, 'hf_config', None), 'max_position_embeddings', None) \
        or getattr(getattr(config.model_config, 'hf_text_config', None), 'max_position_embeddings', None) \
        or 262144
    matrix = {}
    failed = 0
    try:
        module.logger.disabled = True
        for context in range(1024, limit + 1, 1024):
            for lanes in range(1, 9):
                for execution in (False, True):
                    config.model_config.max_model_len = context
                    config.model_config.enforce_eager = execution
                    config.scheduler_config.max_num_seqs = lanes
                    config.scheduler_config.max_num_batched_tokens = 4096 if context <= 65536 else 1024
                    lazy = context <= 65536 and not execution and not getattr(config.cache_config, 'enable_prefix_caching', False)
                    try:
                        specs = {name: replace(spec, num_speculative_blocks=1 if lazy else config.num_speculative_tokens)
                                 if isinstance(spec, MambaSpec) else spec for name, spec in layer_specs.items()}
                        groups = module.get_kv_cache_groups(config, specs)
                        module.get_kv_cache_config_from_groups(config, groups, budget)
                        block_bytes = module._get_kv_cache_bytes_per_block(groups)
                        blocks_per_request = sum((g.kv_cache_spec.max_memory_usage_bytes(config) +
                            g.kv_cache_spec.page_size_bytes - 1) // g.kv_cache_spec.page_size_bytes for g in groups)
                        matrix[f'{context}:{lanes}:{"eager" if execution else "graph"}'] = {
                            'block_bytes': block_bytes, 'blocks_per_request': blocks_per_request,
                            'gdn': 'lazy' if lazy else 'eager',
                            'prefill_tokens': config.scheduler_config.max_num_batched_tokens,
                            'enforce_eager': execution}
                    except Exception:
                        # A layout that cannot be planned must stay absent, never be guessed.
                        failed += 1
    finally:
        config.model_config.max_model_len = original
        config.model_config.enforce_eager = eager
        config.scheduler_config.max_num_seqs = sequences
        config.scheduler_config.max_num_batched_tokens = prefill
        module.logger.disabled = disabled
    if failed:
        print(f'[workbench.kv] {failed} of {len(matrix) + failed} layout combinations could not be planned', file=sys.stderr)
    details = [{'type': type(group.kv_cache_spec).__name__, 'layers': len(group.layer_names),
                'block_tokens': group.kv_cache_spec.block_size,
                'page_bytes': group.kv_cache_spec.page_size_bytes,
                'blocks_per_request': (group.kv_cache_spec.max_memory_usage_bytes(config) + group.kv_cache_spec.page_size_bytes - 1) // group.kv_cache_spec.page_size_bytes}
               for group in cache.kv_cache_groups]
    return {'id': os.environ.get('WORKBENCH_KV_PLAN_ID'),
            'context_tokens': original,
            'concurrency': sequences, 'eager': eager, 'kv_budget_bytes': budget, 'version': 2,
            'prefix_caching': getattr(config.cache_config, 'enable_prefix_caching', False),
            'capacity_tokens': module.get_kv_cache_capacity(config, cache)[0],
            'pool_blocks': cache.num_blocks, 'groups': details,
            'coverage': {'limit': limit, 'planned': len(matrix), 'failed': failed},
            'matrix': matrix}


class Loader(importlib.abc.Loader):
    def __init__(self, original, name):
        self.original, self.name = original, name

    def create_module(self, spec):
        return self.original.create_module(spec)

    def exec_module(self, module):
        patches = {'vllm.platforms.rocm': hip_source,
                   'paiton_vllm_plugin.dflash.serve': server_source,
                   'vllm.v1.worker.gpu_worker': worker_source}
        if self.name in patches:
            patch = patches[self.name]
            source = patch(self.original.get_source(self.name))
            filename = getattr(self.original, 'original', self.original.get_filename(self.name))
            exec(compile(source, filename, 'exec'), module.__dict__)
        elif self.name == 'vllm.envs':
            self.original.exec_module(module)
            module.environment_variables.setdefault(
                'VLLM_DISABLE_PAITON_PLATFORM',
                lambda: os.environ.get('VLLM_DISABLE_PAITON_PLATFORM', '0') == '1')
        elif self.name == 'transformers.models.auto.image_processing_auto':
            self.original.exec_module(module)
            original = module.AutoImageProcessor.from_pretrained

            def from_pretrained(cls, *args, **kwargs):
                return original(*args, **image_processor_kwargs(kwargs))

            module.AutoImageProcessor.from_pretrained = classmethod(from_pretrained)
        else:
            self.original.exec_module(module)
            update = module.update_kv_cache_capacity

            def publish(config, cache):
                update(config, cache)
                try:
                    path = Path(os.environ['WORKBENCH_KV_PLAN_PATH'])
                    data = forecast(module, config, cache)
                    temporary = path.with_suffix('.tmp')
                    temporary.write_text(json.dumps(data))
                    temporary.replace(path)
                except Exception as error:
                    print('[workbench.kv] prediction unavailable: ' + str(error), file=sys.stderr)

            module.update_kv_cache_capacity = publish


class Finder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname not in ('vllm.platforms.rocm', 'vllm.v1.core.kv_cache_utils', 'paiton_vllm_plugin.dflash.serve', 'transformers.models.auto.image_processing_auto', 'vllm.envs', 'vllm.v1.worker.gpu_worker'):
            return None
        # Delegate only downstream, preserving vendor hooks and source/hash checks.
        after = False
        for finder in tuple(sys.meta_path):
            if finder is self:
                after = True
                continue
            if not after:
                continue
            spec = finder.find_spec(fullname, path, target)
            if spec is not None:
                spec.loader = Loader(spec.loader, fullname)
                return spec
        return None


sys.meta_path.insert(0, Finder())
