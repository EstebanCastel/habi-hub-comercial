/**
 * Funnel Combinado MM + Inmo API.
 *
 * GET /api/funnel/combinado?action=filters|etapas|conv-time
 *
 * Ported from webapp/routers/funnel_combinado.py
 */
import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/bq';
import { BUFFER_EMAILS, sqlNotIn } from '@/lib/accounts';
import { loadCycles, loadComerciales } from '@/lib/data';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ── Constants from funnel_inmo ───────────────────────────────────────────────

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
const STAGE_ID_CAPTADO   = '1182117633';

// ── Constants from funnel_mm ─────────────────────────────────────────────────

const EXCLUDE_ETAPAS = [
  'llamadas_comercial',
  'Referido para inmobiliaria',
  'No gestionado',
  'Captado para inmobiliaria',
];

// ── Funnel combinado constants ───────────────────────────────────────────────

const FECHA_INICIO = '2026-01-01';

const UPSTREAM_ETAPAS = [
  { key: 'lead',       label: 'Lead (fecha_creacion)',        fecha_col: 'fecha_creacion' },
  { key: 'calificado', label: 'Calificado (fecha_a_pricing)', fecha_col: 'fecha_a_pricing' },
];
const UPSTREAM_KEYS = new Set(UPSTREAM_ETAPAS.map(e => e.key));

const MM_ETAPAS = [
  { key: 'mm:asignacion', label: 'MM · Asignación',    bq_values: ['Primer_asigancion'] },
  { key: 'mm:cita',       label: 'MM · Cita',          bq_values: ['Cita agendada'] },
  { key: 'mm:visita',     label: 'MM · Visita',        bq_values: ['Visita efectuada'] },
  { key: 'mm:pre_comite', label: 'MM · Pre-comité',    bq_values: ['pre-comité validado'] },
  { key: 'mm:aprobado',   label: 'MM · Aprobado',      bq_values: ['Aprobado', 'inmueble aprobado'] },
  { key: 'mm:acepto',     label: 'MM · Aceptó oferta', bq_values: ['Aceptó Oferta - Pendiente firma'] },
  { key: 'mm:cierre',     label: 'MM · Cierre',        bq_values: ['Cierre - Comprado'] },
];

const INMO_ETAPAS = [
  { key: 'inmo:asignados',       label: 'Inmo · Asignados' },
  { key: 'inmo:perfilados',      label: 'Inmo · Perfilados' },
  { key: 'inmo:comite',          label: 'Inmo · Comité' },
  { key: 'inmo:aprobado',        label: 'Inmo · Aprobado' },
  { key: 'inmo:ofertado',        label: 'Inmo · Ofertado' },
  { key: 'inmo:oferta_aceptada', label: 'Inmo · Oferta aceptada' },
  { key: 'inmo:captado',         label: 'Inmo · Captado' },
];

const COMBOS: Record<string, { label: string; expand: string[] }> = {
  'combo:asignados':          { label: 'Asignados (MM + Inmo)',        expand: ['mm:asignacion', 'inmo:asignados'] },
  'combo:visitas_perfilados': { label: 'Visitas + Perfilados',         expand: ['mm:visita', 'inmo:perfilados'] },
  'combo:aprobados':          { label: 'Aprobados (MM + Inmo)',        expand: ['mm:aprobado', 'inmo:aprobado'] },
  'combo:aceptados':          { label: 'Aceptó + Oferta aceptada',     expand: ['mm:acepto', 'inmo:oferta_aceptada'] },
  'combo:transacciones':      { label: 'Transacciones (Cierre + Capta)', expand: ['mm:cierre', 'inmo:captado'] },
};

const DEFAULT_NUM = 'combo:transacciones';
const DEFAULT_DEN = 'combo:asignados';

// ── Helpers ──────────────────────────────────────────────────────────────────

