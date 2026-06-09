// ── Funnel Inmo — Alpine + Chart.js + HTMX ──────────────────────────────────

document.addEventListener("alpine:init", () => {
  // Store separado del de MM para no colisionar
  Alpine.store("inmoFilters", {
    equipo: [], cat_com: [], prioridad: [], area: [],
    convNum: [], convDen: [],
  });
});

function isDarkMode() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function chartThemeInmo() {
  const dark = isDarkMode();
  return {
    text:     dark ? "#cbd5e1" : "#475569",
    grid:     dark ? "#1e293b" : "#f1f5f9",
    tooltipBg: dark ? "rgba(15,23,42,0.95)" : "rgba(255,255,255,0.95)",
    tooltipFg: dark ? "#f1f5f9" : "#1e293b",
    border:   dark ? "#334155" : "#e2e8f0",
  };
}

function applyChartThemeInmo() {
  const t = chartThemeInmo();
  if (!window.Chart) return;
  Chart.defaults.color = t.text;
  Chart.defaults.borderColor = t.grid;
  Chart.defaults.plugins.tooltip.backgroundColor = t.tooltipBg;
  Chart.defaults.plugins.tooltip.titleColor = t.tooltipFg;
  Chart.defaults.plugins.tooltip.bodyColor = t.tooltipFg;
  Chart.defaults.plugins.tooltip.borderColor = t.border;
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  applyChartThemeInmo();
  const root = document.querySelector("[x-data^='funnelInmo']");
  if (root && root._x_dataStack) {
    const data = root._x_dataStack[0];
    if (data && data.refreshVolumen) data.refreshVolumen();
  }
});

// multiSelect reutilizable — usa el store correcto según prefijo
function multiSelectInmo(key, getOptionsFn, onChange) {
  return {
    key, values: [], open: false,
    options() { return getOptionsFn() || []; },
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
      Alpine.store("inmoFilters")[this.key] = this.values.slice();
      onChange && onChange();
    },
    btnLabel() {
      const n = this.values.length, total = this.options().length;
      if (n === 0 || n === total) return "Todos";
      if (n === 1) return this.values[0];
      return `${n} seleccionados`;
    },
  };
}
window.multiSelect = multiSelectInmo;  // sobrescribe MM en su propia página

function filterParamsInmo() {
  const f = Alpine.store("inmoFilters") || {};
  const el = document.querySelector("[x-data='funnelInmo()']");
  const root = (el && el._x_dataStack && el._x_dataStack[0]) || {};
  const out = {
    fecha_desde: root.fechaDesde,
    fecha_hasta: root.fechaHasta,
    granularidad: root.granularidad,
    exclude_incidente: root.excludeIncidente ? "true" : "false",
  };
  ["equipo","cat_com","prioridad","area"].forEach(k => {
    if (f[k] && f[k].length) out[k] = f[k];
  });
  return out;
}
window.filterParams = filterParamsInmo;

function buildQS(params) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(x => usp.append(k, x));
    else if (v != null) usp.append(k, v);
  });
  return usp.toString();
}

