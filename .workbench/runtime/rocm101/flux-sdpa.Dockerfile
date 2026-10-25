ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY patch-flux-sdpa.py /tmp/patch-flux-sdpa.py
RUN python3 /tmp/patch-flux-sdpa.py && rm /tmp/patch-flux-sdpa.py
