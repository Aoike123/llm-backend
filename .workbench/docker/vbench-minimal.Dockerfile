FROM local-ai/pation-minimax-h3-rocm101:20261011 AS dependencies
USER root
COPY wheels /tmp/wheels
COPY requirements.txt /tmp/requirements.txt
RUN python3 -m pip install --no-cache-dir --no-index --find-links=/tmp/wheels --no-deps --target /opt/vbench-deps -r /tmp/requirements.txt

FROM local-ai/pation-minimax-h3-rocm101:20261011
USER root
COPY --from=dependencies /opt/vbench-deps/ /opt/vbench-deps/
COPY source /opt/vbench-source
ENV PYTHONPATH=/opt/vbench-deps:/opt/vbench-source:/opt/paiton/venv-site-packages:/opt/paiton/site-packages VBENCH_CACHE_DIR=/cache TORCH_HOME=/cache/torchhub HF_HOME=/cache/huggingface HSA_ENABLE_SDMA=0
RUN python3 -c 'import torch,torchvision,vbench; from vbench import subject_consistency,background_consistency,temporal_flickering,motion_smoothness; assert torch.version.hip'
COPY vbench-entry.py /opt/vbench-entry.py
WORKDIR /opt/vbench-source
ENTRYPOINT ["python3", "/opt/vbench-entry.py"]
