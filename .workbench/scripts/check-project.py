#!/usr/bin/env python3
"""Run every project-owned test suite without starting inference services."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "platforms/workbench"
PYTHON_SUITES = (
    ("tools", ".workbench/tests"),
    ("comfyui", "platforms/comfyui/tests"),
    ("scheduler", "platforms/scheduler/tests"),
    ("cpu-vision", ".workbench/runtime/cpu-vision"),
)


def run(label, command, cwd=ROOT):
    print(f"\n[{label}]", flush=True)
    try:
        return subprocess.run(command, cwd=cwd).returncode == 0
    except OSError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return False


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=("all", "python", "node"), default="all")
    default_python = ROOT / ".workbench/envs/tools/bin/python"
    parser.add_argument("--python", default=str(default_python) if default_python.is_file() else sys.executable,
                        help="Python with aiohttp installed (defaults to the existing tools environment)")
    args = parser.parse_args(argv)
    results = []
    if args.suite in ("all", "python"):
        for name, directory in PYTHON_SUITES:
            command = [args.python, "-B", "-m", "unittest", "discover", "-s", str(ROOT / directory), "-q"]
            results.append((name, run(name, command)))
    if args.suite in ("all", "node"):
        node = os.environ.get("WORKBENCH_NODE") or shutil.which("node")
        if not node:
            print("ERROR: Node.js >=22.19 required; set WORKBENCH_NODE.", file=sys.stderr)
            results.append(("workbench", False))
        elif not run("node-version", [node, "-e", "const [a,b]=process.versions.node.split('.').map(Number);"
                                             "if(!(a>22||(a===22&&b>=19))){"
                                             "console.error('Node.js >=22.19 required');process.exit(1);}"]):
            results.append(("workbench", False))
        else:
            tests = sorted(str(path.relative_to(APP)) for path in (APP / "tests").glob("*.test.mjs"))
            if not tests:
                print("ERROR: No workbench tests found.", file=sys.stderr)
                results.append(("workbench", False))
            else:
                results.append(("workbench", run("workbench", [node, "--test", *tests], APP)))
            mcp_app = ROOT / "platforms/mcp"
            mcp_tests = sorted(str(path.relative_to(mcp_app)) for path in (mcp_app / "tests").glob("*.test.mjs"))
            results.append(("media-mcp", run("media-mcp", [node, "--test", *mcp_tests], mcp_app) if mcp_tests else False))
    print("\n" + " | ".join(f"{name}: {'PASS' if passed else 'FAIL'}" for name, passed in results), flush=True)
    return 0 if all(passed for _, passed in results) else 1


if __name__ == "__main__":
    sys.exit(main())