function quoteList(items: string[]): string {
  return items.map(i => `'${i.replace(/'/g, "''")}'`).join(', ');
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

function loadBadCaptadosNids(): string[] {
  const csvPath = join(process.cwd(), 'data', '[CO] Corrección Incidente 7 abr Leads Inmo - bquxjob_41c0d194_19d68c1efbf.csv');
  if (!existsSync(csvPath)) return [];
  const lines = readFileSync(csvPath, 'utf-8').split('\n').slice(1);
  const nids: string[] = [];
  for (const line of lines) {
    const nid = (line.split(',')[0] || '').trim();
    if (nid && /^\d+$/.test(nid)) nids.push(nid);
  }
  return nids;
}

function expandKeys(keys: string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    if (COMBOS[k]) {
      out.push(...COMBOS[k].expand);
    } else if (k.startsWith('mm:') || k.startsWith('inmo:') || UPSTREAM_KEYS.has(k)) {
      out.push(k);
    }
  }
  const seen = new Set<string>();
  return out.filter(k => { if (seen.has(k)) return false; seen.add(k); return true; });
}

function mmBqValuesForKeys(keys: string[]): string[] {
  const byKey: Record<string, string[]> = {};
  for (const e of MM_ETAPAS) byKey[e.key] = e.bq_values;
  const vals: string[] = [];
  for (const k of keys) vals.push(...(byKey[k] || []));
  return vals;
}

function groupExpr(granularidad: string, col = 'e.fecha'): string {
  if (granularidad === 'dia') return `FORMAT_DATE('%Y-%m-%d', DATE(${col}))`;
  if (granularidad === 'semana') return `FORMAT_DATE('%Y-%m-%d', DATE_TRUNC(DATE(${col}), WEEK(MONDAY)))`;
  if (granularidad === 'mes_com') {
    const cycles = loadCycles() as Array<Record<string, unknown>>;
    const whens = cycles.map(c => {
      const mesShort = (c.mes as string).slice(0, 3).charAt(0).toUpperCase() + (c.mes as string).slice(1, 3);
      const label = `C${String(c.ciclo).padStart(2, '0')} · ${mesShort} ${String(c.year).slice(2)}`;
      return `WHEN DATE(${col}) BETWEEN '${c.inicio}' AND '${c.fin}' THEN '${label}'`;
    });
    return `CASE ${whens.join(' ')} ELSE NULL END`;
  }
  if (granularidad === 'sem_com') {
    const cycles = loadCycles() as Array<Record<string, unknown>>;
    const whens: string[] = [];
    for (const c of cycles) {
      for (const s of c.semanas as Array<Record<string, unknown>>) {
        const label = `C${String(c.ciclo).padStart(2, '0')}-S${String(s.num).padStart(2, '0')}`;
        whens.push(`WHEN DATE(${col}) BETWEEN '${s.inicio}' AND '${s.fin}' THEN '${label}'`);
      }
    }
    return `CASE ${whens.join(' ')} ELSE NULL END`;
  }
  return `FORMAT_DATE('%Y-%m', DATE(${col}))`;
}

function upstreamCte(fechaDesde: string, fechaHasta: string, neededUpstream: string[]): string {
  if (!neededUpstream.length) {
    return `
        upstream_events AS (
          SELECT CAST(NULL AS STRING) AS nid, DATE('1900-01-01') AS fecha,
                 CAST(NULL AS STRING) AS etapa, CAST(NULL AS STRING) AS source,
                 '' AS equipo, '' AS area
          LIMIT 0
        )`;
  }
  const qualityBase = `
          ig.nid IS NOT NULL
          AND ig.fuente_id IN (35,20,47,39,3,7)`;
  const extraQuality: Record<string, string> = {
    lead: '',
    calificado: '\n          AND ig.check_a_pricing = 1',
  };
  const unions: string[] = [];
  for (const et of UPSTREAM_ETAPAS) {
    if (!neededUpstream.includes(et.key)) continue;
    const col = et.fecha_col;
    const extra = extraQuality[et.key] || '';
    unions.push(`
          SELECT
            CAST(ig.nid AS STRING) AS nid,
            DATE(ig.${col}) AS fecha,
            '${et.key}' AS etapa,
            'lead' AS source,
            COALESCE(ig.equipo_sellers, '') AS equipo,
            COALESCE(ig.area_metropolitana, '') AS area
          FROM \`papyrus-data.habi_wh_bi.tabla_inmuebles_general\` ig
          WHERE ${qualityBase}${extra}
            AND ig.${col} IS NOT NULL
            AND DATE(ig.${col}) >= '${fechaDesde}'
            AND DATE(ig.${col}) <= '${fechaHasta}'
        `);
  }
  return `
        upstream_events AS (${unions.join(' UNION ALL ')})`;
}

