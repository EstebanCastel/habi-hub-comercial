/**
 * Funnel Combinado MM + Inmo API.
 *
 * GET /api/funnel/combinado?action=filters|etapas|conv-time|cosechas|funnel-compare
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

const MOTIVO_TABLE = 'sellers-main-prod.mid_funnel_ibuyer.seller_digital_co_recepcionista_mm';

const MOTIVO_CATEGORIAS = [
  { key: 'Cambio de casa',       color: '#3b82f6' },
  { key: 'Reubicación',          color: '#10b981' },
  { key: 'Inversión',            color: '#7c3aed' },
  { key: 'Necesidad financiera', color: '#ea580c' },
  { key: 'Separación',           color: '#db2777' },
  { key: 'Otro',                 color: '#64748b' },
];

const MOTIVO_SIN = 'Sin dato';

// ── Funnel combinado constants ───────────────────────────────────────────────

const FECHA_INICIO = '2026-01-01';

// BNPL: campo de hubspot.deals (solo CO). Valores reales: 'Sí' / 'No' (+ vacío).
const BNPL_FIELD = 'negocio_aplica_para_bnpl_';
const BNPL_SIN = 'Sin dato';
const BNPL_OPCIONES = ['Sí', 'No'];

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

// Secuencia ordenada del funnel combinado (vista funnel / comparación cohortes).
const COMBO_FUNNEL = [
  'combo:asignados',
  'combo:visitas_perfilados',
  'combo:aprobados',
  'combo:aceptados',
  'combo:transacciones',
];

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
      // Fuente OFICIAL de asignados Inmo: leads_asignados_inmobiliaria_colombia
      // (1 fila por nid = primera asignación). Reemplaza el "primer evento en historical".
      // ⚠️ La tabla arranca en 2025-12-01.
      unions.push(`
              SELECT CAST(nid AS STRING) AS nid,
                     TIMESTAMP(fecha_primera_asignacion) AS fecha,
                     'inmo:asignados' AS etapa
              FROM \`sellers-main-prod.data_sellers_bo.leads_asignados_inmobiliaria_colombia\`
              WHERE DATE(fecha_primera_asignacion) >= '${fechaDesde}'
                AND DATE(fecha_primera_asignacion) <= '${fechaHasta}'
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

// ── Motivo / BNPL helpers ────────────────────────────────────────────────────

function motivoCatSql(field: string): string {
  const m = `LOWER(TRIM(${field}))`;
  return `CASE
      WHEN ${field} IS NULL THEN '${MOTIVO_SIN}'
      WHEN REGEXP_CONTAINS(${m}, r'deuda|liqui|dinero|efectivo|plata|capital|saldar|solventar|crédito|credito|hipoteca|prestamo|préstamo|financ|gastos|salud|enferm|urgenci') THEN 'Necesidad financiera'
      WHEN REGEXP_CONTAINS(${m}, r'separaci|separad|divorci|bienes|herenci|sucesi|fallec|viud|falleci') THEN 'Separación'
      WHEN REGEXP_CONTAINS(${m}, r'inversi|invertir|negocio|oportunidad|reinvers|rentab|proyecto|renta') THEN 'Inversión'
      WHEN REGEXP_CONTAINS(${m}, r'ciudad|viaje|traslad|me voy|me mudo|mudar|mudan|exterior|país|pais|fuera|extranjer|emigr|reubica|traslado|trabajo|estudi|campo|lejos|cerca de') THEN 'Reubicación'
      WHEN REGEXP_CONTAINS(${m}, r'comprar|compra|cambi|vivienda|casa|inmueble|apartamento|apto|residencia|domicilio|grande|nuev|vivir|arrend|arriendo|alquil|hogar|propiedad') THEN 'Cambio de casa'
      ELSE 'Otro'
    END`;
}

function motivoCte(): string {
  return `
      SELECT
        nid,
        motivo_venta_string AS motivo_venta,
        ${motivoCatSql('motivo_venta_string')} AS motivo_cat
      FROM \`${MOTIVO_TABLE}\`
      WHERE motivo_venta_string IS NOT NULL
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY nid
        ORDER BY fecha_interaccion DESC, fecha_asignacion DESC
      ) = 1
    `;
}

/** Returns [cte, join, cond] for filtering by razón de venta (recepcionista MM). Empty strings if no filter. */
function motivoExtra(motivo: string[] | null): [string, string, string] {
  if (!motivo?.length) return ['', '', ''];
  const cte = `,\n    motivo AS (${motivoCte()})`;
  const join = 'LEFT JOIN motivo m ON CAST(m.nid AS STRING) = e.nid';
  const cond = `\n  AND COALESCE(m.motivo_cat, '${MOTIVO_SIN}') IN (${quoteList(motivo)})`;
  return [cte, join, cond];
}

