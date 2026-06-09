import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hub Comercial — Habi',
  description: 'Tablero comercial Habi: funnels MM, Inmo, combinado y conversión por seller.',
  icons: { icon: '/img/logo.png' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className="dark">
      <head>
        <script src="https://unpkg.com/htmx.org@2.0.4" />
        <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js" />
        <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.1.0/dist/chartjs-plugin-annotation.min.js" />
      </head>
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        {children}
      </body>
    </html>
  );
}
