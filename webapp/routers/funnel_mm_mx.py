"""Funnel MM México — vertical slice inicial (volumen, KPIs, filtros).

Portado de routers/funnel_mm.py (CO) a la fuente MX. Diferencias clave vs CO
(ver memoria mx-funnel-inmo-quirks / mx-bq-tables):

- Fuente = `sellers-main-prod.bi_mx.seguimiento_funnel_mex` (NO funnel_diarios_col).
- Etapas en `valor` con strings LIMPIOS (sin los typos de CO: aquí es
  'Primer asignacion', 'Aprobado General' / 'Primer inmueble aprobado').
- `equipo`, `prioridad_gestion_market_maker`, `categoria_comercial` son columnas
  PROPIAS del funnel MX → no se necesita el CSV de comerciales ni el join a deals.
- Hay etapas duplicadas '(hubspot)' (ej. 'Cita Agendada (hubspot)'): se excluyen
  para no doble-contar; el funnel usa las variantes base.

Difiere de CO (pendiente para pasos siguientes): motivo de venta, leads upstream
(Lead/Calificado), metas, precios+subsidios, cosechas, negocios, share/conv-time.
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

TABLE = "sellers-main-prod.bi_mx.seguimiento_funnel_mex"
FECHA_INICIO = "2026-01-01"

# Etapas que NO son del funnel principal — se excluyen del WHERE.
# Incluye las duplicadas '(hubspot)' para no doble-contar contra las base.
EXCLUDE_ETAPAS = [
    "llamadas_comercial",
    "Cita Agendada (hubspot)",
    "Visita Efectuada (hubspot)",
]

# Etapas del funnel MM MX (orden lógico) — para charts y KPIs.
ETAPAS_MM = [
    {"key": "Primer asignacion",               "label": "Asignación",      "color": "#7c3aed"},
    {"key": "Cita Agendada",                   "label": "Cita",            "color": "#ec4899"},
    {"key": "Visita Efectuada",                "label": "Visita",          "color": "#f59e0b"},
    {"key": "Pre-comite validado",             "label": "Pre-comité",      "color": "#10b981"},
    {"key": "rechazo Comité",                  "label": "Descartado",      "color": "#94a3b8"},
    {"key": "Primer inmueble aprobado",        "label": "Inmueble aprob.", "color": "#06b6d4"},
    {"key": "Aprobado General",                "label": "Aprobado",        "color": "#22c55e"},
    {"key": "Rechazo Oferta",                  "label": "Rechazó",         "color": "#ef4444"},
    {"key": "Acepto Oferta - Pendiente firma", "label": "Aceptó",          "color": "#3b82f6"},
    {"key": "Cierre - Comprado",               "label": "Cierre",          "color": "#1e40af"},
]

SIN_PRIORIDAD_LABEL = "Sin prioridad"

CAT_COLORS = {
    "A":             "#7c3aed",
    "B":             "#10b981",
    "C":             "#f59e0b",
    "Sin categoría": "#94a3b8",
}

# Etapa de primera asignación (universo del share por categoría / razón de venta).
ETAPA_ASIGNACION = "Primer asignacion"

# Etapas del funnel para la comparación de cohortes (key BQ, label, es_exclusion).
# Las de exclusión (rechazos/descartes) se pintan en rojo, como en el reporte.
FUNNEL_COMPARE_STAGES = [
    ("Primer asignacion",               "Primer Asignación",   False),
    ("Cita Agendada",                   "Cita agendada",       False),
    ("Visita Efectuada",                "Visita efectuada",    False),
    ("Pre-comite validado",             "Pre-comité validado", False),
    ("rechazo Comité",                  "Descartado por comité", True),
    ("Aprobado General",                "Aprobado",            False),
    ("Acepto Oferta - Pendiente firma", "Aceptó oferta",       False),
    ("Cierre - Comprado",               "Cierre",              False),
]

# Razón de venta MX — consolidada en hubspot.deals (a diferencia de CO, texto libre
# por keywords). Usa `razon_de_venta_usuario_gabi_mx`; si está vacío, mapea
# `sub_segmento_seller_mx` a la categoría consolidada; si no, 'Sin clasificar'.
MOTIVO_CATEGORIAS = [
    {"key": "Cambio de Casa", "color": "#3b82f6"},
    {"key": "Liquidez",       "color": "#ea580c"},
    {"key": "Otros",          "color": "#64748b"},
]
MOTIVO_SIN = "Sin clasificar"


def _motivo_expr(alias: str = "d") -> str:
    """Expresión SQL de la razón de venta consolidada (sobre el alias de deals)."""
    return f"""COALESCE(
        NULLIF(TRIM({alias}.razon_de_venta_usuario_gabi_mx), ''),
        CASE TRIM({alias}.sub_segmento_seller_mx)
          WHEN 'Cambio de Casa - Destino definido, mudanza pendiente'      THEN 'Cambio de Casa'
          WHEN 'Cambio de Casa - Mudados'                                  THEN 'Cambio de Casa'
          WHEN 'Cambio de Casa - Sin destino definido, explorando opciones' THEN 'Cambio de Casa'
          WHEN 'Deuda / problemas financieros'                             THEN 'Liquidez'
          WHEN 'Inversión'                                                 THEN 'Liquidez'
          WHEN 'Liquidez - Necesidad médica'                               THEN 'Liquidez'
          WHEN 'Liquidez - Pago de estudios'                               THEN 'Liquidez'
          WHEN 'Liquidez - Propiedad no habitada'                          THEN 'Liquidez'
          WHEN 'Necesidad médica'                                          THEN 'Liquidez'
          WHEN 'Adulto mayor / dependencia'                                THEN 'Otros'
          WHEN 'Cambio laboral / ciudad / país'                            THEN 'Otros'
          WHEN 'Con sentencia / convenio'                                  THEN 'Otros'
          WHEN 'Divorcios - Sin sentencia'                                 THEN 'Otros'
          WHEN 'Propiedad no habitada'                                     THEN 'Otros'
          WHEN 'Sin sentencia'                                             THEN 'Otros'
          ELSE NULL
        END,
        '{MOTIVO_SIN}'
      )"""


# CTE de razón de venta (1 fila por nid) + join estándar contra el funnel (alias f).
# Mismo patrón que CO (_ctes + MOTIVO_JOIN): se incluye en todas las queries para que
# `dm.motivo` exista como dimensión filtrable.
def _ctes() -> str:
    return (
        "WITH deals_motivo AS (\n"
        f"  SELECT nid, {_motivo_expr('d')} AS motivo\n"
        "  FROM `sellers-main-prod.hubspot.deals` d\n"
        "  QUALIFY ROW_NUMBER() OVER (PARTITION BY nid ORDER BY nid) = 1\n"
        ")"
    )

MOTIVO_JOIN = "LEFT JOIN deals_motivo dm ON dm.nid = f.nid"


def _quote_list(items: list[str]) -> str:
    safe = [i.replace("'", "''") for i in items]
    return ", ".join(f"'{s}'" for s in safe)


def _map_prioridad(vals: list[str]) -> list[str]:
    return ["" if v == SIN_PRIORIDAD_LABEL else v for v in vals]


def _build_where(
    fecha_desde: str,
    fecha_hasta: str,
    equipos: list[str] | None = None,
    cats: list[str] | None = None,
    recurrencia: list[str] | None = None,
    fuentes: list[str] | None = None,
    areas: list[str] | None = None,
    motivo: list[str] | None = None,
) -> str:
    """WHERE con los filtros activos. Alias de la tabla = `f`.

    Si se pasa `motivo`, la query debe incluir el CTE `deals_motivo` (vía `_ctes()`)
    y el `MOTIVO_JOIN` para que el alias `dm` exista.
    """
    conds = [
        f"DATE(f.fecha) >= '{fecha_desde}'",
        f"DATE(f.fecha) <= '{fecha_hasta}'",
        f"f.valor NOT IN ({_quote_list(EXCLUDE_ETAPAS)})",
    ]
    if equipos:
        conds.append(f"COALESCE(NULLIF(f.equipo, ''), 'Sin equipo') IN ({_quote_list(equipos)})")
    if cats:
        conds.append(
            "COALESCE(NULLIF(f.prioridad_gestion_market_maker, ''), f.categoria_comercial, '') "
            f"IN ({_quote_list(cats)})"
        )
    if recurrencia:
        conds.append(
            f"COALESCE(NORMALIZE(f.flag_recurrecia_gestion, NFC), '') IN ({_quote_list(recurrencia)})"
        )
    if fuentes:
        conds.append(f"COALESCE(f.fuente, '') IN ({_quote_list(fuentes)})")
    if areas:
        conds.append(f"COALESCE(f.area_metropolitana, '') IN ({_quote_list(areas)})")
    if motivo:
        conds.append(f"COALESCE(dm.motivo, '{MOTIVO_SIN}') IN ({_quote_list(motivo)})")
    return "\n  AND ".join(conds)


def _group_expr(granularidad: str, field: str = "f.fecha") -> tuple[str, str]:
    """SQL para agrupar por granularidad. Devuelve (group_expr, order_expr).

    mes_com / sem_com agrupan por ciclo / semana comercial usando el calendario
    en `reports/comercial_cycles.json` (CO y MX comparten los mismos ciclos).
    """
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
    today = date.today().isoformat()
    return templates.TemplateResponse("funnel_mm_mx/page.html", {
        "request": request,
        "etapas": ETAPAS_MM,
        "fecha_desde": FECHA_INICIO,
        "fecha_hasta": today,
    })


# ── /filters → opciones para los multi-selects ───────────────────────────────
@router.get("/filters")
def filters_options(
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
):
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    excl = _quote_list(EXCLUDE_ETAPAS)
    sql = f"""
    WITH base AS (
      SELECT
        COALESCE(NULLIF(f.equipo, ''), 'Sin equipo')                                        AS equipo,
        COALESCE(NULLIF(f.prioridad_gestion_market_maker, ''), f.categoria_comercial, '')   AS cat,
        COALESCE(NULLIF(f.prioridad_gestion_market_maker, ''), '')                          AS prioridad_mm,
        COALESCE(NORMALIZE(f.flag_recurrecia_gestion, NFC), '')                             AS recurrencia,
        COALESCE(f.fuente, '')                                                              AS fuente,
        COALESCE(f.area_metropolitana, '')                                                  AS area,
        FORMAT_DATE('%Y-%m', DATE(f.fecha))                                                 AS mes
      FROM `{TABLE}` f
      WHERE DATE(f.fecha) >= '{fecha_desde}'
        AND DATE(f.fecha) <= '{fecha_hasta}'
        AND f.valor NOT IN ({excl})
    )
    SELECT
      ARRAY(SELECT DISTINCT equipo      FROM base WHERE equipo      != '' ORDER BY equipo)      AS equipos,
      ARRAY(SELECT DISTINCT cat         FROM base WHERE cat         != '' ORDER BY cat)         AS cats,
      ARRAY(SELECT DISTINCT IF(prioridad_mm = '', '{SIN_PRIORIDAD_LABEL}', prioridad_mm) FROM base ORDER BY 1) AS prioridades_mm,
      ARRAY(SELECT DISTINCT recurrencia FROM base WHERE recurrencia != '' ORDER BY recurrencia) AS recurrencias,
      ARRAY(SELECT DISTINCT fuente      FROM base WHERE fuente      != '' ORDER BY fuente)      AS fuentes,
      ARRAY(SELECT DISTINCT area        FROM base WHERE area        != '' ORDER BY area)        AS areas,
      ARRAY(SELECT DISTINCT mes         FROM base WHERE mes         != '' ORDER BY mes DESC)    AS meses
    """
    rows = bq.query(sql)
    r = rows[0] if rows else {}

    def clean(arr):
        return sorted([x for x in (arr or []) if x and x not in ("", "Sin equipo", "Sin categoría")])

    return JSONResponse({
        "equipos":        clean(r.get("equipos")),
        "cats":           clean(r.get("cats")),
        "prioridades_mm": clean(r.get("prioridades_mm")),
        "recurrencias":   clean(r.get("recurrencias")),
        "fuentes":        clean(r.get("fuentes")),
        "areas":          clean(r.get("areas")),
        # Razón de venta: categorías consolidadas (estáticas) + 'Sin clasificar'.
        "motivos":        [c["key"] for c in MOTIVO_CATEGORIAS] + [MOTIVO_SIN],
        # Meses disponibles (YYYY-MM), desc — para la comparación de cohortes.
        "meses":          [m for m in (r.get("meses") or []) if m],
    })


# ── /volumen → JSON con la serie por etapa ───────────────────────────────────
@router.get("/volumen")
def volumen(
    request: Request,
    granularidad: Annotated[str, Query()] = "mes",
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
    recurrencia: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
):
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    where = _build_where(fecha_desde, fecha_hasta, equipo, cat, _map_prioridad(recurrencia or []) or None, fuente, area, motivo)
    group_expr, order_expr = _group_expr(granularidad)

    sql = f"""
    {_ctes()}
    SELECT
      {group_expr} AS periodo,
      f.valor      AS etapa,
      COUNT(DISTINCT f.nid) AS nids
    FROM `{TABLE}` f
    {MOTIVO_JOIN}
    WHERE {where}
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
    for et in ETAPAS_MM:
        if et["key"] not in by_etapa:
            continue
        data = [by_etapa[et["key"]].get(p, 0) for p in periodos]
        datasets.append({
            "label": et["label"],
            "color": et["color"],
            "data": data,
            "etapa_key": et["key"],
        })

    return JSONResponse({
        "labels": periodos,
        "datasets": datasets,
        "granularidad": granularidad,
    })


