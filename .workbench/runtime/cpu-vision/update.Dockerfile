FROM local-ai/pation-qwen38-cpu-vision:20261013
COPY . /opt/cpu-vision-update
RUN cp /opt/cpu-vision-update/proxy.py /usr/local/lib/python3.12/dist-packages/cpu_vision_proxy.py && python -S /opt/cpu-vision-update/patch-profile.py
