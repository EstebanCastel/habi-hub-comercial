# AGENTS.md

Guía para Codex cuando trabaja en este repo (`webapp-comercial`).

Este proyecto contiene **solo la webapp** de métricas comerciales de Habi CO. Es una extracción del repo `Comercial`: se dejó fuera todo lo que no necesita la webapp para correr (reportes legacy, generadores de metas por ciclo, presentaciones, análisis ad-hoc, plantillas de docs).

## Contexto de negocio

Habi tiene dos productos:
- **MM (ibuyer / Market Maker):** Habi **compra** la casa directamente.
- **Inmo (inmobiliaria):** Habi **capta** la casa para venderla por cuenta del dueño.

Cada producto tiene su propio pipeline en HubSpot, comerciales, ciclos comerciales y CVR esperado.

## Estructura

```
webapp/
├── main.py              # FastAPI app + router includes
├── bq.py                # Cliente BQ con caché TTL (lee comerciales.csv, comercial_cycles.json)
├── metas_inmo.py        # Modelo de metas Inmo (formula CVR × leads) + CSV incidente 7-abr
├── metas_mm.py          # Parser de metas MM (CSV)
├── accounts.py          # Fuente única de cuentas excluidas (bots/queue + buffers) + helper sql_not_in
├── routers/
│   ├── funnel_mm.py          # Funnel MM: volumen, KPIs, share, CVR, metas, negocios, cosechas
│   ├── funnel_inmo.py        # Funnel Inmo (captado = fuente oficial seguimiento_inmobiliaria_col; toggle incidente 7-abr)
│   ├── funnel_combinado.py   # Funnel Combinado MM + Inmo (CVR asignado → transacción)
│   ├── conversion_seller.py  # CVR por seller × ciclo (MM + Inmo)
│   └── precios_subsidios.py  # Precios + Subsidios MM (experimento co-rangos). Tab del Funnel MM
├── sql/                 # Queries fuente (referencia): asignados_oficial_col.sql, precios_maestro_mm.sql, precios_descuentos_original.sql, subsidios_gasto.sql
├── templates/           # Jinja2 + HTMX + Alpine.js
├── static/js/           # Alpine components + Chart.js renders
└── requirements.txt
```

Archivos de datos en la raíz que la webapp lee en runtime: `comerciales.csv`, `metas_comerciales_co.csv`, `NID's para excluir asignaciones Colombia - nids_MM.csv`, `mm 2030 Sellers interno - ...csv`, `[CO] Corrección Incidente 7 abr Leads Inmo - ...csv`, `reports/comercial_cycles.json`.

Stack: **FastAPI + HTMX + Alpine.js + Tailwind (CDN) + Chart.js**. Sin Node.js.

## Comandos principales

```bash
# Webapp local
python3 -m uvicorn webapp.main:app --reload --host 0.0.0.0 --port 8765

# Tunnel público (URL random *.trycloudflare.com — Mac debe estar prendida)
./cloudflared tunnel --url http://127.0.0.1:8765

# Detener procesos
pkill -f "uvicorn webapp"
pkill cloudflared

# Limpiar caché BQ del webapp (sin reiniciar)
curl -X POST http://127.0.0.1:8765/admin/cache/clear
```

## Arquitectura del webapp

```
Browser
  ↓ HTTP
FastAPI (uvicorn :8765)
  ↓ google-cloud-bigquery client + ADC
BigQuery (papyrus-data + sellers-main-prod)
```

- **Caché:** `cachetools.TTLCache` 500 queries × 5 min (en memoria, por proceso)
- **Auth a BQ:** ADC del usuario (`gcloud auth application-default login`). No service account.
- **Filtros live:** Alpine.js + HTMX. Al cambiar un filtro, se hace `fetch` al endpoint relevante y se re-renderiza el gráfico/tabla.
- **Filtro "Día del mes" (slider dual 1–31):** filtro global en Funnel MM e Inmo (CO y MX) que aplica el mismo rango de días a **todos los meses** del rango (útil para comparar meses en igualdad de MTD). Se traduce a `EXTRACT(DAY FROM DATE(fecha)) BETWEEN dia_min AND dia_max`. Default `[1,31]` = sin filtro (no toca el SQL ni se manda como query param). Aplica a las **series por período**: Volumen, Share (cat/motivo) y CVR en el tiempo. **NO** aplica a KPIs (ya son MTD), Cosechas/Funnel-compare (cohorte) ni Metas (ciclo). Backend: helpers `_dia_mes_conds`/`_append_dia_mes` en cada router (`f.fecha` en MM/MX, `b.fecha` en Inmo CO). Frontend: `diaMin`/`diaMax` + `diaFillStyle()`, se suman a los params sólo cuando estrechan el default. CSS `.rng-dual` en `static/css/app.css`.

