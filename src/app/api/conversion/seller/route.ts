import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/bq';
import { loadComerciales } from '@/lib/data';
import { MM_EXCLUIR_EMAILS, INMO_EXCLUIR_EMAILS, sqlNotIn } from '@/lib/accounts';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'csv-parse/sync';

// ── Cycle periods: (ciclo, asig_start, asig_end, cierre_start, cierre_end) ──
const CYCLE_PERIODS: [number, string, string, string, string][] = [
  [2,  '2026-02-26', '2026-03-24', '2026-03-04', '2026-03-31'],
  [3,  '2026-03-25', '2026-04-28', '2026-04-01', '2026-05-05'],
  [4,  '2026-04-29', '2026-05-26', '2026-05-06', '2026-06-02'],
  [5,  '2026-05-27', '2026-06-23', '2026-06-03', '2026-06-30'],
  [6,  '2026-06-24', '2026-07-28', '2026-07-01', '2026-08-04'],
  [7,  '2026-07-29', '2026-08-25', '2026-08-05', '2026-09-01'],
  [8,  '2026-08-26', '2026-09-22', '2026-09-02', '2026-09-29'],
  [9,  '2026-09-23', '2026-10-27', '2026-09-30', '2026-11-03'],
  [10, '2026-10-28', '2026-11-24', '2026-11-04', '2026-12-01'],
  [11, '2026-11-25', '2026-12-22', '2026-12-02', '2026-12-29'],
];
const EARLIEST_ASIG = CYCLE_PERIODS.reduce((m, p) => p[1] < m ? p[1] : m, CYCLE_PERIODS[0][1]);
const LATEST_CIERRE = CYCLE_PERIODS.reduce((m, p) => p[4] > m ? p[4] : m, CYCLE_PERIODS[0][4]);

// ── Fuentes excluidas del denominador MM ─────────────────────────────────────
const MM_FUENTES_EXCLUIDAS = ['Broker', 'comercial', 'Ventana'];
const MM_ZONAS_NO_COMPRAMOS = [5418, 5462, 5464, 47, 2279];
const MM_BLACKLIST_LOTE_IDS = [
  1805032, 1720249, 1715504, 1714970, 1704035, 1703723, 1703718, 1702232, 1702125,
  1701484, 1701482, 1700962, 1700322, 1699990, 1699267, 1698865, 1698539, 1696304,
  1696115, 1696097, 1695572, 1695552, 1695506, 1695145, 1695054, 1695009, 1694993,
  1694781, 1694270, 1693883, 1693760, 1693746, 1693624, 1693603, 1693593, 1693482,
  1693347, 1693334, 1693132, 1693131, 1693111, 1693099, 1693037, 1693036, 1693023,
  1693021, 1693018, 1692393, 1692379, 1692247, 1692219, 1692201, 1692198, 1692183,
  1692182, 1691702, 1691639, 1691588, 1691548, 1691165, 1691145, 1691107, 1690943,
  1690879, 1690870, 1690310, 1690183, 1665413, 1636808, 1633459, 1587499, 1584888,
  1582771, 1582455, 1572908, 1567869, 1562361, 1562350, 1562349, 1545499, 1545497,
  1545471, 1528264, 1511780, 1462998, 1451689, 1451664, 1448720, 1446102, 1437353,
  1437174, 1437011, 1428790, 1428789, 1427377, 1425878, 1421416, 1415358, 1415351,
  1415342, 1414067, 1397986, 1377404, 1362499, 1362490, 1359264, 1357414, 1357402,
  1357387, 1354452, 1352986, 1351275, 1339190, 1333870, 1304373, 1298527, 1298472,
  1298396, 1298359, 1294977, 1284315, 1281464, 1281421, 1263808, 1260525, 1260518,
  1254599, 1254594, 1234352, 1221639, 1217202, 1214793, 1208649, 1208589, 1208100,
  1208031, 1207813, 1207789, 1207738, 1207716, 1207567, 1207269, 1201430, 1201335,
  1199818, 1199667, 1199522, 1198813, 1194519, 1192844, 1192826, 1187934, 1186740,
  1186739, 1185930, 1185083, 1184348, 1184177, 1184021, 1184019, 1184012, 1183260,
  1183202, 1182478, 1182475, 1182474, 1182450, 1182449, 1182437, 1182341, 1182324,
  1182286, 1182155, 1182142, 1182131, 1182124, 1182069, 1181709, 1181671, 1181461,
  1181441, 1181326, 1181263, 1180318, 1180135, 1180107, 1180100, 1179995, 1179941,
  1179854, 1179772, 1171329, 1167824, 1167823, 1167822, 1167821, 1167788, 1167776,
  1167763, 1167761, 1167753, 1167712, 1167711, 1167707, 1167706, 1167688, 1167559,
  1167544, 1167543, 1167542, 1167541, 1167539, 1167032, 1167027, 1161764, 1153488,
  1153193, 1153192, 1153190, 1123208, 1073694, 1073693, 1073692, 1073691, 1073690,
  1073689, 1073688, 1073687, 1073686, 1073685, 1073684, 1073683, 1073666, 1073665,
  1073664, 1073662, 1073661, 1073660, 1073659, 1073658, 1073657, 1073655, 1073654,
  1073650, 964135, 964076, 963964, 963936, 963831, 963661, 962756, 942087, 924343,
  924068, 923966, 923103, 921948, 920305, 920092, 911526, 911485, 909625, 896183,
  895361, 894425, 880954, 878959, 877057, 872316, 871631, 871435, 871401, 871274,
  871239, 871230, 871227, 871199, 871156, 871093, 870837, 870732, 870731, 870724,
  870554, 870422, 870249, 870141, 869733, 868610, 868517, 868290, 868276, 867213,
  867192, 865955, 864900, 864899, 864897, 864595, 864529, 864437, 864217, 864201,
  863448, 863242, 862922, 862921, 862918, 861218, 860971, 860933, 860821, 860281,
  859780, 859630, 859629, 834748, 762494, 746952, 745156, 744925, 670376, 665434,
  663730, 642966, 638727, 615879, 587045, 574648, 566624, 549393, 548699, 548323,
  548322, 547715, 547712, 542387, 541833, 541468, 540768, 540230, 540104, 537822,
  536193, 531494, 531493, 524096, 523761, 518906, 518700, 518699, 511834, 507300,
  502214, 472879, 466773, 447236, 445514, 445246, 434446, 433807, 430048, 429669,
  429665, 429124, 428472, 417183, 416320, 410656, 397316, 379986, 379715, 379636,
  379554, 379357, 376905, 376879, 376866, 376821, 298178, 294014, 261062, 233942,
  233934, 231381, 230768, 228450, 224302, 223206, 222961, 219896, 219819, 219508,
  219505, 207980, 178074, 171369, 170794, 162441, 160134, 159705, 159467, 147987,
  132081, 84318, 73910, 73331, 62926, 56298, 55088, 40389, 40253, 37493, 36598,
  34871, 32836, 28630, 26656, 25972, 23761, 21636, 17458, 14889, 13669, 13355,
  12968, 6788, 6704, 4328, 4167, 2440, 743, 650,
];

