"""Router del Funnel MM — queries y endpoints.

Endpoints:
  GET /              → página principal
  GET /filters       → opciones disponibles para los multi-selects
  GET /volumen       → JSON para el chart de volumen por etapa
  GET /kpis          → fragmento HTML con las 6 KPI cards (MTD vs mes ant)
"""
from __future__ import annotations

import logging
from datetime import date
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates

from webapp import bq
from webapp import metas_mm
from webapp.accounts import BUFFER_EMAILS, sql_not_in

log = logging.getLogger(__name__)
router = APIRouter()
templates = Jinja2Templates(directory=Path(__file__).parent.parent / "templates")

FECHA_INICIO = "2026-01-01"

# Etapas que NO son del funnel principal — se excluyen.
EXCLUDE_ETAPAS = [
    "llamadas_comercial",
    "Referido para inmobiliaria",
    "No gestionado",
    "Captado para inmobiliaria",
]

# Etapas del funnel MM (orden lógico) — para charts y tablas
ETAPAS_MM = [
    {"key": "Primer_asigancion",            "label": "Asignación",      "color": "#7c3aed"},
    {"key": "Cita agendada",                "label": "Cita",            "color": "#ec4899"},
    {"key": "Visita efectuada",             "label": "Visita",          "color": "#f59e0b"},
    {"key": "pre-comité validado",          "label": "Pre-comité",      "color": "#10b981"},
    {"key": "Descartado por comité",        "label": "Descartado",      "color": "#94a3b8"},
    {"key": "inmueble aprobado",            "label": "Inmueble aprob.", "color": "#06b6d4"},
    {"key": "Aprobado",                     "label": "Aprobado",        "color": "#22c55e"},
    {"key": "Rechazó Oferta",               "label": "Rechazó",         "color": "#ef4444"},
    {"key": "Aceptó Oferta - Pendiente firma", "label": "Aceptó",       "color": "#3b82f6"},
    {"key": "Cierre - Comprado",            "label": "Cierre",          "color": "#1e40af"},
]

# Etapas para la comparación de funnels cohortados (key BQ, label, es_exclusion).
FUNNEL_COMPARE_STAGES = [
    ("Primer_asigancion",               "Primer Asignación",   False),
    ("Cita agendada",                   "Cita agendada",       False),
    ("Visita efectuada",                "Visita efectuada",    False),
    ("pre-comité validado",             "Pre-comité validado", False),
    ("Descartado por comité",           "Descartado por comité", True),
    ("Aprobado",                        "Aprobado",            False),
    ("Aceptó Oferta - Pendiente firma", "Aceptó oferta",       False),
    ("Cierre - Comprado",               "Cierre",              False),
]


def _quote_list(items: list[str]) -> str:
    """SQL string list ('a','b','c')."""
    safe = [i.replace("'", "''") for i in items]
    return ", ".join(f"'{s}'" for s in safe)


# Opción centinela en el filtro de utm_campaign para los deals SIN campaña
# (utm_campaign vacío/NULL). Al filtrar se traduce a '' para matchear el vacío.
CAMPAIGN_EMPTY_LABEL = "(vacío)"


def _campaign_values(campaign: list[str]) -> list[str]:
    """Mapea el centinela '(vacío)' → '' para el IN de utm_campaign."""
    return ["" if c == CAMPAIGN_EMPTY_LABEL else c for c in campaign]


# ── Razón de venta (motivo_venta_string — texto libre, categorizado por keywords) ──
# Fuente: 1 fila por nid (dedup por última interacción). El campo es texto libre
# escrito a mano (~2k variantes), así que se agrupa en categorías por keywords para
# el share chart y el filtro; el listado de negocios muestra el texto crudo.
MOTIVO_TABLE = "sellers-main-prod.mid_funnel_ibuyer.seller_digital_co_recepcionista_mm"

# Taxonomía oficial de razón de venta (6 categorías) — label → color.
# El orden define el orden en el donut/barras; la prioridad del CASE (para resolver
# overlaps de keywords) vive en _motivo_cat_sql. 'Sin dato' se maneja aparte.
MOTIVO_CATEGORIAS = [
    {"key": "Cambio de casa",       "color": "#3b82f6"},
    {"key": "Reubicación",          "color": "#10b981"},
    {"key": "Inversión",            "color": "#7c3aed"},
    {"key": "Necesidad financiera", "color": "#ea580c"},
    {"key": "Separación",           "color": "#db2777"},
    {"key": "Otro",                 "color": "#64748b"},
]
MOTIVO_SIN = "Sin dato"  # nids sin motivo registrado en la tabla


def _motivo_cat_sql(field: str) -> str:
    """CASE que mapea motivo_venta_string (texto libre) → categoría oficial.

    El orden de los WHEN importa: necesidad financiera / separación / inversión se
    evalúan antes que reubicación / cambio de casa para evitar falsos positivos por
    overlap de keywords (ej. 'inversión en otro inmueble' → Inversión, no Cambio).
    """
    m = f"LOWER(TRIM({field}))"
    return f"""CASE
      WHEN {field} IS NULL THEN '{MOTIVO_SIN}'
      WHEN REGEXP_CONTAINS({m}, r'deuda|liqui|dinero|efectivo|plata|capital|saldar|solventar|crédito|credito|hipoteca|prestamo|préstamo|financ|gastos|salud|enferm|urgenci') THEN 'Necesidad financiera'
      WHEN REGEXP_CONTAINS({m}, r'separaci|separad|divorci|bienes|herenci|sucesi|fallec|viud|falleci') THEN 'Separación'
      WHEN REGEXP_CONTAINS({m}, r'inversi|invertir|negocio|oportunidad|reinvers|rentab|proyecto|renta') THEN 'Inversión'
      WHEN REGEXP_CONTAINS({m}, r'ciudad|viaje|traslad|me voy|me mudo|mudar|mudan|exterior|país|pais|fuera|extranjer|emigr|reubica|traslado|trabajo|estudi|campo|lejos|cerca de') THEN 'Reubicación'
      WHEN REGEXP_CONTAINS({m}, r'comprar|compra|cambi|vivienda|casa|inmueble|apartamento|apto|residencia|domicilio|grande|nuev|vivir|arrend|arriendo|alquil|hogar|propiedad') THEN 'Cambio de casa'
      ELSE 'Otro'
    END"""


def _motivo_cte() -> str:
    """CTE `motivo`: 1 fila por nid con texto crudo + categoría.

    Dedup: última interacción (fecha_interaccion, luego fecha_asignacion).
    """
    return f"""
      SELECT
        nid,
        motivo_venta_string AS motivo_venta,
        {_motivo_cat_sql('motivo_venta_string')} AS motivo_cat
      FROM `{MOTIVO_TABLE}`
      WHERE motivo_venta_string IS NOT NULL
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY nid
        ORDER BY fecha_interaccion DESC, fecha_asignacion DESC
      ) = 1
    """


