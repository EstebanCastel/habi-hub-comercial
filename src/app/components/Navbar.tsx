'use client';

export default function Navbar() {
  // HTML with Alpine directives - $ signs escaped for template literal
  const navbarHtml = `
    <div x-data="countryNav()" x-init="init()">
      <header class="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30 backdrop-blur supports-[backdrop-filter]:bg-white/80 supports-[backdrop-filter]:dark:bg-slate-900/80">
        <div class="max-w-[1700px] mx-auto px-4 md:px-6 py-3 flex items-center gap-3 md:gap-4">
          <a href="/" class="flex items-center gap-2 group shrink-0">
            <img src="/img/logo.png" alt="Habi" class="w-9 h-9 object-contain shrink-0" />
            <span class="font-semibold tracking-tight text-slate-900 dark:text-slate-100 group-hover:text-brand-600 dark:group-hover:text-brand-400 transition hidden sm:inline">Hub Comercial</span>
          </a>

          <!-- Country switcher -->
          <div class="flex items-center gap-1 mr-3">
            <button @click="switchCountry('CO')" :class="country==='CO' ? 'bg-brand-600 text-white' : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'" class="px-2.5 py-1 text-xs font-semibold rounded-md transition">CO</button>
            <button @click="switchCountry('MX')" :class="country==='MX' ? 'bg-brand-600 text-white' : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'" class="px-2.5 py-1 text-xs font-semibold rounded-md transition">MX</button>
          </div>

          <!-- Desktop nav -->
          <nav class="hidden md:flex items-center gap-1 ml-4 text-sm">
            <template x-for="s in sections.filter(s => href(s) !== null)" :key="s.key">
              <a :href="href(s)" :class="isActive(s) ? 'text-brand-600 dark:text-brand-400 font-semibold' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'"
                class="px-3 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-sm transition" x-text="s.label"></a>
            </template>
          </nav>

          <!-- Mobile nav toggle -->
          <div x-data="{open:false}" class="md:hidden ml-auto">
            <button @click="open=!open" class="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition" aria-label="Menú">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <div x-show="open" x-transition @click.outside="open=false" class="absolute right-3 top-14 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl py-2 min-w-[180px]" style="display:none">
              <template x-for="s in sections.filter(s => href(s) !== null)" :key="s.key">
                <a :href="href(s)" :class="isActive(s) ? 'text-brand-600 dark:text-brand-400 font-semibold bg-slate-50 dark:bg-slate-800' : 'hover:bg-slate-50 dark:hover:bg-slate-800'"
                  class="block px-4 py-2 text-sm transition" x-text="s.label"></a>
              </template>
            </div>
          </div>

          <div class="hidden md:flex items-center gap-3 ml-auto">
            <span id="page-loader" class="hidden text-xs text-slate-500 dark:text-slate-400 items-center gap-1">
              <span class="inline-block w-3 h-3 rounded-full border-2 border-brand-500 border-t-transparent animate-spin"></span>
              Cargando…
            </span>
            <span class="text-xs text-slate-400 dark:text-slate-500">Live · BQ</span>
          </div>
        </div>
      </header>
    </div>

    <script>
      function countryNav() {
        return {
          country: "CO",
          sections: [
            { key: "mm",        label: "Funnel MM",         CO: "/funnel/mm",         MX: "/funnel/mm-mx" },
            { key: "inmo",      label: "Funnel Inmo",       CO: "/funnel/inmo",       MX: "/funnel/inmo-mx" },
            { key: "combinado", label: "Combinado",         CO: "/funnel/combinado",  MX: "/funnel/combinado-mx" },
            { key: "conv",      label: "Conversión Seller", CO: "/conversion/seller", MX: null },
            { key: "rechazos",  label: "Rechazos",          CO: "/rechazos",          MX: null },
          ],
          init() {
            const p = location.pathname;
            this.country = (p.endsWith("-mx") || p.includes("/mx")) ? "MX" : "CO";
          },
          href(s) { return s[this.country]; },
          isActive(s) { return s[this.country] === location.pathname; },
          switchCountry(c) {
            if (c === this.country) return;
            const cur = this.sections.find(s => s[this.country] === location.pathname);
            location.href = (cur && cur[c]) || (c === "CO" ? "/funnel/mm" : "/funnel/mm-mx");
          },
        };
      }
    </script>
  `;

  return <div dangerouslySetInnerHTML={{ __html: navbarHtml }} />;
}