// ── Pipeline stages Inmo ─────────────────────────────────────────────────────
const PIPELINE_STAGES_INMO = [
  '1182117549', '1182117546', '1182117545', '1182117550', '1182117547',
  '1182117548', '1182117544', '1182117555', '1182117559', '1182117634',
  '1182117640', '1182117553', '1182117636', '1182117560', '1182117637',
  '1182117638', '1182117554', '1182117558', '1182117561', '1182117635',
  '1182117632', '1182117633', '1182117557', '1182117556', '1182117639',
  '1196757523',
];
const STAGE_ID_CAPTADO_INMO = '1182117633';

// ── Metas CVR por (equipo, categoría) ────────────────────────────────────────
const META_CVR_MM_BOGOTA: Record<string, number> = { A: 0.12, B: 0.04, C: 0.02 };
const META_CVR_MM_CIUDADES: Record<string, Record<string, number>> = {
  'Medellín':     { A: 0.12, B: 0.03, C: 0.03 },
  'Cali':         { A: 0.10, B: 0.03, C: 0.03 },
  'Barranquilla': { A: 0.10, B: 0.03, C: 0.03 },
};
const EQUIPOS_BOGOTA_MM = new Set(['Bogotá Norte', 'Bogotá Sur']);
const META_CVR_INMO: Record<string, number> = { A: 0.25, B: 0.09, C: 0.046 };

// ── Helpers ──────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function catLetter(s: string | null | undefined): string {
  if (!s) return '';
  const parts = s.trim().split(/\s+/);
  return parts[parts.length - 1].toUpperCase();
}

function metaCvrMm(equipo: string, categoria: string): number | null {
  const cat = catLetter(categoria);
  if (!['A', 'B', 'C'].includes(cat)) return null;
  if (EQUIPOS_BOGOTA_MM.has(equipo)) return META_CVR_MM_BOGOTA[cat] ?? null;
  if (equipo in META_CVR_MM_CIUDADES) return META_CVR_MM_CIUDADES[equipo][cat] ?? null;
  return null;
}