# ── /kpis → fragmento HTML con KPIs MTD ──────────────────────────────────────
@router.get("/kpis", response_class=HTMLResponse)
def kpis(
    request: Request,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
    recurrencia: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
):
    """MTD del mes actual (días 1..hoy) vs mismos días mes anterior."""
    hoy = date.today()
    inicio_actual = hoy.replace(day=1)
    inicio_anterior = (inicio_actual - timedelta(days=1)).replace(day=1)
    fin_anterior = inicio_anterior + (hoy - inicio_actual)
    rec = _map_prioridad(recurrencia or []) or None

    def make_where(start: str, end: str) -> str:
        return _build_where(start, end, equipo, cat, rec, fuente, area, motivo)

    sql = f"""
    {_ctes()}
    SELECT 'actual' AS periodo, f.valor AS etapa, COUNT(DISTINCT f.nid) AS nids
    FROM `{TABLE}` f
    {MOTIVO_JOIN}
    WHERE {make_where(inicio_actual.isoformat(), hoy.isoformat())}
    GROUP BY 1, 2
    UNION ALL
    SELECT 'anterior' AS periodo, f.valor AS etapa, COUNT(DISTINCT f.nid) AS nids
    FROM `{TABLE}` f
    {MOTIVO_JOIN}
    WHERE {make_where(inicio_anterior.isoformat(), fin_anterior.isoformat())}
    GROUP BY 1, 2
    """
    rows = bq.query(sql)
    actual: dict[str, int] = {}
    anterior: dict[str, int] = {}
    for r in rows:
        target = actual if r["periodo"] == "actual" else anterior
        target[r["etapa"]] = int(r["nids"])

    kpis_cfg = [
        {"label": "Asignaciones", "keys": ["Primer asignacion"]},
        {"label": "Citas",        "keys": ["Cita Agendada"]},
        {"label": "Visitas",      "keys": ["Visita Efectuada"]},
        {"label": "Pre-comité",   "keys": ["Pre-comite validado"]},
        {"label": "Aprobados",    "keys": ["Aprobado General"]},
        {"label": "Cierres",      "keys": ["Cierre - Comprado"]},
    ]
    kpi_rows = []
    for k in kpis_cfg:
        act = sum(actual.get(x, 0) for x in k["keys"])
        ant = sum(anterior.get(x, 0) for x in k["keys"])
        delta = ((act - ant) / ant * 100) if ant > 0 else None
        kpi_rows.append({"label": k["label"], "actual": act, "anterior": ant, "delta": delta})

    NOMBRES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"]
    label_actual   = f"{NOMBRES[inicio_actual.month-1]} {inicio_actual.year}"
    label_anterior = f"{NOMBRES[inicio_anterior.month-1]} {inicio_anterior.year}"

    return templates.TemplateResponse("funnel_mm_mx/partials/kpis.html", {
        "request": request,
        "kpis": kpi_rows,
        "label_actual": label_actual,
        "label_anterior": label_anterior,
        "dia_corte": hoy.day,
    })


