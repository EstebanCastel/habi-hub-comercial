/**
 * Funnel Inmo API — pipeline 'Nuevo - Inmobiliaria CO'.
 *
 * GET /api/funnel/inmo?action=filters|etapas|volumen|kpis|share-cat|conv-time|negocios|metas-config|metas-real|metas-kpi-tendencias
 *
 * Ported from webapp/routers/funnel_inmo.py + webapp/metas_inmo.py
 */
import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/bq';
import { BUFFER_EMAILS, sqlNotIn } from '@/lib/accounts';
import { loadCycles, loadComerciales } from '@/lib/data';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ── Constants ────────────────────────────────────────────────────────────────

const FECHA_INICIO = '2025-10-27';

const PIPELINE_STAGES = [
  '1182117549','1182117546','1182117545','1182117550','1182117547',
  '1182117548','1182117544','1182117555','1182117559','1182117634',
  '1182117640','1182117553','1182117636','1182117560','1182117637',
  '1182117638','1182117554','1182117558','1182117561','1182117635',
  '1182117632','1182117633','1182117557','1182117556','1182117639',
  '1196757523',
];
const PIPELINE_LIST = PIPELINE_STAGES.map(s => `"${s}"`).join(', ');

const STAGE_ID_PERFILADO = '1182117546';
const STAGE_ID_COMITE    = '1182117547';
const STAGE_ID_APROBADO  = '1182117549';
const STAGE_ID_OFERTADO  = '1182117550';
const STAGE_ID_ACEPTADA  = '1182117553';
// const STAGE_ID_CAPTADO   = '1182117633';

const ETAPAS_INMO = [
  { key: 'asignados',       label: 'Asignados',        color: '#4285F4' },
  { key: 'perfilados',      label: 'Perfilados',       color: '#FF6D00' },
  { key: 'comite',          label: 'Enviado a comité', color: '#9C27B0' },
  { key: 'aprobado',        label: 'Aprobado comité',  color: '#34A853' },
  { key: 'ofertado',        label: 'Ofertado',         color: '#00BCD4' },
  { key: 'oferta aceptada', label: 'Oferta aceptada',  color: '#1565C0' },
  { key: 'captado',         label: 'Captado',          color: '#00897B' },
];

// ── Metas Inmo Ciclo 6 (Julio 2026) — valores explícitos del plan ───────────
// Antes esto era un modelo calculado (CVR × leads). Ahora las metas vienen dadas
// directo del plan comercial (WEEKLY_METAS: valores SEMANALES por etapa y equipo),
// replicados por las 4 semanas del ciclo. El desglose por categoría A/B/C se omite
// (el plan no lo trae) → el toggle "Categoría" del tablero no mostrará línea de meta.
//
// ⚠️ El webapp usa el calendario compartido (comercial_cycles.json) donde
// Julio = Ciclo 6, y el tablero Inmo auto-selecciona el ciclo por fecha. Por eso
// estas metas se emiten bajo CICLO (=6), aunque el plan Inmo las numere "Ciclo 5".

const CICLO = 6;
const N_SEMANAS = 4;

const TARGET_EQUIPOS = ['Inmobiliaria 1', 'Inmobiliaria 2', 'Medellín', 'Cali', 'Barranquilla'];

const ETAPAS_ORDER = ['Asignados', 'Perfilados', 'Aprobados', 'Ofertados', 'Aceptadas', 'Captados'];

const META_ETAPA_TO_BQ: Record<string, string[]> = {
  Asignados:  ['asignados'],
  Perfilados: ['perfilados'],
  Aprobados:  ['aprobado'],
  Ofertados:  ['ofertado'],
  Aceptadas:  ['oferta aceptada'],
  Captados:   ['captado'],
};

// Metas SEMANALES Ciclo 6 (Julio 2026). Valores por semana (idénticos las 4
// semanas). Total ciclo = valor × 4.
const WEEKLY_METAS: Record<string, Record<string, number>> = {
  Asignados:  { Total: 1500, 'Inmobiliaria 1': 557, 'Inmobiliaria 2': 556,
                Medellín: 147, Cali: 118, Barranquilla: 121 },
  Perfilados: { Total: 856,  'Inmobiliaria 1': 293, 'Inmobiliaria 2': 292,
                Medellín: 137, Cali: 67,  Barranquilla: 67 },
  Aprobados:  { Total: 333,  'Inmobiliaria 1': 120, 'Inmobiliaria 2': 119,
                Medellín: 51,  Cali: 22,  Barranquilla: 20 },
  Ofertados:  { Total: 309,  'Inmobiliaria 1': 118, 'Inmobiliaria 2': 118,
                Medellín: 26,  Cali: 24,  Barranquilla: 23 },
  Aceptadas:  { Total: 173,  'Inmobiliaria 1': 64,  'Inmobiliaria 2': 64,
                Medellín: 17,  Cali: 13,  Barranquilla: 15 },
  Captados:   { Total: 98,   'Inmobiliaria 1': 38,  'Inmobiliaria 2': 39,
                Medellín: 6,   Cali: 7,   Barranquilla: 8 },
};

