"""Funnel Inmo México — modelado sobre funnel_mm_mx (single table, etapas en `valor`).

A diferencia del Inmo CO (que arma de `historical` por stage_id + `seguimiento_col`),
el Inmo MX vive en UNA sola tabla con todas las etapas en `valor`.

Fuente: `sellers-main-prod.bi_mx.seguimiento_inmobiliaria_mex_copia`.

⚠️ FAN-OUT: la tabla duplica filas masivamente (cada nid×etapa repetido miles de
veces en una misma fecha). `COUNT(*)` es BASURA → siempre `COUNT(DISTINCT nid)`.
Cada nid×etapa tiene su fecha en un solo día, así que el conteo por período colapsa
bien bajo DISTINCT.

Inmo MX NO tiene columnas de categoría/prioridad ni razón de venta → no hay
share-cat ni filtro de motivo (a diferencia del MM MX). Filtros: equipo, área, fuente.

Etapas (mapeo al funnel Inmo CO):
  Asignados → Contactado(`contactado`) → Enviado a comité → Aprobado comité →
  Ofertado → Oferta aceptada(`oferta_aceptada_gabi`) → Captación(`captaciones_3_checks`).
Se excluyen del funnel En legal/Publicaciones/Firma (post-captación).
"""
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates

from webapp import bq

router = APIRouter()
templates = Jinja2Templates(directory=Path(__file__).parent.parent / "templates")

TABLE = "sellers-main-prod.bi_mx.seguimiento_inmobiliaria_mex_copia"
FECHA_INICIO = "2026-01-01"

# Etapas del funnel Inmo MX — según el dashboard oficial "Seguimiento Inmobiliaria"
# (Seguimiento_MEX.pdf). ⚠️ Los nombres de display NO coinciden con los `valor` de la
# tabla; el mapeo se verificó por conteos mensuales contra el reporte oficial:
#   Documentos solicitados = `En legal`, Contrato en elaboración = `Firma`,
#   Firmas/Captaciones = `captaciones_3_checks`.
# NO son del funnel: ofertado, Enviado a comité, Aprobado comité, Publicaciones.
ETAPAS_INMO = [
    {"key": "Asignados",            "label": "Asignados",               "color": "#4285F4"},
    {"key": "contactado",           "label": "Contactados",             "color": "#FF6D00"},
    {"key": "oferta_aceptada_gabi", "label": "Oferta aceptada",         "color": "#9C27B0"},
    {"key": "En legal",             "label": "Contrato en elaboración", "color": "#34A853"},
    {"key": "Firma",                "label": "Firmas",                  "color": "#00BCD4"},
    {"key": "captaciones_3_checks", "label": "Captaciones 3 checks",    "color": "#00897B"},
]

ETAPA_ASIGNACION = "Asignados"

# Comparación de funnels (key BQ, label, es_exclusion) — sin etapas de exclusión.
FUNNEL_COMPARE_STAGES = [(e["key"], e["label"], False) for e in ETAPAS_INMO]


def _quote_list(items: list[str]) -> str:
    safe = [i.replace("'", "''") for i in items]
    return ", ".join(f"'{s}'" for s in safe)


def _build_where(
    fecha_desde: str,
    fecha_hasta: str,
    equipos: list[str] | None = None,
    fuentes: list[str] | None = None,
    areas: list[str] | None = None,
) -> str:
    """WHERE con los filtros activos. Alias de la tabla = `f`."""
    conds = [
        f"DATE(f.fecha) >= '{fecha_desde}'",
        f"DATE(f.fecha) <= '{fecha_hasta}'",
    ]
    if equipos:
        conds.append(f"COALESCE(NULLIF(f.equipo_sellers, ''), 'Sin equipo') IN ({_quote_list(equipos)})")
    if fuentes:
        conds.append(f"COALESCE(f.fuente, '') IN ({_quote_list(fuentes)})")
    if areas:
        conds.append(f"COALESCE(f.area_metropolitana, '') IN ({_quote_list(areas)})")
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

    En granularidades calendario (mes/semana/dia) filtra por el día del mes (1–31).
    En granularidades comerciales (mes_com/sem_com) filtra por el día del ciclo (1–28),
    para comparar ciclos en igualdad de "ciclo-a-la-fecha". Sólo agrega condición cuando
    el rango se estrecha (min>1 o max<tope), para no ensuciar el SQL en su default.
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


