/**
 * Funnel Inmo MX API Route — ported from webapp/routers/funnel_inmo_mx.py
 *
 * Source table: sellers-main-prod.bi_mx.seguimiento_inmobiliaria_mex_copia
 *
 * ⚠️  FAN-OUT: the table duplicates rows massively per nid×etapa.
 *     COUNT(*) is garbage — always use COUNT(DISTINCT nid).
 *
 * Actions (via ?action=XXX):
 *   filters, etapas, volumen, kpis, conv-time, cosechas, negocios, funnel-compare
 */
import { NextRequest, NextResponse } from 'next/server';
import { query, cacheClear } from '@/lib/bq';

// ── Constants ────────────────────────────────────────────────────────────────

const TABLE = 'sellers-main-prod.bi_mx.seguimiento_inmobiliaria_mex_copia';
const FECHA_INICIO = '2026-01-01';
const ETAPA_ASIGNACION = 'Asignados';

const ETAPAS_INMO = [
  { key: 'Asignados',            label: 'Asignados',               color: '#4285F4' },
  { key: 'contactado',           label: 'Contactados',             color: '#FF6D00' },
  { key: 'oferta_aceptada_gabi', label: 'Oferta aceptada',         color: '#9C27B0' },
  { key: 'En legal',             label: 'Contrato en elaboración', color: '#34A853' },
  { key: 'Firma',                label: 'Firmas',                  color: '#00BCD4' },
  { key: 'captaciones_3_checks', label: 'Captaciones 3 checks',    color: '#00897B' },
];

const FUNNEL_COMPARE_STAGES: [string, string, boolean][] = ETAPAS_INMO.map(
  e => [e.key, e.label, false],
);