### Endpoints principales por router

| Router | Endpoints |
|---|---|
| `/funnel/mm` | `/`, `/filters`, `/volumen`, `/kpis`, `/share-cat`, `/conv-time`, `/cosechas`, `/negocios`, `/etapas`, `/metas/config`, `/metas/real`, `/metas/kpi-tendencias` |
| `/funnel/mm/precios-subsidios` | `/filters`, `/data` — tab "Precios + Subsidios" embebido en Funnel MM |
| `/funnel/inmo` | Iguales que MM pero con `exclude_incidente` toggle |
| `/funnel/combinado` | `/`, `/filters`, `/etapas`, `/conv-time` — vista unificada MM + Inmo |
| `/conversion/seller` | `/`, `/cycles`, `/data` (rows MM/Inmo con `asig_cat`/`num_cat` por categoría de lead) |
| `/admin/cache/clear` | POST — invalida caché BQ |

### Tab Precios + Subsidios (`/funnel/mm/precios-subsidios`)

Análisis del experimento de rangos de precio `co-rangos-20260122` (inicio 26-ene-2026) + subsidios. Embebido como 4° tab del Funnel MM (`?tab=precios`).

- **Fuente:** queries de Juan guardadas en `webapp/sql/` (precios_maestro_mm.sql, subsidios_gasto.sql). Cruzan `im-main-prod.habi_wh_analytics.price_building_co_v2` (armado/experimento) + `papyrus-data.habi_wh.detalle_ofertas_col` (ofertas) + `hubspot.deals`.
- **Filtros:** fecha (toggle aprobación↔cierre = `fecha_aprobado`/`fecha_cierre` de detalle_ofertas_col), granularidad (mes/semana), área, equipo.
- **El tab consulta desde 2025-01-01** (ignora filtro global "Desde") para mostrar historia previa al experimento.
- **4 series de descuento** (vs valor `ask_price_post_remo` y vs cliente `ask_price`): Oferta base (`precio_comite_final_final_final__el_unico____clonada_`), Mín (`precio_minimo_prestamo`), Intermedio (`precio_intermedio`), Máx (`precio_maximo_prestamo`). **Todas HubSpot — NO el armado.**
- **⚠️ UNA FILA POR NEGOCIO = ÚLTIMA APROBACIÓN.** `base_ofertas` deduplica con `QUALIFY ROW_NUMBER() OVER (PARTITION BY nid ORDER BY fecha_aprobado DESC) = 1` — un nid aprobado N veces cuenta 1 (la más reciente), y esa fecha es la fecha del negocio. **Esto fue lo que hizo cuadrar los conteos con el reporte** (479/465/785/873 por mes). El filtro de rango de fechas se aplica al final sobre esa última aprobación.
- **⚠️ METODOLOGÍA DEL DESCUENTO (crítica para que cuadre con el reporte):** `descuento = 1 − (precio / ask)`, contando **sólo ratios `precio/ask` ∈ [0.2, 1.5]**. Ese filtro robusto descarta outliers Y excluye naturalmente los precios de préstamo pre-experimento (ratio <0.2) — por eso las líneas Mín/Inter/Máx arrancan solas en ene-26 **sin necesidad de un flag de experimento explícito**. Mediana sólo si hay ≥5 deals. NO usar `experiment_name` del armado para filtrar (está mal-formado).
- **Query/metodología autoritativa en `webapp/sql/precios_descuentos_original.sql`** — fuente de verdad del mapeo de columnas.
- **KPIs scoped al experimento (2026+)**, aunque los charts muestren historia desde 2025.
- **Subsidio:** identificado por `subsidio_aprobado_lider='Si'`. Monto = `precio_intermedio − precio_minimo_prestamo`. Bolsas: 1ª = min(intermedio, final) − minimo; 2ª = final − intermedio (si positivo).
- **Anotaciones** en charts (chartjs-plugin-annotation, cargado en `base.html`): 26-ene (inicio exp) y 10-mar (subida descuento).

