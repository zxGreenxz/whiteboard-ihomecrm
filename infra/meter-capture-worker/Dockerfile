FROM python:3.12.10-slim-bookworm@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db
# Freeze the complete Debian repository snapshot rather than selecting mutable apt versions.
RUN printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20251001T000000Z bookworm main\ndeb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20251001T000000Z bookworm-security main\n' > /etc/apt/sources.list \
    && rm /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install --no-install-recommends -y ffmpeg libglib2.0-0 libgl1 libgomp1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir --only-binary=:all: --require-hashes -r requirements.lock
COPY fetch_models.py ./
RUN python fetch_models.py && useradd --uid 10001 --create-home meter
COPY domain.py recognize.py worker.py ./
ENV PYTHONUNBUFFERED=1 OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 METER_OCR_MODELS=/opt/models HOME=/tmp
USER 10001:10001
CMD ["python", "worker.py"]
