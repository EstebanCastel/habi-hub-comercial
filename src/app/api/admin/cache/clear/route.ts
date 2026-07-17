import { NextResponse } from 'next/server';
import { cacheClear } from '@/lib/bq';
import { resetMetasCache as resetMetasMM } from '@/app/api/funnel/mm/route';
import { resetMetasCache as resetMetasInmo } from '@/app/api/funnel/inmo/route';

export async function POST() {
  const n = cacheClear();
  // Igual que FastAPI (main.py): además de la caché BQ, invalidar las metas (MM + Inmo).
  resetMetasMM();
  resetMetasInmo();
  return NextResponse.json({ cleared: n });
}
