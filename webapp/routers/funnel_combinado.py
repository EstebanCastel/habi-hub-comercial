"""Router del Funnel Combinado MM + Inmo.

Una sola vista que cruza el funnel ibuyer (MM) y el pipeline inmobiliario (Inmo)
para responder preguntas tipo "CVR asignado (MM+Inmo) → transacción (cierre+capta)".

Endpoints:
  GET /            → página principal
  GET /filters     → equipos y áreas (unión de ambos productos)
  GET /etapas      → opciones agrupadas (Combinados / MM / Inmo) para los selects
  GET /conv-time   → JSON CVR por período (num/den son lists de keys unificadas)

Keys unificadas:
  - mm:<key>      etapas MM individuales      (mm:asignacion, mm:cierre, ...)
  - inmo:<key>    etapas Inmo individuales    (inmo:asignados, inmo:captado, ...)
  - combo:<key>   presets agregados           (combo:transacciones, combo:asignados, ...)
                  el backend los expande a una lista de keys reales antes del SQL.
"""
from __future__ import annotations

import logging
from datetime import date
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates

from webapp import bq, metas_inmo
from webapp.accounts import BUFFER_EMAILS, sql_not_in
from webapp.routers.funnel_inmo import (
    PIPELINE_LIST,
    STAGE_ID_PERFILADO,
    STAGE_ID_COMITE,
    STAGE_ID_APROBADO,
    STAGE_ID_OFERTADO,
    STAGE_ID_ACEPTADA,
    STAGE_ID_CAPTADO,
)
from webapp.routers.funnel_mm import EXCLUDE_ETAPAS, _motivo_cte, MOTIVO_CATEGORIAS, MOTIVO_SIN

log = logging.getLogger(__name__)
router = APIRouter()
templates = Jinja2Templates(directory=Path(__file__).parent.parent / "templates")

FECHA_INICIO = "2026-01-01"

# BNPL: campo de hubspot.deals (solo CO). Valores reales: 'Sí' / 'No' (+ vacío).
BNPL_FIELD = "negocio_aplica_para_bnpl_"
BNPL_SIN = "Sin dato"
BNPL_OPCIONES = ["Sí", "No"]

# ── Etapas upstream (pre-asignación, comunes a ambos productos) ─────────────
# Fuente: papyrus-data.habi_wh_bi.tabla_inmuebles_general (1 fila por nid)
# Filtros de calidad replicados de webapp/sql/asignados_oficial_col.sql
UPSTREAM_ETAPAS = [
    {"key": "lead",       "label": "Lead (fecha_creacion)",        "fecha_col": "fecha_creacion"},
    {"key": "calificado", "label": "Calificado (fecha_a_pricing)", "fecha_col": "fecha_a_pricing"},
]
UPSTREAM_KEYS = {e["key"] for e in UPSTREAM_ETAPAS}

# ── Etapas individuales y mapeo a valores de BQ ─────────────────────────────
MM_ETAPAS = [
    {"key": "mm:asignacion", "label": "MM · Asignación",      "bq_values": ["Primer_asigancion"]},
    {"key": "mm:cita",       "label": "MM · Cita",            "bq_values": ["Cita agendada"]},
    {"key": "mm:visita",     "label": "MM · Visita",          "bq_values": ["Visita efectuada"]},
    {"key": "mm:pre_comite", "label": "MM · Pre-comité",      "bq_values": ["pre-comité validado"]},
    {"key": "mm:aprobado",   "label": "MM · Aprobado",        "bq_values": ["Aprobado", "inmueble aprobado"]},
    {"key": "mm:acepto",     "label": "MM · Aceptó oferta",   "bq_values": ["Aceptó Oferta - Pendiente firma"]},
    {"key": "mm:cierre",     "label": "MM · Cierre",          "bq_values": ["Cierre - Comprado"]},
]

INMO_ETAPAS = [
    {"key": "inmo:asignados",       "label": "Inmo · Asignados"},
    {"key": "inmo:perfilados",      "label": "Inmo · Perfilados"},
    {"key": "inmo:comite",          "label": "Inmo · Comité"},
    {"key": "inmo:aprobado",        "label": "Inmo · Aprobado"},
    {"key": "inmo:ofertado",        "label": "Inmo · Ofertado"},
    {"key": "inmo:oferta_aceptada", "label": "Inmo · Oferta aceptada"},
    {"key": "inmo:captado",         "label": "Inmo · Captado"},
]

