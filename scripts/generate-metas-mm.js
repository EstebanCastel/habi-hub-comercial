const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const csvFile = path.join(__dirname, '..', 'data', 'mm 2030 Sellers interno - MM Col Ciclos Todo el Funnel (Ciudades y equipos).csv');
const outputFile = path.join(__dirname, '..', 'src', 'lib', 'metas-mm-data.json');

if (!fs.existsSync(csvFile)) {
  console.error('CSV file not found:', csvFile);
  process.exit(1);
}

const raw = fs.readFileSync(csvFile, 'utf-8');
const allRows = parse(raw, { relax_column_count: true });

if (allRows.length < 4) {
  console.error('CSV file has insufficient rows');
  process.exit(1);
}

const cicloRow = allRows[1];
const weekRow = allRows[2];
const colToCw = {};
const maxCol = Math.max(cicloRow.length, weekRow.length);

for (let i = 1; i < maxCol; i++) {
  const c = (cicloRow[i] || '').trim();
  const w = (weekRow[i] || '').trim();
  if (c && w && !isNaN(parseInt(c)) && !isNaN(parseInt(w))) {
    colToCw[i] = [parseInt(c), parseInt(w)];
  }
}

const ETAPAS_LBL = new Set(['Asignados', 'Agendas', 'Visitas', 'Comites', 'Aprobados', 'Cierres']);
const ZONAS = new Set(['Norte', 'Sur', 'Medellin', 'Cali', 'Barranquilla', 'Centro']);
const CATS = new Set(['A', 'B', 'C']);

const metas = {};
let current = null;

function parseVal(s) {
  const cleaned = (s || '').replace(/,/g, '').replace(/"/g, '').trim();
  if (!cleaned || cleaned.startsWith('#')) return null;
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : Math.round(num);
}

for (const row of allRows.slice(3)) {
  if (!row || !row[0]?.trim()) continue;
  const label = row[0].trim();
  let bucket = null;

  if (ETAPAS_LBL.has(label)) {
    current = label;
    metas[current] = { 'Total': {} };
    bucket = 'Total';
  } else if (current && ZONAS.has(label) && !metas[current][label]) {
    metas[current][label] = {};
    bucket = label;
  } else if (current === 'Cierres' && CATS.has(label) && !metas[current][label]) {
    metas[current][label] = {};
    bucket = label;
  }

  if (bucket === null) continue;

  for (const [i, cw] of Object.entries(colToCw)) {
    const idx = parseInt(i);
    if (idx >= row.length) continue;
    const v = parseVal(row[idx]);
    if (v !== null) {
      metas[current][bucket][`${cw[0]}-${cw[1]}`] = v;
    }
  }
}

// Compute category metas
const ZONA_TO_EQUIPO = {
  Norte: 'Bogotá Norte',
  Sur: 'Bogotá Sur',
  Medellin: 'Medellín',
  Cali: 'Cali',
  Barranquilla: 'Barranquilla',
};

const ZONA_TO_REGION = {
  Norte: 'Bogotá',
  Sur: 'Bogotá',
  Medellin: 'Ciudades',
  Cali: 'Ciudades',
  Barranquilla: 'Ciudades',
};

const CAT_SHARE = { A: 0.25, B: 0.43, C: 0.32 };

const CVR_BY_REGION = {
  Bogotá: {
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

const ETAPAS_ORDER = ['Asignados', 'Agendas', 'Visitas', 'Comites', 'Aprobados', 'Cierres'];

function computeCatMetas(metas) {
  const asig = metas['Asignados'] || {};
  if (!asig) return;

  const zonas = Object.keys(ZONA_TO_REGION);
  const allKeys = new Set();
  for (const z of zonas) {
    if (asig[z]) Object.keys(asig[z]).forEach(k => allKeys.add(k));
  }

  for (let etapaIdx = 0; etapaIdx < ETAPAS_ORDER.length; etapaIdx++) {
    const etapa = ETAPAS_ORDER[etapaIdx];
    if (!metas[etapa]) continue;

    for (const cat of ['A', 'B', 'C']) {
      metas[etapa][cat] = {};
    }

    const totalDict = metas[etapa]['Total'] || {};

    for (const wk of allKeys) {
      const raw = { A: 0, B: 0, C: 0 };
      for (const zona of zonas) {
        const asigZ = asig[zona]?.[wk];
        if (asigZ === undefined) continue;
        const region = ZONA_TO_REGION[zona];
        const cvrsByCat = CVR_BY_REGION[region];
        for (const cat of ['A', 'B', 'C']) {
          const asigZc = asigZ * (CAT_SHARE[cat] || 0);
          let factor = 1.0;
          if (etapaIdx > 0) {
            const cvrs = cvrsByCat[cat];
            for (let k = 0; k < etapaIdx; k++) {
              factor *= cvrs[k];
            }
          }
          raw[cat] += asigZc * factor;
        }
      }

      const sumRaw = raw.A + raw.B + raw.C;
      const totalCsv = totalDict[wk];

      if (totalCsv !== undefined && sumRaw > 0) {
        const scale = totalCsv / sumRaw;
        const scaled = { A: raw.A * scale, B: raw.B * scale, C: raw.C * scale };
        const rounded = { A: Math.round(scaled.A), B: Math.round(scaled.B), C: Math.round(scaled.C) };
        const drift = totalCsv - (rounded.A + rounded.B + rounded.C);
        const fracs = ['A', 'B', 'C'].sort((a, b) => (scaled[b] - Math.floor(scaled[b])) - (scaled[a] - Math.floor(scaled[a])));
        for (let i = 0; i < Math.abs(drift); i++) {
          const idx = i % 3;
          if (drift > 0) rounded[fracs[idx]] += 1;
          else rounded[fracs[idx]] -= 1;
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

computeCatMetas(metas);

// Write to JSON file
const outputDir = path.join(__dirname, '..', 'src', 'lib');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

fs.writeFileSync(path.join(__dirname, '..', 'src', 'lib', 'metas-mm-data.json'), JSON.stringify(metas, null, 2));
console.log('Generated metas-mm-data.json');
