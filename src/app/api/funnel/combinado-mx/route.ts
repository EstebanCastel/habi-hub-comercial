/**
 * Funnel Combinado México — MM MX + Inmo MX.
 *
 * GET /api/funnel/combinado-mx?action=filters|etapas|conv-time|cosechas|funnel-compare
 * POST /api/funnel/combinado-mx  → cache clear
 *
 * Ported from webapp/routers/funnel_combinado_mx.py
 *
 * Both sources are single tables with stages in the `valor` column.
 * nid dedup: a deal that appeared in both MM and Inmo counts once (COUNT DISTINCT nid,
 * not source:nid). No upstream / leads table in MX.
 */
import { NextRequest, NextResponse } from 'next/server';
import { query, cacheClear } from '@/lib/bq';

// ── Tables ───────────────────────────────────────────────────────────────────

const MM_TABLE    = 'sellers-main-prod.bi_mx.seguimiento_funnel_mex';
const INMO_TABLE  = 'sellers-main-prod.bi_mx.seguimiento_inmobiliaria_mex_copia';
const DEALS_TABLE = 'sellers-main-prod.hubspot.deals';

const FECHA_INICIO = '2026-01-01';

// ── Etapas MM ────────────────────────────────────────────────────────────────

const MM_ETAPAS = [
  { key: 'mm:asignacion', label: 'MM · Asignación',    bq_values: ['Primer asignacion'] },
  { key: 'mm:cita',       label: 'MM · Cita',          bq_values: ['Cita Agendada'] },
  { key: 'mm:visita',     label: 'MM · Visita',        bq_values: ['Visita Efectuada'] },
  { key: 'mm:precomite',  label: 'MM · Pre-comité',    bq_values: ['Pre-comite validado'] },
  { key: 'mm:aprobado',   label: 'MM · Aprobado',      bq_values: ['Aprobado General', 'Primer inmueble aprobado'] },
  { key: 'mm:acepto',     label: 'MM · Aceptó oferta', bq_values: ['Acepto Oferta - Pendiente firma'] },
  { key: 'mm:cierre',     label: 'MM · Cierre',        bq_values: ['Cierre - Comprado'] },
] as const;

// ── Etapas Inmo ──────────────────────────────────────────────────────────────

const INMO_ETAPAS = [
  { key: 'inmo:asignados',       label: 'Inmo · Asignados',          bq_values: ['Asignados'] },
  { key: 'inmo:contactados',     label: 'Inmo · Contactados',        bq_values: ['contactado'] },
  { key: 'inmo:oferta_aceptada', label: 'Inmo · Oferta aceptada',    bq_values: ['oferta_aceptada_gabi'] },
  { key: 'inmo:contrato',        label: 'Inmo · Contrato en elab.',  bq_values: ['En legal'] },
  { key: 'inmo:firmas',          label: 'Inmo · Firmas',             bq_values: ['Firma'] },
  { key: 'inmo:captaciones',     label: 'Inmo · Captaciones',        bq_values: ['captaciones_3_checks'] },
] as const;

// ── Combos ────────────────────────────────────────────────────────────────────

const COMBOS: Record<string, { label: string; expand: string[] }> = {
  'combo:asignados':     { label: 'Asignados (MM + Inmo)',           expand: ['mm:asignacion', 'inmo:asignados'] },
  'combo:contacto':      { label: 'Cita + Contactados',              expand: ['mm:cita', 'inmo:contactados'] },
  'combo:aceptados':     { label: 'Aceptó + Oferta aceptada',        expand: ['mm:acepto', 'inmo:oferta_aceptada'] },
  'combo:transacciones': { label: 'Transacciones (Cierre + Firmas)', expand: ['mm:cierre', 'inmo:firmas'] },
};

// Ordered funnel steps for funnel-compare.
const COMBO_FUNNEL = ['combo:asignados', 'combo:contacto', 'combo:aceptados', 'combo:transacciones'];

const DEFAULT_NUM = 'combo:transacciones';
const DEFAULT_DEN = 'combo:asignados';

// ── Index maps ────────────────────────────────────────────────────────────────

const MM_BY_KEY: Record<string, { key: string; label: string; bq_values: readonly string[] }> = {};
for (const e of MM_ETAPAS) MM_BY_KEY[e.key] = e;

