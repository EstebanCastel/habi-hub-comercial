import { readFileSync } from 'fs';
import { join } from 'path';

export default function FunnelCombinadoPage() {
  const html = readFileSync(join(process.cwd(), 'src/templates/funnel-combinado.html'), 'utf-8');
  const scriptsHtml = `<script src="/js/funnel_combinado.js"></script><script src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js" defer></script>`;
  return <div dangerouslySetInnerHTML={{ __html: html + scriptsHtml }} />;
}
