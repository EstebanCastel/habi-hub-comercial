import { readFileSync } from 'fs';
import { join } from 'path';

export default function FunnelInmoPage() {
  const html = readFileSync(join(process.cwd(), 'src/templates/funnel-inmo.html'), 'utf-8');
  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <script src="/js/funnel_inmo.js" />
      <script src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js" defer />
    </>
  );
}
