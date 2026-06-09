'use client';

export default function Navbar() {
  // HTML with Alpine directives - $ signs escaped for template literal
  const navbarHtml = `
    <header class="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30 backdrop-blur supports-[backdrop-filter]:bg-white/80 supports-[backdrop-filter]:dark:bg-slate-900/80">
      <div class="max-w-[1700px] mx-auto px-4 md:px-6 py-3 flex items-center gap-3 md:gap-4">
        <a href="/" class="flex items-center gap-2 group shrink-0">
          <img src="/img/logo.png" alt="Habi" class="w-9 h-9 object-contain shrink-0" />
          <span class="font-semibold tracking-tight text-slate-900 dark:text-slate-100 group-hover:text-brand-600 dark:group-hover:text-brand-400 transition hidden sm:inline">Hub Comercial</span>
        </a>

        <!-- Desktop nav - global tabs -->
        <nav class="hidden md:flex items-center gap-1 ml-4 text-sm">
          <a href="/funnel/mm" class="px-3 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition">Funnel MM</a>
          <a href="/funnel/inmo" class="px-3 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition">Funnel Inmo</a>
          <a href="/funnel/combinado" class="px-3 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition">Combinado</a>
          <a href="/conversion/seller" class="px-3 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition">Conversi\\u00f3n Seller</a>
        </nav>

        <!-- Mobile nav toggle -->
        <div x-data="{open:false}" class="md:hidden ml-auto">
          <button @click="open=!open" class="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition" aria-label="Men\\u00fa">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div x-show="open" x-transition @click.outside="open=false" class="absolute right-3 top-14 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl py-2 min-w-[180px]" style="display:none">
            <a href="/funnel/mm" class="block px-4 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">Funnel MM</a>
            <a href="/funnel/inmo" class="block px-4 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">Funnel Inmo</a>
            <a href="/funnel/combinado" class="block px-4 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">Combinado</a>
            <a href="/conversion/seller" class="block px-4 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">Conversi\\u00f3n Seller</a>
          </div>
        </div>

        <div class="hidden md:flex items-center gap-3 ml-auto">
          <span id="page-loader" class="hidden text-xs text-slate-500 dark:text-slate-400 items-center gap-1">
            <span class="inline-block w-3 h-3 rounded-full border-2 border-brand-500 border-t-transparent animate-spin"></span>
            Cargando\u2026
          </span>
          <span class="text-xs text-slate-400 dark:text-slate-500">Live \u00b7 BQ</span>
        </div>
      </div>
    </header>
  `;

  return <div dangerouslySetInnerHTML={{ __html: navbarHtml }} />;
}