def _group_expr(granularidad: str, field: str = "f.fecha") -> tuple[str, str]:
    """SQL para agrupar por granularidad (CO y MX comparten ciclos comerciales)."""
    if granularidad == "dia":
        g = f"FORMAT_DATE('%Y-%m-%d', DATE({field}))"
        return g, g
    if granularidad == "semana":
        g = f"FORMAT_DATE('%Y-%m-%d', DATE_TRUNC(DATE({field}), WEEK(MONDAY)))"
        return g, g
    if granularidad == "mes_com":
        cycles = bq.load_cycles()
        whens = []
        for c in cycles:
            mes_short = c["mes"][:3].capitalize()
            label = f"C{c['ciclo']:02d} · {mes_short} {str(c['year'])[2:]}"
            whens.append(f"WHEN DATE({field}) BETWEEN '{c['inicio']}' AND '{c['fin']}' THEN '{label}'")
        g = f"CASE {' '.join(whens)} ELSE NULL END"
        return g, g
    if granularidad == "sem_com":
        cycles = bq.load_cycles()
        whens = []
        for c in cycles:
            for s in c["semanas"]:
                label = f"C{c['ciclo']:02d}-S{s['num']:02d}"
                whens.append(f"WHEN DATE({field}) BETWEEN '{s['inicio']}' AND '{s['fin']}' THEN '{label}'")
        g = f"CASE {' '.join(whens)} ELSE NULL END"
        return g, g
    g = f"FORMAT_DATE('%Y-%m', DATE({field}))"
    return g, g


# ── Página principal ─────────────────────────────────────────────────────────
@router.get("", response_class=HTMLResponse)
def page(request: Request):
    return templates.TemplateResponse("funnel_inmo_mx/page.html", {
        "request": request,
        "etapas": ETAPAS_INMO,
        "fecha_desde": FECHA_INICIO,
        "fecha_hasta": date.today().isoformat(),
    })


