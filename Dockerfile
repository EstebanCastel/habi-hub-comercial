FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependencias del sistema (mínimas)
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Python deps
COPY webapp/requirements.txt /app/webapp/requirements.txt
RUN pip install --upgrade pip && pip install -r /app/webapp/requirements.txt

# Código y data estática (CSVs / JSON / metas)
COPY webapp/ /app/webapp/
COPY comerciales.csv /app/
COPY metas_comerciales_co.csv /app/
COPY "NID's para excluir asignaciones Colombia - nids_MM.csv" /app/
COPY "mm 2030 Sellers interno - MM Col Ciclos Todo el Funnel (Ciudades y equipos).csv" /app/
COPY reports/comercial_cycles.json /app/reports/comercial_cycles.json
# El CSV del incidente Inmo (8.290 nids)
COPY "[CO] Corrección Incidente 7 abr Leads Inmo - bquxjob_41c0d194_19d68c1efbf.csv" /app/

# Cloud Run usa $PORT (default 8080). Uvicorn lo lee de env.
ENV PORT=8080
EXPOSE 8080

# Run app — gunicorn no aporta mucho aquí, uvicorn es suficiente
CMD ["sh", "-c", "uvicorn webapp.main:app --host 0.0.0.0 --port ${PORT}"]
