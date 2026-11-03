# Study image built by the publish workflow: Fedlify NVFLARE base + the study repo at /opt/fedlify/code.
# The aggregator, the FLARE API adapter, and every hospital client run this exact image (pinned by digest).
# Build context is the study repository checkout; this Dockerfile is supplied by Fedlify, not the repo.
ARG BASE_IMAGE=harbor.fedlify.com/fedlify/nvflare-base:branch-main
FROM ${BASE_IMAGE}

ARG GIT_COMMIT=unknown
ARG STUDY_SLUG=unknown
ARG PIPELINE_VERSION=unknown

USER root
COPY requirements.txt /tmp/study-requirements.txt
RUN if grep -qvE '^[[:space:]]*(#|$)' /tmp/study-requirements.txt; then pip install -r /tmp/study-requirements.txt; fi \
    && rm -f /tmp/study-requirements.txt

COPY --chown=fedlify:fedlify . /opt/fedlify/code
RUN rm -rf /opt/fedlify/code/.git

LABEL org.opencontainers.image.revision="${GIT_COMMIT}" \
      com.fedlify.study="${STUDY_SLUG}" \
      com.fedlify.pipeline-version="${PIPELINE_VERSION}"

USER fedlify