/** Returns [cte, join, cond] for filtering by 'aplica para BNPL' (hubspot.deals, solo CO). */
function bnplExtra(bnpl: string[] | null): [string, string, string] {
  if (!bnpl?.length) return ['', '', ''];
  const cte = `,\n    bnpl_deals AS (SELECT CAST(nid AS STRING) AS nid, ${BNPL_FIELD} AS bnpl FROM \`sellers-main-prod.hubspot.deals\` QUALIFY ROW_NUMBER() OVER (PARTITION BY nid ORDER BY nid) = 1)`;
  const join = 'LEFT JOIN bnpl_deals bn ON bn.nid = e.nid';
  const cond = `\n  AND COALESCE(NULLIF(bn.bnpl, ''), '${BNPL_SIN}') IN (${quoteList(bnpl)})`;
  return [cte, join, cond];
}

function labelFor(key: string): string {
  if (COMBOS[key]) return COMBOS[key].label;
  for (const e of [...MM_ETAPAS, ...INMO_ETAPAS, ...UPSTREAM_ETAPAS]) {
    if (e.key === key) return e.label;
  }
  return key;
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
      ARRAY(SELECT DISTINCT area   FROM events WHERE area   != '' ORDER BY area)                       AS areas,
      ARRAY(SELECT DISTINCT FORMAT_DATE('%Y-%m', fecha) FROM events ORDER BY 1 DESC)                   AS meses
  `;
  const rows = await query(sql);
  const r = rows[0] || {};
  return NextResponse.json({
    equipos: ((r.equipos as string[]) || []).filter(x => x).sort(),
    areas:   ((r.areas   as string[]) || []).filter(x => x).sort(),
    motivos: [...MOTIVO_CATEGORIAS.map(c => c.key), MOTIVO_SIN],
    meses:   ((r.meses   as string[]) || []).filter(x => x),
    bnpl:    [...BNPL_OPCIONES, BNPL_SIN],
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
  const motivo = getParamList(sp, 'motivo');
  const bnpl = getParamList(sp, 'bnpl');
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
  let where = filterClause(equipo, area);
  const gExpr = groupExpr(granularidad, 'e.fecha');

  // Filtros por nid vía join a deals/recepcionista, solo si están activos.
  const [mCte, mJoin, mCond] = motivoExtra(motivo);
  const [bCte, bJoin, bCond] = bnplExtra(bnpl);
  where += mCond + bCond;

  const sql = `
    WITH comerciales AS (${comercialesUnnest()}),${ctes}${mCte}${bCte}
    SELECT
      ${gExpr} AS periodo,
      COUNT(DISTINCT IF(e.etapa IN (${quoteList(numKeys)}), e.nid, NULL)) AS num,
      COUNT(DISTINCT IF(e.etapa IN (${quoteList(denKeys)}), e.nid, NULL)) AS den
    FROM events e
    ${mJoin}
    ${bJoin}
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
    labels,
    num: nums, den: dens, cvr: cvrs,
    total_num: totalN, total_den: totalD,
    total_cvr: totalD > 0 ? (totalN / totalD * 100) : null,
    num_key: num, num_label: labelFor(num),
    den_key: den, den_label: labelFor(den),
    num_expanded: numKeys, den_expanded: denKeys,
  });
}

// ── Action: cosechas ─────────────────────────────────────────────────────────