function metaCvrInmo(_equipo: string, categoria: string): number | null {
  return META_CVR_INMO[catLetter(categoria)] ?? null;
}

function comercialesUnnest(): string {
  const com = loadComerciales();
  if (!com.length) return "SELECT '' AS email, '' AS equipo, '' AS categoria WHERE FALSE";
  const structs = com.map(c =>
    `STRUCT('${esc(c.email)}' AS email, '${esc(c.equipo)}' AS equipo, '${esc(c.categoria)}' AS categoria)`
  );
  return 'SELECT * FROM UNNEST([' + structs.join(', ') + '])';
}

function cycleCaseExpr(field: string, idxStart: 1 | 3, idxEnd: 2 | 4): string {
  const cases = CYCLE_PERIODS.map(p =>
    `WHEN DATE(${field}) BETWEEN '${p[idxStart]}' AND '${p[idxEnd]}' THEN ${p[0]}`
  );
  return 'CASE ' + cases.join(' ') + ' ELSE NULL END';
}

// ── Excluded NIDs (from CSV) ─────────────────────────────────────────────────
let _excludedNids: string[] | null = null;
function loadExcludedNids(): string[] {
  if (_excludedNids !== null) return _excludedNids;
  const file = join(process.cwd(), "data", "NID's para excluir asignaciones Colombia - nids_MM.csv");
  if (!existsSync(file)) { _excludedNids = []; return _excludedNids; }
  const raw = readFileSync(file, 'utf-8');
  const records = parse(raw, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  _excludedNids = [];
  for (const row of records) {
    const v = (row['nids_a_excluir'] || row['nids_a_excluir '] || '').trim();
    if (/^\d+$/.test(v)) _excludedNids.push(v);
  }
  return _excludedNids;
}

// ── Metas comerciales (Inmo activos) ─────────────────────────────────────────
interface MetaRow {
  comercial_id: string;
  equipo: string;
  mes: number;
  meta_captacion: string;
  meta_pcv: string;
  rol: string;
  categoria: string;
}
let _metasComerciales: MetaRow[] | null = null;
function loadMetasComerciales(): MetaRow[] {
  if (_metasComerciales !== null) return _metasComerciales;
  const file = join(process.cwd(), 'data', 'metas_comerciales_co.csv');
  if (!existsSync(file)) { _metasComerciales = []; return _metasComerciales; }
  const raw = readFileSync(file, 'utf-8');
  const records = parse(raw, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  _metasComerciales = [];
  for (const row of records) {
    const cid = (row['comercial_id'] || '').trim().toLowerCase();
    const mes = (row['mes'] || '').trim();
    if (!cid || !/^\d+$/.test(mes)) continue;
    _metasComerciales.push({
      comercial_id: cid,
      equipo: (row['Equipo'] || '').trim(),
      mes: parseInt(mes),
      meta_captacion: (row['meta_captacion'] || '').trim(),
      meta_pcv: (row['meta_pcv'] || '').trim(),
      rol: (row['rol'] || '').trim(),
      categoria: (row['Categoria'] || '').trim(),
    });
  }
  return _metasComerciales;
}

function comercialesActivosInmoUnnest(): string {
  const rows = loadMetasComerciales();
  const activos: MetaRow[] = [];
  for (const r of rows) {
    let isActive = false;
    if ([202512, 202601].includes(r.mes) && r.meta_captacion && r.equipo === 'Inmobiliaria') {
      isActive = true;
    } else if (r.mes >= 202602 && r.mes <= 202604 && r.meta_pcv) {
      isActive = true;
    } else if (r.mes >= 202605 && r.meta_pcv && r.rol === 'Inmobiliaria') {
      isActive = true;
    }
    if (isActive) activos.push(r);
  }
  if (!activos.length) {
    return "SELECT '' AS comercial_id, '' AS Equipo, '' AS Categoria, '' AS rol, 202601 AS mes, DATE '2026-01-01' AS mes_date WHERE FALSE";
  }
  const structs = activos.map(r => {
    const yyyy = Math.floor(r.mes / 100);
    const mm = r.mes % 100;
    const mesDate = `DATE '${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-01'`;
    return (
      `STRUCT('${esc(r.comercial_id)}' AS comercial_id, ` +
      `'${esc(r.equipo)}' AS Equipo, ` +
      `'${esc(r.categoria)}' AS Categoria, ` +
      `'${esc(r.rol)}' AS rol, ` +
      `${r.mes} AS mes, ` +
      `${mesDate} AS mes_date)`
    );
  });
  return 'SELECT * FROM UNNEST([' + structs.join(', ') + '])';
}

// ── Campaign filter helper ───────────────────────────────────────────────────

/**
 * Returns a SQL IN clause for utm_campaign filtering.
 * Returns 'TRUE' (no-op AND) when campaigns list is empty.
 * The match is against TRIM(field) to mirror how options come out of /campaigns.
 */
function campaignIn(field: string, campaigns: string[]): string {
  if (!campaigns.length) return 'TRUE';
  const list = campaigns.map(c => `'${c.replace(/'/g, "\\'")}'`).join(', ');
  return `${field} IN (${list})`;
}

// ── Fetch MM data ────────────────────────────────────────────────────────────
async function fetchMm(
  campaigns: string[] = [],
  asigCutoff?: string,
  cierreCutoff?: string,
): Promise<Record<string, unknown>[]> {
  const asigCase = cycleCaseExpr('s.fecha_asignacion', 1, 2);
  const cierreCase = cycleCaseExpr('f.fecha', 3, 4);
  const botsLst = MM_EXCLUIR_EMAILS.map(e => `'${e}'`).join(', ');
  const fuentesExcl = MM_FUENTES_EXCLUIDAS.map(f => `'${f}'`).join(', ');
  const blacklist = Array.from(new Set(MM_BLACKLIST_LOTE_IDS)).sort((a, b) => a - b).join(', ');
  const zonas = MM_ZONAS_NO_COMPRAMOS.join(', ');

  // Campaign filter: asig already has JOIN to deals (alias d); cierres comes from
  // funnel_diarios_col without deals → add a conditional JOIN (alias dcam).
  const asigCampaignClause = campaigns.length
    ? `AND ${campaignIn('TRIM(d.utm_campaign)', campaigns)}`
    : '';
  const cierreCampaignJoin = campaigns.length
    ? 'LEFT JOIN `sellers-main-prod.hubspot.deals` dcam ON dcam.nid = f.nid'
    : '';
  const cierreCampaignClause = campaigns.length
    ? `AND ${campaignIn('TRIM(dcam.utm_campaign)', campaigns)}`
    : '';

  // Cutoff clauses for cycle-to-date comparisons
  const asigCutoffClause = asigCutoff ? `AND DATE(s.fecha_asignacion) <= '${asigCutoff}'` : '';
  const cierreCutoffClause = cierreCutoff ? `AND DATE(f.fecha) <= '${cierreCutoff}'` : '';

  const sql = `
    WITH comerciales AS (${comercialesUnnest()}),
    asig_per_seller AS (
      SELECT
        ${asigCase} AS ciclo,
        LOWER(s.hubspot_owner_id) AS owner_email,
        COUNT(DISTINCT s.nid) AS asignados,
        COUNT(DISTINCT IF(UPPER(TRIM(s.categoria_comercial))='A', s.nid, NULL)) AS asig_a,
        COUNT(DISTINCT IF(UPPER(TRIM(s.categoria_comercial))='B', s.nid, NULL)) AS asig_b,
        COUNT(DISTINCT IF(UPPER(TRIM(s.categoria_comercial))='C', s.nid, NULL)) AS asig_c,
        COUNT(DISTINCT IF(s.categoria_comercial IS NULL OR UPPER(TRIM(s.categoria_comercial)) NOT IN ('A','B','C'), s.nid, NULL)) AS asig_sc
      FROM \`sellers-main-prod.bi_co.seguimiento_asignacion_ibuyer_co\` s
      LEFT JOIN \`papyrus-data.habi_wh_bi.tabla_inmuebles_general\` ig ON ig.nid = s.nid
      LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = s.nid
      WHERE s.tipo_asignacion_comercial = 'Primer Asignación comercial'
        AND DATE(s.fecha_asignacion) BETWEEN '${EARLIEST_ASIG}' AND '${LATEST_CIERRE}'
        AND s.hubspot_owner_id IS NOT NULL
        AND s.hubspot_owner_id != ''
        AND LOWER(s.hubspot_owner_id) NOT IN (${botsLst})
        AND LOWER(s.hubspot_owner_id) NOT LIKE '%@tuhabi.mx'
        AND s.fuente NOT IN (${fuentesExcl})
        AND d.prioridad_gestion_market_maker IS NOT NULL
        AND d.prioridad_gestion_market_maker != ''
        AND LOWER(IFNULL(ig.campana_mercadeo, '')) NOT LIKE '%referido%'
        AND IFNULL(ig.lote_id, -1) NOT IN (${blacklist})
        AND IFNULL(ig.zona_mediana_id, -1) NOT IN (${zonas})
        ${asigCampaignClause}
        ${asigCutoffClause}
      GROUP BY 1, 2
      HAVING ciclo IS NOT NULL
    ),
    cierres_nid AS (
      SELECT
        ${cierreCase} AS ciclo,
        LOWER(f.hubspot_owner_id_historico) AS owner_email,
        f.nid,
        UPPER(TRIM(f.categoria_comercial)) AS cat
      FROM \`papyrus-data.habi_wh_bi.funnel_diarios_col\` f
      ${cierreCampaignJoin}
      WHERE f.valor = 'Cierre - Comprado'
        AND DATE(f.fecha) BETWEEN '${EARLIEST_ASIG}' AND '${LATEST_CIERRE}'
        AND f.hubspot_owner_id_historico IS NOT NULL
        AND f.hubspot_owner_id_historico != ''
        AND LOWER(f.hubspot_owner_id_historico) NOT IN (${botsLst})
        AND LOWER(f.hubspot_owner_id_historico) NOT LIKE '%@tuhabi.mx'
        ${cierreCampaignClause}
        ${cierreCutoffClause}
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY ${cierreCase}, LOWER(f.hubspot_owner_id_historico), f.nid
        ORDER BY f.fecha DESC
      ) = 1
    ),
    cierres_per_seller AS (
      SELECT
        ciclo,
        owner_email,
        COUNT(*) AS cierres,
        COUNTIF(cat = 'A') AS cie_a,
        COUNTIF(cat = 'B') AS cie_b,
        COUNTIF(cat = 'C') AS cie_c,
        COUNTIF(cat IS NULL OR cat NOT IN ('A','B','C')) AS cie_sc
      FROM cierres_nid
      GROUP BY 1, 2
      HAVING ciclo IS NOT NULL
    )
    SELECT
      COALESCE(a.ciclo, c.ciclo) AS ciclo,
      COALESCE(a.owner_email, c.owner_email) AS owner_email,
      COALESCE(co.equipo, '')    AS equipo_csv,
      COALESCE(co.categoria, '') AS categoria_csv,
      COALESCE(a.asignados, 0) AS asignados,
      COALESCE(c.cierres,   0) AS cierres_in_cycle,
      COALESCE(a.asig_a, 0) AS asig_a, COALESCE(a.asig_b, 0) AS asig_b,
      COALESCE(a.asig_c, 0) AS asig_c, COALESCE(a.asig_sc, 0) AS asig_sc,
      COALESCE(c.cie_a, 0) AS cie_a, COALESCE(c.cie_b, 0) AS cie_b,
      COALESCE(c.cie_c, 0) AS cie_c, COALESCE(c.cie_sc, 0) AS cie_sc
    FROM asig_per_seller a
    FULL OUTER JOIN cierres_per_seller c
      ON a.ciclo = c.ciclo AND a.owner_email = c.owner_email
    LEFT JOIN comerciales co ON co.email = COALESCE(a.owner_email, c.owner_email)
  `;

  const rows = await query(sql);
  const intCols = [
    'asignados', 'cierres_in_cycle', 'asig_a', 'asig_b', 'asig_c',
    'asig_sc', 'cie_a', 'cie_b', 'cie_c', 'cie_sc',
  ];
  for (const r of rows) {
    r.ciclo = Number(r.ciclo);
    for (const col of intCols) {
      r[col] = Number(r[col]);
    }
  }
  return rows;
}

// ── Fetch Inmo data ──────────────────────────────────────────────────────────
async function fetchInmo(
  campaigns: string[] = [],
  asigCutoff?: string,
  cierreCutoff?: string,
): Promise<Record<string, unknown>[]> {
  const pipelineList = PIPELINE_STAGES_INMO.map(s => `"${s}"`).join(', ');
  const asigCase = cycleCaseExpr('t.fecha_primera_asignacion', 1, 2);
  const cierreCase = cycleCaseExpr('h.fecha', 3, 4);
  const botsInmo = INMO_EXCLUIR_EMAILS.map(e => `'${e}'`).join(', ');

  // Campaign filter for captados: deals table aliased d
  const capCampaignClause = campaigns.length
    ? `AND ${campaignIn('TRIM(d.utm_campaign)', campaigns)}`
    : '';
  // Campaign filter for asignados: tablero doesn't join deals → semi-join via subquery
  const asigCampaignClause = campaigns.length
    ? `AND t.nid IN (SELECT nid FROM \`sellers-main-prod.hubspot.deals\` d2 WHERE TRUE AND ${campaignIn('TRIM(d2.utm_campaign)', campaigns)})`
    : '';

  // Cutoff clauses for cycle-to-date comparisons
  const asigCutoffClause = asigCutoff ? `AND DATE(t.fecha_primera_asignacion) <= '${asigCutoff}'` : '';
  const cierreCutoffClause = cierreCutoff ? `AND DATE(h.fecha) <= '${cierreCutoff}'` : '';

  const sql = `
    WITH comerciales AS (${comercialesUnnest()}),
    -- Asignados (denominador): fuente OFICIAL tablero_asignacion_inmo_col (1 fila/nid).
    -- Ciclo por fecha_primera_asignacion; excluye bots/buffers y cuentas MX.
    -- Only counts CONSISTENT assignments (asignacion_consistente = TRUE): the official
    -- tablero flag (assignment in same month as priority). Without it inconsistent
    -- reassignments slip in and totals don't match the commercial report.
    asig_per_seller AS (
      SELECT
        ${asigCase} AS ciclo,
        LOWER(t.comercial_asignado)               AS owner_email,
        COALESCE(t.prioridad_de_gestion_inmo, '') AS prioridad,
        ANY_VALUE(t.equipo)                       AS equipo_src,
        ANY_VALUE(t.categoria)                    AS categoria_src,
        COUNT(DISTINCT t.nid)                     AS asignados
      FROM \`sellers-main-prod.bi_co.tablero_asignacion_inmo_col\` t
      WHERE t.comercial_asignado IS NOT NULL AND t.comercial_asignado != ''
        AND LOWER(t.comercial_asignado) NOT IN (${botsInmo})
        AND LOWER(t.comercial_asignado) NOT LIKE '%@tuhabi.mx'
        AND t.asignacion_consistente = TRUE
        ${asigCampaignClause}
        ${asigCutoffClause}
      GROUP BY 1, 2, 3
      HAVING ciclo IS NOT NULL
    ),
    historical_inmo AS (
      SELECT h.nid, h.fecha, h.valor AS stage_id
      FROM \`sellers-main-prod.hubspot.historical\` h
      WHERE h.propiedad = 'dealstage'
        AND h.valor IN (${pipelineList})
        AND DATE(h.fecha) BETWEEN '${EARLIEST_ASIG}' AND '${LATEST_CIERRE}'
        ${cierreCutoffClause}
    ),
    captados_per_seller AS (
      SELECT
        ${cierreCase} AS ciclo,
        LOWER(d.hubspot_owner_id) AS owner_email,
        COALESCE(d.prioridad_de_gestion_inmo, '') AS prioridad,
        COUNT(DISTINCT h.nid) AS captados
      FROM historical_inmo h
      LEFT JOIN \`sellers-main-prod.hubspot.deals\` d ON d.nid = h.nid
      WHERE h.stage_id = '${STAGE_ID_CAPTADO_INMO}'
        AND ${sqlNotIn('d.hubspot_owner_id', INMO_EXCLUIR_EMAILS)}
        ${capCampaignClause}
      GROUP BY 1, 2, 3
      HAVING ciclo IS NOT NULL AND owner_email IS NOT NULL AND owner_email != ''
    )
    SELECT
      COALESCE(a.ciclo, c.ciclo)             AS ciclo,
      COALESCE(a.owner_email, c.owner_email) AS owner_email,
      COALESCE(a.prioridad, c.prioridad, '') AS prioridad,
      -- Equipo/Categoría: comerciales.csv (foto actual) over metas (generic for old periods)
      COALESCE(NULLIF(co.equipo, ''), a.equipo_src, '')       AS equipo_csv,
      COALESCE(NULLIF(co.categoria, ''), a.categoria_src, '') AS categoria_csv,
      COALESCE(a.asignados, 0)               AS asignados,
      COALESCE(c.captados,  0)               AS captados_in_cycle
    FROM asig_per_seller a
    FULL OUTER JOIN captados_per_seller c
      ON a.ciclo = c.ciclo AND a.owner_email = c.owner_email AND a.prioridad = c.prioridad
    LEFT JOIN comerciales co ON co.email = COALESCE(a.owner_email, c.owner_email)
  `;

  const rows = await query(sql);
  // Query returns grain (ciclo, seller, prioridad). Pivot to one row per (ciclo, seller)
  // with breakdown by prioridad (asig_prio/num_prio) for frontend filtering.
  const agg = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const ciclo = Number(r.ciclo);
    const email = r.owner_email as string;
    const prio = ((r.prioridad as string) || '').trim() || 'Sin prioridad';
    const asig = Number(r.asignados);
    const cap = Number(r.captados_in_cycle);
    const key = `${ciclo}::${email}`;
    let a = agg.get(key);
    if (!a) {
      a = {
        ciclo,
        owner_email: email,
        equipo_csv: (r.equipo_csv as string) || '',
        categoria_csv: (r.categoria_csv as string) || '',
        asignados: 0,
        captados_in_cycle: 0,
        asig_prio: {} as Record<string, number>,
        num_prio: {} as Record<string, number>,
      };
      agg.set(key, a);
    }
    a.asignados = (a.asignados as number) + asig;
    a.captados_in_cycle = (a.captados_in_cycle as number) + cap;
    if (asig) {
      const ap = a.asig_prio as Record<string, number>;
      ap[prio] = (ap[prio] || 0) + asig;
    }
    if (cap) {
      const np = a.num_prio as Record<string, number>;
      np[prio] = (np[prio] || 0) + cap;
    }
    if (!(a.equipo_csv as string) && r.equipo_csv) a.equipo_csv = r.equipo_csv;
    if (!(a.categoria_csv as string) && r.categoria_csv) a.categoria_csv = r.categoria_csv;
  }
  return Array.from(agg.values());
}

// ── Enrich rows (shared by /data and /kpis-compare) ─────────────────────────
interface EnrichedRow {
  ciclo: number;
  email: string;
  equipo: string;
  categoria: string;
  asignados: number;
  num: number;
  cvr: number | null;
  cvr_meta: number | null;
  asig_cat: Record<string, number>;
  num_cat: Record<string, number>;
  asig_prio: Record<string, number>;
  num_prio: Record<string, number>;
}

function enrichRows(rows: Record<string, unknown>[], producto: 'mm' | 'inmo'): EnrichedRow[] {
  const out: EnrichedRow[] = [];
  for (const r of rows) {
    const equipo = r.equipo_csv as string;
    const cat = catLetter(r.categoria_csv as string);
    const meta = producto === 'mm' ? metaCvrMm(equipo, cat) : metaCvrInmo(equipo, cat);
    const num = producto === 'mm' ? (r.cierres_in_cycle as number) : (r.captados_in_cycle as number);
    const asig = r.asignados as number;
    const cvr = asig > 0 ? num / asig : null;

    let asigCat: Record<string, number>;
    let numCat: Record<string, number>;
    if (producto === 'mm') {
      asigCat = { A: r.asig_a as number, B: r.asig_b as number, C: r.asig_c as number, SC: r.asig_sc as number };
      numCat = { A: r.cie_a as number, B: r.cie_b as number, C: r.cie_c as number, SC: r.cie_sc as number };
    } else {
      // Inmo: no separate lead category — attribute to seller's category
      const k = ['A', 'B', 'C'].includes(cat) ? cat : 'SC';
      asigCat = { A: 0, B: 0, C: 0, SC: 0 }; asigCat[k] = asig;
      numCat = { A: 0, B: 0, C: 0, SC: 0 }; numCat[k] = num;
    }

    out.push({
      ciclo: r.ciclo as number,
      email: r.owner_email as string,
      equipo,
      categoria: cat,
      asignados: asig,
      num,
      cvr,
      cvr_meta: meta,
      asig_cat: asigCat,
      num_cat: numCat,
      // Breakdown by prioridad_de_gestion_inmo (Inmo only; MM = {})
      asig_prio: (r.asig_prio as Record<string, number>) || {},
      num_prio: (r.num_prio as Record<string, number>) || {},
    });
  }
  return out;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

function handleCycles() {
  return NextResponse.json({
    periods: CYCLE_PERIODS.map(p => ({
      ciclo: p[0],
      asig_start: p[1],
      asig_end: p[2],
      cierre_start: p[3],
      cierre_end: p[4],
    })),
  });
}

async function handleCampaigns() {
  // Lists distinct utm_campaign values from the universe of the tab
  // (MM asig: seguimiento_asignacion_ibuyer_co; Inmo: historical owner-change)
  // within the cycle window, so the list is relevant to CO and not MX.
  const sql = `
    WITH universe AS (
      SELECT nid FROM \`sellers-main-prod.bi_co.seguimiento_asignacion_ibuyer_co\`
      WHERE DATE(fecha_asignacion) BETWEEN '${EARLIEST_ASIG}' AND '${LATEST_CIERRE}'
      UNION DISTINCT
      SELECT nid FROM \`sellers-main-prod.hubspot.historical\`
      WHERE propiedad = 'hubspot_owner_id'
        AND DATE(fecha) BETWEEN '${EARLIEST_ASIG}' AND '${LATEST_CIERRE}'
    )
    SELECT DISTINCT TRIM(d.utm_campaign) AS campaign
    FROM \`sellers-main-prod.hubspot.deals\` d
    JOIN universe u ON u.nid = d.nid
    WHERE d.utm_campaign IS NOT NULL AND TRIM(d.utm_campaign) != ''
    ORDER BY campaign
  `;
  const rows = await query(sql);
  return NextResponse.json({ campaigns: rows.map(r => r.campaign as string) });
}

async function handleData(searchParams: URLSearchParams) {
  const campaigns = searchParams.getAll('campaign').filter(Boolean);
  const [mmRows, inmoRows] = await Promise.all([fetchMm(campaigns), fetchInmo(campaigns)]);
  return NextResponse.json({
    mm: enrichRows(mmRows, 'mm'),
    inmo: enrichRows(inmoRows, 'inmo'),
  });
}

async function handleKpisCompare(searchParams: URLSearchParams) {
  const ciclo = parseInt(searchParams.get('ciclo') || '');
  const producto = (searchParams.get('producto') || 'mm') as 'mm' | 'inmo';
  const campaigns = searchParams.getAll('campaign').filter(Boolean);

  if (!ciclo) {
    return NextResponse.json({ error: 'ciclo param required' }, { status: 400 });
  }

  const periodsMap = new Map(CYCLE_PERIODS.map(p => [p[0], p]));
  const cur = periodsMap.get(ciclo);
  const prev = periodsMap.get(ciclo - 1);

  if (!cur || !prev) {
    return NextResponse.json({ prev_ciclo: null, prev_rows: [] });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const curAsigStart = new Date(cur[1]);
  const curCierreStart = new Date(cur[3]);

  // Days elapsed in each window (clamp >= 0). If the cycle already ended,
  // the prev window cap gets clipped to its end → full cycle vs full cycle comparison.
  const elapsedAsig = Math.max(
    Math.floor((today.getTime() - curAsigStart.getTime()) / 86400000),
    0,
  );
  const elapsedCierre = Math.max(
    Math.floor((today.getTime() - curCierreStart.getTime()) / 86400000),
    0,
  );

  const prevAsigStart = new Date(prev[1]);
  const prevAsigEnd = new Date(prev[2]);
  const prevCierreStart = new Date(prev[3]);
  const prevCierreEnd = new Date(prev[4]);

  // Add elapsed days to previous cycle start, clamped to cycle end
  const prevAsigCutDate = new Date(Math.min(
    prevAsigStart.getTime() + elapsedAsig * 86400000,
    prevAsigEnd.getTime(),
  ));
  const prevCierreCutDate = new Date(Math.min(
    prevCierreStart.getTime() + elapsedCierre * 86400000,
    prevCierreEnd.getTime(),
  ));

  const prevAsigCut = prevAsigCutDate.toISOString().slice(0, 10);
  const prevCierreCut = prevCierreCutDate.toISOString().slice(0, 10);

  let raw: Record<string, unknown>[];
  if (producto === 'mm') {
    raw = await fetchMm(campaigns, prevAsigCut, prevCierreCut);
  } else {
    raw = await fetchInmo(campaigns, prevAsigCut, prevCierreCut);
  }

  // Filter to only previous cycle rows
  const prevRows = enrichRows(raw, producto).filter(r => r.ciclo === ciclo - 1);

  return NextResponse.json({
    producto,
    ciclo,
    prev_ciclo: ciclo - 1,
    elapsed_asig_days: elapsedAsig,
    elapsed_cierre_days: elapsedCierre,
    prev_asig_cut: prevAsigCut,
    prev_cierre_cut: prevCierreCut,
    prev_rows: prevRows,
  });
}

// ── GET handler ──────────────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  switch (action) {
    case 'cycles':    return handleCycles();
    case 'campaigns': return handleCampaigns();
    case 'data':      return handleData(searchParams);
    case 'kpis-compare': return handleKpisCompare(searchParams);
    default:
      return NextResponse.json(
        { error: 'Unknown action. Use ?action=cycles, ?action=campaigns, ?action=data, or ?action=kpis-compare' },
        { status: 400 },
      );
  }
}
