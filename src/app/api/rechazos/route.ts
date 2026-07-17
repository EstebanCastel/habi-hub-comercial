/**
 * Rechazos API Route — ported faithfully from webapp/routers/rechazos.py
 *
 * Replica el análisis de razones de rechazo/aprobación del comité (reporte Looker):
 * para cada nid que pasó por `pre-comité validado`, determina si terminó
 * Aprobado General, Rechazo Comite o Rechazo Remo, y con qué razón.
 *
 * Actions (via ?action=XXX):
 *   filters → { areas: [ciudades] }
 *   data    → { meses, total_mes, serie, razones }
 *
 * POST: clears BQ cache (mirrors /api/admin/cache/clear)
 */
import { NextRequest, NextResponse } from 'next/server';
import { query, cacheClear } from '@/lib/bq';
import { loadCycles } from '@/lib/data';

// ── Constants ────────────────────────────────────────────────────────────────

const FECHA_INICIO = '2026-01-01';

// Valores que en remodelaciones cuentan como aprobación (no rechazo).
const _REMO_APROBADO =
  "'Aprobado','Aprobado Virtual','aprobado sin servicios publicos'," +
  "'Aprobado, inmueble sin contadores','Aprobado sin servicios públicos - obra gris'";

const TIPOS = ['Aprobado General', 'Rechazo Comite', 'Rechazo Remo'] as const;
type Tipo = (typeof TIPOS)[number];

// ── Helpers ──────────────────────────────────────────────────────────────────