# ── Presets combinados (se expanden a etapas reales antes del SQL) ──────────
COMBOS: dict[str, dict] = {
    "combo:asignados":         {"label": "Asignados (MM + Inmo)",      "expand": ["mm:asignacion", "inmo:asignados"]},
    "combo:visitas_perfilados":{"label": "Visitas + Perfilados",       "expand": ["mm:visita", "inmo:perfilados"]},
    "combo:aprobados":         {"label": "Aprobados (MM + Inmo)",      "expand": ["mm:aprobado", "inmo:aprobado"]},
    "combo:aceptados":         {"label": "Aceptó + Oferta aceptada",   "expand": ["mm:acepto", "inmo:oferta_aceptada"]},
    "combo:transacciones":     {"label": "Transacciones (Cierre + Capta)", "expand": ["mm:cierre", "inmo:captado"]},
}

# Secuencia ordenada del funnel combinado (vista funnel / comparación cohortes).
COMBO_FUNNEL = ["combo:asignados", "combo:visitas_perfilados", "combo:aprobados", "combo:aceptados", "combo:transacciones"]

# Default num/den
DEFAULT_NUM = "combo:transacciones"
DEFAULT_DEN = "combo:asignados"


def _quote_list(items: list[str]) -> str:
    safe = [i.replace("'", "''") for i in items]
    return ", ".join(f"'{s}'" for s in safe)


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


def _expand_keys(keys: list[str]) -> list[str]:
    """Expande combo:* a las etapas reales. Mantiene mm:* / inmo:* / upstream tal cual."""
    out: list[str] = []
    for k in keys:
        if k in COMBOS:
            out.extend(COMBOS[k]["expand"])
        elif k.startswith("mm:") or k.startswith("inmo:") or k in UPSTREAM_KEYS:
            out.append(k)
        # Silently ignore claves desconocidas
    # Unique preservando orden
    seen = set()
    return [k for k in out if not (k in seen or seen.add(k))]


def _mm_bq_values_for_keys(keys: list[str]) -> list[str]:
    """Para una lista de claves mm:*, devuelve los valores BQ correspondientes."""
    by_key = {e["key"]: e["bq_values"] for e in MM_ETAPAS}
    vals: list[str] = []
    for k in keys:
        vals.extend(by_key.get(k, []))
    return vals


def _group_expr(granularidad: str, col: str = "e.fecha") -> str:
    """Expresión SQL para agrupar el campo `col` (DATE) según granularidad."""
    if granularidad == "dia":
        return f"FORMAT_DATE('%Y-%m-%d', DATE({col}))"
    if granularidad == "semana":
        return f"FORMAT_DATE('%Y-%m-%d', DATE_TRUNC(DATE({col}), WEEK(MONDAY)))"
    if granularidad == "mes_com":
        cycles = bq.load_cycles()
        whens = []
        for c in cycles:
            mes_short = c["mes"][:3].capitalize()
            label = f"C{c['ciclo']:02d} · {mes_short} {str(c['year'])[2:]}"
            whens.append(f"WHEN DATE({col}) BETWEEN '{c['inicio']}' AND '{c['fin']}' THEN '{label}'")
        return f"CASE {' '.join(whens)} ELSE NULL END"
    if granularidad == "sem_com":
        cycles = bq.load_cycles()
        whens = []
        for c in cycles:
            for s in c["semanas"]:
                label = f"C{c['ciclo']:02d}-S{s['num']:02d}"
                whens.append(f"WHEN DATE({col}) BETWEEN '{s['inicio']}' AND '{s['fin']}' THEN '{label}'")
        return f"CASE {' '.join(whens)} ELSE NULL END"
    return f"FORMAT_DATE('%Y-%m', DATE({col}))"


