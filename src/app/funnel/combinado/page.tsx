import { readFileSync } from 'fs';
import { join } from 'path';

export default function FunnelCombinadoPage() {
  const html = readFileSync(join(process.cwd(), 'src/templates/funnel-combinado.html'), 'utf-8');
  const scripts = `<script src="/js/funnel_combinado.js"></script><script src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js" defer></script>`;
  return (
    <>
      <main className="max-w-[1700px] mx-auto px-4 md:px-6 py-4 md:py-6" dangerouslySetInnerHTML={{ __html: html }} />
      {scripts}
    </>
  );
}
