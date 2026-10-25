ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY patch-torch-init.py /tmp/patch-torch-init.py
RUN python /tmp/patch-torch-init.py && rm /tmp/patch-torch-init.py
COPY init-sdk.py /tmp/init-sdk.py
RUN python /tmp/init-sdk.py && rm /tmp/init-sdk.py
ENV ROCM_PATH=/opt/rocm101 HIP_PATH=/opt/rocm101 ROCM_SDK_TARGET_FAMILY=gfx1201
ENV LD_LIBRARY_PATH=/opt/rocm101/lib:/opt/rocm101/lib64 PATH=/opt/rocm101/bin:${PATH}
