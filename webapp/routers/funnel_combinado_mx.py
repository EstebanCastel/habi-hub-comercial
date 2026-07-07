"""Funnel Combinado México — vista unificada MM MX + Inmo MX (CVR en el tiempo).

Más simple que el Combinado CO: ambas fuentes MX son tablas únicas con etapas en
`valor` (sin historical/stage_ids ni joins de comerciales/deals).

Claves que el frontend manda en num/den:
  - mm:<key>    etapas MM    (de seguimiento_funnel_mex)
  - inmo:<key>  etapas Inmo  (de seguimiento_inmobiliaria_mex_copia)
  - combo:<key> presets agregados → el backend los expande a mm:/inmo: reales.

CVR = COUNT(DISTINCT nid) — nid ÚNICO: un negocio que pasó por MM y por Inmo cuenta
una sola vez (no se suma por producto). Sin upstream (MX no tiene tabla de leads).
"""
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates

from webapp import bq
# Razón de venta MX: reutiliza el mapeo consolidado del Funnel MM MX (deals).
from webapp.routers.funnel_mm_mx import _motivo_expr, MOTIVO_CATEGORIAS, MOTIVO_SIN

router = APIRouter()
templates = Jinja2Templates(directory=Path(__file__).parent.parent / "templates")

FECHA_INICIO = "2026-01-01"

MM_TABLE = "sellers-main-prod.bi_mx.seguimiento_funnel_mex"
INMO_TABLE = "sellers-main-prod.bi_mx.seguimiento_inmobiliaria_mex_copia"

# Etapas MM (key combinado → valores BQ en seguimiento_funnel_mex).
MM_ETAPAS = [
    {"key": "mm:asignacion", "label": "MM · Asignación",    "bq_values": ["Primer asignacion"]},
    {"key": "mm:cita",       "label": "MM · Cita",          "bq_values": ["Cita Agendada"]},
    {"key": "mm:visita",     "label": "MM · Visita",        "bq_values": ["Visita Efectuada"]},
    {"key": "mm:precomite",  "label": "MM · Pre-comité",    "bq_values": ["Pre-comite validado"]},
    {"key": "mm:aprobado",   "label": "MM · Aprobado",      "bq_values": ["Aprobado General", "Primer inmueble aprobado"]},
    {"key": "mm:acepto",     "label": "MM · Aceptó oferta", "bq_values": ["Acepto Oferta - Pendiente firma"]},
    {"key": "mm:cierre",     "label": "MM · Cierre",        "bq_values": ["Cierre - Comprado"]},
]

# Etapas Inmo (key combinado → valores BQ en seguimiento_inmobiliaria_mex_copia).
# Labels según el dashboard oficial (ver mx-funnel-inmo-quirks).
INMO_ETAPAS = [
    {"key": "inmo:asignados",       "label": "Inmo · Asignados",       "bq_values": ["Asignados"]},
    {"key": "inmo:contactados",     "label": "Inmo · Contactados",     "bq_values": ["contactado"]},
    {"key": "inmo:oferta_aceptada", "label": "Inmo · Oferta aceptada", "bq_values": ["oferta_aceptada_gabi"]},
    {"key": "inmo:contrato",        "label": "Inmo · Contrato en elab.", "bq_values": ["En legal"]},
    {"key": "inmo:firmas",          "label": "Inmo · Firmas",          "bq_values": ["Firma"]},
    {"key": "inmo:captaciones",     "label": "Inmo · Captaciones",     "bq_values": ["captaciones_3_checks"]},
]

COMBOS = {
    "combo:asignados":     {"label": "Asignados (MM + Inmo)",          "expand": ["mm:asignacion", "inmo:asignados"]},
    "combo:contacto":      {"label": "Cita + Contactados",             "expand": ["mm:cita", "inmo:contactados"]},
    "combo:aceptados":     {"label": "Aceptó + Oferta aceptada",       "expand": ["mm:acepto", "inmo:oferta_aceptada"]},
    "combo:transacciones": {"label": "Transacciones (Cierre + Firmas)", "expand": ["mm:cierre", "inmo:firmas"]},
}

# Secuencia ordenada del funnel combinado (vista funnel / comparación cohortes).
COMBO_FUNNEL = ["combo:asignados", "combo:contacto", "combo:aceptados", "combo:transacciones"]

DEFAULT_NUM = "combo:transacciones"
DEFAULT_DEN = "combo:asignados"

_MM_BY_KEY = {e["key"]: e for e in MM_ETAPAS}
_INMO_BY_KEY = {e["key"]: e for e in INMO_ETAPAS}


