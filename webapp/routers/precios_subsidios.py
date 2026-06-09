"""Router de Precios + Subsidios MM CO.

Basado en queries pasadas por Juan (2026-05-26):
- webapp/sql/precios_maestro_mm.sql — base de ofertas + experimento de armado
- webapp/sql/subsidios_gasto.sql    — gasto de bolsas con subsidio_aprobado_lider='Si'

Endpoints:
  GET /                  → página principal del tab
  GET /filters           → opciones para los multi-selects (áreas, equipos, categorías)
  GET /data              → JSON con KPIs + series temporales (descuentos, subsidios, gasto)
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

log = logging.getLogger(__name__)
router = APIRouter()
templates = Jinja2Templates(directory=Path(__file__).parent.parent / "templates")

EXP_START = "2026-01-26"
EXP_NAME  = "co-rangos-20260122"


def _quote_list(items: list[str]) -> str:
    safe = [i.replace("'", "''") for i in items]
    return ", ".join(f"'{s}'" for s in safe)


def _base_cte(fecha_desde: str, fecha_hasta: str, fecha_tipo: str = "aprobacion") -> str:
    """Construye la CTE base con todos los nids+ofertas+experimento.

    Filtra por la fecha indicada (aprobación o cierre). Devuelve SQL string que
    puede usarse como `WITH base AS (...)` y luego agregado por encima.
    """
    fecha_field = "fecha_cierre" if fecha_tipo == "cierre" else "fecha_aprobado"
    return f"""
    base_armado AS (
      SELECT
        CAST(nid AS INT64) AS nid,
        SAFE.PARSE_JSON(REPLACE(idm_hesh, "\\'", "\\"")) AS idm_hesh,
        SAFE.PARSE_JSON(REPLACE(diff_price, "\\'", "\\"")) AS diff_price,
        DATETIME(fecha_ejecucion) - INTERVAL 5 HOUR AS fecha_ejecucion_armado,
        precio_final AS precio_esperado_compra
      FROM `im-main-prod.habi_wh_analytics.price_building_co_v2`
      QUALIFY ROW_NUMBER() OVER (PARTITION BY nid, DATE(fecha_ejecucion) ORDER BY DATETIME(fecha_ejecucion) DESC) = 1
    ),
    base_armado_v2 AS (
      SELECT *,
        JSON_VALUE(diff_price.ab_test) AS ab_test,
        JSON_VALUE(diff_price.experiment_name) AS experiment_name_raw,
        CAST(JSON_VALUE(diff_price.precio_base) AS FLOAT64) AS precio_base,
        CAST(JSON_VALUE(diff_price.precio_maximo) AS FLOAT64) AS precio_maximo,
        CAST(JSON_VALUE(diff_price.precio_minimo) AS FLOAT64) AS precio_minimo,
        CAST(JSON_VALUE(idm_hesh.ask_price_post_remo) AS FLOAT64) AS precio_esperado_venta
      FROM base_armado
      QUALIFY ROW_NUMBER() OVER (PARTITION BY nid, DATE(fecha_ejecucion_armado)) = 1
    ),
    base_ofertas AS (
      -- Sólo la ÚLTIMA aprobación por negocio (nid). Esa fecha es la fecha del negocio.
      SELECT *
      FROM `papyrus-data.habi_wh.detalle_ofertas_col`
      WHERE fecha_aprobado IS NOT NULL
      QUALIFY ROW_NUMBER() OVER (PARTITION BY nid ORDER BY fecha_aprobado DESC) = 1
    ),
    base_auxiliar_armado AS (
      SELECT
        o.nid, o.fecha_aprobado,
        a.precio_esperado_compra,
        a.precio_esperado_venta,
        a.precio_base,
        a.precio_maximo,
        a.precio_minimo,
        CASE
          WHEN a.experiment_name_raw = '{EXP_NAME}'
            AND a.fecha_ejecucion_armado >= '{EXP_START} 13:00:00'
          THEN '{EXP_NAME}'
          ELSE NULL
        END AS experiment_id
      FROM base_ofertas o
      LEFT JOIN base_armado_v2 a ON o.nid = a.nid
      WHERE a.fecha_ejecucion_armado <= o.fecha_aprobado
      QUALIFY ROW_NUMBER() OVER (PARTITION BY o.nid, o.fecha_aprobado ORDER BY a.fecha_ejecucion_armado DESC) = 1
    ),
    base AS (
      SELECT
        o.nid,
        o.fecha_aprobado,
        o.fecha_cierre,
        o.estado_aprobado,
        o.categoria_final,
        a.precio_esperado_compra,
        a.precio_esperado_venta AS precio_esperado_venta_armado,
        a.precio_base,
        a.precio_maximo AS precio_maximo_exp,
        a.precio_minimo AS precio_minimo_exp,
        a.experiment_id,
        hs.valor_subsidiado,
        hs.subsidio_aprobado_lider,
        hs.precio_minimo_prestamo,
        hs.precio_maximo_prestamo,
        hs.precio_intermedio,
        hs.precio_comite,
        hs.ask_price_despues__de_remodelacion AS ask_price_post_remo,
        hs.ask_price,
        hs.precio_comite_final_final_final__el_unico____clonada_ AS precio_oferta_base,
        hs.equipo_sellers,
        hs.final_final_aprobado_b_o,
        tam.name AS area_metro,
        CASE WHEN tam.name IS NULL THEN 'sin_area'
             WHEN LOWER(tam.name) LIKE '%bogot%' THEN 'bogota'
             WHEN LOWER(tam.name) LIKE '%aburr%' OR LOWER(tam.name) LIKE '%medell%' THEN 'valle_de_aburra'
             WHEN LOWER(tam.name) LIKE '%cali%' THEN 'cali'
             WHEN LOWER(tam.name) LIKE '%barranquilla%' THEN 'barranquilla'
             WHEN LOWER(tam.name) LIKE '%cartagena%' THEN 'cartagena'
             ELSE 'otra'
        END AS area_key
      FROM base_ofertas o
      LEFT JOIN base_auxiliar_armado a ON a.nid = o.nid AND DATE(a.fecha_aprobado) = DATE(o.fecha_aprobado)
      LEFT JOIN `sellers-main-prod.hubspot.deals` hs ON hs.nid = o.nid
      LEFT JOIN `papyrus-data.habi_db.tabla_negocio_inmueble` tni ON tni.nid = o.nid
      LEFT JOIN `papyrus-data.habi_db.tabla_inmueble_v2` ti ON ti.id = tni.inmueble_id
      LEFT JOIN `papyrus-data.habi_db.tabla_localizacion_inmueble_v2` tli ON tli.id = ti.localizacion_new_id
      LEFT JOIN `papyrus-data.habi_wh.tabla_zona_mediana` tzm ON tzm.id = tli.zona_mediana_id
      LEFT JOIN `papyrus-data.habi_wh.tabla_zona_grande` tzg ON tzg.id = tzm.zona_grande_id
      LEFT JOIN `papyrus-data.habi_wh.tabla_ciudad` tc ON tc.id = tzg.ciudad_id
      LEFT JOIN `papyrus-data.habi_wh.tabla_area_metropolitana` tam ON tam.id = tc.area_metropolitana_id
      WHERE o.{fecha_field} BETWEEN '{fecha_desde}' AND '{fecha_hasta}'
    )
    """


# Este router vive embebido como tab del Funnel MM — no tiene página propia,
# solo endpoints de datos. El tab se renderiza desde templates/funnel_mm/page.html.


# ── /filters → áreas + equipos disponibles ───────────────────────────────────
@router.get("/filters")
def filters_options(
    fecha_desde: Annotated[str, Query()] = "2026-01-01",
    fecha_hasta: Annotated[str | None, Query()] = None,
    fecha_tipo: Annotated[str, Query()] = "aprobacion",
):
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()

    base = _base_cte(fecha_desde, fecha_hasta, fecha_tipo)
    sql = f"""
    WITH {base}
    SELECT
      ARRAY(SELECT DISTINCT area_key FROM base WHERE area_key NOT IN ('sin_area','otra') ORDER BY area_key) AS areas,
      ARRAY(SELECT DISTINCT TRIM(IFNULL(equipo_sellers,'(sin equipo)')) FROM base
            WHERE TRIM(IFNULL(equipo_sellers,''))!='' ORDER BY 1) AS equipos,
      ARRAY(SELECT DISTINCT IFNULL(categoria_final,'(sin cat)') FROM base ORDER BY 1) AS cats
    """
    rows = bq.query(sql)
    r = rows[0] if rows else {}
    return JSONResponse({
        "areas": list(r.get("areas") or []),
        "equipos": list(r.get("equipos") or []),
        "cats": list(r.get("cats") or []),
    })


# ── /data → KPIs + series temporales ─────────────────────────────────────────
@router.get("/data")
def data(
    fecha_desde: Annotated[str, Query()] = "2026-01-01",
    fecha_hasta: Annotated[str | None, Query()] = None,
    fecha_tipo: Annotated[str, Query()] = "aprobacion",      # aprobacion | cierre
    granularidad: Annotated[str, Query()] = "mes",           # mes | semana
    area: Annotated[list[str] | None, Query()] = None,
    equipo: Annotated[list[str] | None, Query()] = None,
    cat: Annotated[list[str] | None, Query()] = None,
):
    """Devuelve KPIs + series por período para los charts del tab."""
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()

    fecha_field = "fecha_cierre" if fecha_tipo == "cierre" else "fecha_aprobado"
    base = _base_cte(fecha_desde, fecha_hasta, fecha_tipo)

    # Filtros para todas las queries
    conds = []
    if area:
        conds.append(f"area_key IN ({_quote_list(area)})")
    if equipo:
        conds.append(f"TRIM(COALESCE(equipo_sellers,'(sin equipo)')) IN ({_quote_list(equipo)})")
    if cat:
        conds.append(f"COALESCE(categoria_final,'(sin cat)') IN ({_quote_list(cat)})")
    where_extra = ""
    if conds:
        where_extra = "WHERE " + " AND ".join(conds)

    # Granularidad → expresión SQL
    if granularidad == "semana":
        period_expr = f"FORMAT_DATE('%Y-%m-%d', DATE_TRUNC(DATE({fecha_field}), WEEK(MONDAY)))"
    else:
        period_expr = f"FORMAT_DATE('%Y-%m', {fecha_field})"

    # Series temporales con agregaciones
    sql = f"""
    WITH {base},
    filtered AS (SELECT * FROM base {where_extra}),
    series AS (
      SELECT
        {period_expr} AS periodo,
        COUNT(*) AS n_aprobados,
        -- Descuentos vs VALOR vivienda (ask_price_post_remo) y vs CLIENTE (ask_price).
        -- Metodología del reporte original: descuento = 1 - precio/ask, contando sólo
        -- ratios precio/ask ∈ [0.2, 1.5] (descarta outliers Y excluye naturalmente los
        -- precios de préstamo pre-experimento que tienen ratio <0.2). Umbral ≥5 se aplica en Python.
        APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_oferta_base,     ask_price_post_remo) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_oferta_base,     ask_price_post_remo), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS dv_base,
        APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_minimo_prestamo, ask_price_post_remo) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_minimo_prestamo, ask_price_post_remo), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS dv_min,
        APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_intermedio,      ask_price_post_remo) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_intermedio,      ask_price_post_remo), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS dv_inter,
        APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_maximo_prestamo, ask_price_post_remo) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_maximo_prestamo, ask_price_post_remo), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS dv_max,
        COUNTIF(SAFE_DIVIDE(precio_minimo_prestamo, ask_price_post_remo) BETWEEN 0.2 AND 1.5) AS n_dv_exp,
        APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_oferta_base,     ask_price) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_oferta_base,     ask_price), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS dc_base,
        APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_minimo_prestamo, ask_price) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_minimo_prestamo, ask_price), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS dc_min,
        APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_intermedio,      ask_price) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_intermedio,      ask_price), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS dc_inter,
        APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_maximo_prestamo, ask_price) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_maximo_prestamo, ask_price), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS dc_max,
        -- Subsidios
        COUNTIF(subsidio_aprobado_lider = 'Si') AS n_subsidios,
        SAFE_DIVIDE(COUNTIF(subsidio_aprobado_lider = 'Si'), COUNT(*)) AS tasa_subsidio,
        APPROX_QUANTILES(IF(subsidio_aprobado_lider = 'Si', precio_intermedio - precio_minimo_prestamo, NULL), 100)[OFFSET(50)] AS subsidio_monto_mediano,
        SUM(IF(subsidio_aprobado_lider = 'Si', precio_intermedio - precio_minimo_prestamo, 0)) AS gasto_subsidio_total,
        -- Bolsas: 1ª = (final - min), capada en intermedio. 2ª = excedente sobre intermedio.
        SUM(IF(subsidio_aprobado_lider = 'Si' AND final_final_aprobado_b_o IS NOT NULL,
               CASE WHEN (final_final_aprobado_b_o - precio_intermedio) <= 0
                    THEN final_final_aprobado_b_o - precio_minimo_prestamo
                    ELSE precio_intermedio - precio_minimo_prestamo END, 0)) AS gasto_1bolsa,
        SUM(IF(subsidio_aprobado_lider = 'Si' AND final_final_aprobado_b_o IS NOT NULL,
               CASE WHEN (final_final_aprobado_b_o - precio_intermedio) > 0
                    THEN final_final_aprobado_b_o - precio_intermedio
                    ELSE 0 END, 0)) AS gasto_2bolsa,
        COUNTIF(subsidio_aprobado_lider = 'Si' AND final_final_aprobado_b_o > precio_intermedio) AS n_uso_2bolsa,
        COUNTIF(subsidio_aprobado_lider = 'Si' AND final_final_aprobado_b_o IS NOT NULL) AS n_uso_total,
        -- Ticket (precio oferta base)
        APPROX_QUANTILES(precio_oferta_base, 100)[OFFSET(50)] AS ticket_mediano,
        APPROX_QUANTILES(IF(subsidio_aprobado_lider = 'Si', precio_oferta_base, NULL), 100)[OFFSET(50)] AS ticket_subsidio_mediano,
        -- Cobertura experimento
        COUNTIF(experiment_id = '{EXP_NAME}') AS n_experimento
      FROM filtered
      GROUP BY 1
      ORDER BY 1
    )
    SELECT * FROM series WHERE periodo IS NOT NULL
    """
    rows = bq.query(sql)

    # KPIs scoped al período del experimento (2026+), aunque los charts muestren historia 2025.
    kpi_floor = "2026-01-01"
    kpi_where = (where_extra + (" AND " if where_extra else "WHERE ")) + f"{fecha_field} >= '{kpi_floor}'"
    sql_kpis = f"""
    WITH {base},
    filtered AS (SELECT * FROM base {kpi_where})
    SELECT
      COUNT(*) AS n_total,
      COUNTIF(subsidio_aprobado_lider = 'Si') AS n_subsidios,
      SAFE_DIVIDE(COUNTIF(subsidio_aprobado_lider = 'Si'), COUNT(*)) AS tasa_subsidio,
      APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_oferta_base, ask_price_post_remo) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_oferta_base, ask_price_post_remo), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS desc_valor_mediano,
      APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_oferta_base, ask_price) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_oferta_base, ask_price), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS desc_cliente_mediano,
      APPROX_QUANTILES(IF(subsidio_aprobado_lider = 'Si', precio_intermedio - precio_minimo_prestamo, NULL), 100)[OFFSET(50)] AS subsidio_monto_mediano,
      SUM(IF(subsidio_aprobado_lider = 'Si', precio_intermedio - precio_minimo_prestamo, 0)) AS gasto_total,
      COUNTIF(experiment_id = '{EXP_NAME}') AS n_experimento
    FROM filtered
    """
    kpi_rows = bq.query(sql_kpis)
    k = kpi_rows[0] if kpi_rows else {}

    return JSONResponse({
        "fecha_tipo": fecha_tipo,
        "granularidad": granularidad,
        "exp_start": EXP_START,
        "kpis": {
            "n_total":           int(k.get("n_total") or 0),
            "n_subsidios":       int(k.get("n_subsidios") or 0),
            "tasa_subsidio":     float(k.get("tasa_subsidio") or 0),
            "desc_valor":        float(k.get("desc_valor_mediano") or 0),
            "desc_cliente":      float(k.get("desc_cliente_mediano") or 0),
            "subsidio_monto":    float(k.get("subsidio_monto_mediano") or 0),
            "gasto_total":       float(k.get("gasto_total") or 0),
            "n_experimento":     int(k.get("n_experimento") or 0),
        },
        "series": {
            "periods":               [r["periodo"] for r in rows],
            "n_aprobados":           [int(r["n_aprobados"] or 0) for r in rows],
            # Descuento vs valor — 4 series. Mín/Inter/Máx se nullean si <5 deals del experimento
            # (replica umbral del reporte: las líneas del experimento sólo aparecen con data suficiente).
            "dv_base":               [r["dv_base"] for r in rows],
            "dv_min":                [r["dv_min"]   if (r["n_dv_exp"] or 0) >= 5 else None for r in rows],
            "dv_inter":              [r["dv_inter"] if (r["n_dv_exp"] or 0) >= 5 else None for r in rows],
            "dv_max":                [r["dv_max"]   if (r["n_dv_exp"] or 0) >= 5 else None for r in rows],
            # Descuento vs cliente — 4 series
            "dc_base":               [r["dc_base"] for r in rows],
            "dc_min":                [r["dc_min"]   if (r["n_dv_exp"] or 0) >= 5 else None for r in rows],
            "dc_inter":              [r["dc_inter"] if (r["n_dv_exp"] or 0) >= 5 else None for r in rows],
            "dc_max":                [r["dc_max"]   if (r["n_dv_exp"] or 0) >= 5 else None for r in rows],
            # compat: desc_valor / desc_cliente = oferta base
            "desc_valor":            [r["dv_base"] for r in rows],
            "desc_cliente":          [r["dc_base"] for r in rows],
            "tasa_subsidio":         [r["tasa_subsidio"] for r in rows],
            "subsidio_monto":        [r["subsidio_monto_mediano"] for r in rows],
            "gasto_total":           [float(r["gasto_subsidio_total"] or 0) for r in rows],
            "gasto_1bolsa":          [float(r["gasto_1bolsa"] or 0) for r in rows],
            "gasto_2bolsa":          [float(r["gasto_2bolsa"] or 0) for r in rows],
            "n_uso_2bolsa":          [int(r["n_uso_2bolsa"] or 0) for r in rows],
            "n_uso_total":           [int(r["n_uso_total"] or 0) for r in rows],
            "ticket_mediano":        [r["ticket_mediano"] for r in rows],
            "ticket_subsidio":       [r["ticket_subsidio_mediano"] for r in rows],
            "n_experimento":         [int(r["n_experimento"] or 0) for r in rows],
        },
    })
