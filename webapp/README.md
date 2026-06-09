# Hub Comercial — webapp (FastAPI + HTMX + Tailwind)

Versión "live data" de los reportes comerciales. Las queries a BigQuery se hacen
en el servidor cuando el usuario cambia un filtro, y la UI se actualiza en
segundos (no minutos como los HTML estáticos).

## Stack

- **Backend**: FastAPI (Python) + google-cloud-bigquery + cachetools (TTL 5 min)
- **Frontend**: Jinja2 templates + Tailwind CSS (CDN) + HTMX 2 + Alpine.js + Chart.js
- **Hosting recomendado**: GCP Cloud Run (pay-per-request)

## Estructura

```
webapp/
├── main.py                     # FastAPI app + rutas raíz
├── bq.py                       # Cliente BQ + caché en memoria
├── routers/
│   └── funnel_mm.py            # Endpoints del Funnel MM
├── templates/
│   ├── base.html               # Layout principal (Tailwind + HTMX + Alpine + Chart.js)
│   ├── index.html              # Hub home
│   └── funnel_mm/
│       ├── page.html           # Página principal MM
│       └── partials/
│           └── kpis.html       # Fragmento KPI cards
├── static/
│   ├── css/app.css             # CSS custom (minimal)
│   └── js/funnel_mm.js         # Alpine state + chart render + filter sync
├── requirements.txt
└── README.md
```

## Correr local

```bash
# 1. Instalar deps (una vez)
python3 -m pip install --user -r webapp/requirements.txt

# 2. Levantar el server con auto-reload
python3 -m uvicorn webapp.main:app --reload --port 8765

# 3. Abrir
open http://127.0.0.1:8765
```

## Autenticación BQ

Usa **Application Default Credentials** (ADC). Si ya corrés `gcloud auth application-default login`
en otros scripts del proyecto, ya está. No necesita service account local.

## Endpoints actuales

### Home
- `GET /` — Hub principal con cards de reportes

### Funnel MM
- `GET /funnel/mm` — Página principal
- `GET /funnel/mm/filters?fecha_desde&fecha_hasta` — JSON con valores disponibles
- `GET /funnel/mm/volumen?granularidad&equipo&...` — JSON con serie por etapa
- `GET /funnel/mm/kpis?equipo&...` — HTML fragment con 6 KPI cards MTD

### Admin
- `GET /health` — Para Cloud Run health check
- `POST /admin/cache/clear` — Vacía el caché de queries

## Cómo funciona la UX "live like Looker"

1. El usuario carga la página → HTMX trigger inicial pide `/funnel/mm/filters` para llenar los multi-selects.
2. Cuando el usuario cambia cualquier filtro:
   - Alpine.js detecta el cambio y dispara `refresh()`.
   - `refresh()` llama `/funnel/mm/volumen` y `/funnel/mm/kpis` con los filtros activos.
   - Chart.js destruye el chart viejo y crea uno nuevo con la data nueva.
   - HTMX swap-ea el fragmento de KPIs.
3. Caché del servidor (5 min, hash del SQL) evita re-pegarle a BQ con queries idénticas → segunda vista es instantánea.

## Deploy a Cloud Run

```bash
# 1. Asegurar que estás logueado en gcloud y en el project correcto
gcloud config set project papyrus-data  # o el project que use Habi para apps

# 2. Crear un Dockerfile sencillo (opcional — Cloud Run puede buildear con buildpacks)
gcloud run deploy hub-comercial \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8000 \
  --memory 512Mi \
  --command "uvicorn" \
  --args "webapp.main:app,--host,0.0.0.0,--port,8000"
```

Costo estimado con tráfico bajo (10-20 usuarios internos): **~$0-5/mes** con free tier.

## Próximos pasos

Lo que viene en Fase 2 (Funnel MM completo):
- [ ] Share categorización (donut + barras por período)
- [ ] Tasa de conversión en el tiempo (multi-select num/den)
- [ ] Cumplimiento de metas (tabla semanal con barras)
- [ ] Deep-dive por semana (vs Meta / vs prev / vs prom 7s)
- [ ] Tabla de negocios paginada
- [ ] Persistencia de filtros via URL params

Fase 3: Funnel Inmo (mismos patrones, adaptados).
Fase 4: Conversión por Seller (tablas + benchmarks).

## Por qué este stack

| Necesidad | Cómo lo resuelve |
|---|---|
| Data live | FastAPI consulta BQ on-demand con caché 5 min |
| UI moderna | Tailwind + componentes consistentes |
| Responsive | Grid de Tailwind + sin frameworks pesados |
| Filtros que recargan data | HTMX para HTML fragments + fetch para JSON (charts) |
| Sin Node.js | Todo lo client-side via CDN |
| Mantenible | Un solo lenguaje (Python) + HTML/CSS estándar |