### Tab "Tasa de conversión en el tiempo" (`/funnel/mm/conv-time`)

CVR por período = `suma(num) ÷ suma(den)`, con num/den elegibles entre las etapas (`/etapas`). Construye una CTE `events` unificada `(periodo, etapa, cid)` y cuenta `COUNT(DISTINCT IF(etapa IN num, cid))`.

- **Etapas de funnel** (`funnel_diarios_col`): dateadas por `f.fecha`, `cid = nid`.
- **3 etapas especiales "Lead"** (upstream, desde `tabla_inmuebles_general`, dateadas por `fecha_creacion`, `fuente_id IN (35,20,47,39,3,7)`):
  - `Lead` (nid) → `+ nid IS NOT NULL`, cuenta `DISTINCT nid`.
  - `Lead (filas)` → **sin** `nid IS NOT NULL`; cuenta **FILAS** (`cid = GENERATE_UUID()`). Incluye ~8.8k filas/periodo con **nid nulo** → denominador mayor que `Lead (nid)`.
- **Filtros locales** (sobrescriben los globales sólo en esta card): Fuente, Equipo, Prioridad de gestión (`prioridad_mm`), Área. "Sin prioridad" mapea a `prioridad_gestion_market_maker = ''` (helper `_map_prioridad`). ⚠️ Para las etapas Lead **solo aplican fuente y área**.

### Tab Funnel Combinado (`/funnel/combinado`)

Vista única que cruza el funnel ibuyer (MM) y el pipeline inmobiliario (Inmo) en una sola serie de CVR. Endpoints: `/`, `/filters`, `/etapas`, `/conv-time`.

- **Keys unificadas** que el frontend manda en num/den:
  - `mm:<key>` — etapas MM individuales (`mm:asignacion`, `mm:cierre`, …)
  - `inmo:<key>` — etapas Inmo individuales (`inmo:asignados`, `inmo:captado`, …)
  - `combo:<key>` — presets agregados; el backend los **expande a una lista de keys reales** antes de armar el SQL.
- Reutiliza `PIPELINE_LIST` + `STAGE_ID_*` de `funnel_inmo`, `EXCLUDE_ETAPAS` de `funnel_mm`. Excluye solo **buffers** (`BUFFER_EMAILS`).

## BigQuery — proyectos y datasets

### Proyectos
- **`papyrus-data`** (dataset `habi_wh_bi`) — funnel MM, tabla inmuebles
- **`sellers-main-prod`** (datasets `hubspot`, `bi_co`) — HubSpot deals/historical, vistas BI

**Auth:** ADC del usuario (`gcloud auth application-default login`).

### Tablas críticas

**`papyrus-data.habi_wh_bi.funnel_diarios_col`** — historial de etapas MM
Cada fila = un nid en una etapa en una fecha. Un mismo nid aparece varias veces.
| Columna | Descripción |
|---|---|
| `nid` | ID inmueble |
| `valor` | Etapa (sensible a acentos y typos) |
| `fecha` | Fecha en que el nid entró a la etapa |
| `equipo_sellers` | Equipo comercial |
| `fuente` | WEB, Estudio Inmueble, CRM, lead_forms, Broker, comercial... |
| `flag_recurrecia_gestion` | `Primer gestión` / `Regestión` (typo en BQ: "recurrecia"). Ver sección Recurrencia |
| `categoria_comercial` | A/B/C |
| `area_metropolitana` | Bogotá, Medellín, etc. |
| `hubspot_owner_id` | ⚠️ Email del owner **ACTUAL** del deal (no numérico), NO el del momento del evento |
| `hubspot_owner_id_historico` | Email del owner **al momento del evento/etapa**. Usar este para atribución por evento |