def _upstream_cte(fecha_desde: str, fecha_hasta: str, needed_upstream: list[str]) -> str:
    """CTE upstream_events: lead / calificado desde tabla_inmuebles_general.

    Filtros por etapa:
      Lead       = nid IS NOT NULL, fuente_id IN (35,20,47,39,3,7), fecha_creacion IS NOT NULL
      Calificado = nid IS NOT NULL, fuente_id IN (35,20,47,39,3,7), check_a_pricing=1, fecha_a_pricing IS NOT NULL

    Notas:
      - Lead NO aplica check_a_pricing ni calificacion_del_lead_v2 (es el universo más amplio).
      - Calificado SÍ aplica check_a_pricing=1 (es semánticamente coherente con la etapa).
      - Asignados aplica filtros estrictos completos (ver asignados_oficial_col.sql).
    """
    if not needed_upstream:
        return """
        upstream_events AS (
          SELECT CAST(NULL AS STRING) AS nid, DATE('1900-01-01') AS fecha,
                 CAST(NULL AS STRING) AS etapa, CAST(NULL AS STRING) AS source,
                 '' AS equipo, '' AS area
          LIMIT 0
        )"""
    quality_base = """
          ig.nid IS NOT NULL
          AND ig.fuente_id IN (35,20,47,39,3,7)"""
    # Filtro extra por etapa
    extra_quality = {
        "lead": "",
        "calificado": "\n          AND ig.check_a_pricing = 1",
    }
    unions = []
    for et in UPSTREAM_ETAPAS:
        if et["key"] not in needed_upstream:
            continue
        col = et["fecha_col"]
        extra = extra_quality.get(et["key"], "")
        unions.append(f"""
          SELECT
            CAST(ig.nid AS STRING) AS nid,
            DATE(ig.{col}) AS fecha,
            '{et['key']}' AS etapa,
            'lead' AS source,
            COALESCE(ig.equipo_sellers, '') AS equipo,
            COALESCE(ig.area_metropolitana, '') AS area
          FROM `papyrus-data.habi_wh_bi.tabla_inmuebles_general` ig
          WHERE {quality_base}{extra}
            AND ig.{col} IS NOT NULL
            AND DATE(ig.{col}) >= '{fecha_desde}'
            AND DATE(ig.{col}) <= '{fecha_hasta}'
        """)
    return f"""
        upstream_events AS ({' UNION ALL '.join(unions)})"""


