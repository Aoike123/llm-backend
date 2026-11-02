# Build step for the VBench evaluator: offline deps, pinned source and the entry script.
set -eu
here=/src/.workbench/evaluation/vbench
python3 -m pip install --no-cache-dir --no-index --find-links /src/workspace/data/runtime/vbench/wheels --no-deps --target /opt/vbench-deps -r "$here/requirements.txt"
rm -rf /opt/vbench-source && mkdir -p /opt/vbench-source
tar -C /src/.workbench/vendor/vbench --exclude=.git --exclude=__pycache__ -cf - . | tar -C /opt/vbench-source -xf -
cp "$here/entry.py" /opt/vbench-entry.py
PYTHONPATH=/opt/vbench-deps:/opt/vbench-source:/opt/paiton/venv-site-packages:/opt/paiton/site-packages \
  python3 -c 'import torch,torchvision,vbench; from vbench import subject_consistency,background_consistency,temporal_flickering,motion_smoothness; print("vbench", torch.__version__)'
