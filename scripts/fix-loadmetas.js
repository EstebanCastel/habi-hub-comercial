const fs = require('fs');
const path = require('path');

const routePath = path.join(__dirname, '..', 'src', 'app', 'api', 'funnel', 'mm', 'route.ts');

let content = fs.readFileSync(routePath, 'utf-8');

// Find the loadMetas function and replace it
const oldLoadMetas = `let _cachedMetas: Record<string, Record<string, Record<string, number>>> | null = null;

function loadMetas(): Record<string, Record<string, Record<string, number>>> {
  if (_cachedMetas) return _cachedMetas;

  // Read the metas CSV
  const { readFileSync, existsSync } = require('fs') as typeof import('fs');
  const { join } = require('path') as typeof import('path');
  const { parse } = require('csv-parse/sync') as typeof import('csv-parse/sync');

  const csvFile = join(process.cwd(), 'mm 2030 Sellers interno - MM Col Ciclos Todo el Funnel (Ciudades y equipos).csv');
  if (!existsSync(csvFile)) {
    _cachedMetas = {};
    return _cachedMetas;
  }

  const raw = readFileSync(csvFile, 'utf-8');
  const allRows: string[][] = [];
  const parsed = parse(raw, { relax_column_count: true }) as string[][];
  for (const r of parsed) allRows.push(r);

  if (allRows.length < 4) {
    _cachedMetas = {};
    return _cachedMetas;
  }

  const cicloRow = allRows[1];
  const weekRow = allRows[2];
  const colToCw: Record<number, [number, number]> = {};
  const maxCol = Math.max(cicloRow.length, weekRow.length);
  for (let i = 1; i < maxCol; i++) {
    const c = (cicloRow[i] || '').trim();
    const w = (weekRow[i] || '').trim();
    if (/^\\d+$/.test(c) && /^\\d+$/.test(w)) {
      colToCw[i] = [parseInt(c), parseInt(w)];
    }
  }

  const ETAPAS_LBL = new Set(Object.keys(META_ETAPA_TO_BQ));
  const ZONAS = new Set([...Object.keys(ZONA_TO_EQUIPO), 'Centro']);
  const CATS = new Set(['A', 'B', 'C']);

  const metas: Record<string, Record<string, Record<string, number>>> = {};
  let current: string | null = null;

  for (const row of allRows.slice(3)) {
    if (!row || !(row[0] || '').trim()) continue;
    const label = row[0].trim();
    let bucket: string | null = null;

    if (ETAPAS_LBL.has(label)) {
      current = label;
      metas[current] = { Total: {} };
      bucket = 'Total';
    } else if (current && ZONAS.has(label) && !metas[current][label]) {
      metas[current][label] = {};
      bucket = label;
    } else if (current === 'Cierres' && CATS.has(label) && !metas[current][label]) {
      metas[current][label] = {};
      bucket = label;
    }

    if (bucket === null) continue;

    for (const iStr of Object.keys(colToCw)) {
      const i = parseInt(iStr);
      if (i >= row.length) continue;
      const v = _parseVal(row[i]);
      if (v !== null) {
        metas[current!][bucket][\`\${colToCw[i][0]}-\${colToCw[i][1]}\`] = v;
      }
    }
  }

  _computeCatMetas(metas);
  _cachedMetas = metas;
  return metas;
}`;

const newLoadMetas = `let _cachedMetas: Record<string, Record<string, Record<string, number>>> | null = null;

import metasData from '@/lib/metas-mm-data.json';

function loadMetas(): Record<string, Record<string, Record<string, number>>> {
  if (_cachedMetas) return _cachedMetas;
  _cachedMetas = metasData;
  return _cachedMetas;
}`;

if (!content.includes(oldLoadMetas)) {
  console.error('Could not find the old loadMetas function!');
  console.log('Searching for loadMetas...');
  const idx = content.indexOf('function loadMetas()');
  if (idx >= 0) {
    console.log('Found at index:', idx);
    console.log('Context:', content.substring(idx, idx + 200));
  }
  process.exit(1);
}

content = content.replace(oldLoadMetas, newLoadMetas);

fs.writeFileSync(routePath, content);
console.log('Successfully updated loadMetas function!');