def _events_ctes(
    fecha_desde: str,
    fecha_hasta: str,
    needed_mm: list[str],
    needed_inmo: list[str],
    needed_upstream: list[str] | None = None,
    exclude_incidente: bool = True,
) -> str:
    """Construye las CTEs upstream_events / mm_events / inmo_events con schema unificado.

    Schema: (nid STRING, fecha DATE, etapa STRING, source STRING, equipo STRING, area STRING)
    """
    needed_upstream = needed_upstream or []
    # ── MM ──
    mm_values = _mm_bq_values_for_keys(needed_mm)
    if mm_values:
        # Mapeo CASE de valor BQ → key unificada
        case_lines = []
        for et in MM_ETAPAS:
            if et["key"] in needed_mm:
                for v in et["bq_values"]:
                    case_lines.append(f"WHEN f.valor = '{v.replace(chr(39), chr(39)*2)}' THEN '{et['key']}'")
        case_sql = f"CASE {' '.join(case_lines)} ELSE NULL END"
        mm_cte = f"""
        mm_events AS (
          SELECT
            CAST(f.nid AS STRING) AS nid,
            DATE(f.fecha) AS fecha,
            {case_sql} AS etapa,
            'mm' AS source,
            COALESCE(c.equipo, 'Sin equipo') AS equipo,
            COALESCE(f.area_metropolitana, '') AS area
          FROM `papyrus-data.habi_wh_bi.funnel_diarios_col` f
          LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
          WHERE DATE(f.fecha) >= '{fecha_desde}'
            AND DATE(f.fecha) <= '{fecha_hasta}'
            AND f.valor NOT IN ({_quote_list(EXCLUDE_ETAPAS)})
            AND f.valor IN ({_quote_list(mm_values)})
            AND {sql_not_in("f.hubspot_owner_id", BUFFER_EMAILS)}
        )"""
    else:
        mm_cte = """
        mm_events AS (
          SELECT CAST(NULL AS STRING) AS nid, DATE('1900-01-01') AS fecha,
                 CAST(NULL AS STRING) AS etapa, CAST(NULL AS STRING) AS source,
                 '' AS equipo, '' AS area
          LIMIT 0
        )"""

    # ── Inmo ──
    if needed_inmo:
        bad_nids = ", ".join(metas_inmo.load_bad_captados_nids()) or "0"
        captado_filter = f" AND nid NOT IN ({bad_nids})" if exclude_incidente else ""
        # Stage maps por key
        stage_map = {
            "inmo:perfilados":      STAGE_ID_PERFILADO,
            "inmo:comite":          STAGE_ID_COMITE,
            "inmo:aprobado":        STAGE_ID_APROBADO,
            "inmo:ofertado":        STAGE_ID_OFERTADO,
            "inmo:oferta_aceptada": STAGE_ID_ACEPTADA,
            "inmo:captado":         STAGE_ID_CAPTADO,
        }
        sub_ctes = [f"""
        historical_inmo AS (
          SELECT h.nid, h.fecha, h.valor AS stage_id
          FROM `sellers-main-prod.hubspot.historical` h
          WHERE h.propiedad = 'dealstage'
            AND h.valor IN ({PIPELINE_LIST})
            AND DATE(h.fecha) >= '{fecha_desde}'
            AND DATE(h.fecha) <= '{fecha_hasta}'
        )"""]
        unions = []
        if "inmo:asignados" in needed_inmo:
            # Fuente OFICIAL de asignados Inmo: leads_asignados_inmobiliaria_colombia
            # (1 fila por nid = primera asignación). Reemplaza el "primer evento en historical".
            # ⚠️ La tabla arranca en 2025-12-01.
            unions.append(f"""
              SELECT nid, TIMESTAMP(fecha_primera_asignacion) AS fecha, 'inmo:asignados' AS etapa
              FROM `sellers-main-prod.data_sellers_bo.leads_asignados_inmobiliaria_colombia`
              WHERE DATE(fecha_primera_asignacion) >= '{fecha_desde}'
                AND DATE(fecha_primera_asignacion) <= '{fecha_hasta}'
            """)
        for key, stage_id in stage_map.items():
            if key in needed_inmo:
                extra = captado_filter if key == "inmo:captado" else ""
                unions.append(f"""
                  SELECT nid, fecha, '{key}' AS etapa
                  FROM historical_inmo
                  WHERE stage_id = '{stage_id}'{extra}
                """)
        inmo_base_sql = " UNION ALL ".join(unions) if unions else "SELECT CAST(NULL AS STRING) AS nid, DATE('1900-01-01') AS fecha, CAST(NULL AS STRING) AS etapa LIMIT 0"
        sub_ctes.append(f"""
        inmo_base AS ({inmo_base_sql})""")
        sub_ctes.append(f"""
        inmo_events AS (
          SELECT
            CAST(b.nid AS STRING) AS nid,
            DATE(b.fecha) AS fecha,
            b.etapa AS etapa,
            'inmo' AS source,
            COALESCE(c.equipo, 'Sin equipo') AS equipo,
            COALESCE(d.area_metropolitana, '') AS area
          FROM inmo_base b
          LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = b.nid
          LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
          WHERE {sql_not_in("d.hubspot_owner_id", BUFFER_EMAILS)}
        )""")
        inmo_ctes = ",".join(sub_ctes)
    else:
        inmo_ctes = """
        inmo_events AS (
          SELECT CAST(NULL AS STRING) AS nid, DATE('1900-01-01') AS fecha,
                 CAST(NULL AS STRING) AS etapa, CAST(NULL AS STRING) AS source,
                 '' AS equipo, '' AS area
          LIMIT 0
        )"""

    upstream_cte = _upstream_cte(fecha_desde, fecha_hasta, needed_upstream)
    return f"""{upstream_cte},{mm_cte},{inmo_ctes},
        events AS (
          SELECT nid, fecha, etapa, source, equipo, area FROM upstream_events WHERE etapa IS NOT NULL
          UNION ALL
          SELECT nid, fecha, etapa, source, equipo, area FROM mm_events WHERE etapa IS NOT NULL
          UNION ALL
          SELECT nid, fecha, etapa, source, equipo, area FROM inmo_events WHERE etapa IS NOT NULL
        )"""


def _filter_clause(equipos: list[str] | None, areas: list[str] | None) -> str:
    conds = ["1=1"]
    if equipos:
        conds.append(f"e.equipo IN ({_quote_list(equipos)})")
    if areas:
        conds.append(f"e.area IN ({_quote_list(areas)})")
    return "\n  AND ".join(conds)


