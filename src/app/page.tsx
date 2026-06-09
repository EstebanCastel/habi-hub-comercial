export default function HomePage() {
  return (
    <div dangerouslySetInnerHTML={{ __html: `
<nav class="bg-gray-900/80 backdrop-blur border-b border-gray-800 px-6 py-3 flex items-center gap-3 sticky top-0 z-50">
  <img src="/img/logo.png" class="h-8 w-8 rounded" alt="Habi">
  <span class="font-semibold text-lg tracking-tight">Hub Comercial</span>
</nav>
<main class="max-w-5xl mx-auto px-4 py-10">
  <h1 class="text-3xl font-bold mb-2">Hub Comercial Habi</h1>
  <p class="text-gray-400 mb-8">Reportes comerciales con datos en vivo de BigQuery.</p>
  <div class="grid sm:grid-cols-2 gap-6">
    <a href="/funnel/mm" class="block p-6 rounded-2xl bg-gray-900 border border-gray-800 hover:border-purple-500/50 transition group">
      <div class="flex items-center gap-3 mb-2">
        <span class="text-2xl">📊</span>
        <h2 class="text-lg font-semibold group-hover:text-purple-400 transition">Funnel Comercial — MM</h2>
        <span class="ml-auto text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300">Activo</span>
      </div>
      <p class="text-sm text-gray-400">Volumen por etapa del funnel ibuyer (asignación → cierre). Filtros por equipo, categoría, fuente y área metropolitana.</p>
    </a>
    <a href="/funnel/inmo" class="block p-6 rounded-2xl bg-gray-900 border border-gray-800 hover:border-teal-500/50 transition group">
      <div class="flex items-center gap-3 mb-2">
        <span class="text-2xl">🏘️</span>
        <h2 class="text-lg font-semibold group-hover:text-teal-400 transition">Funnel Comercial — Inmobiliaria</h2>
        <span class="ml-auto text-xs px-2 py-0.5 rounded-full bg-teal-500/20 text-teal-300">Activo</span>
      </div>
      <p class="text-sm text-gray-400">Volumen por etapa del pipeline inmobiliaria (asignado → captado). Filtros por equipo, área y prioridad.</p>
    </a>
    <a href="/funnel/combinado" class="block p-6 rounded-2xl bg-gray-900 border border-gray-800 hover:border-indigo-500/50 transition group">
      <div class="flex items-center gap-3 mb-2">
        <span class="text-2xl">🔀</span>
        <h2 class="text-lg font-semibold group-hover:text-indigo-400 transition">Funnel Combinado — MM + Inmo</h2>
        <span class="ml-auto text-xs px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300">Activo</span>
      </div>
      <p class="text-sm text-gray-400">CVR cruzando ambos productos. Editás numerador y denominador (presets combinados o etapas individuales).</p>
    </a>
    <a href="/conversion/seller" class="block p-6 rounded-2xl bg-gray-900 border border-gray-800 hover:border-pink-500/50 transition group">
      <div class="flex items-center gap-3 mb-2">
        <span class="text-2xl">📈</span>
        <h2 class="text-lg font-semibold group-hover:text-pink-400 transition">Conversión por Seller</h2>
        <span class="ml-auto text-xs px-2 py-0.5 rounded-full bg-pink-500/20 text-pink-300">Activo</span>
      </div>
      <p class="text-sm text-gray-400">CVR Asignado → Cierre (MM) y Asignado → Captado (Inmo) por comercial individual, con benchmarks vs meta / equipo / global.</p>
    </a>
  </div>
</main>
    ` }} />
  )
}