function eventsCtes(
  fechaDesde: string,
  fechaHasta: string,
  neededMm: string[],
  neededInmo: string[],
  neededUpstream: string[] = [],
  excludeIncidente = true,
): string {
  // ── MM ──
  const mmValues = mmBqValuesForKeys(neededMm);
  let mmCte: string;
  if (mmValues.length) {
    const caseLines: string[] = [];
    for (const et of MM_ETAPAS) {
      if (neededMm.includes(et.key)) {
        for (const v of et.bq_values) {
          caseLines.push(`WHEN f.valor = '${v.replace(/'/g, "''")}' THEN '${et.key}'`);
        }
      }
    }
    const caseSql = `CASE ${caseLines.join(' ')} ELSE NULL END`;
    mmCte = `
        mm_events AS (
          SELECT
            CAST(f.nid AS STRING) AS nid,
            DATE(f.fecha) AS fecha,
            ${caseSql} AS etapa,
            'mm' AS source,
            COALESCE(c.equipo, 'Sin equipo') AS equipo,
            COALESCE(f.area_metropolitana, '') AS area
          FROM \`papyrus-data.habi_wh_bi.funnel_diarios_col\` f
          LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(f.hubspot_owner_id)
          WHERE DATE(f.fecha) >= '${fechaDesde}'
            AND DATE(f.fecha) <= '${fechaHasta}'
            AND f.valor NOT IN (${quoteList(EXCLUDE_ETAPAS)})
            AND f.valor IN (${quoteList(mmValues)})
            AND ${sqlNotIn('f.hubspot_owner_id', BUFFER_EMAILS)}
        )`;
  } else {
    mmCte = `
        mm_events AS (
          SELECT CAST(NULL AS STRING) AS nid, DATE('1900-01-01') AS fecha,
                 CAST(NULL AS STRING) AS etapa, CAST(NULL AS STRING) AS source,
                 '' AS equipo, '' AS area
          LIMIT 0
        )`;
  }

  // ── Inmo ──
  let inmoCtes: string;
  if (neededInmo.length) {
    const badNids = loadBadCaptadosNids().join(', ') || '0';
    const captadoFilter = excludeIncidente ? ` AND nid NOT IN (${badNids})` : '';
    const stageMap: Record<string, string> = {
      'inmo:perfilados':      STAGE_ID_PERFILADO,
      'inmo:comite':          STAGE_ID_COMITE,
      'inmo:aprobado':        STAGE_ID_APROBADO,
      'inmo:ofertado':        STAGE_ID_OFERTADO,
      'inmo:oferta_aceptada': STAGE_ID_ACEPTADA,
      'inmo:captado':         STAGE_ID_CAPTADO,
    };
    const subCtes = [`
        historical_inmo AS (
          SELECT h.nid, h.fecha, h.valor AS stage_id
          FROM \`sellers-main-prod.hubspot.historical\` h
          WHERE h.propiedad = 'dealstage'
            AND h.valor IN (${PIPELINE_LIST})
            AND DATE(h.fecha) >= '${fechaDesde}'
            AND DATE(h.fecha) <= '${fechaHasta}'
        )`];
    const unions: string[] = [];
    if (neededInmo.includes('inmo:asignados')) {
      unions.push(`
              SELECT nid, fecha, 'inmo:asignados' AS etapa
              FROM historical_inmo
              QUALIFY ROW_NUMBER() OVER (PARTITION BY nid ORDER BY fecha ASC) = 1
            `);
    }
    for (const [key, stageId] of Object.entries(stageMap)) {
      if (neededInmo.includes(key)) {
        const extra = key === 'inmo:captado' ? captadoFilter : '';
        unions.push(`
                  SELECT nid, fecha, '${key}' AS etapa
                  FROM historical_inmo
                  WHERE stage_id = '${stageId}'${extra}
                `);
      }
    }
    const inmoBaseSql = unions.length
      ? unions.join(' UNION ALL ')
      : "SELECT CAST(NULL AS STRING) AS nid, DATE('1900-01-01') AS fecha, CAST(NULL AS STRING) AS etapa LIMIT 0";
    subCtes.push(`
        inmo_base AS (${inmoBaseSql})`);
    subCtes.push(`
        inmo_events AS (
          SELECT
            CAST(b.nid AS STRING) AS nid,
            DATE(b.fecha) AS fecha,
            b.etapa AS etapa,
            'inmo' AS source,
            COALESCE(c.equipo, 'Sin equipo') AS equipo,
            COALESCE(d.area_metropolitana, '') AS area
          FROM inmo_base b
          LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = b.nid
          LEFT JOIN comerciales c ON LOWER(c.email) = LOWER(d.hubspot_owner_id)
          WHERE ${sqlNotIn('d.hubspot_owner_id', BUFFER_EMAILS)}
        )`);
    inmoCtes = subCtes.join(',');
  } else {
    inmoCtes = `
        inmo_events AS (
          SELECT CAST(NULL AS STRING) AS nid, DATE('1900-01-01') AS fecha,
                 CAST(NULL AS STRING) AS etapa, CAST(NULL AS STRING) AS source,
                 '' AS equipo, '' AS area
          LIMIT 0
        )`;
  }

  const upCte = upstreamCte(fechaDesde, fechaHasta, neededUpstream);
  return `${upCte},${mmCte},${inmoCtes},
        events AS (
          SELECT nid, fecha, etapa, source, equipo, area FROM upstream_events WHERE etapa IS NOT NULL
          UNION ALL
          SELECT nid, fecha, etapa, source, equipo, area FROM mm_events WHERE etapa IS NOT NULL
          UNION ALL
          SELECT nid, fecha, etapa, source, equipo, area FROM inmo_events WHERE etapa IS NOT NULL
        )`;
}