# ── Página principal ────────────────────────────────────────────────────────
@router.get("", response_class=HTMLResponse)
def page(request: Request):
    today = date.today().isoformat()
    return templates.TemplateResponse("funnel_combinado/page.html", {
        "request": request,
        "fecha_desde": FECHA_INICIO,
        "fecha_hasta": today,
        "default_num": DEFAULT_NUM,
        "default_den": DEFAULT_DEN,
    })


# ── /filters ────────────────────────────────────────────────────────────────
@router.get("/filters")
def filters_options(
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
):
    """Equipos y áreas disponibles (unión MM + Inmo) en el rango."""
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    # Pedimos todas las etapas (sin upstream — su universo de equipos/áreas usa otra
    # vocabulary que pueda contaminar los dropdowns con valores no comparables)
    needed_mm = [e["key"] for e in MM_ETAPAS]
    needed_inmo = [e["key"] for e in INMO_ETAPAS]
    ctes = _events_ctes(fecha_desde, fecha_hasta, needed_mm, needed_inmo)
    sql = f"""
    WITH comerciales AS ({_comerciales_unnest()}),{ctes}
    SELECT
      ARRAY(SELECT DISTINCT equipo FROM events WHERE equipo NOT IN ('', 'Sin equipo') ORDER BY equipo) AS equipos,
      ARRAY(SELECT DISTINCT area   FROM events WHERE area   != '' ORDER BY area)                       AS areas,
      ARRAY(SELECT DISTINCT FORMAT_DATE('%Y-%m', fecha) FROM events ORDER BY 1 DESC)                   AS meses
    """
    rows = bq.query(sql)
    r = rows[0] if rows else {}
    return JSONResponse({
        "equipos": sorted([x for x in (r.get("equipos") or []) if x]),
        "areas":   sorted([x for x in (r.get("areas")   or []) if x]),
        "motivos": [c["key"] for c in MOTIVO_CATEGORIAS] + [MOTIVO_SIN],
        "meses":   [m for m in (r.get("meses") or []) if m],
        "bnpl":    BNPL_OPCIONES + [BNPL_SIN],
    })


# ── /etapas ────────────────────────────────────────────────────────────────
@router.get("/etapas")
def etapas():
    """Opciones agrupadas para los selects Numerador / Denominador."""
    return JSONResponse({
        "groups": [
            {
                "label": "Combinados",
                "options": [{"key": k, "label": v["label"]} for k, v in COMBOS.items()],
            },
            {
                "label": "Pre-asignación",
                "options": [{"key": e["key"], "label": e["label"]} for e in UPSTREAM_ETAPAS],
            },
            {
                "label": "MM",
                "options": [{"key": e["key"], "label": e["label"]} for e in MM_ETAPAS],
            },
            {
                "label": "Inmo",
                "options": [{"key": e["key"], "label": e["label"]} for e in INMO_ETAPAS],
            },
        ],
        "default_num": DEFAULT_NUM,
        "default_den": DEFAULT_DEN,
    })


