// ── Funnel MM — Alpine + Chart.js + HTMX bridge ─────────────────────────────

// Stores compartidos (Alpine)
document.addEventListener("alpine:init", () => {
  Alpine.store("filters", {
    equipo: [], cat_com: [], cat: [], recurrencia: [], fuente: [], area: [], motivo: [], campaign: [],
    // Locales a Share de categorización (override del global SÓLO para esa card)
    shareCatFuente: [],
    shareCatEquipo: [],
    shareCatArea: [],
    shareCatPrioridadMM: [],
    shareCatPrioridadInmo: [],
    // Locales a Tasa de conversión en el tiempo (override del global SÓLO para esa card)
    convTimeFuente: [],
    convTimeEquipo: [],
    convTimeArea: [],
    convTimeRecurrencia: [],
    convTimePrioridadMM: [],
    convTimeCampaign: [],
    // Filtros de la comparación de cohortes (A / B)
    cmpA_equipo: [], cmpA_cat: [], cmpA_fuente: [], cmpA_motivo: [],
    cmpB_equipo: [], cmpB_cat: [], cmpB_fuente: [], cmpB_motivo: [],
  });
});

// ── Dark mode helpers ───────────────────────────────────────────────────────
function isDarkMode() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
function chartTheme() {
  const dark = isDarkMode();
  return {
    text:     dark ? "#cbd5e1" : "#475569",
    textDim:  dark ? "#64748b" : "#94a3b8",
    grid:     dark ? "#1e293b" : "#f1f5f9",
    tooltipBg: dark ? "rgba(15,23,42,0.95)" : "rgba(255,255,255,0.95)",
    tooltipFg: dark ? "#f1f5f9" : "#1e293b",
    border:   dark ? "#334155" : "#e2e8f0",
  };
}

// Aplica defaults de Chart.js para el tema actual
function applyChartTheme() {
  const t = chartTheme();
  if (!window.Chart) return;
  Chart.defaults.color = t.text;
  Chart.defaults.borderColor = t.grid;
  Chart.defaults.plugins.tooltip.backgroundColor = t.tooltipBg;
  Chart.defaults.plugins.tooltip.titleColor = t.tooltipFg;
  Chart.defaults.plugins.tooltip.bodyColor = t.tooltipFg;
  Chart.defaults.plugins.tooltip.borderColor = t.border;
  Chart.defaults.plugins.tooltip.borderWidth = 1;
}

// Re-render charts cuando el OS cambia tema
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  applyChartTheme();
  // Notificar al componente Alpine activo para que re-renderice charts
  const root = document.querySelector("[x-data^='funnelMM']");
  if (root && root._x_dataStack) {
    const data = root._x_dataStack[0];
    if (data && data.refreshVolumen) data.refreshVolumen();
  }
});

// Componente multi-select reutilizable
function multiSelect(key, getOptionsFn, onChange) {
  return {
    key,
    values: [],
    open: false,
    filter: "",
    options() { return getOptionsFn() || []; },
    // Opciones tras el buscador interno (solo se usa donde se renderiza el input `filter`)
    filteredOptions() {
      const f = (this.filter || "").toLowerCase().trim();
      const opts = this.options();
      return f ? opts.filter(o => (o || "").toLowerCase().includes(f)) : opts;
    },
    allSelected() { return this.values.length === this.options().length && this.options().length > 0; },
    toggle(v) {
      const i = this.values.indexOf(v);
      if (i >= 0) this.values.splice(i, 1); else this.values.push(v);
      this.sync();
    },
    toggleAll(e) {
      this.values = e.target.checked ? [...this.options()] : [];
      this.sync();
    },
    sync() {
      // Alpine reactivity → store
      Alpine.store("filters")[this.key] = this.values.slice();
      onChange && onChange();
    },
    btnLabel() {
      const n = this.values.length;
      const total = this.options().length;
      if (n === 0 || n === total) return "Todos";
      if (n === 1) return this.values[0];
      return `${n} seleccionados`;
    },
  };
}

// Construye query string a partir del store de filtros
function filterParams() {
  const f = Alpine.store("filters") || {};
  const el = document.querySelector("[x-data='funnelMM()']");
  // Alpine v3 stores el componente en _x_dataStack[0]
  const root = (el && el._x_dataStack && el._x_dataStack[0]) || {};
  const out = {
    fecha_desde: root.fechaDesde,
    fecha_hasta: root.fechaHasta,
    granularidad: root.granularidad,
  };
  ["equipo","cat_com","cat","recurrencia","fuente","area","motivo","campaign"].forEach(k => {
    if (f[k] && f[k].length) out[k] = f[k];
  });
  // Slider día del mes/ciclo — solo se manda cuando estrecha el default [1, tope]
  const diaTop = (typeof root.diaTop === "function") ? root.diaTop() : 31;
  if (root.diaMin > 1)      out.dia_min = root.diaMin;
  if (root.diaMax < diaTop) out.dia_max = root.diaMax;
  return out;
}

function buildQS(params) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(x => usp.append(k, x));
    else if (v != null) usp.append(k, v);
  });
  return usp.toString();
}