function _quoteList(items: string[]): string {
  return items.map(i => `'${i.replace(/'/g, "''")}'`).join(', ');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Área metropolitana curada a partir de `ciudad` (NO se usa area_metropolitana cruda). */
function _areaExpr(alias = 'h'): string {
  const c = `LOWER(TRIM(${alias}.ciudad))`;
  return `CASE
      WHEN ${c} IN ('bogotá','bogota','soacha','madrid','zipaquirá','zipaquira','tocancipá','tocancipa','mosquera','chía','chia','cajica','cajicá','funza','facatativa','facatativá','cota','la calera','sopó','sopo','tenjo','sibaté','sibate') THEN 'Bogotá'
      WHEN ${c} IN ('medellín','medellin','bello','sabaneta','rionegro','itagui','itagüí','itagui','la estrella','envigado','copacabana','girardota','caldas','barbosa') THEN 'Medellín'
      WHEN ${c} IN ('cali','yumbo','palmira','jamundí','jamundi','candelaria') THEN 'Cali'
      WHEN ${c} IN ('barranquilla','soledad','puerto colombia','malambo','galapa','sabanagrande') THEN 'Barranquilla'
      WHEN ${c} IN ('cartagena') THEN 'Cartagena'
      WHEN ${c} IN ('santa marta') THEN 'Santa Marta'
      WHEN ${c} IS NULL OR ${c} = '' THEN NULL
      ELSE 'Otras'
    END`;
}

/** Etiqueta de período (ordenable) según granularidad. mes|semana|dia|mes_com|sem_com. */
function _periodExpr(gran: string, field = 'f.fecha'): string {
  const d = `DATE(${field})`;
  if (gran === 'dia') {
    return `FORMAT_DATE('%Y-%m-%d', ${d})`;
  }
  if (gran === 'semana') {
    return `FORMAT_DATE('%Y-%m-%d', DATE_TRUNC(${d}, WEEK(MONDAY)))`;
  }
  if (gran === 'mes_com' || gran === 'sem_com') {
    const whens: string[] = [];
    if (gran === 'mes_com') {
      const cycles = loadCycles() as unknown as { ciclo: number; mes: string; year: number; inicio: string; fin: string }[];
      for (const c of cycles) {
        const mesShort = c.mes.slice(0, 3).charAt(0).toUpperCase() + c.mes.slice(0, 3).slice(1);
        const label = `C${String(c.ciclo).padStart(2, '0')} · ${mesShort} ${String(c.year).slice(2)}`;
        whens.push(`WHEN ${d} BETWEEN '${c.inicio}' AND '${c.fin}' THEN '${label}'`);
      }
    } else {
      const cycles = loadCycles() as unknown as { ciclo: number; semanas: { num: number; inicio: string; fin: string }[] }[];
      for (const c of cycles) {
        for (const s of c.semanas) {
          const label = `C${String(c.ciclo).padStart(2, '0')}-S${String(s.num).padStart(2, '0')}`;
          whens.push(`WHEN ${d} BETWEEN '${s.inicio}' AND '${s.fin}' THEN '${label}'`);
        }
      }
    }
    return `CASE ${whens.join(' ')} ELSE NULL END`;
  }
  return `FORMAT_DATE('%Y-%m', ${d})`; // mes (default)
}

/**
 * CTE `base`: una fila por (nid, período) que pasó por pre-comité validado, con su
 * clasificación 3-way (rechazos_general) y su razón (razon_rechazo_general).
 */
function _baseCte(
  fechaDesde: string,
  fechaHasta: string,
  areas: string[] | null,
  gran = 'mes',
): string {
  let areaClause = '';
  if (areas && areas.length) {
    areaClause = `AND ${_areaExpr('h')} IN (${_quoteList(areas)})`;
  }
  const periodSql = _periodExpr(gran);

  // Expresiones compartidas (remo → comité → aprobado general)
  const remoIsRechazo =
    `IF(rrr.razon_rechazo_remodelaciones IN (${_REMO_APROBADO}), 'Aprobado', ` +
    `IF(rrr.razon_rechazo_remodelaciones IS NULL, 'Nulo', 'Rechazo'))`;
  const comiteVal = 'IFNULL(rrc.razon_rechazo_comite, rrc_.razon_rechazo_comite)';
  const comiteIsRechazo = `IF((${comiteVal} IS NULL OR ${comiteVal} = ''), 'Aprobado', 'Rechazo')`;
  const razonGeneral =
    `IF(${remoIsRechazo} = 'Rechazo', rrr.razon_rechazo_remodelaciones, ` +
    `IF(${comiteIsRechazo} = 'Rechazo' ` +
    `OR LOWER(TRIM(odn.oportunidad_del_negocio)) = 'descartado por comité', ` +
    `${comiteVal}, 'Aprobado General'))`;
  const rechazosGeneral =
    `IF(${remoIsRechazo} = 'Rechazo', 'Rechazo Remo', ` +
    `IF(${comiteIsRechazo} = 'Rechazo' ` +
    `OR LOWER(TRIM(odn.oportunidad_del_negocio)) = 'descartado por comité', ` +
    `'Rechazo Comite', 'Aprobado General'))`;

  return `
    WITH fecha AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY nid ORDER BY fecha DESC) AS ultimo_envio
      FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY nid, DATE_TRUNC(DATE(fecha), MONTH) ORDER BY fecha DESC) AS numero_envio_mes
        FROM \`papyrus-master.squad_bi_global.hubspot_historical\` hh
        WHERE hh.propiedad = 'oportunidad_del_negocio' AND LOWER(hh.valor) = 'pre-comité validado'
      )
      WHERE numero_envio_mes = 1
    ),
    rrc_t AS (SELECT nid, fecha_mes, razon_rechazo_comite FROM \`papyrus-data.habi_wh_analytics.ultima_razon_rechazo_comite\`),
    rrr_t AS (SELECT nid, fecha_mes, razon_rechazo_remodelaciones FROM \`papyrus-data.habi_wh_analytics.ultima_razon_rechazo_remodelaciones\`),
    odn_t AS (
      SELECT * FROM (
        SELECT nid, fecha, DATE_TRUNC(DATE(fecha), MONTH) fecha_mes, TRIM(valor) AS oportunidad_del_negocio,
          ROW_NUMBER() OVER (PARTITION BY nid, DATE_TRUNC(DATE(fecha), MONTH) ORDER BY fecha DESC) AS n
        FROM \`papyrus-master.squad_bi_global.hubspot_historical\` hh
        WHERE hh.propiedad = 'oportunidad_del_negocio' AND TRIM(hh.valor) IS NOT NULL AND TRIM(hh.valor) != ''
      )
      WHERE n = 1
    ),
    base AS (
      SELECT
        h.nid AS nid,
        ${periodSql} AS periodo,
        ${razonGeneral} AS razon_rechazo_general,
        ${rechazosGeneral} AS rechazos_general
      FROM \`papyrus-master.squad_bi_global.hubspot_deal\` h
      LEFT JOIN fecha f ON f.nid = h.nid
      LEFT JOIN rrc_t rrc  ON CONCAT(rrc.nid, rrc.fecha_mes)  = CONCAT(f.nid, DATE_TRUNC(DATE(f.fecha), MONTH))
      LEFT JOIN rrc_t rrc_ ON CONCAT(rrc_.nid, rrc_.fecha_mes) = CONCAT(f.nid, DATE_ADD(DATE_TRUNC(DATE(f.fecha), MONTH), INTERVAL 1 MONTH))
      LEFT JOIN rrr_t rrr  ON CONCAT(rrr.nid, rrr.fecha_mes)  = CONCAT(f.nid, DATE_TRUNC(DATE(f.fecha), MONTH))
      LEFT JOIN odn_t odn  ON CONCAT(odn.nid, odn.fecha_mes)  = CONCAT(f.nid, DATE_TRUNC(DATE(f.fecha), MONTH))
      WHERE f.fecha IS NOT NULL
        AND DATE(f.fecha) BETWEEN '${fechaDesde}' AND '${fechaHasta}'
        AND IF((LOWER(TRIM(odn.oportunidad_del_negocio)) IN ('aprobación comité final', 'aprobación fase 1', 'pre-comité', 'pre-comité validado')
              AND f.ultimo_envio = 1 AND DATE_TRUNC(DATE(f.fecha), MONTH) > DATE_SUB(CURRENT_DATE('-05'), INTERVAL 30 DAY)), 1, 0) = 0
        ${areaClause}
    )`;
}

// ── Action handlers ──────────────────────────────────────────────────────────

async function handleFilters(params: URLSearchParams): Promise<NextResponse> {
  const fechaDesde = params.get('fecha_desde') || FECHA_INICIO;
  const fechaHasta = params.get('fecha_hasta') || today();

  const sql = `${_baseCte(fechaDesde, fechaHasta, null)}
    SELECT DISTINCT area FROM (
      SELECT ${_areaExpr('h')} AS area
      FROM \`papyrus-master.squad_bi_global.hubspot_deal\` h
      JOIN base b ON b.nid = h.nid
    )
    WHERE area IS NOT NULL AND area != ''
    ORDER BY area
    `;
  const rows = await query(sql);
  return NextResponse.json({
    areas: rows.map(r => r['area'] as string).filter(a => a),
  });
}

async function handleData(params: URLSearchParams): Promise<NextResponse> {
  const fechaDesde = params.get('fecha_desde') || FECHA_INICIO;
  const fechaHasta = params.get('fecha_hasta') || today();
  const areas = params.getAll('area').filter(a => a);
  const granularidad = params.get('granularidad') || 'mes';

  const sql = `${_baseCte(fechaDesde, fechaHasta, areas, granularidad)}
    SELECT periodo AS mes, rechazos_general, razon_rechazo_general, COUNT(DISTINCT nid) AS n
    FROM base
    WHERE periodo IS NOT NULL
    GROUP BY 1, 2, 3
    ORDER BY 1
    `;
  const rows = await query(sql);

  const meses = [...new Set(rows.map(r => String(r['mes'])))].sort();
  const mesIdx: Record<string, number> = {};
  meses.forEach((m, i) => (mesIdx[m] = i));

  // serie[tipo][mes] = count
  const serie: Record<Tipo, Record<string, number>> = {
    'Aprobado General': {},
    'Rechazo Comite': {},
    'Rechazo Remo': {},
  };
  for (const t of TIPOS) for (const m of meses) serie[t][m] = 0;

  // razones: {(tipo, razon): {mes: count}}
  const razones = new Map<string, { tipo: string; razon: string; byMes: Record<string, number> }>();
  const totMes: Record<string, number> = {};
  for (const m of meses) totMes[m] = 0;

  for (const r of rows) {
    const m = String(r['mes']);
    const t = String(r['rechazos_general']) as Tipo;
    const n = Number(r['n']);
    const razon = (String(r['razon_rechazo_general'] ?? '').trim()) || '(sin razón)';
    if (t in serie) serie[t][m] += n;
    totMes[m] += n;
    const key = `${t} ${razon}`;
    let entry = razones.get(key);
    if (!entry) {
      entry = { tipo: t, razon, byMes: Object.fromEntries(meses.map(mm => [mm, 0])) };
      razones.set(key, entry);
    }
    entry.byMes[m] += n;
  }

  // serie_out[tipo] = { counts:[...], pct:[...] } (paralelos a `meses`)
  const serieOut: Record<string, { counts: number[]; pct: number[] }> = {};
  for (const t of TIPOS) {
    const counts = meses.map(m => serie[t][m]);
    const pct = meses.map(m => (totMes[m] ? Math.round((serie[t][m] / totMes[m]) * 1000) / 10 : 0));
    serieOut[t] = { counts, pct };
  }

  // razones_out: [{tipo, razon, counts:[...], total}] ordenado por total desc
  const razonesOut = [...razones.values()].map(e => {
    const counts = meses.map(m => e.byMes[m]);
    return {
      tipo: e.tipo,
      razon: e.razon,
      counts,
      total: counts.reduce((a, b) => a + b, 0),
    };
  });
  razonesOut.sort((a, b) => b.total - a.total);

  return NextResponse.json({
    meses,
    total_mes: meses.map(m => totMes[m]),
    serie: serieOut,
    razones: razonesOut,
  });
}

// ── Route handlers ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const action = searchParams.get('action') ?? '';

  try {
    if (action === 'filters') return await handleFilters(searchParams);
    if (action === 'data') return await handleData(searchParams);
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    console.error(`[rechazos] action=${action} error:`, err);
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
