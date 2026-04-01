FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir paho-mqtt

COPY *.py ./
COPY profiles/ profiles/

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD python -c "print('ok')" || exit 1

ENTRYPOINT ["python", "main.py"]
CMD ["--no-ui", "--debug", "--no-tcp", "--mqtt-host", "emqx", "--mqtt-port", "1883"]