// Componente principal
function funnelMM() {
  return {
    fechaDesde: document.body.dataset.fechaDesde || "2026-01-01",
    fechaHasta: document.body.dataset.fechaHasta || new Date().toISOString().slice(0,10),
    granularidad: "mes",
    // Slider "día del mes" (1–31) — aplica el mismo rango de días a todos los meses
    diaMin: 1,
    diaMax: 31,
    filtersOptions: { equipos:[], cats_com:[], cats:[], recurrencias:[], fuentes:[], areas:[], motivos:[], campaigns:[] },
    etapasList: [],
    loading: { volumen: false, kpis: false, shareCat: false, shareMotivo: false, convTime: false, negocios: false, metas: false, cosechas: false, precios: false },
    negociosEtapa: "fecha_asignacion",
    negociosSearch: "",
    negociosPage: 1,
    negociosPageSize: 50,
    negociosTotal: 0,
    negociosHasMore: false,
    chartVolumen: null,
    chartShareDonut: null,
    chartShareBars: null,
    chartConvTime: null,
    // Share categorización: filtros locales
    shareCatExcluirSin: false,
    lastShareCatData: null,
    // Share razón de venta
    shareMotivoExcluirSin: false,
    lastShareMotivoData: null,
    chartMotivoDonut: null,
    chartMotivoBars: null,
    debounceT: null,
    refreshing: false,
    // Tab state
    tab: "volumen",
    metasInited: false,
    // Metas
    metaCycles: [],
    metaEtapas: [],
    metaCiclo: 0,
    metaDesglose: "total",
    metaVista: "semanal",
    metaAsumeArea: false,
    metaConfig: null,
    metaReal: null,
    metaKpi: {},
    metaCicloLabel: "",
    sparkCharts: {},
    // Comparación de funnels (cohorte A / B)
    mesA: "",
    mesB: "",
    // Cosechas
    cosechasInited: false,
    etapasFull: [],         // [{key, label}, ...]
    cosechaOrigen: "Primer_asigancion",
    cosechaDestino: "Cita agendada",
    cosechaGran: "semana",
    cosechaBucket: "iso",     // iso | dias
    cosechaConteo: "cohorte", // cohorte (1er evento por nid) | funnel (matchea volumen)
    cosechaAcum: false,
    cosechaModo: "pct",      // pct | abs
    cosechaData: null,
    cosechaTitle: "",
    cosechaSummary: "",
    // Precios + Subsidios
    preciosInited: false,
    psFechaTipo: "aprobacion",   // aprobacion | cierre
    psGran: "mes",               // mes | semana
    psArea: "",
    psEquipo: "",
    psAreas: [],
    psEquipos: [],
    psKpis: {},
    psCharts: {},

    init() {
      const sec = document.querySelector("[x-data='funnelMM()']");
      this.fechaDesde = sec.dataset.fechaDesde || this.fechaDesde;
      this.fechaHasta = sec.dataset.fechaHasta || this.fechaHasta;
      // Soporta ?tab=metas|cosechas para deep-linking
      const url = new URLSearchParams(window.location.search);
      const t = url.get("tab");
      if (t === "metas") this.tab = "metas";
      if (t === "cosechas") this.tab = "cosechas";
      if (t === "precios") this.tab = "precios";
      applyChartTheme();

      // Inicializar defaults de conv-time num/den en el store
      Alpine.store("filters").convNum = ["Cierre - Comprado"];
      Alpine.store("filters").convDen = ["Primer_asigancion"];

      // Cargar opciones (filtros + etapas) y luego primera carga de todos los charts
      Promise.all([this.loadFilterOptions(), this.loadEtapas()]).then(() => {
        // Sembrar valores iniciales en los multi-selects conv*
        this.$nextTick(() => {
          document.querySelectorAll("[x-data^=\"multiSelect('convNum'\"], [x-data^=\"multiSelect('convDen'\"]").forEach(el => {
            if (el._x_dataStack) {
              const d = el._x_dataStack[0];
              d.values = Alpine.store("filters")[d.key] || [];
            }
          });
        });
        this.refreshVolumen();
        this.refreshShareCat();
        this.refreshShareMotivo();
        this.refreshConvTime();
        this.refreshNegocios();
        if (this.tab === "metas" && !this.metasInited) this.initMetas();
        if (this.tab === "cosechas" && !this.cosechasInited) {
          this.cosechasInited = true;
          this.refreshCosechas();
          this.initCompare();
        }
        if (this.tab === "precios" && !this.preciosInited) this.initPrecios();
      });
    },

    async loadFilterOptions() {
      const r = await fetch(`/funnel/mm/filters?fecha_desde=${this.fechaDesde}&fecha_hasta=${this.fechaHasta}`);
      this.filtersOptions = await r.json();
    },

    async loadEtapas() {
      const r = await fetch("/funnel/mm/etapas");
      const arr = await r.json();
      this.etapasList = arr.map(e => e.key);
      this.etapasFull = arr;
    },

    async forceRefresh() {
      // Limpia cache servidor y vuelve a pedir todo el tab actual
      this.refreshing = true;
      try {
        await fetch("/admin/cache/clear", { method: "POST" });
        // Re-cargar opciones de filtro también (por si cambió data)
        await this.loadFilterOptions();
        this.refreshVolumen();
        this.refreshShareCat();
        this.refreshShareMotivo();
        this.refreshConvTime();
        this.refreshNegocios();
        htmx.trigger(document.getElementById("kpis-section"), "refresh-kpis");
        if (this.tab === "metas" && this.metasInited) this.refreshMetas();
        if (this.tab === "cosechas" && this.cosechasInited) this.refreshCosechas();
      } finally {
        // Espera un poquito para que el spinner sea visible aunque cache fresco
        setTimeout(() => { this.refreshing = false; }, 800);
      }
    },

    refresh() {
      clearTimeout(this.debounceT);
      this.debounceT = setTimeout(() => {
        this.refreshVolumen();
        this.refreshShareCat();
        this.refreshShareMotivo();
        this.refreshConvTime();
        this.negociosPage = 1;
        this.refreshNegocios();
        htmx.trigger(document.getElementById("kpis-section"), "refresh-kpis");
        if (this.tab === "metas" && this.metasInited) this.refreshMetas();
        if (this.tab === "cosechas" && this.cosechasInited) this.refreshCosechas();
        if (this.tab === "precios" && this.preciosInited) this.refreshPrecios();
      }, 200);
    },

    switchTab(t) {
      this.tab = t;
      if (t === "metas" && !this.metasInited) {
        this.initMetas();
      }
      if (t === "cosechas" && !this.cosechasInited) {
        this.cosechasInited = true;
        this.refreshCosechas();
        this.initCompare();
      }
      if (t === "precios" && !this.preciosInited) {
        this.initPrecios();
      }
      if (t === "rechazos") {
        // El tab embebe el componente rechazos() (lazy). Avísale que se mostró
        // para que cargue/renderice el chart al tamaño correcto.
        this.$nextTick(() => window.dispatchEvent(new CustomEvent("rechazos:show")));
      }
    },

    // ── Comparación de funnels (cohorte A vs B) ─────────────────────────────
    initCompare() {
      const meses = this.filtersOptions.meses || [];
      if (!this.mesA && meses.length) { this.mesA = meses[0]; this.refreshCompare("A"); }
      if (!this.mesB && meses.length > 1) { this.mesB = meses[1]; this.refreshCompare("B"); }
    },

    async refreshCompare(c) {
      const s = Alpine.store("filters");
      const p = new URLSearchParams();
      const mes = c === "A" ? this.mesA : this.mesB;
      if (mes) p.set("mes", mes);
      for (const v of (s["cmp"+c+"_equipo"] || [])) p.append("equipo", v);
      for (const v of (s["cmp"+c+"_cat"]    || [])) p.append("cat", v);
      for (const v of (s["cmp"+c+"_fuente"] || [])) p.append("fuente", v);
      for (const v of (s["cmp"+c+"_motivo"] || [])) p.append("motivo", v);
      const r = await fetch(`/funnel/mm/funnel-compare?${p}`);
      this.renderCompare(c, await r.json());
    },

    renderCompare(c, data) {
      const accent = c === "A" ? "#2563eb" : "#059669";   // azul / esmeralda
      const excl = "#ef4444";                              // rojo (exclusión)
      const fmt = n => n.toLocaleString("es-CO");
      const hdr = document.getElementById("funnelHdr"+c);
      if (hdr) hdr.innerHTML = `<span class="text-base font-bold" style="color:${accent}">${fmt(data.total)}</span> nids · Primer Asignación · ${data.mes}`;
      const box = document.getElementById("funnel"+c);
      if (!box) return;
      box.innerHTML = data.stages.map(s => {
        const color = s.exclusion ? excl : accent;
        const width = Math.max(2, s.pct_first);
        const prev = s.pct_prev == null ? "" : `<span class="text-slate-400 dark:text-slate-500 ml-1">${s.pct_prev.toFixed(1)}% vs ant.</span>`;
        return `
          <div>
            <div class="flex items-baseline justify-between text-xs mb-0.5">
              <span class="${s.exclusion ? 'italic text-slate-500 dark:text-slate-400' : 'font-medium text-slate-700 dark:text-slate-200'}">${s.exclusion ? '⊘ ' : ''}${s.label}</span>
              <span class="tabular-nums">
                <span class="font-semibold text-slate-900 dark:text-slate-100">${fmt(s.nids)}</span>
                <span class="font-semibold ml-1" style="color:${color}">${s.pct_first.toFixed(1)}%</span>${prev}
              </span>
            </div>
            <div class="h-2.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
              <div class="h-full rounded-full" style="width:${width}%;background:${color}"></div>
            </div>
          </div>`;
      }).join("");
    },

    async initMetas() {
      this.metasInited = true;
      const r = await fetch("/funnel/mm/metas/config");
      this.metaConfig = await r.json();
      this.metaCycles = this.metaConfig.cycles || [];
      this.metaEtapas = this.metaConfig.etapas || [];
      // Default: ciclo del mes actual (o el último con metas)
      const today = new Date().toISOString().slice(0,10);
      const currentCiclo = this.metaCycles.find(c => c.inicio <= today && today <= c.fin);
      this.metaCiclo = (currentCiclo || this.metaCycles[this.metaCycles.length-1] || {}).ciclo || 0;
      this.refreshMetas();
    },

    async refreshMetas() {
      if (!this.metaCiclo) return;
      this.loading.metas = true;
      const ciclo = this.metaCycles.find(c => c.ciclo === this.metaCiclo);
      this.metaCicloLabel = ciclo ? `${ciclo.inicio} → ${ciclo.fin}` : "";
      try {
        const params = filterParams();
        params.ciclo = this.metaCiclo;
        params.desglose = this.metaDesglose;
        if (this.metaAsumeArea) params.asume_area = "true";
        const [realRes, kpiRes] = await Promise.all([
          fetch(`/funnel/mm/metas/real?${buildQS(params)}`).then(r => r.json()),
          fetch(`/funnel/mm/metas/kpi-tendencias?${buildQS(params)}`).then(r => r.json()),
        ]);
        this.metaReal = realRes;
        this.metaKpi = kpiRes.series || {};
        this.$nextTick(() => {
          this.renderSparklines();
          this.renderMetaTable();
        });
      } finally {
        this.loading.metas = false;
      }
    },

    renderSparklines() {
      const t = chartTheme();
      this.metaEtapas.forEach((etapa, i) => {
        const el = document.getElementById(`spark-${i}`);
        if (!el) return;
        const s = this.metaKpi[etapa];
        if (!s) return;
        Chart.getChart(el)?.destroy();
        this.sparkCharts[i] = null;
        const ctx = el.getContext("2d");
        if (!ctx) return;
        try { this.sparkCharts[i] = new Chart(ctx, {
          type: "bar",
          data: {
            labels: s.labels,
            datasets: [
              { label: "Meta", data: s.metas, backgroundColor: isDarkMode() ? "#334155" : "#e2e8f0", borderRadius: 1, barPercentage: 0.9, categoryPercentage: 0.9 },
              { label: "Real", data: s.reales, backgroundColor: "#7c3aed", borderRadius: 1, barPercentage: 0.5, categoryPercentage: 0.9 },
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: {
              callbacks: {
                title: items => `Sem ${items[0].label}`,
                label: c => ` ${c.dataset.label}: ${c.parsed.y == null ? "—" : c.parsed.y.toLocaleString("es-CO")}`,
              }
            } },
            scales: {
              x: { display: false, stacked: false },
              y: { display: false, beginAtZero: true },
            },
            animation: { duration: 200 },
          }
        }); } catch (e) { console.error(`spark ${i} failed`, e); }
      });
    },

    renderMetaTable() {
      const tbody = document.querySelector("#metas-table tbody");
      const empty = document.getElementById("metas-empty");
      if (!this.metaReal || !this.metaConfig) {
        tbody.innerHTML = ""; return;
      }
      const semanas = this.metaReal.semanas || [];
      const desglose = this.metaDesglose;
      const today = new Date().toISOString().slice(0,10);

      // Buckets a mostrar
      let buckets = ["Total"];
      if (desglose === "equipo") buckets = ["Total","Norte","Sur","Medellin","Cali","Barranquilla","Sin equipo"];
      else if (desglose === "categoria") buckets = ["Total","A","B","C"];

      const metas = this.metaConfig.metas || {};
      const real = this.metaReal.data || {};
      const ciclo = this.metaCiclo;

      // Cuando el backend agrupa por equipo/categoría no devuelve un bucket "Total".
      // Lo sintetizamos en frontend sumando todos los buckets reales para que la
      // fila Total no muestre 0. Incluye 'Sin equipo' para no perder leads.
      if (desglose !== "total") {
        Object.keys(real).forEach(etapa => {
          const byBucket = real[etapa] || {};
          const totalByWeek = {};
          Object.keys(byBucket).forEach(b => {
            if (b === "Total") return;
            const wks = byBucket[b] || {};
            Object.keys(wks).forEach(w => {
              totalByWeek[w] = (totalByWeek[w] || 0) + (wks[w] || 0);
            });
          });
          real[etapa]["Total"] = totalByWeek;
        });
      }

      const fmt = n => n == null ? "—" : n.toLocaleString("es-CO");
      const pct = (r, m) => (m == null || m === 0) ? null : (r / m * 100);
      const cellClass = p => {
        if (p == null) return "text-slate-400 dark:text-slate-500";
        if (p >= 100) return "text-emerald-700 dark:text-emerald-300 font-semibold";
        if (p >= 80)  return "text-amber-700 dark:text-amber-400";
        return "text-rose-700 dark:text-rose-400";
      };
      const bgClass = p => {
        if (p == null) return "";
        if (p >= 100) return "bg-emerald-50/60 dark:bg-emerald-900/20";
        if (p >= 80)  return "bg-amber-50/60 dark:bg-amber-900/20";
        return "bg-rose-50/60 dark:bg-rose-900/20";
      };

      // Header
      let html = `<thead class="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-[10px] uppercase tracking-wider">
        <tr>
          <th class="px-3 py-2.5 text-left whitespace-nowrap sticky left-0 bg-slate-50 dark:bg-slate-800">Etapa</th>
          <th class="px-3 py-2.5 text-left whitespace-nowrap">Desglose</th>`;
      semanas.forEach(s => {
        html += `<th class="px-3 py-2.5 text-center whitespace-nowrap" title="${s.inicio} → ${s.fin}">Sem ${s.num}</th>`;
      });
      html += `<th class="px-3 py-2.5 text-center whitespace-nowrap bg-slate-100 dark:bg-slate-700/60">Total ciclo</th>
        </tr></thead><tbody class="divide-y divide-slate-100 dark:divide-slate-800">`;

      const ETAPAS = this.metaEtapas;
      let totalRows = 0;
      ETAPAS.forEach(etapa => {
        buckets.forEach((bucket, bi) => {
          // Si el bucket no aplica a esta etapa (ej. categoría solo en algunas), igual mostramos pero "—"
          let metaAcum = 0, realAcum = 0;
          let totalMetaWeek = [];
          let totalRealWeek = [];

          // Pre-compute todas las semanas
          semanas.forEach((s, idx) => {
            const wkKey = `${ciclo}-${s.num}`;
            const m = (metas[etapa] && metas[etapa][bucket]) ? (metas[etapa][bucket][wkKey] ?? null) : null;
            const r = (real[etapa] && real[etapa][bucket]) ? (real[etapa][bucket][String(s.num)] ?? null) : null;
            totalMetaWeek.push(m);
            totalRealWeek.push(r);
            if (m != null) metaAcum += m;
            if (r != null && s.inicio <= today) realAcum += r;
          });

          if (bi === 0 && totalRows > 0) {
            html += `<tr class="border-t-4 border-slate-200 dark:border-slate-700"><td colspan="${semanas.length + 3}" class="h-0 p-0"></td></tr>`;
          }
          html += `<tr class="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">`;
          if (bi === 0) {
            html += `<td rowspan="${buckets.length}" class="px-3 py-2 font-semibold text-slate-700 dark:text-slate-200 align-top sticky left-0 bg-white dark:bg-slate-900">${etapa}</td>`;
          }
          html += `<td class="px-3 py-2 text-slate-600 dark:text-slate-400 whitespace-nowrap">${bucket}</td>`;

          let metaAccum = 0, realAccum = 0;
          semanas.forEach((s, idx) => {
            const m = totalMetaWeek[idx];
            const r = totalRealWeek[idx];
            const futura = s.inicio > today;
            if (m != null) metaAccum += m;
            if (r != null && !futura) realAccum += r;

            let mDisp, rDisp;
            if (this.metaVista === "acumulado") {
              mDisp = metaAccum;
              rDisp = (s.inicio > today && r == null) ? null : realAccum;
            } else {
              mDisp = m;
              rDisp = futura ? null : r;
            }
            const p = pct(rDisp, mDisp);
            html += `<td class="px-2 py-2 text-center whitespace-nowrap ${bgClass(p)}">
              <div class="${cellClass(p)} tabular-nums">${fmt(rDisp)}</div>
              <div class="text-[10px] text-slate-400 dark:text-slate-500 tabular-nums">/ ${fmt(mDisp)}</div>
              ${p != null ? `<div class="text-[10px] ${cellClass(p)} tabular-nums">${p.toFixed(0)}%</div>` : ""}
            </td>`;
          });
          // Total ciclo column
          const pT = pct(realAcum, metaAcum);
          html += `<td class="px-2 py-2 text-center whitespace-nowrap bg-slate-50 dark:bg-slate-800/60">
            <div class="${cellClass(pT)} tabular-nums font-semibold">${fmt(realAcum)}</div>
            <div class="text-[10px] text-slate-400 dark:text-slate-500 tabular-nums">/ ${fmt(metaAcum)}</div>
            ${pT != null ? `<div class="text-[10px] ${cellClass(pT)} tabular-nums">${pT.toFixed(0)}%</div>` : ""}
          </td>`;
          html += `</tr>`;
          totalRows++;
        });
      });
      html += "</tbody>";

      const table = document.getElementById("metas-table");
      table.innerHTML = html;
      empty.classList.toggle("hidden", totalRows > 0);
    },

    async refreshNegocios() {
      this.loading.negocios = true;
      try {
        const params = filterParams();
        params.etapa = this.negociosEtapa;
        if (this.negociosSearch) params.search = this.negociosSearch;
        params.page = this.negociosPage;
        params.page_size = this.negociosPageSize;
        const r = await fetch(`/funnel/mm/negocios?${buildQS(params)}`);
        this.renderNegocios(await r.json());
      } finally {
        this.loading.negocios = false;
      }
    },

    renderNegocios(data) {
      this.negociosTotal = data.total;
      const start = (data.page - 1) * data.page_size + 1;
      const end = Math.min(start + data.rows.length - 1, data.total);
      this.negociosHasMore = end < data.total;
      document.getElementById("negocios-count").textContent = `${data.total.toLocaleString("es-CO")} negocios`;
      document.getElementById("negocios-pageinfo").textContent = data.total > 0 ? `${start.toLocaleString("es-CO")}–${end.toLocaleString("es-CO")} de ${data.total.toLocaleString("es-CO")}` : "Sin resultados";

      const tbody = document.getElementById("negocios-tbody");
      if (!data.rows.length) {
        tbody.innerHTML = `<tr><td colspan="14" class="px-3 py-6 text-center text-slate-400 dark:text-slate-500">Sin resultados</td></tr>`;
        return;
      }
      const dash = '<span class="text-slate-300 dark:text-slate-600">—</span>';
      const esc = s => (s == null ? "" : String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"));
      tbody.innerHTML = data.rows.map(r => `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/50">
          <td class="px-3 py-2 font-mono text-[11px] md:text-xs">${r.nid}</td>
          <td class="px-3 py-2 whitespace-nowrap">${r.equipo || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap">${r.categoria_comercial || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap">${r.categoria || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap">${r.fuente || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap">${r.area_metropolitana || dash}</td>
          <td class="px-3 py-2 max-w-[200px] truncate" title="${esc(r.motivo_venta)}">${r.motivo_venta ? esc(r.motivo_venta) : dash}</td>
          <td class="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-400">${r.fecha_asignacion || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-400">${r.fecha_cita || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-400">${r.fecha_visita || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-400">${r.fecha_precomite || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-400">${r.fecha_aprobado || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-400">${r.fecha_acepto || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-400">${r.fecha_cierre || dash}</td>
        </tr>
      `).join("");
    },

    async exportNegocios() {
      // Trae todas las páginas (con un límite razonable) para exportar
      const params = filterParams();
      params.etapa = this.negociosEtapa;
      if (this.negociosSearch) params.search = this.negociosSearch;
      params.page = 1;
      params.page_size = 200;
      const all = [];
      let p = 1, fetched = 0;
      while (true) {
        params.page = p;
        const r = await fetch(`/funnel/mm/negocios?${buildQS(params)}`);
        const data = await r.json();
        all.push(...data.rows);
        fetched += data.rows.length;
        if (fetched >= data.total || data.rows.length === 0) break;
        p++;
        if (p > 50) break;  // safety
      }
      const headers = ["nid","equipo","categoria_comercial","categoria","fuente","area_metropolitana","motivo_venta","motivo_cat","fecha_asignacion","fecha_cita","fecha_visita","fecha_precomite","fecha_aprobado","fecha_acepto","fecha_cierre"];
      const csv = [headers.join(",")].concat(
        all.map(r => headers.map(h => `"${(r[h] || "").toString().replace(/"/g,'""')}"`).join(","))
      ).join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `negocios_mm_${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },

    async refreshVolumen() {
      this.loading.volumen = true;
      try {
        const r = await fetch(`/funnel/mm/volumen?${buildQS(filterParams())}`);
        this.renderVolumen(await r.json());
      } finally {
        this.loading.volumen = false;
      }
    },

    async refreshShareCat() {
      this.loading.shareCat = true;
      try {
        const params = filterParams();
        const s = Alpine.store("filters");
        // Locales sobrescriben el global SÓLO para esta gráfica
        if ((s.shareCatFuente || []).length) params.fuente = s.shareCatFuente;
        if ((s.shareCatEquipo || []).length) params.equipo = s.shareCatEquipo;
        if ((s.shareCatArea   || []).length) params.area   = s.shareCatArea;
        // Filtros nuevos (no tienen contraparte global)
        if ((s.shareCatPrioridadMM   || []).length) params.prioridad_mm   = s.shareCatPrioridadMM;
        if ((s.shareCatPrioridadInmo || []).length) params.prioridad_inmo = s.shareCatPrioridadInmo;
        const r = await fetch(`/funnel/mm/share-cat?${buildQS(params)}`);
        const data = await r.json();
        this.lastShareCatData = data;
        this.renderShareCat(data);
      } finally {
        this.loading.shareCat = false;
      }
    },

    async refreshShareMotivo() {
      this.loading.shareMotivo = true;
      try {
        const r = await fetch(`/funnel/mm/share-motivo?${buildQS(filterParams())}`);
        const data = await r.json();
        this.lastShareMotivoData = data;
        this.renderShareMotivo(data);
      } finally {
        this.loading.shareMotivo = false;
      }
    },

    async refreshConvTime() {
      this.loading.convTime = true;
      try {
        const params = filterParams();
        // Añadir num y den del store
        const s = Alpine.store("filters");
        if (s.convNum && s.convNum.length) params.num = s.convNum;
        if (s.convDen && s.convDen.length) params.den = s.convDen;
        // Filtros locales de esta card (sobrescriben los globales)
        if ((s.convTimeFuente      || []).length) params.fuente       = s.convTimeFuente;
        if ((s.convTimeEquipo      || []).length) params.equipo       = s.convTimeEquipo;
        if ((s.convTimeArea        || []).length) params.area         = s.convTimeArea;
        if ((s.convTimeRecurrencia || []).length) params.recurrencia  = s.convTimeRecurrencia;
        if ((s.convTimePrioridadMM || []).length) params.prioridad_mm = s.convTimePrioridadMM;
        if ((s.convTimeCampaign    || []).length) params.campaign     = s.convTimeCampaign;
        const r = await fetch(`/funnel/mm/conv-time?${buildQS(params)}`);
        this.renderConvTime(await r.json());
      } finally {
        this.loading.convTime = false;
      }
    },

    // ── Render: Volumen ────────────────────────────────────────────────────
    renderVolumen(data) {
      const el = document.getElementById("chart-volumen");
      if (!el) return;
      // Matar cualquier chart "zombie" sobre este canvas (mismo o stale)
      Chart.getChart(el)?.destroy();
      this.chartVolumen = null;
      const ctx = el.getContext("2d");
      if (!ctx) return;
      const t = chartTheme();
      try { this.chartVolumen = new Chart(ctx, {
        type: "bar",
        data: {
          labels: data.labels,
          datasets: data.datasets.map(d => ({
            label: d.label, data: d.data,
            backgroundColor: d.color, borderRadius: 4, borderSkipped: false,
          })),
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position: "top", align: "start", labels: { usePointStyle: true, pointStyle: "rect", padding: 14, font: { size: 11 }, color: t.text } },
            tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.parsed.y.toLocaleString("es-CO")}` } }
          },
          scales: {
            x: { grid: { display: false }, ticks: { font: { size: 11 }, color: t.text } },
            y: { beginAtZero: true, grid: { color: t.grid }, ticks: { font: { size: 11 }, color: t.text,
                callback: v => v >= 1000 ? (v/1000).toFixed(0)+"k" : v } }
          },
          animation: { duration: 300 },
        }
      }); } catch (e) { console.error("renderVolumen failed", e); }
    },

    // ── Render: Share categorización (donut + stacked bars + leyenda) ──────
    renderShareCat(data) {
      if (!data) return;
      // Si el toggle local está activo, removemos "Sin categoría" y recalculamos total/share
      if (this.shareCatExcluirSin) {
        const keep = data.donut.labels.map(l => l !== "Sin categoría");
        const labels = data.donut.labels.filter((_, i) => keep[i]);
        const values = data.donut.values.filter((_, i) => keep[i]);
        const colors = data.donut.colors.filter((_, i) => keep[i]);
        const total = values.reduce((s, v) => s + v, 0);
        const datasets = data.bars.datasets.filter(ds => ds.label !== "Sin categoría");
        data = {
          donut: { labels, values, colors, total },
          bars: { labels: data.bars.labels, datasets },
        };
      }
      const t = chartTheme();
      // Donut
      const elD = document.getElementById("chart-share-donut");
      if (!elD) return;
      Chart.getChart(elD)?.destroy();
      this.chartShareDonut = null;
      const ctxD = elD.getContext("2d");
      if (!ctxD) return;
      try { this.chartShareDonut = new Chart(ctxD, {
        type: "doughnut",
        data: { labels: data.donut.labels, datasets: [{ data: data.donut.values, backgroundColor: data.donut.colors, borderWidth: 2, borderColor: isDarkMode() ? "#0f172a" : "#fff" }] },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: "62%",
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: c => {
              const pct = data.donut.total > 0 ? (c.parsed/data.donut.total*100).toFixed(1) : "0.0";
              return ` ${c.label}: ${c.parsed.toLocaleString("es-CO")} (${pct}%)`;
            } } }
          },
        }
      }); } catch (e) { console.error("renderShareCat donut failed", e); }
      // Leyenda
      const legend = document.getElementById("share-legend");
      if (data.donut.total === 0) {
        legend.innerHTML = '<div class="text-xs text-slate-400 dark:text-slate-500">Sin datos</div>';
      } else {
        legend.innerHTML = `
          <div class="text-[10px] uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400">Total asignados</div>
          <div class="text-2xl font-bold text-slate-900 dark:text-slate-100 tabular-nums">${data.donut.total.toLocaleString("es-CO")}</div>
        ` + data.donut.labels.map((l, i) => {
          const v = data.donut.values[i];
          const pct = (v / data.donut.total * 100).toFixed(1);
          return `
            <div class="flex items-center gap-2 pt-1.5 border-t border-slate-100 dark:border-slate-800 text-xs">
              <span class="w-2.5 h-2.5 rounded-sm" style="background:${data.donut.colors[i]}"></span>
              <span class="flex-1 text-slate-700 dark:text-slate-300">${l}</span>
              <span class="text-slate-500 dark:text-slate-400 tabular-nums">${v.toLocaleString("es-CO")}</span>
              <span class="font-semibold tabular-nums" style="color:${data.donut.colors[i]}">${pct}%</span>
            </div>`;
        }).join("");
      }
      // Stacked bars
      const elB = document.getElementById("chart-share-bars");
      if (!elB) return;
      Chart.getChart(elB)?.destroy();
      this.chartShareBars = null;
      const ctxB = elB.getContext("2d");
      if (!ctxB) return;
      try { this.chartShareBars = new Chart(ctxB, {
        type: "bar",
        data: {
          labels: data.bars.labels,
          datasets: data.bars.datasets.map(d => ({
            label: d.label, data: d.data, backgroundColor: d.color,
            stack: "cat", borderWidth: 0, borderRadius: 3,
          })),
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position: "top", align: "start", labels: { usePointStyle: true, pointStyle: "rect", padding: 12, font: { size: 11 }, color: t.text } },
            tooltip: {
              mode: "index", intersect: false,
              callbacks: {
                label: c => {
                  const total = c.chart.data.datasets.reduce((s,d) => s + (d.data[c.dataIndex]||0), 0);
                  const pct = total > 0 ? (c.parsed.y/total*100).toFixed(1) : "0.0";
                  return ` ${c.dataset.label}: ${c.parsed.y.toLocaleString("es-CO")} (${pct}%)`;
                },
                footer: items => " Total: " + items[0].chart.data.datasets.reduce((s,d) => s + (d.data[items[0].dataIndex]||0), 0).toLocaleString("es-CO"),
              }
            }
          },
          scales: {
            x: { stacked: true, grid: { display: false }, ticks: { color: t.text, font: { size: 11 } } },
            y: { stacked: true, beginAtZero: true, grid: { color: t.grid }, ticks: { color: t.text, font: { size: 11 },
                 callback: v => v >= 1000 ? (v/1000).toFixed(0)+"k" : v } }
          },
          animation: { duration: 300 },
        }
      }); } catch (e) { console.error("renderShareCat bars failed", e); }
    },

    // ── Render: Share razón de venta (donut + stacked bars + leyenda) ──────
    renderShareMotivo(data) {
      if (!data) return;
      // Toggle local: remover "Sin dato" y recalcular total/share
      if (this.shareMotivoExcluirSin) {
        const keep = data.donut.labels.map(l => l !== "Sin dato");
        const labels = data.donut.labels.filter((_, i) => keep[i]);
        const values = data.donut.values.filter((_, i) => keep[i]);
        const colors = data.donut.colors.filter((_, i) => keep[i]);
        const total = values.reduce((s, v) => s + v, 0);
        const datasets = data.bars.datasets.filter(ds => ds.label !== "Sin dato");
        data = {
          donut: { labels, values, colors, total },
          bars: { labels: data.bars.labels, datasets },
        };
      }
      const t = chartTheme();
      // Donut
      const elD = document.getElementById("chart-motivo-donut");
      if (!elD) return;
      Chart.getChart(elD)?.destroy();
      this.chartMotivoDonut = null;
      const ctxD = elD.getContext("2d");
      if (!ctxD) return;
      try { this.chartMotivoDonut = new Chart(ctxD, {
        type: "doughnut",
        data: { labels: data.donut.labels, datasets: [{ data: data.donut.values, backgroundColor: data.donut.colors, borderWidth: 2, borderColor: isDarkMode() ? "#0f172a" : "#fff" }] },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: "62%",
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: c => {
              const pct = data.donut.total > 0 ? (c.parsed/data.donut.total*100).toFixed(1) : "0.0";
              return ` ${c.label}: ${c.parsed.toLocaleString("es-CO")} (${pct}%)`;
            } } }
          },
        }
      }); } catch (e) { console.error("renderShareMotivo donut failed", e); }
      // Leyenda
      const legend = document.getElementById("motivo-legend");
      if (data.donut.total === 0) {
        legend.innerHTML = '<div class="text-xs text-slate-400 dark:text-slate-500">Sin datos</div>';
      } else {
        legend.innerHTML = `
          <div class="text-[10px] uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400">Total asignados</div>
          <div class="text-2xl font-bold text-slate-900 dark:text-slate-100 tabular-nums">${data.donut.total.toLocaleString("es-CO")}</div>
        ` + data.donut.labels.map((l, i) => {
          const v = data.donut.values[i];
          const pct = (v / data.donut.total * 100).toFixed(1);
          return `
            <div class="flex items-center gap-2 pt-1.5 border-t border-slate-100 dark:border-slate-800 text-xs">
              <span class="w-2.5 h-2.5 rounded-sm shrink-0" style="background:${data.donut.colors[i]}"></span>
              <span class="flex-1 text-slate-700 dark:text-slate-300">${l}</span>
              <span class="text-slate-500 dark:text-slate-400 tabular-nums">${v.toLocaleString("es-CO")}</span>
              <span class="font-semibold tabular-nums" style="color:${data.donut.colors[i]}">${pct}%</span>
            </div>`;
        }).join("");
      }
      // Stacked bars
      const elB = document.getElementById("chart-motivo-bars");
      if (!elB) return;
      Chart.getChart(elB)?.destroy();
      this.chartMotivoBars = null;
      const ctxB = elB.getContext("2d");
      if (!ctxB) return;
      try { this.chartMotivoBars = new Chart(ctxB, {
        type: "bar",
        data: {
          labels: data.bars.labels,
          datasets: data.bars.datasets.map(d => ({
            label: d.label, data: d.data, backgroundColor: d.color,
            stack: "motivo", borderWidth: 0, borderRadius: 3,
          })),
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position: "top", align: "start", labels: { usePointStyle: true, pointStyle: "rect", padding: 12, font: { size: 11 }, color: t.text } },
            tooltip: {
              mode: "index", intersect: false,
              callbacks: {
                label: c => {
                  const total = c.chart.data.datasets.reduce((s,d) => s + (d.data[c.dataIndex]||0), 0);
                  const pct = total > 0 ? (c.parsed.y/total*100).toFixed(1) : "0.0";
                  return ` ${c.dataset.label}: ${c.parsed.y.toLocaleString("es-CO")} (${pct}%)`;
                },
                footer: items => " Total: " + items[0].chart.data.datasets.reduce((s,d) => s + (d.data[items[0].dataIndex]||0), 0).toLocaleString("es-CO"),
              }
            }
          },
          scales: {
            x: { stacked: true, grid: { display: false }, ticks: { color: t.text, font: { size: 11 } } },
            y: { stacked: true, beginAtZero: true, grid: { color: t.grid }, ticks: { color: t.text, font: { size: 11 },
                 callback: v => v >= 1000 ? (v/1000).toFixed(0)+"k" : v } }
          },
          animation: { duration: 300 },
        }
      }); } catch (e) { console.error("renderShareMotivo bars failed", e); }
    },

    // ── Render: Conversion in time (line + bars dual-axis) ────────────────
    renderConvTime(data) {
      const t = chartTheme();
      // Update totals chip
      const fmt = n => n.toLocaleString("es-CO");
      const totalsEl = document.getElementById("conv-totals");
      const totalCvr = data.total_cvr == null ? "—" : data.total_cvr.toFixed(2) + "%";
      totalsEl.innerHTML = `Total: <strong class="text-slate-700 dark:text-slate-200">${fmt(data.total_num)}</strong> / <strong class="text-slate-700 dark:text-slate-200">${fmt(data.total_den)}</strong> = <strong class="text-brand-600 dark:text-brand-400">${totalCvr}</strong>`;

      const elCT = document.getElementById("chart-conv-time");
      if (!elCT) return;

      // Patrón update-or-create: si ya existe un chart en este canvas,
      // actualizamos su data en vez de recrear (evita race conditions de
      // ResizeObserver de Chart.js que producen "null.save").
      const existing = Chart.getChart(elCT);
      if (existing) {
        try {
          existing.data.labels = data.labels;
          existing.data.datasets[0].data = data.cvr;
          existing.data.datasets[1].data = data.num;
          existing.data.datasets[2].data = data.den;
          existing.update("none");
          this.chartConvTime = existing;
          return;
        } catch (e) {
          console.error("renderConvTime update failed, recreating", e);
          existing.destroy();
        }
      }

      const ctx = elCT.getContext("2d");
      if (!ctx) return;
      try { this.chartConvTime = new Chart(ctx, {
        type: "line",
        data: {
          labels: data.labels,
          datasets: [
            {
              label: "CVR %", type: "line", yAxisID: "y1", data: data.cvr,
              borderColor: "#7c3aed", backgroundColor: "rgba(124,58,237,0.12)",
              fill: true, tension: 0.25, pointRadius: 3, pointHoverRadius: 5, borderWidth: 2, order: 0,
            },
            {
              label: "Numerador", type: "bar", yAxisID: "y2", data: data.num,
              backgroundColor: "rgba(16,185,129,0.55)", borderWidth: 0, borderRadius: 3, order: 2,
            },
            {
              label: "Denominador", type: "bar", yAxisID: "y2", data: data.den,
              backgroundColor: "rgba(148,163,184,0.30)", borderWidth: 0, borderRadius: 3, order: 3,
            }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { position: "top", align: "start", labels: { usePointStyle: true, pointStyle: "rect", padding: 14, font: { size: 11 }, color: t.text } },
            tooltip: { callbacks: { label: c => {
              if (c.dataset.label === "CVR %") return ` CVR: ${c.parsed.y == null ? "—" : c.parsed.y.toFixed(2)+"%"}`;
              return ` ${c.dataset.label}: ${c.parsed.y.toLocaleString("es-CO")}`;
            } } }
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: t.text, font: { size: 11 } } },
            y1: { position: "left", beginAtZero: true, grid: { color: t.grid }, title: { display: true, text: "CVR %", color: t.text, font: { size: 11 } },
                  ticks: { color: t.text, font: { size: 11 }, callback: v => v.toFixed(0)+"%" } },
            y2: { position: "right", beginAtZero: true, grid: { display: false }, title: { display: true, text: "Volumen", color: t.text, font: { size: 11 } },
                  ticks: { color: t.text, font: { size: 11 }, callback: v => v >= 1000 ? (v/1000).toFixed(0)+"k" : v } }
          },
          animation: { duration: 0 },
        }
      }); } catch (e) { console.error("renderConvTime failed", e); }
    },

    // ── Cosechas ──────────────────────────────────────────────────────────
    async refreshCosechas() {
      this.loading.cosechas = true;
      try {
        const params = filterParams();
        // No mandar granularidad global — cosechas usa la suya propia
        delete params.granularidad;
        params.origen = this.cosechaOrigen;
        params.destino = this.cosechaDestino;
        params.granularidad = this.cosechaGran;
        params.bucket = this.cosechaBucket;
        params.conteo = this.cosechaConteo;
        const r = await fetch(`/funnel/mm/cosechas?${buildQS(params)}`);
        this.cosechaData = await r.json();
        this.renderCosechasTable();
      } finally {
        this.loading.cosechas = false;
      }
    },

    renderCosechasTable() {
      const d = this.cosechaData;
      const table = document.getElementById("cosechas-table");
      const empty = document.getElementById("cosechas-empty");
      if (!d || !d.rows || d.rows.length === 0) {
        if (table) table.innerHTML = "";
        if (empty) empty.classList.remove("hidden");
        this.cosechaTitle = "";
        this.cosechaSummary = "";
        return;
      }
      if (empty) empty.classList.add("hidden");

      // Encontrar el label de origen/destino para el título
      const fmtEtapa = k => (this.etapasFull.find(e => e.key === k) || {label:k}).label;
      this.cosechaTitle = `${fmtEtapa(d.origen)} → ${fmtEtapa(d.destino)}`;

      // Total de leads y % global que alcanzaron
      const totalLeads = d.rows.reduce((s, r) => s + r.total, 0);
      const totalAlc   = d.rows.reduce((s, r) => s + r.alcanzaron, 0);
      const globalPct  = totalLeads > 0 ? (totalAlc / totalLeads * 100) : 0;
      this.cosechaSummary = `${d.rows.length} cohortes · ${totalLeads.toLocaleString("es-CO")} leads · ${globalPct.toFixed(1)}% alcanzaron destino`;

      // En modo dias usamos offset_ranges (más explícitos: 0-6d, 7-13d, ...)
      const offsets = (d.bucket === "dias" && d.offset_ranges) ? d.offset_ranges : (d.offset_labels || []);
      const acum = this.cosechaAcum;
      const modo = this.cosechaModo;  // pct | share | abs

      // Para colorear: en modo share usamos escala 0-50 (share típicamente más alto),
      // en modo pct/abs usamos escala 0-50 también (la mayoría < 50%).
      // En share, valores >50 son la norma para offsets tempranos → cap intensidad.
      const scaleMax = modo === "share" ? 60 : 50;
      const cellBg = (intensityVal, isFuture) => {
        if (isFuture) return "";
        if (intensityVal == null || intensityVal === 0) return "";
        const intensity = Math.min(1, intensityVal / scaleMax);
        return `background:rgba(124,58,237,${(intensity*0.85).toFixed(3)});`;
      };
      const cellText = (intensityVal, isFuture) => {
        if (isFuture) return "text-slate-300 dark:text-slate-700";
        if (intensityVal == null || intensityVal === 0) return "text-slate-400 dark:text-slate-600";
        const threshold = scaleMax * 0.5;
        if (intensityVal >= threshold) return "text-white font-semibold";
        if (intensityVal >= scaleMax * 0.2) return "text-slate-900 dark:text-slate-100 font-medium";
        return "text-slate-700 dark:text-slate-300";
      };

      // Un bucket está completamente en el futuro si su PRIMER día > hoy.
      // (El día más temprano posible es: inicio del cohorte + off * step).
      // De lo contrario aún puede tener datos parciales y se muestra normalmente.
      const today = new Date().toISOString().slice(0,10);
      const isFutureOffset = (cohorte, off) => {
        let bucketStart;
        if (this.cosechaGran === "semana") {
          // cohorte = lunes de la semana ISO origen
          const dt = new Date(cohorte + "T00:00:00");
          dt.setDate(dt.getDate() + off * 7);
          bucketStart = dt.toISOString().slice(0,10);
        } else {
          // cohorte = "YYYY-MM"
          const [y, m] = cohorte.split("-").map(Number);
          if (d.bucket === "dias") {
            const dt = new Date(y, m - 1, 1);
            dt.setDate(dt.getDate() + off * 30);
            bucketStart = dt.toISOString().slice(0,10);
          } else {
            const dt = new Date(y, m - 1 + off, 1);
            bucketStart = dt.toISOString().slice(0,10);
          }
        }
        return bucketStart > today;
      };

      // Construir HTML
      let html = `<thead class="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-[10px] uppercase tracking-wider">
        <tr>
          <th class="px-3 py-2.5 text-left whitespace-nowrap sticky left-0 bg-slate-50 dark:bg-slate-800 z-10">Cohorte</th>
          <th class="px-2 py-2.5 text-right whitespace-nowrap">Total</th>
          <th class="px-2 py-2.5 text-right whitespace-nowrap">Llegaron</th>`;
      offsets.forEach(lbl => {
        html += `<th class="px-2 py-2.5 text-center whitespace-nowrap">${lbl}</th>`;
      });
      html += `</tr></thead><tbody class="divide-y divide-slate-100 dark:divide-slate-800">`;

      d.rows.forEach(r => {
        const pcts    = acum ? r.cum_pct    : r.pct;
        const shares  = acum ? r.cum_share  : r.share;
        const counts  = acum ? r.cum_counts : r.counts;
        const globalRowPct = r.total > 0 ? (r.alcanzaron / r.total * 100) : 0;
        html += `<tr class="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">
          <td class="px-3 py-2 font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap sticky left-0 bg-white dark:bg-slate-900">${r.cohorte}</td>
          <td class="px-2 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">${r.total.toLocaleString("es-CO")}</td>
          <td class="px-2 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
            <span class="font-semibold">${r.alcanzaron.toLocaleString("es-CO")}</span>
            <span class="text-[10px] text-slate-400 dark:text-slate-500 ml-1">${globalRowPct.toFixed(1)}%</span>
          </td>`;
        offsets.forEach((lbl, i) => {
          const pct   = pcts[i];
          const share = shares ? shares[i] : null;
          const cnt   = counts[i];
          const futuro = isFutureOffset(r.cohorte, i);
          // Elegir el valor a mostrar y el valor que pinta el color
          let txt, paintVal;
          if (futuro) {
            txt = "—"; paintVal = null;
          } else if (modo === "abs") {
            txt = cnt == null ? "—" : cnt.toLocaleString("es-CO");
            paintVal = pct;  // color por intensidad del % cohorte
          } else if (modo === "share") {
            txt = share == null ? "—" : share.toFixed(1) + "%";
            paintVal = share;
          } else {  // pct
            txt = pct == null ? "—" : pct.toFixed(1) + "%";
            paintVal = pct;
          }
          html += `<td class="px-2 py-2 text-center text-xs tabular-nums ${cellText(paintVal, futuro)}" style="${cellBg(paintVal, futuro)}">${txt}</td>`;
        });
        html += `</tr>`;
      });
      html += `</tbody>`;
      table.innerHTML = html;
    },

    // Tope del slider: 28 en vistas comerciales (día del ciclo), 31 en calendario
    isDiaCiclo() {
      return this.granularidad === "mes_com" || this.granularidad === "sem_com";
    },
    diaTop() {
      return this.isDiaCiclo() ? 28 : 31;
    },
    // Cambia granularidad y ajusta el slider al nuevo tope (día del mes ↔ día del ciclo)
    setGranularidad(g) {
      const oldTop = this.diaTop();
      this.granularidad = g;
      const newTop = this.diaTop();
      // Si el max estaba en el tope (= "Todos"), muévelo al nuevo tope
      if (this.diaMax >= oldTop) this.diaMax = newTop;
      else if (this.diaMax > newTop) this.diaMax = newTop;
      if (this.diaMin > newTop) this.diaMin = newTop;
      this.refresh();
    },

    // Posición del track resaltado del slider día del mes/ciclo (1–tope → 0–100%)
    diaFillStyle() {
      const span = this.diaTop() - 1;
      const l = (this.diaMin - 1) / span * 100;
      const r = (this.diaMax - 1) / span * 100;
      return `left:${l}%;width:${Math.max(0, r - l)}%`;
    },

    resetFilters() {
      ["equipo","cat_com","cat","recurrencia","fuente","area","motivo","campaign",
       "convTimeFuente","convTimeEquipo","convTimeArea","convTimeRecurrencia","convTimePrioridadMM","convTimeCampaign"].forEach(k => {
        Alpine.store("filters")[k] = [];
      });
      document.querySelectorAll("[x-data^='multiSelect']").forEach(el => {
        if (el._x_dataStack) {
          const d = el._x_dataStack[0];
          // No resetear los conv*
          if (d.key !== "convNum" && d.key !== "convDen") d.values = [];
        }
      });
      this.diaMin = 1;
      this.diaMax = this.diaTop();
      this.refresh();
    },

    // ── Precios + Subsidios ─────────────────────────────────────────────
    async initPrecios() {
      this.preciosInited = true;
      try {
        const r = await fetch(`/funnel/mm/precios-subsidios/filters?fecha_desde=${this.fechaDesde}&fecha_hasta=${this.fechaHasta}&fecha_tipo=${this.psFechaTipo}`);
        const f = await r.json();
        this.psAreas = (f.areas || []).filter(a => a && a !== "sin_area" && a !== "otra");
        this.psEquipos = (f.equipos || []).filter(e => e && e !== "(sin equipo)");
      } catch (e) {
        console.error("psFilters error", e);
      }
      await this.refreshPrecios();
    },

    async refreshPrecios() {
      if (!this.preciosInited) return;
      this.loading.precios = true;
      try {
        const params = new URLSearchParams();
        // El tab de precios muestra historia completa (experimento marca ene-26)
        params.set("fecha_desde", "2025-01-01");
        params.set("fecha_hasta", this.fechaHasta);
        params.set("fecha_tipo", this.psFechaTipo);
        params.set("granularidad", this.psGran);
        if (this.psArea)   params.set("area", this.psArea);
        if (this.psEquipo) params.set("equipo", this.psEquipo);
        const r = await fetch(`/funnel/mm/precios-subsidios/data?${params}`);
        const d = await r.json();
        this.psKpis = d.kpis || {};
        this.renderPreciosCharts(d.series || {});
      } catch (e) {
        console.error("refreshPrecios error", e);
      } finally {
        this.loading.precios = false;
      }
    },

    renderPreciosCharts(s) {
      const periods = s.periods || [];
      const _pct = arr => (arr || []).map(v => v == null ? null : v * 100);
      const _mm  = arr => (arr || []).map(v => v == null ? null : v / 1e6);

      // Anotaciones: inicio experimento (26-ene-26) y subida descuento (10-mar-26).
      // Encuentra el índice de la categoría que corresponde según granularidad.
      const findPeriodIdx = (isoDate) => {
        const d = new Date(isoDate + "T00:00:00");
        if (this.psGran === "mes") {
          const key = isoDate.slice(0, 7); // YYYY-MM
          return periods.indexOf(key);
        } else {
          // semana: lunes de esa semana
          const day = (d.getDay() + 6) % 7; // 0=lunes
          const mon = new Date(d); mon.setDate(d.getDate() - day);
          const key = mon.toISOString().slice(0, 10);
          // buscar el período más cercano <= key
          let idx = periods.indexOf(key);
          if (idx < 0) { for (let i = 0; i < periods.length; i++) { if (periods[i] <= key) idx = i; } }
          return idx;
        }
      };
      const idxExp = findPeriodIdx("2026-01-26");
      const idxSub = findPeriodIdx("2026-03-10");
      const mkAnnotations = () => {
        const ann = {};
        if (idxExp >= 0) ann.exp = {
          type: "line", xMin: idxExp, xMax: idxExp,
          borderColor: "#94a3b8", borderWidth: 1.5, borderDash: [5,4],
          label: { display: true, content: "Inicio experimento (26-ene)", position: "end",
                   backgroundColor: "#94a3b8", color: "#fff", font: { size: 9 } }
        };
        if (idxSub >= 0) ann.sub = {
          type: "line", xMin: idxSub, xMax: idxSub,
          borderColor: "#7c3aed", borderWidth: 1.5, borderDash: [5,4],
          label: { display: true, content: "Subida descuento (10-mar)", position: "start",
                   backgroundColor: "#7c3aed", color: "#fff", font: { size: 9 } }
        };
        return ann;
      };

      // Chart de descuento con 4 series (base, mín, intermedio, máx) + anotaciones
      const SERIES = [
        { key: "base",  label: "Oferta base (comité)",     color: "#0f172a", width: 3 },
        { key: "min",   label: "Mín (experimento)",        color: "#dc2626", width: 2 },
        { key: "inter", label: "Intermedio (experimento)", color: "#f59e0b", width: 2 },
        { key: "max",   label: "Máx (experimento)",        color: "#10b981", width: 2 },
      ];
      const mkDescChart = (id, prefix) => {
        if (this.psCharts[id]) this.psCharts[id].destroy();
        const ctx = document.getElementById(id);
        if (!ctx) return;
        const datasets = SERIES.map(ser => ({
          label: ser.label,
          data: _pct(s[`${prefix}_${ser.key}`]),
          borderColor: ser.color,
          backgroundColor: "transparent",
          borderWidth: ser.width,
          tension: 0.3, fill: false, spanGaps: true,
          pointRadius: 2, pointHoverRadius: 5,
        }));
        this.psCharts[id] = new Chart(ctx, {
          type: "line",
          data: { labels: periods, datasets },
          options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            scales: {
              x: { ticks: { font: { size: 10 } } },
              y: { ticks: { callback: v => v.toFixed(1) + "%" } }
            },
            plugins: {
              legend: { position: "bottom", labels: { font: { size: 10 }, boxWidth: 14 } },
              tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y == null ? "—" : ctx.parsed.y.toFixed(2) + "%"}` } },
              annotation: { annotations: mkAnnotations() }
            }
          }
        });
      };
      mkDescChart("ps-chart-desc-valor",   "dv");
      mkDescChart("ps-chart-desc-cliente", "dc");

      const lineOpts = (axis_pct=false) => ({
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { ticks: { font: { size: 10 } } },
          y: { beginAtZero: false, ticks: { callback: v => axis_pct ? v.toFixed(1) + "%" : v.toLocaleString("es-CO") } }
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => `${ctx.dataset.label || ""}: ${ctx.parsed.y == null ? "—" : (axis_pct ? ctx.parsed.y.toFixed(2) + "%" : ctx.parsed.y.toLocaleString("es-CO"))}` } },
          annotation: { annotations: mkAnnotations() }
        }
      });
      const mkLine = (id, data, color, axis_pct=false, label="") => {
        if (this.psCharts[id]) this.psCharts[id].destroy();
        const ctx = document.getElementById(id);
        if (!ctx) return;
        this.psCharts[id] = new Chart(ctx, {
          type: "line",
          data: { labels: periods, datasets: [{ label, data, borderColor: color, backgroundColor: color + "33", tension: 0.3, fill: true, pointRadius: 3, pointHoverRadius: 5, spanGaps: true }] },
          options: lineOpts(axis_pct)
        });
      };

      mkLine("ps-chart-tasa-sub",     _pct(s.tasa_subsidio), "#10b981", true, "Tasa subsidio");
      mkLine("ps-chart-monto-sub",    _mm(s.subsidio_monto), "#f59e0b", false, "Monto mediano (MM COP)");

      // Gasto stacked bar
      const gastoId = "ps-chart-gasto";
      if (this.psCharts[gastoId]) this.psCharts[gastoId].destroy();
      const gastoCtx = document.getElementById(gastoId);
      if (gastoCtx) {
        this.psCharts[gastoId] = new Chart(gastoCtx, {
          type: "bar",
          data: {
            labels: periods,
            datasets: [
              { label: "1ª bolsa", data: _mm(s.gasto_1bolsa), backgroundColor: "#06b6d4", stack: "g" },
              { label: "2ª bolsa", data: _mm(s.gasto_2bolsa), backgroundColor: "#f43f5e", stack: "g" },
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: v => v.toLocaleString("es-CO") + " M" } } },
            plugins: {
              legend: { position: "top" },
              tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${(ctx.parsed.y || 0).toLocaleString("es-CO", {maximumFractionDigits: 1})} M COP` } }
            }
          }
        });
      }

      // Bolsas use (% deals con 2 bolsa)
      const bolsaId = "ps-chart-bolsas";
      if (this.psCharts[bolsaId]) this.psCharts[bolsaId].destroy();
      const bolsaCtx = document.getElementById(bolsaId);
      if (bolsaCtx) {
        const pct2 = (s.n_uso_2bolsa || []).map((n, i) => {
          const tot = (s.n_uso_total || [])[i] || 0;
          return tot > 0 ? n / tot * 100 : null;
        });
        const pct1 = pct2.map(p => p == null ? null : 100 - p);
        this.psCharts[bolsaId] = new Chart(bolsaCtx, {
          type: "bar",
          data: {
            labels: periods,
            datasets: [
              { label: "Sólo 1ª bolsa", data: pct1, backgroundColor: "#06b6d4", stack: "b" },
              { label: "1ª + 2ª bolsa", data: pct2, backgroundColor: "#f43f5e", stack: "b" },
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            scales: { x: { stacked: true }, y: { stacked: true, max: 100, ticks: { callback: v => v + "%" } } },
            plugins: {
              legend: { position: "top" },
              tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${(ctx.parsed.y || 0).toFixed(1)}%` } }
            }
          }
        });
      }
    },
  };
}

window.filterParams = filterParams;
