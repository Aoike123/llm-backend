#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
kind="${1:?Usage: evaluate-media.sh geneval|vbench INPUT_DIRECTORY}"
input="$(realpath "${2:?Provide generated image/video directory}")"
stamp="$(date -u +%Y%m%dT%H%M%S)-$$"
output="$root/workspace/reports/$kind-$stamp"
mkdir -p "$output"
case "$kind" in
  geneval)
    : "${GENEVAL_PYTHON:?Set GENEVAL_PYTHON to a separately configured GenEval Python interpreter; see docs/EVALUATION.md}"
    : "${GENEVAL_MODEL_DIR:?Set GENEVAL_MODEL_DIR to the downloaded detector directory}"
    "$GENEVAL_PYTHON" "$root/.workbench/vendor/geneval/evaluation/evaluate_images.py" "$input" \
      --model-path "$GENEVAL_MODEL_DIR" --outfile "$output/results.jsonl"
    "$GENEVAL_PYTHON" "$root/.workbench/vendor/geneval/evaluation/summary_scores.py" "$output/results.jsonl" | tee "$output/summary.txt"
    ;;
  vbench)
    if [[ -n "${VBENCH_PYTHON:-}" ]]; then
      "$VBENCH_PYTHON" "$root/.workbench/vendor/vbench/evaluate.py" --videos_path "$input" \
        --output_path "$output" --mode custom_input \
        --dimension subject_consistency background_consistency temporal_flickering motion_smoothness
    else
      python3 "$root/.workbench/scripts/run-vbench.py" "$input" "$output"
    fi
    ;;
  *) echo 'Choose geneval or vbench' >&2; exit 2 ;;
esac