# ── /conv-time ─────────────────────────────────────────────────────────────
@router.get("/conv-time")
def conv_time(
    granularidad: Annotated[str, Query()] = "mes",
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    num: Annotated[str, Query()] = DEFAULT_NUM,
    den: Annotated[str, Query()] = DEFAULT_DEN,
    equipo: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
    bnpl: Annotated[list[str] | None, Query()] = None,
    exclude_incidente: Annotated[bool, Query()] = True,
):
    """CVR por período: nids(num) ÷ nids(den) sobre el universo MM + Inmo.

    Conteo: COUNT(DISTINCT nid) — nid único (un negocio en MM y en Inmo cuenta 1 vez).
    """
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()

    num_keys = _expand_keys([num])
    den_keys = _expand_keys([den])
    if not num_keys or not den_keys:
        return JSONResponse({"error": "num/den inválidos"}, status_code=400)

    needed = set(num_keys) | set(den_keys)
    needed_mm = [k for k in needed if k.startswith("mm:")]
    needed_inmo = [k for k in needed if k.startswith("inmo:")]
    needed_upstream = [k for k in needed if k in UPSTREAM_KEYS]

    ctes = _events_ctes(fecha_desde, fecha_hasta, needed_mm, needed_inmo,
                        needed_upstream=needed_upstream, exclude_incidente=exclude_incidente)
    where = _filter_clause(equipo, area)
    group_expr = _group_expr(granularidad, "e.fecha")

    # Filtros por nid vía join a deals/recepcionista, solo si están activos.
    m_cte, m_join, m_cond = _motivo_extra(motivo)
    b_cte, b_join, b_cond = _bnpl_extra(bnpl)
    where += m_cond + b_cond

    sql = f"""
    WITH comerciales AS ({_comerciales_unnest()}),{ctes}{m_cte}{b_cte}
    SELECT
      {group_expr} AS periodo,
      COUNT(DISTINCT IF(e.etapa IN ({_quote_list(num_keys)}), e.nid, NULL)) AS num,
      COUNT(DISTINCT IF(e.etapa IN ({_quote_list(den_keys)}), e.nid, NULL)) AS den
    FROM events e
    {m_join}
    {b_join}
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

    def _resolve_label(key: str) -> str:
        if key in COMBOS:
            return COMBOS[key]["label"]
        for e in MM_ETAPAS + INMO_ETAPAS + UPSTREAM_ETAPAS:
            if e["key"] == key:
                return e["label"]
        return key

    return JSONResponse({
        "labels": labels,
        "num": nums, "den": dens, "cvr": cvrs,
        "total_num": total_n, "total_den": total_d,
        "total_cvr": (total_n/total_d*100) if total_d > 0 else None,
        "num_key": num, "num_label": _resolve_label(num),
        "den_key": den, "den_label": _resolve_label(den),
        "num_expanded": num_keys, "den_expanded": den_keys,
    })


def _label_for(key: str) -> str:
    if key in COMBOS:
        return COMBOS[key]["label"]
    for e in MM_ETAPAS + INMO_ETAPAS + UPSTREAM_ETAPAS:
        if e["key"] == key:
            return e["label"]
    return key


def _motivo_extra(motivo: list[str] | None) -> tuple[str, str, str]:
    """(cte, join, cond) para filtrar por razón de venta (recepcionista MM). Vacíos si no hay filtro."""
    if not motivo:
        return "", "", ""
    cte = f",\n    motivo AS ({_motivo_cte()})"
    join = "LEFT JOIN motivo m ON CAST(m.nid AS STRING) = e.nid"
    cond = f"\n  AND COALESCE(m.motivo_cat, '{MOTIVO_SIN}') IN ({_quote_list(motivo)})"
    return cte, join, cond


def _bnpl_extra(bnpl: list[str] | None) -> tuple[str, str, str]:
    """(cte, join, cond) para filtrar por 'aplica para BNPL' (hubspot.deals, solo CO)."""
    if not bnpl:
        return "", "", ""
    cte = (",\n    bnpl_deals AS ("
           f"SELECT CAST(nid AS STRING) AS nid, {BNPL_FIELD} AS bnpl "
           "FROM `sellers-main-prod.hubspot.deals` "
           "QUALIFY ROW_NUMBER() OVER (PARTITION BY nid ORDER BY nid) = 1)")
    join = "LEFT JOIN bnpl_deals bn ON bn.nid = e.nid"
    cond = f"\n  AND COALESCE(NULLIF(bn.bnpl, ''), '{BNPL_SIN}') IN ({_quote_list(bnpl)})"
    return cte, join, cond


# ── /cosechas → cohorte × offset (entidad = source:nid) ──────────────────────
@router.get("/cosechas")
def cosechas(
    origen: Annotated[str, Query()] = "combo:asignados",
    destino: Annotated[str, Query()] = "combo:transacciones",
    granularidad: Annotated[str, Query()] = "mes",
    bucket: Annotated[str, Query()] = "iso",
    conteo: Annotated[str, Query()] = "cohorte",
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
    bnpl: Annotated[list[str] | None, Query()] = None,
    exclude_incidente: Annotated[bool, Query()] = True,
):
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    origen_keys = _expand_keys([origen])
    destino_keys = _expand_keys([destino])
    if not origen_keys or not destino_keys:
        return JSONResponse({"error": "origen/destino inválidos"}, status_code=400)
    needed = set(origen_keys) | set(destino_keys)
    needed_mm = [k for k in needed if k.startswith("mm:")]
    needed_inmo = [k for k in needed if k.startswith("inmo:")]
    needed_upstream = [k for k in needed if k in UPSTREAM_KEYS]
    ctes = _events_ctes(FECHA_INICIO, date.today().isoformat(), needed_mm, needed_inmo,
                        needed_upstream=needed_upstream, exclude_incidente=exclude_incidente)

    unit = "WEEK(MONDAY)" if granularidad == "semana" else "MONTH"
    fmt = "'%Y-%m-%d'" if granularidad == "semana" else "'%Y-%m'"
    if bucket == "dias":
        dpb = 7 if granularidad == "semana" else 30
        offset_expr = f"DIV(DATE_DIFF(d.fecha_destino, o.fecha_origen, DAY), {dpb})"
    else:
        diff_unit = "WEEK" if granularidad == "semana" else "MONTH"
        offset_expr = f"DATE_DIFF(d.fecha_destino, o.fecha_origen, {diff_unit})"

    where_o = _filter_clause(equipo, area)
    m_cte, m_join, m_cond = _motivo_extra(motivo)
    b_cte, b_join, b_cond = _bnpl_extra(bnpl)
    where_o += m_cond + b_cond
    ent = "e.nid"

    if conteo == "funnel":
        origen_cte = f"""
        origen AS (
          SELECT {ent} AS entity, DATE_TRUNC(e.fecha, {unit}) AS cohorte_date, MIN(e.fecha) AS fecha_origen
          FROM events e {m_join} {b_join}
          WHERE e.etapa IN ({_quote_list(origen_keys)}) AND {where_o}
            AND e.fecha BETWEEN '{fecha_desde}' AND '{fecha_hasta}'
          GROUP BY 1, 2
        )"""
        cohorte_expr = f"FORMAT_DATE({fmt}, o.cohorte_date)"
    else:
        origen_cte = f"""
        origen AS (
          SELECT {ent} AS entity, MIN(e.fecha) AS fecha_origen
          FROM events e {m_join} {b_join}
          WHERE e.etapa IN ({_quote_list(origen_keys)}) AND {where_o}
            AND e.fecha BETWEEN '{fecha_desde}' AND '{fecha_hasta}'
          GROUP BY 1
        )"""
        cohorte_expr = f"FORMAT_DATE({fmt}, DATE_TRUNC(o.fecha_origen, {unit}))"

    sql = f"""
    WITH comerciales AS ({_comerciales_unnest()}),{ctes}{m_cte}{b_cte},
    {origen_cte},
    destino AS (
      SELECT nid AS entity, MIN(fecha) AS fecha_destino
      FROM events WHERE etapa IN ({_quote_list(destino_keys)}) GROUP BY 1
    ),
    joined AS (
      SELECT {cohorte_expr} AS cohorte, {offset_expr} AS offset_unit
      FROM origen o LEFT JOIN destino d ON d.entity = o.entity AND d.fecha_destino >= o.fecha_origen
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
        b = cohortes[c]
        total = sum(b.values())
        counts = [b.get(o, 0) for o in range(max_offset + 1)]
        no_reached = b.get(None, 0)
        alc = total - no_reached
        cum, cum_counts = 0, []
        for x in counts:
            cum += x
            cum_counts.append(cum)
        matrix.append({
            "cohorte": c, "total": total, "alcanzaron": alc, "no_alcanzaron": no_reached,
            "counts": counts,
            "pct": [(x / total * 100) if total > 0 else 0 for x in counts],
            "share": [(x / alc * 100) if alc > 0 else 0 for x in counts],
            "cum_counts": cum_counts,
            "cum_pct": [(x / total * 100) if total > 0 else 0 for x in cum_counts],
            "cum_share": [(x / alc * 100) if alc > 0 else 0 for x in cum_counts],
        })

    prefix = "S" if granularidad == "semana" else "M"
    offset_labels = [f"{prefix}{i}" for i in range(max_offset + 1)]
    if bucket == "dias":
        step = 7 if granularidad == "semana" else 30
        offset_ranges = [f"{i*step}-{(i+1)*step-1}d" for i in range(max_offset + 1)]
    else:
        offset_ranges = None

    return JSONResponse({
        "origen": origen, "destino": destino, "origen_label": _label_for(origen), "destino_label": _label_for(destino),
        "granularidad": granularidad, "bucket": bucket, "conteo": conteo,
        "offset_labels": offset_labels, "offset_ranges": offset_ranges, "rows": matrix,
    })


# ── /funnel-compare → funnel cohortado combinado (A vs B) ────────────────────
@router.get("/funnel-compare")
def funnel_compare(
    mes: Annotated[str | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    motivo: Annotated[list[str] | None, Query()] = None,
    bnpl: Annotated[list[str] | None, Query()] = None,
    source: Annotated[str, Query()] = "both",   # both | mm | inmo (acota el producto)
    exclude_incidente: Annotated[bool, Query()] = True,
):
    label = mes if mes else "Todo"
    source_filter = f"AND e.source = '{source}'" if source in ("mm", "inmo") else ""
    all_keys = []
    for combo in COMBO_FUNNEL:
        all_keys.extend(_expand_keys([combo]))
    needed_mm = [k for k in set(all_keys) if k.startswith("mm:")]
    needed_inmo = [k for k in set(all_keys) if k.startswith("inmo:")]
    ctes = _events_ctes(FECHA_INICIO, date.today().isoformat(), needed_mm, needed_inmo,
                        needed_upstream=[], exclude_incidente=exclude_incidente)

    where = _filter_clause(equipo, area)
    m_cte, m_join, m_cond = _motivo_extra(motivo)
    b_cte, b_join, b_cond = _bnpl_extra(bnpl)
    where += m_cond + b_cond
    cohort_where = f"AND FORMAT_DATE('%Y-%m', fecha_origen) = '{mes}'" if mes else ""
    asig_keys = _expand_keys([COMBO_FUNNEL[0]])
    ent = "e.nid"
    _MM_BY_KEY = {e["key"]: e for e in MM_ETAPAS}
    _INMO_BY_KEY = {e["key"]: e for e in INMO_ETAPAS}

    when_lines = []
    for combo in COMBO_FUNNEL:
        for k in _expand_keys([combo]):
            when_lines.append(f"WHEN '{k}' THEN '{combo}'")
    combo_case = f"CASE e.etapa {' '.join(when_lines)} ELSE NULL END"

    sql = f"""
    WITH comerciales AS ({_comerciales_unnest()}),{ctes}{m_cte}{b_cte},
    asig AS (
      SELECT {ent} AS entity, MIN(e.fecha) AS fecha_origen
      FROM events e {m_join} {b_join}
      WHERE e.etapa IN ({_quote_list(asig_keys)}) AND {where} {source_filter}
      GROUP BY 1
    ),
    cohort AS (SELECT entity, fecha_origen FROM asig WHERE TRUE {cohort_where}),
    stage_min AS (
      SELECT e.nid AS entity, {combo_case} AS combo, MIN(e.fecha) AS fecha_etapa
      FROM events e
      WHERE {combo_case} IS NOT NULL {source_filter}
      GROUP BY 1, 2
    ),
    reached AS (
      SELECT sm.combo AS etapa, COUNT(DISTINCT sm.entity) AS nids
      FROM stage_min sm JOIN cohort co ON co.entity = sm.entity
      WHERE sm.fecha_etapa >= co.fecha_origen
      GROUP BY 1
    )
    SELECT etapa, nids FROM reached
    """
    rows = bq.query(sql)
    by_combo = {r["etapa"]: int(r["nids"]) for r in rows}

    def _stage_label(combo: str) -> str:
        if source in ("mm", "inmo"):
            for k in COMBOS[combo]["expand"]:
                if k.startswith(source + ":"):
                    e = (_MM_BY_KEY if source == "mm" else _INMO_BY_KEY).get(k)
                    if e:
                        return e["label"]
        return COMBOS[combo]["label"]

    first = by_combo.get(COMBO_FUNNEL[0], 0)
    stages, prev_n = [], None
    for combo in COMBO_FUNNEL:
        n = by_combo.get(combo, 0)
        stages.append({
            "key": combo, "label": _stage_label(combo), "exclusion": False,
            "nids": n,
            "pct_first": (n / first * 100) if first > 0 else 0,
            "pct_prev": (n / prev_n * 100) if (prev_n and prev_n > 0) else None,
        })
        prev_n = n

    return JSONResponse({"mes": label, "total": first, "stages": stages})