def _quote_list(items: list[str]) -> str:
    safe = [i.replace("'", "''") for i in items]
    return ", ".join(f"'{s}'" for s in safe)


def _expand_keys(keys: list[str]) -> list[str]:
    """Expande combo:* a etapas reales; mm:/inmo: quedan igual."""
    out: list[str] = []
    for k in keys:
        if k in COMBOS:
            out.extend(COMBOS[k]["expand"])
        elif k.startswith("mm:") or k.startswith("inmo:"):
            out.append(k)
    # dedup preservando orden
    seen, res = set(), []
    for k in out:
        if k not in seen:
            seen.add(k)
            res.append(k)
    return res


def _group_expr(granularidad: str, col: str = "e.fecha") -> str:
    if granularidad == "dia":
        return f"FORMAT_DATE('%Y-%m-%d', DATE({col}))"
    if granularidad == "semana":
        return f"FORMAT_DATE('%Y-%m-%d', DATE_TRUNC(DATE({col}), WEEK(MONDAY)))"
    if granularidad == "mes_com":
        whens = []
        for c in bq.load_cycles():
            label = f"C{c['ciclo']:02d} · {c['mes'][:3].capitalize()} {str(c['year'])[2:]}"
            whens.append(f"WHEN DATE({col}) BETWEEN '{c['inicio']}' AND '{c['fin']}' THEN '{label}'")
        return f"CASE {' '.join(whens)} ELSE NULL END"
    if granularidad == "sem_com":
        whens = []
        for c in bq.load_cycles():
            for s in c["semanas"]:
                whens.append(f"WHEN DATE({col}) BETWEEN '{s['inicio']}' AND '{s['fin']}' THEN 'C{c['ciclo']:02d}-S{s['num']:02d}'")
        return f"CASE {' '.join(whens)} ELSE NULL END"
    return f"FORMAT_DATE('%Y-%m', DATE({col}))"


def _case_for(etapas_by_key: dict, needed: list[str]) -> tuple[str, list[str]]:
    """Construye (CASE valor → key, lista de valores BQ a filtrar) para las keys pedidas."""
    whens, valores = [], []
    for key in needed:
        e = etapas_by_key.get(key)
        if not e:
            continue
        for v in e["bq_values"]:
            whens.append(f"WHEN '{v}' THEN '{key}'")
            valores.append(v)
    case = f"CASE f.valor {' '.join(whens)} ELSE NULL END" if whens else "CAST(NULL AS STRING)"
    return case, valores


