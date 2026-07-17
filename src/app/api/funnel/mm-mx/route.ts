/**
 * Funnel MM México API Route — ported from webapp/routers/funnel_mm_mx.py
 *
 * Actions (via ?action=XXX):
 *   filters, etapas, volumen, kpis, share-cat, share-motivo, conv-time,
 *   cosechas, negocios, funnel-compare
 *
 * Key differences vs CO mm route:
 * - TABLE = sellers-main-prod.bi_mx.seguimiento_funnel_mex
 * - No loadComerciales() / CSV join — equipo/prioridad/categoria_comercial are
 *   native columns on the MX funnel table.
 * - _groupExpr supports mes_com/sem_com via loadCycles() (cycles are shared CO/MX).
 * - No BUFFER_EMAILS filtering.
 * - MOTIVO_JOIN against sellers-main-prod.hubspot.deals for razon de venta.
 */
import { NextRequest, NextResponse } from 'next/server';
import { query, cacheClear } from '@/lib/bq';
import { loadCycles } from '@/lib/data';

// ── Constants ────────────────────────────────────────────────────────────────

const TABLE = 'sellers-main-prod.bi_mx.seguimiento_funnel_mex';
const FECHA_INICIO = '2026-01-01';

const EXCLUDE_ETAPAS = [
  'llamadas_comercial',
  'Cita Agendada (hubspot)',
  'Visita Efectuada (hubspot)',
];

const ETAPAS_MM = [
  { key: 'Primer asignacion',               label: 'Asignación',      color: '#7c3aed' },
  { key: 'Cita Agendada',                   label: 'Cita',            color: '#ec4899' },
  { key: 'Visita Efectuada',                label: 'Visita',          color: '#f59e0b' },
  { key: 'Pre-comite validado',             label: 'Pre-comité',      color: '#10b981' },
  { key: 'rechazo Comité',                  label: 'Descartado',      color: '#94a3b8' },
  { key: 'Primer inmueble aprobado',        label: 'Inmueble aprob.', color: '#06b6d4' },
  { key: 'Aprobado General',                label: 'Aprobado',        color: '#22c55e' },
  { key: 'Rechazo Oferta',                  label: 'Rechazó',         color: '#ef4444' },
  { key: 'Acepto Oferta - Pendiente firma', label: 'Aceptó',          color: '#3b82f6' },
  { key: 'Cierre - Comprado',               label: 'Cierre',          color: '#1e40af' },
];

const ETAPA_ASIGNACION = 'Primer asignacion';

const SIN_PRIORIDAD_LABEL = 'Sin prioridad';

const CAT_COLORS: Record<string, string> = {
  'A':             '#7c3aed',
  'B':             '#10b981',
  'C':             '#f59e0b',
  'Sin categoría': '#94a3b8',
};

// Etapas para funnel-compare: (bq_key, display_label, is_exclusion)
const FUNNEL_COMPARE_STAGES: [string, string, boolean][] = [
  ['Primer asignacion',               'Primer Asignación',   false],
  ['Cita Agendada',                   'Cita agendada',       false],
  ['Visita Efectuada',                'Visita efectuada',    false],
  ['Pre-comite validado',             'Pre-comité validado', false],
  ['rechazo Comité',                  'Descartado por comité', true],
  ['Aprobado General',                'Aprobado',            false],
  ['Acepto Oferta - Pendiente firma', 'Aceptó oferta',       false],
  ['Cierre - Comprado',               'Cierre',              false],
];

// Razón de venta MX
const MOTIVO_CATEGORIAS = [
  { key: 'Cambio de Casa', color: '#3b82f6' },
  { key: 'Liquidez',       color: '#ea580c' },
  { key: 'Otros',          color: '#64748b' },
];
const MOTIVO_SIN = 'Sin clasificar';

// Etapas table for negocios: (field, label, bq_valor)
const TABLE_ETAPAS_FIELDS: [string, string, string][] = [
  ['fecha_asignacion', 'F. asignación', 'Primer asignacion'],
  ['fecha_cita',       'F. cita',       'Cita Agendada'],
  ['fecha_visita',     'F. visita',     'Visita Efectuada'],
  ['fecha_precomite',  'F. pre-comité', 'Pre-comite validado'],
  ['fecha_aprobado',   'F. aprobado',   'Aprobado General'],
  ['fecha_acepto',     'F. aceptó',     'Acepto Oferta - Pendiente firma'],
  ['fecha_cierre',     'F. cierre',     'Cierre - Comprado'],
];

// ── SQL helpers ───────────────────────────────────────────────────────────────

/**
 * Expresión SQL de la razón de venta consolidada sobre el alias de deals.
 * Usa razan_de_venta_usuario_gabi_mx; fallback a sub_segmento_seller_mx mappeado;
 * fallback a 'Sin clasificar'.
 */