# ── /share-cat → distribución por categoría (A/B/C) en Primera asignación ─────
@router.get("/share-cat")
def share_cat(
    granularidad: Annotated[str, Query()] = "mes",
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
    recurrencia: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
):
    """Distribución por categoría (A/B/C) sobre la etapa de Primera asignación.

    Devuelve {donut:{labels,values,colors,total}, bars:{labels,datasets}}.
    """
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    rec = _map_prioridad(recurrencia or []) or None
    where = _build_where(fecha_desde, fecha_hasta, equipo, cat, rec, fuente, area, motivo)
    group_expr, _ = _group_expr(granularidad)

    sql = f"""
    {_ctes()}
    SELECT
      {group_expr} AS periodo,
      COALESCE(NULLIF(f.prioridad_gestion_market_maker, ''), f.categoria_comercial, 'Sin categoría') AS categoria,
      COUNT(DISTINCT f.nid) AS nids
    FROM `{TABLE}` f
    {MOTIVO_JOIN}
    WHERE {where}
      AND f.valor = '{ETAPA_ASIGNACION}'
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

    order = ["A", "B", "C"] + sorted(cats_seen - {"A", "B", "C", "Sin categoría"}) + ["Sin categoría"]
    cats_ordered = [c for c in order if c in cats_seen]
    periodos_ordered = sorted(periodos)

    donut_values = [donut.get(c, 0) for c in cats_ordered]
    donut_colors = [CAT_COLORS.get(c, "#94a3b8") for c in cats_ordered]
    bars_datasets = [{
        "label": c,
        "color": CAT_COLORS.get(c, "#94a3b8"),
        "data": [by_period.get(p, {}).get(c, 0) for p in periodos_ordered],
    } for c in cats_ordered]

    return JSONResponse({
        "donut": {"labels": cats_ordered, "values": donut_values, "colors": donut_colors, "total": sum(donut_values)},
        "bars": {"labels": periodos_ordered, "datasets": bars_datasets},
    })


# ── /share-motivo → distribución por razón de venta (Primera asignación) ─────
@router.get("/share-motivo")
def share_motivo(
    granularidad: Annotated[str, Query()] = "mes",
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
    recurrencia: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
):
    """Distribución por razón de venta sobre la etapa de Primera asignación.

    Razón = consolidada de `deals` (razon_de_venta_usuario_gabi_mx → fallback a
    sub_segmento_seller_mx → 'Sin clasificar'), unida al funnel por nid. Mismo
    universo que /share-cat. Devuelve {donut, bars}.
    """
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    rec = _map_prioridad(recurrencia or []) or None
    where = _build_where(fecha_desde, fecha_hasta, equipo, cat, rec, fuente, area, motivo)
    group_expr, _ = _group_expr(granularidad)

    sql = f"""
    {_ctes()}
    SELECT
      {group_expr} AS periodo,
      COALESCE(dm.motivo, '{MOTIVO_SIN}') AS categoria,
      COUNT(DISTINCT f.nid) AS nids
    FROM `{TABLE}` f
    {MOTIVO_JOIN}
    WHERE {where}
      AND f.valor = '{ETAPA_ASIGNACION}'
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
        c = r["categoria"] or MOTIVO_SIN
        cats_seen.add(c)
        periodos.add(r["periodo"])
        donut[c] = donut.get(c, 0) + int(r["nids"])
        by_period.setdefault(r["periodo"], {})[c] = int(r["nids"])

    color_by_cat = {c["key"]: c["color"] for c in MOTIVO_CATEGORIAS}
    color_by_cat[MOTIVO_SIN] = "#cbd5e1"
    order = [c["key"] for c in MOTIVO_CATEGORIAS] + [MOTIVO_SIN]
    cats_ordered = [c for c in order if c in cats_seen] + sorted(cats_seen - set(order))
    periodos_ordered = sorted(periodos)

    donut_values = [donut.get(c, 0) for c in cats_ordered]
    donut_colors = [color_by_cat.get(c, "#94a3b8") for c in cats_ordered]
    bars_datasets = [{
        "label": c,
        "color": color_by_cat.get(c, "#94a3b8"),
        "data": [by_period.get(p, {}).get(c, 0) for p in periodos_ordered],
    } for c in cats_ordered]

    return JSONResponse({
        "donut": {"labels": cats_ordered, "values": donut_values, "colors": donut_colors, "total": sum(donut_values)},
        "bars": {"labels": periodos_ordered, "datasets": bars_datasets},
    })