def _events_ctes(fecha_desde: str, fecha_hasta: str, needed_mm: list[str], needed_inmo: list[str]) -> str:
    """CTE `events` unificada (mm + inmo) con (nid, fecha, etapa, source, equipo, area)."""
    mm_case, mm_vals = _case_for(_MM_BY_KEY, needed_mm)
    if mm_vals:
        mm_cte = f"""
        mm_events AS (
          SELECT CAST(f.nid AS STRING) AS nid, DATE(f.fecha) AS fecha,
                 {mm_case} AS etapa, 'mm' AS source,
                 COALESCE(NULLIF(f.equipo, ''), 'Sin equipo') AS equipo,
                 COALESCE(f.area_metropolitana, '') AS area
          FROM `{MM_TABLE}` f
          WHERE DATE(f.fecha) BETWEEN '{fecha_desde}' AND '{fecha_hasta}'
            AND f.valor IN ({_quote_list(mm_vals)})
        )"""
    else:
        mm_cte = "mm_events AS (SELECT CAST(NULL AS STRING) nid, DATE('1900-01-01') fecha, CAST(NULL AS STRING) etapa, CAST(NULL AS STRING) source, '' equipo, '' area LIMIT 0)"

    inmo_case, inmo_vals = _case_for(_INMO_BY_KEY, needed_inmo)
    if inmo_vals:
        inmo_cte = f"""
        inmo_events AS (
          SELECT CAST(f.nid AS STRING) AS nid, DATE(f.fecha) AS fecha,
                 {inmo_case} AS etapa, 'inmo' AS source,
                 COALESCE(NULLIF(f.equipo_sellers, ''), 'Sin equipo') AS equipo,
                 COALESCE(f.area_metropolitana, '') AS area
          FROM `{INMO_TABLE}` f
          WHERE DATE(f.fecha) BETWEEN '{fecha_desde}' AND '{fecha_hasta}'
            AND f.valor IN ({_quote_list(inmo_vals)})
        )"""
    else:
        inmo_cte = "inmo_events AS (SELECT CAST(NULL AS STRING) nid, DATE('1900-01-01') fecha, CAST(NULL AS STRING) etapa, CAST(NULL AS STRING) source, '' equipo, '' area LIMIT 0)"

    return f"""{mm_cte},{inmo_cte},
        events AS (
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


# ── Página ───────────────────────────────────────────────────────────────────
@router.get("", response_class=HTMLResponse)
def page(request: Request):
    return templates.TemplateResponse("funnel_combinado_mx/page.html", {
        "request": request,
        "fecha_desde": FECHA_INICIO,
        "fecha_hasta": date.today().isoformat(),
        "default_num": DEFAULT_NUM,
        "default_den": DEFAULT_DEN,
    })


# ── /filters ─────────────────────────────────────────────────────────────────
@router.get("/filters")
def filters_options(
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
):
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    needed_mm = [e["key"] for e in MM_ETAPAS]
    needed_inmo = [e["key"] for e in INMO_ETAPAS]
    ctes = _events_ctes(fecha_desde, fecha_hasta, needed_mm, needed_inmo)
    sql = f"""
    WITH {ctes}
    SELECT
      ARRAY(SELECT DISTINCT equipo FROM events WHERE equipo NOT IN ('', 'Sin equipo') ORDER BY equipo) AS equipos,
      ARRAY(SELECT DISTINCT area   FROM events WHERE area   != '' ORDER BY area)                       AS areas,
      ARRAY(SELECT DISTINCT FORMAT_DATE('%Y-%m', fecha) FROM events ORDER BY 1 DESC)                   AS meses
    """
    rows = bq.query(sql)
    r = rows[0] if rows else {}
    return JSONResponse({
        "equipos": sorted([x for x in (r.get("equipos") or []) if x]),
        "areas":   sorted([x for x in (r.get("areas") or []) if x]),
        "motivos": [c["key"] for c in MOTIVO_CATEGORIAS] + [MOTIVO_SIN],
        "meses":   [m for m in (r.get("meses") or []) if m],
    })


# ── /etapas ──────────────────────────────────────────────────────────────────
@router.get("/etapas")
def etapas():
    return JSONResponse({
        "groups": [
            {"label": "Combinados", "options": [{"key": k, "label": v["label"]} for k, v in COMBOS.items()]},
            {"label": "MM",         "options": [{"key": e["key"], "label": e["label"]} for e in MM_ETAPAS]},
            {"label": "Inmo",       "options": [{"key": e["key"], "label": e["label"]} for e in INMO_ETAPAS]},
        ],
        "default_num": DEFAULT_NUM,
        "default_den": DEFAULT_DEN,
    })


# ── /conv-time ───────────────────────────────────────────────────────────────
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
):
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    num_keys = _expand_keys([num])
    den_keys = _expand_keys([den])
    if not num_keys or not den_keys:
        return JSONResponse({"error": "num/den inválidos"}, status_code=400)

    needed = set(num_keys) | set(den_keys)
    needed_mm = [k for k in needed if k.startswith("mm:")]
    needed_inmo = [k for k in needed if k.startswith("inmo:")]
    ctes = _events_ctes(fecha_desde, fecha_hasta, needed_mm, needed_inmo)
    where = _filter_clause(equipo, area)
    group_expr = _group_expr(granularidad, "e.fecha")

    # Razón de venta: CTE deals (1 fila/nid) + join, solo si hay filtro activo.
    motivo_cte = motivo_join = ""
    if motivo:
        motivo_cte = f""",
    deals_motivo AS (
      SELECT CAST(nid AS STRING) AS nid, {_motivo_expr('d')} AS motivo
      FROM `sellers-main-prod.hubspot.deals` d
      QUALIFY ROW_NUMBER() OVER (PARTITION BY nid ORDER BY nid) = 1
    )"""
        motivo_join = "LEFT JOIN deals_motivo dm ON dm.nid = e.nid"
        where += f"\n  AND COALESCE(dm.motivo, '{MOTIVO_SIN}') IN ({_quote_list(motivo)})"

    sql = f"""
    WITH {ctes}{motivo_cte}
    SELECT
      {group_expr} AS periodo,
      COUNT(DISTINCT IF(e.etapa IN ({_quote_list(num_keys)}), e.nid, NULL)) AS num,
      COUNT(DISTINCT IF(e.etapa IN ({_quote_list(den_keys)}), e.nid, NULL)) AS den
    FROM events e
    {motivo_join}
    WHERE {where}
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

    def _label(key: str) -> str:
        if key in COMBOS:
            return COMBOS[key]["label"]
        e = _MM_BY_KEY.get(key) or _INMO_BY_KEY.get(key)
        return e["label"] if e else key

    return JSONResponse({
        "labels": labels, "num": nums, "den": dens, "cvr": cvrs,
        "total_num": total_n, "total_den": total_d,
        "total_cvr": (total_n / total_d * 100) if total_d > 0 else None,
        "num_key": num, "num_label": _label(num),
        "den_key": den, "den_label": _label(den),
    })


