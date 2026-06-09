import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'csv-parse/sync';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');

let _cycles: Record<string, unknown>[] | null = null;
let _comerciales: Record<string, string>[] | null = null;

export function loadCycles(): Record<string, unknown>[] {
  if (_cycles) return _cycles;
  const file = join(DATA_DIR, 'comercial_cycles.json');
  _cycles = JSON.parse(readFileSync(file, 'utf-8'));
  return _cycles!;
}

export function loadComerciales(): Record<string, string>[] {
  if (_comerciales) return _comerciales;
  const file = join(DATA_DIR, 'comerciales.csv');
  if (!existsSync(file)) { _comerciales = []; return _comerciales; }
  const raw = readFileSync(file, 'utf-8');
  const records = parse(raw, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  _comerciales = records
    .filter(r => (r['Comercial'] || '').trim())
    .map(r => ({
      email: (r['Comercial'] || '').trim().toLowerCase(),
      equipo: (r['Equipo'] || '').trim(),
      categoria: (r['Categoría'] || r['Categoria'] || '').trim(),
      lider: (r['Líder'] || r['Lider'] || '').trim(),
      especialidad: (r['Especialidad'] || '').trim(),
    }));
  return _comerciales;
}
