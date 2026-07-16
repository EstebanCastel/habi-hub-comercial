// ── Funnel Combinado MM + Inmo — Alpine + Chart.js ─────────────────────────

document.addEventListener("alpine:init", () => {
  Alpine.store("filters_combo", {
    equipo: [],
    area: [],
    motivo: [],
    bnpl: [],
    cmpA_equipo: [], cmpA_area: [], cmpA_motivo: [],
    cmpB_equipo: [], cmpB_area: [], cmpB_motivo: [],
    cmpC_equipo: [], cmpC_area: [], cmpC_motivo: [],
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
    tab: "cvr",
    // cosechas
    cosechaOrigen: "combo:asignados", cosechaDestino: "combo:transacciones",
    cosechaGran: "mes", cosechaBucket: "iso", cosechaConteo: "cohorte",
    cosechaModo: "pct", cosechaAcum: false, cosechaData: null, cosechaTitle: "", cosechaSummary: "",
    // comparación
    mesA: "", mesB: "", mesC: "", sourceA: "both", sourceB: "both", sourceC: "both",

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
        this.refreshCosechas();
      });
    },

    switchTab(t) { this.tab = t; },

    async loadFilterOptions() {
      const r = await fetch(`/api/funnel/combinado?action=filters&fecha_desde=${this.fechaDesde}&fecha_hasta=${this.fechaHasta}`);
      this.filtersOptions = await r.json();
      const meses = this.filtersOptions.meses || [];
      if (!this.mesA && meses.length) { this.mesA = meses[0]; this.refreshCompare("A"); }
      if (!this.mesB && meses.length > 1) { this.mesB = meses[1]; this.refreshCompare("B"); }
      if (!this.mesC && meses.length) { this.mesC = meses[2] || meses[0]; this.refreshCompare("C"); }
    },

    async loadEtapas() {
      const r = await fetch("/api/funnel/combinado?action=etapas");
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
      if (f.motivo && f.motivo.length) out.motivo = f.motivo;
      if (f.bnpl && f.bnpl.length)     out.bnpl   = f.bnpl;
      return out;
    },

    refreshAll() {
      // Cambió rango de fechas → recargar opciones de filtro y el chart
      this.loadFilterOptions().then(() => this.refreshConvTime());
    },

    resetFilters() {
      Alpine.store("filters_combo").equipo = [];
      Alpine.store("filters_combo").area = [];
      Alpine.store("filters_combo").motivo = [];
      Alpine.store("filters_combo").bnpl = [];
      // Reset solo los multi-selects globales (no los de cohorte cmpA_/cmpB_)
      document.querySelectorAll("[x-data^='multiSelect']").forEach(el => {
        const d = el._x_dataStack && el._x_dataStack[0];
        if (d && ["equipo", "area", "motivo", "bnpl"].includes(d.key)) d.values = [];
      });
      this.refreshConvTime();
    },

    async refreshConvTime() {
      this.loading.convTime = true;
      try {
        const r = await fetch(`/api/funnel/combinado?action=conv-time&${buildQS(this.filterParams())}`);
        const data = await r.json();
        this.renderConvTime(data);
        this.refreshCosechas();
      } catch (e) {
        console.error("refreshConvTime failed", e);
      } finally {
        this.loading.convTime = false;
      }
    },

    // ── Cosechas + comparación (entidad = source:nid) ──
    cosechaParams() {
      const f = Alpine.store("filters_combo") || {};
      const out = {
        origen: this.cosechaOrigen, destino: this.cosechaDestino,
        granularidad: this.cosechaGran, bucket: this.cosechaBucket, conteo: this.cosechaConteo,
        fecha_desde: this.fechaDesde, fecha_hasta: this.fechaHasta,
      };
      if (f.equipo && f.equipo.length) out.equipo = f.equipo;
      if (f.area && f.area.length)     out.area   = f.area;
      if (f.motivo && f.motivo.length) out.motivo = f.motivo;
      if (f.bnpl && f.bnpl.length)     out.bnpl   = f.bnpl;
      return out;
    },
    async refreshCosechas() {
      const r = await fetch(`/api/funnel/combinado?action=cosechas&${buildQS(this.cosechaParams())}`);
      this.cosechaData = await r.json();
      this.renderCosechasTable();
    },
    renderCosechasTable() {
      const d = this.cosechaData;
      const table = document.getElementById("cosechasTable"); const empty = document.getElementById("cosechasEmpty");
      if (!d || !d.rows || !d.rows.length) { if (table) table.innerHTML = ""; if (empty) empty.classList.remove("hidden"); this.cosechaTitle = ""; this.cosechaSummary = ""; return; }
      if (empty) empty.classList.add("hidden");
      this.cosechaTitle = `${d.origen_label} → ${d.destino_label}`;
      const tl = d.rows.reduce((s, r) => s + r.total, 0), ta = d.rows.reduce((s, r) => s + r.alcanzaron, 0);
      this.cosechaSummary = `${d.rows.length} cohortes · ${tl.toLocaleString("es-CO")} · ${(tl>0?ta/tl*100:0).toFixed(1)}% alcanzaron`;
      const offsets = (d.bucket === "dias" && d.offset_ranges) ? d.offset_ranges : (d.offset_labels || []);
      const acum = this.cosechaAcum, modo = this.cosechaModo, scaleMax = modo === "share" ? 60 : 50;
      const bg = (v, f) => (f || v == null || v === 0) ? "" : `background:rgba(124,58,237,${(Math.min(1, v/scaleMax)*0.85).toFixed(3)});`;
      const tc = (v, f) => { if (f) return "text-slate-300 dark:text-slate-700"; if (v == null || v === 0) return "text-slate-400 dark:text-slate-600"; if (v >= scaleMax*0.5) return "text-white font-semibold"; if (v >= scaleMax*0.2) return "text-slate-900 dark:text-slate-100 font-medium"; return "text-slate-700 dark:text-slate-300"; };
      const today = new Date().toISOString().slice(0,10);
      const fut = (co, off) => { let bs; if (this.cosechaGran === "semana") { const dt = new Date(co + "T00:00:00"); dt.setDate(dt.getDate() + off*7); bs = dt.toISOString().slice(0,10); } else { const [y, m] = co.split("-").map(Number); if (d.bucket === "dias") { const dt = new Date(y, m-1, 1); dt.setDate(dt.getDate() + off*30); bs = dt.toISOString().slice(0,10); } else { const dt = new Date(y, m-1+off, 1); bs = dt.toISOString().slice(0,10); } } return bs > today; };
      let html = `<thead class="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-[10px] uppercase tracking-wider"><tr><th class="px-3 py-2.5 text-left whitespace-nowrap sticky left-0 bg-slate-50 dark:bg-slate-800 z-10">Cohorte</th><th class="px-2 py-2.5 text-right">Total</th><th class="px-2 py-2.5 text-right">Llegaron</th>`;
      offsets.forEach(l => { html += `<th class="px-2 py-2.5 text-center">${l}</th>`; });
      html += `</tr></thead><tbody class="divide-y divide-slate-100 dark:divide-slate-800">`;
      d.rows.forEach(r => {
        const pcts = acum ? r.cum_pct : r.pct, shares = acum ? r.cum_share : r.share, counts = acum ? r.cum_counts : r.counts;
        const g = r.total > 0 ? (r.alcanzaron / r.total * 100) : 0;
        html += `<tr class="hover:bg-slate-50/50 dark:hover:bg-slate-800/50"><td class="px-3 py-2 font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap sticky left-0 bg-white dark:bg-slate-900">${r.cohorte}</td><td class="px-2 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">${r.total.toLocaleString("es-CO")}</td><td class="px-2 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300"><span class="font-semibold">${r.alcanzaron.toLocaleString("es-CO")}</span> <span class="text-[10px] text-slate-400 ml-1">${g.toFixed(1)}%</span></td>`;
        offsets.forEach((l, i) => { const pct = pcts[i], sh = shares ? shares[i] : null, cn = counts[i]; const f = fut(r.cohorte, i); let txt, pv; if (f) { txt = "—"; pv = null; } else if (modo === "abs") { txt = cn == null ? "—" : cn.toLocaleString("es-CO"); pv = pct; } else if (modo === "share") { txt = sh == null ? "—" : sh.toFixed(1)+"%"; pv = sh; } else { txt = pct == null ? "—" : pct.toFixed(1)+"%"; pv = pct; } html += `<td class="px-2 py-2 text-center text-xs tabular-nums ${tc(pv, f)}" style="${bg(pv, f)}">${txt}</td>`; });
        html += `</tr>`;
      });
      html += `</tbody>`; table.innerHTML = html;
    },
    async refreshCompare(c) {
      const f = Alpine.store("filters_combo") || {};
      const p = { };
      const mes = c === "A" ? this.mesA : this.mesB;
      if (mes) p.mes = mes;
      p.source = c === "A" ? this.sourceA : this.sourceB;
      if ((f["cmp"+c+"_equipo"] || []).length) p.equipo = f["cmp"+c+"_equipo"];
      if ((f["cmp"+c+"_area"]   || []).length) p.area   = f["cmp"+c+"_area"];
      if ((f["cmp"+c+"_motivo"] || []).length) p.motivo = f["cmp"+c+"_motivo"];
      const r = await fetch(`/api/funnel/combinado?action=funnel-compare&${buildQS(p)}`);
      this.renderCompare(c, await r.json());
    },
    renderCompare(c, data) {
      const accent = c === "A" ? "#2563eb" : "#059669", fmt = n => n.toLocaleString("es-CO");
      const hdr = document.getElementById("funnelHdr"+c);
      if (hdr) hdr.innerHTML = `<span class="text-base font-bold" style="color:${accent}">${fmt(data.total)}</span> nids · Asignados · ${data.mes}`;
      const box = document.getElementById("funnel"+c);
      if (!box) return;
      box.innerHTML = data.stages.map(s => {
        const width = Math.max(2, s.pct_first);
        const prev = s.pct_prev == null ? "" : `<span class="text-slate-400 dark:text-slate-500 ml-1">${s.pct_prev.toFixed(1)}% vs ant.</span>`;
        return `<div><div class="flex items-baseline justify-between text-xs mb-0.5"><span class="font-medium text-slate-700 dark:text-slate-200">${s.label}</span><span class="tabular-nums"><span class="font-semibold text-slate-900 dark:text-slate-100">${fmt(s.nids)}</span><span class="font-semibold ml-1" style="color:${accent}">${s.pct_first.toFixed(1)}%</span>${prev}</span></div><div class="h-2.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden"><div class="h-full rounded-full" style="width:${width}%;background:${accent}"></div></div></div>`;
      }).join("");
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
