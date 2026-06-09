// Cuentas que NO son comerciales reales — se excluyen de los tableros.
// Fuente única de verdad para bots/queue y buffers.

export const MM_BOT_EMAILS = ['juanquinones@habi.co', 'iagabi@habi.co'];
export const INMO_BOT_EMAILS = ['cristianmartin@habi.co', 'jhoanbenavides@habi.co'];

// Buffers: leads parqueados que no se asignan al equipo
export const BUFFER_EMAILS = [
  'susanaescobar@habi.co',
  'danieljaramillo@habi.co',
  'juancampos@habi.co',
];

export const MM_EXCLUIR_EMAILS = [...MM_BOT_EMAILS, ...BUFFER_EMAILS];
export const INMO_EXCLUIR_EMAILS = [...INMO_BOT_EMAILS, ...BUFFER_EMAILS];

export function sqlNotIn(field: string, emails: string[]): string {
  if (!emails.length) return 'TRUE';
  const lst = emails.map(e => `'${e.toLowerCase().replace(/'/g, "''")}'`).join(', ');
  return `LOWER(${field}) NOT IN (${lst})`;
}
