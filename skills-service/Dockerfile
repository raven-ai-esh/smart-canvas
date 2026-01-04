FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY skills-service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY skills-service/app.py ./app.py
COPY skills-service/scripts ./scripts

EXPOSE 8002

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8002"]
