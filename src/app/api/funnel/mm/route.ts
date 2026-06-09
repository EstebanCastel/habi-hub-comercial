/**
 * Funnel MM API Route — ported from webapp/routers/funnel_mm.py
 *
 * Actions (via ?action=XXX):
 *   filters, etapas, volumen, kpis, share-cat, conv-time, negocios,
 *   metas-config, metas-real, metas-kpi-tendencias, cosechas, cache-clear
 */
import { NextRequest, NextResponse } from 'next/server';
import { query, cacheClear } from '@/lib/bq';
import { sqlNotIn, BUFFER_EMAILS } from '@/lib/accounts';
import { loadCycles, loadComerciales } from '@/lib/data';

// ── Constants ────────────────────────────────────────────────────────────────

const FECHA_INICIO = '2026-01-01';

const EXCLUDE_ETAPAS = [
  'llamadas_comercial',
  'Referido para inmobiliaria',
  'No gestionado',
  'Captado para inmobiliaria',
];

const ETAPAS_MM = [
  { key: 'Primer_asigancion',                  label: 'Asignación',       color: '#7c3aed' },
  { key: 'Cita agendada',                      label: 'Cita',             color: '#ec4899' },
  { key: 'Visita efectuada',                   label: 'Visita',           color: '#f59e0b' },
  { key: 'pre-comité validado',                label: 'Pre-comité',       color: '#10b981' },
  { key: 'Descartado por comité',              label: 'Descartado',       color: '#94a3b8' },
  { key: 'inmueble aprobado',                  label: 'Inmueble aprob.',  color: '#06b6d4' },
  { key: 'Aprobado',                           label: 'Aprobado',         color: '#22c55e' },
  { key: 'Rechazó Oferta',                     label: 'Rechazó',          color: '#ef4444' },
  { key: 'Aceptó Oferta - Pendiente firma',    label: 'Aceptó',           color: '#3b82f6' },
  { key: 'Cierre - Comprado',                  label: 'Cierre',           color: '#1e40af' },
];

const SIN_PRIORIDAD_LABEL = 'Sin prioridad';

const CAT_COLORS: Record<string, string> = {
  'A':             '#7c3aed',
  'B':             '#10b981',
  'C':             '#f59e0b',
  'Sin categoría': '#94a3b8',
};

const TABLE_ETAPAS_FIELDS: [string, string, string][] = [
  ['fecha_asignacion', 'F. asignación',  'Primer_asigancion'],
  ['fecha_cita',       'F. cita',        'Cita agendada'],
  ['fecha_visita',     'F. visita',      'Visita efectuada'],
  ['fecha_precomite',  'F. pre-comité',  'pre-comité validado'],
  ['fecha_aprobado',   'F. aprobado',    'Aprobado'],
  ['fecha_acepto',     'F. aceptó',      'Aceptó Oferta - Pendiente firma'],
  ['fecha_cierre',     'F. cierre',      'Cierre - Comprado'],
];

// ── Metas MM (ported from metas_mm.py) ──────────────────────────────────────

const ZONA_TO_EQUIPO: Record<string, string> = {
  Norte:        'Bogotá Norte',
  Sur:          'Bogotá Sur',
  Medellin:     'Medellín',
  Cali:         'Cali',
  Barranquilla: 'Barranquilla',
};

const META_ETAPA_TO_BQ: Record<string, string[]> = {
  Asignados: ['Primer_asigancion'],
  Agendas:   ['Cita agendada'],
  Visitas:   ['Visita efectuada'],
  Comites:   ['pre-comité validado'],
  Aprobados: ['Aprobado'],
  Cierres:   ['Cierre - Comprado'],
};

const ETAPAS_ORDER = ['Asignados', 'Agendas', 'Visitas', 'Comites', 'Aprobados', 'Cierres'];

const CAT_SHARE: Record<string, number> = { A: 0.25, B: 0.43, C: 0.32 };

const CVR_BY_REGION: Record<string, Record<string, number[]>> = {
  'Bogotá': {
    A: [0.6326, 0.7263, 0.9113, 0.7000, 0.3987],
    B: [0.3415, 0.7842, 0.9113, 0.6000, 0.3154],
    C: [0.2460, 0.7419, 0.8696, 0.5000, 0.2000],
  },
  Ciudades: {
    A: [0.6783, 0.7320, 0.8438, 0.7263, 0.3333],
    B: [0.2914, 0.7711, 0.8438, 0.7778, 0.3333],
    C: [0.1586, 0.8372, 0.8333, 0.7381, 0.1250],
  },
};

const ZONA_TO_REGION: Record<string, string> = {
  Norte:        'Bogotá',
  Sur:          'Bogotá',
  Medellin:     'Ciudades',
  Cali:         'Ciudades',
  Barranquilla: 'Ciudades',
};