# Join estándar de la CTE motivo contra funnel_diarios_col (alias f).
MOTIVO_JOIN = "LEFT JOIN motivo m ON m.nid = f.nid"


def _ctes() -> str:
    """Prefijo WITH compartido: comerciales + motivo."""
    return f"WITH comerciales AS ({_comerciales_unnest()}),\n    motivo AS ({_motivo_cte()})"


# Label para leads sin prioridad de gestión asignada (valor vacío en BQ).
SIN_PRIORIDAD_LABEL = "Sin prioridad"


def _map_prioridad(vals: list[str]) -> list[str]:
    """Mapea el label 'Sin prioridad' al valor real en BQ (''). El resto sin cambios."""
    return ["" if v == SIN_PRIORIDAD_LABEL else v for v in vals]


def _build_where(
    fecha_desde: str,
    fecha_hasta: str,
    equipos: list[str] | None = None,
    cats_com: list[str] | None = None,
    cats: list[str] | None = None,
    recurrencia: list[str] | None = None,
    fuentes: list[str] | None = None,
    areas: list[str] | None = None,
    motivo: list[str] | None = None,
    campaign: list[str] | None = None,
) -> str:
    """Construye el WHERE con los filtros activos.

    Nota: si se pasa `motivo`, la query debe incluir el CTE `motivo` (vía `_ctes()`)
    y el `MOTIVO_JOIN` para que el alias `m` exista. `campaign` (utm_campaign) requiere
    el JOIN a `hubspot.deals` (alias `d`), presente en todos los endpoints del funnel.
    """
    conds = [
        f"DATE(f.fecha) >= '{fecha_desde}'",
        f"DATE(f.fecha) <= '{fecha_hasta}'",
        f"f.valor NOT IN ({_quote_list(EXCLUDE_ETAPAS)})",
        # Excluir cuentas buffer (no son comerciales reales). Se filtra por owner ACTUAL
        # (hubspot_owner_id), igual que el resto de la atribución del funnel.
        sql_not_in("f.hubspot_owner_id", BUFFER_EMAILS),
    ]
    # Equipo viene del CSV via comerciales JOIN
    if equipos:
        conds.append(f"COALESCE(c.equipo, 'Sin equipo') IN ({_quote_list(equipos)})")
    if cats_com:
        conds.append(f"COALESCE(NULLIF(c.categoria_com, ''), 'Sin categoría') IN ({_quote_list(cats_com)})")
    if cats:
        conds.append(f"COALESCE(NULLIF(d.prioridad_gestion_market_maker, ''), f.categoria_comercial, '') IN ({_quote_list(cats)})")
    if recurrencia:
        conds.append(f"COALESCE(f.flag_recurrecia_gestion, '') IN ({_quote_list(recurrencia)})")
    if fuentes:
        conds.append(f"COALESCE(f.fuente, '') IN ({_quote_list(fuentes)})")
    if areas:
        conds.append(f"COALESCE(f.area_metropolitana, '') IN ({_quote_list(areas)})")
    if motivo:
        conds.append(f"COALESCE(m.motivo_cat, '{MOTIVO_SIN}') IN ({_quote_list(motivo)})")
    if campaign:
        conds.append(f"TRIM(COALESCE(d.utm_campaign, '')) IN ({_quote_list(_campaign_values(campaign))})")
    return "\n  AND ".join(conds)