# ── /etapas → lista de etapas disponibles para num/den (CVR) ─────────────────
@router.get("/etapas")
def etapas():
    """Etapas MM MX con labels (para los selects num/den de CVR).

    A diferencia de CO, MX no tiene etapas 'Lead' upstream (no hay
    tabla_inmuebles_general MX).
    """
    return JSONResponse([{"key": e["key"], "label": e["label"]} for e in ETAPAS_MM])


# ── /conv-time → tasa de conversión en el tiempo ─────────────────────────────
@router.get("/conv-time")
def conv_time(
    granularidad: Annotated[str, Query()] = "mes",
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    num: Annotated[list[str] | None, Query()] = None,
    den: Annotated[list[str] | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
    recurrencia: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
):
    """CVR por período = nids(num) / nids(den). num/den son listas de etapas."""
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    if not num:
        num = ["Cierre - Comprado"]
    if not den:
        den = [ETAPA_ASIGNACION]
    rec = _map_prioridad(recurrencia or []) or None
    where = _build_where(fecha_desde, fecha_hasta, equipo, cat, rec, fuente, area, motivo)
    group_f, _ = _group_expr(granularidad)

    sql = f"""
    {_ctes()},
    events AS (
      SELECT {group_f} AS periodo, f.valor AS etapa, CAST(f.nid AS STRING) AS cid
      FROM `{TABLE}` f
      {MOTIVO_JOIN}
      WHERE {where}
        AND f.valor IN ({_quote_list(sorted(set(num + den)))})
    )
    SELECT
      periodo,
      COUNT(DISTINCT IF(etapa IN ({_quote_list(num)}), cid, NULL)) AS num,
      COUNT(DISTINCT IF(etapa IN ({_quote_list(den)}), cid, NULL)) AS den
    FROM events
    WHERE periodo IS NOT NULL
    GROUP BY 1
    ORDER BY 1
    """
    rows = bq.query(sql)
    rows = [r for r in rows if r["periodo"] is not None]
    labels = [r["periodo"] for r in rows]
    nums = [int(r["num"]) for r in rows]
    dens = [int(r["den"]) for r in rows]
    cvrs = [(n / d * 100) if d > 0 else None for n, d in zip(nums, dens)]
    total_n, total_d = sum(nums), sum(dens)
    return JSONResponse({
        "labels": labels,
        "num": nums,
        "den": dens,
        "cvr": cvrs,
        "total_num": total_n,
        "total_den": total_d,
        "total_cvr": (total_n / total_d * 100) if total_d > 0 else None,
        "num_etapas": num,
        "den_etapas": den,
    })


# ── /cosechas → análisis de cohortes (origen → destino) ──────────────────────
@router.get("/cosechas")
def cosechas(
    origen: Annotated[str, Query()] = "Primer asignacion",
    destino: Annotated[str, Query()] = "Cita Agendada",
    granularidad: Annotated[str, Query()] = "semana",  # semana | mes
    bucket: Annotated[str, Query()] = "iso",            # iso | dias
    conteo: Annotated[str, Query()] = "cohorte",        # cohorte | funnel
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
    recurrencia: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
):
    """Cosechas: matriz cohorte × offset (igual que el Funnel MM CO).

    Para cada nid que entra a `origen` en una cohorte (semana/mes), mide en qué
    offset llegó a `destino`. bucket: 'iso' (límites calendario) | 'dias' (bloques
    de 7/30 días corridos). conteo: 'cohorte' (1 cohorte por nid, MIN fecha) |
    'funnel' (un nid por cada período con evento origen, matchea /volumen).
    """
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

    rec = _map_prioridad(recurrencia or []) or None
    where_origen = _build_where(fecha_desde, fecha_hasta, equipo, cat, rec, fuente, area, motivo)
    o_esc = origen.replace("'", "''")
    d_esc = destino.replace("'", "''")

    if conteo == "funnel":
        origen_cte = f"""
        origen AS (
          SELECT f.nid, DATE_TRUNC(DATE(f.fecha), {unit}) AS cohorte_date, MIN(DATE(f.fecha)) AS fecha_origen
          FROM `{TABLE}` f
          {MOTIVO_JOIN}
          WHERE {where_origen}
            AND f.valor = '{o_esc}'
          GROUP BY 1, 2
        )"""
        cohorte_expr = f"FORMAT_DATE({fmt}, o.cohorte_date)"
    else:
        origen_cte = f"""
        origen AS (
          SELECT f.nid, MIN(DATE(f.fecha)) AS fecha_origen
          FROM `{TABLE}` f
          {MOTIVO_JOIN}
          WHERE {where_origen}
            AND f.valor = '{o_esc}'
          GROUP BY f.nid
        )"""
        cohorte_expr = f"FORMAT_DATE({fmt}, DATE_TRUNC(o.fecha_origen, {unit}))"

    sql = f"""
    {_ctes()},
    {origen_cte},
    destino AS (
      SELECT nid, MIN(DATE(fecha)) AS fecha_destino
      FROM `{TABLE}`
      WHERE valor = '{d_esc}'
      GROUP BY nid
    ),
    joined AS (
      SELECT {cohorte_expr} AS cohorte, {offset_expr} AS offset_unit
      FROM origen o
      LEFT JOIN destino d ON d.nid = o.nid AND d.fecha_destino >= o.fecha_origen
    )
    SELECT cohorte, offset_unit, COUNT(*) AS n
    FROM joined
    WHERE cohorte IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1, 2
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
        "offset_labels": offset_labels, "offset_ranges": offset_ranges,
        "rows": matrix,
    })


# ── /negocios → tabla cohort (1 fila por nid) paginada ───────────────────────
# (field, label, valor BQ). 'Aprobado General' matchea también 'Primer inmueble aprobado'.
TABLE_ETAPAS_FIELDS = [
    ("fecha_asignacion", "F. asignación", "Primer asignacion"),
    ("fecha_cita",       "F. cita",       "Cita Agendada"),
    ("fecha_visita",     "F. visita",     "Visita Efectuada"),
    ("fecha_precomite",  "F. pre-comité", "Pre-comite validado"),
    ("fecha_aprobado",   "F. aprobado",   "Aprobado General"),
    ("fecha_acepto",     "F. aceptó",     "Acepto Oferta - Pendiente firma"),
    ("fecha_cierre",     "F. cierre",     "Cierre - Comprado"),
]


@router.get("/negocios")
def negocios(
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
    recurrencia: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
    etapa: Annotated[str | None, Query()] = None,   # fecha_cierre, fecha_visita, etc.
    search: Annotated[str | None, Query()] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 50,
):
    """nids paginados con la cronología de etapas que pasaron.

    - etapa: si se da, solo nids que llegaron a esa etapa; el rango de fechas se
      aplica sobre la fecha de esa etapa (default = asignación).
    - search: substring match en nid.
    """
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    rec = _map_prioridad(recurrencia or []) or None
    # El rango de fechas se aplica luego sobre la columna de etapa (HAVING),
    # así que aquí el WHERE usa un rango amplio.
    where = _build_where("2020-01-01", date.today().isoformat(), equipo, cat, rec, fuente, area, motivo)

    date_field = etapa if etapa in {f for f, _, _ in TABLE_ETAPAS_FIELDS} else "fecha_asignacion"

    select_etapas = ",\n      ".join([
        f"MIN(CASE WHEN f.valor = '{bq_etapa}' THEN CAST(f.fecha AS STRING) END) AS {field}"
        if bq_etapa != "Aprobado General"
        else f"MIN(CASE WHEN f.valor IN ('Aprobado General', 'Primer inmueble aprobado') THEN CAST(f.fecha AS STRING) END) AS {field}"
        for field, _, bq_etapa in TABLE_ETAPAS_FIELDS
    ])

    search_clause = ""
    if search:
        safe = search.replace("'", "''")
        search_clause = f"AND CAST(f.nid AS STRING) LIKE '%{safe}%'"

    having_clauses = [f"{date_field} IS NOT NULL"]
    if fecha_desde:
        having_clauses.append(f"SUBSTR({date_field}, 1, 10) >= '{fecha_desde}'")
    if fecha_hasta:
        having_clauses.append(f"SUBSTR({date_field}, 1, 10) <= '{fecha_hasta}'")
    having_sql = " AND ".join(having_clauses)

    cohort_cte = f"""
    cohort AS (
      SELECT
        CAST(f.nid AS STRING) AS nid,
        ANY_VALUE(COALESCE(NULLIF(f.equipo, ''), 'Sin equipo'))                                  AS equipo,
        ANY_VALUE(COALESCE(NULLIF(f.prioridad_gestion_market_maker, ''), f.categoria_comercial, '')) AS categoria,
        ANY_VALUE(COALESCE(f.fuente, ''))                                                         AS fuente,
        ANY_VALUE(COALESCE(f.area_metropolitana, ''))                                             AS area_metropolitana,
        ANY_VALUE(dm.motivo)                                                                      AS motivo_cat,
        {select_etapas}
      FROM `{TABLE}` f
      {MOTIVO_JOIN}
      WHERE {where}
        {search_clause}
      GROUP BY 1
      HAVING {having_sql}
    )"""

    base_sql = f"""
    {_ctes()},
    {cohort_cte}
    SELECT * FROM cohort
    ORDER BY {date_field} DESC
    LIMIT {page_size}
    OFFSET {(page - 1) * page_size}
    """
    rows = bq.query(base_sql)

    count_sql = f"""
    {_ctes()},
    {cohort_cte}
    SELECT COUNT(*) AS total FROM cohort
    """
    total = int(bq.query(count_sql)[0]["total"])

    for r in rows:
        for f, _, _ in TABLE_ETAPAS_FIELDS:
            v = r.get(f)
            if v:
                r[f] = v[:10]

    return JSONResponse({
        "rows": rows,
        "total": total,
        "page": page,
        "page_size": page_size,
        "etapas": [{"field": f, "label": l} for f, l, _ in TABLE_ETAPAS_FIELDS],
        "date_field": date_field,
    })


# ── /funnel-compare → funnel cohortado (para comparar A vs B) ────────────────
@router.get("/funnel-compare")
def funnel_compare(
    mes: Annotated[str | None, Query()] = None,   # 'YYYY-MM' — cohorte = asignados ese mes
    equipo: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
):
    """Funnel cohortado: nids cuya Primera asignación cae en `mes` (con filtros),
    y cuántos de ESOS alcanzaron cada etapa posterior (en cualquier fecha).

    Devuelve las etapas en orden con nids, % sobre asignación y % vs etapa previa.
    """
    label = mes if mes else "Todo"
    # Cohorte = misma definición que Cosechas (conteo=cohorte): un nid pertenece al
    # mes de su PRIMERA asignación (MIN sobre el rango). Y una etapa "se alcanza"
    # solo si su fecha es ≥ la de asignación (conversión hacia adelante).
    where_asig = _build_where(FECHA_INICIO, date.today().isoformat(), equipo, cat, None, fuente, area, motivo)
    cohort_where = f"AND FORMAT_DATE('%Y-%m', fecha_origen) = '{mes}'" if mes else ""
    stage_keys = [k for k, _, _ in FUNNEL_COMPARE_STAGES]

    sql = f"""
    {_ctes()},
    asig AS (
      SELECT f.nid, MIN(DATE(f.fecha)) AS fecha_origen
      FROM `{TABLE}` f
      {MOTIVO_JOIN}
      WHERE {where_asig}
        AND f.valor = '{ETAPA_ASIGNACION}'
      GROUP BY f.nid
    ),
    cohort AS (
      SELECT nid, fecha_origen FROM asig
      WHERE TRUE {cohort_where}
    ),
    stage_min AS (
      SELECT f.nid, f.valor AS etapa, MIN(DATE(f.fecha)) AS fecha_etapa
      FROM `{TABLE}` f
      JOIN cohort co ON co.nid = f.nid
      WHERE f.valor IN ({_quote_list(stage_keys)})
      GROUP BY 1, 2
    ),
    reached AS (
      SELECT sm.etapa, COUNT(DISTINCT sm.nid) AS nids
      FROM stage_min sm
      JOIN cohort co ON co.nid = sm.nid
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
        stages.append({
            "key": key, "label": lbl, "exclusion": excl,
            "nids": n, "pct_first": pct_first, "pct_prev": pct_prev,
        })
        # El % vs anterior se mide contra la última etapa de progresión (no exclusión).
        if not excl:
            prev_n = n

    return JSONResponse({"mes": label, "total": first, "stages": stages})
