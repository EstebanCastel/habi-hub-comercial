# webapp-comercial

Hub interactivo de métricas comerciales de Habi CO (Funnel MM, Funnel Inmo, Funnel Combinado, Conversión por Seller, Precios + Subsidios). Queries live a BigQuery con caché de 5 min.

Stack: **FastAPI + HTMX + Alpine.js + Tailwind (CDN) + Chart.js**. Sin Node.js.

Este proyecto es una extracción del repo `Comercial`, conteniendo **solo** lo que la webapp necesita para correr (código + archivos de datos que lee en runtime + infra de deploy). Los reportes legacy, presentaciones, análisis ad-hoc y docs quedaron fuera.

## Requisitos

1. **Python 3.12+** y las deps de `webapp/requirements.txt`:
   ```bash
   pip install -r webapp/requirements.txt
   ```
2. **Auth a BigQuery (ADC del usuario):**
   ```bash
   gcloud auth application-default login
   ```
   Necesita lectura sobre `papyrus-data` y `sellers-main-prod`.

## Correr local

```bash
python3 -m uvicorn webapp.main:app --reload --host 0.0.0.0 --port 8765
```

## Tunnel público (opcional)

```bash
./cloudflared tunnel --url http://127.0.0.1:8765
```
URL pública random `*.trycloudflare.com` — la Mac debe quedar prendida con uvicorn + cloudflared corriendo.

## Limpiar caché BQ sin reiniciar

```bash
curl -X POST http://127.0.0.1:8765/admin/cache/clear
```

## Deploy (Docker / Cloud Run)

El `Dockerfile` empaqueta `webapp/` + los CSVs/JSON de datos. Cloud Run usa `$PORT` (default 8080).

```bash
docker build -t webapp-comercial .
docker run -p 8080:8080 webapp-comercial
```

## Archivos de datos (leídos en runtime)

La webapp lee estos archivos desde la raíz del proyecto (no los borres):

| Archivo | Usado por |
|---|---|
| `comerciales.csv` | catálogo de comerciales (`bq.py`) |
| `metas_comerciales_co.csv` | metas activas por mes (`conversion_seller.py`) |
| `NID's para excluir asignaciones Colombia - nids_MM.csv` | nids a excluir (`conversion_seller.py`) |
| `mm 2030 Sellers interno - ...csv` | metas semanales MM (`metas_mm.py`) |
| `[CO] Corrección Incidente 7 abr Leads Inmo - ...csv` | toggle incidente 7-abr (`metas_inmo.py`) |
| `reports/comercial_cycles.json` | definición de ciclos comerciales (`bq.py`) |

Para detalle de arquitectura, BigQuery, etapas y gotchas, ver `CLAUDE.md`.