def _group_expr(granularidad: str, field: str = "f.fecha") -> tuple[str, str]:
    """SQL expressions para agrupar por granularidad. Devuelve (group_expr, order_expr).

    `field` = columna de fecha a usar (default `f.fecha`). Para fuentes con otra fecha
    (ej. Lead usa `ig.fecha_creacion`) pasar ese campo para que los labels coincidan.

    mes_com / sem_com agrupan por ciclo comercial / semana comercial usando
    el calendario en `reports/comercial_cycles.json`.
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
        # Label con zero-pad del ciclo para que el ORDER BY string ordene cronológicamente
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


def _comerciales_unnest() -> str:
    """SQL UNNEST con los comerciales del CSV. Se usa como CTE."""
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


# ── Página principal ─────────────────────────────────────────────────────────
@router.get("", response_class=HTMLResponse)
def page(request: Request):
    today = date.today().isoformat()
    return templates.TemplateResponse("funnel_mm/page.html", {
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
    """Trae los valores disponibles para cada dimensión filtrable."""
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    excl = _quote_list(EXCLUDE_ETAPAS)
    sql = f"""
    WITH comerciales AS ({_comerciales_unnest()}),
    base AS (
      SELECT
        COALESCE(c.equipo, 'Sin equipo')                                                AS equipo,
        COALESCE(NULLIF(c.categoria_com, ''), 'Sin categoría')                           AS cat_com,
        COALESCE(NULLIF(d.prioridad_gestion_market_maker, ''), f.categoria_comercial, '') AS cat,
        COALESCE(NULLIF(d.prioridad_gestion_market_maker, ''), '')                       AS prioridad_mm,
        COALESCE(NULLIF(d.prioridad_de_gestion_inmo, ''), '')                            AS prioridad_inmo,
        COALESCE(f.flag_recurrecia_gestion, '')                                          AS recurrencia,
        COALESCE(f.fuente, '')                                                           AS fuente,
        COALESCE(f.area_metropolitana, '')                                               AS area,
        TRIM(COALESCE(d.utm_campaign, ''))                                               AS campaign,
        FORMAT_DATE('%Y-%m', DATE(f.fecha))                                              AS mes
      FROM `papyrus-data.habi_wh_bi.funnel_diarios_col` f
      LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = f.nid
      LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
      WHERE DATE(f.fecha) >= '{fecha_desde}'
        AND DATE(f.fecha) <= '{fecha_hasta}'
        AND f.valor NOT IN ({excl})
        AND {sql_not_in("f.hubspot_owner_id", BUFFER_EMAILS)}
    )
    SELECT
      ARRAY(SELECT DISTINCT equipo         FROM base WHERE equipo         != '' ORDER BY equipo)         AS equipos,
      ARRAY(SELECT DISTINCT cat_com        FROM base WHERE cat_com        != '' ORDER BY cat_com)        AS cats_com,
      ARRAY(SELECT DISTINCT cat            FROM base WHERE cat            != '' ORDER BY cat)            AS cats,
      ARRAY(SELECT DISTINCT IF(prioridad_mm = '', '{SIN_PRIORIDAD_LABEL}', prioridad_mm) FROM base ORDER BY 1) AS prioridades_mm,
      ARRAY(SELECT DISTINCT prioridad_inmo FROM base WHERE prioridad_inmo != '' ORDER BY prioridad_inmo) AS prioridades_inmo,
      ARRAY(SELECT DISTINCT recurrencia    FROM base WHERE recurrencia    != '' ORDER BY recurrencia)    AS recurrencias,
      ARRAY(SELECT DISTINCT fuente         FROM base WHERE fuente         != '' ORDER BY fuente)         AS fuentes,
      ARRAY(SELECT DISTINCT area           FROM base WHERE area           != '' ORDER BY area)           AS areas,
      ARRAY(SELECT DISTINCT campaign       FROM base WHERE campaign       != '' ORDER BY campaign)       AS campaigns,
      (SELECT COUNTIF(campaign = '') FROM base)                                                          AS n_empty_campaign,
      ARRAY(SELECT DISTINCT mes            FROM base WHERE mes            != '' ORDER BY mes DESC)       AS meses
    """
    rows = bq.query(sql)
    r = rows[0] if rows else {}
    def clean(arr):
        return sorted([x for x in (arr or []) if x and x not in ("", "Sin equipo", "Sin categoría")])
    # Opción "(vacío)" al inicio de campañas si hay deals sin utm_campaign en el scope.
    campaigns_opts = clean(r.get("campaigns"))
    if int(r.get("n_empty_campaign") or 0) > 0:
        campaigns_opts = [CAMPAIGN_EMPTY_LABEL] + campaigns_opts
    return JSONResponse({
        "equipos":         clean(r.get("equipos")),
        "cats_com":        clean(r.get("cats_com")),
        "cats":            clean(r.get("cats")),
        "prioridades_mm":  clean(r.get("prioridades_mm")),
        "prioridades_inmo":clean(r.get("prioridades_inmo")),
        "recurrencias":    clean(r.get("recurrencias")),
        "fuentes":         clean(r.get("fuentes")),
        "areas":           clean(r.get("areas")),
        "campaigns":       campaigns_opts,
        # Categorías de razón de venta (estáticas — el campo es texto libre que
        # categorizamos por keywords). 'Sin dato' al final para nids sin motivo.
        "motivos":         [c["key"] for c in MOTIVO_CATEGORIAS] + [MOTIVO_SIN],
        # Meses disponibles (YYYY-MM), desc — para la comparación de cohortes.
        "meses":           [m for m in (r.get("meses") or []) if m],
    })


# ── /volumen → JSON con la serie por etapa ───────────────────────────────────
@router.get("/volumen")
def volumen(
    request: Request,
    granularidad: Annotated[str, Query()] = "mes",  # mes | semana | dia | mes_com | sem_com
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat_com: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
    recurrencia: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
    campaign: Annotated[list[str] | None, Query()] = None,
):
    """Devuelve {labels:[...], datasets:[{label, color, data:[...]}]}."""
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    where = _build_where(fecha_desde, fecha_hasta, equipo, cat_com, cat, recurrencia, fuente, area, motivo, campaign)

    group_expr, order_expr = _group_expr(granularidad)

    sql = f"""
    {_ctes()}
    SELECT
      {group_expr} AS periodo,
      f.valor      AS etapa,
      COUNT(DISTINCT f.nid) AS nids
    FROM `papyrus-data.habi_wh_bi.funnel_diarios_col` f
    LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = f.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
    {MOTIVO_JOIN}
    WHERE {where}
    GROUP BY 1, 2
    ORDER BY {order_expr}
    """
    rows = bq.query(sql)
    # Filtrar filas sin periodo (fechas fuera de ciclos cuando mes_com/sem_com)
    rows = [r for r in rows if r["periodo"] is not None]
    # Pivot: periodo × etapa → nids
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
    cat_com: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
    recurrencia: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
    campaign: Annotated[list[str] | None, Query()] = None,
):
    """MTD del mes actual (días 1..hoy) vs mismos días mes anterior."""
    from datetime import timedelta
    hoy = date.today()
    inicio_actual = hoy.replace(day=1)
    inicio_anterior = (inicio_actual - timedelta(days=1)).replace(day=1)
    # mismo día del mes anterior
    fin_anterior = inicio_anterior + (hoy - inicio_actual)

    def make_where(start: str, end: str) -> str:
        return _build_where(start, end, equipo, cat_com, cat, recurrencia, fuente, area, motivo, campaign)

    sql = f"""
    {_ctes()}
    SELECT
      'actual' AS periodo,
      f.valor AS etapa,
      COUNT(DISTINCT f.nid) AS nids
    FROM `papyrus-data.habi_wh_bi.funnel_diarios_col` f
    LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = f.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
    {MOTIVO_JOIN}
    WHERE {make_where(inicio_actual.isoformat(), hoy.isoformat())}
    GROUP BY 1, 2
    UNION ALL
    SELECT
      'anterior' AS periodo,
      f.valor AS etapa,
      COUNT(DISTINCT f.nid) AS nids
    FROM `papyrus-data.habi_wh_bi.funnel_diarios_col` f
    LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = f.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
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

    # Etapas a destacar como KPI
    kpis_cfg = [
        {"label": "Asignaciones", "keys": ["Primer_asigancion"]},
        {"label": "Citas",        "keys": ["Cita agendada"]},
        {"label": "Visitas",      "keys": ["Visita efectuada"]},
        {"label": "Pre-comité",   "keys": ["pre-comité validado"]},
        {"label": "Aprobados",    "keys": ["Aprobado"]},
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

    return templates.TemplateResponse("funnel_mm/partials/kpis.html", {
        "request": request,
        "kpis": kpi_rows,
        "label_actual": label_actual,
        "label_anterior": label_anterior,
        "dia_corte": hoy.day,
    })


# ── /share-cat → distribución por categoría de asignados ─────────────────────
CAT_COLORS = {
    "A":              "#7c3aed",
    "B":              "#10b981",
    "C":              "#f59e0b",
    "Sin categoría":  "#94a3b8",
}


@router.get("/share-cat")
def share_cat(
    granularidad: Annotated[str, Query()] = "mes",
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat_com: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
    recurrencia: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
    prioridad_mm: Annotated[list[str] | None, Query()] = None,
    prioridad_inmo: Annotated[list[str] | None, Query()] = None,
    campaign: Annotated[list[str] | None, Query()] = None,
):
    """Distribución por categoría (A/B/C) en la etapa de Primer asignación.

    Devuelve {donut:{labels,values,total}, bars:{labels,datasets}}.
    """
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    where = _build_where(fecha_desde, fecha_hasta, equipo, cat_com, cat, recurrencia, fuente, area, motivo, campaign)
    extra = []
    if prioridad_mm:
        extra.append(f"COALESCE(d.prioridad_gestion_market_maker, '') IN ({_quote_list(_map_prioridad(prioridad_mm))})")
    if prioridad_inmo:
        extra.append(f"COALESCE(d.prioridad_de_gestion_inmo, '') IN ({_quote_list(prioridad_inmo)})")
    if extra:
        where = where + "\n  AND " + "\n  AND ".join(extra)
    group_expr, _ = _group_expr(granularidad)

    sql = f"""
    {_ctes()}
    SELECT
      {group_expr} AS periodo,
      COALESCE(NULLIF(d.prioridad_gestion_market_maker, ''), f.categoria_comercial, 'Sin categoría') AS categoria,
      COUNT(DISTINCT f.nid) AS nids
    FROM `papyrus-data.habi_wh_bi.funnel_diarios_col` f
    LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = f.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
    {MOTIVO_JOIN}
    WHERE {where}
      AND f.valor = 'Primer_asigancion'
    GROUP BY 1, 2
    ORDER BY 1, 2
    """
    rows = bq.query(sql)
    rows = [r for r in rows if r["periodo"] is not None]

    # Donut: totales por categoría
    donut: dict[str, int] = {}
    # Bars: periodo × categoría
    by_period: dict[str, dict[str, int]] = {}
    cats_seen: set[str] = set()
    periodos: set[str] = set()
    for r in rows:
        c = r["categoria"] or "Sin categoría"
        if not c:
            c = "Sin categoría"
        cats_seen.add(c)
        periodos.add(r["periodo"])
        donut[c] = donut.get(c, 0) + int(r["nids"])
        by_period.setdefault(r["periodo"], {})[c] = int(r["nids"])

    # Orden estable: A, B, C, otros, Sin categoría
    order = ["A", "B", "C"] + sorted(cats_seen - {"A","B","C","Sin categoría"}) + ["Sin categoría"]
    cats_ordered = [c for c in order if c in cats_seen]
    periodos_ordered = sorted(periodos)

    donut_labels = cats_ordered
    donut_values = [donut.get(c, 0) for c in cats_ordered]
    donut_total = sum(donut_values)
    donut_colors = [CAT_COLORS.get(c, "#94a3b8") for c in cats_ordered]

    bars_datasets = []
    for c in cats_ordered:
        bars_datasets.append({
            "label": c,
            "color": CAT_COLORS.get(c, "#94a3b8"),
            "data": [by_period.get(p, {}).get(c, 0) for p in periodos_ordered],
        })

    return JSONResponse({
        "donut": {
            "labels": donut_labels,
            "values": donut_values,
            "colors": donut_colors,
            "total": donut_total,
        },
        "bars": {
            "labels": periodos_ordered,
            "datasets": bars_datasets,
        },
    })


# ── /share-motivo → distribución por razón de venta (categorizada) ───────────
@router.get("/share-motivo")
def share_motivo(
    granularidad: Annotated[str, Query()] = "mes",
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat_com: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
    recurrencia: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
    campaign: Annotated[list[str] | None, Query()] = None,
):
    """Distribución por razón de venta (categorizada) en la Primer asignación.

    Mismo universo que /share-cat (nids en 'Primer_asigancion'), pero agrupado por
    la categoría de motivo_venta_string. Devuelve {donut, bars}.
    """
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    where = _build_where(fecha_desde, fecha_hasta, equipo, cat_com, cat, recurrencia, fuente, area, motivo, campaign)
    group_expr, _ = _group_expr(granularidad)

    sql = f"""
    {_ctes()}
    SELECT
      {group_expr} AS periodo,
      COALESCE(m.motivo_cat, '{MOTIVO_SIN}') AS categoria,
      COUNT(DISTINCT f.nid) AS nids
    FROM `papyrus-data.habi_wh_bi.funnel_diarios_col` f
    LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = f.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
    {MOTIVO_JOIN}
    WHERE {where}
      AND f.valor = 'Primer_asigancion'
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

    # Orden estable: el de MOTIVO_CATEGORIAS, luego 'Sin dato' al final.
    color_by_cat = {c["key"]: c["color"] for c in MOTIVO_CATEGORIAS}
    color_by_cat[MOTIVO_SIN] = "#cbd5e1"
    order = [c["key"] for c in MOTIVO_CATEGORIAS] + [MOTIVO_SIN]
    cats_ordered = [c for c in order if c in cats_seen]
    periodos_ordered = sorted(periodos)

    donut_values = [donut.get(c, 0) for c in cats_ordered]
    donut_colors = [color_by_cat.get(c, "#94a3b8") for c in cats_ordered]

    bars_datasets = [{
        "label": c,
        "color": color_by_cat.get(c, "#94a3b8"),
        "data": [by_period.get(p, {}).get(c, 0) for p in periodos_ordered],
    } for c in cats_ordered]

    return JSONResponse({
        "donut": {
            "labels": cats_ordered,
            "values": donut_values,
            "colors": donut_colors,
            "total": sum(donut_values),
        },
        "bars": {
            "labels": periodos_ordered,
            "datasets": bars_datasets,
        },
    })


# ── /conv-time → tasa de conversión en el tiempo ────────────────────────────
@router.get("/conv-time")
def conv_time(
    granularidad: Annotated[str, Query()] = "mes",
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    num: Annotated[list[str] | None, Query()] = None,
    den: Annotated[list[str] | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat_com: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
    recurrencia: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
    prioridad_mm: Annotated[list[str] | None, Query()] = None,
    campaign: Annotated[list[str] | None, Query()] = None,
):
    """CVR por período: nids(num) / nids(den).

    num/den son listas de etapas. Dos etapas especiales se cuentan desde
    `tabla_inmuebles_general.fecha_creacion` (fuente_id válidas), no desde
    funnel_diarios_col:
      - 'Lead'         → cuenta DISTINCT nid
      - 'Lead (filas)' → mismo universo pero cuenta FILAS de tabla_inmuebles_general
    Para ambas sólo aplican filtros de fuente y área (equipo, prioridad, categoría y
    recurrencia son atributos post-asignación que un lead aún no tiene).
    """
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    if not num:
        num = ["Cierre - Comprado"]
    if not den:
        den = ["Primer_asigancion"]

    # Dos definiciones de Lead (mismo universo, distinta unidad a contar):
    #   'Lead'         → cuenta DISTINCT nid
    #   'Lead (filas)' → cuenta FILAS de tabla_inmuebles_general (cid único por fila)
    use_lead      = "Lead" in num or "Lead" in den
    use_lead_rows = "Lead (filas)" in num or "Lead (filas)" in den
    funnel_etapas = sorted({x for x in (num + den) if x not in ("Lead", "Lead (filas)")})

    where = _build_where(fecha_desde, fecha_hasta, equipo, cat_com, cat, recurrencia, fuente, area, motivo, campaign)
    if prioridad_mm:
        where += f"\n  AND COALESCE(d.prioridad_gestion_market_maker, '') IN ({_quote_list(_map_prioridad(prioridad_mm))})"
    group_f, _ = _group_expr(granularidad)

    event_parts = []
    if funnel_etapas:
        # Para etapas del funnel el id contado es el nid.
        event_parts.append(f"""
        SELECT {group_f} AS periodo, f.valor AS etapa, CAST(f.nid AS STRING) AS cid
        FROM `papyrus-data.habi_wh_bi.funnel_diarios_col` f
        LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = f.nid
        LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
        {MOTIVO_JOIN}
        WHERE {where}
          AND f.valor IN ({_quote_list(funnel_etapas)})""")
    if use_lead or use_lead_rows:
        group_l, _ = _group_expr(granularidad, field="ig.fecha_creacion")
        # Condiciones base del universo Lead — SIN el filtro de nid (ese solo aplica a
        # la definición por nid; 'Lead (filas)' cuenta también filas con nid nulo).
        lead_conds = [
            "ig.fuente_id IN (35,20,47,39,3,7)",
            "ig.fecha_creacion IS NOT NULL",
            f"DATE(ig.fecha_creacion) >= '{fecha_desde}'",
            f"DATE(ig.fecha_creacion) <= '{fecha_hasta}'",
        ]
        if fuente:
            lead_conds.append(f"COALESCE(ig.fuente, '') IN ({_quote_list(fuente)})")
        if area:
            lead_conds.append(f"COALESCE(ig.area_metropolitana, '') IN ({_quote_list(area)})")
        # utm_campaign es del deal: semi-join a los nids con esa campaña. Los leads sin
        # deb (nid nulo o sin deal) quedan naturalmente fuera cuando hay filtro activo.
        if campaign:
            lead_conds.append(
                f"ig.nid IN (SELECT nid FROM `sellers-main-prod.hubspot.deals` "
                f"WHERE TRIM(COALESCE(utm_campaign, '')) IN ({_quote_list(_campaign_values(campaign))}))"
            )
        lead_where = ' AND '.join(lead_conds)
        if use_lead:
            # Lead por nid: agrega nid IS NOT NULL (definición oficial) y cuenta DISTINCT nid.
            event_parts.append(f"""
        SELECT {group_l} AS periodo, 'Lead' AS etapa, CAST(ig.nid AS STRING) AS cid
        FROM `papyrus-data.habi_wh_bi.tabla_inmuebles_general` ig
        WHERE {lead_where} AND ig.nid IS NOT NULL""")
        if use_lead_rows:
            # Lead por filas: TODAS las filas del universo (incluye nid nulo). cid único
            # por fila (GENERATE_UUID) para que COUNT(DISTINCT cid) = COUNT(*).
            event_parts.append(f"""
        SELECT {group_l} AS periodo, 'Lead (filas)' AS etapa, GENERATE_UUID() AS cid
        FROM `papyrus-data.habi_wh_bi.tabla_inmuebles_general` ig
        WHERE {lead_where}""")

    events_sql = "\n        UNION ALL\n".join(event_parts)

    sql = f"""
    {_ctes()},
    events AS ({events_sql})
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
    nums   = [int(r["num"]) for r in rows]
    dens   = [int(r["den"]) for r in rows]
    cvrs   = [(n/d*100) if d > 0 else None for n, d in zip(nums, dens)]
    total_n = sum(nums)
    total_d = sum(dens)
    return JSONResponse({
        "labels": labels,
        "num": nums,
        "den": dens,
        "cvr": cvrs,
        "total_num": total_n,
        "total_den": total_d,
        "total_cvr": (total_n/total_d*100) if total_d > 0 else None,
        "num_etapas": num,
        "den_etapas": den,
    })


# ── /etapas → lista de etapas disponibles para num/den ──────────────────────
@router.get("/etapas")
def etapas():
    """Devuelve la lista de etapas MM con sus labels (para los selects num/den).

    Incluye 'Lead' (upstream, dateado por fecha_creacion de tabla_inmuebles_general),
    que conv_time resuelve aparte (no es una etapa de funnel_diarios_col).
    """
    items = [
        {"key": "Lead",         "label": "Lead (nid)"},
        {"key": "Lead (filas)", "label": "Lead (filas tabla)"},
    ]
    items += [{"key": e["key"], "label": e["label"]} for e in ETAPAS_MM]
    return JSONResponse(items)


# ── /cosechas → análisis de cohortes ────────────────────────────────────────
@router.get("/cosechas")
def cosechas(
    origen: Annotated[str, Query()] = "Primer_asigancion",
    destino: Annotated[str, Query()] = "Cita agendada",
    granularidad: Annotated[str, Query()] = "semana",  # semana | mes
    bucket: Annotated[str, Query()] = "iso",            # iso | dias
    conteo: Annotated[str, Query()] = "cohorte",        # cohorte | funnel
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat_com: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
    recurrencia: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
    campaign: Annotated[list[str] | None, Query()] = None,
):
    """Cosechas: matriz cohorte × offset.

    Para cada nid que entra a la etapa `origen` en una cohorte (semana/mes),
    medimos en qué offset (0, 1, 2, ... semanas/meses) llegó a la etapa
    `destino`. Devuelve la matriz lista para renderizar como heatmap.

    bucket:
      - 'iso':  offset = semanas/meses calendario cruzados (ISO).
                S0 = misma semana ISO que origen.
      - 'dias': offset = bloques de 7 (o 30) días corridos desde origen.
                S0 = días 0-6 desde origen exacto.

    conteo:
      - 'cohorte' (default): cada nid pertenece a UNA sola cohorte = la semana/mes
                de su PRIMER evento origen dentro del rango. Métrica de conversión limpia.
      - 'funnel': cada nid puede aparecer en VARIAS cohortes (una por cada semana/mes
                donde tuvo evento origen). El total por cohorte iguala lo que muestra
                la barra del tablero `/volumen` (COUNT DISTINCT nid). Incluye re-eventos.

    Filtros aplican a la etapa origen (universo del cohorte).
    """
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    unit = "WEEK(MONDAY)" if granularidad == "semana" else "MONTH"
    fmt  = "'%Y-%m-%d'" if granularidad == "semana" else "'%Y-%m'"
    # Expresión del offset según bucket mode
    if bucket == "dias":
        # Rolling buckets de 7 o 30 días desde la fecha origen exacta
        days_per_bucket = 7 if granularidad == "semana" else 30
        offset_expr = f"DIV(DATE_DIFF(d.fecha_destino, o.fecha_origen, DAY), {days_per_bucket})"
    else:
        # ISO: cuántos límites de semana/mes calendario se cruzan
        diff_unit = "WEEK" if granularidad == "semana" else "MONTH"
        offset_expr = f"DATE_DIFF(d.fecha_destino, o.fecha_origen, {diff_unit})"

    where_origen = _build_where(fecha_desde, fecha_hasta, equipo, cat_com, cat, recurrencia, fuente, area, motivo, campaign)

    # Modo 'funnel': agrupar por (nid, semana/mes del evento) — un nid puede caer en
    # varias cohortes si tuvo el evento en distintos períodos. Matchea /volumen.
    # Modo 'cohorte' (default): MIN(fecha) por nid → nid pertenece a UNA cohorte.
    if conteo == "funnel":
        origen_cte = f"""
        origen AS (
          SELECT
            f.nid,
            DATE_TRUNC(DATE(f.fecha), {unit}) AS cohorte_date,
            MIN(DATE(f.fecha)) AS fecha_origen
          FROM `papyrus-data.habi_wh_bi.funnel_diarios_col` f
          LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = f.nid
          LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
          {MOTIVO_JOIN}
          WHERE {where_origen}
            AND f.valor = '{origen.replace("'", "''")}'
          GROUP BY 1, 2
        )"""
        cohorte_expr = f"FORMAT_DATE({fmt}, o.cohorte_date)"
    else:
        origen_cte = f"""
        origen AS (
          SELECT f.nid, MIN(DATE(f.fecha)) AS fecha_origen
          FROM `papyrus-data.habi_wh_bi.funnel_diarios_col` f
          LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = f.nid
          LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
          {MOTIVO_JOIN}
          WHERE {where_origen}
            AND f.valor = '{origen.replace("'", "''")}'
          GROUP BY f.nid
        )"""
        cohorte_expr = f"FORMAT_DATE({fmt}, DATE_TRUNC(o.fecha_origen, {unit}))"

    sql = f"""
    {_ctes()},
    {origen_cte},
    destino AS (
      SELECT nid, MIN(DATE(fecha)) AS fecha_destino
      FROM `papyrus-data.habi_wh_bi.funnel_diarios_col`
      WHERE valor = '{destino.replace("'", "''")}'
      GROUP BY nid
    ),
    joined AS (
      SELECT
        {cohorte_expr} AS cohorte,
        {offset_expr} AS offset_unit
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

    # Reconstruir matriz en Python
    cohortes: dict[str, dict[int | None, int]] = {}
    for r in rows:
        c = r["cohorte"]
        off = r["offset_unit"]  # int o None (no llegó al destino)
        cohortes.setdefault(c, {})[off] = int(r["n"])

    # Totales y matriz [{cohorte, total, alcanzaron, by_offset:[%...]}]
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
        # Conteo por offset (0..max_offset). Si None: no alcanzaron, va aparte.
        by_offset_counts = [buckets.get(o, 0) for o in range(max_offset + 1)]
        no_reached = buckets.get(None, 0)
        alcanzaron = total - no_reached
        # % sobre cohorte total
        by_offset_pct = [(c_ / total * 100) if total > 0 else 0 for c_ in by_offset_counts]
        # Share 100%: % sobre los que alcanzaron destino (cada fila suma 100%)
        by_offset_share = [(c_ / alcanzaron * 100) if alcanzaron > 0 else 0 for c_ in by_offset_counts]
        # Acumulativos
        cum_counts = []
        cum = 0
        for c_ in by_offset_counts:
            cum += c_
            cum_counts.append(cum)
        cum_pct = [(c_ / total * 100) if total > 0 else 0 for c_ in cum_counts]
        cum_share = [(c_ / alcanzaron * 100) if alcanzaron > 0 else 0 for c_ in cum_counts]
        matrix.append({
            "cohorte": c,
            "total": total,
            "alcanzaron": alcanzaron,
            "no_alcanzaron": no_reached,
            "counts": by_offset_counts,
            "pct": by_offset_pct,
            "share": by_offset_share,
            "cum_counts": cum_counts,
            "cum_pct": cum_pct,
            "cum_share": cum_share,
        })

    # Etiquetas de columnas: S0, S1, ... (o M0, M1, ...)
    prefix = "S" if granularidad == "semana" else "M"
    offset_labels = [f"{prefix}{i}" for i in range(max_offset + 1)]
    # En modo días, ranges: 0-6d, 7-13d, etc. (o 0-29d, 30-59d, ... en mes)
    if bucket == "dias":
        step = 7 if granularidad == "semana" else 30
        offset_ranges = [f"{i*step}-{(i+1)*step-1}d" for i in range(max_offset + 1)]
    else:
        offset_ranges = None

    return JSONResponse({
        "origen": origen,
        "destino": destino,
        "granularidad": granularidad,
        "bucket": bucket,
        "conteo": conteo,
        "offset_labels": offset_labels,
        "offset_ranges": offset_ranges,
        "rows": matrix,
    })


# ── /funnel-compare → funnel cohortado (para comparar A vs B) ────────────────
@router.get("/funnel-compare")
def funnel_compare(
    mes: Annotated[str | None, Query()] = None,   # 'YYYY-MM' — cohorte = 1ra asignación ese mes
    equipo: Annotated[list[str] | None, Query()] = None,
    cat_com: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
    recurrencia: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
):
    """Funnel cohortado (misma semántica que /cosechas, conteo=cohorte): un nid
    pertenece al mes de su PRIMERA asignación; una etapa se "alcanza" solo si su
    fecha es ≥ la de asignación. Devuelve etapas con nids, % sobre asignación y
    % vs etapa de progresión previa.
    """
    label = mes if mes else "Todo"
    where_asig = _build_where(FECHA_INICIO, date.today().isoformat(),
                              equipos=equipo, cats_com=cat_com, cats=cat,
                              recurrencia=recurrencia, fuentes=fuente, areas=area, motivo=motivo)
    cohort_where = f"AND FORMAT_DATE('%Y-%m', fecha_origen) = '{mes}'" if mes else ""
    stage_keys = [k for k, _, _ in FUNNEL_COMPARE_STAGES]

    sql = f"""
    {_ctes()},
    asig AS (
      SELECT f.nid, MIN(DATE(f.fecha)) AS fecha_origen
      FROM `papyrus-data.habi_wh_bi.funnel_diarios_col` f
      LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = f.nid
      LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
      {MOTIVO_JOIN}
      WHERE {where_asig}
        AND f.valor = 'Primer_asigancion'
      GROUP BY f.nid
    ),
    cohort AS (
      SELECT nid, fecha_origen FROM asig WHERE TRUE {cohort_where}
    ),
    stage_min AS (
      SELECT f.nid, f.valor AS etapa, MIN(DATE(f.fecha)) AS fecha_etapa
      FROM `papyrus-data.habi_wh_bi.funnel_diarios_col` f
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

    first = by_etapa.get("Primer_asigancion", 0)
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
        if not excl:
            prev_n = n

    return JSONResponse({"mes": label, "total": first, "stages": stages})


# ── /negocios → tabla cohort (1 row per nid) paginada ───────────────────────
TABLE_ETAPAS_FIELDS = [
    ("fecha_asignacion", "F. asignación", "Primer_asigancion"),
    ("fecha_cita",       "F. cita",       "Cita agendada"),
    ("fecha_visita",     "F. visita",     "Visita efectuada"),
    ("fecha_precomite",  "F. pre-comité", "pre-comité validado"),
    ("fecha_aprobado",   "F. aprobado",   "Aprobado"),
    ("fecha_acepto",     "F. aceptó",     "Aceptó Oferta - Pendiente firma"),
    ("fecha_cierre",     "F. cierre",     "Cierre - Comprado"),
]


@router.get("/negocios")
def negocios(
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat_com: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
    recurrencia: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
    campaign: Annotated[list[str] | None, Query()] = None,
    etapa: Annotated[str | None, Query()] = None,   # fecha_cierre, fecha_visita, etc.
    search: Annotated[str | None, Query()] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 50,
):
    """Devuelve nids paginados con la cronología de etapas que pasaron.

    Filtros:
      - etapa: si se da, solo nids que llegaron a esa etapa, filtrando por la fecha de esa etapa.
      - search: substring match en nid.
      - rango fechas filtra contra la fecha de la etapa seleccionada (o asignación por default).
    """
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    where = _build_where(fecha_desde="2020-01-01", fecha_hasta=date.today().isoformat(),
                         equipos=equipo, cats_com=cat_com, cats=cat,
                         recurrencia=recurrencia, fuentes=fuente, areas=area, motivo=motivo,
                         campaign=campaign)
    # En este endpoint no filtramos por fecha en el WHERE del SQL — la fecha
    # se aplica luego sobre la columna de etapa elegida (HAVING).
    # Pero _build_where ya pone DATE(f.fecha) >= y <=. Lo "neutralizamos" usando rango amplio.

    date_field = etapa if etapa in {f for f,_,_ in TABLE_ETAPAS_FIELDS} else "fecha_asignacion"

    select_etapas = ",\n      ".join([
        f"MIN(CASE WHEN f.valor = '{bq_etapa}' THEN CAST(f.fecha AS STRING) END) AS {field}"
        if bq_etapa != "Aprobado"
        else f"MIN(CASE WHEN f.valor IN ('Aprobado', 'inmueble aprobado') THEN CAST(f.fecha AS STRING) END) AS {field}"
        for field, _, bq_etapa in TABLE_ETAPAS_FIELDS
    ])

    search_clause = ""
    if search:
        safe = search.replace("'", "''")
        search_clause = f"AND CAST(f.nid AS STRING) LIKE '%{safe}%'"

    # Filtrar por etapa alcanzada + rango de fechas de esa etapa
    having_clauses = [f"{date_field} IS NOT NULL"]
    if fecha_desde:
        having_clauses.append(f"SUBSTR({date_field}, 1, 10) >= '{fecha_desde}'")
    if fecha_hasta:
        having_clauses.append(f"SUBSTR({date_field}, 1, 10) <= '{fecha_hasta}'")
    having_sql = " AND ".join(having_clauses)

    base_sql = f"""
    {_ctes()},
    cohort AS (
      SELECT
        CAST(f.nid AS STRING) AS nid,
        ANY_VALUE(COALESCE(c.equipo, 'Sin equipo'))                                                 AS equipo,
        ANY_VALUE(COALESCE(NULLIF(c.categoria_com, ''), 'Sin categoría'))                            AS categoria_comercial,
        ANY_VALUE(COALESCE(NULLIF(d.prioridad_gestion_market_maker, ''), f.categoria_comercial, '')) AS categoria,
        ANY_VALUE(COALESCE(f.fuente, ''))                                                            AS fuente,
        ANY_VALUE(COALESCE(f.area_metropolitana, ''))                                                AS area_metropolitana,
        ANY_VALUE(m.motivo_venta)                                                                    AS motivo_venta,
        ANY_VALUE(m.motivo_cat)                                                                      AS motivo_cat,
        {select_etapas}
      FROM `papyrus-data.habi_wh_bi.funnel_diarios_col` f
      LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = f.nid
      LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
      {MOTIVO_JOIN}
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

    # Para conocer el total exacto (count), una query separada:
    count_sql = f"""
    {_ctes()},
    cohort AS (
      SELECT
        CAST(f.nid AS STRING) AS nid,
        {select_etapas}
      FROM `papyrus-data.habi_wh_bi.funnel_diarios_col` f
      LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = f.nid
      LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
      {MOTIVO_JOIN}
      WHERE {where}
        {search_clause}
      GROUP BY 1
      HAVING {having_sql}
    )
    SELECT COUNT(*) AS total FROM cohort
    """
    total = int(bq.query(count_sql)[0]["total"])

    # Recortar fechas a YYYY-MM-DD
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


# ── /metas/config → ciclos + etapas (lo estático) ────────────────────────────
@router.get("/metas/config")
def metas_config():
    """Lista de ciclos + metas parseadas + etiquetas para el frontend."""
    cycles = bq.load_cycles()
    return JSONResponse({
        "cycles": cycles,
        "etapas": metas_mm.ETAPAS_ORDER,
        "zona_to_equipo": metas_mm.ZONA_TO_EQUIPO,
        "metas": metas_mm.load_metas(),
    })


# ── /metas/real → reales agrupados por (etapa, semana, bucket) ───────────────
def _bucket_expr(desglose: str) -> str:
    """Devuelve la expresión SQL que produce el 'bucket' (Total | zona | cat)."""
    if desglose == "equipo":
        # Mapeo de equipo (comerciales.csv) → zona del CSV de metas.
        # Lo que no mapea queda como 'Sin equipo' (no NULL) para no desaparecer
        # del tablero — el frontend lo muestra como bucket aparte.
        mapping = " ".join([
            f"WHEN COALESCE(c.equipo, 'Sin equipo') = '{eq}' THEN '{zona}'"
            for zona, eq in metas_mm.ZONA_TO_EQUIPO.items()
        ])
        return f"CASE {mapping} ELSE 'Sin equipo' END"
    if desglose == "categoria":
        return ("CASE COALESCE(NULLIF(d.prioridad_gestion_market_maker, ''), "
                "f.categoria_comercial, '') "
                "WHEN 'A' THEN 'A' WHEN 'B' THEN 'B' WHEN 'C' THEN 'C' ELSE NULL END")
    return "'Total'"


@router.get("/metas/real")
def metas_real(
    ciclo: Annotated[int, Query()] = 0,
    desglose: Annotated[str, Query()] = "total",   # total | equipo | categoria
    equipo: Annotated[list[str] | None, Query()] = None,
    cat_com: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
    recurrencia: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
    campaign: Annotated[list[str] | None, Query()] = None,
    asume_area: Annotated[bool, Query()] = False,
):
    """Reales del ciclo agrupados por (etapa, semana, bucket).

    Devuelve: { "weeks": [...], "data": { etapa: { bucket: { week: int } } } }
    """
    cycles = bq.load_cycles()
    ciclo_def = next((c for c in cycles if c["ciclo"] == ciclo), None)
    if not ciclo_def:
        return JSONResponse({"weeks": [], "data": {}})

    semanas = ciclo_def["semanas"]
    fecha_desde = semanas[0]["inicio"]
    fecha_hasta = semanas[-1]["fin"]
    where = _build_where(fecha_desde, fecha_hasta, equipo, cat_com, cat,
                         recurrencia, fuente, area, motivo, campaign)

    # Fechas de semana → CASE para asignar 'wk'
    week_cases = " ".join([
        f"WHEN DATE(f.fecha) BETWEEN '{s['inicio']}' AND '{s['fin']}' THEN {s['num']}"
        for s in semanas
    ])

    bucket_expr = _bucket_expr(desglose)

    # Si asume_area=True y desglose=equipo, fallback a area_metropolitana
    # cuando el comercial no está mapeado. Si tampoco mapea por área, queda
    # como 'Sin equipo' (no NULL — no queremos perder leads del conteo).
    if asume_area and desglose == "equipo":
        equipo_case = " ".join([
            f"WHEN COALESCE(c.equipo, 'Sin equipo') = '{eq}' THEN '{zona}'"
            for zona, eq in metas_mm.ZONA_TO_EQUIPO.items()
        ])
        area_mapping = (
            "WHEN COALESCE(f.area_metropolitana,'') = 'Bogotá' THEN 'Norte' "
            "WHEN COALESCE(f.area_metropolitana,'') = 'Medellín' THEN 'Medellin' "
            "WHEN COALESCE(f.area_metropolitana,'') = 'Cali' THEN 'Cali' "
            "WHEN COALESCE(f.area_metropolitana,'') = 'Barranquilla' THEN 'Barranquilla'"
        )
        bucket_expr = (
            f"COALESCE("
            f"(CASE {equipo_case} ELSE NULL END), "
            f"(CASE {area_mapping} ELSE NULL END), "
            f"'Sin equipo'"
            f")"
        )

    # Lista de etapas BQ a incluir — solo lo que está en META_ETAPA_TO_BQ.
    # NO incluimos 'inmueble aprobado' (la meta usa solo 'Aprobado').
    todas_etapas_bq: list[str] = []
    for et in metas_mm.ETAPAS_ORDER:
        todas_etapas_bq.extend(metas_mm.META_ETAPA_TO_BQ[et])

    # Conteo por EVENTOS (cada fila = 1 evento, equivalente al legacy):
    # un nid con 2 filas en la misma semana cuenta 2.
    sql = f"""
    {_ctes()}
    SELECT
      f.valor AS etapa_bq,
      (CASE {week_cases} ELSE NULL END) AS wk,
      ({bucket_expr}) AS bucket,
      COUNT(*) AS nids
    FROM `papyrus-data.habi_wh_bi.funnel_diarios_col` f
    LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = f.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
    {MOTIVO_JOIN}
    WHERE {where}
      AND f.valor IN ({_quote_list(todas_etapas_bq)})
    GROUP BY 1, 2, 3
    """
    rows = bq.query(sql)

    # Mapear etapa_bq → etapa lógica (Asignados, Agendas, ...)
    bq_to_etapa: dict[str, str] = {}
    for et, bqs in metas_mm.META_ETAPA_TO_BQ.items():
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


# ── /metas/kpi-tendencias → series para los KPI cards ────────────────────────
@router.get("/metas/kpi-tendencias")
def metas_kpi_tendencias(
    ciclo: Annotated[int, Query()] = 0,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat_com: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
    recurrencia: Annotated[list[str] | None, Query()] = None,
    fuente: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
    campaign: Annotated[list[str] | None, Query()] = None,
):
    """Para cada etapa devuelve serie de N semanas (8) con meta y real.

    Útil para sparklines + valor MTD-ciclo del actual vs meta acumulada.
    """
    cycles = bq.load_cycles()
    ciclo_def = next((c for c in cycles if c["ciclo"] == ciclo), None)
    if not ciclo_def:
        return JSONResponse({"series": {}})

    # Flat list de (ciclo, week, inicio, fin)
    flat: list[dict] = []
    for c in cycles:
        for s in c["semanas"]:
            flat.append({
                "ciclo": c["ciclo"],
                "week": s["num"],
                "inicio": s["inicio"],
                "fin": s["fin"],
            })

    # Index del último ítem del ciclo seleccionado
    last_in_ciclo = max(
        (i for i, x in enumerate(flat) if x["ciclo"] == ciclo),
        default=-1,
    )
    if last_in_ciclo < 0:
        return JSONResponse({"series": {}})

    # Tomamos los últimos 8 (incluyendo el ciclo actual) - pero solo hasta hoy
    today = date.today().isoformat()
    n_back = 8
    start_idx = max(0, last_in_ciclo - n_back + 1)
    series_flat = flat[start_idx:last_in_ciclo + 1]

    # Query rango total
    fecha_desde = series_flat[0]["inicio"]
    fecha_hasta = series_flat[-1]["fin"]
    where = _build_where(fecha_desde, fecha_hasta, equipo, cat_com, cat,
                         recurrencia, fuente, area, motivo, campaign)

    week_cases = " ".join([
        f"WHEN DATE(f.fecha) BETWEEN '{s['inicio']}' AND '{s['fin']}' THEN '{s['ciclo']}-{s['week']}'"
        for s in series_flat
    ])

    todas_etapas_bq: list[str] = []
    for et in metas_mm.ETAPAS_ORDER:
        todas_etapas_bq.extend(metas_mm.META_ETAPA_TO_BQ[et])

    sql = f"""
    {_ctes()}
    SELECT
      f.valor AS etapa_bq,
      (CASE {week_cases} ELSE NULL END) AS wkey,
      COUNT(*) AS nids
    FROM `papyrus-data.habi_wh_bi.funnel_diarios_col` f
    LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = f.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
    {MOTIVO_JOIN}
    WHERE {where}
      AND f.valor IN ({_quote_list(todas_etapas_bq)})
    GROUP BY 1, 2
    """
    rows = bq.query(sql)

    bq_to_etapa: dict[str, str] = {}
    for et, bqs in metas_mm.META_ETAPA_TO_BQ.items():
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

    metas = metas_mm.load_metas()
    series: dict[str, dict] = {}
    for et in metas_mm.ETAPAS_ORDER:
        labels: list[str] = []
        metas_arr: list[int | None] = []
        reales_arr: list[int | None] = []
        for s in series_flat:
            wkey = f"{s['ciclo']}-{s['week']}"
            labels.append(wkey)
            m = metas.get(et, {}).get("Total", {}).get(wkey)
            metas_arr.append(m)
            futura = s["inicio"] > today
            r = real.get(et, {}).get(wkey)
            reales_arr.append(None if futura else (r or 0))

        # Totales del ciclo (solo el ciclo seleccionado)
        meta_ciclo = sum(
            (metas.get(et, {}).get("Total", {}).get(f"{ciclo}-{s['num']}") or 0)
            for s in ciclo_def["semanas"]
        )
        real_ciclo = sum(
            (real.get(et, {}).get(f"{ciclo}-{s['num']}") or 0)
            for s in ciclo_def["semanas"]
            if s["inicio"] <= today
        )
        # Cumplimiento "fair": real vs meta de las semanas ya transcurridas
        meta_ciclo_mtd = sum(
            (metas.get(et, {}).get("Total", {}).get(f"{ciclo}-{s['num']}") or 0)
            for s in ciclo_def["semanas"]
            if s["inicio"] <= today
        )
        cumplimiento = (real_ciclo / meta_ciclo_mtd * 100) if meta_ciclo_mtd > 0 else None

        series[et] = {
            "labels": labels,
            "metas": metas_arr,
            "reales": reales_arr,
            "meta_ciclo": meta_ciclo,
            "meta_ciclo_mtd": meta_ciclo_mtd,
            "real_ciclo": real_ciclo,
            "cumplimiento": cumplimiento,
        }

    return JSONResponse({
        "ciclo": ciclo,
        "ciclo_label": f"Ciclo {ciclo} · {ciclo_def['mes']} {ciclo_def['year']}",
        "series": series,
        "etapas": metas_mm.ETAPAS_ORDER,
    })
