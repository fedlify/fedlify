FROM python:3.13-slim

WORKDIR /worker
ENV PYTHONUNBUFFERED=1

COPY services/agent-worker/pyproject.toml ./pyproject.toml
COPY services/agent-worker/fedlify_agent_worker ./fedlify_agent_worker
RUN pip install --no-cache-dir .

ENTRYPOINT ["fedlify-agent-worker"]
