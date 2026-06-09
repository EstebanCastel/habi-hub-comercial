import { readFileSync } from 'fs';
import { join } from 'path';

export default function FunnelCombinadoPage() {
  const html = readFileSync(join(process.cwd(), 'src/templates/funnel-combinado.html'), 'utf-8');
  return (
    <>
      <nav className="bg-gray-900/80 backdrop-blur border-b border-gray-800 px-6 py-3 flex items-center gap-3 sticky top-0 z-50">
        <a href="/" className="flex items-center gap-3 hover:opacity-80 transition">
          <img src="/img/logo.png" className="h-8 w-8 rounded" alt="Habi" />
          <span className="font-semibold text-lg tracking-tight">Hub Comercial</span>
        </a>
        <span className="text-gray-600">/</span>
        <span className="text-gray-300">Funnel Combinado</span>
      </nav>
      <main className="max-w-7xl mx-auto px-4 py-6" dangerouslySetInnerHTML={{ __html: html }} />
      {/* Alpine.js page script — must load BEFORE Alpine */}
      <script src="/js/funnel_combinado.js" />
      <script src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js" defer />
    </>
  );
}
