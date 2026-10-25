ARG BASE_IMAGE
FROM ${BASE_IMAGE} AS dependencies
ARG DEPS_PATH
COPY wheels /tmp/comfy-wheels
COPY requirements.lock.txt /tmp/comfy-requirements.txt
RUN python3 -m pip install --no-cache-dir --no-index --find-links /tmp/comfy-wheels --no-deps --target ${DEPS_PATH} -r /tmp/comfy-requirements.txt

# Only installed dependencies enter the final image. Deleting wheels in a later
# RUN would leave their original COPY layer in every published runtime image.
FROM ${BASE_IMAGE}
LABEL dev.paiton.distribution="local-assembly-only"
ARG DEPS_PATH
COPY --from=dependencies ${DEPS_PATH}/ ${DEPS_PATH}/
COPY comfyui /opt/comfyui
COPY frontend /opt/comfyui-frontend-source
COPY custom_nodes /opt/comfyui/custom_nodes
