import { readFileSync } from 'fs';
import { join } from 'path';

export default function HomePage() {
  const cardsHtml = `
  <div class="grid sm:grid-cols-2 gap-6">
    <a href="/funnel/mm" class="block p-6 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-brand-500/50 transition group">
      <div class="flex items-center gap-3 mb-2">
        <span class="text-2xl">📊</span>
        <h2 class="text-lg font-semibold group-hover:text-brand-400 transition">Funnel Comercial — MM</h2>
        <span class="ml-auto text-xs px-2 py-0.5 rounded-full bg-brand-500/20 text-brand-300">Activo</span>
      </div>
      <p class="text-sm text-slate-400 dark:text-slate-500">Volumen por etapa del funnel ibuyer (asignación → cierre). Filtros por equipo, categoría, fuente y área metropolitana.</p>
    </a>
    <a href="/funnel/inmo" class="block p-6 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-teal-500/50 transition group">
      <div class="flex items-center gap-3 mb-2">
        <span class="text-2xl">🏘️</span>
        <h2 class="text-lg font-semibold group-hover:text-teal-400 transition">Funnel Comercial — Inmobiliaria</h2>
        <span class="ml-auto text-xs px-2 py-0.5 rounded-full bg-teal-500/20 text-teal-300">Activo</span>
      </div>
      <p class="text-sm text-slate-400 dark:text-slate-500">Volumen por etapa del pipeline inmobiliaria (asignado → captado). Filtros por equipo, área y prioridad.</p>
    </a>
    <a href="/funnel/combinado" class="block p-6 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-indigo-500/50 transition group">
      <div class="flex items-center gap-3 mb-2">
        <span class="text-2xl">🔀</span>
        <h2 class="text-lg font-semibold group-hover:text-indigo-400 transition">Funnel Combinado — MM + Inmo</h2>
        <span class="ml-auto text-xs px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300">Activo</span>
      </div>
      <p class="text-sm text-slate-400 dark:text-slate-500">CVR cruzando ambos productos. Editás numerador y denominador (presets combinados o etapas individuales).</p>
    </a>
    <a href="/conversion/seller" class="block p-6 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-pink-500/50 transition group">
      <div class="flex items-center gap-3 mb-2">
        <span class="text-2xl">📈</span>
        <h2 class="text-lg font-semibold group-hover:text-pink-400 transition">Conversión por Seller</h2>
        <span class="ml-auto text-xs px-2 py-0.5 rounded-full bg-pink-500/20 text-pink-300">Activo</span>
      </div>
      <p class="text-sm text-slate-400 dark:text-slate-500">CVR Asignado → Cierre (MM) y Asignado → Captado (Inmo) por comercial individual, con benchmarks vs meta / equipo / global.</p>
    </a>
  </div>
  `;
  
  return (
    <div className="max-w-[1700px] mx-auto px-4 md:px-6 py-4 md:py-6">
      <div dangerouslySetInnerHTML={{ __html: `
        <div class="flex items-center gap-3 flex-wrap mb-2">
          <h1 class="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Hub Comercial Habi</h1>
        </div>
        <p class="text-slate-400 dark:text-slate-500 mb-8">Reportes comerciales con datos en vivo de BigQuery.</p>
        ${cardsHtml}
      ` }} />
    </div>
  );
}
