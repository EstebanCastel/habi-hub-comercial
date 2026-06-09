const fs = require('fs');
const path = require('path');

const dataFiles = [
  'comerciales.csv',
  'metas_comerciales_co.csv',
  "NID's para excluir asignaciones Colombia - nids_MM.csv",
  "[CO] Corrección Incidente 7 abr Leads Inmo - bquxjob_41c0d194_19d68c1efbf.csv",
  "mm 2030 Sellers interno - MM Col Ciclos Todo el Funnel (Ciudades y equipos).csv",
  'comercial_cycles.json',
];

const sqlFiles = [
  'asignados_oficial_col.sql',
  'precios_descuentos_original.sql',
  'precios_maestro_mm.sql',
  'subsidios_gasto.sql',
];

const sourceDir = path.join(__dirname, '..', 'data');
const sqlSourceDir = path.join(__dirname, '..', 'data', 'sql');
const targetDir = path.join(__dirname, '..', '.next', 'standalone', 'data');
const sqlTargetDir = path.join(__dirname, '..', '.next', 'standalone', 'data', 'sql');

// Create target directories
[targetDir, sqlTargetDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Copy data files
dataFiles.forEach(file => {
  const src = path.join(sourceDir, file);
  const dest = path.join(targetDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied: ${file}`);
  } else {
    console.warn(`Source file not found: ${src}`);
  }
});

// Copy SQL files
sqlFiles.forEach(file => {
  const src = path.join(sqlSourceDir, file);
  const dest = path.join(sqlTargetDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied SQL: ${file}`);
  } else {
    console.warn(`SQL source file not found: ${src}`);
  }
});

// Copy public/data as fallback
const publicDataDir = path.join(__dirname, '..', 'public', 'data');
if (fs.existsSync(publicDataDir)) {
  const targetPublicDataDir = path.join(__dirname, '..', '.next', 'standalone', 'public', 'data');
  if (!fs.existsSync(targetPublicDataDir)) {
    fs.mkdirSync(targetPublicDataDir, { recursive: true });
  }
  fs.readdirSync(publicDataDir).forEach(file => {
    fs.copyFileSync(path.join(publicDataDir, file), path.join(targetPublicDataDir, file));
  });
  console.log('Copied public/data files');
}

console.log('Data files copied successfully!');