function funnelInmo() {
  return {
    fechaDesde: document.body.dataset.fechaDesde || "2025-10-27",
    fechaHasta: document.body.dataset.fechaHasta || new Date().toISOString().slice(0,10),
    granularidad: "mes",
    excludeIncidente: true,
    filtersOptions: { equipos:[], cats_com:[], prioridades:[], areas:[] },
    etapasList: [],
    loading: { volumen: false, kpis: false, shareCat: false, convTime: false, negocios: false, metas: false },
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
    debounceT: null,
    refreshing: false,
    // Share categorización: toggle local
    shareCatExcluirSin: false,
    lastShareCatData: null,
    tab: "volumen",
    metasInited: false,
    metaCycles: [],
    metaEtapas: [],
    metaCiclo: 0,
    metaDesglose: "total",
    metaVista: "semanal",
    metaConfig: null,
    metaReal: null,
    metaKpi: {},
    metaCicloLabel: "",
    sparkCharts: {},

    init() {
      const sec = document.querySelector("[x-data='funnelInmo()']");
      this.fechaDesde = sec.dataset.fechaDesde || this.fechaDesde;
      this.fechaHasta = sec.dataset.fechaHasta || this.fechaHasta;
      const url = new URLSearchParams(window.location.search);
      if (url.get("tab") === "metas") this.tab = "metas";
      applyChartThemeInmo();

      Alpine.store("inmoFilters").convNum = ["captado"];
      Alpine.store("inmoFilters").convDen = ["asignados"];

      Promise.all([this.loadFilterOptions(), this.loadEtapas()]).then(() => {
        this.$nextTick(() => {
          document.querySelectorAll("[x-data^=\"multiSelect('convNum'\"], [x-data^=\"multiSelect('convDen'\"]").forEach(el => {
            if (el._x_dataStack) {
              const d = el._x_dataStack[0];
              d.values = Alpine.store("inmoFilters")[d.key] || [];
            }
          });
        });
        this.refreshVolumen();
        this.refreshShareCat();
        this.refreshConvTime();
        this.refreshNegocios();
        if (this.tab === "metas" && !this.metasInited) this.initMetas();
      });
    },

    async loadFilterOptions() {
      const r = await fetch(`/funnel/inmo/filters?fecha_desde=${this.fechaDesde}&fecha_hasta=${this.fechaHasta}`);
      this.filtersOptions = await r.json();
    },
    async loadEtapas() {
      const r = await fetch("/funnel/inmo/etapas");
      const arr = await r.json();
      this.etapasList = arr.map(e => e.key);
    },

    async forceRefresh() {
      this.refreshing = true;
      try {
        await fetch("/admin/cache/clear", { method: "POST" });
        await this.loadFilterOptions();
        this.refreshVolumen();
        this.refreshShareCat();
        this.refreshConvTime();
        this.refreshNegocios();
        htmx.trigger(document.getElementById("kpis-section"), "refresh-kpis");
        if (this.tab === "metas" && this.metasInited) this.refreshMetas();
      } finally {
        setTimeout(() => { this.refreshing = false; }, 800);
      }
    },

    refresh() {
      clearTimeout(this.debounceT);
      this.debounceT = setTimeout(() => {
        this.refreshVolumen();
        this.refreshShareCat();
        this.refreshConvTime();
        this.negociosPage = 1;
        this.refreshNegocios();
        htmx.trigger(document.getElementById("kpis-section"), "refresh-kpis");
        if (this.tab === "metas" && this.metasInited) this.refreshMetas();
      }, 200);
    },

    switchTab(t) {
      this.tab = t;
      if (t === "metas" && !this.metasInited) this.initMetas();
    },

    async initMetas() {
      this.metasInited = true;
      const r = await fetch("/funnel/inmo/metas/config");
      this.metaConfig = await r.json();
      this.metaCycles = this.metaConfig.cycles || [];
      this.metaEtapas = this.metaConfig.etapas || [];
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
        const params = filterParamsInmo();
        params.ciclo = this.metaCiclo;
        params.desglose = this.metaDesglose;
        const [realRes, kpiRes] = await Promise.all([
          fetch(`/funnel/inmo/metas/real?${buildQS(params)}`).then(r => r.json()),
          fetch(`/funnel/inmo/metas/kpi-tendencias?${buildQS(params)}`).then(r => r.json()),
        ]);
        this.metaReal = realRes;
        this.metaKpi = kpiRes.series || {};
        this.$nextTick(() => { this.renderSparklines(); this.renderMetaTable(); });
      } finally {
        this.loading.metas = false;
      }
    },

    renderSparklines() {
      this.metaEtapas.forEach((etapa, i) => {
        const el = document.getElementById(`spark-inmo-${i}`);
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
              { label: "Real", data: s.reales, backgroundColor: "#00897B", borderRadius: 1, barPercentage: 0.5, categoryPercentage: 0.9 },
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: {
              callbacks: {
                title: items => `Sem ${items[0].label}`,
                label: c => ` ${c.dataset.label}: ${c.parsed.y == null ? "—" : Math.round(c.parsed.y).toLocaleString("es-CO")}`,
              }
            } },
            scales: { x: { display: false }, y: { display: false, beginAtZero: true } },
            animation: { duration: 200 },
          }
        }); } catch (e) { console.error(`spark-inmo ${i} failed`, e); }
      });
    },

    renderMetaTable() {
      const tbody = document.querySelector("#metas-table tbody");
      const empty = document.getElementById("metas-empty");
      if (!this.metaReal || !this.metaConfig) { tbody.innerHTML = ""; return; }
      const semanas = this.metaReal.semanas || [];
      const desglose = this.metaDesglose;
      const today = new Date().toISOString().slice(0,10);

      let buckets = ["Total"];
      if (desglose === "equipo") buckets = ["Total","Inmobiliaria 1","Inmobiliaria 2","Medellín","Cali","Barranquilla"];
      else if (desglose === "categoria") buckets = ["Total","A","B","C"];

      const metas = this.metaConfig.metas || {};
      const real = this.metaReal.data || {};
      const ciclo = this.metaCiclo;

      const fmt = n => n == null ? "—" : (typeof n === "number" ? Math.round(n).toLocaleString("es-CO") : n.toLocaleString("es-CO"));
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
          let totalMetaWeek = [], totalRealWeek = [];
          let metaAcum = 0, realAcum = 0;
          semanas.forEach(s => {
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

      document.getElementById("metas-table").innerHTML = html;
      empty.classList.toggle("hidden", totalRows > 0);
    },

    async refreshNegocios() {
      this.loading.negocios = true;
      try {
        const params = filterParamsInmo();
        params.etapa = this.negociosEtapa;
        if (this.negociosSearch) params.search = this.negociosSearch;
        params.page = this.negociosPage;
        params.page_size = this.negociosPageSize;
        const r = await fetch(`/funnel/inmo/negocios?${buildQS(params)}`);
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
      document.getElementById("negocios-pageinfo").textContent = data.total > 0
        ? `${start.toLocaleString("es-CO")}–${end.toLocaleString("es-CO")} de ${data.total.toLocaleString("es-CO")}` : "Sin resultados";
      const tbody = document.getElementById("negocios-tbody");
      if (!data.rows.length) {
        tbody.innerHTML = `<tr><td colspan="12" class="px-3 py-6 text-center text-slate-400 dark:text-slate-500">Sin resultados</td></tr>`;
        return;
      }
      const dash = '<span class="text-slate-300 dark:text-slate-600">—</span>';
      tbody.innerHTML = data.rows.map(r => `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/50">
          <td class="px-3 py-2 font-mono text-[11px] md:text-xs">${r.nid}</td>
          <td class="px-3 py-2 whitespace-nowrap">${r.equipo || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap">${r.categoria_comercial || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap">${r.prioridad || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap">${r.area_metropolitana || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-400">${r.fecha_asignacion || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-400">${r.fecha_perfilado || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-400">${r.fecha_comite || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-400">${r.fecha_aprobado || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-400">${r.fecha_ofertado || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-400">${r.fecha_aceptada || dash}</td>
          <td class="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-400">${r.fecha_captado || dash}</td>
        </tr>
      `).join("");
    },

    async exportNegocios() {
      const params = filterParamsInmo();
      params.etapa = this.negociosEtapa;
      if (this.negociosSearch) params.search = this.negociosSearch;
      params.page = 1; params.page_size = 200;
      const all = []; let p = 1;
      while (true) {
        params.page = p;
        const r = await fetch(`/funnel/inmo/negocios?${buildQS(params)}`);
        const data = await r.json();
        all.push(...data.rows);
        if (all.length >= data.total || data.rows.length === 0) break;
        p++;
        if (p > 50) break;
      }
      const headers = ["nid","equipo","categoria_comercial","prioridad","area_metropolitana","fecha_asignacion","fecha_perfilado","fecha_comite","fecha_aprobado","fecha_ofertado","fecha_aceptada","fecha_captado"];
      const csv = [headers.join(",")].concat(
        all.map(r => headers.map(h => `"${(r[h] || "").toString().replace(/"/g,'""')}"`).join(","))
      ).join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `negocios_inmo_${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },

    async refreshVolumen() {
      this.loading.volumen = true;
      try {
        const r = await fetch(`/funnel/inmo/volumen?${buildQS(filterParamsInmo())}`);
        this.renderVolumen(await r.json());
      } finally { this.loading.volumen = false; }
    },
    async refreshShareCat() {
      this.loading.shareCat = true;
      try {
        const r = await fetch(`/funnel/inmo/share-cat?${buildQS(filterParamsInmo())}`);
        const data = await r.json();
        this.lastShareCatData = data;
        this.renderShareCat(data);
      } finally { this.loading.shareCat = false; }
    },
    async refreshConvTime() {
      this.loading.convTime = true;
      try {
        const params = filterParamsInmo();
        const s = Alpine.store("inmoFilters");
        if (s.convNum && s.convNum.length) params.num = s.convNum;
        if (s.convDen && s.convDen.length) params.den = s.convDen;
        const r = await fetch(`/funnel/inmo/conv-time?${buildQS(params)}`);
        this.renderConvTime(await r.json());
      } finally { this.loading.convTime = false; }
    },

    renderVolumen(data) {
      const el = document.getElementById("chart-volumen");
      if (!el) return;
      Chart.getChart(el)?.destroy();
      this.chartVolumen = null;
      const ctx = el.getContext("2d");
      if (!ctx) return;
      const t = chartThemeInmo();
      try { this.chartVolumen = new Chart(ctx, {
        type: "bar",
        data: {
          labels: data.labels,
          datasets: data.datasets.map(d => ({
            label: d.label, data: d.data, backgroundColor: d.color, borderRadius: 4, borderSkipped: false,
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

    renderShareCat(data) {
      if (!data) return;
      // Toggle local: excluir "Sin categoría" y recalcular total/share
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
      const t = chartThemeInmo();
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
            label: d.label, data: d.data, backgroundColor: d.color, stack: "cat", borderWidth: 0, borderRadius: 3,
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

    renderConvTime(data) {
      const t = chartThemeInmo();
      const fmt = n => n.toLocaleString("es-CO");
      const totalsEl = document.getElementById("conv-totals");
      const totalCvr = data.total_cvr == null ? "—" : data.total_cvr.toFixed(2) + "%";
      totalsEl.innerHTML = `Total: <strong class="text-slate-700 dark:text-slate-200">${fmt(data.total_num)}</strong> / <strong class="text-slate-700 dark:text-slate-200">${fmt(data.total_den)}</strong> = <strong class="text-brand-600 dark:text-brand-400">${totalCvr}</strong>`;
      const elCT = document.getElementById("chart-conv-time");
      if (!elCT) return;
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
      const ctxCT = elCT.getContext("2d");
      if (!ctxCT) return;
      try { this.chartConvTime = new Chart(ctxCT, {
        type: "line",
        data: {
          labels: data.labels,
          datasets: [
            { label: "CVR %", type: "line", yAxisID: "y1", data: data.cvr,
              borderColor: "#00897B", backgroundColor: "rgba(0,137,123,0.12)", fill: true, tension: 0.25, pointRadius: 3, pointHoverRadius: 5, borderWidth: 2, order: 0 },
            { label: "Numerador", type: "bar", yAxisID: "y2", data: data.num,
              backgroundColor: "rgba(16,185,129,0.55)", borderWidth: 0, borderRadius: 3, order: 2 },
            { label: "Denominador", type: "bar", yAxisID: "y2", data: data.den,
              backgroundColor: "rgba(148,163,184,0.30)", borderWidth: 0, borderRadius: 3, order: 3 },
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
          animation: { duration: 300 },
        }
      }); } catch (e) { console.error("renderConvTime failed", e); }
    },

    resetFilters() {
      ["equipo","cat_com","prioridad","area"].forEach(k => {
        Alpine.store("inmoFilters")[k] = [];
      });
      document.querySelectorAll("[x-data^='multiSelect']").forEach(el => {
        if (el._x_dataStack) {
          const d = el._x_dataStack[0];
          if (d.key !== "convNum" && d.key !== "convDen") d.values = [];
        }
      });
      this.refresh();
    },
  };
}
