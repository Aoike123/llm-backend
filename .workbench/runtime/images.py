#!/usr/bin/env python3
"""Runtime images, registered like engine packages.

Every `image.json` under engines/ is the recipe of one runtime (the `runtime.id` its engine.json
files declare): a pinned vendor base plus ordered steps. A build runs the steps in a throwaway
container from the base, with the shared ROCm SDK and the repository mounted read-only, then
exports the result as a single-layer image. Nothing is layered on top of a previous build, so
rebuilding never accumulates shadowed files.

Which tag each runtime runs is operator state (workspace/config/runtime-images.json), never git:
`activate` switches it after the GPU checks and keeps the previous tag for rollback; `prune`
deletes every image, SDK version and build leftover nothing references.
"""
import argparse
import datetime
import fnmatch
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE / "rocm101"))
import sdk  # noqa: E402

STATE = ROOT / "workspace/config/runtime-images.json"
BUILD = ROOT / "workspace/data/runtime/build"
REPORTS = ROOT / "workspace/reports/runtime"
STEPS = HERE / "rocm101/steps"
# Environment every ROCm 10.1 runtime image runs with; recipes may add their own.
ROCM_ENV = {"ROCM_PATH": "/opt/rocm101", "HIP_PATH": "/opt/rocm101", "ROCM_SDK_TARGET_FAMILY": "gfx1201",
            "LD_LIBRARY_PATH": "/opt/rocm101/lib:/opt/rocm101/lib64"}


def run(*args, capture=False, **kwargs):
    return subprocess.run(list(map(str, args)), check=True, text=True, capture_output=capture, **kwargs)


def recipes():
    """runtime id -> recipe, from every engines/**/image.json (vendor checkouts excluded)."""
    found = {}
    # Engine runtimes live with their packages; evaluation tools under .workbench/evaluation.
    for file in sorted([*ROOT.glob("engines/**/image.json"), *ROOT.glob(".workbench/evaluation/*/image.json")]):
        if "upstream" in file.relative_to(ROOT).parts:
            continue
        recipe = json.loads(file.read_text())
        for key in ("runtime", "repository", "base", "steps"):
            if key not in recipe:
                raise ValueError(f"{file}: {key} is required")
        if recipe["runtime"] in found:
            raise ValueError(f"{file}: runtime {recipe['runtime']} is already built by {found[recipe['runtime']]['_file']}")
        found[recipe["runtime"]] = {**recipe, "_file": file.relative_to(ROOT)}
    return found


def state():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save(value):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(STATE)


def active(runtime):
    """The image a runtime starts from; refuses to guess when none was activated."""
    image = state().get(runtime, {}).get("image")
    if not image:
        raise RuntimeError(f"运行时 {runtime} 还没有激活镜像：先 ./lab runtime build {runtime}，验收后 ./lab runtime activate {runtime} <tag>")
    return image


def referenced():
    return {tag for row in state().values() for tag in (row.get("image"), row.get("previous")) if tag}


def image_info(tag):
    result = subprocess.run(["docker", "image", "inspect", tag], capture_output=True, text=True)
    return json.loads(result.stdout)[0] if result.returncode == 0 else None


def changes(config, extra, overrides=None):
    """docker import --change lines: the base configuration plus the ROCm and recipe environment."""
    env = dict(item.split("=", 1) for item in config.get("Env") or [])
    path = [part for part in env.get("PATH", "/usr/local/bin:/usr/bin:/bin").split(":") if part != "/opt/rocm101/bin"]
    env.update(ROCM_ENV)
    env["PATH"] = ":".join(["/opt/rocm101/bin", *dict.fromkeys(path)])
    env.update(extra)
    config = {**config, **(overrides or {})}
    rows = [f"ENV {key}={value}" for key, value in env.items()]
    for key, instruction in (("Entrypoint", "ENTRYPOINT"), ("Cmd", "CMD")):
        if config.get(key):
            rows.append(f"{instruction} {json.dumps(config[key])}")
    if config.get("WorkingDir"):
        rows.append(f"WORKDIR {config['WorkingDir']}")
    if config.get("User"):
        rows.append(f"USER {config['User']}")
    rows += [f"EXPOSE {port}" for port in config.get("ExposedPorts") or {}]
    rows += [f"VOLUME {json.dumps([volume])}" for volume in config.get("Volumes") or {}]
    rows += [f"LABEL {json.dumps(key)}={json.dumps(value)}" for key, value in (config.get("Labels") or {}).items()]
    return rows


