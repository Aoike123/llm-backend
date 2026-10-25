"""Apply serving limits to the generated Docker command without editing vendor code."""
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path


def value_of(argv, flag):
    index = max((i for i, value in enumerate(argv) if value == flag), default=None)
    if index is None or index + 1 >= len(argv):
        raise ValueError(f'Launcher command is missing {flag}')
    return argv[index + 1]


def dedupe(argv, flag):
    """The profile args and the saved policy both carry these flags; keep the last."""
    while argv.count(flag) > 1:
        del argv[argv.index(flag):argv.index(flag) + 2]


def configure(argv, eager=False):
    # `--image` is also consumed by the launcher itself, so the docker argv must
    # carry exactly one pair before the image reference.
    dedupe(argv, '--image')
    if argv[:2] != ['docker', 'run'] or 'serve' not in argv:
        raise ValueError('Unexpected launcher command')
    # The upstream launcher adds the deprecated CUDA alias alongside HIP.
    # Keep the selected ROCm device masks and omit the CUDA variable entirely.
    image = argv.index('serve') - 1
    index = 2
    while index < image:
        if argv[index] in ('-e', '--env') and argv[index + 1].split('=', 1)[0] in ('CUDA_VISIBLE_DEVICES', 'OMP_NUM_THREADS'):
            del argv[index:index + 2]
            image -= 2
        else:
            index += 1
    sequences = int(value_of(argv, '--max-num-seqs'))
    if not 1 <= sequences <= 8:
        raise ValueError('Concurrency must be between 1 and 8')
    context = int(value_of(argv, '--max-model-len'))
    budget = int(value_of(argv, '--kv-cache-memory-bytes'))
    if not 2**30 <= budget <= 32 * 2**30:
        raise ValueError('Configured worker requires a valid official KV budget (1–32 GiB)')
    index = argv.index('--compilation-config') + 1
    compilation = json.loads(argv[index])
    # One target verification round schedules up to draft + 1 tokens per request.
    speculative = json.loads(argv[argv.index('--speculative-config') + 1])
    maximum = sequences * (speculative['num_speculative_tokens'] + 1)
    sizes = [size for size in compilation['cudagraph_capture_sizes'] if size <= maximum]
    compilation['cudagraph_capture_sizes'] = sorted(set([*sizes, maximum]))
    argv[index] = json.dumps(compilation)
    if eager:
        compilation.update(cudagraph_mode='NONE', cudagraph_capture_sizes=[])
        argv[index] = json.dumps(compilation)
        if '--no-enforce-eager' in argv:
            argv.remove('--no-enforce-eager')
        argv.append('--enforce-eager')
        for i, value in enumerate(argv):
            if value.startswith('RADIANCE_GDN_LAZY='):
                argv[i] = 'RADIANCE_GDN_LAZY=0' 
    # Explicitly override image defaults, including converted runtime images.
    # Keep the launcher's explicit Qwen sampling values while declaring their
    # source, rather than implicitly merging the model's generation_config.json.
    if '--generation-config' not in argv:
        argv += ['--generation-config', 'vllm']
    # Keep explicit cache-off commands consistent when configure() is used
    # independently; normal serving enables prefix caching with align mode.
    if '--no-enable-prefix-caching' in argv and '--enable-prefix-caching' not in argv and '--mamba-cache-mode' in argv:
        argv[argv.index('--mamba-cache-mode') + 1] = 'none'
    # Qwen's video warmup shares this process with text serving. Match the
    # reference per-frame pixel budget to avoid oversized video token counts.
    if '--mm-processor-kwargs' in argv:
        i = argv.index('--mm-processor-kwargs') + 1
        processor = json.loads(argv[i])
        processor.setdefault('cap_pixels_per_frame', True)
        argv[i] = json.dumps(processor)
    runtime = Path(__file__).resolve().parents[1] / 'runtime/rocm101'
    site = '/usr/local/lib/python3.12/dist-packages/'
    argv[argv.index('serve') - 1:argv.index('serve') - 1] = [
        # GPU hot-loop CPU ops use one thread; CPU vision has its own budget.
        '-e', 'OMP_NUM_THREADS=1',
        '-e', 'PAITON_HOST_EMBED=1', '-e', 'PAITON_LMHEAD_W8=0', '-e', 'RADIANCE_NVFP4_LMHEAD=bf16',
        '-e', 'WORKBENCH_ROCM_HIP=1', '-e', 'WORKBENCH_CONFIGURATION_VERSION=2', '-e', 'WORKBENCH_KV_PLAN_ID=' + uuid.uuid4().hex,
        '-e', 'WORKBENCH_KV_PLAN_PATH=/cache/workbench-kv-plan.json',
        '-v', str(runtime / 'workbench_runtime.py') + ':' + site + 'workbench_runtime.py:ro',
        '-v', str(runtime / 'zz_workbench_runtime.pth') + ':' + site + 'zz_workbench_runtime.pth:ro']
    return argv


def command(launcher, args):
    args = list(args)

    def last(flag):
        i = max((i for i, value in enumerate(args) if value == flag), default=None)
        return args[i + 1] if i is not None else None

    def keep_last(flag):
        """The controller appends the saved policy after the profile args, so an
        overridden flag can appear twice. Keep the last value and drop the rest."""
        while args.count(flag) > 1:
            i = args.index(flag)
            del args[i:i + 2]

    for flag in ('--context', '--max-num-seqs', '--kv-cache-memory-bytes', '--eager-mode', '--prefix-caching'):
        keep_last(flag)
    eager_index = max((i for i, value in enumerate(args) if value == '--eager-mode'), default=None)
    eager = eager_index is not None and args[eager_index + 1] == 'on'
    if eager_index is not None:
        del args[eager_index:eager_index + 2]
    budget = last('--kv-cache-memory-bytes')
    context = int(last('--context') or 65536)
    # Reuse prefixes at every context, with aligned recurrent state snapshots.
    # This is independent of graph/eager execution; lazy GDN cannot restore prefixes.
    args += ['--mode', 'long-kv4', '--prefix-caching', 'on',
             '--gdn-state', 'eager',
             '--max-num-batched-tokens', '4096' if context <= 65536 else '1024',
             '--long-prefill-threshold', 'off' if context <= 65536 else '512',
             '--kv-cache-memory-bytes', str(budget or (8859648000 if context <= 65536 else 8589934592))]
    result = subprocess.run([sys.executable, str(launcher), '--release', '65k',
                             '--name', 'paiton-qwen38', '--weights', 'w3a4',
                             *args, '--lm-head', 'bf16', '--dry-run'],
                            capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or 'Worker launcher failed')
    if result.stderr:
        print(result.stderr, file=sys.stderr, end='')
    return configure(json.loads(result.stdout), eager)


if __name__ == '__main__':
    argv = command(Path(sys.argv[1]), sys.argv[2:])
    if '--dry-run' in sys.argv[2:]:
        print(json.dumps(argv))
    else:
        os.execvp(argv[0], argv)
