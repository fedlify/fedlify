FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir numpy==2.3.2 scikit-learn==1.7.1
COPY protocol.py prepare_case_study.py evaluate_predictions.py run_case_study.py ./
RUN useradd --create-home --uid 10001 fedlify && mkdir /outputs && chown fedlify:fedlify /outputs
USER fedlify
ENTRYPOINT []
