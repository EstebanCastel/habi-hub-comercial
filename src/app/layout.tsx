import type { Metadata } from "next";
import Navbar from "./components/Navbar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hub Comercial \u2014 Habi",
  description: "Tablero comercial Habi: funnels MM, Inmo, combinado y conversi\u00f3n por seller.",
  icons: {
    icon: "/img/logo.png",
    shortcut: "/img/logo.png",
    apple: "/img/logo.png",
  },
  manifest: "/site.webmanifest",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className="h-full" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#7c3aed" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#0f172a" media="(prefers-color-scheme: dark)" />
        {/* Inter font */}
        <link rel="preconnect" href="https://rsms.me/" />
        <link rel="stylesheet" href="https://rsms.me/inter/inter.css" />
        {/* HTMX 2.x */}
        <script src="https://unpkg.com/htmx.org@2.0.4" />
        {/* Alpine.js 3.x (reactividad chica) */}
        <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js" />
        {/* Chart.js */}
        <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js" />
        <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.0.1/dist/chartjs-plugin-annotation.min.js" />
        {/* Tailwind config (same as original) */}
        <script dangerouslySetInnerHTML={{ __html: `
          tailwind.config = {
            darkMode: 'media',
            theme: {
              extend: {
                fontFamily: { sans: ['Inter','system-ui','sans-serif'] },
                colors: {
                  brand: { 50:'#f5f3ff',100:'#ede9fe',200:'#ddd6fe',300:'#c4b5fd',400:'#a78bfa',500:'#8b5cf6',600:'#7c3aed',700:'#6d28d9',800:'#5b21b6',900:'#4c1d95' }
                }
              }
            }
          }
        `}} />
      </head>
      <body className="h-full font-sans text-slate-800 dark:text-slate-100 antialiased transition-colors">
        <Navbar />
        <main className="max-w-[1700px] mx-auto px-4 md:px-6 py-4 md:py-6">
          {children}
        </main>

        {/* HTMX global loader hooks */}
        <script dangerouslySetInnerHTML={{ __html: `
          document.body.addEventListener("htmx:beforeRequest", () => {
            document.getElementById("page-loader")?.classList.remove("hidden");
            document.getElementById("page-loader")?.classList.add("flex");
          });
          document.body.addEventListener("htmx:afterRequest", () => {
            document.getElementById("page-loader")?.classList.add("hidden");
            document.getElementById("page-loader")?.classList.remove("flex");
          });
        `}} />
      </body>
    </html>
  );
}
