// ── Rechazos y Aprobaciones — Alpine + Chart.js ─────────────────────────────

function rechMulti(key, getOptionsFn, onChange) {
  return {
    key, values: [], open: false,
    options() { return getOptionsFn() || []; },
    allSelected() { return this.values.length === this.options().length && this.options().length > 0; },
    toggle(v) {
      const i = this.values.indexOf(v);
      if (i >= 0) this.values.splice(i, 1); else this.values.push(v);
      onChange && onChange();
    },
    toggleAll(e) { this.values = e.target.checked ? [...this.options()] : []; onChange && onChange(); },
    btnLabel() {
      const n = this.values.length, total = this.options().length;
      if (n === 0 || n === total) return "Todas";
      if (n === 1) return this.values[0];
      return `${n} seleccionadas`;
    },
  };
}

const TIPO_STYLE = {
  "Aprobado General": { color: "#7c3aed", fill: "rgba(124,58,237,0.22)" },
  "Rechazo Comite":   { color: "#0891b2", fill: "rgba(8,145,178,0.18)" },
  "Rechazo Remo":     { color: "#f59e0b", fill: "rgba(245,158,11,0.18)" },
};

function rechazos() {
  return {
    fechaDesde: "2026-01-01",
    fechaHasta: "",
    areaOptions: [],
    selectedAreas: [],
    gran: "mes",
    tipoTabla: "comite",
    raw: { meses: [], serie: {}, razones: [], total_mes: [] },
    loading: false,
    refreshing: false,
    chart: null,

    _loaded: false,

    init() {
      const el = this.$el;
      this.fechaDesde = el.dataset.fechaDesde || this.fechaDesde;
      this.fechaHasta = el.dataset.fechaHasta || new Date().toISOString().slice(0, 10);
      if (el.dataset.lazy === "1") {
        // Embebido como tab: carga al primer "show"; luego solo re-renderiza (resize).
        window.addEventListener("rechazos:show", () => {
          if (!this._loaded) { this._loaded = true; this.loadFilters(); this.loadData(); }
          else { this.$nextTick(() => this.renderChart()); }
        });
      } else {
        this._loaded = true;
        this.loadFilters();
        this.loadData();
      }
    },

    async loadFilters() {
      try {
        const r = await fetch(`/api/rechazos?action=filters&fecha_desde=${this.fechaDesde}&fecha_hasta=${this.fechaHasta}`);
        const j = await r.json();
        this.areaOptions = j.areas || [];
      } catch (e) { this.areaOptions = []; }
    },

    async loadData() {
      this.loading = true;
      try {
        const qs = new URLSearchParams({ action: "data", fecha_desde: this.fechaDesde, fecha_hasta: this.fechaHasta, granularidad: this.gran });
        (this.selectedAreas || []).forEach(a => qs.append("area", a));
        const r = await fetch(`/api/rechazos?${qs.toString()}`);
        this.raw = await r.json();
        this.$nextTick(() => this.renderChart());
      } finally {
        this.loading = false;
      }
    },

    onAreaChange() {
      const el = document.querySelector("[x-data*=\"rechMulti('area'\"]");
      this.selectedAreas = el?._x_dataStack?.[0]?.values || [];
      this.loadData();
    },

    async forceRefresh() {
      this.refreshing = true;
      try {
        await fetch("/api/admin/cache/clear", { method: "POST" });
        await this.loadData();
      } finally {
        setTimeout(() => { this.refreshing = false; }, 700);
      }
    },

    fmtMes(m) {
      const meses = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
      if (/^\d{4}-\d{2}$/.test(m)) {          // mes: 'YYYY-MM' → 'ene 26'
        const [y, mm] = m.split("-");
        return `${meses[parseInt(mm,10)-1]} ${y.slice(2)}`;
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(m)) {    // día/semana: 'YYYY-MM-DD' → 'DD mmm'
        const [y, mm, dd] = m.split("-");
        return `${dd} ${meses[parseInt(mm,10)-1]}`;
      }
      return m;                                // ciclos comerciales: label ya viene listo
    },

    // ── Chart ──────────────────────────────────────────────────────────────
    renderChart() {
      const el = document.getElementById("chart-rechazos");
      if (!el || typeof Chart === "undefined") return;
      const meses = this.raw.meses || [];
      const labels = meses.map(m => this.fmtMes(m));
      const order = ["Aprobado General", "Rechazo Comite", "Rechazo Remo"];
      const datasets = order.filter(t => this.raw.serie[t]).map(t => {
        const s = this.raw.serie[t];
        const st = TIPO_STYLE[t];
        return {
          label: t,
          data: s.pct,
          _counts: s.counts,
          borderColor: st.color,
          backgroundColor: st.fill,
          fill: "origin",
          tension: 0.35,
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 2,
        };
      });
      const dark = document.documentElement.classList.contains("dark") ||
        window.matchMedia("(prefers-color-scheme: dark)").matches;
      const grid = dark ? "rgba(148,163,184,0.15)" : "rgba(100,116,139,0.12)";
      const tick = dark ? "#94a3b8" : "#64748b";
      // Línea de Total (conteo absoluto del mes) en eje secundario de volumen (derecha),
      // para no distorsionar el eje de share %.
      datasets.push({
        label: "Total",
        data: this.raw.total_mes || [],
        _isTotal: true,
        yAxisID: "yCount",
        borderColor: dark ? "#cbd5e1" : "#475569",
        backgroundColor: "transparent",
        borderDash: [5, 4],
        fill: false,
        tension: 0.35,
        pointRadius: 2,
        pointHoverRadius: 5,
        borderWidth: 2,
      });
      Chart.getChart(el)?.destroy();
      this.chart = new Chart(el, {
        type: "line",
        data: { labels, datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { labels: { color: tick, usePointStyle: true, boxWidth: 10 } },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  if (ctx.dataset._isTotal) {
                    const v = ctx.parsed.y;
                    return `Total: ${v != null ? v.toLocaleString("es-CO") : "–"}`;
                  }
                  const n = ctx.dataset._counts ? ctx.dataset._counts[ctx.dataIndex] : null;
                  const pct = ctx.parsed.y;
                  return `${ctx.dataset.label}: ${n != null ? n.toLocaleString("es-CO") : "–"} (${pct != null ? pct.toFixed(1) : "–"}%)`;
                },
              },
            },
          },
          scales: {
            y: { beginAtZero: true, suggestedMax: 80, ticks: { color: tick, callback: v => v + "%" }, grid: { color: grid } },
            yCount: { position: "right", beginAtZero: true, ticks: { color: tick },
                      grid: { drawOnChartArea: false }, title: { display: true, text: "Total (conteo)", color: tick } },
            x: { ticks: { color: tick }, grid: { color: grid } },
          },
        },
      });
    },

    // ── Tabla: 3 totales siempre visibles; el toggle solo expande razones ────
    get tableData() {
      const meses = this.raw.meses || [];
      const totMes = this.raw.total_mes || [];
      const razones = this.raw.razones || [];
      const pctOf = (counts) => meses.map((_, ci) => totMes[ci] > 0 ? (counts[ci] / totMes[ci] * 100) : null);

      // Definición de los 3 tipos y si su sección está expandida (según el toggle)
      const TIPOS = [
        { key: "Aprobado General", label: "Aprobado General",        expandable: false, expanded: false },
        { key: "Rechazo Comite",   label: "Rechazo Comité",          expandable: true,  expanded: this.tipoTabla === "comite" || this.tipoTabla === "ambos" },
        { key: "Rechazo Remo",     label: "Rechazo Remodelaciones",  expandable: true,  expanded: this.tipoTabla === "remo"   || this.tipoTabla === "ambos" },
      ];

      const rows = [];
      TIPOS.forEach(t => {
        const rs = razones.filter(r => r.tipo === t.key);
        const totalCounts = meses.map((_, ci) => rs.reduce((s, r) => s + (r.counts[ci] || 0), 0));
        rows.push({
          level: 0, tipo: t.label, razon: "",
          expandable: t.expandable, expanded: t.expanded,
          pcts: pctOf(totalCounts),
        });
        if (t.expanded) {
          rs.slice().sort((a, b) => b.total - a.total).forEach(r => {
            rows.push({ level: 1, tipo: t.label, razon: r.razon, expandable: false, expanded: false, pcts: pctOf(r.counts) });
          });
        }
      });
      // Total = 100% (los 3 tipos cubren todos los negocios del mes)
      const totalRow = meses.map((_, ci) => totMes[ci] > 0 ? 100 : null);
      return { meses, rows, totalRow };
    },
  };
}