function _motivoExpr(alias: string = 'd'): string {
  return `COALESCE(
        NULLIF(TRIM(${alias}.razon_de_venta_usuario_gabi_mx), ''),
        CASE TRIM(${alias}.sub_segmento_seller_mx)
          WHEN 'Cambio de Casa - Destino definido, mudanza pendiente'       THEN 'Cambio de Casa'
          WHEN 'Cambio de Casa - Mudados'                                   THEN 'Cambio de Casa'
          WHEN 'Cambio de Casa - Sin destino definido, explorando opciones' THEN 'Cambio de Casa'
          WHEN 'Deuda / problemas financieros'                              THEN 'Liquidez'
          WHEN 'Inversión'                                                  THEN 'Liquidez'
          WHEN 'Liquidez - Necesidad médica'                                THEN 'Liquidez'
          WHEN 'Liquidez - Pago de estudios'                                THEN 'Liquidez'
          WHEN 'Liquidez - Propiedad no habitada'                           THEN 'Liquidez'
          WHEN 'Necesidad médica'                                           THEN 'Liquidez'
          WHEN 'Adulto mayor / dependencia'                                 THEN 'Otros'
          WHEN 'Cambio laboral / ciudad / país'                             THEN 'Otros'
          WHEN 'Con sentencia / convenio'                                   THEN 'Otros'
          WHEN 'Divorcios - Sin sentencia'                                  THEN 'Otros'
          WHEN 'Propiedad no habitada'                                      THEN 'Otros'
          WHEN 'Sin sentencia'                                              THEN 'Otros'
          ELSE NULL
        END,
        '${MOTIVO_SIN}'
      )`;
}

/**
 * Opening CTE for deals_motivo (1 row per nid, deduplicated).
 * Include in queries that need dm.motivo.
 */
function _ctes(): string {
  return (
    'WITH deals_motivo AS (\n' +
    `  SELECT nid, ${_motivoExpr('d')} AS motivo\n` +
    '  FROM `sellers-main-prod.hubspot.deals` d\n' +
    '  QUALIFY ROW_NUMBER() OVER (PARTITION BY nid ORDER BY nid) = 1\n' +
    ')'
  );
}

const MOTIVO_JOIN = 'LEFT JOIN deals_motivo dm ON dm.nid = f.nid';