// (field alias, display label, BQ valor value)
const TABLE_ETAPAS_FIELDS: [string, string, string][] = [
  ['fecha_asignado', 'F. asignado',      'Asignados'],
  ['fecha_contacto', 'F. contacto',      'contactado'],
  ['fecha_aceptada', 'F. oferta acept.', 'oferta_aceptada_gabi'],
  ['fecha_contrato', 'F. contrato',      'En legal'],
  ['fecha_firmas',   'F. firmas',        'Firma'],
  ['fecha_captado',  'F. captación',     'captaciones_3_checks'],
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function quoteList(items: string[]): string {
  return items.map(i => `'${i.replace(/'/g, "''")}'`).join(', ');
}

/**
 * Build a WHERE clause for the Inmo MX table.
 * Table alias assumed to be `f`.
 * Filters: equipo (f.equipo_sellers), fuente (f.fuente), area (f.area_metropolitana).
 * No category / priority columns exist in this table.
 */
function buildWhere(
  fechaDesde: string,
  fechaHasta: string,
  equipos?: string[] | null,
  fuentes?: string[] | null,
  areas?: string[] | null,
): string {
  const conds: string[] = [
    `DATE(f.fecha) >= '${fechaDesde}'`,
    `DATE(f.fecha) <= '${fechaHasta}'`,
  ];
  if (equipos?.length) {
    conds.push(`COALESCE(NULLIF(f.equipo_sellers, ''), 'Sin equipo') IN (${quoteList(equipos)})`);
  }
  if (fuentes?.length) {
    conds.push(`COALESCE(f.fuente, '') IN (${quoteList(fuentes)})`);
  }
  if (areas?.length) {
    conds.push(`COALESCE(f.area_metropolitana, '') IN (${quoteList(areas)})`);
  }
  return conds.join('\n  AND ');
}

function groupExpr(granularidad: string, field = 'f.fecha'): [string, string] {
  if (granularidad === 'dia') {
    const g = `FORMAT_DATE('%Y-%m-%d', DATE(${field}))`;
    return [g, g];
  }
  if (granularidad === 'semana') {
    const g = `FORMAT_DATE('%Y-%m-%d', DATE_TRUNC(DATE(${field}), WEEK(MONDAY)))`;
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

  const sql = `
    WITH base AS (
      SELECT
        COALESCE(NULLIF(f.equipo_sellers, ''), 'Sin equipo') AS equipo,
        COALESCE(f.fuente, '')                               AS fuente,
        COALESCE(f.area_metropolitana, '')                   AS area
      FROM \`${TABLE}\` f
      WHERE DATE(f.fecha) >= '${fechaDesde}' AND DATE(f.fecha) <= '${fechaHasta}'
    )
    SELECT
      ARRAY(SELECT DISTINCT equipo FROM base WHERE equipo != '' ORDER BY equipo) AS equipos,
      ARRAY(SELECT DISTINCT fuente FROM base WHERE fuente != '' ORDER BY fuente) AS fuentes,
      ARRAY(SELECT DISTINCT area   FROM base WHERE area   != '' ORDER BY area)   AS areas
    `;
  const rows = await query(sql);
  const r = rows[0] || {};

  const clean = (arr: unknown) =>
    ((arr as string[] | null) || [])
      .filter(x => x && x !== '' && x !== 'Sin equipo')
      .sort();

  return NextResponse.json({
    equipos: clean(r.equipos),
    fuentes: clean(r.fuentes),
    areas:   clean(r.areas),
  });
}

async function handleEtapas() {
  return NextResponse.json(ETAPAS_INMO.map(e => ({ key: e.key, label: e.label })));
}

async function handleVolumen(params: URLSearchParams) {
  const granularidad = getString(params, 'granularidad', 'mes');
  const fechaDesde   = getString(params, 'fecha_desde', FECHA_INICIO);
  const fechaHasta   = getString(params, 'fecha_hasta', today());
  const equipo       = getList(params, 'equipo');
  const fuente       = getList(params, 'fuente');
  const area         = getList(params, 'area');

  const where = buildWhere(fechaDesde, fechaHasta, equipo, fuente, area);
  const [gExpr, oExpr] = groupExpr(granularidad);
  const stageKeys = ETAPAS_INMO.map(e => e.key);

  const sql = `
    SELECT ${gExpr} AS periodo, f.valor AS etapa, COUNT(DISTINCT f.nid) AS nids
    FROM \`${TABLE}\` f
    WHERE ${where}
      AND f.valor IN (${quoteList(stageKeys)})
    GROUP BY 1, 2
    ORDER BY ${oExpr}
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
  for (const et of ETAPAS_INMO) {
    if (!byEtapa[et.key]) continue;
    datasets.push({
      label:     et.label,
      color:     et.color,
      data:      periodos.map(p => byEtapa[et.key][p] || 0),
      etapa_key: et.key,
    });
  }

  return NextResponse.json({ labels: periodos, datasets, granularidad });
}

async function handleKpis(params: URLSearchParams) {
  const equipo = getList(params, 'equipo');
  const fuente = getList(params, 'fuente');
  const area   = getList(params, 'area');

  const hoy = new Date();
  const inicioActual   = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const inicioAnterior = new Date(inicioActual);
  inicioAnterior.setDate(inicioAnterior.getDate() - 1);
  inicioAnterior.setDate(1);
  const finAnterior = new Date(inicioAnterior);
  const dayDiff = Math.floor((hoy.getTime() - inicioActual.getTime()) / (1000 * 60 * 60 * 24));
  finAnterior.setDate(inicioAnterior.getDate() + dayDiff);

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const makeWhere = (s: string, e: string) => buildWhere(s, e, equipo, fuente, area);

  const stageKeys = ETAPAS_INMO.map(et => et.key);

  const sql = `
    SELECT 'actual' AS periodo, f.valor AS etapa, COUNT(DISTINCT f.nid) AS nids
    FROM \`${TABLE}\` f
    WHERE ${makeWhere(fmt(inicioActual), fmt(hoy))}
      AND f.valor IN (${quoteList(stageKeys)})
    GROUP BY 1, 2
    UNION ALL
    SELECT 'anterior' AS periodo, f.valor AS etapa, COUNT(DISTINCT f.nid) AS nids
    FROM \`${TABLE}\` f
    WHERE ${makeWhere(fmt(inicioAnterior), fmt(finAnterior))}
      AND f.valor IN (${quoteList(stageKeys)})
    GROUP BY 1, 2
    `;
  const rows = await query(sql);
  const actual:   Record<string, number> = {};
  const anterior: Record<string, number> = {};
  for (const r of rows) {
    const target = r.periodo === 'actual' ? actual : anterior;
    target[r.etapa as string] = Number(r.nids);
  }

  const kpisCfg = [
    { label: 'Asignados',     keys: ['Asignados'] },
    { label: 'Contactados',   keys: ['contactado'] },
    { label: 'Oferta acept.', keys: ['oferta_aceptada_gabi'] },
    { label: 'Contrato',      keys: ['En legal'] },
    { label: 'Firmas',        keys: ['Firma'] },
    { label: 'Captaciones',   keys: ['captaciones_3_checks'] },
  ];

  const NOMBRES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const mtdLabel = `${NOMBRES[inicioActual.getMonth()]} ${inicioActual.getFullYear()}`;

  const result: { label: string; actual: number; anterior: number | null; delta: number | null; mtd_label: string }[] =
    kpisCfg.map(k => {
      const act = k.keys.reduce((s, x) => s + (actual[x] || 0), 0);
      const ant = k.keys.reduce((s, x) => s + (anterior[x] || 0), 0);
      const delta = ant > 0 ? ((act - ant) / ant) * 100 : null;
      return { label: k.label, actual: act, anterior: ant, delta, mtd_label: mtdLabel };
    });

  return NextResponse.json(result);
}

async function handleConvTime(params: URLSearchParams) {
  const granularidad = getString(params, 'granularidad', 'mes');
  const fechaDesde   = getString(params, 'fecha_desde', FECHA_INICIO);
  const fechaHasta   = getString(params, 'fecha_hasta', today());
  let num            = getList(params, 'num');
  let den            = getList(params, 'den');
  const equipo       = getList(params, 'equipo');
  const fuente       = getList(params, 'fuente');
  const area         = getList(params, 'area');

  if (!num) num = ['captaciones_3_checks'];
  if (!den) den = [ETAPA_ASIGNACION];

  const where = buildWhere(fechaDesde, fechaHasta, equipo, fuente, area);
  const [gExpr] = groupExpr(granularidad);
  const allEtapas = [...new Set([...num, ...den])].sort();

  const sql = `
    WITH events AS (
      SELECT ${gExpr} AS periodo, f.valor AS etapa, CAST(f.nid AS STRING) AS cid
      FROM \`${TABLE}\` f
      WHERE ${where}
        AND f.valor IN (${quoteList(allEtapas)})
    )
    SELECT
      periodo,
      COUNT(DISTINCT IF(etapa IN (${quoteList(num)}), cid, NULL)) AS num,
      COUNT(DISTINCT IF(etapa IN (${quoteList(den)}), cid, NULL)) AS den
    FROM events
    WHERE periodo IS NOT NULL
    GROUP BY 1
    ORDER BY 1
    `;
  let rows = await query(sql);
  rows = rows.filter(r => r.periodo != null);

  const labels = rows.map(r => r.periodo as string);
  const nums   = rows.map(r => Number(r.num));
  const dens   = rows.map(r => Number(r.den));
  const cvrs   = nums.map((n, i) => (dens[i] > 0 ? (n / dens[i]) * 100 : null));
  const totalN = nums.reduce((a, b) => a + b, 0);
  const totalD = dens.reduce((a, b) => a + b, 0);

  return NextResponse.json({
    labels,
    num:       nums,
    den:       dens,
    cvr:       cvrs,
    total_num: totalN,
    total_den: totalD,
    total_cvr: totalD > 0 ? (totalN / totalD) * 100 : null,
    num_etapas: num,
    den_etapas: den,
  });
}

async function handleCosechas(params: URLSearchParams) {
  const origen       = getString(params, 'origen', 'Asignados');
  const destino      = getString(params, 'destino', 'captaciones_3_checks');
  const granularidad = getString(params, 'granularidad', 'semana');
  const bucket       = getString(params, 'bucket', 'iso');
  const conteo       = getString(params, 'conteo', 'cohorte');
  const fechaDesde   = getString(params, 'fecha_desde', FECHA_INICIO);
  const fechaHasta   = getString(params, 'fecha_hasta', today());
  const equipo       = getList(params, 'equipo');
  const fuente       = getList(params, 'fuente');
  const area         = getList(params, 'area');

  const unit    = granularidad === 'semana' ? 'WEEK(MONDAY)' : 'MONTH';
  const fmtStr  = granularidad === 'semana' ? "'%Y-%m-%d'" : "'%Y-%m'";

  let offsetExpr: string;
  if (bucket === 'dias') {
    const daysPerBucket = granularidad === 'semana' ? 7 : 30;
    offsetExpr = `DIV(DATE_DIFF(d.fecha_destino, o.fecha_origen, DAY), ${daysPerBucket})`;
  } else {
    const diffUnit = granularidad === 'semana' ? 'WEEK' : 'MONTH';
    offsetExpr = `DATE_DIFF(d.fecha_destino, o.fecha_origen, ${diffUnit})`;
  }

  const whereOrigen = buildWhere(fechaDesde, fechaHasta, equipo, fuente, area);
  const safeOrigen  = origen.replace(/'/g, "''");
  const safeDestino = destino.replace(/'/g, "''");

  let origenCte:   string;
  let cohorteExpr: string;
  if (conteo === 'funnel') {
    origenCte = `
        origen AS (
          SELECT f.nid, DATE_TRUNC(DATE(f.fecha), ${unit}) AS cohorte_date, MIN(DATE(f.fecha)) AS fecha_origen
          FROM \`${TABLE}\` f
          WHERE ${whereOrigen} AND f.valor = '${safeOrigen}'
          GROUP BY 1, 2
        )`;
    cohorteExpr = `FORMAT_DATE(${fmtStr}, o.cohorte_date)`;
  } else {
    origenCte = `
        origen AS (
          SELECT f.nid, MIN(DATE(f.fecha)) AS fecha_origen
          FROM \`${TABLE}\` f
          WHERE ${whereOrigen} AND f.valor = '${safeOrigen}'
          GROUP BY f.nid
        )`;
    cohorteExpr = `FORMAT_DATE(${fmtStr}, DATE_TRUNC(o.fecha_origen, ${unit}))`;
  }

  const sql = `
    WITH ${origenCte},
    destino AS (
      SELECT nid, MIN(DATE(fecha)) AS fecha_destino
      FROM \`${TABLE}\`
      WHERE valor = '${safeDestino}'
      GROUP BY nid
    ),
    joined AS (
      SELECT
        ${cohorteExpr} AS cohorte,
        ${offsetExpr}  AS offset_unit
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
    const c   = r.cohorte as string;
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
    const bkts      = cohortes[c];
    const total     = Object.values(bkts).reduce((a, b) => a + b, 0);
    const byOffsetCounts = Array.from({ length: maxOffset + 1 }, (_, i) => bkts[String(i)] || 0);
    const noReached = bkts['__null__'] || 0;
    const alcanzaron = total - noReached;
    const byOffsetPct   = byOffsetCounts.map(v => (total > 0 ? (v / total) * 100 : 0));
    const byOffsetShare = byOffsetCounts.map(v => (alcanzaron > 0 ? (v / alcanzaron) * 100 : 0));

    const cumCounts: number[] = [];
    let cum = 0;
    for (const v of byOffsetCounts) { cum += v; cumCounts.push(cum); }
    const cumPct   = cumCounts.map(v => (total > 0 ? (v / total) * 100 : 0));
    const cumShare = cumCounts.map(v => (alcanzaron > 0 ? (v / alcanzaron) * 100 : 0));

    return {
      cohorte:       c,
      total,
      alcanzaron,
      no_alcanzaron: noReached,
      counts:        byOffsetCounts,
      pct:           byOffsetPct,
      share:         byOffsetShare,
      cum_counts:    cumCounts,
      cum_pct:       cumPct,
      cum_share:     cumShare,
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
    offset_labels:  offsetLabels,
    offset_ranges:  offsetRanges,
    rows:           matrix,
  });
}

async function handleNegocios(params: URLSearchParams) {
  const fechaDesde = getString(params, 'fecha_desde', FECHA_INICIO);
  const fechaHasta = getString(params, 'fecha_hasta', today());
  const equipo     = getList(params, 'equipo');
  const fuente     = getList(params, 'fuente');
  const area       = getList(params, 'area');
  const etapa      = params.get('etapa');
  const search     = params.get('search');
  const page       = getInt(params, 'page', 1);
  const pageSize   = Math.min(getInt(params, 'page_size', 50), 200);

  // Use wide date range for cohort; date filtering via HAVING on the chosen stage column
  const where = buildWhere('2020-01-01', today(), equipo, fuente, area);

  const validFields = new Set(TABLE_ETAPAS_FIELDS.map(([f]) => f));
  const dateField   = etapa && validFields.has(etapa) ? etapa : 'fecha_asignado';

  const selectEtapas = TABLE_ETAPAS_FIELDS.map(([field, , bqValor]) =>
    `MIN(CASE WHEN f.valor = '${bqValor.replace(/'/g, "''")}' THEN CAST(f.fecha AS STRING) END) AS ${field}`,
  ).join(',\n      ');

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
        ANY_VALUE(COALESCE(NULLIF(f.equipo_sellers, ''), 'Sin equipo')) AS equipo,
        ANY_VALUE(COALESCE(f.fuente, ''))                               AS fuente,
        ANY_VALUE(COALESCE(f.area_metropolitana, ''))                   AS area_metropolitana,
        ${selectEtapas}
      FROM \`${TABLE}\` f
      WHERE ${where}
        ${searchClause}
      GROUP BY 1
      HAVING ${havingSql}
    )`;

  const baseSql = `
    WITH ${cohortCte}
    SELECT * FROM cohort
    ORDER BY ${dateField} DESC
    LIMIT ${pageSize}
    OFFSET ${(page - 1) * pageSize}
    `;
  const rows = await query(baseSql);

  const countSql = `
    WITH ${cohortCte}
    SELECT COUNT(*) AS total FROM cohort
    `;
  const countRows = await query(countSql);
  const total = Number(countRows[0]?.total || 0);

  // Trim dates to YYYY-MM-DD
  for (const r of rows) {
    for (const [f] of TABLE_ETAPAS_FIELDS) {
      const v = r[f];
      if (v && typeof v === 'string') r[f] = v.slice(0, 10);
    }
  }

  return NextResponse.json({
    rows,
    total,
    page,
    page_size: pageSize,
    etapas:    TABLE_ETAPAS_FIELDS.map(([f, l]) => ({ field: f, label: l })),
    date_field: dateField,
  });
}

async function handleFunnelCompare(params: URLSearchParams) {
  const mes    = params.get('mes') ?? null;
  const equipo = getList(params, 'equipo');
  const fuente = getList(params, 'fuente');
  const area   = getList(params, 'area');

  const label        = mes ?? 'Todo';
  const whereAsig    = buildWhere(FECHA_INICIO, today(), equipo, fuente, area);
  const cohortWhere  = mes ? `AND FORMAT_DATE('%Y-%m', fecha_origen) = '${mes.replace(/'/g, "''")}'` : '';
  const stageKeys    = FUNNEL_COMPARE_STAGES.map(([k]) => k);

  const sql = `
    WITH asig AS (
      SELECT f.nid, MIN(DATE(f.fecha)) AS fecha_origen
      FROM \`${TABLE}\` f
      WHERE ${whereAsig} AND f.valor = '${ETAPA_ASIGNACION}'
      GROUP BY f.nid
    ),
    cohort AS (SELECT nid, fecha_origen FROM asig WHERE TRUE ${cohortWhere}),
    stage_min AS (
      SELECT f.nid, f.valor AS etapa, MIN(DATE(f.fecha)) AS fecha_etapa
      FROM \`${TABLE}\` f
      JOIN cohort co ON co.nid = f.nid
      WHERE f.valor IN (${quoteList(stageKeys)})
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
  for (const r of rows) byEtapa[r.etapa as string] = Number(r.nids);

  const first  = byEtapa[ETAPA_ASIGNACION] || 0;
  const stages = [];
  let prevN: number | null = null;

  for (const [key, lbl, excl] of FUNNEL_COMPARE_STAGES) {
    const n       = byEtapa[key] || 0;
    const pctFirst = first > 0 ? (n / first) * 100 : 0;
    const pctPrev  = prevN != null && prevN > 0 ? (n / prevN) * 100 : null;
    stages.push({ key, label: lbl, exclusion: excl, nids: n, pct_first: pctFirst, pct_prev: pctPrev });
    if (!excl) prevN = n;
  }

  return NextResponse.json({ mes: label, total: first, stages });
}

// ── Route handlers ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const action = searchParams.get('action') ?? '';

  try {
    switch (action) {
      case 'filters':       return await handleFilters(searchParams);
      case 'etapas':        return await handleEtapas();
      case 'volumen':       return await handleVolumen(searchParams);
      case 'kpis':          return await handleKpis(searchParams);
      case 'conv-time':     return await handleConvTime(searchParams);
      case 'cosechas':      return await handleCosechas(searchParams);
      case 'negocios':      return await handleNegocios(searchParams);
      case 'funnel-compare':return await handleFunnelCompare(searchParams);
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (err) {
    console.error(`[funnel/inmo-mx] action=${action} error:`, err);
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
