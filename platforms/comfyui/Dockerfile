ARG BASE_IMAGE=ghcr.nju.edu.cn/eliovp/paiton-vllm-plugin@sha256:64f6a6154b93f39b34f272fc66110ce17f72cca3ec31284ab57056ca5cdc2677
FROM ${BASE_IMAGE}
COPY platforms/comfyui/requirements.lock.txt /opt/comfy-requirements.lock.txt
RUN python -m pip install --no-cache-dir --no-deps -r /opt/comfy-requirements.lock.txt
RUN python -m pip install --no-cache-dir --no-deps --index-url https://download.pytorch.org/whl/cpu torch==2.10.0+cpu torchvision==0.25.0+cpu torchaudio==2.10.0+cpu
COPY .workbench/vendor/comfyui /opt/comfyui
COPY platforms/comfyui/custom_nodes /opt/comfyui/custom_nodes
WORKDIR /opt/comfyui
ENV PYTHONDONTWRITEBYTECODE=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD python -c "from urllib.request import urlopen; urlopen('http://127.0.0.1:8188/system_stats', timeout=4)"
ENTRYPOINT ["python", "/opt/comfyui/main.py"]
CMD ["--cpu", "--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch", "--user-directory", "/workspace/user", "--input-directory", "/workspace/input", "--output-directory", "/workspace/output", "--temp-directory", "/workspace/temp"]