function _computeCatMetas(metas: Record<string, Record<string, Record<string, number>>>) {
  const asig = metas['Asignados'];
  if (!asig) return;
  const zonas = Object.keys(ZONA_TO_REGION);
  const allKeys = new Set<string>();
  for (const z of zonas) {
    if (asig[z]) {
      for (const k of Object.keys(asig[z])) allKeys.add(k);
    }
  }

  for (let etapaIdx = 0; etapaIdx < ETAPAS_ORDER.length; etapaIdx++) {
    const etapa = ETAPAS_ORDER[etapaIdx];
    if (!metas[etapa]) continue;
    for (const cat of ['A', 'B', 'C']) {
      metas[etapa][cat] = {};
    }
    const totalDict = metas[etapa]['Total'] || {};

    for (const wk of allKeys) {
      const raw: Record<string, number> = { A: 0, B: 0, C: 0 };
      for (const zona of zonas) {
        const asigZ = asig[zona]?.[wk];
        if (asigZ == null) continue;
        const region = ZONA_TO_REGION[zona];
        const cvrsByCat = CVR_BY_REGION[region];
        for (const cat of ['A', 'B', 'C']) {
          const asigZC = asigZ * CAT_SHARE[cat];
          let factor = 1.0;
          if (etapaIdx > 0) {
            const cvrs = cvrsByCat[cat];
            for (let k = 0; k < etapaIdx; k++) {
              factor *= cvrs[k];
            }
          }
          raw[cat] += asigZC * factor;
        }
      }

      const sumRaw = raw.A + raw.B + raw.C;
      const totalCsv = totalDict[wk];
      if (totalCsv && sumRaw > 0) {
        const scale = totalCsv / sumRaw;
        const scaled: Record<string, number> = { A: raw.A * scale, B: raw.B * scale, C: raw.C * scale };
        const rounded: Record<string, number> = { A: Math.floor(scaled.A), B: Math.floor(scaled.B), C: Math.floor(scaled.C) };
        const drift = totalCsv - (rounded.A + rounded.B + rounded.C);
        const fracs = (['A', 'B', 'C'] as const).slice().sort((a, b) => -(scaled[a] - rounded[a]) + (scaled[b] - rounded[b]));
        for (let i = 0; i < drift; i++) {
          rounded[fracs[i % 3]] += 1;
        }
        for (const cat of ['A', 'B', 'C']) {
          metas[etapa][cat][wk] = rounded[cat];
        }
      } else {
        for (const cat of ['A', 'B', 'C']) {
          metas[etapa][cat][wk] = Math.round(raw[cat]);
        }
      }
    }
  }
}

let _cachedMetas: Record<string, Record<string, Record<string, number>>> | null = null;

import metasData from '@/lib/metas-mm-data.json';

function loadMetas(): Record<string, Record<string, Record<string, number>>> {
  if (_cachedMetas) return _cachedMetas;
  _cachedMetas = metasData;
  return _cachedMetas;
}