function _quoteList(items: string[]): string {
  const safe = items.map(i => i.replace(/'/g, "''"));
  return safe.map(s => `'${s}'`).join(', ');
}

function _mapPrioridad(vals: string[]): string[] {
  return vals.map(v => (v === SIN_PRIORIDAD_LABEL ? '' : v));
}

/**
 * Build the WHERE clause for queries against TABLE (alias f).
 * If motivo filter is active, the caller must include _ctes() and MOTIVO_JOIN.
 */
function _buildWhere(
  fechaDesde: string,
  fechaHasta: string,
  equipos?: string[] | null,
  cats?: string[] | null,
  recurrencia?: string[] | null,
  fuentes?: string[] | null,
  areas?: string[] | null,
  motivo?: string[] | null,
): string {
  const conds: string[] = [
    `DATE(f.fecha) >= '${fechaDesde}'`,
    `DATE(f.fecha) <= '${fechaHasta}'`,
    `f.valor NOT IN (${_quoteList(EXCLUDE_ETAPAS)})`,
  ];
  if (equipos?.length) {
    conds.push(`COALESCE(NULLIF(f.equipo, ''), 'Sin equipo') IN (${_quoteList(equipos)})`);
  }
  if (cats?.length) {
    conds.push(
      `COALESCE(NULLIF(f.prioridad_gestion_market_maker, ''), f.categoria_comercial, '') IN (${_quoteList(cats)})`,
    );
  }
  if (recurrencia?.length) {
    conds.push(
      `COALESCE(NORMALIZE(f.flag_recurrecia_gestion, NFC), '') IN (${_quoteList(recurrencia)})`,
    );
  }
  if (fuentes?.length) {
    conds.push(`COALESCE(f.fuente, '') IN (${_quoteList(fuentes)})`);
  }
  if (areas?.length) {
    conds.push(`COALESCE(f.area_metropolitana, '') IN (${_quoteList(areas)})`);
  }
  if (motivo?.length) {
    conds.push(`COALESCE(dm.motivo, '${MOTIVO_SIN}') IN (${_quoteList(motivo)})`);
  }
  return conds.join('\n  AND ');
}

function _groupExpr(granularidad: string, field = 'f.fecha'): [string, string] {
  if (granularidad === 'dia') {
    const g = `FORMAT_DATE('%Y-%m-%d', DATE(${field}))`;
    return [g, g];
  }
  if (granularidad === 'semana') {
    const g = `FORMAT_DATE('%Y-%m-%d', DATE_TRUNC(DATE(${field}), WEEK(MONDAY)))`;
    return [g, g];
  }
  if (granularidad === 'mes_com') {
    const cycles = loadCycles() as Array<Record<string, unknown>>;
    const whens = cycles.map(c => {
      const mesShort = (c.mes as string).slice(0, 3).charAt(0).toUpperCase() + (c.mes as string).slice(1, 3);
      const label = `C${String(c.ciclo).padStart(2, '0')} · ${mesShort} ${String(c.year).slice(2)}`;
      return `WHEN DATE(${field}) BETWEEN '${c.inicio}' AND '${c.fin}' THEN '${label}'`;
    });
    const g = `CASE ${whens.join(' ')} ELSE NULL END`;
    return [g, g];
  }
  if (granularidad === 'sem_com') {
    const cycles = loadCycles() as Array<Record<string, unknown>>;
    const whens: string[] = [];
    for (const c of cycles) {
      for (const s of c.semanas as Array<Record<string, unknown>>) {
        const label = `C${String(c.ciclo).padStart(2, '0')}-S${String(s.num).padStart(2, '0')}`;
        whens.push(`WHEN DATE(${field}) BETWEEN '${s.inicio}' AND '${s.fin}' THEN '${label}'`);
      }
    }
    const g = `CASE ${whens.join(' ')} ELSE NULL END`;
    return [g, g];
  }
  // Default: mes
  const g = `FORMAT_DATE('%Y-%m', DATE(${field}))`;
  return [g, g];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function getList(params: URLSearchParams, key: string): string[] | null {
  const vals = params.getAll(key);
  return vals.length ? vals : null;
}

function getString(params: URLSearchParams, key: string, def: string): string {
  return params.get(key) || def;
}

function getInt(params: URLSearchParams, key: string, def: number): number {
  const v = params.get(key);
  return v ? parseInt(v) || def : def;
}

// ── Action handlers ──────────────────────────────────────────────────────────

async function handleFilters(params: URLSearchParams) {
  const fechaDesde = getString(params, 'fecha_desde', FECHA_INICIO);
  const fechaHasta = getString(params, 'fecha_hasta', today());
  const excl = _quoteList(EXCLUDE_ETAPAS);
  const sql = `
    WITH base AS (
      SELECT
        COALESCE(NULLIF(f.equipo, ''), 'Sin equipo')                                       AS equipo,
        COALESCE(NULLIF(f.prioridad_gestion_market_maker, ''), f.categoria_comercial, '')  AS cat,
        COALESCE(NULLIF(f.prioridad_gestion_market_maker, ''), '')                         AS prioridad_mm,
        COALESCE(NORMALIZE(f.flag_recurrecia_gestion, NFC), '')                            AS recurrencia,
        COALESCE(f.fuente, '')                                                             AS fuente,
        COALESCE(f.area_metropolitana, '')                                                 AS area,
        FORMAT_DATE('%Y-%m', DATE(f.fecha))                                                AS mes
      FROM \`${TABLE}\` f
      WHERE DATE(f.fecha) >= '${fechaDesde}'
        AND DATE(f.fecha) <= '${fechaHasta}'
        AND f.valor NOT IN (${excl})
    )
    SELECT
      ARRAY(SELECT DISTINCT equipo      FROM base WHERE equipo      != '' ORDER BY equipo)      AS equipos,
      ARRAY(SELECT DISTINCT cat         FROM base WHERE cat         != '' ORDER BY cat)         AS cats,
      ARRAY(SELECT DISTINCT IF(prioridad_mm = '', '${SIN_PRIORIDAD_LABEL}', prioridad_mm) FROM base ORDER BY 1) AS prioridades_mm,
      ARRAY(SELECT DISTINCT recurrencia FROM base WHERE recurrencia != '' ORDER BY recurrencia) AS recurrencias,
      ARRAY(SELECT DISTINCT fuente      FROM base WHERE fuente      != '' ORDER BY fuente)      AS fuentes,
      ARRAY(SELECT DISTINCT area        FROM base WHERE area        != '' ORDER BY area)        AS areas,
      ARRAY(SELECT DISTINCT mes         FROM base WHERE mes         != '' ORDER BY mes DESC)    AS meses
    `;
  const rows = await query(sql);
  const r = rows[0] || {};
  const clean = (arr: unknown) => {
    const a = (arr as string[] | null) || [];
    return a.filter(x => x && x !== '' && x !== 'Sin equipo' && x !== 'Sin categoría').sort();
  };
  return NextResponse.json({
    equipos:        clean(r.equipos),
    cats:           clean(r.cats),
    prioridades_mm: clean(r.prioridades_mm),
    recurrencias:   clean(r.recurrencias),
    fuentes:        clean(r.fuentes),
    areas:          clean(r.areas),
    // Razón de venta: static categories + 'Sin clasificar'
    motivos:        [...MOTIVO_CATEGORIAS.map(c => c.key), MOTIVO_SIN],
    // Available months (YYYY-MM), desc — for funnel-compare
    meses:          ((r.meses as string[] | null) || []).filter(Boolean),
  });
}

async function handleEtapas() {
  const items = ETAPAS_MM.map(e => ({ key: e.key, label: e.label }));
  return NextResponse.json(items);
}

async function handleVolumen(params: URLSearchParams) {
  const granularidad = getString(params, 'granularidad', 'mes');
  const fechaDesde = getString(params, 'fecha_desde', FECHA_INICIO);
  const fechaHasta = getString(params, 'fecha_hasta', today());
  const equipo = getList(params, 'equipo');
  const cat = getList(params, 'cat');
  const recurrencia = getList(params, 'recurrencia');
  const fuente = getList(params, 'fuente');
  const area = getList(params, 'area');
  const motivo = getList(params, 'motivo');

  const rec = recurrencia ? _mapPrioridad(recurrencia) : null;
  const where = _buildWhere(fechaDesde, fechaHasta, equipo, cat, rec?.length ? rec : null, fuente, area, motivo);
  const [groupExpr, orderExpr] = _groupExpr(granularidad);

  const sql = `
    ${_ctes()}
    SELECT
      ${groupExpr} AS periodo,
      f.valor      AS etapa,
      COUNT(DISTINCT f.nid) AS nids
    FROM \`${TABLE}\` f
    ${MOTIVO_JOIN}
    WHERE ${where}
    GROUP BY 1, 2
    ORDER BY ${orderExpr}
    `;
  let rows = await query(sql);
  rows = rows.filter(r => r.periodo != null);

  const periodos = [...new Set(rows.map(r => r.periodo as string))].sort();
  const byEtapa: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const etapa = r.etapa as string;
    if (!byEtapa[etapa]) byEtapa[etapa] = {};
    byEtapa[etapa][r.periodo as string] = Number(r.nids);
  }

  const datasets = [];
  for (const et of ETAPAS_MM) {
    if (!byEtapa[et.key]) continue;
    const data = periodos.map(p => byEtapa[et.key][p] || 0);
    datasets.push({
      label: et.label,
      color: et.color,
      data,
      etapa_key: et.key,
    });
  }

  return NextResponse.json({
    labels: periodos,
    datasets,
    granularidad,
  });
}

async function handleKpis(params: URLSearchParams) {
  const equipo = getList(params, 'equipo');
  const cat = getList(params, 'cat');
  const recurrencia = getList(params, 'recurrencia');
  const fuente = getList(params, 'fuente');
  const area = getList(params, 'area');
  const motivo = getList(params, 'motivo');

  const rec = recurrencia ? _mapPrioridad(recurrencia) : null;

  const hoy = new Date();
  const inicioActual = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const inicioAnterior = new Date(inicioActual);
  inicioAnterior.setDate(inicioAnterior.getDate() - 1);
  inicioAnterior.setDate(1);
  const dayDiff = Math.floor((hoy.getTime() - inicioActual.getTime()) / (1000 * 60 * 60 * 24));
  const finAnterior = new Date(inicioAnterior);
  finAnterior.setDate(inicioAnterior.getDate() + dayDiff);

  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const makeWhere = (start: string, end: string) =>
    _buildWhere(start, end, equipo, cat, rec?.length ? rec : null, fuente, area, motivo);

  const sql = `
    ${_ctes()}
    SELECT 'actual' AS periodo, f.valor AS etapa, COUNT(DISTINCT f.nid) AS nids
    FROM \`${TABLE}\` f
    ${MOTIVO_JOIN}
    WHERE ${makeWhere(fmt(inicioActual), fmt(hoy))}
    GROUP BY 1, 2
    UNION ALL
    SELECT 'anterior' AS periodo, f.valor AS etapa, COUNT(DISTINCT f.nid) AS nids
    FROM \`${TABLE}\` f
    ${MOTIVO_JOIN}
    WHERE ${makeWhere(fmt(inicioAnterior), fmt(finAnterior))}
    GROUP BY 1, 2
    `;
  const rows = await query(sql);
  const actual: Record<string, number> = {};
  const anterior: Record<string, number> = {};
  for (const r of rows) {
    const target = r.periodo === 'actual' ? actual : anterior;
    target[r.etapa as string] = Number(r.nids);
  }

  const kpisCfg = [
    { label: 'Asignaciones', keys: ['Primer asignacion'] },
    { label: 'Citas',        keys: ['Cita Agendada'] },
    { label: 'Visitas',      keys: ['Visita Efectuada'] },
    { label: 'Pre-comité',   keys: ['Pre-comite validado'] },
    { label: 'Aprobados',    keys: ['Aprobado General'] },
    { label: 'Cierres',      keys: ['Cierre - Comprado'] },
  ];

  const NOMBRES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const labelActual   = `${NOMBRES[inicioActual.getMonth()]} ${inicioActual.getFullYear()}`;
  const labelAnterior = `${NOMBRES[inicioAnterior.getMonth()]} ${inicioAnterior.getFullYear()}`;
  const mtdLabel = `${hoy.getDate()} ${NOMBRES[hoy.getMonth()]}`;

  const kpiRows = kpisCfg.map(k => {
    const act = k.keys.reduce((s, x) => s + (actual[x] || 0), 0);
    const ant = k.keys.reduce((s, x) => s + (anterior[x] || 0), 0);
    const delta = ant > 0 ? ((act - ant) / ant) * 100 : null;
    return {
      label: k.label,
      actual: act,
      anterior: ant,
      delta,
      mtd_label: mtdLabel,
      // Metadata repeated on each row so the template can build the MTD footer
      // from kpis[0] while consuming a plain array (parity with inmo-mx).
      label_actual: labelActual,
      label_anterior: labelAnterior,
      dia_corte: hoy.getDate(),
    };
  });

  // Plain array — matches inmo-mx handleKpis and the template's kpis.map(...).
  return NextResponse.json(kpiRows);
}

async function handleShareCat(params: URLSearchParams) {
  const granularidad = getString(params, 'granularidad', 'mes');
  const fechaDesde = getString(params, 'fecha_desde', FECHA_INICIO);
  const fechaHasta = getString(params, 'fecha_hasta', today());
  const equipo = getList(params, 'equipo');
  const cat = getList(params, 'cat');
  const recurrencia = getList(params, 'recurrencia');
  const fuente = getList(params, 'fuente');
  const area = getList(params, 'area');
  const motivo = getList(params, 'motivo');

  const rec = recurrencia ? _mapPrioridad(recurrencia) : null;
  const where = _buildWhere(fechaDesde, fechaHasta, equipo, cat, rec?.length ? rec : null, fuente, area, motivo);
  const [groupExpr] = _groupExpr(granularidad);

  const sql = `
    ${_ctes()}
    SELECT
      ${groupExpr} AS periodo,
      COALESCE(NULLIF(f.prioridad_gestion_market_maker, ''), f.categoria_comercial, 'Sin categoría') AS categoria,
      COUNT(DISTINCT f.nid) AS nids
    FROM \`${TABLE}\` f
    ${MOTIVO_JOIN}
    WHERE ${where}
      AND f.valor = '${ETAPA_ASIGNACION}'
    GROUP BY 1, 2
    ORDER BY 1, 2
    `;
  let rows = await query(sql);
  rows = rows.filter(r => r.periodo != null);

  const donut: Record<string, number> = {};
  const byPeriod: Record<string, Record<string, number>> = {};
  const catsSeen = new Set<string>();
  const periodosSet = new Set<string>();

  for (const r of rows) {
    const c = (r.categoria as string) || 'Sin categoría';
    catsSeen.add(c);
    periodosSet.add(r.periodo as string);
    donut[c] = (donut[c] || 0) + Number(r.nids);
    if (!byPeriod[r.periodo as string]) byPeriod[r.periodo as string] = {};
    byPeriod[r.periodo as string][c] = Number(r.nids);
  }

  const order = ['A', 'B', 'C', ...[...catsSeen].filter(c => !['A', 'B', 'C', 'Sin categoría'].includes(c)).sort(), 'Sin categoría'];
  const catsOrdered = order.filter(c => catsSeen.has(c));
  const periodosOrdered = [...periodosSet].sort();

  const donutValues = catsOrdered.map(c => donut[c] || 0);
  const donutColors = catsOrdered.map(c => CAT_COLORS[c] || '#94a3b8');
  const donutTotal = donutValues.reduce((a, b) => a + b, 0);

  const barsDatasets = catsOrdered.map(c => ({
    label: c,
    color: CAT_COLORS[c] || '#94a3b8',
    data: periodosOrdered.map(p => (byPeriod[p] || {})[c] || 0),
  }));

  return NextResponse.json({
    donut: {
      labels: catsOrdered,
      values: donutValues,
      colors: donutColors,
      total: donutTotal,
    },
    bars: {
      labels: periodosOrdered,
      datasets: barsDatasets,
    },
  });
}

async function handleShareMotivo(params: URLSearchParams) {
  const granularidad = getString(params, 'granularidad', 'mes');
  const fechaDesde = getString(params, 'fecha_desde', FECHA_INICIO);
  const fechaHasta = getString(params, 'fecha_hasta', today());
  const equipo = getList(params, 'equipo');
  const cat = getList(params, 'cat');
  const recurrencia = getList(params, 'recurrencia');
  const fuente = getList(params, 'fuente');
  const area = getList(params, 'area');
  const motivo = getList(params, 'motivo');

  const rec = recurrencia ? _mapPrioridad(recurrencia) : null;
  const where = _buildWhere(fechaDesde, fechaHasta, equipo, cat, rec?.length ? rec : null, fuente, area, motivo);
  const [groupExpr] = _groupExpr(granularidad);

  const sql = `
    ${_ctes()}
    SELECT
      ${groupExpr} AS periodo,
      COALESCE(dm.motivo, '${MOTIVO_SIN}') AS categoria,
      COUNT(DISTINCT f.nid) AS nids
    FROM \`${TABLE}\` f
    ${MOTIVO_JOIN}
    WHERE ${where}
      AND f.valor = '${ETAPA_ASIGNACION}'
    GROUP BY 1, 2
    ORDER BY 1, 2
    `;
  let rows = await query(sql);
  rows = rows.filter(r => r.periodo != null);

  const donut: Record<string, number> = {};
  const byPeriod: Record<string, Record<string, number>> = {};
  const catsSeen = new Set<string>();
  const periodosSet = new Set<string>();

  for (const r of rows) {
    const c = (r.categoria as string) || MOTIVO_SIN;
    catsSeen.add(c);
    periodosSet.add(r.periodo as string);
    donut[c] = (donut[c] || 0) + Number(r.nids);
    if (!byPeriod[r.periodo as string]) byPeriod[r.periodo as string] = {};
    byPeriod[r.periodo as string][c] = Number(r.nids);
  }

  const colorByCat: Record<string, string> = {};
  for (const mc of MOTIVO_CATEGORIAS) colorByCat[mc.key] = mc.color;
  colorByCat[MOTIVO_SIN] = '#cbd5e1';

  const knownOrder = [...MOTIVO_CATEGORIAS.map(mc => mc.key), MOTIVO_SIN];
  const extra = [...catsSeen].filter(c => !knownOrder.includes(c)).sort();
  const catsOrdered = [...knownOrder.filter(c => catsSeen.has(c)), ...extra];
  const periodosOrdered = [...periodosSet].sort();

  const donutValues = catsOrdered.map(c => donut[c] || 0);
  const donutColors = catsOrdered.map(c => colorByCat[c] || '#94a3b8');
  const donutTotal = donutValues.reduce((a, b) => a + b, 0);

  const barsDatasets = catsOrdered.map(c => ({
    label: c,
    color: colorByCat[c] || '#94a3b8',
    data: periodosOrdered.map(p => (byPeriod[p] || {})[c] || 0),
  }));

  return NextResponse.json({
    donut: {
      labels: catsOrdered,
      values: donutValues,
      colors: donutColors,
      total: donutTotal,
    },
    bars: {
      labels: periodosOrdered,
      datasets: barsDatasets,
    },
  });
}

async function handleConvTime(params: URLSearchParams) {
  const granularidad = getString(params, 'granularidad', 'mes');
  const fechaDesde = getString(params, 'fecha_desde', FECHA_INICIO);
  const fechaHasta = getString(params, 'fecha_hasta', today());
  let num = getList(params, 'num');
  let den = getList(params, 'den');
  const equipo = getList(params, 'equipo');
  const cat = getList(params, 'cat');
  const recurrencia = getList(params, 'recurrencia');
  const fuente = getList(params, 'fuente');
  const area = getList(params, 'area');
  const motivo = getList(params, 'motivo');

  if (!num) num = ['Cierre - Comprado'];
  if (!den) den = [ETAPA_ASIGNACION];

  const rec = recurrencia ? _mapPrioridad(recurrencia) : null;
  const where = _buildWhere(fechaDesde, fechaHasta, equipo, cat, rec?.length ? rec : null, fuente, area, motivo);
  const [groupF] = _groupExpr(granularidad);

  const allEtapas = [...new Set([...num, ...den])].sort();

  // Per-numerator columns (for multi-series support when num has 2+ etapas)
  const numCols = num
    .map((e, i) => `COUNT(DISTINCT IF(etapa = '${e.replace(/'/g, "''")}', cid, NULL)) AS num_${i}`)
    .join(',\n      ');

  const sql = `
    ${_ctes()},
    events AS (
      SELECT ${groupF} AS periodo, f.valor AS etapa, CAST(f.nid AS STRING) AS cid
      FROM \`${TABLE}\` f
      ${MOTIVO_JOIN}
      WHERE ${where}
        AND f.valor IN (${_quoteList(allEtapas)})
    )
    SELECT
      periodo,
      COUNT(DISTINCT IF(etapa IN (${_quoteList(num)}), cid, NULL)) AS num,
      COUNT(DISTINCT IF(etapa IN (${_quoteList(den)}), cid, NULL)) AS den,
      ${numCols}
    FROM events
    WHERE periodo IS NOT NULL
    GROUP BY 1
    ORDER BY 1
    `;
  let rows = await query(sql);
  rows = rows.filter(r => r.periodo != null);

  const labels = rows.map(r => r.periodo as string);
  const nums = rows.map(r => Number(r.num));
  const dens = rows.map(r => Number(r.den));
  const cvrs = nums.map((n, i) => (dens[i] > 0 ? (n / dens[i]) * 100 : null));
  const totalN = nums.reduce((a, b) => a + b, 0);
  const totalD = dens.reduce((a, b) => a + b, 0);

  const numSeries = num.map((etapa, i) => {
    const vals = rows.map(r => Number(r[`num_${i}`] ?? 0));
    const cvr = vals.map((v, k) => (dens[k] > 0 ? (v / dens[k]) * 100 : null));
    const tot = vals.reduce((a, b) => a + b, 0);
    return { etapa, num: vals, cvr, total_num: tot, total_cvr: totalD > 0 ? (tot / totalD) * 100 : null };
  });

  return NextResponse.json({
    labels,
    num: nums,
    den: dens,
    cvr: cvrs,
    total_num: totalN,
    total_den: totalD,
    total_cvr: totalD > 0 ? (totalN / totalD) * 100 : null,
    num_etapas: num,
    den_etapas: den,
    num_series: numSeries,
  });
}

async function handleCosechas(params: URLSearchParams) {
  const origen = getString(params, 'origen', 'Primer asignacion');
  const destino = getString(params, 'destino', 'Cita Agendada');
  const granularidad = getString(params, 'granularidad', 'semana');
  const bucket = getString(params, 'bucket', 'iso');
  const conteo = getString(params, 'conteo', 'cohorte');
  const fechaDesde = getString(params, 'fecha_desde', FECHA_INICIO);
  const fechaHasta = getString(params, 'fecha_hasta', today());
  const equipo = getList(params, 'equipo');
  const cat = getList(params, 'cat');
  const recurrencia = getList(params, 'recurrencia');
  const fuente = getList(params, 'fuente');
  const area = getList(params, 'area');
  const motivo = getList(params, 'motivo');

  const unit = granularidad === 'semana' ? 'WEEK(MONDAY)' : 'MONTH';
  const fmt = granularidad === 'semana' ? "'%Y-%m-%d'" : "'%Y-%m'";

  let offsetExpr: string;
  if (bucket === 'dias') {
    const daysPerBucket = granularidad === 'semana' ? 7 : 30;
    offsetExpr = `DIV(DATE_DIFF(d.fecha_destino, o.fecha_origen, DAY), ${daysPerBucket})`;
  } else {
    const diffUnit = granularidad === 'semana' ? 'WEEK' : 'MONTH';
    offsetExpr = `DATE_DIFF(d.fecha_destino, o.fecha_origen, ${diffUnit})`;
  }

  const rec = recurrencia ? _mapPrioridad(recurrencia) : null;
  const whereOrigen = _buildWhere(fechaDesde, fechaHasta, equipo, cat, rec?.length ? rec : null, fuente, area, motivo);
  const safeOrigen = origen.replace(/'/g, "''");
  const safeDestino = destino.replace(/'/g, "''");

  let origenCte: string;
  let cohorteExpr: string;

  if (conteo === 'funnel') {
    origenCte = `
        origen AS (
          SELECT f.nid, DATE_TRUNC(DATE(f.fecha), ${unit}) AS cohorte_date, MIN(DATE(f.fecha)) AS fecha_origen
          FROM \`${TABLE}\` f
          ${MOTIVO_JOIN}
          WHERE ${whereOrigen}
            AND f.valor = '${safeOrigen}'
          GROUP BY 1, 2
        )`;
    cohorteExpr = `FORMAT_DATE(${fmt}, o.cohorte_date)`;
  } else {
    origenCte = `
        origen AS (
          SELECT f.nid, MIN(DATE(f.fecha)) AS fecha_origen
          FROM \`${TABLE}\` f
          ${MOTIVO_JOIN}
          WHERE ${whereOrigen}
            AND f.valor = '${safeOrigen}'
          GROUP BY f.nid
        )`;
    cohorteExpr = `FORMAT_DATE(${fmt}, DATE_TRUNC(o.fecha_origen, ${unit}))`;
  }

  const sql = `
    ${_ctes()},
    ${origenCte},
    destino AS (
      SELECT nid, MIN(DATE(fecha)) AS fecha_destino
      FROM \`${TABLE}\`
      WHERE valor = '${safeDestino}'
      GROUP BY nid
    ),
    joined AS (
      SELECT
        ${cohorteExpr} AS cohorte,
        ${offsetExpr} AS offset_unit
      FROM origen o
      LEFT JOIN destino d ON d.nid = o.nid AND d.fecha_destino >= o.fecha_origen
    )
    SELECT cohorte, offset_unit, COUNT(*) AS n
    FROM joined
    WHERE cohorte IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1, 2
    `;
  const rows = await query(sql);

  const cohortes: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const c = r.cohorte as string;
    const off = r.offset_unit != null ? String(r.offset_unit) : '__null__';
    if (!cohortes[c]) cohortes[c] = {};
    cohortes[c][off] = Number(r.n);
  }

  const cohortesOrdered = Object.keys(cohortes).sort();
  let maxOffset = 0;
  for (const v of Object.values(cohortes)) {
    for (const o of Object.keys(v)) {
      if (o !== '__null__') {
        const n = parseInt(o);
        if (n > maxOffset) maxOffset = n;
      }
    }
  }

  const matrix = cohortesOrdered.map(c => {
    const buckets = cohortes[c];
    const total = Object.values(buckets).reduce((a, b) => a + b, 0);
    const byOffsetCounts = Array.from({ length: maxOffset + 1 }, (_, i) => buckets[String(i)] || 0);
    const noReached = buckets['__null__'] || 0;
    const alcanzaron = total - noReached;
    const byOffsetPct = byOffsetCounts.map(v => (total > 0 ? (v / total) * 100 : 0));
    const byOffsetShare = byOffsetCounts.map(v => (alcanzaron > 0 ? (v / alcanzaron) * 100 : 0));

    const cumCounts: number[] = [];
    let cum = 0;
    for (const v of byOffsetCounts) {
      cum += v;
      cumCounts.push(cum);
    }
    const cumPct = cumCounts.map(v => (total > 0 ? (v / total) * 100 : 0));
    const cumShare = cumCounts.map(v => (alcanzaron > 0 ? (v / alcanzaron) * 100 : 0));

    return {
      cohorte: c,
      total,
      alcanzaron,
      no_alcanzaron: noReached,
      counts: byOffsetCounts,
      pct: byOffsetPct,
      share: byOffsetShare,
      cum_counts: cumCounts,
      cum_pct: cumPct,
      cum_share: cumShare,
    };
  });

  const prefix = granularidad === 'semana' ? 'S' : 'M';
  const offsetLabels = Array.from({ length: maxOffset + 1 }, (_, i) => `${prefix}${i}`);
  let offsetRanges: string[] | null = null;
  if (bucket === 'dias') {
    const step = granularidad === 'semana' ? 7 : 30;
    offsetRanges = Array.from({ length: maxOffset + 1 }, (_, i) => `${i * step}-${(i + 1) * step - 1}d`);
  }

  return NextResponse.json({
    origen,
    destino,
    granularidad,
    bucket,
    conteo,
    offset_labels: offsetLabels,
    offset_ranges: offsetRanges,
    rows: matrix,
  });
}

async function handleNegocios(params: URLSearchParams) {
  const fechaDesde = getString(params, 'fecha_desde', FECHA_INICIO);
  const fechaHasta = getString(params, 'fecha_hasta', today());
  const equipo = getList(params, 'equipo');
  const cat = getList(params, 'cat');
  const recurrencia = getList(params, 'recurrencia');
  const fuente = getList(params, 'fuente');
  const area = getList(params, 'area');
  const motivo = getList(params, 'motivo');
  const etapa = params.get('etapa');
  const search = params.get('search');
  const page = getInt(params, 'page', 1);
  const pageSize = Math.min(getInt(params, 'page_size', 50), 200);

  const rec = recurrencia ? _mapPrioridad(recurrencia) : null;
  // Wide date range for WHERE; actual date filtering happens via HAVING
  const where = _buildWhere('2020-01-01', today(), equipo, cat, rec?.length ? rec : null, fuente, area, motivo);

  const validFields = new Set(TABLE_ETAPAS_FIELDS.map(([f]) => f));
  const dateField = etapa && validFields.has(etapa) ? etapa : 'fecha_asignacion';

  const selectEtapas = TABLE_ETAPAS_FIELDS.map(([field, , bqEtapa]) => {
    if (bqEtapa !== 'Aprobado General') {
      return `MIN(CASE WHEN f.valor = '${bqEtapa}' THEN CAST(f.fecha AS STRING) END) AS ${field}`;
    }
    // Aprobado General also catches Primer inmueble aprobado
    return `MIN(CASE WHEN f.valor IN ('Aprobado General', 'Primer inmueble aprobado') THEN CAST(f.fecha AS STRING) END) AS ${field}`;
  }).join(',\n      ');

  let searchClause = '';
  if (search) {
    const safe = search.replace(/'/g, "''");
    searchClause = `AND CAST(f.nid AS STRING) LIKE '%${safe}%'`;
  }

  const havingClauses = [`${dateField} IS NOT NULL`];
  if (fechaDesde) havingClauses.push(`SUBSTR(${dateField}, 1, 10) >= '${fechaDesde}'`);
  if (fechaHasta) havingClauses.push(`SUBSTR(${dateField}, 1, 10) <= '${fechaHasta}'`);
  const havingSql = havingClauses.join(' AND ');

  const cohortCte = `
    cohort AS (
      SELECT
        CAST(f.nid AS STRING) AS nid,
        ANY_VALUE(COALESCE(NULLIF(f.equipo, ''), 'Sin equipo'))                                       AS equipo,
        ANY_VALUE(COALESCE(NULLIF(f.prioridad_gestion_market_maker, ''), f.categoria_comercial, ''))  AS categoria,
        ANY_VALUE(COALESCE(f.fuente, ''))                                                             AS fuente,
        ANY_VALUE(COALESCE(f.area_metropolitana, ''))                                                 AS area_metropolitana,
        ANY_VALUE(dm.motivo)                                                                          AS motivo_cat,
        ${selectEtapas}
      FROM \`${TABLE}\` f
      ${MOTIVO_JOIN}
      WHERE ${where}
        ${searchClause}
      GROUP BY 1
      HAVING ${havingSql}
    )`;

  const baseSql = `
    ${_ctes()},
    ${cohortCte}
    SELECT * FROM cohort
    ORDER BY ${dateField} DESC
    LIMIT ${pageSize}
    OFFSET ${(page - 1) * pageSize}
    `;
  const rows = await query(baseSql);

  const countSql = `
    ${_ctes()},
    ${cohortCte}
    SELECT COUNT(*) AS total FROM cohort
    `;
  const countRows = await query(countSql);
  const total = Number(countRows[0]?.total || 0);

  // Trim timestamps to YYYY-MM-DD
  for (const r of rows) {
    for (const [f] of TABLE_ETAPAS_FIELDS) {
      const v = r[f];
      if (v && typeof v === 'string') {
        r[f] = v.slice(0, 10);
      }
    }
  }

  return NextResponse.json({
    rows,
    total,
    page,
    page_size: pageSize,
    etapas: TABLE_ETAPAS_FIELDS.map(([f, l]) => ({ field: f, label: l })),
    date_field: dateField,
  });
}

async function handleFunnelCompare(params: URLSearchParams) {
  const mes = params.get('mes') ?? null; // 'YYYY-MM' or null for all time
  const equipo = getList(params, 'equipo');
  const cat = getList(params, 'cat');
  const fuente = getList(params, 'fuente');
  const area = getList(params, 'area');
  const motivo = getList(params, 'motivo');

  const label = mes ?? 'Todo';

  // WHERE for the base asignacion pool (no date bounds — cohort defined by mes filter below)
  const whereAsig = _buildWhere(FECHA_INICIO, today(), equipo, cat, null, fuente, area, motivo);
  const cohortWhere = mes ? `AND FORMAT_DATE('%Y-%m', fecha_origen) = '${mes.replace(/'/g, "''")}'` : '';

  const stageKeys = FUNNEL_COMPARE_STAGES.map(([k]) => k);

  const sql = `
    ${_ctes()},
    asig AS (
      SELECT f.nid, MIN(DATE(f.fecha)) AS fecha_origen
      FROM \`${TABLE}\` f
      ${MOTIVO_JOIN}
      WHERE ${whereAsig}
        AND f.valor = '${ETAPA_ASIGNACION}'
      GROUP BY f.nid
    ),
    cohort AS (
      SELECT nid, fecha_origen FROM asig
      WHERE TRUE ${cohortWhere}
    ),
    stage_min AS (
      SELECT f.nid, f.valor AS etapa, MIN(DATE(f.fecha)) AS fecha_etapa
      FROM \`${TABLE}\` f
      JOIN cohort co ON co.nid = f.nid
      WHERE f.valor IN (${_quoteList(stageKeys)})
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
    `;
  const rows = await query(sql);
  const byEtapa: Record<string, number> = {};
  for (const r of rows) {
    byEtapa[r.etapa as string] = Number(r.nids);
  }

  const first = byEtapa[ETAPA_ASIGNACION] || 0;
  const stages = [];
  let prevN: number | null = null;

  for (const [key, lbl, excl] of FUNNEL_COMPARE_STAGES) {
    const n = byEtapa[key] || 0;
    const pctFirst = first > 0 ? (n / first) * 100 : 0;
    const pctPrev = prevN != null && prevN > 0 ? (n / prevN) * 100 : null;
    stages.push({
      key,
      label: lbl,
      exclusion: excl,
      nids: n,
      pct_first: pctFirst,
      pct_prev: pctPrev,
    });
    // pct_prev advances only against progression stages (not exclusions)
    if (!excl) {
      prevN = n;
    }
  }

  return NextResponse.json({ mes: label, total: first, stages });
}

// ── Route handlers ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const action = searchParams.get('action') ?? '';

  try {
    switch (action) {
      case 'filters':        return await handleFilters(searchParams);
      case 'etapas':         return await handleEtapas();
      case 'volumen':        return await handleVolumen(searchParams);
      case 'kpis':           return await handleKpis(searchParams);
      case 'share-cat':      return await handleShareCat(searchParams);
      case 'share-motivo':   return await handleShareMotivo(searchParams);
      case 'conv-time':      return await handleConvTime(searchParams);
      case 'cosechas':       return await handleCosechas(searchParams);
      case 'negocios':       return await handleNegocios(searchParams);
      case 'funnel-compare': return await handleFunnelCompare(searchParams);
      default:               return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (err) {
    console.error(`[funnel/mm-mx] action=${action} error:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function POST() {
  cacheClear();
  return NextResponse.json({ ok: true });
}