function filterClause(equipos: string[] | null, areas: string[] | null): string {
  const conds = ['1=1'];
  if (equipos?.length) conds.push(`e.equipo IN (${quoteList(equipos)})`);
  if (areas?.length) conds.push(`e.area IN (${quoteList(areas)})`);
  return conds.join('\n  AND ');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function getParam(sp: URLSearchParams, key: string): string | null {
  return sp.get(key) || null;
}

function getParamList(sp: URLSearchParams, key: string): string[] | null {
  const vals = sp.getAll(key);
  return vals.length ? vals : null;
}

// ── Action: filters ──────────────────────────────────────────────────────────

async function handleFilters(sp: URLSearchParams) {
  const fechaDesde = getParam(sp, 'fecha_desde') || FECHA_INICIO;
  const fechaHasta = getParam(sp, 'fecha_hasta') || today();
  const neededMm = MM_ETAPAS.map(e => e.key);
  const neededInmo = INMO_ETAPAS.map(e => e.key);
  const ctes = eventsCtes(fechaDesde, fechaHasta, neededMm, neededInmo);
  const sql = `
    WITH comerciales AS (${comercialesUnnest()}),${ctes}
    SELECT
      ARRAY(SELECT DISTINCT equipo FROM events WHERE equipo NOT IN ('', 'Sin equipo') ORDER BY equipo) AS equipos,
      ARRAY(SELECT DISTINCT area   FROM events WHERE area   != '' ORDER BY area)                       AS areas
  `;
  const rows = await query(sql);
  const r = rows[0] || {};
  return NextResponse.json({
    equipos: ((r.equipos as string[]) || []).filter(x => x).sort(),
    areas:   ((r.areas   as string[]) || []).filter(x => x).sort(),
  });
}

// ── Action: etapas ───────────────────────────────────────────────────────────

function handleEtapas() {
  return NextResponse.json({
    groups: [
      {
        label: 'Combinados',
        options: Object.entries(COMBOS).map(([k, v]) => ({ key: k, label: v.label })),
      },
      {
        label: 'Pre-asignación',
        options: UPSTREAM_ETAPAS.map(e => ({ key: e.key, label: e.label })),
      },
      {
        label: 'MM',
        options: MM_ETAPAS.map(e => ({ key: e.key, label: e.label })),
      },
      {
        label: 'Inmo',
        options: INMO_ETAPAS.map(e => ({ key: e.key, label: e.label })),
      },
    ],
    default_num: DEFAULT_NUM,
    default_den: DEFAULT_DEN,
  });
}

// ── Action: conv-time ────────────────────────────────────────────────────────

async function handleConvTime(sp: URLSearchParams) {
  const granularidad = getParam(sp, 'granularidad') || 'mes';
  const fechaDesde = getParam(sp, 'fecha_desde') || FECHA_INICIO;
  const fechaHasta = getParam(sp, 'fecha_hasta') || today();
  const num = getParam(sp, 'num') || DEFAULT_NUM;
  const den = getParam(sp, 'den') || DEFAULT_DEN;
  const equipo = getParamList(sp, 'equipo');
  const area = getParamList(sp, 'area');
  const excludeIncidente = getParam(sp, 'exclude_incidente') !== 'false';

  const numKeys = expandKeys([num]);
  const denKeys = expandKeys([den]);
  if (!numKeys.length || !denKeys.length) {
    return NextResponse.json({ error: 'num/den inválidos' }, { status: 400 });
  }

  const needed = Array.from(new Set([...numKeys, ...denKeys]));
  const neededMm = needed.filter(k => k.startsWith('mm:'));
  const neededInmo = needed.filter(k => k.startsWith('inmo:'));
  const neededUpstream = needed.filter(k => UPSTREAM_KEYS.has(k));

  const ctes = eventsCtes(fechaDesde, fechaHasta, neededMm, neededInmo, neededUpstream, excludeIncidente);
  const where = filterClause(equipo, area);
  const gExpr = groupExpr(granularidad, 'e.fecha');

  const sql = `
    WITH comerciales AS (${comercialesUnnest()}),${ctes}
    SELECT
      ${gExpr} AS periodo,
      COUNT(DISTINCT IF(e.etapa IN (${quoteList(numKeys)}), CONCAT(e.source, ':', e.nid), NULL)) AS num,
      COUNT(DISTINCT IF(e.etapa IN (${quoteList(denKeys)}), CONCAT(e.source, ':', e.nid), NULL)) AS den
    FROM events e
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

  function resolveLabel(key: string): string {
    if (COMBOS[key]) return COMBOS[key].label;
    for (const e of [...MM_ETAPAS, ...INMO_ETAPAS, ...UPSTREAM_ETAPAS]) {
      if (e.key === key) return e.label;
    }
    return key;
  }

  return NextResponse.json({
    labels,
    num: nums, den: dens, cvr: cvrs,
    total_num: totalN, total_den: totalD,
    total_cvr: totalD > 0 ? (totalN / totalD * 100) : null,
    num_key: num, num_label: resolveLabel(num),
    den_key: den, den_label: resolveLabel(den),
    num_expanded: numKeys, den_expanded: denKeys,
  });
}

// ── Main GET handler ─────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const action = sp.get('action') || '';

  try {
    switch (action) {
      case 'filters':   return await handleFilters(sp);
      case 'etapas':    return handleEtapas();
      case 'conv-time': return await handleConvTime(sp);
      default:
        return NextResponse.json(
          { error: `Unknown action '${action}'. Valid: filters, etapas, conv-time` },
          { status: 400 },
        );
    }
  } catch (err) {
    console.error(`[funnel/combinado] action=${action}`, err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