**`sellers-main-prod.hubspot.deals`** — datos del deal (HubSpot) — join por `nid`. Útil: `dealstage`, `ask_price`, `area_metropolitana`, `prioridad_de_gestion_inmo`, `prioridad_gestion_market_maker`.

**`sellers-main-prod.hubspot.historical`** — historial de cambios de propiedades HubSpot. Filtrar `propiedad = 'hubspot_owner_id'` → owner change; `propiedad = 'dealstage'` → cambios de etapa.

**`sellers-main-prod.hubspot.deal_pipelines_stages`** — catálogo de etapas. Join `deals.dealstage = id`.

**`sellers-main-prod.bi_co.tablero_asignacion_inmo_col`** — fuente oficial Inmo (1 fila/nid). Campos: `nid`, `fecha_primera_asignacion`, `comercial_asignado`, `equipo`, `categoria`, `prioridad_de_gestion_inmo`, `propietario_actual`, `estado`, `etapa_negocio`.

**`sellers-main-prod.bi_co.seguimiento_inmobiliaria_col`** — seguimiento oficial Inmo por etapa (≈1 fila por nid×etapa). Campos: `nid`, `fecha` (DATETIME), `etapa`, `valor`, `comercial`, `equipo`, `area_metropolitana`, `fuente`. **Fuente de la captación oficial del Funnel Inmo** (`etapa = 'Captaciones'`). Cuadra con el Looker oficial.

**`sellers-main-prod.bi_co.metas_comerciales_co`** ⚠️ **Enlazada a Google Sheets — Drive scope bloqueado por Workspace.** Define qué comerciales tienen meta activa por mes. **Workaround:** export CSV → `metas_comerciales_co.csv` en la raíz, cargado vía `UNNEST([...])`.

**`sellers-main-prod.bi_co.input_exclusion_nids_asignacion_mm_col`** ⚠️ **También Drive-linked, bloqueada.** Exportada a `NID's para excluir asignaciones Colombia - nids_MM.csv`.

**`sellers-main-prod.bi_co.seguimiento_asignacion_ibuyer_co`** — fuente oficial de Asignados MM (ver Conversión por Seller).

**`papyrus-data.habi_wh_bi.tabla_inmuebles_general`** — 1 fila por nid, atributos + fechas del journey upstream. Define **Lead** y **Calificado**.
| Columna | Descripción |
|---|---|
| `nid` | ID inmueble |
| `fecha_creacion` | Fecha en que el lead entró al sistema (= **Lead**) |
| `fecha_a_pricing` | Fecha en que pasó a pricing (= **Calificado**) |
| `fuente_id` | 6 fuentes válidas: `35, 20, 47, 39, 3, 7` |
| `check_a_pricing` | 1 si pasó el chequeo automático de pricing |
| `calificacion_del_lead_v2` | `n` / `nh` / otros |
| `equipo_sellers`, `area_metropolitana` | Atribución comercial y geográfica |

### Definiciones de Lead / Calificado / Asignados (filtros distintos)

Todas cuentan `COUNT(DISTINCT nid)` por mes.

| Etapa | Tabla / fecha | Filtros |
|---|---|---|
| **Lead** | `tabla_inmuebles_general.fecha_creacion` | `nid IS NOT NULL`, `fuente_id IN (35,20,47,39,3,7)` |
| **Calificado** | `tabla_inmuebles_general.fecha_a_pricing` | + `check_a_pricing = 1` |
| **Asignados** | `historical.hubspot_owner_id` change (primera asignación) | + `check_a_pricing=1`, `calificacion_del_lead_v2 NOT IN ('n','nh')`, estado gestionable. Ver `webapp/sql/asignados_oficial_col.sql` |

Lead/Calificado están en `webapp/routers/funnel_combinado.py` (`_upstream_cte`). **No mezclar los filtros entre definiciones.**

## Etapas y mapeos

### MM (`funnel_diarios_col.valor`)
| Valor en BQ | Qué significa |
|---|---|
| `Primer_asigancion` | Lead asignado (typo en BQ: "asigancion") |
| `Cita agendada` | Cita pactada con dueño |
| `Visita efectuada` | Visita realizada |
| `pre-comité validado` | Documentos completos |
| `Descartado por comité` | No aprobado |
| `Aprobado` / `inmueble aprobado` | Aprobado por comité (para metas solo usar `Aprobado`) |
| `Rechazó Oferta` | Cliente no aceptó |
| `Aceptó Oferta - Pendiente firma` | Aceptó |
| `Cierre - Comprado` | Negocio cerrado |

