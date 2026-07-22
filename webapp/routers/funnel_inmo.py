"""Router del Funnel Inmo (pipeline 'Nuevo - Inmobiliaria CO').

Endpoints:
  GET /              → página
  GET /filters       → opciones de filtros multi-select
  GET /volumen       → JSON volumen por etapa
  GET /kpis          → fragmento HTML KPIs MTD
  GET /share-cat     → distribución por prioridad de gestión inmo
  GET /conv-time     → CVR por período
  GET /etapas        → lista de etapas
  GET /negocios      → cohorte paginada
  GET /metas/config  → ciclos + metas pre-calculadas
  GET /metas/real    → reales por (etapa, semana, bucket)
  GET /metas/kpi-tendencias → series 8 semanas para sparklines

La fuente es `sellers-main-prod.hubspot.historical` filtrada por
propiedad='dealstage' AND valor IN pipeline stages.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates

from webapp import bq, metas_inmo
from webapp.accounts import BUFFER_EMAILS, sql_not_in

log = logging.getLogger(__name__)
router = APIRouter()
templates = Jinja2Templates(directory=Path(__file__).parent.parent / "templates")

FECHA_INICIO = "2025-10-27"

# ── Pipeline 'Nuevo - Inmobiliaria CO' ───────────────────────────────────────
PIPELINE_STAGES = [
    "1182117549", "1182117546", "1182117545", "1182117550", "1182117547",
    "1182117548", "1182117544", "1182117555", "1182117559", "1182117634",
    "1182117640", "1182117553", "1182117636", "1182117560", "1182117637",
    "1182117638", "1182117554", "1182117558", "1182117561", "1182117635",
    "1182117632", "1182117633", "1182117557", "1182117556", "1182117639",
    "1196757523",
]
PIPELINE_LIST = ", ".join(f'"{s}"' for s in PIPELINE_STAGES)

STAGE_ID_PERFILADO = "1182117546"
STAGE_ID_COMITE    = "1182117547"
STAGE_ID_APROBADO  = "1182117549"
STAGE_ID_OFERTADO  = "1182117550"
STAGE_ID_ACEPTADA  = "1182117553"
STAGE_ID_CAPTADO   = "1182117633"

# Etapas en orden lógico (key, label, color, stage_id|None)
ETAPAS_INMO = [
    {"key": "asignados",        "label": "Asignados",        "color": "#4285F4"},
    {"key": "perfilados",       "label": "Perfilados",       "color": "#FF6D00"},
    {"key": "comite",           "label": "Enviado a comité", "color": "#9C27B0"},
    {"key": "aprobado",         "label": "Aprobado comité",  "color": "#34A853"},
    {"key": "ofertado",         "label": "Ofertado",         "color": "#00BCD4"},
    {"key": "oferta aceptada",  "label": "Oferta aceptada",  "color": "#1565C0"},
    {"key": "captado",          "label": "Captado",          "color": "#00897B"},
]


def _quote_list(items: list[str]) -> str:
    safe = [i.replace("'", "''") for i in items]
    return ", ".join(f"'{s}'" for s in safe)


def _bad_nids_inline() -> str:
    nids = metas_inmo.load_bad_captados_nids()
    return ", ".join(nids) if nids else "0"


def _comerciales_unnest() -> str:
    com = bq.load_comerciales()
    if not com:
        return "SELECT '' AS email, '' AS equipo, '' AS categoria_com WHERE FALSE"
    def esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace("'", "\\'")
    structs = [
        f"STRUCT('{esc(c['email'])}' AS email, '{esc(c['equipo'])}' AS equipo, '{esc(c['categoria'])}' AS categoria_com)"
        for c in com
    ]
    return "SELECT * FROM UNNEST([" + ", ".join(structs) + "])"


def _base_cte(fecha_desde: str, fecha_hasta: str, exclude_incidente: bool) -> str:
    """CTE 'base' con una fila por (nid, fecha, etapa_historica) en el rango.

    Etapas: asignados (primer evento), perfilados, comite, aprobado, ofertado,
    oferta aceptada, captado.

    ⚠️ 'captado' usa la fuente OFICIAL `sellers-main-prod.bi_co.seguimiento_inmobiliaria_col`
    filtrada por `etapa = 'Captaciones'` (no el stage_id de historical). Esta definición
    es la que cuadra con el Looker oficial y, de paso, NO arrastra el incidente 7-abr ni
    los picos de migración de Oct/Nov-2025 que sí inflaban el stage_id en historical.
    El resto de las etapas siguen saliendo de `historical`.

    Si exclude_incidente=True, los nids del incidente 7-abr NO aparecen como captado.
    """
    bad_nids = _bad_nids_inline()
    captado_filter = f" AND nid NOT IN ({bad_nids})" if exclude_incidente else ""
    return f"""
    historical_inmo AS (
      SELECT h.nid, h.fecha, h.valor AS stage_id
      FROM `sellers-main-prod.hubspot.historical` h
      WHERE h.propiedad = 'dealstage'
        AND h.valor IN ({PIPELINE_LIST})
        AND DATE(h.fecha) >= '{fecha_desde}'
        AND DATE(h.fecha) <= '{fecha_hasta}'
    ),
    asignados AS (
      -- Fuente OFICIAL de asignados Inmo: leads_asignados_inmobiliaria_colombia
      -- (1 fila por nid = primera asignación). Reemplaza el "primer evento en historical".
      -- ⚠️ La tabla arranca en 2025-12-01, así que no hay asignados previos a esa fecha.
      SELECT
        a.nid,
        TIMESTAMP(a.fecha_primera_asignacion) AS fecha,
        'asignados' AS etapa
      FROM `sellers-main-prod.data_sellers_bo.leads_asignados_inmobiliaria_colombia` a
      WHERE DATE(a.fecha_primera_asignacion) >= '{fecha_desde}'
        AND DATE(a.fecha_primera_asignacion) <= '{fecha_hasta}'
    ),
    perfilados AS (
      SELECT nid, fecha, 'perfilados' AS etapa
      FROM historical_inmo WHERE stage_id = '{STAGE_ID_PERFILADO}'
    ),
    comite AS (
      SELECT nid, fecha, 'comite' AS etapa
      FROM historical_inmo WHERE stage_id = '{STAGE_ID_COMITE}'
    ),
    aprobado AS (
      SELECT nid, fecha, 'aprobado' AS etapa
      FROM historical_inmo WHERE stage_id = '{STAGE_ID_APROBADO}'
    ),
    ofertado AS (
      SELECT nid, fecha, 'ofertado' AS etapa
      FROM historical_inmo WHERE stage_id = '{STAGE_ID_OFERTADO}'
    ),
    oferta_aceptada AS (
      SELECT nid, fecha, 'oferta aceptada' AS etapa
      FROM historical_inmo WHERE stage_id = '{STAGE_ID_ACEPTADA}'
    ),
    captado AS (
      -- Fuente OFICIAL de captaciones (no historical): cuadra con el Looker y excluye
      -- naturalmente el incidente 7-abr y los picos de migración Oct/Nov-2025.
      SELECT s.nid, TIMESTAMP(s.fecha) AS fecha, 'captado' AS etapa
      FROM `sellers-main-prod.bi_co.seguimiento_inmobiliaria_col` s
      WHERE s.etapa = 'Captaciones'
        AND DATE(s.fecha) >= '{fecha_desde}'
        AND DATE(s.fecha) <= '{fecha_hasta}'{captado_filter}
    ),
    base AS (
      SELECT * FROM asignados UNION ALL
      SELECT * FROM perfilados UNION ALL
      SELECT * FROM comite UNION ALL
      SELECT * FROM aprobado UNION ALL
      SELECT * FROM ofertado UNION ALL
      SELECT * FROM oferta_aceptada UNION ALL
      SELECT * FROM captado
    )
    """


def _build_filter_where(
    equipos: list[str] | None,
    cats_com: list[str] | None,
    prioridades: list[str] | None,
    areas: list[str] | None,
) -> str:
    # Condición base: excluir cuentas buffer (no son comerciales reales). Atribución
    # Inmo = dueño actual del deal (d.hubspot_owner_id).
    conds = [sql_not_in("d.hubspot_owner_id", BUFFER_EMAILS)]
    if equipos:
        conds.append(f"COALESCE(c.equipo, 'Sin equipo') IN ({_quote_list(equipos)})")
    if cats_com:
        conds.append(f"COALESCE(NULLIF(c.categoria_com, ''), 'Sin categoría') IN ({_quote_list(cats_com)})")
    if prioridades:
        conds.append(f"COALESCE(d.prioridad_de_gestion_inmo, '') IN ({_quote_list(prioridades)})")
    if areas:
        conds.append(f"COALESCE(d.area_metropolitana, '') IN ({_quote_list(areas)})")
    return "\n  AND ".join(conds)


def _dia_ciclo_expr(field: str) -> str:
    """Expresión SQL: día dentro del ciclo comercial (1-based, 1–28) para `field`.

    Mapea cada fecha al ciclo que la contiene (calendario en comercial_cycles.json)
    y devuelve DATE_DIFF(fecha, inicio_ciclo)+1. NULL si cae fuera de todo ciclo.
    """
    cycles = bq.load_cycles()
    whens = [
        f"WHEN DATE({field}) BETWEEN '{c['inicio']}' AND '{c['fin']}' "
        f"THEN DATE_DIFF(DATE({field}), DATE('{c['inicio']}'), DAY) + 1"
        for c in cycles
    ]
    return f"CASE {' '.join(whens)} ELSE NULL END"


def _dia_mes_conds(field: str, dia_min: int | None, dia_max: int | None,
                   granularidad: str = "mes") -> list[str]:
    """Condiciones del filtro global "día" (slider que aplica a TODOS los períodos).

    En granularidades calendario (mes/semana/dia) filtra por el día del mes de `field`
    (1–31). En granularidades comerciales (mes_com/sem_com) filtra por el día del ciclo
    (1–28), para comparar ciclos en igualdad de "ciclo-a-la-fecha". Sólo agrega condición
    cuando el rango se estrecha (min>1 o max<tope), para no ensuciar el SQL en su default.
    """
    ciclo = granularidad in ("mes_com", "sem_com")
    expr = _dia_ciclo_expr(field) if ciclo else f"EXTRACT(DAY FROM DATE({field}))"
    tope = 28 if ciclo else 31
    conds: list[str] = []
    if dia_min is not None and int(dia_min) > 1:
        conds.append(f"{expr} >= {int(dia_min)}")
    if dia_max is not None and int(dia_max) < tope:
        conds.append(f"{expr} <= {int(dia_max)}")
    return conds


def _append_dia_mes(where: str, field: str, dia_min: int | None, dia_max: int | None,
                    granularidad: str = "mes") -> str:
    """Agrega las condiciones de día (del mes o del ciclo) a un WHERE ya construido."""
    conds = _dia_mes_conds(field, dia_min, dia_max, granularidad)
    return where + ("\n  AND " + "\n  AND ".join(conds) if conds else "")


def _group_expr(granularidad: str) -> tuple[str, str]:
    if granularidad == "dia":
        g = "FORMAT_DATE('%Y-%m-%d', DATE(b.fecha))"
        return g, g
    if granularidad == "semana":
        g = "FORMAT_DATE('%Y-%m-%d', DATE_TRUNC(DATE(b.fecha), WEEK(MONDAY)))"
        return g, g
    if granularidad == "mes_com":
        cycles = bq.load_cycles()
        whens = []
        for c in cycles:
            mes_short = c["mes"][:3].capitalize()
            label = f"C{c['ciclo']:02d} · {mes_short} {str(c['year'])[2:]}"
            whens.append(f"WHEN DATE(b.fecha) BETWEEN '{c['inicio']}' AND '{c['fin']}' THEN '{label}'")
        g = f"CASE {' '.join(whens)} ELSE NULL END"
        return g, g
    if granularidad == "sem_com":
        cycles = bq.load_cycles()
        whens = []
        for c in cycles:
            for s in c["semanas"]:
                label = f"C{c['ciclo']:02d}-S{s['num']:02d}"
                whens.append(f"WHEN DATE(b.fecha) BETWEEN '{s['inicio']}' AND '{s['fin']}' THEN '{label}'")
        g = f"CASE {' '.join(whens)} ELSE NULL END"
        return g, g
    g = "FORMAT_DATE('%Y-%m', DATE(b.fecha))"
    return g, g


# ── Página principal ─────────────────────────────────────────────────────────
@router.get("", response_class=HTMLResponse)
def page(request: Request):
    today = date.today().isoformat()
    return templates.TemplateResponse("funnel_inmo/page.html", {
        "request": request,
        "etapas": ETAPAS_INMO,
        "fecha_desde": FECHA_INICIO,
        "fecha_hasta": today,
    })


# ── /filters ─────────────────────────────────────────────────────────────────
@router.get("/filters")
def filters_options(
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
):
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    base = _base_cte(fecha_desde, fecha_hasta, exclude_incidente=False)
    sql = f"""
    WITH comerciales AS ({_comerciales_unnest()}),
    {base},
    enriched AS (
      SELECT
        COALESCE(c.equipo, 'Sin equipo')                                AS equipo,
        COALESCE(NULLIF(c.categoria_com, ''), 'Sin categoría')           AS cat_com,
        COALESCE(d.prioridad_de_gestion_inmo, '')                        AS prioridad,
        COALESCE(d.area_metropolitana, '')                               AS area
      FROM base b
      LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = b.nid
      LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
      WHERE {sql_not_in("d.hubspot_owner_id", BUFFER_EMAILS)}
    )
    SELECT
      ARRAY(SELECT DISTINCT equipo     FROM enriched WHERE equipo     != '' ORDER BY equipo)     AS equipos,
      ARRAY(SELECT DISTINCT cat_com    FROM enriched WHERE cat_com    != '' ORDER BY cat_com)    AS cats_com,
      ARRAY(SELECT DISTINCT prioridad  FROM enriched WHERE prioridad  != '' ORDER BY prioridad)  AS prioridades,
      ARRAY(SELECT DISTINCT area       FROM enriched WHERE area       != '' ORDER BY area)       AS areas
    """
    rows = bq.query(sql)
    r = rows[0] if rows else {}
    def clean(arr):
        return sorted([x for x in (arr or []) if x and x not in ("Sin equipo", "Sin categoría")])
    return JSONResponse({
        "equipos":     clean(r.get("equipos")),
        "cats_com":    clean(r.get("cats_com")),
        "prioridades": clean(r.get("prioridades")),
        "areas":       clean(r.get("areas")),
    })


# ── /etapas ──────────────────────────────────────────────────────────────────
@router.get("/etapas")
def etapas():
    return JSONResponse([{"key": e["key"], "label": e["label"]} for e in ETAPAS_INMO])


# ── /volumen ─────────────────────────────────────────────────────────────────
@router.get("/volumen")
def volumen(
    granularidad: Annotated[str, Query()] = "mes",
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    exclude_incidente: Annotated[bool, Query()] = True,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat_com: Annotated[list[str] | None, Query()] = None,
    prioridad: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    dia_min: Annotated[int | None, Query()] = None,
    dia_max: Annotated[int | None, Query()] = None,
):
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    base = _base_cte(fecha_desde, fecha_hasta, exclude_incidente=exclude_incidente)
    where = _build_filter_where(equipo, cat_com, prioridad, area)
    where = _append_dia_mes(where, "b.fecha", dia_min, dia_max, granularidad)
    group_expr, order_expr = _group_expr(granularidad)

    sql = f"""
    WITH comerciales AS ({_comerciales_unnest()}),
    {base}
    SELECT
      {group_expr} AS periodo,
      b.etapa      AS etapa,
      COUNT(DISTINCT b.nid) AS nids
    FROM base b
    LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = b.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
    WHERE {where}
    GROUP BY 1, 2
    ORDER BY {order_expr}
    """
    rows = bq.query(sql)
    rows = [r for r in rows if r["periodo"] is not None]

    periodos = sorted({r["periodo"] for r in rows})
    by_etapa: dict[str, dict[str, int]] = {}
    for r in rows:
        by_etapa.setdefault(r["etapa"], {})[r["periodo"]] = int(r["nids"])

    datasets = []
    for et in ETAPAS_INMO:
        if et["key"] not in by_etapa:
            continue
        datasets.append({
            "label": et["label"],
            "color": et["color"],
            "data": [by_etapa[et["key"]].get(p, 0) for p in periodos],
            "etapa_key": et["key"],
        })
    return JSONResponse({"labels": periodos, "datasets": datasets, "granularidad": granularidad})


# ── /kpis ────────────────────────────────────────────────────────────────────
@router.get("/kpis", response_class=HTMLResponse)
def kpis(
    request: Request,
    exclude_incidente: Annotated[bool, Query()] = True,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat_com: Annotated[list[str] | None, Query()] = None,
    prioridad: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    granularidad: Annotated[str, Query()] = "mes",
):
    w = bq.kpi_windows(granularidad)

    where = _build_filter_where(equipo, cat_com, prioridad, area)
    base_act = _base_cte(w["inicio_actual"], w["fin_actual"], exclude_incidente)
    base_ant = _base_cte(w["inicio_anterior"], w["fin_anterior"], exclude_incidente)

    sql = f"""
    WITH comerciales AS ({_comerciales_unnest()})
    SELECT 'actual' AS periodo, b.etapa, COUNT(DISTINCT b.nid) AS nids FROM (
      WITH {base_act}
      SELECT b.* FROM base b
      LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = b.nid
      LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
      WHERE {where}
    ) b GROUP BY 1, 2
    UNION ALL
    SELECT 'anterior' AS periodo, b.etapa, COUNT(DISTINCT b.nid) AS nids FROM (
      WITH {base_ant}
      SELECT b.* FROM base b
      LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = b.nid
      LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
      WHERE {where}
    ) b GROUP BY 1, 2
    """
    rows = bq.query(sql)
    actual: dict[str, int] = {}
    anterior: dict[str, int] = {}
    for r in rows:
        target = actual if r["periodo"] == "actual" else anterior
        target[r["etapa"]] = int(r["nids"])

    kpis_cfg = [
        {"label": "Asignados",  "keys": ["asignados"]},
        {"label": "Perfilados", "keys": ["perfilados"]},
        {"label": "Aprobados",  "keys": ["aprobado"]},
        {"label": "Ofertados",  "keys": ["ofertado"]},
        {"label": "Aceptadas",  "keys": ["oferta aceptada"]},
        {"label": "Captados",   "keys": ["captado"]},
    ]
    kpi_rows = []
    for k in kpis_cfg:
        act = sum(actual.get(x, 0) for x in k["keys"])
        ant = sum(anterior.get(x, 0) for x in k["keys"])
        delta = ((act - ant) / ant * 100) if ant > 0 else None
        kpi_rows.append({"label": k["label"], "actual": act, "anterior": ant, "delta": delta})

    return templates.TemplateResponse("funnel_mm/partials/kpis.html", {
        "request": request,
        "kpis": kpi_rows,
        "label_actual": w["label_actual"],
        "label_anterior": w["label_anterior"],
        "dia_corte": w["dia_corte"],
        "modo": w["modo"],
    })


# ── /share-cat → prioridad de gestión inmo ───────────────────────────────────
PRIORIDAD_COLORS = {
    "Alta":   "#7c3aed",
    "Media":  "#10b981",
    "Baja":   "#f59e0b",
    "Sin categoría": "#94a3b8",
}


@router.get("/share-cat")
def share_cat(
    granularidad: Annotated[str, Query()] = "mes",
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    exclude_incidente: Annotated[bool, Query()] = True,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat_com: Annotated[list[str] | None, Query()] = None,
    prioridad: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    dia_min: Annotated[int | None, Query()] = None,
    dia_max: Annotated[int | None, Query()] = None,
):
    """Distribución por prioridad inmo en la etapa 'asignados'."""
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    base = _base_cte(fecha_desde, fecha_hasta, exclude_incidente=exclude_incidente)
    where = _build_filter_where(equipo, cat_com, prioridad, area)
    where = _append_dia_mes(where, "b.fecha", dia_min, dia_max, granularidad)
    group_expr, _ = _group_expr(granularidad)

    sql = f"""
    WITH comerciales AS ({_comerciales_unnest()}),
    {base}
    SELECT
      {group_expr} AS periodo,
      COALESCE(NULLIF(d.prioridad_de_gestion_inmo, ''), 'Sin categoría') AS categoria,
      COUNT(DISTINCT b.nid) AS nids
    FROM base b
    LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = b.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
    WHERE {where}
      AND b.etapa = 'asignados'
    GROUP BY 1, 2
    ORDER BY 1, 2
    """
    rows = bq.query(sql)
    rows = [r for r in rows if r["periodo"] is not None]

    donut: dict[str, int] = {}
    by_period: dict[str, dict[str, int]] = {}
    cats_seen: set[str] = set()
    periodos: set[str] = set()
    for r in rows:
        c = r["categoria"] or "Sin categoría"
        cats_seen.add(c)
        periodos.add(r["periodo"])
        donut[c] = donut.get(c, 0) + int(r["nids"])
        by_period.setdefault(r["periodo"], {})[c] = int(r["nids"])

    order = ["Alta", "Media", "Baja"] + sorted(cats_seen - {"Alta","Media","Baja","Sin categoría"}) + ["Sin categoría"]
    cats_ordered = [c for c in order if c in cats_seen]
    periodos_ordered = sorted(periodos)

    donut_values = [donut.get(c, 0) for c in cats_ordered]
    donut_colors = [PRIORIDAD_COLORS.get(c, "#94a3b8") for c in cats_ordered]
    bars_datasets = [{
        "label": c,
        "color": PRIORIDAD_COLORS.get(c, "#94a3b8"),
        "data": [by_period.get(p, {}).get(c, 0) for p in periodos_ordered],
    } for c in cats_ordered]
    return JSONResponse({
        "donut": {
            "labels": cats_ordered,
            "values": donut_values,
            "colors": donut_colors,
            "total": sum(donut_values),
        },
        "bars": {"labels": periodos_ordered, "datasets": bars_datasets},
    })


# ── /conv-time ───────────────────────────────────────────────────────────────
@router.get("/conv-time")
def conv_time(
    granularidad: Annotated[str, Query()] = "mes",
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    exclude_incidente: Annotated[bool, Query()] = True,
    num: Annotated[list[str] | None, Query()] = None,
    den: Annotated[list[str] | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat_com: Annotated[list[str] | None, Query()] = None,
    prioridad: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    dia_min: Annotated[int | None, Query()] = None,
    dia_max: Annotated[int | None, Query()] = None,
):
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    if not num: num = ["captado"]
    if not den: den = ["asignados"]
    base = _base_cte(fecha_desde, fecha_hasta, exclude_incidente=exclude_incidente)
    where = _build_filter_where(equipo, cat_com, prioridad, area)
    where = _append_dia_mes(where, "b.fecha", dia_min, dia_max, granularidad)
    group_expr, _ = _group_expr(granularidad)

    sql = f"""
    WITH comerciales AS ({_comerciales_unnest()}),
    {base}
    SELECT
      {group_expr} AS periodo,
      COUNT(DISTINCT IF(b.etapa IN ({_quote_list(num)}), b.nid, NULL)) AS num,
      COUNT(DISTINCT IF(b.etapa IN ({_quote_list(den)}), b.nid, NULL)) AS den
    FROM base b
    LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = b.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
    WHERE {where}
    GROUP BY 1
    ORDER BY 1
    """
    rows = bq.query(sql)
    rows = [r for r in rows if r["periodo"] is not None]
    labels = [r["periodo"] for r in rows]
    nums   = [int(r["num"]) for r in rows]
    dens   = [int(r["den"]) for r in rows]
    cvrs   = [(n/d*100) if d > 0 else None for n, d in zip(nums, dens)]
    total_n = sum(nums)
    total_d = sum(dens)
    return JSONResponse({
        "labels": labels, "num": nums, "den": dens, "cvr": cvrs,
        "total_num": total_n, "total_den": total_d,
        "total_cvr": (total_n/total_d*100) if total_d > 0 else None,
        "num_etapas": num, "den_etapas": den,
    })


# ── /negocios → cohorte paginada ─────────────────────────────────────────────
TABLE_ETAPAS_FIELDS = [
    ("fecha_asignacion", "F. asignación", "asignados"),
    ("fecha_perfilado",  "F. perfilado",  "perfilados"),
    ("fecha_comite",     "F. comité",     "comite"),
    ("fecha_aprobado",   "F. aprobado",   "aprobado"),
    ("fecha_ofertado",   "F. ofertado",   "ofertado"),
    ("fecha_aceptada",   "F. aceptada",   "oferta aceptada"),
    ("fecha_captado",    "F. captado",    "captado"),
]


@router.get("/negocios")
def negocios(
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    exclude_incidente: Annotated[bool, Query()] = True,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat_com: Annotated[list[str] | None, Query()] = None,
    prioridad: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    etapa: Annotated[str | None, Query()] = None,
    search: Annotated[str | None, Query()] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 50,
):
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    date_field = etapa if etapa in {f for f, _, _ in TABLE_ETAPAS_FIELDS} else "fecha_asignacion"
    base = _base_cte("2020-01-01", date.today().isoformat(), exclude_incidente=exclude_incidente)
    where = _build_filter_where(equipo, cat_com, prioridad, area)

    select_etapas = ",\n      ".join([
        f"MIN(IF(b.etapa = '{key}', CAST(b.fecha AS STRING), NULL)) AS {field}"
        for field, _, key in TABLE_ETAPAS_FIELDS
    ])

    search_clause = ""
    if search:
        safe = search.replace("'", "''")
        search_clause = f"AND CAST(b.nid AS STRING) LIKE '%{safe}%'"

    having = [f"{date_field} IS NOT NULL"]
    if fecha_desde:
        having.append(f"SUBSTR({date_field}, 1, 10) >= '{fecha_desde}'")
    if fecha_hasta:
        having.append(f"SUBSTR({date_field}, 1, 10) <= '{fecha_hasta}'")
    having_sql = " AND ".join(having)

    base_sql = f"""
    WITH comerciales AS ({_comerciales_unnest()}),
    {base},
    cohort AS (
      SELECT
        CAST(b.nid AS STRING) AS nid,
        ANY_VALUE(COALESCE(c.equipo, 'Sin equipo'))                              AS equipo,
        ANY_VALUE(COALESCE(NULLIF(c.categoria_com,''), 'Sin categoría'))          AS categoria_comercial,
        ANY_VALUE(COALESCE(d.prioridad_de_gestion_inmo, ''))                      AS prioridad,
        ANY_VALUE(COALESCE(d.area_metropolitana, ''))                             AS area_metropolitana,
        {select_etapas}
      FROM base b
      LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = b.nid
      LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
      WHERE {where}
        {search_clause}
      GROUP BY 1
      HAVING {having_sql}
    )
    SELECT * FROM cohort
    ORDER BY {date_field} DESC
    LIMIT {page_size}
    OFFSET {(page - 1) * page_size}
    """
    rows = bq.query(base_sql)

    count_sql = f"""
    WITH comerciales AS ({_comerciales_unnest()}),
    {base},
    cohort AS (
      SELECT
        CAST(b.nid AS STRING) AS nid,
        {select_etapas}
      FROM base b
      LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = b.nid
      LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
      WHERE {where}
        {search_clause}
      GROUP BY 1
      HAVING {having_sql}
    )
    SELECT COUNT(*) AS total FROM cohort
    """
    total = int(bq.query(count_sql)[0]["total"])

    for r in rows:
        for f, _, _ in TABLE_ETAPAS_FIELDS:
            v = r.get(f)
            if v:
                r[f] = v[:10]

    return JSONResponse({
        "rows": rows, "total": total, "page": page, "page_size": page_size,
        "etapas": [{"field": f, "label": l} for f, l, _ in TABLE_ETAPAS_FIELDS],
        "date_field": date_field,
    })


# ── Metas ────────────────────────────────────────────────────────────────────
@router.get("/metas/config")
def metas_config():
    cycles = bq.load_cycles()
    comerciales = bq.load_comerciales()
    return JSONResponse({
        "cycles": cycles,
        "etapas": metas_inmo.ETAPAS_ORDER,
        "target_equipos": metas_inmo.TARGET_EQUIPOS,
        "metas": metas_inmo.load_metas(comerciales),
    })


def _bucket_expr_inmo(desglose: str) -> str:
    if desglose == "equipo":
        # Equipo directo del comercial (ya es Inmobiliaria 1/2, Medellín, Cali, Barranquilla)
        return "COALESCE(c.equipo, NULL)"
    if desglose == "categoria":
        return ("CASE COALESCE(NULLIF(d.prioridad_de_gestion_inmo, ''), '') "
                "WHEN 'A' THEN 'A' WHEN 'B' THEN 'B' WHEN 'C' THEN 'C' ELSE NULL END")
    return "'Total'"


@router.get("/metas/real")
def metas_real(
    ciclo: Annotated[int, Query()] = 0,
    desglose: Annotated[str, Query()] = "total",
    exclude_incidente: Annotated[bool, Query()] = True,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat_com: Annotated[list[str] | None, Query()] = None,
    prioridad: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
):
    cycles = bq.load_cycles()
    ciclo_def = next((c for c in cycles if c["ciclo"] == ciclo), None)
    if not ciclo_def:
        return JSONResponse({"weeks": [], "data": {}})

    semanas = ciclo_def["semanas"]
    fecha_desde = semanas[0]["inicio"]
    fecha_hasta = semanas[-1]["fin"]
    base = _base_cte(fecha_desde, fecha_hasta, exclude_incidente=exclude_incidente)
    where = _build_filter_where(equipo, cat_com, prioridad, area)
    week_cases = " ".join([
        f"WHEN DATE(b.fecha) BETWEEN '{s['inicio']}' AND '{s['fin']}' THEN {s['num']}"
        for s in semanas
    ])
    bucket_expr = _bucket_expr_inmo(desglose)

    todas_etapas: list[str] = []
    for et in metas_inmo.ETAPAS_ORDER:
        todas_etapas.extend(metas_inmo.META_ETAPA_TO_BQ[et])

    sql = f"""
    WITH comerciales AS ({_comerciales_unnest()}),
    {base}
    SELECT
      b.etapa AS etapa_bq,
      (CASE {week_cases} ELSE NULL END) AS wk,
      ({bucket_expr}) AS bucket,
      COUNT(*) AS nids
    FROM base b
    LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = b.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
    WHERE {where}
      AND b.etapa IN ({_quote_list(todas_etapas)})
    GROUP BY 1, 2, 3
    """
    rows = bq.query(sql)

    bq_to_etapa: dict[str, str] = {}
    for et, bqs in metas_inmo.META_ETAPA_TO_BQ.items():
        for bq_val in bqs:
            bq_to_etapa[bq_val] = et

    out: dict[str, dict[str, dict[str, int]]] = {}
    for r in rows:
        et = bq_to_etapa.get(r["etapa_bq"])
        wk = r["wk"]
        bucket = r["bucket"]
        if not et or wk is None or bucket is None:
            continue
        out.setdefault(et, {}).setdefault(bucket, {})
        out[et][bucket][str(wk)] = out[et][bucket].get(str(wk), 0) + int(r["nids"])

    return JSONResponse({
        "ciclo": ciclo,
        "weeks": [s["num"] for s in semanas],
        "semanas": semanas,
        "desglose": desglose,
        "data": out,
    })


@router.get("/metas/kpi-tendencias")
def metas_kpi_tendencias(
    ciclo: Annotated[int, Query()] = 0,
    exclude_incidente: Annotated[bool, Query()] = True,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat_com: Annotated[list[str] | None, Query()] = None,
    prioridad: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
):
    cycles = bq.load_cycles()
    ciclo_def = next((c for c in cycles if c["ciclo"] == ciclo), None)
    if not ciclo_def:
        return JSONResponse({"series": {}})

    flat: list[dict] = []
    for c in cycles:
        for s in c["semanas"]:
            flat.append({"ciclo": c["ciclo"], "week": s["num"],
                         "inicio": s["inicio"], "fin": s["fin"]})

    last_in_ciclo = max((i for i, x in enumerate(flat) if x["ciclo"] == ciclo), default=-1)
    if last_in_ciclo < 0:
        return JSONResponse({"series": {}})

    today = date.today().isoformat()
    n_back = 8
    start_idx = max(0, last_in_ciclo - n_back + 1)
    series_flat = flat[start_idx:last_in_ciclo + 1]

    fecha_desde = series_flat[0]["inicio"]
    fecha_hasta = series_flat[-1]["fin"]
    base = _base_cte(fecha_desde, fecha_hasta, exclude_incidente=exclude_incidente)
    where = _build_filter_where(equipo, cat_com, prioridad, area)
    week_cases = " ".join([
        f"WHEN DATE(b.fecha) BETWEEN '{s['inicio']}' AND '{s['fin']}' THEN '{s['ciclo']}-{s['week']}'"
        for s in series_flat
    ])

    todas_etapas: list[str] = []
    for et in metas_inmo.ETAPAS_ORDER:
        todas_etapas.extend(metas_inmo.META_ETAPA_TO_BQ[et])

    sql = f"""
    WITH comerciales AS ({_comerciales_unnest()}),
    {base}
    SELECT
      b.etapa AS etapa_bq,
      (CASE {week_cases} ELSE NULL END) AS wkey,
      COUNT(*) AS nids
    FROM base b
    LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = b.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
    WHERE {where}
      AND b.etapa IN ({_quote_list(todas_etapas)})
    GROUP BY 1, 2
    """
    rows = bq.query(sql)

    bq_to_etapa: dict[str, str] = {}
    for et, bqs in metas_inmo.META_ETAPA_TO_BQ.items():
        for bq_val in bqs:
            bq_to_etapa[bq_val] = et

    real: dict[str, dict[str, int]] = {}
    for r in rows:
        et = bq_to_etapa.get(r["etapa_bq"])
        wk = r["wkey"]
        if not et or not wk:
            continue
        real.setdefault(et, {})
        real[et][wk] = real[et].get(wk, 0) + int(r["nids"])

    metas = metas_inmo.load_metas(bq.load_comerciales())
    series: dict[str, dict] = {}
    for et in metas_inmo.ETAPAS_ORDER:
        labels: list[str] = []
        metas_arr: list[float | None] = []
        reales_arr: list[int | None] = []
        for s in series_flat:
            wkey = f"{s['ciclo']}-{s['week']}"
            labels.append(wkey)
            m = metas.get(et, {}).get("Total", {}).get(wkey)
            metas_arr.append(m)
            futura = s["inicio"] > today
            r = real.get(et, {}).get(wkey)
            reales_arr.append(None if futura else (r or 0))

        meta_ciclo = sum(
            (metas.get(et, {}).get("Total", {}).get(f"{ciclo}-{s['num']}") or 0)
            for s in ciclo_def["semanas"]
        )
        real_ciclo = sum(
            (real.get(et, {}).get(f"{ciclo}-{s['num']}") or 0)
            for s in ciclo_def["semanas"]
            if s["inicio"] <= today
        )
        meta_ciclo_mtd = sum(
            (metas.get(et, {}).get("Total", {}).get(f"{ciclo}-{s['num']}") or 0)
            for s in ciclo_def["semanas"]
            if s["inicio"] <= today
        )
        cumplimiento = (real_ciclo / meta_ciclo_mtd * 100) if meta_ciclo_mtd > 0 else None
        series[et] = {
            "labels": labels, "metas": metas_arr, "reales": reales_arr,
            "meta_ciclo": meta_ciclo, "meta_ciclo_mtd": meta_ciclo_mtd,
            "real_ciclo": real_ciclo, "cumplimiento": cumplimiento,
        }
    return JSONResponse({
        "ciclo": ciclo,
        "ciclo_label": f"Ciclo {ciclo} · {ciclo_def['mes']} {ciclo_def['year']}",
        "series": series,
        "etapas": metas_inmo.ETAPAS_ORDER,
    })
