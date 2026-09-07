FROM python:3.12-slim

WORKDIR /app

COPY app.py ./
COPY server.py ./
COPY reading_digest_service.py ./
COPY reading_reminder_service.py ./

# Web UI
COPY index.html ./
COPY manifest.webmanifest ./
COPY sw.js ./
COPY threads.js ./
COPY assets ./assets
COPY src ./src
COPY thirdparty ./thirdparty

# Sanity check: ensure foliate-js assets were copied into the image
RUN test -f /app/thirdparty/foliate-js/reader.js

RUN pip install --no-cache-dir  googletrans==4.0.2

VOLUME ["/app/data"]

EXPOSE 8000

CMD ["python", "server.py"]