**Etapas excluidas:** `llamadas_comercial`, `Referido para inmobiliaria`, `No gestionado`, `Captado para inmobiliaria`.

### Recurrencia — `flag_recurrecia_gestion`

Dos valores: `Primer gestión` (**PG**, lead nuevo) y `Regestión` (**RG**, lead reciclado/re-asignado). El flag se aplica a nivel de **evento (fila), no de nid**.

#### ⚠️ Encoding NFC vs NFD (gotcha crítico)
El valor `Regestión` en BQ está en **NFD** (`o` + combining acute). Un literal normal usa NFC:
```sql
WHERE flag_recurrecia_gestion = 'Regestión'              -- ❌ 0 filas
WHERE NORMALIZE(flag_recurrecia_gestion, NFC) = 'Regestión'  -- ✅
WHERE STARTS_WITH(flag_recurrecia_gestion, 'Regest')         -- ✅
```

#### ⚠️ La definición del flag cambió a mid-2025
- 2024–mediados 2025: una `Regestión` era un re-ciclo literal (mediana ~150d desde primera asignación).
- Mid-2025 → hoy: marca reasignaciones operativas mucho más cercanas (mediana ~25–50d).
Cualquier serie histórica PG vs RG a través de mid-2025 compara definiciones distintas.

### Inmo — pipeline `'Nuevo - Inmobiliaria CO'` en `historical.dealstage`
Etapas clave: `1182117546` Perfilado · `1182117547` Enviado a comité · `1182117549` Aprobado comité · `1182117550` Ofertado · `1182117553` Oferta aceptada · `1182117633` Captado (firmado).

**⚠️ Captado en el Funnel Inmo NO usa este stage_id.** El CTE `captado` de `_base_cte()` (en `funnel_inmo.py`) sale de la fuente **oficial** `seguimiento_inmobiliaria_col` filtrada por `etapa = 'Captaciones'`. Las demás etapas Inmo sí salen de `historical`. La fuente oficial cuadra con el Looker y **excluye sola** el incidente 7-abr y los picos de migración Oct/Nov-2025. Como `seguimiento_inmobiliaria_col.fecha` es DATETIME y `historical.fecha` es TIMESTAMP, el CTE castea con `TIMESTAMP(s.fecha)`.

**⚠️ El stage_id `1182117633` SÍ se usa** en `funnel_combinado.py` (`inmo:captado`) y en `conversion_seller.py` (`STAGE_ID_CAPTADO_INMO`) — arman su CTE desde eventos `historical` y NO se cambiaron.

## Cuentas excluidas (bots/queue + buffers)

**Fuente única de verdad: `webapp/accounts.py`** (importar, no duplicar listas). Helper `sql_not_in(field, emails)`.

- **Bots/queue MM:** `juanquinones@habi.co`, `iagabi@habi.co` (`MM_BOT_EMAILS`)
- **Bots/queue Inmo:** `cristianmartin@habi.co`, `jhoanbenavides@habi.co` (`INMO_BOT_EMAILS`)
- **Buffers:** `susanaescobar@habi.co`, `danieljaramillo@habi.co`, `juancampos@habi.co` (`BUFFER_EMAILS`)

**Dónde se excluye qué:**
- **Conversión Seller** (MM + Inmo): bots **+** buffers (`MM_EXCLUIR_EMAILS` / `INMO_EXCLUIR_EMAILS`).
- **Funnel MM, Inmo, Combinado:** solo **buffers** (`BUFFER_EMAILS`). Los bots NO se excluyen aquí. Filtro por **owner actual**.

## Métricas — diferencia importante

**Funnel MM y Funnel Inmo tabs:** cuentan **EVENTOS** (filas) — `COUNT(*)`, no `COUNT(DISTINCT nid)`.

