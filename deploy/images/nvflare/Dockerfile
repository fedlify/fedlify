# Fedlify NVFLARE base image. Build from the repository root:
#   docker build -f deploy/images/nvflare/Dockerfile -t harbor.fedlify.com/fedlify/nvflare-base:2.6.2 .
# Every study image is built FROM this image (see deploy/k8s/publish-workflow-template.yaml);
# the aggregator, the FLARE API adapter, and hospital clients all run study images.
FROM python:3.10-slim

ARG NVFLARE_VERSION=2.6.2

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    FEDLIFY_CODE_DIR=/opt/fedlify/code \
    FEDLIFY_JOB_DIR=/opt/fedlify/code/job \
    PYTHONPATH=/opt/fedlify/runtime:/opt/fedlify/code

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git tini \
    && rm -rf /var/lib/apt/lists/*

RUN pip install "nvflare==${NVFLARE_VERSION}" numpy pandas scikit-learn

RUN useradd --create-home --uid 10001 fedlify \
    && mkdir -p /opt/fedlify/code /workspace \
    && chown -R fedlify:fedlify /opt/fedlify /workspace

COPY --chown=fedlify:fedlify deploy/images/nvflare/fedlify-start.sh /usr/local/bin/fedlify-start
COPY --chown=fedlify:fedlify deploy/images/nvflare/fedlify_runtime /opt/fedlify/runtime/fedlify_runtime
COPY --chown=fedlify:fedlify services/flare-api-adapter/fedlify_flare_api_adapter.py /opt/fedlify/adapter/fedlify_flare_api_adapter.py
# Publish-time tooling used by the publish workflow (repo checks and the study image Dockerfile).
COPY --chown=fedlify:fedlify deploy/images/study/validate_repo.py /opt/fedlify/runtime/validate_repo.py
COPY --chown=fedlify:fedlify deploy/images/study/Dockerfile /opt/fedlify/runtime/study.Dockerfile
COPY --chown=fedlify:fedlify deploy/k8s/study-aggregator/aggregator.yaml.tmpl /opt/fedlify/runtime/aggregator.yaml.tmpl

USER fedlify
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/fedlify-start"]