async function handleCosechas(sp: URLSearchParams) {
  const origen = getParam(sp, 'origen') || 'combo:asignados';
  const destino = getParam(sp, 'destino') || 'combo:transacciones';
  const granularidad = getParam(sp, 'granularidad') || 'mes';
  const bucket = getParam(sp, 'bucket') || 'iso';
  const conteo = getParam(sp, 'conteo') || 'cohorte';
  const fechaDesde = getParam(sp, 'fecha_desde') || FECHA_INICIO;
  const fechaHasta = getParam(sp, 'fecha_hasta') || today();
  const equipo = getParamList(sp, 'equipo');
  const area = getParamList(sp, 'area');
  const motivo = getParamList(sp, 'motivo');
  const bnpl = getParamList(sp, 'bnpl');
  const excludeIncidente = getParam(sp, 'exclude_incidente') !== 'false';

  const origenKeys = expandKeys([origen]);
  const destinoKeys = expandKeys([destino]);
  if (!origenKeys.length || !destinoKeys.length) {
    return NextResponse.json({ error: 'origen/destino inválidos' }, { status: 400 });
  }

  const needed = Array.from(new Set([...origenKeys, ...destinoKeys]));
  const neededMm = needed.filter(k => k.startsWith('mm:'));
  const neededInmo = needed.filter(k => k.startsWith('inmo:'));
  const neededUpstream = needed.filter(k => UPSTREAM_KEYS.has(k));
  const ctes = eventsCtes(FECHA_INICIO, today(), neededMm, neededInmo, neededUpstream, excludeIncidente);

  const unit = granularidad === 'semana' ? 'WEEK(MONDAY)' : 'MONTH';
  const fmt = granularidad === 'semana' ? "'%Y-%m-%d'" : "'%Y-%m'";
  let offsetExpr: string;
  if (bucket === 'dias') {
    const dpb = granularidad === 'semana' ? 7 : 30;
    offsetExpr = `DIV(DATE_DIFF(d.fecha_destino, o.fecha_origen, DAY), ${dpb})`;
  } else {
    const diffUnit = granularidad === 'semana' ? 'WEEK' : 'MONTH';
    offsetExpr = `DATE_DIFF(d.fecha_destino, o.fecha_origen, ${diffUnit})`;
  }

  let whereO = filterClause(equipo, area);
  const [mCte, mJoin, mCond] = motivoExtra(motivo);
  const [bCte, bJoin, bCond] = bnplExtra(bnpl);
  whereO += mCond + bCond;

  let origenCte: string;
  let cohorteExpr: string;
  if (conteo === 'funnel') {
    origenCte = `
        origen AS (
          SELECT e.nid AS entity, DATE_TRUNC(DATE(e.fecha), ${unit}) AS cohorte_date, MIN(e.fecha) AS fecha_origen
          FROM events e ${mJoin} ${bJoin}
          WHERE e.etapa IN (${quoteList(origenKeys)}) AND ${whereO}
            AND DATE(e.fecha) BETWEEN '${fechaDesde}' AND '${fechaHasta}'
          GROUP BY 1, 2
        )`;
    cohorteExpr = `FORMAT_DATE(${fmt}, o.cohorte_date)`;
  } else {
    origenCte = `
        origen AS (
          SELECT e.nid AS entity, MIN(e.fecha) AS fecha_origen
          FROM events e ${mJoin} ${bJoin}
          WHERE e.etapa IN (${quoteList(origenKeys)}) AND ${whereO}
            AND DATE(e.fecha) BETWEEN '${fechaDesde}' AND '${fechaHasta}'
          GROUP BY 1
        )`;
    cohorteExpr = `FORMAT_DATE(${fmt}, DATE_TRUNC(o.fecha_origen, ${unit}))`;
  }

  const sql = `
    WITH comerciales AS (${comercialesUnnest()}),${ctes}${mCte}${bCte},
    ${origenCte},
    destino AS (
      SELECT nid AS entity, MIN(fecha) AS fecha_destino
      FROM events WHERE etapa IN (${quoteList(destinoKeys)}) GROUP BY 1
    ),
    joined AS (
      SELECT ${cohorteExpr} AS cohorte, ${offsetExpr} AS offset_unit
      FROM origen o LEFT JOIN destino d ON d.entity = o.entity AND d.fecha_destino >= o.fecha_origen
    )
    SELECT cohorte, offset_unit, COUNT(*) AS n FROM joined WHERE cohorte IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2
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
    const b = cohortes[c];
    const total = Object.values(b).reduce((a, x) => a + x, 0);
    const counts = Array.from({ length: maxOffset + 1 }, (_, i) => b[String(i)] || 0);
    const noReached = b['__null__'] || 0;
    const alcanzaron = total - noReached;
    const pct = counts.map(x => total > 0 ? (x / total * 100) : 0);
    const share = counts.map(x => alcanzaron > 0 ? (x / alcanzaron * 100) : 0);
    const cumCounts: number[] = [];
    let cum = 0;
    for (const x of counts) { cum += x; cumCounts.push(cum); }
    const cumPct = cumCounts.map(x => total > 0 ? (x / total * 100) : 0);
    const cumShare = cumCounts.map(x => alcanzaron > 0 ? (x / alcanzaron * 100) : 0);
    return {
      cohorte: c, total, alcanzaron, no_alcanzaron: noReached,
      counts, pct, share, cum_counts: cumCounts, cum_pct: cumPct, cum_share: cumShare,
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
    origen, destino, origen_label: labelFor(origen), destino_label: labelFor(destino),
    granularidad, bucket, conteo,
    offset_labels: offsetLabels, offset_ranges: offsetRanges, rows: matrix,
  });
}

// ── Action: funnel-compare ────────────────────────────────────────────────────

async function handleFunnelCompare(sp: URLSearchParams) {
  const mes = getParam(sp, 'mes');
  const equipo = getParamList(sp, 'equipo');
  const area = getParamList(sp, 'area');
  const motivo = getParamList(sp, 'motivo');
  const bnpl = getParamList(sp, 'bnpl');
  const source = getParam(sp, 'source') || 'both'; // both | mm | inmo
  const excludeIncidente = getParam(sp, 'exclude_incidente') !== 'false';

  const label = mes || 'Todo';
  const sourceFilter = (source === 'mm' || source === 'inmo') ? `AND e.source = '${source}'` : '';

  const allKeys: string[] = [];
  for (const combo of COMBO_FUNNEL) allKeys.push(...expandKeys([combo]));
  const neededMm = [...new Set(allKeys)].filter(k => k.startsWith('mm:'));
  const neededInmo = [...new Set(allKeys)].filter(k => k.startsWith('inmo:'));
  const ctes = eventsCtes(FECHA_INICIO, today(), neededMm, neededInmo, [], excludeIncidente);

  let where = filterClause(equipo, area);
  const [mCte, mJoin, mCond] = motivoExtra(motivo);
  const [bCte, bJoin, bCond] = bnplExtra(bnpl);
  where += mCond + bCond;
  const cohortWhere = mes ? `AND FORMAT_DATE('%Y-%m', fecha_origen) = '${mes}'` : '';
  const asigKeys = expandKeys([COMBO_FUNNEL[0]]);

  const MM_BY_KEY: Record<string, typeof MM_ETAPAS[0]> = {};
  for (const e of MM_ETAPAS) MM_BY_KEY[e.key] = e;
  const INMO_BY_KEY: Record<string, typeof INMO_ETAPAS[0]> = {};
  for (const e of INMO_ETAPAS) INMO_BY_KEY[e.key] = e;

  const whenLines: string[] = [];
  for (const combo of COMBO_FUNNEL) {
    for (const k of expandKeys([combo])) {
      whenLines.push(`WHEN '${k}' THEN '${combo}'`);
    }
  }
  const comboCase = `CASE e.etapa ${whenLines.join(' ')} ELSE NULL END`;

  const sql = `
    WITH comerciales AS (${comercialesUnnest()}),${ctes}${mCte}${bCte},
    asig AS (
      SELECT e.nid AS entity, MIN(e.fecha) AS fecha_origen
      FROM events e ${mJoin} ${bJoin}
      WHERE e.etapa IN (${quoteList(asigKeys)}) AND ${where} ${sourceFilter}
      GROUP BY 1
    ),
    cohort AS (SELECT entity, fecha_origen FROM asig WHERE TRUE ${cohortWhere}),
    stage_min AS (
      SELECT e.nid AS entity, ${comboCase} AS combo, MIN(e.fecha) AS fecha_etapa
      FROM events e
      WHERE ${comboCase} IS NOT NULL ${sourceFilter}
      GROUP BY 1, 2
    ),
    reached AS (
      SELECT sm.combo AS etapa, COUNT(DISTINCT sm.entity) AS nids
      FROM stage_min sm JOIN cohort co ON co.entity = sm.entity
      WHERE sm.fecha_etapa >= co.fecha_origen
      GROUP BY 1
    )
    SELECT etapa, nids FROM reached
  `;
  const rows = await query(sql);
  const byCombo: Record<string, number> = {};
  for (const r of rows) byCombo[r.etapa as string] = Number(r.nids);

  function stageLabel(combo: string): string {
    if (source === 'mm' || source === 'inmo') {
      for (const k of COMBOS[combo].expand) {
        if (k.startsWith(source + ':')) {
          const e = source === 'mm' ? MM_BY_KEY[k] : INMO_BY_KEY[k];
          if (e) return e.label;
        }
      }
    }
    return COMBOS[combo].label;
  }

  const first = byCombo[COMBO_FUNNEL[0]] || 0;
  let prevN: number | null = null;
  const stages = COMBO_FUNNEL.map(combo => {
    const n = byCombo[combo] || 0;
    const stage = {
      key: combo, label: stageLabel(combo), exclusion: false,
      nids: n,
      pct_first: first > 0 ? (n / first * 100) : 0,
      pct_prev: (prevN != null && prevN > 0) ? (n / prevN * 100) : null,
    };
    prevN = n;
    return stage;
  });

  return NextResponse.json({ mes: label, total: first, stages });
}

// ── Main GET handler ─────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const action = sp.get('action') || '';

  try {
    switch (action) {
      case 'filters':        return await handleFilters(sp);
      case 'etapas':         return handleEtapas();
      case 'conv-time':      return await handleConvTime(sp);
      case 'cosechas':       return await handleCosechas(sp);
      case 'funnel-compare': return await handleFunnelCompare(sp);
      default:
        return NextResponse.json(
          { error: `Unknown action '${action}'. Valid: filters, etapas, conv-time, cosechas, funnel-compare` },
          { status: 400 },
        );
    }
  } catch (err) {
    console.error(`[funnel/combinado] action=${action}`, err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