def _motivo_extra(motivo: list[str] | None) -> tuple[str, str, str]:
    """Devuelve (cte, join, cond) para filtrar por razón de venta. Vacíos si no hay filtro."""
    if not motivo:
        return "", "", ""
    cte = f""",
    deals_motivo AS (
      SELECT CAST(nid AS STRING) AS nid, {_motivo_expr('d')} AS motivo
      FROM `sellers-main-prod.hubspot.deals` d
      QUALIFY ROW_NUMBER() OVER (PARTITION BY nid ORDER BY nid) = 1
    )"""
    join = "LEFT JOIN deals_motivo dm ON dm.nid = e.nid"
    cond = f"\n  AND COALESCE(dm.motivo, '{MOTIVO_SIN}') IN ({_quote_list(motivo)})"
    return cte, join, cond


def _label_for(key: str) -> str:
    if key in COMBOS:
        return COMBOS[key]["label"]
    e = _MM_BY_KEY.get(key) or _INMO_BY_KEY.get(key)
    return e["label"] if e else key


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
    # Eventos sobre todo el rango (origen acotado luego; destino hacia adelante).
    ctes = _events_ctes(FECHA_INICIO, date.today().isoformat(), needed_mm, needed_inmo)

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
    where_o += m_cond
    ent = "e.nid"

    if conteo == "funnel":
        origen_cte = f"""
        origen AS (
          SELECT {ent} AS entity, DATE_TRUNC(e.fecha, {unit}) AS cohorte_date, MIN(e.fecha) AS fecha_origen
          FROM events e {m_join}
          WHERE e.etapa IN ({_quote_list(origen_keys)}) AND {where_o}
            AND e.fecha BETWEEN '{fecha_desde}' AND '{fecha_hasta}'
          GROUP BY 1, 2
        )"""
        cohorte_expr = f"FORMAT_DATE({fmt}, o.cohorte_date)"
    else:
        origen_cte = f"""
        origen AS (
          SELECT {ent} AS entity, MIN(e.fecha) AS fecha_origen
          FROM events e {m_join}
          WHERE e.etapa IN ({_quote_list(origen_keys)}) AND {where_o}
            AND e.fecha BETWEEN '{fecha_desde}' AND '{fecha_hasta}'
          GROUP BY 1
        )"""
        cohorte_expr = f"FORMAT_DATE({fmt}, DATE_TRUNC(o.fecha_origen, {unit}))"

    sql = f"""
    WITH {ctes}{m_cte},
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
    source: Annotated[str, Query()] = "both",   # both | mm | inmo (acota el producto)
):
    """Funnel cohortado con las etapas combinadas (COMBO_FUNNEL). Entidad = nid único.
    Cohorte = nids que entraron a Asignados ese mes; cada etapa se alcanza si su fecha
    ≥ la de asignación. `source` acota a MM, Inmo o ambos."""
    label = mes if mes else "Todo"
    source_filter = f"AND e.source = '{source}'" if source in ("mm", "inmo") else ""
    # Todas las etapas reales de las combos del funnel.
    all_keys = []
    for combo in COMBO_FUNNEL:
        all_keys.extend(_expand_keys([combo]))
    needed_mm = [k for k in set(all_keys) if k.startswith("mm:")]
    needed_inmo = [k for k in set(all_keys) if k.startswith("inmo:")]
    ctes = _events_ctes(FECHA_INICIO, date.today().isoformat(), needed_mm, needed_inmo)

    where = _filter_clause(equipo, area)
    m_cte, m_join, m_cond = _motivo_extra(motivo)
    where += m_cond
    cohort_where = f"AND FORMAT_DATE('%Y-%m', fecha_origen) = '{mes}'" if mes else ""
    asig_keys = _expand_keys([COMBO_FUNNEL[0]])
    ent = "e.nid"

    # Para cada combo: ¿qué etapas reales? CASE para etiquetar el evento con su combo.
    when_lines = []
    for combo in COMBO_FUNNEL:
        for k in _expand_keys([combo]):
            when_lines.append(f"WHEN '{k}' THEN '{combo}'")
    combo_case = f"CASE e.etapa {' '.join(when_lines)} ELSE NULL END"

    sql = f"""
    WITH {ctes}{m_cte},
    asig AS (
      SELECT {ent} AS entity, MIN(e.fecha) AS fecha_origen
      FROM events e {m_join}
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
        # both → label del combo; mm/inmo → label de la sub-etapa de ese producto.
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
