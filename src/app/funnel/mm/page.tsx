import { readFileSync } from 'fs';
import { join } from 'path';

export default function FunnelMMPage() {
  const html = readFileSync(join(process.cwd(), 'src/templates/funnel-mm.html'), 'utf-8');
  // Scripts that need to be at the end of body for Alpine to work properly
  const scriptsHtml = `<script src="/js/funnel_mm.js"></script><script src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js" defer></script>`;
  return <div dangerouslySetInnerHTML={{ __html: html + scriptsHtml }} />;
}
