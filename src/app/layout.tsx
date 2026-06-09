import type { Metadata } from "next";
import Script from "next/script";

export const metadata: Metadata = {
  title: "Hub Comercial — Habi",
  description: "Tablero comercial Habi: funnels MM, Inmo, combinado y conversión por seller.",
  icons: { icon: "/img/logo.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <head>
        {/* Tailwind CDN — same as original */}
        <Script src="https://cdn.tailwindcss.com" strategy="beforeInteractive" />
        {/* HTMX 2 */}
        <Script src="https://unpkg.com/htmx.org@2.0.4" strategy="beforeInteractive" />
        {/* Chart.js + annotation plugin */}
        <Script src="https://cdn.jsdelivr.net/npm/chart.js" strategy="beforeInteractive" />
        <Script
          src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation"
          strategy="beforeInteractive"
        />
      </head>
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        <style>{`[x-cloak]{display:none!important} :focus-visible{outline:2px solid #6366f1;outline-offset:2px}`}</style>
        {children}
      </body>
    </html>
  );
}