**Conversión por Seller tab:** cuenta **primera asignación por (nid, comercial)** en período.
- Inmo: lógica del Looker oficial (`metas_comerciales_co` + `prioridad_de_gestion_inmo IS NOT NULL`).
- MM (denominador = Asignados): **fuente oficial `seguimiento_asignacion_ibuyer_co`** con `tipo_asignacion_comercial = 'Primer Asignación comercial'` (captura primera asignación al comercial REAL saltando el bot). **NO usar** `funnel_diarios_col.valor='Primer_asigancion'` con `hubspot_owner_id`. Filtros: `fuente NOT IN (Broker, comercial, Ventana)`, `prioridad_gestion_market_maker IS NOT NULL`, excluye referidos, blacklist de `lote_id`/`zona_mediana_id`.
- MM (numerador = Cierres): `funnel_diarios_col.valor='Cierre - Comprado'` atribuido a **`hubspot_owner_id_historico`**.

### UI del tab Conversión por Seller (`conversion_seller.js` + `page.html`)

Cada fila de `/data` trae breakdown por **categoría del lead**: `asig_cat`/`num_cat` = `{A,B,C,SC}`.
- **Share por categoría** (2 barras 100%: Asignados / Cierres) con toggle **"Categoría del lead" ↔ "Categoría del seller"** (`shareCatMode`).
- **CVR por mes comercial y categoría** (líneas). Respeta el toggle y filtros; **ignora el filtro de ciclo**.
- **Filtro "Comercial"** (multi-select): comerciales con asignados>0 del ciclo. Convive con "Buscar seller".
- **"Sin equipo":** los `@habi.co` sin equipo en `comerciales.csv` = ex-empleados CO → se muestran como "Sin equipo". México (`@tuhabi.mx`) y buffers se excluyen en el query.

## Ciclos comerciales

Definidos en `reports/comercial_cycles.json`. Para conversion seller (`CYCLE_PERIODS` en `conversion_seller.py`): cada ciclo tiene período de asignación (~1 mes) y de cierre (~1 mes, con offset).

## Deploy / hosting

**Status actual:** Cloudflare Quick Tunnel apuntando a la Mac local (URL random `*.trycloudflare.com`, sin auth, Mac prendida con uvicorn + cloudflared).

**Dockerfile** incluido para Cloud Run (usa `$PORT`, default 8080). Para "producción" falta service account JSON de IT (`roles/bigquery.jobUser` + `roles/bigquery.dataViewer` en `papyrus-data` y `sellers-main-prod`).

## Quirks / gotchas conocidos

1. **Alpine.js v3 auto-llama `init()` si está definido.** NO poner `x-init="init()"` en componentes con método `init` → doble init → Chart.js crashea con `null.save`.
2. **CASE WHEN SQL:** los `WHEN ... THEN ...` se separan con **espacios**, no comas. `", ".join(...)` rompe el query.
3. **htmx 2 cambió `hx-vals` con `js:`** — requiere expresión de objeto: `js:{...funcName()}`.
4. **`__x.$data` de Alpine v2 ya no existe en v3.** Usar `_x_dataStack[0]`.
5. **Workspace Habi bloquea el scope Drive de gcloud.** Tablas BQ enlazadas a Sheets (`metas_comerciales_co`, `input_exclusion_nids_asignacion_mm_col`) no se consultan con ADC → workaround CSV.
6. **Tabla MM tiene typos:** `flag_recurrecia_gestion` (no `recurrencia`), `Primer_asigancion` (no `asignacion`). Respetarlos. El valor `Regestión` está en NFD (ver Recurrencia).
7. **`tablero_asignacion_inmo_col` se refresca cada hora** — ventana de refresh puede diferir del Looker, no es bug.
8. **`Aprobado` vs `inmueble aprobado` en MM:** existen ambas; para conteos de metas solo usar `Aprobado`.

## Para hacer cambios en el webapp

1. `uvicorn ... --reload` ya corriendo → al guardar un `.py`, recarga automáticamente.
2. Cambios en `templates/*.html` o `static/*.js` → solo refresh del navegador.
3. Si cambias el schema de un response JSON, actualiza el JS del frontend.
4. Si agregas un endpoint nuevo, expónlo en el router correspondiente.
