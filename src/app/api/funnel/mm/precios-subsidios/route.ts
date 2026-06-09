import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/bq';

const EXP_START = '2026-01-26';
const EXP_NAME = 'co-rangos-20260122';

function quoteList(items: string[]): string {
  const safe = items.map(i => i.replace(/'/g, "''"));
  return safe.map(s => `'${s}'`).join(', ');
}

function baseCte(fechaDesde: string, fechaHasta: string, fechaTipo: string = 'aprobacion'): string {
  const fechaField = fechaTipo === 'cierre' ? 'fecha_cierre' : 'fecha_aprobado';
  return `
    base_armado AS (
      SELECT
        CAST(nid AS INT64) AS nid,
        SAFE.PARSE_JSON(REPLACE(idm_hesh, "'", '"')) AS idm_hesh,
        SAFE.PARSE_JSON(REPLACE(diff_price, "'", '"')) AS diff_price,
        DATETIME(fecha_ejecucion) - INTERVAL 5 HOUR AS fecha_ejecucion_armado,
        precio_final AS precio_esperado_compra
      FROM \`im-main-prod.habi_wh_analytics.price_building_co_v2\`
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
      SELECT *
      FROM \`papyrus-data.habi_wh.detalle_ofertas_col\`
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
          WHEN a.experiment_name_raw = '${EXP_NAME}'
            AND a.fecha_ejecucion_armado >= '${EXP_START} 13:00:00'
          THEN '${EXP_NAME}'
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
      LEFT JOIN \`sellers-main-prod.hubspot.deals\` hs ON hs.nid = o.nid
      LEFT JOIN \`papyrus-data.habi_db.tabla_negocio_inmueble\` tni ON tni.nid = o.nid
      LEFT JOIN \`papyrus-data.habi_db.tabla_inmueble_v2\` ti ON ti.id = tni.inmueble_id
      LEFT JOIN \`papyrus-data.habi_db.tabla_localizacion_inmueble_v2\` tli ON tli.id = ti.localizacion_new_id
      LEFT JOIN \`papyrus-data.habi_wh.tabla_zona_mediana\` tzm ON tzm.id = tli.zona_mediana_id
      LEFT JOIN \`papyrus-data.habi_wh.tabla_zona_grande\` tzg ON tzg.id = tzm.zona_grande_id
      LEFT JOIN \`papyrus-data.habi_wh.tabla_ciudad\` tc ON tc.id = tzg.ciudad_id
      LEFT JOIN \`papyrus-data.habi_wh.tabla_area_metropolitana\` tam ON tam.id = tc.area_metropolitana_id
      WHERE o.${fechaField} BETWEEN '${fechaDesde}' AND '${fechaHasta}'
    )
  `;
}

// ── Filters handler ──────────────────────────────────────────────────────────
async function handleFilters(searchParams: URLSearchParams) {
  const fechaDesde = searchParams.get('fecha_desde') || '2026-01-01';
  const fechaHasta = searchParams.get('fecha_hasta') || new Date().toISOString().slice(0, 10);
  const fechaTipo = searchParams.get('fecha_tipo') || 'aprobacion';

  const base = baseCte(fechaDesde, fechaHasta, fechaTipo);
  const sql = `
    WITH ${base}
    SELECT
      ARRAY(SELECT DISTINCT area_key FROM base WHERE area_key NOT IN ('sin_area','otra') ORDER BY area_key) AS areas,
      ARRAY(SELECT DISTINCT TRIM(IFNULL(equipo_sellers,'(sin equipo)')) FROM base
            WHERE TRIM(IFNULL(equipo_sellers,''))!='' ORDER BY 1) AS equipos,
      ARRAY(SELECT DISTINCT IFNULL(categoria_final,'(sin cat)') FROM base ORDER BY 1) AS cats
  `;
  const rows = await query(sql);
  const r = rows[0] || {};
  return NextResponse.json({
    areas: Array.isArray(r.areas) ? r.areas : [],
    equipos: Array.isArray(r.equipos) ? r.equipos : [],
    cats: Array.isArray(r.cats) ? r.cats : [],
  });
}

// ── Data handler ─────────────────────────────────────────────────────────────
async function handleData(searchParams: URLSearchParams) {
  const fechaDesde = searchParams.get('fecha_desde') || '2026-01-01';
  const fechaHasta = searchParams.get('fecha_hasta') || new Date().toISOString().slice(0, 10);
  const fechaTipo = searchParams.get('fecha_tipo') || 'aprobacion';
  const granularidad = searchParams.get('granularidad') || 'mes';
  const area = searchParams.getAll('area');
  const equipo = searchParams.getAll('equipo');
  const cat = searchParams.getAll('cat');

  const fechaField = fechaTipo === 'cierre' ? 'fecha_cierre' : 'fecha_aprobado';
  const base = baseCte(fechaDesde, fechaHasta, fechaTipo);

  // Build filter conditions
  const conds: string[] = [];
  if (area.length) conds.push(`area_key IN (${quoteList(area)})`);
  if (equipo.length) conds.push(`TRIM(COALESCE(equipo_sellers,'(sin equipo)')) IN (${quoteList(equipo)})`);
  if (cat.length) conds.push(`COALESCE(categoria_final,'(sin cat)') IN (${quoteList(cat)})`);
  const whereExtra = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  // Granularity → SQL expression
  const periodExpr = granularidad === 'semana'
    ? `FORMAT_DATE('%Y-%m-%d', DATE_TRUNC(DATE(${fechaField}), WEEK(MONDAY)))`
    : `FORMAT_DATE('%Y-%m', ${fechaField})`;

  // Series temporales
  const sql = `
    WITH ${base},
    filtered AS (SELECT * FROM base ${whereExtra}),
    series AS (
      SELECT
        ${periodExpr} AS periodo,
        COUNT(*) AS n_aprobados,
        APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_oferta_base,     ask_price_post_remo) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_oferta_base,     ask_price_post_remo), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS dv_base,
        APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_minimo_prestamo, ask_price_post_remo) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_minimo_prestamo, ask_price_post_remo), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS dv_min,
        APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_intermedio,      ask_price_post_remo) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_intermedio,      ask_price_post_remo), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS dv_inter,
        APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_maximo_prestamo, ask_price_post_remo) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_maximo_prestamo, ask_price_post_remo), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS dv_max,
        COUNTIF(SAFE_DIVIDE(precio_minimo_prestamo, ask_price_post_remo) BETWEEN 0.2 AND 1.5) AS n_dv_exp,
        APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_oferta_base,     ask_price) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_oferta_base,     ask_price), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS dc_base,
        APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_minimo_prestamo, ask_price) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_minimo_prestamo, ask_price), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS dc_min,
        APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_intermedio,      ask_price) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_intermedio,      ask_price), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS dc_inter,
        APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_maximo_prestamo, ask_price) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_maximo_prestamo, ask_price), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS dc_max,
        COUNTIF(subsidio_aprobado_lider = 'Si') AS n_subsidios,
        SAFE_DIVIDE(COUNTIF(subsidio_aprobado_lider = 'Si'), COUNT(*)) AS tasa_subsidio,
        APPROX_QUANTILES(IF(subsidio_aprobado_lider = 'Si', precio_intermedio - precio_minimo_prestamo, NULL), 100)[OFFSET(50)] AS subsidio_monto_mediano,
        SUM(IF(subsidio_aprobado_lider = 'Si', precio_intermedio - precio_minimo_prestamo, 0)) AS gasto_subsidio_total,
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
        APPROX_QUANTILES(precio_oferta_base, 100)[OFFSET(50)] AS ticket_mediano,
        APPROX_QUANTILES(IF(subsidio_aprobado_lider = 'Si', precio_oferta_base, NULL), 100)[OFFSET(50)] AS ticket_subsidio_mediano,
        COUNTIF(experiment_id = '${EXP_NAME}') AS n_experimento
      FROM filtered
      GROUP BY 1
      ORDER BY 1
    )
    SELECT * FROM series WHERE periodo IS NOT NULL
  `;
  const rows = await query(sql);

  // KPIs scoped to experiment period (2026+)
  const kpiFloor = '2026-01-01';
  const kpiWhere = (whereExtra ? whereExtra + ' AND ' : 'WHERE ') + `${fechaField} >= '${kpiFloor}'`;
  const sqlKpis = `
    WITH ${base},
    filtered AS (SELECT * FROM base ${kpiWhere})
    SELECT
      COUNT(*) AS n_total,
      COUNTIF(subsidio_aprobado_lider = 'Si') AS n_subsidios,
      SAFE_DIVIDE(COUNTIF(subsidio_aprobado_lider = 'Si'), COUNT(*)) AS tasa_subsidio,
      APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_oferta_base, ask_price_post_remo) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_oferta_base, ask_price_post_remo), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS desc_valor_mediano,
      APPROX_QUANTILES(IF(SAFE_DIVIDE(precio_oferta_base, ask_price) BETWEEN 0.2 AND 1.5, 1 - SAFE_DIVIDE(precio_oferta_base, ask_price), NULL), 100 IGNORE NULLS)[OFFSET(50)] AS desc_cliente_mediano,
      APPROX_QUANTILES(IF(subsidio_aprobado_lider = 'Si', precio_intermedio - precio_minimo_prestamo, NULL), 100)[OFFSET(50)] AS subsidio_monto_mediano,
      SUM(IF(subsidio_aprobado_lider = 'Si', precio_intermedio - precio_minimo_prestamo, 0)) AS gasto_total,
      COUNTIF(experiment_id = '${EXP_NAME}') AS n_experimento
    FROM filtered
  `;
  const kpiRows = await query(sqlKpis);
  const k = kpiRows[0] || {};

  return NextResponse.json({
    fecha_tipo: fechaTipo,
    granularidad,
    exp_start: EXP_START,
    kpis: {
      n_total:        Number(k.n_total || 0),
      n_subsidios:    Number(k.n_subsidios || 0),
      tasa_subsidio:  Number(k.tasa_subsidio || 0),
      desc_valor:     Number(k.desc_valor_mediano || 0),
      desc_cliente:   Number(k.desc_cliente_mediano || 0),
      subsidio_monto: Number(k.subsidio_monto_mediano || 0),
      gasto_total:    Number(k.gasto_total || 0),
      n_experimento:  Number(k.n_experimento || 0),
    },
    series: {
      periods:            rows.map(r => r.periodo),
      n_aprobados:        rows.map(r => Number(r.n_aprobados || 0)),
      dv_base:            rows.map(r => r.dv_base),
      dv_min:             rows.map(r => (Number(r.n_dv_exp || 0) >= 5 ? r.dv_min : null)),
      dv_inter:           rows.map(r => (Number(r.n_dv_exp || 0) >= 5 ? r.dv_inter : null)),
      dv_max:             rows.map(r => (Number(r.n_dv_exp || 0) >= 5 ? r.dv_max : null)),
      dc_base:            rows.map(r => r.dc_base),
      dc_min:             rows.map(r => (Number(r.n_dv_exp || 0) >= 5 ? r.dc_min : null)),
      dc_inter:           rows.map(r => (Number(r.n_dv_exp || 0) >= 5 ? r.dc_inter : null)),
      dc_max:             rows.map(r => (Number(r.n_dv_exp || 0) >= 5 ? r.dc_max : null)),
      desc_valor:         rows.map(r => r.dv_base),
      desc_cliente:       rows.map(r => r.dc_base),
      tasa_subsidio:      rows.map(r => r.tasa_subsidio),
      subsidio_monto:     rows.map(r => r.subsidio_monto_mediano),
      gasto_total:        rows.map(r => Number(r.gasto_subsidio_total || 0)),
      gasto_1bolsa:       rows.map(r => Number(r.gasto_1bolsa || 0)),
      gasto_2bolsa:       rows.map(r => Number(r.gasto_2bolsa || 0)),
      n_uso_2bolsa:       rows.map(r => Number(r.n_uso_2bolsa || 0)),
      n_uso_total:        rows.map(r => Number(r.n_uso_total || 0)),
      ticket_mediano:     rows.map(r => r.ticket_mediano),
      ticket_subsidio:    rows.map(r => r.ticket_subsidio_mediano),
      n_experimento:      rows.map(r => Number(r.n_experimento || 0)),
    },
  });
}

// ── GET handler ──────────────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  if (action === 'filters') {
    return handleFilters(searchParams);
  }

  if (action === 'data') {
    return handleData(searchParams);
  }

  return NextResponse.json(
    { error: 'Unknown action. Use ?action=filters or ?action=data' },
    { status: 400 },
  );
}
