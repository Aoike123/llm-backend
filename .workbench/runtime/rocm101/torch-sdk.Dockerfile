ARG TORCH_IMAGE
ARG BASE_IMAGE
FROM ${TORCH_IMAGE} AS torch-runtime
FROM ${BASE_IMAGE}
RUN python -c "from pathlib import Path; import shutil; root=Path('/opt/paiton/site-packages'); [shutil.rmtree(p) for p in root.glob('torch-*.dist-info')]; shutil.rmtree(root/'torch')"
COPY --from=torch-runtime /usr/local/lib/python3.12/dist-packages/torch /opt/paiton/site-packages/torch
COPY --from=torch-runtime /usr/local/lib/python3.12/dist-packages/torch-2.12.0+rocm10.0.0.dist-info /opt/paiton/site-packages/torch-2.12.0+rocm10.0.0.dist-info
COPY patch-torch-init.py /tmp/patch-torch-init.py
RUN python /tmp/patch-torch-init.py && rm /tmp/patch-torch-init.py
ENV ROCM_PATH=/opt/rocm101 HIP_PATH=/opt/rocm101 ROCM_SDK_TARGET_FAMILY=gfx1201
ENV LD_LIBRARY_PATH=/opt/rocm101/lib:/opt/rocm101/lib64 PATH=/opt/rocm101/bin:${PATH}
