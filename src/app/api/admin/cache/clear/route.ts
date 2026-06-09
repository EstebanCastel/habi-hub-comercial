import { NextResponse } from 'next/server';
import { cacheClear } from '@/lib/bq';

export async function POST() {
  const n = cacheClear();
  return NextResponse.json({ cleared: n });
}