let _metasCache: Record<string, Record<string, Record<string, number>>> | null = null;

/** Invalida la caché de metas Inmo a nivel de módulo (para admin/cache/clear). */
export function resetMetasCache(): void {
  _metasCache = null;
}

function loadBadCaptadosNids(): string[] {
  const csvPath = join(process.cwd(), 'data', '[CO] Corrección Incidente 7 abr Leads Inmo - bquxjob_41c0d194_19d68c1efbf.csv');
  if (!existsSync(csvPath)) return [];
  const lines = readFileSync(csvPath, 'utf-8').split('\n').slice(1); // skip header
  const nids: string[] = [];
  for (const line of lines) {
    const nid = (line.split(',')[0] || '').trim();
    if (nid && /^\d+$/.test(nid)) nids.push(nid);
  }
  return nids;
}

/**
 * Devuelve {etapa: {bucket: {'ciclo-week': valor}}} para el Ciclo 6.
 * `comerciales` se ignora (se mantiene por compatibilidad con los callers).
 */
function loadMetas(_comerciales?: Record<string, string>[]): Record<string, Record<string, Record<string, number>>> {
  void _comerciales;
  if (_metasCache) return _metasCache;

  const metas: Record<string, Record<string, Record<string, number>>> = {};
  const weekKeys: string[] = [];
  for (let w = 1; w <= N_SEMANAS; w++) weekKeys.push(`${CICLO}-${w}`);

  for (const [etapa, buckets] of Object.entries(WEEKLY_METAS)) {
    metas[etapa] = {};
    // Total + equipos: valor semanal directo del plan (categorías omitidas)
    for (const [bucket, val] of Object.entries(buckets)) {
      metas[etapa][bucket] = {};
      for (const wk of weekKeys) metas[etapa][bucket][wk] = val;
    }
  }

  _metasCache = metas;
  return metas;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function quoteList(items: string[]): string {
  const safe = items.map(i => i.replace(/'/g, "''"));
  return safe.map(s => `'${s}'`).join(', ');
}

function badNidsInline(): string {
  const nids = loadBadCaptadosNids();
  return nids.length ? nids.join(', ') : '0';
}

function comercialesUnnest(): string {
  const com = loadComerciales();
  if (!com.length) return "SELECT '' AS email, '' AS equipo, '' AS categoria_com WHERE FALSE";
  function esc(s: string) { return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
  const structs = com.map(c =>
    `STRUCT('${esc(c.email)}' AS email, '${esc(c.equipo)}' AS equipo, '${esc(c.categoria)}' AS categoria_com)`
  );
  return `SELECT * FROM UNNEST([${structs.join(', ')}])`;
}

function baseCte(fechaDesde: string, fechaHasta: string, excludeIncidente: boolean): string {
  const badNids = badNidsInline();
  const captadoFilter = excludeIncidente ? ` AND nid NOT IN (${badNids})` : '';
  return `
    historical_inmo AS (
      SELECT h.nid, h.fecha, h.valor AS stage_id
      FROM \`sellers-main-prod.hubspot.historical\` h
      WHERE h.propiedad = 'dealstage'
        AND h.valor IN (${PIPELINE_LIST})
        AND DATE(h.fecha) >= '${fechaDesde}'
        AND DATE(h.fecha) <= '${fechaHasta}'
    ),
    asignados AS (
      -- Fuente OFICIAL de asignados Inmo: leads_asignados_inmobiliaria_colombia
      -- (1 fila por nid = primera asignación). Reemplaza el "primer evento en historical".
      -- ⚠️ La tabla arranca en 2025-12-01, así que no hay asignados previos a esa fecha.
      SELECT
        a.nid,
        TIMESTAMP(a.fecha_primera_asignacion) AS fecha,
        'asignados' AS etapa
      FROM \`sellers-main-prod.data_sellers_bo.leads_asignados_inmobiliaria_colombia\` a
      WHERE DATE(a.fecha_primera_asignacion) >= '${fechaDesde}'
        AND DATE(a.fecha_primera_asignacion) <= '${fechaHasta}'
    ),
    perfilados AS (
      SELECT nid, fecha, 'perfilados' AS etapa
      FROM historical_inmo WHERE stage_id = '${STAGE_ID_PERFILADO}'
    ),
    comite AS (
      SELECT nid, fecha, 'comite' AS etapa
      FROM historical_inmo WHERE stage_id = '${STAGE_ID_COMITE}'
    ),
    aprobado AS (
      SELECT nid, fecha, 'aprobado' AS etapa
      FROM historical_inmo WHERE stage_id = '${STAGE_ID_APROBADO}'
    ),
    ofertado AS (
      SELECT nid, fecha, 'ofertado' AS etapa
      FROM historical_inmo WHERE stage_id = '${STAGE_ID_OFERTADO}'
    ),
    oferta_aceptada AS (
      SELECT nid, fecha, 'oferta aceptada' AS etapa
      FROM historical_inmo WHERE stage_id = '${STAGE_ID_ACEPTADA}'
    ),
    captado AS (
      SELECT s.nid, TIMESTAMP(s.fecha) AS fecha, 'captado' AS etapa
      FROM \`sellers-main-prod.bi_co.seguimiento_inmobiliaria_col\` s
      WHERE s.etapa = 'Captaciones'
        AND DATE(s.fecha) >= '${fechaDesde}'
        AND DATE(s.fecha) <= '${fechaHasta}'${captadoFilter}
    ),
    base AS (
      SELECT * FROM asignados UNION ALL
      SELECT * FROM perfilados UNION ALL
      SELECT * FROM comite UNION ALL
      SELECT * FROM aprobado UNION ALL
      SELECT * FROM ofertado UNION ALL
      SELECT * FROM oferta_aceptada UNION ALL
      SELECT * FROM captado
    )`;
}

function buildFilterWhere(
  equipos: string[] | null,
  catsCom: string[] | null,
  prioridades: string[] | null,
  areas: string[] | null,
): string {
  const conds = [sqlNotIn('d.hubspot_owner_id', BUFFER_EMAILS)];
  if (equipos?.length)
    conds.push(`COALESCE(c.equipo, 'Sin equipo') IN (${quoteList(equipos)})`);
  if (catsCom?.length)
    conds.push(`COALESCE(NULLIF(c.categoria_com, ''), 'Sin categoría') IN (${quoteList(catsCom)})`);
  if (prioridades?.length)
    conds.push(`COALESCE(d.prioridad_de_gestion_inmo, '') IN (${quoteList(prioridades)})`);
  if (areas?.length)
    conds.push(`COALESCE(d.area_metropolitana, '') IN (${quoteList(areas)})`);
  return conds.join('\n  AND ');
}

function groupExpr(granularidad: string): [string, string] {
  if (granularidad === 'dia') {
    const g = "FORMAT_DATE('%Y-%m-%d', DATE(b.fecha))";
    return [g, g];
  }
  if (granularidad === 'semana') {
    const g = "FORMAT_DATE('%Y-%m-%d', DATE_TRUNC(DATE(b.fecha), WEEK(MONDAY)))";
    return [g, g];
  }
  if (granularidad === 'mes_com') {
    const cycles = loadCycles();
    const whens = (cycles as Array<Record<string, unknown>>).map(c => {
      const mesShort = (c.mes as string).slice(0, 3).charAt(0).toUpperCase() + (c.mes as string).slice(1, 3);
      const label = `C${String(c.ciclo).padStart(2, '0')} · ${mesShort} ${String(c.year).slice(2)}`;
      return `WHEN DATE(b.fecha) BETWEEN '${c.inicio}' AND '${c.fin}' THEN '${label}'`;
    });
    const g = `CASE ${whens.join(' ')} ELSE NULL END`;
    return [g, g];
  }
  if (granularidad === 'sem_com') {
    const cycles = loadCycles();
    const whens: string[] = [];
    for (const c of cycles as Array<Record<string, unknown>>) {
      for (const s of c.semanas as Array<Record<string, unknown>>) {
        const label = `C${String(c.ciclo).padStart(2, '0')}-S${String(s.num).padStart(2, '0')}`;
        whens.push(`WHEN DATE(b.fecha) BETWEEN '${s.inicio}' AND '${s.fin}' THEN '${label}'`);
      }
    }
    const g = `CASE ${whens.join(' ')} ELSE NULL END`;
    return [g, g];
  }
  const g = "FORMAT_DATE('%Y-%m', DATE(b.fecha))";
  return [g, g];
}

// ── Query param helpers ──────────────────────────────────────────────────────

function getParam(sp: URLSearchParams, key: string): string | null {
  return sp.get(key) || null;
}

function getParamList(sp: URLSearchParams, key: string): string[] | null {
  const vals = sp.getAll(key);
  return vals.length ? vals : null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Action: filters ──────────────────────────────────────────────────────────

async function handleFilters(sp: URLSearchParams) {
  const fechaDesde = getParam(sp, 'fecha_desde') || FECHA_INICIO;
  const fechaHasta = getParam(sp, 'fecha_hasta') || today();
  const base = baseCte(fechaDesde, fechaHasta, false);
  const sql = `
    WITH comerciales AS (${comercialesUnnest()}),
    ${base},
    enriched AS (
      SELECT
        COALESCE(c.equipo, 'Sin equipo')                                AS equipo,
        COALESCE(NULLIF(c.categoria_com, ''), 'Sin categoría')           AS cat_com,
        COALESCE(d.prioridad_de_gestion_inmo, '')                        AS prioridad,
        COALESCE(d.area_metropolitana, '')                               AS area
      FROM base b
      LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = b.nid
      LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
      WHERE ${sqlNotIn('d.hubspot_owner_id', BUFFER_EMAILS)}
    )
    SELECT
      ARRAY(SELECT DISTINCT equipo     FROM enriched WHERE equipo     != '' ORDER BY equipo)     AS equipos,
      ARRAY(SELECT DISTINCT cat_com    FROM enriched WHERE cat_com    != '' ORDER BY cat_com)    AS cats_com,
      ARRAY(SELECT DISTINCT prioridad  FROM enriched WHERE prioridad  != '' ORDER BY prioridad)  AS prioridades,
      ARRAY(SELECT DISTINCT area       FROM enriched WHERE area       != '' ORDER BY area)       AS areas
  `;
  const rows = await query(sql);
  const r = rows[0] || {};
  function clean(arr: unknown): string[] {
    return ((arr as string[] || []).filter(
      (x: string) => x && x !== 'Sin equipo' && x !== 'Sin categoría'
    )).sort();
  }
  return NextResponse.json({
    equipos:     clean(r.equipos),
    cats_com:    clean(r.cats_com),
    prioridades: clean(r.prioridades),
    areas:       clean(r.areas),
  });
}

// ── Action: etapas ───────────────────────────────────────────────────────────

function handleEtapas() {
  return NextResponse.json(ETAPAS_INMO.map(e => ({ key: e.key, label: e.label })));
}

// ── Action: volumen ──────────────────────────────────────────────────────────

async function handleVolumen(sp: URLSearchParams) {
  const granularidad = getParam(sp, 'granularidad') || 'mes';
  const fechaDesde = getParam(sp, 'fecha_desde') || FECHA_INICIO;
  const fechaHasta = getParam(sp, 'fecha_hasta') || today();
  const excludeIncidente = getParam(sp, 'exclude_incidente') !== 'false';
  const equipo = getParamList(sp, 'equipo');
  const catCom = getParamList(sp, 'cat_com');
  const prioridad = getParamList(sp, 'prioridad');
  const area = getParamList(sp, 'area');

  const base = baseCte(fechaDesde, fechaHasta, excludeIncidente);
  const where = buildFilterWhere(equipo, catCom, prioridad, area);
  const [gExpr, oExpr] = groupExpr(granularidad);

  const sql = `
    WITH comerciales AS (${comercialesUnnest()}),
    ${base}
    SELECT
      ${gExpr} AS periodo,
      b.etapa      AS etapa,
      COUNT(DISTINCT b.nid) AS nids
    FROM base b
    LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = b.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
    WHERE ${where}
    GROUP BY 1, 2
    ORDER BY ${oExpr}
  `;
  let rows = await query(sql);
  rows = rows.filter(r => r.periodo != null);

  const periodos = Array.from(new Set(rows.map(r => r.periodo as string))).sort();
  const byEtapa: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const et = r.etapa as string;
    if (!byEtapa[et]) byEtapa[et] = {};
    byEtapa[et][r.periodo as string] = Number(r.nids);
  }

  const datasets = ETAPAS_INMO
    .filter(et => byEtapa[et.key])
    .map(et => ({
      label: et.label,
      color: et.color,
      data: periodos.map(p => (byEtapa[et.key][p as string] || 0)),
      etapa_key: et.key,
    }));

  return NextResponse.json({ labels: periodos, datasets, granularidad });
}

// ── Action: kpis ─────────────────────────────────────────────────────────────

async function handleKpis(sp: URLSearchParams) {
  const excludeIncidente = getParam(sp, 'exclude_incidente') !== 'false';
  const equipo = getParamList(sp, 'equipo');
  const catCom = getParamList(sp, 'cat_com');
  const prioridad = getParamList(sp, 'prioridad');
  const area = getParamList(sp, 'area');

  const hoy = new Date();
  const inicioActual = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const finAnteriorMonth = new Date(inicioActual);
  finAnteriorMonth.setDate(finAnteriorMonth.getDate() - 1);
  const inicioAnterior = new Date(finAnteriorMonth.getFullYear(), finAnteriorMonth.getMonth(), 1);
  const daysDiff = hoy.getDate() - 1; // same day-of-month offset
  const finAnterior = new Date(inicioAnterior);
  finAnterior.setDate(finAnterior.getDate() + daysDiff);

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const where = buildFilterWhere(equipo, catCom, prioridad, area);
  const baseAct = baseCte(fmt(inicioActual), fmt(hoy), excludeIncidente);
  const baseAnt = baseCte(fmt(inicioAnterior), fmt(finAnterior), excludeIncidente);

  const sql = `
    WITH comerciales AS (${comercialesUnnest()})
    SELECT 'actual' AS periodo, b.etapa, COUNT(DISTINCT b.nid) AS nids FROM (
      WITH ${baseAct}
      SELECT b.* FROM base b
      LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = b.nid
      LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
      WHERE ${where}
    ) b GROUP BY 1, 2
    UNION ALL
    SELECT 'anterior' AS periodo, b.etapa, COUNT(DISTINCT b.nid) AS nids FROM (
      WITH ${baseAnt}
      SELECT b.* FROM base b
      LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = b.nid
      LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
      WHERE ${where}
    ) b GROUP BY 1, 2
  `;
  const rows = await query(sql);
  const actual: Record<string, number> = {};
  const anterior: Record<string, number> = {};
  for (const r of rows) {
    const target = r.periodo === 'actual' ? actual : anterior;
    target[r.etapa as string] = Number(r.nids);
  }

  const kpisCfg = [
    { label: 'Asignados',  keys: ['asignados'] },
    { label: 'Perfilados', keys: ['perfilados'] },
    { label: 'Aprobados',  keys: ['aprobado'] },
    { label: 'Ofertados',  keys: ['ofertado'] },
    { label: 'Aceptadas',  keys: ['oferta aceptada'] },
    { label: 'Captados',   keys: ['captado'] },
  ];
  const NOMBRES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const kpiRows = kpisCfg.map(k => {
    const act = k.keys.reduce((s, x) => s + (actual[x] || 0), 0);
    const ant = k.keys.reduce((s, x) => s + (anterior[x] || 0), 0);
    const delta = ant > 0 ? ((act - ant) / ant * 100) : null;
    return { label: k.label, actual: act, anterior: ant, delta };
  });

  return NextResponse.json({
    kpis: kpiRows,
    label_actual: `${NOMBRES[inicioActual.getMonth()]} ${inicioActual.getFullYear()}`,
    label_anterior: `${NOMBRES[inicioAnterior.getMonth()]} ${inicioAnterior.getFullYear()}`,
    dia_corte: hoy.getDate(),
  });
}

// ── Action: share-cat ────────────────────────────────────────────────────────

const PRIORIDAD_COLORS: Record<string, string> = {
  Alta: '#7c3aed', Media: '#10b981', Baja: '#f59e0b', 'Sin categoría': '#94a3b8',
};

async function handleShareCat(sp: URLSearchParams) {
  const granularidad = getParam(sp, 'granularidad') || 'mes';
  const fechaDesde = getParam(sp, 'fecha_desde') || FECHA_INICIO;
  const fechaHasta = getParam(sp, 'fecha_hasta') || today();
  const excludeIncidente = getParam(sp, 'exclude_incidente') !== 'false';
  const equipo = getParamList(sp, 'equipo');
  const catCom = getParamList(sp, 'cat_com');
  const prioridad = getParamList(sp, 'prioridad');
  const area = getParamList(sp, 'area');

  const base = baseCte(fechaDesde, fechaHasta, excludeIncidente);
  const where = buildFilterWhere(equipo, catCom, prioridad, area);
  const [gExpr] = groupExpr(granularidad);

  const sql = `
    WITH comerciales AS (${comercialesUnnest()}),
    ${base}
    SELECT
      ${gExpr} AS periodo,
      COALESCE(NULLIF(d.prioridad_de_gestion_inmo, ''), 'Sin categoría') AS categoria,
      COUNT(DISTINCT b.nid) AS nids
    FROM base b
    LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = b.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
    WHERE ${where}
      AND b.etapa = 'asignados'
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

  const order = ['Alta', 'Media', 'Baja',
    ...Array.from(catsSeen).filter(c => !['Alta','Media','Baja','Sin categoría'].includes(c)).sort(),
    'Sin categoría'];
  const catsOrdered = order.filter(c => catsSeen.has(c));
  const periodosOrdered = Array.from(periodosSet).sort();

  const donutValues = catsOrdered.map(c => donut[c] || 0);
  const donutColors = catsOrdered.map(c => PRIORIDAD_COLORS[c] || '#94a3b8');
  const barsDatasets = catsOrdered.map(c => ({
    label: c,
    color: PRIORIDAD_COLORS[c] || '#94a3b8',
    data: periodosOrdered.map(p => (byPeriod[p] || {})[c] || 0),
  }));

  return NextResponse.json({
    donut: { labels: catsOrdered, values: donutValues, colors: donutColors, total: donutValues.reduce((a, b) => a + b, 0) },
    bars: { labels: periodosOrdered, datasets: barsDatasets },
  });
}

// ── Action: conv-time ────────────────────────────────────────────────────────

async function handleConvTime(sp: URLSearchParams) {
  const granularidad = getParam(sp, 'granularidad') || 'mes';
  const fechaDesde = getParam(sp, 'fecha_desde') || FECHA_INICIO;
  const fechaHasta = getParam(sp, 'fecha_hasta') || today();
  const excludeIncidente = getParam(sp, 'exclude_incidente') !== 'false';
  const num = getParamList(sp, 'num') || ['captado'];
  const den = getParamList(sp, 'den') || ['asignados'];
  const equipo = getParamList(sp, 'equipo');
  const catCom = getParamList(sp, 'cat_com');
  const prioridad = getParamList(sp, 'prioridad');
  const area = getParamList(sp, 'area');

  const base = baseCte(fechaDesde, fechaHasta, excludeIncidente);
  const where = buildFilterWhere(equipo, catCom, prioridad, area);
  const [gExpr] = groupExpr(granularidad);

  const sql = `
    WITH comerciales AS (${comercialesUnnest()}),
    ${base}
    SELECT
      ${gExpr} AS periodo,
      COUNT(DISTINCT IF(b.etapa IN (${quoteList(num)}), b.nid, NULL)) AS num,
      COUNT(DISTINCT IF(b.etapa IN (${quoteList(den)}), b.nid, NULL)) AS den
    FROM base b
    LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = b.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
    WHERE ${where}
    GROUP BY 1
    ORDER BY 1
  `;
  let rows = await query(sql);
  rows = rows.filter(r => r.periodo != null);
  const labels = rows.map(r => r.periodo as string);
  const nums = rows.map(r => Number(r.num));
  const dens = rows.map(r => Number(r.den));
  const cvrs = nums.map((n, i) => dens[i] > 0 ? (n / dens[i] * 100) : null);
  const totalN = nums.reduce((a, b) => a + b, 0);
  const totalD = dens.reduce((a, b) => a + b, 0);

  return NextResponse.json({
    labels, num: nums, den: dens, cvr: cvrs,
    total_num: totalN, total_den: totalD,
    total_cvr: totalD > 0 ? (totalN / totalD * 100) : null,
    num_etapas: num, den_etapas: den,
  });
}

// ── Action: negocios ─────────────────────────────────────────────────────────

const TABLE_ETAPAS_FIELDS: [string, string, string][] = [
  ['fecha_asignacion', 'F. asignación', 'asignados'],
  ['fecha_perfilado',  'F. perfilado',  'perfilados'],
  ['fecha_comite',     'F. comité',     'comite'],
  ['fecha_aprobado',   'F. aprobado',   'aprobado'],
  ['fecha_ofertado',   'F. ofertado',   'ofertado'],
  ['fecha_aceptada',   'F. aceptada',   'oferta aceptada'],
  ['fecha_captado',    'F. captado',    'captado'],
];

async function handleNegocios(sp: URLSearchParams) {
  const fechaDesde = getParam(sp, 'fecha_desde') || FECHA_INICIO;
  const fechaHasta = getParam(sp, 'fecha_hasta') || today();
  const excludeIncidente = getParam(sp, 'exclude_incidente') !== 'false';
  const equipo = getParamList(sp, 'equipo');
  const catCom = getParamList(sp, 'cat_com');
  const prioridad = getParamList(sp, 'prioridad');
  const area = getParamList(sp, 'area');
  const etapa = getParam(sp, 'etapa');
  const search = getParam(sp, 'search');
  const page = Math.max(1, parseInt(getParam(sp, 'page') || '1', 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(getParam(sp, 'page_size') || '50', 10)));

  const validFields = TABLE_ETAPAS_FIELDS.map(([f]) => f);
  const dateField = etapa && validFields.includes(etapa) ? etapa : 'fecha_asignacion';
  const base = baseCte('2020-01-01', today(), excludeIncidente);
  const where = buildFilterWhere(equipo, catCom, prioridad, area);

  const selectEtapas = TABLE_ETAPAS_FIELDS.map(([field, , key]) =>
    `MIN(IF(b.etapa = '${key}', CAST(b.fecha AS STRING), NULL)) AS ${field}`
  ).join(',\n      ');

  let searchClause = '';
  if (search) {
    const safe = search.replace(/'/g, "''");
    searchClause = `AND CAST(b.nid AS STRING) LIKE '%${safe}%'`;
  }

  const having: string[] = [`${dateField} IS NOT NULL`];
  if (fechaDesde) having.push(`SUBSTR(${dateField}, 1, 10) >= '${fechaDesde}'`);
  if (fechaHasta) having.push(`SUBSTR(${dateField}, 1, 10) <= '${fechaHasta}'`);
  const havingSql = having.join(' AND ');

  const baseSql = `
    WITH comerciales AS (${comercialesUnnest()}),
    ${base},
    cohort AS (
      SELECT
        CAST(b.nid AS STRING) AS nid,
        ANY_VALUE(COALESCE(c.equipo, 'Sin equipo'))                              AS equipo,
        ANY_VALUE(COALESCE(NULLIF(c.categoria_com,''), 'Sin categoría'))          AS categoria_comercial,
        ANY_VALUE(COALESCE(d.prioridad_de_gestion_inmo, ''))                      AS prioridad,
        ANY_VALUE(COALESCE(d.area_metropolitana, ''))                             AS area_metropolitana,
        ${selectEtapas}
      FROM base b
      LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = b.nid
      LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
      WHERE ${where}
        ${searchClause}
      GROUP BY 1
      HAVING ${havingSql}
    )
    SELECT * FROM cohort
    ORDER BY ${dateField} DESC
    LIMIT ${pageSize}
    OFFSET ${(page - 1) * pageSize}
  `;
  const rows = await query(baseSql);

  const countSql = `
    WITH comerciales AS (${comercialesUnnest()}),
    ${base},
    cohort AS (
      SELECT
        CAST(b.nid AS STRING) AS nid,
        ${selectEtapas}
      FROM base b
      LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = b.nid
      LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
      WHERE ${where}
        ${searchClause}
      GROUP BY 1
      HAVING ${havingSql}
    )
    SELECT COUNT(*) AS total FROM cohort
  `;
  const countRows = await query(countSql);
  const total = Number((countRows[0] || {}).total || 0);

  for (const r of rows) {
    for (const [f] of TABLE_ETAPAS_FIELDS) {
      const v = r[f];
      if (v && typeof v === 'string') r[f] = v.slice(0, 10);
    }
  }

  return NextResponse.json({
    rows, total, page, page_size: pageSize,
    etapas: TABLE_ETAPAS_FIELDS.map(([f, l]) => ({ field: f, label: l })),
    date_field: dateField,
  });
}

// ── Action: metas-config ─────────────────────────────────────────────────────

function handleMetasConfig() {
  const cycles = loadCycles();
  const comerciales = loadComerciales();
  return NextResponse.json({
    cycles,
    etapas: ETAPAS_ORDER,
    target_equipos: TARGET_EQUIPOS,
    metas: loadMetas(comerciales),
  });
}

// ── Action: metas-real ───────────────────────────────────────────────────────

async function handleMetasReal(sp: URLSearchParams) {
  const ciclo = parseInt(getParam(sp, 'ciclo') || '0', 10);
  const desglose = getParam(sp, 'desglose') || 'total';
  const excludeIncidente = getParam(sp, 'exclude_incidente') !== 'false';
  const equipo = getParamList(sp, 'equipo');
  const catCom = getParamList(sp, 'cat_com');
  const prioridad = getParamList(sp, 'prioridad');
  const area = getParamList(sp, 'area');

  const cycles = loadCycles() as Array<Record<string, unknown>>;
  const cicloDef = cycles.find(c => c.ciclo === ciclo);
  if (!cicloDef) return NextResponse.json({ weeks: [], data: {} });

  const semanas = cicloDef.semanas as Array<Record<string, unknown>>;
  const fechaDesde = semanas[0].inicio as string;
  const fechaHasta = semanas[semanas.length - 1].fin as string;
  const base = baseCte(fechaDesde, fechaHasta, excludeIncidente);
  const where = buildFilterWhere(equipo, catCom, prioridad, area);
  const weekCases = semanas.map(s =>
    `WHEN DATE(b.fecha) BETWEEN '${s.inicio}' AND '${s.fin}' THEN ${s.num}`
  ).join(' ');

  let bucketExpr: string;
  if (desglose === 'equipo') {
    bucketExpr = 'COALESCE(c.equipo, NULL)';
  } else if (desglose === 'categoria') {
    bucketExpr = "CASE COALESCE(NULLIF(d.prioridad_de_gestion_inmo, ''), '') WHEN 'A' THEN 'A' WHEN 'B' THEN 'B' WHEN 'C' THEN 'C' ELSE NULL END";
  } else {
    bucketExpr = "'Total'";
  }

  const todasEtapas: string[] = [];
  for (const et of ETAPAS_ORDER) todasEtapas.push(...META_ETAPA_TO_BQ[et]);

  const sql = `
    WITH comerciales AS (${comercialesUnnest()}),
    ${base}
    SELECT
      b.etapa AS etapa_bq,
      (CASE ${weekCases} ELSE NULL END) AS wk,
      (${bucketExpr}) AS bucket,
      COUNT(*) AS nids
    FROM base b
    LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = b.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
    WHERE ${where}
      AND b.etapa IN (${quoteList(todasEtapas)})
    GROUP BY 1, 2, 3
  `;
  const rows = await query(sql);

  const bqToEtapa: Record<string, string> = {};
  for (const [et, bqs] of Object.entries(META_ETAPA_TO_BQ)) {
    for (const bqVal of bqs) bqToEtapa[bqVal] = et;
  }

  const out: Record<string, Record<string, Record<string, number>>> = {};
  for (const r of rows) {
    const et = bqToEtapa[r.etapa_bq as string];
    const wk = r.wk;
    const bucket = r.bucket as string;
    if (!et || wk == null || bucket == null) continue;
    if (!out[et]) out[et] = {};
    if (!out[et][bucket]) out[et][bucket] = {};
    out[et][bucket][String(wk)] = (out[et][bucket][String(wk)] || 0) + Number(r.nids);
  }

  return NextResponse.json({
    ciclo, weeks: semanas.map(s => s.num), semanas, desglose, data: out,
  });
}

// ── Action: metas-kpi-tendencias ─────────────────────────────────────────────

async function handleMetasKpiTendencias(sp: URLSearchParams) {
  const ciclo = parseInt(getParam(sp, 'ciclo') || '0', 10);
  const excludeIncidente = getParam(sp, 'exclude_incidente') !== 'false';
  const equipo = getParamList(sp, 'equipo');
  const catCom = getParamList(sp, 'cat_com');
  const prioridad = getParamList(sp, 'prioridad');
  const area = getParamList(sp, 'area');

  const cycles = loadCycles() as Array<Record<string, unknown>>;
  const cicloDef = cycles.find(c => c.ciclo === ciclo);
  if (!cicloDef) return NextResponse.json({ series: {} });

  interface FlatWeek { ciclo: number; week: number; inicio: string; fin: string }
  const flat: FlatWeek[] = [];
  for (const c of cycles) {
    for (const s of c.semanas as Array<Record<string, unknown>>) {
      flat.push({ ciclo: c.ciclo as number, week: s.num as number, inicio: s.inicio as string, fin: s.fin as string });
    }
  }

  let lastInCiclo = -1;
  for (let i = 0; i < flat.length; i++) {
    if (flat[i].ciclo === ciclo) lastInCiclo = i;
  }
  if (lastInCiclo < 0) return NextResponse.json({ series: {} });

  const todayStr = today();
  const nBack = 8;
  const startIdx = Math.max(0, lastInCiclo - nBack + 1);
  const seriesFlat = flat.slice(startIdx, lastInCiclo + 1);

  const fechaDesde = seriesFlat[0].inicio;
  const fechaHasta = seriesFlat[seriesFlat.length - 1].fin;
  const base = baseCte(fechaDesde, fechaHasta, excludeIncidente);
  const where = buildFilterWhere(equipo, catCom, prioridad, area);
  const weekCases = seriesFlat.map(s =>
    `WHEN DATE(b.fecha) BETWEEN '${s.inicio}' AND '${s.fin}' THEN '${s.ciclo}-${s.week}'`
  ).join(' ');

  const todasEtapas: string[] = [];
  for (const et of ETAPAS_ORDER) todasEtapas.push(...META_ETAPA_TO_BQ[et]);

  const sql = `
    WITH comerciales AS (${comercialesUnnest()}),
    ${base}
    SELECT
      b.etapa AS etapa_bq,
      (CASE ${weekCases} ELSE NULL END) AS wkey,
      COUNT(*) AS nids
    FROM base b
    LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = b.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
    WHERE ${where}
      AND b.etapa IN (${quoteList(todasEtapas)})
    GROUP BY 1, 2
  `;
  const rows = await query(sql);

  const bqToEtapa: Record<string, string> = {};
  for (const [et, bqs] of Object.entries(META_ETAPA_TO_BQ)) {
    for (const bqVal of bqs) bqToEtapa[bqVal] = et;
  }

  const real: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const et = bqToEtapa[r.etapa_bq as string];
    const wk = r.wkey as string;
    if (!et || !wk) continue;
    if (!real[et]) real[et] = {};
    real[et][wk] = (real[et][wk] || 0) + Number(r.nids);
  }

  const metas = loadMetas(loadComerciales());
  const series: Record<string, Record<string, unknown>> = {};
  const cicloSemanas = cicloDef.semanas as Array<Record<string, unknown>>;

  for (const et of ETAPAS_ORDER) {
    const labels: string[] = [];
    const metasArr: (number | null)[] = [];
    const realesArr: (number | null)[] = [];
    for (const s of seriesFlat) {
      const wkey = `${s.ciclo}-${s.week}`;
      labels.push(wkey);
      const m = metas[et]?.['Total']?.[wkey] ?? null;
      metasArr.push(m);
      const futura = s.inicio > todayStr;
      const rv = real[et]?.[wkey];
      realesArr.push(futura ? null : (rv || 0));
    }

    const metaCiclo = cicloSemanas.reduce((sum, s) =>
      sum + (metas[et]?.['Total']?.[`${ciclo}-${s.num}`] || 0), 0);
    const realCiclo = cicloSemanas.reduce((sum, s) =>
      (s.inicio as string) <= todayStr ? sum + (real[et]?.[`${ciclo}-${s.num}`] || 0) : sum, 0);
    const metaCicloMtd = cicloSemanas.reduce((sum, s) =>
      (s.inicio as string) <= todayStr ? sum + (metas[et]?.['Total']?.[`${ciclo}-${s.num}`] || 0) : sum, 0);
    const cumplimiento = metaCicloMtd > 0 ? (realCiclo / metaCicloMtd * 100) : null;

    series[et] = {
      labels, metas: metasArr, reales: realesArr,
      meta_ciclo: metaCiclo, meta_ciclo_mtd: metaCicloMtd,
      real_ciclo: realCiclo, cumplimiento,
    };
  }

  return NextResponse.json({
    ciclo,
    ciclo_label: `Ciclo ${ciclo} · ${cicloDef.mes} ${cicloDef.year}`,
    series,
    etapas: ETAPAS_ORDER,
  });
}

// ── Main GET handler ─────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const action = sp.get('action') || '';

  try {
    switch (action) {
      case 'filters':              return await handleFilters(sp);
      case 'etapas':               return handleEtapas();
      case 'volumen':              return await handleVolumen(sp);
      case 'kpis':                 return await handleKpis(sp);
      case 'share-cat':            return await handleShareCat(sp);
      case 'conv-time':            return await handleConvTime(sp);
      case 'negocios':             return await handleNegocios(sp);
      case 'metas-config':         return handleMetasConfig();
      case 'metas-real':           return await handleMetasReal(sp);
      case 'metas-kpi-tendencias': return await handleMetasKpiTendencias(sp);
      default:
        return NextResponse.json(
          { error: `Unknown action '${action}'. Valid: filters, etapas, volumen, kpis, share-cat, conv-time, negocios, metas-config, metas-real, metas-kpi-tendencias` },
          { status: 400 },
        );
    }
  } catch (err) {
    console.error(`[funnel/inmo] action=${action}`, err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
