ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY packages /tmp/rocm101/packages
COPY upgrade-sdk.py /tmp/rocm101/upgrade-sdk.py
COPY patch-torch-init.py /tmp/rocm101/patch-torch-init.py
RUN cd /tmp/rocm101/packages && sha256sum -c SHA256SUMS && python /tmp/rocm101/upgrade-sdk.py && python /tmp/rocm101/patch-torch-init.py && rm -rf /tmp/rocm101
LABEL local.ai.rocm.sdk="10.1.0" local.ai.runtime.upgrade="20261011"
ENV ROCM_PATH=/opt/rocm101 HIP_PATH=/opt/rocm101 ROCM_SDK_TARGET_FAMILY=gfx1201
ENV LD_LIBRARY_PATH=/opt/rocm101/lib:/opt/rocm101/lib64 PATH=/opt/rocm101/bin:${PATH}