const INMO_BY_KEY: Record<string, { key: string; label: string; bq_values: readonly string[] }> = {};
for (const e of INMO_ETAPAS) INMO_BY_KEY[e.key] = e;

// ── Razón de venta (ported inline from funnel_mm_mx._motivo_expr) ─────────────

const MOTIVO_CATEGORIAS = [
  { key: 'Cambio de Casa' },
  { key: 'Liquidez' },
  { key: 'Otros' },
];
const MOTIVO_SIN = 'Sin clasificar';

function motivoExpr(alias = 'd'): string {
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function quoteList(items: string[]): string {
  return items.map(i => `'${i.replace(/'/g, "''")}'`).join(', ');
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

/**
 * Expand combo:* keys to real mm:/inmo: keys; pass-through mm:/inmo: unchanged.
 * Preserves insertion order, deduplicates.
 */
function expandKeys(keys: string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    if (COMBOS[k]) {
      out.push(...COMBOS[k].expand);
    } else if (k.startsWith('mm:') || k.startsWith('inmo:')) {
      out.push(k);
    }
  }
  const seen = new Set<string>();
  return out.filter(k => { if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * Build (CASE f.valor → key, list-of-BQ-values) for the requested keys.
 * Returns [caseSql, bqValues].
 */
function caseFor(
  byKey: Record<string, { bq_values: readonly string[] }>,
  needed: string[],
): [string, string[]] {
  const whens: string[] = [];
  const valores: string[] = [];
  for (const key of needed) {
    const e = byKey[key];
    if (!e) continue;
    for (const v of e.bq_values) {
      whens.push(`WHEN '${v.replace(/'/g, "''")}' THEN '${key}'`);
      valores.push(v);
    }
  }
  const caseSql = whens.length
    ? `CASE f.valor ${whens.join(' ')} ELSE NULL END`
    : 'CAST(NULL AS STRING)';
  return [caseSql, valores];
}

/**
 * Unified events CTE (mm + inmo).
 * Returns columns: nid STRING, fecha DATE, etapa STRING, source STRING, equipo STRING, area STRING.
 */
function eventsCtes(
  fechaDesde: string,
  fechaHasta: string,
  neededMm: string[],
  neededInmo: string[],
): string {
  // ── MM ──
  const [mmCase, mmVals] = caseFor(MM_BY_KEY, neededMm);
  let mmCte: string;
  if (mmVals.length) {
    mmCte = `
        mm_events AS (
          SELECT CAST(f.nid AS STRING) AS nid, DATE(f.fecha) AS fecha,
                 ${mmCase} AS etapa, 'mm' AS source,
                 COALESCE(NULLIF(f.equipo, ''), 'Sin equipo') AS equipo,
                 COALESCE(f.area_metropolitana, '') AS area
          FROM \`${MM_TABLE}\` f
          WHERE DATE(f.fecha) BETWEEN '${fechaDesde}' AND '${fechaHasta}'
            AND f.valor IN (${quoteList(mmVals)})
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
  const [inmoCase, inmoVals] = caseFor(INMO_BY_KEY, neededInmo);
  let inmoCte: string;
  if (inmoVals.length) {
    inmoCte = `
        inmo_events AS (
          SELECT CAST(f.nid AS STRING) AS nid, DATE(f.fecha) AS fecha,
                 ${inmoCase} AS etapa, 'inmo' AS source,
                 COALESCE(NULLIF(f.equipo_sellers, ''), 'Sin equipo') AS equipo,
                 COALESCE(f.area_metropolitana, '') AS area
          FROM \`${INMO_TABLE}\` f
          WHERE DATE(f.fecha) BETWEEN '${fechaDesde}' AND '${fechaHasta}'
            AND f.valor IN (${quoteList(inmoVals)})
        )`;
  } else {
    inmoCte = `
        inmo_events AS (
          SELECT CAST(NULL AS STRING) AS nid, DATE('1900-01-01') AS fecha,
                 CAST(NULL AS STRING) AS etapa, CAST(NULL AS STRING) AS source,
                 '' AS equipo, '' AS area
          LIMIT 0
        )`;
  }

  return `${mmCte},${inmoCte},
        events AS (
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

/** Returns [motivoCte, motivoJoin, motivoCond] — all empty strings if no motivo filter. */
function motivoExtra(motivo: string[] | null): [string, string, string] {
  if (!motivo?.length) return ['', '', ''];
  const cte = `,
    deals_motivo AS (
      SELECT CAST(nid AS STRING) AS nid, ${motivoExpr('d')} AS motivo
      FROM \`${DEALS_TABLE}\` d
      QUALIFY ROW_NUMBER() OVER (PARTITION BY nid ORDER BY nid) = 1
    )`;
  const join = 'LEFT JOIN deals_motivo dm ON dm.nid = e.nid';
  const cond = `\n  AND COALESCE(dm.motivo, '${MOTIVO_SIN}') IN (${quoteList(motivo)})`;
  return [cte, join, cond];
}

function labelFor(key: string): string {
  if (COMBOS[key]) return COMBOS[key].label;
  const e = MM_BY_KEY[key] || INMO_BY_KEY[key];
  return e ? e.label : key;
}

// ── Action: filters ───────────────────────────────────────────────────────────

async function handleFilters(sp: URLSearchParams) {
  const fechaDesde = getParam(sp, 'fecha_desde') || FECHA_INICIO;
  const fechaHasta = getParam(sp, 'fecha_hasta') || today();
  const neededMm   = MM_ETAPAS.map(e => e.key);
  const neededInmo = INMO_ETAPAS.map(e => e.key);
  const ctes = eventsCtes(fechaDesde, fechaHasta, neededMm, neededInmo);

  const sql = `
    WITH ${ctes}
    SELECT
      ARRAY(SELECT DISTINCT equipo FROM events WHERE equipo NOT IN ('', 'Sin equipo') ORDER BY equipo) AS equipos,
      ARRAY(SELECT DISTINCT area   FROM events WHERE area   != '' ORDER BY area)                       AS areas,
      ARRAY(SELECT DISTINCT FORMAT_DATE('%Y-%m', fecha) FROM events ORDER BY 1 DESC)                   AS meses
  `;
  const rows = await query(sql);
  const r = (rows[0] || {}) as Record<string, unknown>;
  return NextResponse.json({
    equipos: ((r.equipos as string[]) || []).filter(x => x).sort(),
    areas:   ((r.areas   as string[]) || []).filter(x => x).sort(),
    motivos: [...MOTIVO_CATEGORIAS.map(c => c.key), MOTIVO_SIN],
    meses:   ((r.meses   as string[]) || []).filter(x => x),
  });
}

// ── Action: etapas ────────────────────────────────────────────────────────────

function handleEtapas() {
  return NextResponse.json({
    groups: [
      {
        label: 'Combinados',
        options: Object.entries(COMBOS).map(([k, v]) => ({ key: k, label: v.label })),
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

// ── Action: conv-time ─────────────────────────────────────────────────────────

async function handleConvTime(sp: URLSearchParams) {
  const granularidad = getParam(sp, 'granularidad') || 'mes';
  const fechaDesde   = getParam(sp, 'fecha_desde') || FECHA_INICIO;
  const fechaHasta   = getParam(sp, 'fecha_hasta') || today();
  const num          = getParam(sp, 'num') || DEFAULT_NUM;
  const den          = getParam(sp, 'den') || DEFAULT_DEN;
  const equipo       = getParamList(sp, 'equipo');
  const area         = getParamList(sp, 'area');
  const motivo       = getParamList(sp, 'motivo');

  const numKeys = expandKeys([num]);
  const denKeys = expandKeys([den]);
  if (!numKeys.length || !denKeys.length) {
    return NextResponse.json({ error: 'num/den inválidos' }, { status: 400 });
  }

  const needed     = Array.from(new Set([...numKeys, ...denKeys]));
  const neededMm   = needed.filter(k => k.startsWith('mm:'));
  const neededInmo = needed.filter(k => k.startsWith('inmo:'));
  const ctes = eventsCtes(fechaDesde, fechaHasta, neededMm, neededInmo);
  const where = filterClause(equipo, area);
  const [motivoCte, motivoJoin, motivoCond] = motivoExtra(motivo);

  const groupExpr = groupExprSql(granularidad, 'e.fecha');

  const sql = `
    WITH ${ctes}${motivoCte}
    SELECT
      ${groupExpr} AS periodo,
      COUNT(DISTINCT IF(e.etapa IN (${quoteList(numKeys)}), e.nid, NULL)) AS num,
      COUNT(DISTINCT IF(e.etapa IN (${quoteList(denKeys)}), e.nid, NULL)) AS den
    FROM events e
    ${motivoJoin}
    WHERE ${where}${motivoCond}
    GROUP BY 1
    ORDER BY 1
  `;
  let rows = await query(sql);
  rows = rows.filter(r => r.periodo != null);

  const labels = rows.map(r => r.periodo as string);
  const nums   = rows.map(r => Number(r.num));
  const dens   = rows.map(r => Number(r.den));
  const cvrs   = nums.map((n, i) => dens[i] > 0 ? (n / dens[i] * 100) : null);
  const totalN = nums.reduce((a, b) => a + b, 0);
  const totalD = dens.reduce((a, b) => a + b, 0);

  return NextResponse.json({
    labels,
    num: nums, den: dens, cvr: cvrs,
    total_num: totalN, total_den: totalD,
    total_cvr: totalD > 0 ? (totalN / totalD * 100) : null,
    num_key: num, num_label: labelFor(num),
    den_key: den, den_label: labelFor(den),
  });
}

// ── Action: cosechas ──────────────────────────────────────────────────────────

async function handleCosechas(sp: URLSearchParams) {
  const origen       = getParam(sp, 'origen')       || 'combo:asignados';
  const destino      = getParam(sp, 'destino')      || 'combo:transacciones';
  const granularidad = getParam(sp, 'granularidad') || 'mes';
  const bucket       = getParam(sp, 'bucket')       || 'iso';
  const conteo       = getParam(sp, 'conteo')       || 'cohorte';
  const fechaDesde   = getParam(sp, 'fecha_desde')  || FECHA_INICIO;
  const fechaHasta   = getParam(sp, 'fecha_hasta')  || today();
  const equipo       = getParamList(sp, 'equipo');
  const area         = getParamList(sp, 'area');
  const motivo       = getParamList(sp, 'motivo');

  const origenKeys  = expandKeys([origen]);
  const destinoKeys = expandKeys([destino]);
  if (!origenKeys.length || !destinoKeys.length) {
    return NextResponse.json({ error: 'origen/destino inválidos' }, { status: 400 });
  }

  const needed     = Array.from(new Set([...origenKeys, ...destinoKeys]));
  const neededMm   = needed.filter(k => k.startsWith('mm:'));
  const neededInmo = needed.filter(k => k.startsWith('inmo:'));

  // Events over full range; cohorte window is applied to origen below.
  const ctes = eventsCtes(FECHA_INICIO, today(), neededMm, neededInmo);

  const unit     = granularidad === 'semana' ? 'WEEK(MONDAY)' : 'MONTH';
  const fmt      = granularidad === 'semana' ? "'%Y-%m-%d'" : "'%Y-%m'";
  const diffUnit = granularidad === 'semana' ? 'WEEK'       : 'MONTH';

  const offsetExpr = bucket === 'dias'
    ? `DIV(DATE_DIFF(d.fecha_destino, o.fecha_origen, DAY), ${granularidad === 'semana' ? 7 : 30})`
    : `DATE_DIFF(d.fecha_destino, o.fecha_origen, ${diffUnit})`;

  const whereO = filterClause(equipo, area);
  const [motivoCte, motivoJoin, motivoCond] = motivoExtra(motivo);

  let origenCte: string;
  let cohorteExpr: string;
  if (conteo === 'funnel') {
    origenCte = `
        origen AS (
          SELECT e.nid AS entity,
                 DATE_TRUNC(e.fecha, ${unit}) AS cohorte_date,
                 MIN(e.fecha) AS fecha_origen
          FROM events e ${motivoJoin}
          WHERE e.etapa IN (${quoteList(origenKeys)}) AND ${whereO}${motivoCond}
            AND e.fecha BETWEEN '${fechaDesde}' AND '${fechaHasta}'
          GROUP BY 1, 2
        )`;
    cohorteExpr = `FORMAT_DATE(${fmt}, o.cohorte_date)`;
  } else {
    origenCte = `
        origen AS (
          SELECT e.nid AS entity, MIN(e.fecha) AS fecha_origen
          FROM events e ${motivoJoin}
          WHERE e.etapa IN (${quoteList(origenKeys)}) AND ${whereO}${motivoCond}
            AND e.fecha BETWEEN '${fechaDesde}' AND '${fechaHasta}'
          GROUP BY 1
        )`;
    cohorteExpr = `FORMAT_DATE(${fmt}, DATE_TRUNC(o.fecha_origen, ${unit}))`;
  }

  const sql = `
    WITH ${ctes}${motivoCte},
    ${origenCte},
    destino AS (
      SELECT nid AS entity, MIN(fecha) AS fecha_destino
      FROM events
      WHERE etapa IN (${quoteList(destinoKeys)})
      GROUP BY 1
    ),
    joined AS (
      SELECT
        ${cohorteExpr} AS cohorte,
        ${offsetExpr}  AS offset_unit
      FROM origen o
      LEFT JOIN destino d ON d.entity = o.entity AND d.fecha_destino >= o.fecha_origen
    )
    SELECT cohorte, offset_unit, COUNT(*) AS n
    FROM joined
    WHERE cohorte IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1, 2
  `;
  const rows = await query(sql);

  // Build cohorte map: cohorte -> offset -> count
  const cohortesMap: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const c = r.cohorte as string;
    const o = r.offset_unit == null ? '__none__' : String(r.offset_unit);
    if (!cohortesMap[c]) cohortesMap[c] = {};
    cohortesMap[c][o] = Number(r.n);
  }

  const cohortesOrdered = Object.keys(cohortesMap).sort();

  let maxOffset = 0;
  for (const v of Object.values(cohortesMap)) {
    for (const o of Object.keys(v)) {
      if (o !== '__none__') {
        const n = Number(o);
        if (n > maxOffset) maxOffset = n;
      }
    }
  }

  const matrix = cohortesOrdered.map(c => {
    const b = cohortesMap[c];
    const total    = Object.values(b).reduce((a, x) => a + x, 0);
    const noReached = b['__none__'] || 0;
    const alc      = total - noReached;
    const counts   = Array.from({ length: maxOffset + 1 }, (_, i) => b[String(i)] || 0);
    let cum = 0;
    const cumCounts = counts.map(x => { cum += x; return cum; });
    return {
      cohorte:       c,
      total,
      alcanzaron:    alc,
      no_alcanzaron: noReached,
      counts,
      pct:       counts.map(x => total > 0 ? (x / total * 100) : 0),
      share:     counts.map(x => alc   > 0 ? (x / alc   * 100) : 0),
      cum_counts: cumCounts,
      cum_pct:   cumCounts.map(x => total > 0 ? (x / total * 100) : 0),
      cum_share: cumCounts.map(x => alc   > 0 ? (x / alc   * 100) : 0),
    };
  });

  const prefix       = granularidad === 'semana' ? 'S' : 'M';
  const offsetLabels = Array.from({ length: maxOffset + 1 }, (_, i) => `${prefix}${i}`);
  const step         = granularidad === 'semana' ? 7 : 30;
  const offsetRanges = bucket === 'dias'
    ? Array.from({ length: maxOffset + 1 }, (_, i) => `${i * step}-${(i + 1) * step - 1}d`)
    : null;

  return NextResponse.json({
    origen, destino,
    origen_label:  labelFor(origen),
    destino_label: labelFor(destino),
    granularidad, bucket, conteo,
    offset_labels: offsetLabels,
    offset_ranges: offsetRanges,
    rows: matrix,
  });
}

// ── Action: funnel-compare ────────────────────────────────────────────────────

async function handleFunnelCompare(sp: URLSearchParams) {
  const mes    = getParam(sp, 'mes');
  const equipo = getParamList(sp, 'equipo');
  const area   = getParamList(sp, 'area');
  const motivo = getParamList(sp, 'motivo');
  // 'both' | 'mm' | 'inmo' — controls which source(s) seed the asignados cohort.
  const source = getParam(sp, 'source') || 'both';

  const sourceFilter = source === 'mm' || source === 'inmo'
    ? `AND e.source = '${source}'`
    : '';

  // Collect all real keys for every combo in the funnel.
  const allKeys    = COMBO_FUNNEL.flatMap(combo => expandKeys([combo]));
  const neededMm   = Array.from(new Set(allKeys.filter(k => k.startsWith('mm:'))));
  const neededInmo = Array.from(new Set(allKeys.filter(k => k.startsWith('inmo:'))));
  const ctes = eventsCtes(FECHA_INICIO, today(), neededMm, neededInmo);

  const where = filterClause(equipo, area);
  const [motivoCte, motivoJoin, motivoCond] = motivoExtra(motivo);
  const cohortWhere = mes ? `AND FORMAT_DATE('%Y-%m', fecha_origen) = '${mes}'` : '';
  const asigKeys = expandKeys([COMBO_FUNNEL[0]]);

  // CASE to label each event with its combo-level key.
  const whenLines = COMBO_FUNNEL.flatMap(combo =>
    expandKeys([combo]).map(k => `WHEN '${k}' THEN '${combo}'`)
  );
  const comboCase = `CASE e.etapa ${whenLines.join(' ')} ELSE NULL END`;

  const sql = `
    WITH ${ctes}${motivoCte},
    asig AS (
      SELECT e.nid AS entity, MIN(e.fecha) AS fecha_origen
      FROM events e ${motivoJoin}
      WHERE e.etapa IN (${quoteList(asigKeys)})
        AND ${where}${motivoCond}
        ${sourceFilter}
      GROUP BY 1
    ),
    cohort AS (
      SELECT entity, fecha_origen FROM asig WHERE TRUE ${cohortWhere}
    ),
    stage_min AS (
      SELECT e.nid AS entity,
             ${comboCase} AS combo,
             MIN(e.fecha) AS fecha_etapa
      FROM events e
      WHERE ${comboCase} IS NOT NULL
        ${sourceFilter}
      GROUP BY 1, 2
    ),
    reached AS (
      SELECT sm.combo AS etapa, COUNT(DISTINCT sm.entity) AS nids
      FROM stage_min sm
      JOIN cohort co ON co.entity = sm.entity
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
      const expand = COMBOS[combo]?.expand || [];
      for (const k of expand) {
        if (k.startsWith(source + ':')) {
          const e = source === 'mm' ? MM_BY_KEY[k] : INMO_BY_KEY[k];
          if (e) return e.label;
        }
      }
    }
    return COMBOS[combo]?.label ?? combo;
  }

  const first = byCombo[COMBO_FUNNEL[0]] || 0;
  let prevN: number | null = null;
  const stages = COMBO_FUNNEL.map(combo => {
    const n = byCombo[combo] || 0;
    const stage = {
      key:       combo,
      label:     stageLabel(combo),
      exclusion: false,
      nids:      n,
      pct_first: first > 0 ? (n / first * 100) : 0,
      pct_prev:  prevN != null && prevN > 0 ? (n / prevN * 100) : null,
    };
    prevN = n;
    return stage;
  });

  return NextResponse.json({
    mes:    mes || 'Todo',
    total:  first,
    stages,
  });
}

// ── Grouping expression ───────────────────────────────────────────────────────

function groupExprSql(granularidad: string, col = 'e.fecha'): string {
  if (granularidad === 'dia')    return `FORMAT_DATE('%Y-%m-%d', DATE(${col}))`;
  if (granularidad === 'semana') return `FORMAT_DATE('%Y-%m-%d', DATE_TRUNC(DATE(${col}), WEEK(MONDAY)))`;
  // mes_com / sem_com require cycle data not available in MX; fall through to month.
  return `FORMAT_DATE('%Y-%m', DATE(${col}))`;
}

// ── Route handlers ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const action = searchParams.get('action') ?? '';
  try {
    switch (action) {
      case 'filters':        return await handleFilters(searchParams);
      case 'etapas':         return handleEtapas();
      case 'conv-time':      return await handleConvTime(searchParams);
      case 'cosechas':       return await handleCosechas(searchParams);
      case 'funnel-compare': return await handleFunnelCompare(searchParams);
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (err) {
    console.error(`[funnel/combinado-mx] action=${action}`, err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST() {
  cacheClear();
  return NextResponse.json({ ok: true });
}
