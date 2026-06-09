// ── Funnel Combinado MM + Inmo — Alpine + Chart.js ─────────────────────────

document.addEventListener("alpine:init", () => {
  Alpine.store("filters_combo", {
    equipo: [],
    area: [],
  });
});

function isDarkMode() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
function chartTheme() {
  const dark = isDarkMode();
  return {
    text:      dark ? "#cbd5e1" : "#475569",
    grid:      dark ? "#1e293b" : "#f1f5f9",
    tooltipBg: dark ? "rgba(15,23,42,0.95)" : "rgba(255,255,255,0.95)",
    tooltipFg: dark ? "#f1f5f9" : "#1e293b",
    border:    dark ? "#334155" : "#e2e8f0",
  };
}
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

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  applyChartTheme();
  const root = document.querySelector("[x-data='funnelCombinado()']");
  if (root && root._x_dataStack) {
    const data = root._x_dataStack[0];
    if (data && data.refreshConvTime) data.refreshConvTime();
  }
});

// Multi-select reusado (versión local para no depender de funnel_mm.js)
function multiSelect(key, getOptionsFn, onChange) {
  return {
    key,
    values: [],
    open: false,
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
      Alpine.store("filters_combo")[this.key] = this.values.slice();
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

function buildQS(params) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(x => usp.append(k, x));
    else if (v != null) usp.append(k, v);
  });
  return usp.toString();
}

function funnelCombinado() {
  return {
    fechaDesde: "2026-01-01",
    fechaHasta: new Date().toISOString().slice(0, 10),
    granularidad: "mes",
    convNum: "combo:transacciones",
    convDen: "combo:asignados",
    filtersOptions: { equipos: [], areas: [] },
    etapaGroups: [],
    loading: { convTime: false },
    chartConvTime: null,

    init() {
      const root = document.querySelector("[x-data='funnelCombinado()']");
      if (root) {
        this.fechaDesde = root.dataset.fechaDesde || this.fechaDesde;
        this.fechaHasta = root.dataset.fechaHasta || this.fechaHasta;
        this.convNum = root.dataset.defaultNum || this.convNum;
        this.convDen = root.dataset.defaultDen || this.convDen;
      }
      applyChartTheme();
      Promise.all([this.loadFilterOptions(), this.loadEtapas()]).then(() => {
        this.refreshConvTime();
      });
    },

    async loadFilterOptions() {
      const r = await fetch(`/funnel/combinado/filters?fecha_desde=${this.fechaDesde}&fecha_hasta=${this.fechaHasta}`);
      this.filtersOptions = await r.json();
    },

    async loadEtapas() {
      const r = await fetch("/funnel/combinado/etapas");
      const data = await r.json();
      this.etapaGroups = data.groups || [];
    },

    filterParams() {
      const f = Alpine.store("filters_combo") || {};
      const out = {
        fecha_desde: this.fechaDesde,
        fecha_hasta: this.fechaHasta,
        granularidad: this.granularidad,
        num: this.convNum,
        den: this.convDen,
      };
      if (f.equipo && f.equipo.length) out.equipo = f.equipo;
      if (f.area && f.area.length)     out.area   = f.area;
      return out;
    },

    refreshAll() {
      // Cambió rango de fechas → recargar opciones de filtro y el chart
      this.loadFilterOptions().then(() => this.refreshConvTime());
    },

    resetFilters() {
      Alpine.store("filters_combo").equipo = [];
      Alpine.store("filters_combo").area = [];
      // Reset multi-selects abiertos
      document.querySelectorAll("[x-data^='multiSelect']").forEach(el => {
        if (el._x_dataStack) el._x_dataStack[0].values = [];
      });
      this.refreshConvTime();
    },

    async refreshConvTime() {
      this.loading.convTime = true;
      try {
        const r = await fetch(`/funnel/combinado/conv-time?${buildQS(this.filterParams())}`);
        const data = await r.json();
        this.renderConvTime(data);
      } catch (e) {
        console.error("refreshConvTime failed", e);
      } finally {
        this.loading.convTime = false;
      }
    },

    renderConvTime(data) {
      const t = chartTheme();
      const fmt = n => (n ?? 0).toLocaleString("es-CO");
      const totalsEl = document.getElementById("conv-totals");
      if (totalsEl) {
        const totalCvr = data.total_cvr == null ? "—" : data.total_cvr.toFixed(2) + "%";
        totalsEl.innerHTML = `Total: <strong class="text-slate-700 dark:text-slate-200">${fmt(data.total_num)}</strong> / <strong class="text-slate-700 dark:text-slate-200">${fmt(data.total_den)}</strong> = <strong class="text-brand-600 dark:text-brand-400">${totalCvr}</strong>`;
      }

      const el = document.getElementById("chart-conv-time");
      if (!el) return;

      // Patrón update-or-create
      const existing = Chart.getChart(el);
      if (existing) {
        try {
          existing.data.labels = data.labels;
          existing.data.datasets[0].data = data.cvr;
          existing.data.datasets[1].data = data.num;
          existing.data.datasets[2].data = data.den;
          existing.data.datasets[1].label = "Numerador";
          existing.data.datasets[2].label = "Denominador";
          existing.update("none");
          this.chartConvTime = existing;
          return;
        } catch (e) {
          console.error("update failed, recreating", e);
          existing.destroy();
        }
      }

      const ctx = el.getContext("2d");
      if (!ctx) return;
      try {
        this.chartConvTime = new Chart(ctx, {
          type: "line",
          data: {
            labels: data.labels,
            datasets: [
              {
                label: "CVR %", type: "line", yAxisID: "y1", data: data.cvr,
                borderColor: "#7c3aed", backgroundColor: "rgba(124,58,237,0.12)",
                fill: true, tension: 0.25, pointRadius: 3, pointHoverRadius: 5,
                borderWidth: 2, order: 0,
              },
              {
                label: "Numerador", type: "bar", yAxisID: "y2", data: data.num,
                backgroundColor: "rgba(16,185,129,0.55)", borderWidth: 0,
                borderRadius: 3, order: 2,
              },
              {
                label: "Denominador", type: "bar", yAxisID: "y2", data: data.den,
                backgroundColor: "rgba(148,163,184,0.30)", borderWidth: 0,
                borderRadius: 3, order: 3,
              }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
              legend: { position: "top", align: "start",
                labels: { usePointStyle: true, pointStyle: "rect", padding: 14, font: { size: 11 }, color: t.text } },
              tooltip: {
                callbacks: {
                  label: c => {
                    if (c.dataset.label === "CVR %") {
                      return ` CVR: ${c.parsed.y == null ? "—" : c.parsed.y.toFixed(2) + "%"}`;
                    }
                    return ` ${c.dataset.label}: ${c.parsed.y.toLocaleString("es-CO")}`;
                  }
                }
              }
            },
            scales: {
              x: { grid: { display: false }, ticks: { color: t.text, font: { size: 11 } } },
              y1: { position: "left", beginAtZero: true, grid: { color: t.grid },
                    title: { display: true, text: "CVR %", color: t.text, font: { size: 11 } },
                    ticks: { color: t.text, font: { size: 11 }, callback: v => v.toFixed(0) + "%" } },
              y2: { position: "right", beginAtZero: true, grid: { display: false },
                    title: { display: true, text: "Volumen", color: t.text, font: { size: 11 } },
                    ticks: { color: t.text, font: { size: 11 },
                             callback: v => v >= 1000 ? (v / 1000).toFixed(0) + "k" : v } }
            },
            animation: { duration: 0 },
          }
        });
      } catch (e) {
        console.error("renderConvTime failed", e);
      }
    },
  };
}
