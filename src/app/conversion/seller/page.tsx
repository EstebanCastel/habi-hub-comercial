import { readFileSync } from 'fs';
import { join } from 'path';

export default function ConversionSellerPage() {
  const html = readFileSync(join(process.cwd(), 'src/templates/conversion-seller.html'), 'utf-8');
  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <script src="/js/conversion_seller.js" />
      <script src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js" defer />
    </>
  );
}