function _parseVal(s: string | null | undefined): number | null {
  s = (s || '').trim().replace(/,/g, '').replace(/"/g, '');
  if (!s || s.startsWith('#')) return null;
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return Math.floor(n);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _quoteList(items: string[]): string {
  const safe = items.map(i => i.replace(/'/g, "''"));
  return safe.map(s => `'${s}'`).join(', ');
}

function _mapPrioridad(vals: string[]): string[] {
  return vals.map(v => (v === SIN_PRIORIDAD_LABEL ? '' : v));
}

function _buildWhere(
  fechaDesde: string,
  fechaHasta: string,
  equipos?: string[] | null,
  catsCom?: string[] | null,
  cats?: string[] | null,
  recurrencia?: string[] | null,
  fuentes?: string[] | null,
  areas?: string[] | null,
): string {
  const conds: string[] = [
    `DATE(f.fecha) >= '${fechaDesde}'`,
    `DATE(f.fecha) <= '${fechaHasta}'`,
    `f.valor NOT IN (${_quoteList(EXCLUDE_ETAPAS)})`,
    sqlNotIn('f.hubspot_owner_id', BUFFER_EMAILS),
  ];
  if (equipos?.length) {
    conds.push(`COALESCE(c.equipo, 'Sin equipo') IN (${_quoteList(equipos)})`);
  }
  if (catsCom?.length) {
    conds.push(`COALESCE(NULLIF(c.categoria_com, ''), 'Sin categoría') IN (${_quoteList(catsCom)})`);
  }
  if (cats?.length) {
    conds.push(`COALESCE(NULLIF(d.prioridad_gestion_market_maker, ''), f.categoria_comercial, '') IN (${_quoteList(cats)})`);
  }
  if (recurrencia?.length) {
    conds.push(`COALESCE(f.flag_recurrecia_gestion, '') IN (${_quoteList(recurrencia)})`);
  }
  if (fuentes?.length) {
    conds.push(`COALESCE(f.fuente, '') IN (${_quoteList(fuentes)})`);
  }
  if (areas?.length) {
    conds.push(`COALESCE(f.area_metropolitana, '') IN (${_quoteList(areas)})`);
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
    const cycles = loadCycles() as { ciclo: number; mes: string; year: number; inicio: string; fin: string }[];
    const whens: string[] = [];
    for (const c of cycles) {
      const mesShort = c.mes.slice(0, 3).charAt(0).toUpperCase() + c.mes.slice(0, 3).slice(1);
      const label = `C${String(c.ciclo).padStart(2, '0')} · ${mesShort} ${String(c.year).slice(2)}`;
      whens.push(`WHEN DATE(${field}) BETWEEN '${c.inicio}' AND '${c.fin}' THEN '${label}'`);
    }
    const g = `CASE ${whens.join(' ')} ELSE NULL END`;
    return [g, g];
  }
  if (granularidad === 'sem_com') {
    const cycles = loadCycles() as { ciclo: number; semanas: { num: number; inicio: string; fin: string }[] }[];
    const whens: string[] = [];
    for (const c of cycles) {
      for (const s of c.semanas) {
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

function _comercialesUnnest(): string {
  const com = loadComerciales();
  if (!com.length) {
    return "SELECT '' AS email, '' AS equipo, '' AS categoria_com WHERE FALSE";
  }
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const structs = com.map(
    c =>
      `STRUCT('${esc(c.email)}' AS email, '${esc(c.equipo)}' AS equipo, '${esc(c.categoria)}' AS categoria_com)`,
  );
  return `SELECT * FROM UNNEST([${structs.join(', ')}])`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Parse a query param that may be string | string[] | null into string[] | null */
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
    WITH comerciales AS (${_comercialesUnnest()}),
    base AS (
      SELECT
        COALESCE(c.equipo, 'Sin equipo')                                                AS equipo,
        COALESCE(NULLIF(c.categoria_com, ''), 'Sin categoría')                           AS cat_com,
        COALESCE(NULLIF(d.prioridad_gestion_market_maker, ''), f.categoria_comercial, '') AS cat,
        COALESCE(NULLIF(d.prioridad_gestion_market_maker, ''), '')                       AS prioridad_mm,
        COALESCE(NULLIF(d.prioridad_de_gestion_inmo, ''), '')                            AS prioridad_inmo,
        COALESCE(f.flag_recurrecia_gestion, '')                                          AS recurrencia,
        COALESCE(f.fuente, '')                                                           AS fuente,
        COALESCE(f.area_metropolitana, '')                                               AS area
      FROM \`papyrus-data.habi_wh_bi.funnel_diarios_col\` f
      LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = f.nid
      LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
      WHERE DATE(f.fecha) >= '${fechaDesde}'
        AND DATE(f.fecha) <= '${fechaHasta}'
        AND f.valor NOT IN (${excl})
        AND ${sqlNotIn('f.hubspot_owner_id', BUFFER_EMAILS)}
    )
    SELECT
      ARRAY(SELECT DISTINCT equipo         FROM base WHERE equipo         != '' ORDER BY equipo)         AS equipos,
      ARRAY(SELECT DISTINCT cat_com        FROM base WHERE cat_com        != '' ORDER BY cat_com)        AS cats_com,
      ARRAY(SELECT DISTINCT cat            FROM base WHERE cat            != '' ORDER BY cat)            AS cats,
      ARRAY(SELECT DISTINCT IF(prioridad_mm = '', '${SIN_PRIORIDAD_LABEL}', prioridad_mm) FROM base ORDER BY 1) AS prioridades_mm,
      ARRAY(SELECT DISTINCT prioridad_inmo FROM base WHERE prioridad_inmo != '' ORDER BY prioridad_inmo) AS prioridades_inmo,
      ARRAY(SELECT DISTINCT recurrencia    FROM base WHERE recurrencia    != '' ORDER BY recurrencia)    AS recurrencias,
      ARRAY(SELECT DISTINCT fuente         FROM base WHERE fuente         != '' ORDER BY fuente)         AS fuentes,
      ARRAY(SELECT DISTINCT area           FROM base WHERE area           != '' ORDER BY area)           AS areas
    `;
  const rows = await query(sql);
  const r = rows[0] || {};
  const clean = (arr: unknown) => {
    const a = (arr as string[] | null) || [];
    return a
      .filter(x => x && x !== '' && x !== 'Sin equipo' && x !== 'Sin categoría')
      .sort();
  };
  return NextResponse.json({
    equipos:          clean(r.equipos),
    cats_com:         clean(r.cats_com),
    cats:             clean(r.cats),
    prioridades_mm:   clean(r.prioridades_mm),
    prioridades_inmo: clean(r.prioridades_inmo),
    recurrencias:     clean(r.recurrencias),
    fuentes:          clean(r.fuentes),
    areas:            clean(r.areas),
  });
}

async function handleEtapas() {
  const items = [
    { key: 'Lead',         label: 'Lead (nid)' },
    { key: 'Lead (filas)', label: 'Lead (filas tabla)' },
    ...ETAPAS_MM.map(e => ({ key: e.key, label: e.label })),
  ];
  return NextResponse.json(items);
}

async function handleVolumen(params: URLSearchParams) {
  const granularidad = getString(params, 'granularidad', 'mes');
  const fechaDesde = getString(params, 'fecha_desde', FECHA_INICIO);
  const fechaHasta = getString(params, 'fecha_hasta', today());
  const equipo = getList(params, 'equipo');
  const catCom = getList(params, 'cat_com');
  const cat = getList(params, 'cat');
  const recurrencia = getList(params, 'recurrencia');
  const fuente = getList(params, 'fuente');
  const area = getList(params, 'area');

  const where = _buildWhere(fechaDesde, fechaHasta, equipo, catCom, cat, recurrencia, fuente, area);
  const [groupExpr, orderExpr] = _groupExpr(granularidad);

  const sql = `
    WITH comerciales AS (${_comercialesUnnest()})
    SELECT
      ${groupExpr} AS periodo,
      f.valor      AS etapa,
      COUNT(DISTINCT f.nid) AS nids
    FROM \`papyrus-data.habi_wh_bi.funnel_diarios_col\` f
    LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = f.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
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
  const catCom = getList(params, 'cat_com');
  const cat = getList(params, 'cat');
  const recurrencia = getList(params, 'recurrencia');
  const fuente = getList(params, 'fuente');
  const area = getList(params, 'area');

  const hoy = new Date();
  const inicioActual = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const inicioAnterior = new Date(inicioActual);
  inicioAnterior.setDate(inicioAnterior.getDate() - 1);
  inicioAnterior.setDate(1);
  // same day of previous month
  const finAnterior = new Date(inicioAnterior);
  const dayDiff = Math.floor((hoy.getTime() - inicioActual.getTime()) / (1000 * 60 * 60 * 24));
  finAnterior.setDate(inicioAnterior.getDate() + dayDiff);

  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const makeWhere = (start: string, end: string) =>
    _buildWhere(start, end, equipo, catCom, cat, recurrencia, fuente, area);

  const sql = `
    WITH comerciales AS (${_comercialesUnnest()})
    SELECT
      'actual' AS periodo,
      f.valor AS etapa,
      COUNT(DISTINCT f.nid) AS nids
    FROM \`papyrus-data.habi_wh_bi.funnel_diarios_col\` f
    LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = f.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
    WHERE ${makeWhere(fmt(inicioActual), fmt(hoy))}
    GROUP BY 1, 2
    UNION ALL
    SELECT
      'anterior' AS periodo,
      f.valor AS etapa,
      COUNT(DISTINCT f.nid) AS nids
    FROM \`papyrus-data.habi_wh_bi.funnel_diarios_col\` f
    LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = f.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
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
    { label: 'Asignaciones', keys: ['Primer_asigancion'] },
    { label: 'Citas',        keys: ['Cita agendada'] },
    { label: 'Visitas',      keys: ['Visita efectuada'] },
    { label: 'Pre-comité',   keys: ['pre-comité validado'] },
    { label: 'Aprobados',    keys: ['Aprobado'] },
    { label: 'Cierres',      keys: ['Cierre - Comprado'] },
  ];
  const kpiRows = kpisCfg.map(k => {
    const act = k.keys.reduce((s, x) => s + (actual[x] || 0), 0);
    const ant = k.keys.reduce((s, x) => s + (anterior[x] || 0), 0);
    const delta = ant > 0 ? ((act - ant) / ant) * 100 : null;
    return { label: k.label, actual: act, anterior: ant, delta };
  });

  const NOMBRES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const labelActual = `${NOMBRES[inicioActual.getMonth()]} ${inicioActual.getFullYear()}`;
  const labelAnterior = `${NOMBRES[inicioAnterior.getMonth()]} ${inicioAnterior.getFullYear()}`;

  return NextResponse.json({
    kpis: kpiRows,
    label_actual: labelActual,
    label_anterior: labelAnterior,
    dia_corte: hoy.getDate(),
  });
}

async function handleShareCat(params: URLSearchParams) {
  const granularidad = getString(params, 'granularidad', 'mes');
  const fechaDesde = getString(params, 'fecha_desde', FECHA_INICIO);
  const fechaHasta = getString(params, 'fecha_hasta', today());
  const equipo = getList(params, 'equipo');
  const catCom = getList(params, 'cat_com');
  const cat = getList(params, 'cat');
  const recurrencia = getList(params, 'recurrencia');
  const fuente = getList(params, 'fuente');
  const area = getList(params, 'area');
  const prioridadMm = getList(params, 'prioridad_mm');
  const prioridadInmo = getList(params, 'prioridad_inmo');

  let where = _buildWhere(fechaDesde, fechaHasta, equipo, catCom, cat, recurrencia, fuente, area);
  const extra: string[] = [];
  if (prioridadMm?.length) {
    extra.push(`COALESCE(d.prioridad_gestion_market_maker, '') IN (${_quoteList(_mapPrioridad(prioridadMm))})`);
  }
  if (prioridadInmo?.length) {
    extra.push(`COALESCE(d.prioridad_de_gestion_inmo, '') IN (${_quoteList(prioridadInmo)})`);
  }
  if (extra.length) {
    where = where + '\n  AND ' + extra.join('\n  AND ');
  }

  const [groupExpr] = _groupExpr(granularidad);

  const sql = `
    WITH comerciales AS (${_comercialesUnnest()})
    SELECT
      ${groupExpr} AS periodo,
      COALESCE(NULLIF(d.prioridad_gestion_market_maker, ''), f.categoria_comercial, 'Sin categoría') AS categoria,
      COUNT(DISTINCT f.nid) AS nids
    FROM \`papyrus-data.habi_wh_bi.funnel_diarios_col\` f
    LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = f.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
    WHERE ${where}
      AND f.valor = 'Primer_asigancion'
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
    let c = (r.categoria as string) || 'Sin categoría';
    if (!c) c = 'Sin categoría';
    catsSeen.add(c);
    periodosSet.add(r.periodo as string);
    donut[c] = (donut[c] || 0) + Number(r.nids);
    if (!byPeriod[r.periodo as string]) byPeriod[r.periodo as string] = {};
    byPeriod[r.periodo as string][c] = Number(r.nids);
  }

  const order = ['A', 'B', 'C', ...([...catsSeen].filter(c => !['A', 'B', 'C', 'Sin categoría'].includes(c)).sort()), 'Sin categoría'];
  const catsOrdered = order.filter(c => catsSeen.has(c));
  const periodosOrdered = [...periodosSet].sort();

  const donutLabels = catsOrdered;
  const donutValues = catsOrdered.map(c => donut[c] || 0);
  const donutTotal = donutValues.reduce((a, b) => a + b, 0);
  const donutColors = catsOrdered.map(c => CAT_COLORS[c] || '#94a3b8');

  const barsDatasets = catsOrdered.map(c => ({
    label: c,
    color: CAT_COLORS[c] || '#94a3b8',
    data: periodosOrdered.map(p => (byPeriod[p] || {})[c] || 0),
  }));

  return NextResponse.json({
    donut: {
      labels: donutLabels,
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
  const catCom = getList(params, 'cat_com');
  const cat = getList(params, 'cat');
  const recurrencia = getList(params, 'recurrencia');
  const fuente = getList(params, 'fuente');
  const area = getList(params, 'area');
  const prioridadMm = getList(params, 'prioridad_mm');

  if (!num) num = ['Cierre - Comprado'];
  if (!den) den = ['Primer_asigancion'];

  const useLead = num.includes('Lead') || den.includes('Lead');
  const useLeadRows = num.includes('Lead (filas)') || den.includes('Lead (filas)');
  const funnelEtapas = [...new Set([...num, ...den].filter(x => x !== 'Lead' && x !== 'Lead (filas)'))].sort();

  let where = _buildWhere(fechaDesde, fechaHasta, equipo, catCom, cat, recurrencia, fuente, area);
  if (prioridadMm?.length) {
    where += `\n  AND COALESCE(d.prioridad_gestion_market_maker, '') IN (${_quoteList(_mapPrioridad(prioridadMm))})`;
  }
  const [groupF] = _groupExpr(granularidad);

  const eventParts: string[] = [];
  if (funnelEtapas.length) {
    eventParts.push(`
        SELECT ${groupF} AS periodo, f.valor AS etapa, CAST(f.nid AS STRING) AS cid
        FROM \`papyrus-data.habi_wh_bi.funnel_diarios_col\` f
        LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = f.nid
        LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
        WHERE ${where}
          AND f.valor IN (${_quoteList(funnelEtapas)})`);
  }
  if (useLead || useLeadRows) {
    const [groupL] = _groupExpr(granularidad, 'ig.fecha_creacion');
    const leadConds = [
      'ig.fuente_id IN (35,20,47,39,3,7)',
      'ig.fecha_creacion IS NOT NULL',
      `DATE(ig.fecha_creacion) >= '${fechaDesde}'`,
      `DATE(ig.fecha_creacion) <= '${fechaHasta}'`,
    ];
    if (fuente?.length) {
      leadConds.push(`COALESCE(ig.fuente, '') IN (${_quoteList(fuente)})`);
    }
    if (area?.length) {
      leadConds.push(`COALESCE(ig.area_metropolitana, '') IN (${_quoteList(area)})`);
    }
    const leadWhere = leadConds.join(' AND ');
    if (useLead) {
      eventParts.push(`
        SELECT ${groupL} AS periodo, 'Lead' AS etapa, CAST(ig.nid AS STRING) AS cid
        FROM \`papyrus-data.habi_wh_bi.tabla_inmuebles_general\` ig
        WHERE ${leadWhere} AND ig.nid IS NOT NULL`);
    }
    if (useLeadRows) {
      eventParts.push(`
        SELECT ${groupL} AS periodo, 'Lead (filas)' AS etapa, GENERATE_UUID() AS cid
        FROM \`papyrus-data.habi_wh_bi.tabla_inmuebles_general\` ig
        WHERE ${leadWhere}`);
    }
  }

  const eventsSql = eventParts.join('\n        UNION ALL\n');

  const sql = `
    WITH comerciales AS (${_comercialesUnnest()}),
    events AS (${eventsSql})
    SELECT
      periodo,
      COUNT(DISTINCT IF(etapa IN (${_quoteList(num)}), cid, NULL)) AS num,
      COUNT(DISTINCT IF(etapa IN (${_quoteList(den)}), cid, NULL)) AS den
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
  });
}

async function handleNegocios(params: URLSearchParams) {
  const fechaDesde = getString(params, 'fecha_desde', FECHA_INICIO);
  const fechaHasta = getString(params, 'fecha_hasta', today());
  const equipo = getList(params, 'equipo');
  const catCom = getList(params, 'cat_com');
  const cat = getList(params, 'cat');
  const recurrencia = getList(params, 'recurrencia');
  const fuente = getList(params, 'fuente');
  const area = getList(params, 'area');
  const etapa = params.get('etapa');
  const search = params.get('search');
  const page = getInt(params, 'page', 1);
  const pageSize = Math.min(getInt(params, 'page_size', 50), 200);

  // Wide date range for WHERE, date filtering via HAVING on specific stage column
  const where = _buildWhere('2020-01-01', today(), equipo, catCom, cat, recurrencia, fuente, area);

  const validFields = new Set(TABLE_ETAPAS_FIELDS.map(([f]) => f));
  const dateField = etapa && validFields.has(etapa) ? etapa : 'fecha_asignacion';

  const selectEtapas = TABLE_ETAPAS_FIELDS.map(([field, , bqEtapa]) => {
    if (bqEtapa !== 'Aprobado') {
      return `MIN(CASE WHEN f.valor = '${bqEtapa}' THEN CAST(f.fecha AS STRING) END) AS ${field}`;
    }
    return `MIN(CASE WHEN f.valor IN ('Aprobado', 'inmueble aprobado') THEN CAST(f.fecha AS STRING) END) AS ${field}`;
  }).join(',\n      ');

  let searchClause = '';
  if (search) {
    const safe = search.replace(/'/g, "''");
    searchClause = `AND CAST(f.nid AS STRING) LIKE '%${safe}%'`;
  }

  const havingClauses = [`${dateField} IS NOT NULL`];
  if (fechaDesde) {
    havingClauses.push(`SUBSTR(${dateField}, 1, 10) >= '${fechaDesde}'`);
  }
  if (fechaHasta) {
    havingClauses.push(`SUBSTR(${dateField}, 1, 10) <= '${fechaHasta}'`);
  }
  const havingSql = havingClauses.join(' AND ');

  const baseSql = `
    WITH comerciales AS (${_comercialesUnnest()}),
    cohort AS (
      SELECT
        CAST(f.nid AS STRING) AS nid,
        ANY_VALUE(COALESCE(c.equipo, 'Sin equipo'))                                                 AS equipo,
        ANY_VALUE(COALESCE(NULLIF(c.categoria_com, ''), 'Sin categoría'))                            AS categoria_comercial,
        ANY_VALUE(COALESCE(NULLIF(d.prioridad_gestion_market_maker, ''), f.categoria_comercial, '')) AS categoria,
        ANY_VALUE(COALESCE(f.fuente, ''))                                                            AS fuente,
        ANY_VALUE(COALESCE(f.area_metropolitana, ''))                                                AS area_metropolitana,
        ${selectEtapas}
      FROM \`papyrus-data.habi_wh_bi.funnel_diarios_col\` f
      LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = f.nid
      LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
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
    WITH comerciales AS (${_comercialesUnnest()}),
    cohort AS (
      SELECT
        CAST(f.nid AS STRING) AS nid,
        ${selectEtapas}
      FROM \`papyrus-data.habi_wh_bi.funnel_diarios_col\` f
      LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = f.nid
      LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
      WHERE ${where}
        ${searchClause}
      GROUP BY 1
      HAVING ${havingSql}
    )
    SELECT COUNT(*) AS total FROM cohort
    `;
  const countRows = await query(countSql);
  const total = Number(countRows[0]?.total || 0);

  // Trim dates to YYYY-MM-DD
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

async function handleCosechas(params: URLSearchParams) {
  const origen = getString(params, 'origen', 'Primer_asigancion');
  const destino = getString(params, 'destino', 'Cita agendada');
  const granularidad = getString(params, 'granularidad', 'semana');
  const bucket = getString(params, 'bucket', 'iso');
  const conteo = getString(params, 'conteo', 'cohorte');
  const fechaDesde = getString(params, 'fecha_desde', FECHA_INICIO);
  const fechaHasta = getString(params, 'fecha_hasta', today());
  const equipo = getList(params, 'equipo');
  const catCom = getList(params, 'cat_com');
  const cat = getList(params, 'cat');
  const recurrencia = getList(params, 'recurrencia');
  const fuente = getList(params, 'fuente');
  const area = getList(params, 'area');

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

  const whereOrigen = _buildWhere(fechaDesde, fechaHasta, equipo, catCom, cat, recurrencia, fuente, area);
  const safeOrigen = origen.replace(/'/g, "''");
  const safeDestino = destino.replace(/'/g, "''");

  let origenCte: string;
  let cohorteExpr: string;
  if (conteo === 'funnel') {
    origenCte = `
        origen AS (
          SELECT
            f.nid,
            DATE_TRUNC(DATE(f.fecha), ${unit}) AS cohorte_date,
            MIN(DATE(f.fecha)) AS fecha_origen
          FROM \`papyrus-data.habi_wh_bi.funnel_diarios_col\` f
          LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = f.nid
          LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
          WHERE ${whereOrigen}
            AND f.valor = '${safeOrigen}'
          GROUP BY 1, 2
        )`;
    cohorteExpr = `FORMAT_DATE(${fmt}, o.cohorte_date)`;
  } else {
    origenCte = `
        origen AS (
          SELECT f.nid, MIN(DATE(f.fecha)) AS fecha_origen
          FROM \`papyrus-data.habi_wh_bi.funnel_diarios_col\` f
          LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = f.nid
          LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
          WHERE ${whereOrigen}
            AND f.valor = '${safeOrigen}'
          GROUP BY f.nid
        )`;
    cohorteExpr = `FORMAT_DATE(${fmt}, DATE_TRUNC(o.fecha_origen, ${unit}))`;
  }

  const sql = `
    WITH comerciales AS (${_comercialesUnnest()}),
    ${origenCte},
    destino AS (
      SELECT nid, MIN(DATE(fecha)) AS fecha_destino
      FROM \`papyrus-data.habi_wh_bi.funnel_diarios_col\`
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

  // Reconstruct matrix
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

async function handleMetasConfig() {
  const cycles = loadCycles();
  return NextResponse.json({
    cycles,
    etapas: ETAPAS_ORDER,
    zona_to_equipo: ZONA_TO_EQUIPO,
    metas: loadMetas(),
  });
}

async function handleMetasReal(params: URLSearchParams) {
  const ciclo = getInt(params, 'ciclo', 0);
  const desglose = getString(params, 'desglose', 'total');
  const equipo = getList(params, 'equipo');
  const catCom = getList(params, 'cat_com');
  const cat = getList(params, 'cat');
  const recurrencia = getList(params, 'recurrencia');
  const fuente = getList(params, 'fuente');
  const area = getList(params, 'area');
  const asumeArea = params.get('asume_area') === 'true';

  const cycles = loadCycles() as { ciclo: number; semanas: { num: number; inicio: string; fin: string }[] }[];
  const cicloDef = cycles.find(c => c.ciclo === ciclo);
  if (!cicloDef) {
    return NextResponse.json({ weeks: [], data: {} });
  }

  const semanas = cicloDef.semanas;
  const fechaDesde = semanas[0].inicio;
  const fechaHasta = semanas[semanas.length - 1].fin;
  const where = _buildWhere(fechaDesde, fechaHasta, equipo, catCom, cat, recurrencia, fuente, area);

  const weekCases = semanas
    .map(s => `WHEN DATE(f.fecha) BETWEEN '${s.inicio}' AND '${s.fin}' THEN ${s.num}`)
    .join(' ');

  let bucketExpr = _bucketExpr(desglose);

  if (asumeArea && desglose === 'equipo') {
    const equipoCase = Object.entries(ZONA_TO_EQUIPO)
      .map(([zona, eq]) => `WHEN COALESCE(c.equipo, 'Sin equipo') = '${eq}' THEN '${zona}'`)
      .join(' ');
    const areaMapping =
      "WHEN COALESCE(f.area_metropolitana,'') = 'Bogotá' THEN 'Norte' " +
      "WHEN COALESCE(f.area_metropolitana,'') = 'Medellín' THEN 'Medellin' " +
      "WHEN COALESCE(f.area_metropolitana,'') = 'Cali' THEN 'Cali' " +
      "WHEN COALESCE(f.area_metropolitana,'') = 'Barranquilla' THEN 'Barranquilla'";
    bucketExpr =
      `COALESCE(` +
      `(CASE ${equipoCase} ELSE NULL END), ` +
      `(CASE ${areaMapping} ELSE NULL END), ` +
      `'Sin equipo')`;
  }

  const todasEtapasBq: string[] = [];
  for (const et of ETAPAS_ORDER) {
    todasEtapasBq.push(...META_ETAPA_TO_BQ[et]);
  }

  const sql = `
    WITH comerciales AS (${_comercialesUnnest()})
    SELECT
      f.valor AS etapa_bq,
      (CASE ${weekCases} ELSE NULL END) AS wk,
      (${bucketExpr}) AS bucket,
      COUNT(*) AS nids
    FROM \`papyrus-data.habi_wh_bi.funnel_diarios_col\` f
    LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = f.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
    WHERE ${where}
      AND f.valor IN (${_quoteList(todasEtapasBq)})
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
    const bkt = r.bucket as string;
    if (!et || wk == null || bkt == null) continue;
    if (!out[et]) out[et] = {};
    if (!out[et][bkt]) out[et][bkt] = {};
    out[et][bkt][String(wk)] = (out[et][bkt][String(wk)] || 0) + Number(r.nids);
  }

  return NextResponse.json({
    ciclo,
    weeks: semanas.map(s => s.num),
    semanas,
    desglose,
    data: out,
  });
}

function _bucketExpr(desglose: string): string {
  if (desglose === 'equipo') {
    const mapping = Object.entries(ZONA_TO_EQUIPO)
      .map(([zona, eq]) => `WHEN COALESCE(c.equipo, 'Sin equipo') = '${eq}' THEN '${zona}'`)
      .join(' ');
    return `CASE ${mapping} ELSE 'Sin equipo' END`;
  }
  if (desglose === 'categoria') {
    return (
      "CASE COALESCE(NULLIF(d.prioridad_gestion_market_maker, ''), " +
      "f.categoria_comercial, '') " +
      "WHEN 'A' THEN 'A' WHEN 'B' THEN 'B' WHEN 'C' THEN 'C' ELSE NULL END"
    );
  }
  return "'Total'";
}

async function handleMetasKpiTendencias(params: URLSearchParams) {
  const ciclo = getInt(params, 'ciclo', 0);
  const equipo = getList(params, 'equipo');
  const catCom = getList(params, 'cat_com');
  const cat = getList(params, 'cat');
  const recurrencia = getList(params, 'recurrencia');
  const fuente = getList(params, 'fuente');
  const area = getList(params, 'area');

  const cycles = loadCycles() as {
    ciclo: number;
    mes: string;
    year: number;
    semanas: { num: number; inicio: string; fin: string }[];
  }[];
  const cicloDef = cycles.find(c => c.ciclo === ciclo);
  if (!cicloDef) {
    return NextResponse.json({ series: {} });
  }

  // Flat list of (ciclo, week, inicio, fin)
  const flat: { ciclo: number; week: number; inicio: string; fin: string }[] = [];
  for (const c of cycles) {
    for (const s of c.semanas) {
      flat.push({ ciclo: c.ciclo, week: s.num, inicio: s.inicio, fin: s.fin });
    }
  }

  // Index of last item in the selected ciclo
  let lastInCiclo = -1;
  for (let i = 0; i < flat.length; i++) {
    if (flat[i].ciclo === ciclo) lastInCiclo = i;
  }
  if (lastInCiclo < 0) {
    return NextResponse.json({ series: {} });
  }

  const todayStr = today();
  const nBack = 8;
  const startIdx = Math.max(0, lastInCiclo - nBack + 1);
  const seriesFlat = flat.slice(startIdx, lastInCiclo + 1);

  const fechaDesde = seriesFlat[0].inicio;
  const fechaHasta = seriesFlat[seriesFlat.length - 1].fin;
  const where = _buildWhere(fechaDesde, fechaHasta, equipo, catCom, cat, recurrencia, fuente, area);

  const weekCases = seriesFlat
    .map(s => `WHEN DATE(f.fecha) BETWEEN '${s.inicio}' AND '${s.fin}' THEN '${s.ciclo}-${s.week}'`)
    .join(' ');

  const todasEtapasBq: string[] = [];
  for (const et of ETAPAS_ORDER) {
    todasEtapasBq.push(...META_ETAPA_TO_BQ[et]);
  }

  const sql = `
    WITH comerciales AS (${_comercialesUnnest()})
    SELECT
      f.valor AS etapa_bq,
      (CASE ${weekCases} ELSE NULL END) AS wkey,
      COUNT(*) AS nids
    FROM \`papyrus-data.habi_wh_bi.funnel_diarios_col\` f
    LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = f.nid
    LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
    WHERE ${where}
      AND f.valor IN (${_quoteList(todasEtapasBq)})
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

  const metas = loadMetas();
  const series: Record<string, Record<string, unknown>> = {};

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
      realesArr.push(futura ? null : rv || 0);
    }

    const metaCiclo = cicloDef.semanas.reduce(
      (sum, s) => sum + (metas[et]?.['Total']?.[`${ciclo}-${s.num}`] || 0),
      0,
    );
    const realCiclo = cicloDef.semanas
      .filter(s => s.inicio <= todayStr)
      .reduce((sum, s) => sum + (real[et]?.[`${ciclo}-${s.num}`] || 0), 0);
    const metaCicloMtd = cicloDef.semanas
      .filter(s => s.inicio <= todayStr)
      .reduce((sum, s) => sum + (metas[et]?.['Total']?.[`${ciclo}-${s.num}`] || 0), 0);
    const cumplimiento = metaCicloMtd > 0 ? (realCiclo / metaCicloMtd) * 100 : null;

    series[et] = {
      labels,
      metas: metasArr,
      reales: realesArr,
      meta_ciclo: metaCiclo,
      meta_ciclo_mtd: metaCicloMtd,
      real_ciclo: realCiclo,
      cumplimiento,
    };
  }

  return NextResponse.json({
    ciclo,
    ciclo_label: `Ciclo ${ciclo} · ${cicloDef.mes} ${cicloDef.year}`,
    series,
    etapas: ETAPAS_ORDER,
  });
}

// ── Route handlers ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || '';

  try {
    switch (action) {
      case 'filters':
        return await handleFilters(searchParams);
      case 'etapas':
        return await handleEtapas();
      case 'volumen':
        return await handleVolumen(searchParams);
      case 'kpis':
        return await handleKpis(searchParams);
      case 'share-cat':
        return await handleShareCat(searchParams);
      case 'conv-time':
        return await handleConvTime(searchParams);
      case 'negocios':
        return await handleNegocios(searchParams);
      case 'cosechas':
        return await handleCosechas(searchParams);
      case 'metas-config':
        return await handleMetasConfig();
      case 'metas-real':
        return await handleMetasReal(searchParams);
      case 'metas-kpi-tendencias':
        return await handleMetasKpiTendencias(searchParams);
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    console.error(`[funnel/mm] action=${action} error:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || '';

  if (action === 'cache-clear') {
    const n = cacheClear();
    return NextResponse.json({ cleared: n });
  }

  return NextResponse.json({ error: `Unknown POST action: ${action}` }, { status: 400 });
}
