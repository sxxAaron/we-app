FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOST=0.0.0.0 PORT=8080 DB_PATH=/data/journal.db
WORKDIR /app
RUN groupadd --gid 10001 journal && useradd --uid 10001 --gid journal --no-create-home journal && mkdir /data && chown journal:journal /data
COPY --chown=journal:journal server.py manage.py ./
COPY --chown=journal:journal static ./static
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=3)"
CMD ["python", "server.py"]
