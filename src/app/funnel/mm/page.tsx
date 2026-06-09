import { readFileSync } from 'fs';
import { join } from 'path';

export default function FunnelMMPage() {
  const html = readFileSync(join(process.cwd(), 'src/templates/funnel-mm.html'), 'utf-8');
  const nav = `<nav class="bg-gray-900/80 backdrop-blur border-b border-gray-800 px-6 py-3 flex items-center gap-3 sticky top-0 z-50">
    <a href="/" class="flex items-center gap-3 hover:opacity-80 transition">
      <img src="/img/logo.png" class="h-8 w-8 rounded" alt="Habi">
      <span class="font-semibold text-lg tracking-tight">Hub Comercial</span>
    </a>
    <span class="text-gray-600">/</span>
    <span class="text-gray-300">Funnel MM</span>
  </nav>`;
  const scripts = `<script src="https://unpkg.com/htmx.org@2.0.4"></script><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script><script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.1.0/dist/chartjs-plugin-annotation.min.js"></script><script src="/js/funnel_mm.js"></script><script src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js" defer></script>`;
  return <div dangerouslySetInnerHTML={{ __html: nav + '<main class="max-w-7xl mx-auto px-4 py-6">' + html + '</main>' + scripts }} />;
}
