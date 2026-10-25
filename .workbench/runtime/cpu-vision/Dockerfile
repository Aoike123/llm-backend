FROM local-ai/pation-qwen38-rocm101:20261011
COPY proxy.py /usr/local/lib/python3.12/dist-packages/cpu_vision_proxy.py
COPY server.py /opt/cpu-vision/server.py
COPY patch.py /tmp/patch-cpu-vision.py
RUN python -S /tmp/patch-cpu-vision.py
COPY patch-profile.py /tmp/patch-cpu-profile.py
RUN python -S /tmp/patch-cpu-profile.py
