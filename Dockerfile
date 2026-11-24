FROM python:3.12-slim

# System tools: ffmpeg for audio/video, espeak-ng for the scratch voice, git to fetch cinematic-skill,
# GL/font libraries that skia-python needs on a headless server.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg espeak-ng git ca-certificates curl \
        libgl1 libegl1 libfontconfig1 libfreetype6 fonts-dejavu fonts-liberation fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

# cinematic-skill (pin a commit or tag with --build-arg SKILL_REF=... for reproducible builds)
ARG SKILL_REPO_URL=https://github.com/Moh4696/cinematic-skill.git
ARG SKILL_REF=main
RUN git clone ${SKILL_REPO_URL} /opt/cinematic-skill \
    && cd /opt/cinematic-skill && git checkout ${SKILL_REF} \
    && pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir scipy

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY static ./static

RUN useradd -m -u 1000 studio && mkdir -p /data && chown -R studio /data /opt/cinematic-skill
USER studio

ENV DATA_DIR=/data \
    SKILL_REPO=/opt/cinematic-skill \
    PYTHON_BIN=python3 \
    PYTHONUNBUFFERED=1

EXPOSE 8000
# One worker process (agents run as background threads inside it), many threads for requests.
CMD ["gunicorn", "-w", "1", "--threads", "16", "-t", "0", "-b", "0.0.0.0:8000", "app.main:app"]