def script(recipe, context):
    """The shell program that applies the recipe inside the build container."""
    lines = ["set -eu"]
    for index, step in enumerate(recipe["steps"]):
        if "script" in step:
            path = step["script"] if "/" in step["script"] else str((STEPS / step["script"]).relative_to(ROOT))
            runner = "sh" if path.endswith(".sh") else "python3"
            lines.append(f"echo '== {path}'")
            lines.append(f"{runner} /src/{path}")
        elif "copy" in step:
            copy = step["copy"]
            lines.append(f"echo '== copy from {copy['runtime']}'")
            for pattern in copy.get("replace", []):
                lines.append(f"rm -rf {copy['into']}/{pattern}")
            lines.append(f"tar -xf /build/copy-{index}.tar -C {copy['into']}")
        elif "remove" in step:
            lines.append("rm -rf " + " ".join(f"'{path}'" for path in step["remove"]))
        else:
            raise ValueError(f"{recipe['_file']}: unknown step {step}")
    lines.append("rm -rf /tmp/* /root/.cache/pip")
    return "\n".join(lines) + "\n"


def build(runtime):
    recipe = recipes()[runtime]
    root = sdk.path()
    if recipe.get("prepare"):
        run(sys.executable, ROOT / recipe["prepare"])
    if not image_info(recipe["base"]):
        run("docker", "pull", recipe["base"])
    context = BUILD / runtime
    shutil.rmtree(context, ignore_errors=True)
    context.mkdir(parents=True)
    # Files taken from another runtime's active image (e.g. H3 uses the LLM image's torch).
    for index, step in enumerate(recipe["steps"]):
        if "copy" in step:
            copy = step["copy"]
            with (context / f"copy-{index}.tar").open("wb") as out:
                subprocess.run(["docker", "run", "--rm", "--entrypoint", "tar", active(copy["runtime"]),
                                "-C", copy["from"], "-cf", "-", *copy["names"]], stdout=out, check=True)
    tag = recipe["repository"] + ":" + datetime.datetime.now().strftime("%Y%m%d-%H%M")
    name = "image-build-" + runtime
    subprocess.run(["docker", "rm", "-f", name], capture_output=True)
    try:
        run("docker", "run", "--name", name, "--user", "0", "--entrypoint", "sh",
            "-v", f"{ROOT}:/src:ro", *sdk.mount(), "-v", f"{context}:/build:ro",
            recipe["base"], "-c", script(recipe, context))
        config = image_info(recipe["base"])["Config"]
        command = ["docker", "import", *[part for row in changes(config, recipe.get("env", {}), recipe.get("config")) for part in ("--change", row)], "-", tag]
        export = subprocess.Popen(["docker", "export", name], stdout=subprocess.PIPE)
        subprocess.run(command, stdin=export.stdout, check=True, stdout=subprocess.DEVNULL)
        export.stdout.close()
        if export.wait():
            raise RuntimeError("docker export failed")
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        shutil.rmtree(context, ignore_errors=True)
    result = check(tag)
    receipt = {"runtime": runtime, "image": tag, "id": image_info(tag)["Id"], "base": recipe["base"],
               "recipe": str(recipe["_file"]), "steps": recipe["steps"], "sdk": root.name,
               "cpu_check": result, "gpu_qualified": False}
    REPORTS.mkdir(parents=True, exist_ok=True)
    (REPORTS / f"{runtime}-{tag.rsplit(':', 1)[1]}.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
    print(f"已构建 {tag}（{image_info(tag)['Size'] / 2**30:.1f} GiB 压缩）。GPU 验收后执行：./lab runtime activate {runtime} {tag}")
    return tag


def check(tag):
    """CPU-only check: SDK versions, HIP loads from the shared SDK, torch imports."""
    result = run("docker", "run", "--rm", "--entrypoint", "python3", *sdk.mount(),
                 "-v", f"{HERE / 'rocm101/check-runtime.py'}:/tmp/check-runtime.py:ro", tag, "/tmp/check-runtime.py", capture=True)
    return json.loads(result.stdout)


def activate(runtime, tag):
    if runtime not in recipes():
        raise RuntimeError(f"未知运行时：{runtime}")
    if not image_info(tag):
        raise RuntimeError(f"镜像不存在：{tag}")
    value = state()
    current = value.get(runtime, {}).get("image")
    value[runtime] = {"image": tag, **({"previous": current} if current and current != tag else {})}
    save(value)
    print(f"{runtime} → {tag}" + (f"（回滚：./lab runtime activate {runtime} {current}）" if current and current != tag else ""))


def human(size):
    return f"{size / 2**30:.1f} GiB"


def status():
    rows = state()
    for runtime, recipe in recipes().items():
        row = rows.get(runtime, {})
        print(f"[{runtime}] {recipe['_file']}")
        for label in ("image", "previous"):
            tag = row.get(label)
            info = image_info(tag) if tag else None
            print(f"  {label:9} {tag or '—'}" + (f"  {human(info['Size'])} 压缩" if info else ("  （镜像缺失）" if tag else "")))
    print(f"[sdk] 当前 {sdk.path().name}；已安装 {', '.join(sorted(p.name for p in sdk.STORE.iterdir() if p.is_dir() and not p.name.startswith('.')))}")


def prune(apply, keep_bases):
    """Everything not referenced: old tags, vendor bases, legacy images, SDK versions, build leftovers."""
    keep = referenced()
    bases = {recipe["base"] for recipe in recipes().values()}
    repositories = {recipe["repository"] for recipe in recipes().values()}
    images = run("docker", "images", "--format", "{{.Repository}}:{{.Tag}}|{{.ID}}|{{.Repository}}@{{.Digest}}", capture=True).stdout.split()
    remove = []
    for line in images:
        tag, image_id, digest = line.split("|")
        repository = tag.rsplit(":", 1)[0]
        if tag in keep:
            continue
        is_base = digest in bases or any(base.split("@")[0] == repository for base in bases)
        owned = repository in repositories or repository.startswith("local-ai/pation-")
        if (is_base and not keep_bases) or (owned and not is_base):
            remove.append(image_id if tag.endswith(":<none>") else tag)
    versions = [p for p in sdk.STORE.iterdir() if p.is_dir() and p != sdk.path()]
    # Directories of the retired layered build; a running build cleans up its own context.
    leftovers = [p for p in (ROOT / "workspace/data/runtime/rocm101" / name for name in
                 ("build", "finalize", "assembly", "flux-sdpa", "wan-wheels")) if p.exists()]
    for tag in remove:
        print("镜像", tag)
    for path in versions + leftovers:
        print("目录", path.relative_to(ROOT))
    if not apply:
        print("以上为预览；加 --apply 执行，并清理悬空镜像、悬空卷与构建缓存。")
        return
    for tag in remove:
        run("docker", "rmi", tag)
    for path in versions + leftovers:
        subprocess.run(["docker", "run", "--rm", "-v", f"{path.parent}:/x", "ubuntu:24.04", "rm", "-rf", "/x/" + path.name], check=True)
    for command in (["image", "prune", "-f"], ["volume", "prune", "-f"], ["builder", "prune", "-f"]):
        subprocess.run(["docker", *command], capture_output=True)
    print("清理完成。")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="各运行时的配方、当前与上一版镜像、SDK 版本")
    one = sub.add_parser("build", help="从供应商底座按配方构建单层镜像（不激活）")
    one.add_argument("runtime")
    one = sub.add_parser("check", help="对镜像做 CPU 侧检查")
    one.add_argument("tag")
    one = sub.add_parser("activate", help="切换运行时使用的镜像，保留上一版用于回滚")
    one.add_argument("runtime")
    one.add_argument("tag")
    one = sub.add_parser("prune", help="删除未被引用的镜像、SDK 版本与构建残留（默认预览）")
    one.add_argument("--apply", action="store_true")
    one.add_argument("--keep-bases", action="store_true", help="保留供应商底座，便于马上重建")
    sdk_parser = sub.add_parser("sdk", help="宿主机共享 ROCm SDK：install VERSION | verify")
    sdk_parser.add_argument("action", choices=["install", "verify"])
    sdk_parser.add_argument("version", nargs="?")
    args = parser.parse_args()
    if args.command == "status":
        status()
    elif args.command == "build":
        build(args.runtime)
    elif args.command == "check":
        print(json.dumps(check(args.tag), ensure_ascii=False, indent=2))
    elif args.command == "activate":
        activate(args.runtime, args.tag)
    elif args.command == "prune":
        prune(args.apply, args.keep_bases)
    elif args.action == "install":
        sdk.install(args.version or sdk.active_version())
    else:
        sdk.verify()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print("ERROR:", error, file=sys.stderr)
        sys.exit(1)