# ── /filters ─────────────────────────────────────────────────────────────────
@router.get("/filters")
def filters_options(
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
):
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    sql = f"""
    WITH base AS (
      SELECT
        COALESCE(NULLIF(f.equipo_sellers, ''), 'Sin equipo') AS equipo,
        COALESCE(f.fuente, '')                               AS fuente,
        COALESCE(f.area_metropolitana, '')                   AS area,
        FORMAT_DATE('%Y-%m', DATE(f.fecha))                  AS mes
      FROM `{TABLE}` f
      WHERE DATE(f.fecha) >= '{fecha_desde}' AND DATE(f.fecha) <= '{fecha_hasta}'
    )
    SELECT
      ARRAY(SELECT DISTINCT equipo FROM base WHERE equipo != '' ORDER BY equipo) AS equipos,
      ARRAY(SELECT DISTINCT fuente FROM base WHERE fuente != '' ORDER BY fuente) AS fuentes,
      ARRAY(SELECT DISTINCT area   FROM base WHERE area   != '' ORDER BY area)   AS areas,
      ARRAY(SELECT DISTINCT mes    FROM base WHERE mes    != '' ORDER BY mes DESC) AS meses
    """
    rows = bq.query(sql)
    r = rows[0] if rows else {}

    def clean(arr):
        return sorted([x for x in (arr or []) if x and x not in ("", "Sin equipo")])

    return JSONResponse({
        "equipos": clean(r.get("equipos")),
        "fuentes": clean(r.get("fuentes")),
        "areas":   clean(r.get("areas")),
        "meses":   [m for m in (r.get("meses") or []) if m],
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
    equipo: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    dia_min: Annotated[int | None, Query()] = None,
    dia_max: Annotated[int | None, Query()] = None,
):
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    where = _build_where(fecha_desde, fecha_hasta, equipo, fuente, area)
    where = _append_dia_mes(where, "f.fecha", dia_min, dia_max, granularidad)
    group_expr, order_expr = _group_expr(granularidad)
    stage_keys = [e["key"] for e in ETAPAS_INMO]

    sql = f"""
    SELECT {group_expr} AS periodo, f.valor AS etapa, COUNT(DISTINCT f.nid) AS nids
    FROM `{TABLE}` f
    WHERE {where}
      AND f.valor IN ({_quote_list(stage_keys)})
    GROUP BY 1, 2
    ORDER BY {order_expr}
    """
    rows = bq.query(sql)
    rows = [r for r in rows if r["periodo"] is not None]
    periodos = sorted(list({r["periodo"] for r in rows}))
    by_etapa: dict[str, dict[str, int]] = {}
    for r in rows:
        by_etapa.setdefault(r["etapa"], {})[r["periodo"]] = int(r["nids"])

    datasets = []
    for et in ETAPAS_INMO:
        if et["key"] not in by_etapa:
            continue
        datasets.append({
            "label": et["label"], "color": et["color"],
            "data": [by_etapa[et["key"]].get(p, 0) for p in periodos],
            "etapa_key": et["key"],
        })
    return JSONResponse({"labels": periodos, "datasets": datasets, "granularidad": granularidad})


# ── /kpis ────────────────────────────────────────────────────────────────────
@router.get("/kpis", response_class=HTMLResponse)
def kpis(
    request: Request,
    equipo: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    granularidad: Annotated[str, Query()] = "mes",
):
    w = bq.kpi_windows(granularidad)

    def make_where(s, e):
        return _build_where(s, e, equipo, fuente, area)

    stage_keys = [e["key"] for e in ETAPAS_INMO]
    sql = f"""
    SELECT 'actual' AS periodo, f.valor AS etapa, COUNT(DISTINCT f.nid) AS nids
    FROM `{TABLE}` f
    WHERE {make_where(w['inicio_actual'], w['fin_actual'])} AND f.valor IN ({_quote_list(stage_keys)})
    GROUP BY 1, 2
    UNION ALL
    SELECT 'anterior' AS periodo, f.valor AS etapa, COUNT(DISTINCT f.nid) AS nids
    FROM `{TABLE}` f
    WHERE {make_where(w['inicio_anterior'], w['fin_anterior'])} AND f.valor IN ({_quote_list(stage_keys)})
    GROUP BY 1, 2
    """
    rows = bq.query(sql)
    actual: dict[str, int] = {}
    anterior: dict[str, int] = {}
    for r in rows:
        (actual if r["periodo"] == "actual" else anterior)[r["etapa"]] = int(r["nids"])

    kpis_cfg = [
        {"label": "Asignados",      "keys": ["Asignados"]},
        {"label": "Contactados",    "keys": ["contactado"]},
        {"label": "Oferta acept.",  "keys": ["oferta_aceptada_gabi"]},
        {"label": "Contrato",       "keys": ["En legal"]},
        {"label": "Firmas",         "keys": ["Firma"]},
        {"label": "Captaciones",    "keys": ["captaciones_3_checks"]},
    ]
    kpi_rows = []
    for k in kpis_cfg:
        act = sum(actual.get(x, 0) for x in k["keys"])
        ant = sum(anterior.get(x, 0) for x in k["keys"])
        delta = ((act - ant) / ant * 100) if ant > 0 else None
        kpi_rows.append({"label": k["label"], "actual": act, "anterior": ant, "delta": delta})

    return templates.TemplateResponse("funnel_mm_mx/partials/kpis.html", {
        "request": request,
        "kpis": kpi_rows,
        "label_actual": w["label_actual"],
        "label_anterior": w["label_anterior"],
        "dia_corte": w["dia_corte"],
        "modo": w["modo"],
    })


# ── /conv-time ───────────────────────────────────────────────────────────────
@router.get("/conv-time")
def conv_time(
    granularidad: Annotated[str, Query()] = "mes",
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    num: Annotated[list[str] | None, Query()] = None,
    den: Annotated[list[str] | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    dia_min: Annotated[int | None, Query()] = None,
    dia_max: Annotated[int | None, Query()] = None,
):
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    if not num:
        num = ["captaciones_3_checks"]
    if not den:
        den = [ETAPA_ASIGNACION]
    where = _build_where(fecha_desde, fecha_hasta, equipo, fuente, area)
    where = _append_dia_mes(where, "f.fecha", dia_min, dia_max, granularidad)
    group_f, _ = _group_expr(granularidad)

    sql = f"""
    WITH events AS (
      SELECT {group_f} AS periodo, f.valor AS etapa, CAST(f.nid AS STRING) AS cid
      FROM `{TABLE}` f
      WHERE {where} AND f.valor IN ({_quote_list(sorted(set(num + den)))})
    )
    SELECT periodo,
      COUNT(DISTINCT IF(etapa IN ({_quote_list(num)}), cid, NULL)) AS num,
      COUNT(DISTINCT IF(etapa IN ({_quote_list(den)}), cid, NULL)) AS den
    FROM events WHERE periodo IS NOT NULL GROUP BY 1 ORDER BY 1
    """
    rows = bq.query(sql)
    rows = [r for r in rows if r["periodo"] is not None]
    labels = [r["periodo"] for r in rows]
    nums = [int(r["num"]) for r in rows]
    dens = [int(r["den"]) for r in rows]
    cvrs = [(n / d * 100) if d > 0 else None for n, d in zip(nums, dens)]
    total_n, total_d = sum(nums), sum(dens)
    return JSONResponse({
        "labels": labels, "num": nums, "den": dens, "cvr": cvrs,
        "total_num": total_n, "total_den": total_d,
        "total_cvr": (total_n / total_d * 100) if total_d > 0 else None,
        "num_etapas": num, "den_etapas": den,
    })


# ── /cosechas ────────────────────────────────────────────────────────────────
@router.get("/cosechas")
def cosechas(
    origen: Annotated[str, Query()] = "Asignados",
    destino: Annotated[str, Query()] = "captaciones_3_checks",
    granularidad: Annotated[str, Query()] = "semana",
    bucket: Annotated[str, Query()] = "iso",
    conteo: Annotated[str, Query()] = "cohorte",
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
):
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    unit = "WEEK(MONDAY)" if granularidad == "semana" else "MONTH"
    fmt = "'%Y-%m-%d'" if granularidad == "semana" else "'%Y-%m'"
    if bucket == "dias":
        days_per_bucket = 7 if granularidad == "semana" else 30
        offset_expr = f"DIV(DATE_DIFF(d.fecha_destino, o.fecha_origen, DAY), {days_per_bucket})"
    else:
        diff_unit = "WEEK" if granularidad == "semana" else "MONTH"
        offset_expr = f"DATE_DIFF(d.fecha_destino, o.fecha_origen, {diff_unit})"

    where_origen = _build_where(fecha_desde, fecha_hasta, equipo, fuente, area)
    o_esc, d_esc = origen.replace("'", "''"), destino.replace("'", "''")

    if conteo == "funnel":
        origen_cte = f"""
        origen AS (
          SELECT f.nid, DATE_TRUNC(DATE(f.fecha), {unit}) AS cohorte_date, MIN(DATE(f.fecha)) AS fecha_origen
          FROM `{TABLE}` f WHERE {where_origen} AND f.valor = '{o_esc}' GROUP BY 1, 2
        )"""
        cohorte_expr = f"FORMAT_DATE({fmt}, o.cohorte_date)"
    else:
        origen_cte = f"""
        origen AS (
          SELECT f.nid, MIN(DATE(f.fecha)) AS fecha_origen
          FROM `{TABLE}` f WHERE {where_origen} AND f.valor = '{o_esc}' GROUP BY f.nid
        )"""
        cohorte_expr = f"FORMAT_DATE({fmt}, DATE_TRUNC(o.fecha_origen, {unit}))"

    sql = f"""
    WITH {origen_cte},
    destino AS (
      SELECT nid, MIN(DATE(fecha)) AS fecha_destino FROM `{TABLE}` WHERE valor = '{d_esc}' GROUP BY nid
    ),
    joined AS (
      SELECT {cohorte_expr} AS cohorte, {offset_expr} AS offset_unit
      FROM origen o LEFT JOIN destino d ON d.nid = o.nid AND d.fecha_destino >= o.fecha_origen
    )
    SELECT cohorte, offset_unit, COUNT(*) AS n FROM joined WHERE cohorte IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2
    """
    rows = bq.query(sql)
    cohortes: dict[str, dict[int | None, int]] = {}
    for r in rows:
        cohortes.setdefault(r["cohorte"], {})[r["offset_unit"]] = int(r["n"])

    cohortes_ordered = sorted(cohortes.keys())
    max_offset = 0
    for v in cohortes.values():
        for o in v.keys():
            if o is not None and o > max_offset:
                max_offset = o

    matrix = []
    for c in cohortes_ordered:
        buckets = cohortes[c]
        total = sum(buckets.values())
        by_offset_counts = [buckets.get(o, 0) for o in range(max_offset + 1)]
        no_reached = buckets.get(None, 0)
        alcanzaron = total - no_reached
        by_offset_pct = [(x / total * 100) if total > 0 else 0 for x in by_offset_counts]
        by_offset_share = [(x / alcanzaron * 100) if alcanzaron > 0 else 0 for x in by_offset_counts]
        cum_counts, cum = [], 0
        for x in by_offset_counts:
            cum += x
            cum_counts.append(cum)
        cum_pct = [(x / total * 100) if total > 0 else 0 for x in cum_counts]
        cum_share = [(x / alcanzaron * 100) if alcanzaron > 0 else 0 for x in cum_counts]
        matrix.append({
            "cohorte": c, "total": total, "alcanzaron": alcanzaron, "no_alcanzaron": no_reached,
            "counts": by_offset_counts, "pct": by_offset_pct, "share": by_offset_share,
            "cum_counts": cum_counts, "cum_pct": cum_pct, "cum_share": cum_share,
        })

    prefix = "S" if granularidad == "semana" else "M"
    offset_labels = [f"{prefix}{i}" for i in range(max_offset + 1)]
    if bucket == "dias":
        step = 7 if granularidad == "semana" else 30
        offset_ranges = [f"{i*step}-{(i+1)*step-1}d" for i in range(max_offset + 1)]
    else:
        offset_ranges = None

    return JSONResponse({
        "origen": origen, "destino": destino, "granularidad": granularidad,
        "bucket": bucket, "conteo": conteo,
        "offset_labels": offset_labels, "offset_ranges": offset_ranges, "rows": matrix,
    })


# ── /negocios ────────────────────────────────────────────────────────────────
TABLE_ETAPAS_FIELDS = [
    ("fecha_asignado", "F. asignado",      "Asignados"),
    ("fecha_contacto", "F. contacto",      "contactado"),
    ("fecha_aceptada", "F. oferta acept.", "oferta_aceptada_gabi"),
    ("fecha_contrato", "F. contrato",      "En legal"),
    ("fecha_firmas",   "F. firmas",        "Firma"),
    ("fecha_captado",  "F. captación",     "captaciones_3_checks"),
]


@router.get("/negocios")
def negocios(
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    etapa: Annotated[str | None, Query()] = None,
    search: Annotated[str | None, Query()] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 50,
):
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    where = _build_where("2020-01-01", date.today().isoformat(), equipo, fuente, area)
    date_field = etapa if etapa in {f for f, _, _ in TABLE_ETAPAS_FIELDS} else "fecha_asignado"

    select_etapas = ",\n      ".join([
        f"MIN(CASE WHEN f.valor = '{bq_etapa}' THEN CAST(f.fecha AS STRING) END) AS {field}"
        for field, _, bq_etapa in TABLE_ETAPAS_FIELDS
    ])
    search_clause = ""
    if search:
        safe = search.replace("'", "''")
        search_clause = f"AND CAST(f.nid AS STRING) LIKE '%{safe}%'"

    having = [f"{date_field} IS NOT NULL"]
    if fecha_desde:
        having.append(f"SUBSTR({date_field}, 1, 10) >= '{fecha_desde}'")
    if fecha_hasta:
        having.append(f"SUBSTR({date_field}, 1, 10) <= '{fecha_hasta}'")
    having_sql = " AND ".join(having)

    cohort_cte = f"""
    cohort AS (
      SELECT
        CAST(f.nid AS STRING) AS nid,
        ANY_VALUE(COALESCE(NULLIF(f.equipo_sellers, ''), 'Sin equipo')) AS equipo,
        ANY_VALUE(COALESCE(f.fuente, ''))                              AS fuente,
        ANY_VALUE(COALESCE(f.area_metropolitana, ''))                  AS area_metropolitana,
        {select_etapas}
      FROM `{TABLE}` f
      WHERE {where} {search_clause}
      GROUP BY 1
      HAVING {having_sql}
    )"""

    base_sql = f"""
    WITH {cohort_cte}
    SELECT * FROM cohort ORDER BY {date_field} DESC
    LIMIT {page_size} OFFSET {(page - 1) * page_size}
    """
    rows = bq.query(base_sql)
    total = int(bq.query(f"WITH {cohort_cte} SELECT COUNT(*) AS total FROM cohort")[0]["total"])

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


# ── /funnel-compare → funnel cohortado (A vs B) ──────────────────────────────
@router.get("/funnel-compare")
def funnel_compare(
    mes: Annotated[str | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
):
    """Funnel cohortado (misma semántica que /cosechas, conteo=cohorte)."""
    label = mes if mes else "Todo"
    where_asig = _build_where(FECHA_INICIO, date.today().isoformat(), equipo, fuente, area)
    cohort_where = f"AND FORMAT_DATE('%Y-%m', fecha_origen) = '{mes}'" if mes else ""
    stage_keys = [k for k, _, _ in FUNNEL_COMPARE_STAGES]

    sql = f"""
    WITH asig AS (
      SELECT f.nid, MIN(DATE(f.fecha)) AS fecha_origen
      FROM `{TABLE}` f
      WHERE {where_asig} AND f.valor = '{ETAPA_ASIGNACION}'
      GROUP BY f.nid
    ),
    cohort AS (SELECT nid, fecha_origen FROM asig WHERE TRUE {cohort_where}),
    stage_min AS (
      SELECT f.nid, f.valor AS etapa, MIN(DATE(f.fecha)) AS fecha_etapa
      FROM `{TABLE}` f JOIN cohort co ON co.nid = f.nid
      WHERE f.valor IN ({_quote_list(stage_keys)})
      GROUP BY 1, 2
    ),
    reached AS (
      SELECT sm.etapa, COUNT(DISTINCT sm.nid) AS nids
      FROM stage_min sm JOIN cohort co ON co.nid = sm.nid
      WHERE sm.fecha_etapa >= co.fecha_origen
      GROUP BY 1
    )
    SELECT etapa, nids FROM reached
    """
    rows = bq.query(sql)
    by_etapa = {r["etapa"]: int(r["nids"]) for r in rows}

    first = by_etapa.get(ETAPA_ASIGNACION, 0)
    stages = []
    prev_n = None
    for key, lbl, excl in FUNNEL_COMPARE_STAGES:
        n = by_etapa.get(key, 0)
        pct_first = (n / first * 100) if first > 0 else 0
        pct_prev = (n / prev_n * 100) if (prev_n and prev_n > 0) else None
        stages.append({"key": key, "label": lbl, "exclusion": excl,
                       "nids": n, "pct_first": pct_first, "pct_prev": pct_prev})
        if not excl:
            prev_n = n

    return JSONResponse({"mes": label, "total": first, "stages": stages})
