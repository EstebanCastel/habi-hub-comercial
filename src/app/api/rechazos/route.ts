/**
 * Rechazos API Route — ported from webapp/routers/rechazos.py
 *
 * Actions (via ?action=XXX):
 *   filters, data
 *
 * POST: clears BQ cache
 */
import { NextRequest, NextResponse } from 'next/server';
import { query, cacheClear } from '@/lib/bq';

// ── Constants ────────────────────────────────────────────────────────────────

const FECHA_INICIO = '2026-01-01';

// ── SQL helpers ──────────────────────────────────────────────────────────────

function quoteList(vals: string[]): string {
  return vals.map(v => `'${v.replace(/'/g, "''")}'`).join(', ');
}

function areaExpr(areas: string[]): string {
  if (!areas.length) return 'TRUE';
  return `hd.area_metropolitana IN (${quoteList(areas)})`;
}

function periodExpr(fechaDesde: string, fechaHasta: string): string {
  const parts = [`hd.fecha_comite_formato >= '${fechaDesde}'`];
  if (fechaHasta) {
    parts.push(`hd.fecha_comite_formato <= '${fechaHasta}'`);
  }
  return parts.join(' AND ');
}

function baseCte(areas: string[], fechaDesde: string, fechaHasta: string): string {
  return `
    base AS (
        SELECT
            FORMAT_DATE('%Y-%m', hd.fecha_comite_formato) AS mes,
            hd.resultado_comite_final AS tipo,
            hd.area_metropolitana AS area
        FROM \`papyrus-master.squad_bi_global.hubspot_historical\` hd
        WHERE hd.fecha_comite_formato IS NOT NULL
          AND hd.fecha_comite_formato >= '${FECHA_INICIO}'
          AND ${periodExpr(fechaDesde, fechaHasta)}
          AND ${areaExpr(areas)}
    )`;
}

// ── Action handlers ──────────────────────────────────────────────────────────

async function handleFilters(): Promise<NextResponse> {
  const sql = `
    SELECT DISTINCT hd.area_metropolitana AS area
    FROM \`papyrus-master.squad_bi_global.hubspot_historical\` hd
    WHERE hd.fecha_comite_formato IS NOT NULL
      AND hd.area_metropolitana IS NOT NULL
    ORDER BY 1
  `;
  const rows = await query(sql);
  return NextResponse.json({ areas: rows.map(r => r['area']) });
}

async function handleData(searchParams: URLSearchParams): Promise<NextResponse> {
  const fechaDesde = searchParams.get('fecha_desde') ?? FECHA_INICIO;
  const fechaHasta = searchParams.get('fecha_hasta') ?? '';
  const areas = searchParams.getAll('area');
  // granularidad kept for future use; currently unused in SQL (same as Python)
  // const granularidad = searchParams.get('granularidad') ?? 'mes';

  const cteBase = baseCte(areas, fechaDesde, fechaHasta);

  // ── Serie temporal de totales ────────────────────────────────────────────
  const sqlSerie = `
    WITH ${cteBase},
    totales AS (
        SELECT mes, COUNT(*) AS total
        FROM base GROUP BY mes
    ),
    tipos_raw AS (
        SELECT mes, tipo, COUNT(*) AS cnt
        FROM base GROUP BY mes, tipo
    )
    SELECT
        t.mes,
        t.total AS total_mes,
        tr.tipo,
        tr.cnt
    FROM totales t
    JOIN tipos_raw tr USING (mes)
    ORDER BY t.mes, tr.tipo
  `;

  // ── Razones de rechazo — Comité ──────────────────────────────────────────
  const areaJoinClause = areas.length ? areaExpr(areas) : 'TRUE';
  const sqlComite = `
    WITH ${cteBase},
    rechazos AS (
        SELECT mes, area FROM base WHERE tipo = 'Rechazo Comité'
    )
    SELECT r.mes, rc.razon_rechazo AS razon, COUNT(DISTINCT rc.deal_id) AS cnt
    FROM rechazos r
    JOIN \`papyrus-data.habi_wh_analytics.ultima_razon_rechazo_comite\` rc
        ON FORMAT_DATE('%Y-%m', rc.fecha_rechazo) = r.mes
    JOIN \`papyrus-master.squad_bi_global.hubspot_deal\` hd
        ON rc.deal_id = hd.id
        AND (${areaJoinClause})
    WHERE rc.razon_rechazo IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1, 3 DESC
  `;

  // ── Razones de rechazo — Remodelaciones ─────────────────────────────────
  const sqlRemo = `
    WITH ${cteBase},
    rechazos AS (
        SELECT mes, area FROM base WHERE tipo = 'Rechazo Remodelaciones'
    )
    SELECT r.mes, rr.razon_rechazo AS razon, COUNT(DISTINCT rr.deal_id) AS cnt
    FROM rechazos r
    JOIN \`papyrus-data.habi_wh_analytics.ultima_razon_rechazo_remodelaciones\` rr
        ON FORMAT_DATE('%Y-%m', rr.fecha_rechazo) = r.mes
    JOIN \`papyrus-master.squad_bi_global.hubspot_deal\` hd
        ON rr.deal_id = hd.id
        AND (${areaJoinClause})
    WHERE rr.razon_rechazo IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1, 3 DESC
  `;

  const [rowsSerie, rowsComite, rowsRemo] = await Promise.all([
    query(sqlSerie),
    query(sqlComite),
    query(sqlRemo),
  ]);

  // ── Build response ───────────────────────────────────────────────────────
  const mesesSet = new Set<string>();
  const serieByMes: Record<string, { total: number; tipos: Record<string, number> }> = {};

  for (const r of rowsSerie) {
    const m = String(r['mes']);
    mesesSet.add(m);
    if (!serieByMes[m]) {
      serieByMes[m] = { total: Number(r['total_mes']), tipos: {} };
    }
    serieByMes[m].tipos[String(r['tipo'])] = Number(r['cnt']);
  }

  const meses = [...mesesSet].sort();

  const tiposOrder = ['Aprobado General', 'Rechazo Comité', 'Rechazo Remodelaciones'];
  const totalMes: Record<string, number> = {};
  for (const m of meses) {
    totalMes[m] = serieByMes[m]?.total ?? 0;
  }

  const serie: Record<string, Record<string, number>> = {};
  for (const tipo of tiposOrder) {
    serie[tipo] = {};
    for (const m of meses) {
      serie[tipo][m] = serieByMes[m]?.tipos[tipo] ?? 0;
    }
  }

  const razones: {
    comite: Record<string, { razon: string; cnt: number }[]>;
    remo: Record<string, { razon: string; cnt: number }[]>;
  } = { comite: {}, remo: {} };

  for (const r of rowsComite) {
    const m = String(r['mes']);
    if (!razones.comite[m]) razones.comite[m] = [];
    razones.comite[m].push({ razon: String(r['razon']), cnt: Number(r['cnt']) });
  }
  for (const r of rowsRemo) {
    const m = String(r['mes']);
    if (!razones.remo[m]) razones.remo[m] = [];
    razones.remo[m].push({ razon: String(r['razon']), cnt: Number(r['cnt']) });
  }

  return NextResponse.json({ meses, total_mes: totalMes, serie, razones });
}

// ── Route handlers ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const action = searchParams.get('action') ?? '';

  try {
    if (action === 'filters') return await handleFilters();
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
