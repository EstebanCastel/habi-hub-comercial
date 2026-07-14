// ── Conversión por Seller — Alpine ──────────────────────────────────────────

function multiSelectCS(key, getOptionsFn, onChange) {
  return {
    key, values: [], open: false, filter: "",
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
      onChange && onChange();
    },
    toggleAll(e) {
      this.values = e.target.checked ? [...this.options()] : [];
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

function convSeller() {
  return {
    producto: "mm",
    ciclo: 0,
    search: "",
    minAsig: 0,
    sortKey: "cvr",
    sortDir: "desc",
    raw: { mm: [], inmo: [] },
    cicloOptions: [],
    selectedCiclos: [],       // ciclos elegidos (números); [] = todos
    _defaultCiclo: null,
    _ciclosInited: false,
    periodoLabel: "",
    filteredRows: [],
    filteredCount: 0,
    kpis: [],
    // Para los multi-selects
    selectedEquipos: [],
    selectedCats: [],
    selectedComerciales: [],
    selectedPriorities: [],   // solo Inmo
    selectedCampaigns: [],    // utm_campaign (server-side → re-fetch)
    campaignOptions: [],
    refreshing: false,
    shareCatMode: "lead",   // 'lead' (categoría del inmueble) | 'seller' (categoría del comercial)
    cvrLinesChart: null,
    prevRows: [],           // filas por-seller del ciclo anterior (truncadas a igual día)
    kpiCompareMeta: null,   // {prev_ciclo, elapsed_asig_days, elapsed_cierre_days, ciclo, producto}
    _kpiCompareKey: null,

    init() {
      // Re-renderiza el chart de líneas al cambiar el toggle lead/seller
      this.$watch("shareCatMode", () => this.renderCvrLines());
      this.loadCampaigns();
      this.loadCycles().then(() => this.loadData());
    },

    async loadCampaigns() {
      try {
        const r = await fetch("/conversion/seller/campaigns");
        const j = await r.json();
        this.campaignOptions = j.campaigns || [];
      } catch (e) { this.campaignOptions = []; }
    },

    // El filtro de campaña es server-side: al cambiar hay que re-fetchear /data.
    onCampaignChange() {
      const el = document.querySelector("[x-data*=\"multiSelectCS('campana'\"]");
      this.selectedCampaigns = el?._x_dataStack?.[0]?.values || [];
      this.loadData();
    },

    async loadCycles() {
      const r = await fetch("/conversion/seller/cycles");
      const j = await r.json();
      this.cicloOptions = j.periods;
      // Ciclo "actual" = el primero que aún no termina (cierre_end >= hoy)
      const today = new Date().toISOString().slice(0,10);
      const current = this.cicloOptions.find(c => c.cierre_end >= today) || this.cicloOptions[this.cicloOptions.length-1];
      this._defaultCiclo = current ? current.ciclo : (this.cicloOptions[0]?.ciclo || 0);
    },

    // Etiquetas del multiselect de ciclos ("Ciclo N"), en orden.
    get cicloLabels() {
      return (this.cicloOptions || []).map(c => "Ciclo " + c.ciclo);
    },

    // Escribe la selección de ciclos en el store del multiselect + estado.
    _setCiclosSelection(ciclos) {
      const el = document.querySelector("[x-data*=\"multiSelectCS('ciclo'\"]");
      if (el?._x_dataStack) el._x_dataStack[0].values = ciclos.map(c => "Ciclo " + c);
      this.selectedCiclos = ciclos.slice();
    },

    async loadData() {
      const qs = (this.selectedCampaigns || [])
        .map(c => "campaign=" + encodeURIComponent(c)).join("&");
      const r = await fetch("/conversion/seller/data" + (qs ? "?" + qs : ""));
      this.raw = await r.json();
      // Primera carga: pre-selecciona el ciclo actual (ya con los multiselects montados).
      if (!this._ciclosInited) {
        this._ciclosInited = true;
        if (this._defaultCiclo != null) this._setCiclosSelection([this._defaultCiclo]);
      }
      this.rebuild();
    },

    async forceRefresh() {
      this.refreshing = true;
      try {
        await fetch("/admin/cache/clear", { method: "POST" });
        await this.loadData();
      } finally {
        setTimeout(() => { this.refreshing = false; }, 800);
      }
    },

    updatePeriodoLabel() {
      const sel = this.selectedCiclos || [];
      if (sel.length === 0) { this.periodoLabel = "📅 Todos los ciclos (acumulado por comercial)"; return; }
      if (sel.length === 1) {
        const p = this.cicloOptions.find(c => c.ciclo === sel[0]);
        if (p) { this.periodoLabel = `📅 Asignación: ${p.asig_start} → ${p.asig_end} · Cierre: ${p.cierre_start} → ${p.cierre_end}`; return; }
      }
      this.periodoLabel = `📅 ${sel.length} ciclos: ${[...sel].sort((a,b)=>a-b).map(c=>'C'+c).join(', ')} (acumulado por comercial)`;
    },

    get equiposOptions() {
      const set = new Set();
      let hasSinEquipo = false;
      this.allRows.forEach(r => { if (r.equipo) set.add(r.equipo); else hasSinEquipo = true; });
      const out = [...set].sort();
      if (hasSinEquipo) out.push("Sin equipo");   // ex-empleados sin equipo registrado
      return out;
    },
    get catOptions() {
      const set = new Set();
      this.allRows.forEach(r => { if (r.categoria) set.add(r.categoria); });
      return [...set].sort();
    },
    get sellerOptions() {
      // Comerciales con al menos un asignado, del ciclo seleccionado (relevante a la vista)
      const set = new Set();
      const sel = this.selectedCiclos || [];
      const inSel = c => sel.length === 0 || sel.includes(c);
      this.allRows.forEach(r => { if (r.email && inSel(r.ciclo) && (r.asignados || 0) > 0) set.add(r.email); });
      return [...set].sort();
    },
    get prioOptions() {
      // Prioridades de gestión inmo presentes en los datos (asignados o captados)
      const set = new Set();
      this.allRows.forEach(r => {
        Object.keys(r.asig_prio || {}).forEach(p => set.add(p));
        Object.keys(r.num_prio  || {}).forEach(p => set.add(p));
      });
      return [...set].sort();
    },
    get allRows() { return this.raw[this.producto] || []; },

    // Aplica el filtro de prioridad inmo a una fila: recalcula asignados/num/cvr y los
    // breakdowns por categoría a partir del breakdown por prioridad. No-op para MM o
    // cuando no hay prioridades seleccionadas.
    applyPrio(r) {
      if (this.producto !== "inmo" || !this.selectedPriorities.length) return r;
      let asig = 0, num = 0;
      this.selectedPriorities.forEach(p => {
        asig += (r.asig_prio && r.asig_prio[p]) || 0;
        num  += (r.num_prio  && r.num_prio[p])  || 0;
      });
      const cvr = asig > 0 ? num / asig : null;
      const k = ["A", "B", "C"].includes(r.categoria) ? r.categoria : "SC";
      const asig_cat = { A: 0, B: 0, C: 0, SC: 0 }; asig_cat[k] = asig;
      const num_cat  = { A: 0, B: 0, C: 0, SC: 0 }; num_cat[k]  = num;
      return { ...r, asignados: asig, num, cvr, asig_cat, num_cat };
    },

    // Aplica los filtros de tabla (equipo/categoría/comercial/búsqueda + prioridad +
    // mín. asignados) a un set de filas YA acotado al ciclo relevante. Compartido por
    // la vista actual y por la referencia del ciclo anterior → misma lógica exacta.
    _filterRows(rows) {
      const prioActive = this.producto === "inmo" && this.selectedPriorities.length > 0;
      return rows.filter(r => {
        if (this.selectedEquipos.length && !this.selectedEquipos.includes(r.equipo || "Sin equipo")) return false;
        if (this.selectedCats.length && !this.selectedCats.includes(r.categoria)) return false;
        if (this.selectedComerciales.length && !this.selectedComerciales.includes(r.email)) return false;
        if (this.search && !(r.email || "").includes(this.search)) return false;
        return true;
      }).map(r => this.applyPrio(r)).filter(r => {
        if (prioActive && (r.asignados || 0) === 0 && (r.num || 0) === 0) return false;
        if ((r.asignados || 0) < this.minAsig) return false;
        return true;
      });
    },

    // Totales KPI (asignados, num, sellers activos, cvr) de un set de filas, tras filtrar.
    _kpiTotals(rows) {
      let asig = 0, num = 0, sellers = 0;
      this._filterRows(rows).forEach(r => {
        asig += r.asignados || 0;
        num  += r.num || 0;
        if ((r.asignados || 0) > 0) sellers++;
      });
      return { asignados: asig, num, sellers, cvr: asig > 0 ? num / asig : null };
    },

    // Fusiona todas las filas por comercial (para "Todos los ciclos"): suma asignados/
    // num y los breakdowns por categoría y prioridad; recalcula cvr. Una fila por email.
    _mergeByEmail(rows) {
      const m = {};
      const cats = ["A", "B", "C", "SC"];
      rows.forEach(r => {
        let e = m[r.email];
        if (!e) {
          e = m[r.email] = {
            ciclo: -1, email: r.email, equipo: r.equipo, categoria: r.categoria,
            cvr_meta: r.cvr_meta, asignados: 0, num: 0,
            asig_cat: { A: 0, B: 0, C: 0, SC: 0 }, num_cat: { A: 0, B: 0, C: 0, SC: 0 },
            asig_prio: {}, num_prio: {},
          };
        }
        e.asignados += r.asignados || 0;
        e.num += r.num || 0;
        cats.forEach(k => {
          e.asig_cat[k] += (r.asig_cat && r.asig_cat[k]) || 0;
          e.num_cat[k]  += (r.num_cat  && r.num_cat[k])  || 0;
        });
        Object.entries(r.asig_prio || {}).forEach(([k, v]) => e.asig_prio[k] = (e.asig_prio[k] || 0) + v);
        Object.entries(r.num_prio  || {}).forEach(([k, v]) => e.num_prio[k]  = (e.num_prio[k]  || 0) + v);
        if (!e.equipo && r.equipo) e.equipo = r.equipo;
        if (!e.categoria && r.categoria) e.categoria = r.categoria;
        if (e.cvr_meta == null && r.cvr_meta != null) e.cvr_meta = r.cvr_meta;
      });
      return Object.values(m).map(e => ({ ...e, cvr: e.asignados > 0 ? e.num / e.asignados : null }));
    },

    // ── Share por categoría (barras 100% apiladas) ──────────────────────────────
    get shareCats() {
      return [
        { cat: "A",  label: "A",        color: "#10b981" },
        { cat: "B",  label: "B",        color: "#f59e0b" },
        { cat: "C",  label: "C",        color: "#f43f5e" },
        { cat: "SC", label: "Sin cat.", color: "#94a3b8" },
      ];
    },
    get shareLegend() { return this.shareCats; },
    get shareData() {
      const cats = this.shareCats;
      const asig = { A: 0, B: 0, C: 0, SC: 0 };
      const cier = { A: 0, B: 0, C: 0, SC: 0 };
      this.filteredRows.forEach(r => {
        if (this.shareCatMode === "lead") {
          cats.forEach(c => {
            asig[c.cat] += (r.asig_cat && r.asig_cat[c.cat]) || 0;
            cier[c.cat] += (r.num_cat  && r.num_cat[c.cat])  || 0;
          });
        } else {
          const k = ["A", "B", "C"].includes(r.categoria) ? r.categoria : "SC";
          asig[k] += r.asignados || 0;
          cier[k] += r.num || 0;
        }
      });
      const mk = (tot) => {
        const sum = cats.reduce((a, c) => a + tot[c.cat], 0);
        return cats
          .map(c => ({ cat: c.cat, label: c.label, color: c.color, count: tot[c.cat], pct: sum > 0 ? tot[c.cat] / sum * 100 : 0 }))
          .filter(s => s.count > 0);
      };
      return {
        asig: mk(asig), cier: mk(cier),
        asigTotal: cats.reduce((a, c) => a + asig[c.cat], 0),
        cierTotal: cats.reduce((a, c) => a + cier[c.cat], 0),
      };
    },
    get tableHeaders() {
      const numLabel = this.producto === "mm" ? "Cierres" : "Captados";
      return [
        { key: "email",        label: "Seller",     right: false },
        { key: "equipo",       label: "Equipo",     right: false },
        { key: "categoria",    label: "Cat.",       right: false },
        { key: "asignados",    label: "Asignados",  right: true },
        { key: "num",          label: numLabel,     right: true },
        { key: "cvr",          label: "CVR",        right: true },
        { key: "cvr_meta",     label: "Meta CVR",   right: true },
        { key: "delta_meta",   label: "Δ vs meta",  right: true },
        { key: "delta_team",   label: "Δ vs equipo",right: true },
        { key: "delta_global", label: "Δ vs global",right: true },
      ];
    },

    rebuild() {
      // Multi-selects values reading (incluye selectedCiclos)
      this.refreshSelectedFromStores();
      this.updatePeriodoLabel();

      // Filtra a los ciclos elegidos (vacío = todos) y SIEMPRE fusiona por comercial:
      // una fila por seller sumando los ciclos seleccionados (con 1 ciclo el merge es
      // idéntico a la fila original).
      const sel = this.selectedCiclos || [];
      const inSel = r => sel.length === 0 || sel.includes(r.ciclo);
      let rows = this._filterRows(this._mergeByEmail(this.allRows.filter(inSel)));

      // Referencia cycle-to-date: solo cuando hay EXACTAMENTE 1 ciclo seleccionado.
      const singleCiclo = sel.length === 1 ? sel[0] : null;
      const meta = this.kpiCompareMeta;
      const prevOk = singleCiclo != null && meta && meta.ciclo === singleCiclo && meta.producto === this.producto;
      this._prevTotals = prevOk ? this._kpiTotals(this.prevRows) : null;

      let totalAsig = 0, totalNum = 0;
      rows.forEach(r => { totalAsig += r.asignados; totalNum += r.num; });
      const globalCvr = totalAsig > 0 ? totalNum / totalAsig : null;

      // Promedio por equipo
      const byTeam = {};
      rows.forEach(r => {
        if (!byTeam[r.equipo]) byTeam[r.equipo] = { asig: 0, num: 0 };
        byTeam[r.equipo].asig += r.asignados;
        byTeam[r.equipo].num  += r.num;
      });
      const teamCvr = {};
      Object.keys(byTeam).forEach(t => {
        const d = byTeam[t];
        teamCvr[t] = d.asig > 0 ? d.num / d.asig : null;
      });

      rows = rows.map(r => ({
        ...r,
        delta_meta:   (r.cvr != null && r.cvr_meta != null) ? (r.cvr - r.cvr_meta) * 100 : null,
        delta_team:   (r.cvr != null && teamCvr[r.equipo] != null) ? (r.cvr - teamCvr[r.equipo]) * 100 : null,
        delta_global: (r.cvr != null && globalCvr != null) ? (r.cvr - globalCvr) * 100 : null,
        cvr_team:     teamCvr[r.equipo],
        cvr_global:   globalCvr,
      }));

      rows.sort((a, b) => {
        let va = a[this.sortKey], vb = b[this.sortKey];
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (typeof va === "string") { va = va.toLowerCase(); vb = vb.toLowerCase(); }
        if (va < vb) return this.sortDir === "asc" ? -1 : 1;
        if (va > vb) return this.sortDir === "asc" ?  1 : -1;
        return 0;
      });

      this.filteredRows = rows;
      this.filteredCount = rows.length;
      this.updateKpis(globalCvr, totalAsig, totalNum);
      this.loadKpiCompare();
      this.$nextTick(() => this.renderCvrLines());
    },

    // ── CVR por mes comercial y categoría (líneas) ──────────────────────────────
    renderCvrLines() {
      const el = document.getElementById("chart-cvr-lines");
      if (!el || typeof Chart === "undefined") return;
      const cats = this.shareCats;
      // Mismos filtros que la tabla pero SIN el de ciclo (el chart abarca todos los ciclos)
      const rows = this.allRows.filter(r => {
        if (this.selectedEquipos.length && !this.selectedEquipos.includes(r.equipo || "Sin equipo")) return false;
        if (this.selectedCats.length && !this.selectedCats.includes(r.categoria)) return false;
        if (this.selectedComerciales.length && !this.selectedComerciales.includes(r.email)) return false;
        if (this.search && !(r.email || "").includes(this.search)) return false;
        return true;
      }).map(r => this.applyPrio(r)).filter(r => (r.asignados || 0) >= this.minAsig);
      const cycles = [...new Set(this.allRows.map(r => r.ciclo))].sort((a, b) => a - b);
      const labels = cycles.map(c => "Ciclo " + c);
      const agg = {};
      cycles.forEach(c => { agg[c] = {}; cats.forEach(k => agg[c][k.cat] = { asig: 0, num: 0 }); });
      rows.forEach(r => {
        if (!(r.ciclo in agg)) return;
        if (this.shareCatMode === "lead") {
          cats.forEach(k => {
            agg[r.ciclo][k.cat].asig += (r.asig_cat && r.asig_cat[k.cat]) || 0;
            agg[r.ciclo][k.cat].num  += (r.num_cat  && r.num_cat[k.cat])  || 0;
          });
        } else {
          const k = ["A", "B", "C"].includes(r.categoria) ? r.categoria : "SC";
          agg[r.ciclo][k].asig += r.asignados || 0;
          agg[r.ciclo][k].num  += r.num || 0;
        }
      });
      // Si hay filtro de CATEGORÍA activo, mostrar solo esas categorías (no las demás
      // que un seller de esa categoría igual pudo trabajar, ej. leads sin categoría).
      const catFilter = this.selectedCats.length ? new Set(this.selectedCats) : null;
      const datasets = cats
        .filter(k => !catFilter || catFilter.has(k.cat))
        .filter(k => cycles.some(c => agg[c][k.cat].asig > 0))
        .map(k => ({
          label: k.label,
          data: cycles.map(c => {
            const d = agg[c][k.cat];
            return d.asig > 0 ? +(d.num / d.asig * 100).toFixed(2) : null;
          }),
          borderColor: k.color,
          backgroundColor: k.color,
          tension: 0.35,
          spanGaps: true,
          pointRadius: 3,
          pointHoverRadius: 5,
        }));
      const dark = document.documentElement.classList.contains("dark");
      const gridC = dark ? "rgba(148,163,184,0.15)" : "rgba(100,116,139,0.12)";
      const tickC = dark ? "#94a3b8" : "#64748b";
      Chart.getChart(el)?.destroy();
      this.cvrLinesChart = new Chart(el, {
        type: "line",
        data: { labels, datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { labels: { color: tickC, usePointStyle: true, boxWidth: 8 } },
            tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y == null ? "—" : ctx.parsed.y.toFixed(1) + "%"}` } },
          },
          scales: {
            y: { beginAtZero: true, ticks: { color: tickC, callback: v => v + "%" }, grid: { color: gridC }, title: { display: true, text: "CVR %", color: tickC } },
            x: { ticks: { color: tickC }, grid: { color: gridC } },
          },
        },
      });
    },

    refreshSelectedFromStores() {
      // Lee los valores actuales de los multi-selects desde sus _x_dataStack
      const eqEl   = document.querySelector("[x-data*=\"multiSelectCS('equipo'\"]");
      const catEl  = document.querySelector("[x-data*=\"multiSelectCS('categoria'\"]");
      const comEl  = document.querySelector("[x-data*=\"multiSelectCS('comercial'\"]");
      const prioEl = document.querySelector("[x-data*=\"multiSelectCS('prioridad'\"]");
      const cicEl  = document.querySelector("[x-data*=\"multiSelectCS('ciclo'\"]");
      this.selectedEquipos     = eqEl?._x_dataStack?.[0]?.values || [];
      this.selectedCats        = catEl?._x_dataStack?.[0]?.values || [];
      this.selectedComerciales = comEl?._x_dataStack?.[0]?.values || [];
      this.selectedPriorities  = prioEl?._x_dataStack?.[0]?.values || [];
      // Etiquetas "Ciclo N" → números
      this.selectedCiclos = (cicEl?._x_dataStack?.[0]?.values || [])
        .map(v => parseInt(String(v).replace(/[^0-9]/g, ""), 10))
        .filter(n => !isNaN(n));
    },

    updateKpis(globalCvr, totalAsig, totalNum) {
      const numLabel = this.producto === "mm" ? "Cierres" : "Captados";
      const nSellers = this.filteredRows.filter(r => r.asignados > 0).length;

      // Referencia = ciclo anterior a igual día (solo con 1 ciclo seleccionado).
      // this._prevTotals ya viene null en rebuild si no aplica.
      const meta = this.kpiCompareMeta;
      const prev = this._prevTotals;
      const pc = prev && meta ? meta.prev_ciclo : null;

      // kind: 'count' → Δ absoluto + %; 'pct' → Δ en puntos porcentuales.
      const cmpLine = (curVal, prevVal, kind, days) => {
        if (prev == null || prevVal == null) return null;
        const dLabel = days != null ? ` (día ${days})` : "";
        if (kind === "pct") {
          const cur = (curVal ?? 0) * 100, pv = prevVal * 100, dpp = cur - pv;
          return {
            text: `C${pc}${dLabel}: ${pv.toFixed(1)}% · ${dpp >= 0 ? "+" : ""}${dpp.toFixed(1)} pp`,
            good: dpp >= 0,
          };
        }
        const delta = (curVal ?? 0) - prevVal;
        const pctTxt = prevVal > 0 ? ` · ${delta >= 0 ? "+" : ""}${(delta / prevVal * 100).toFixed(0)}%` : "";
        return {
          text: `C${pc}${dLabel}: ${prevVal.toLocaleString("es-CO")}${pctTxt}`,
          good: delta >= 0,
        };
      };
      const eAsig = prev ? meta.elapsed_asig_days : null;
      const eCie = prev ? meta.elapsed_cierre_days : null;

      this.kpis = [
        { label: "CVR global",       value: this.fmtPct(globalCvr),          sub: `${totalNum.toLocaleString("es-CO")} / ${totalAsig.toLocaleString("es-CO")}`,
          cmp: cmpLine(globalCvr, prev && prev.cvr, "pct", null) },
        { label: "Sellers activos",  value: nSellers.toLocaleString("es-CO"), sub: "con al menos 1 asignado",
          cmp: cmpLine(nSellers, prev && prev.sellers, "count", eAsig) },
        { label: "Total asignados",  value: totalAsig.toLocaleString("es-CO"),sub: "en período de asignación",
          cmp: cmpLine(totalAsig, prev && prev.asignados, "count", eAsig) },
        { label: `Total ${numLabel}`,value: totalNum.toLocaleString("es-CO"), sub: "en período de cierre del ciclo",
          cmp: cmpLine(totalNum, prev && prev.num, "count", eCie) },
      ];
    },

    async loadKpiCompare() {
      // Comparación solo con EXACTAMENTE 1 ciclo seleccionado.
      const sel = this.selectedCiclos || [];
      const single = sel.length === 1 ? sel[0] : null;
      if (single == null) {
        this._kpiCompareKey = "none"; this.prevRows = []; this.kpiCompareMeta = null;
        return;
      }
      const key = `${this.producto}|${single}|${(this.selectedCampaigns || []).join(",")}`;
      if (key === this._kpiCompareKey) return;   // ya lo tenemos para esta vista
      this._kpiCompareKey = key;
      this.prevRows = [];                        // limpia referencia stale mientras carga
      this.kpiCompareMeta = null;
      try {
        const params = new URLSearchParams();
        params.set("ciclo", single);
        params.set("producto", this.producto);
        (this.selectedCampaigns || []).forEach(c => params.append("campaign", c));
        const r = await fetch("/conversion/seller/kpis-compare?" + params.toString());
        const j = await r.json();
        if (this._kpiCompareKey !== key) return; // llegó tarde: otra vista activa
        this.prevRows = j.prev_rows || [];
        this.kpiCompareMeta = j.prev_ciclo == null ? null : {
          ciclo: j.ciclo, producto: j.producto, prev_ciclo: j.prev_ciclo,
          elapsed_asig_days: j.elapsed_asig_days, elapsed_cierre_days: j.elapsed_cierre_days,
        };
        this.rebuild();                          // recalcula todo con la referencia ya cargada
      } catch (e) { /* sin comparación si falla */ }
    },

    sortBy(k) {
      if (this.sortKey === k) {
        this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
      } else {
        this.sortKey = k;
        this.sortDir = (k === "email" || k === "equipo" || k === "categoria") ? "asc" : "desc";
      }
      this.rebuild();
    },

    // ── Formatters ────────────────────────────────────────────────────────────
    fmtPct(v) {
      return v == null ? "—" : (v * 100).toFixed(1) + "%";
    },
    fmtPp(v) {
      if (v == null) return "—";
      const sign = v >= 0 ? "+" : "";
      return sign + v.toFixed(1) + " pp";
    },
    cvrColor(cvr, meta) {
      if (cvr == null) return "text-slate-400 dark:text-slate-500";
      if (meta == null) return "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300";
      const ratio = cvr / meta;
      if (ratio >= 1.0)  return "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300";
      if (ratio >= 0.8)  return "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300";
      return "bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300";
    },
    deltaColor(d) {
      if (d == null) return "text-slate-400 dark:text-slate-500";
      return d >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";
    },

    exportCsv() {
      const headers = ["email","equipo","categoria","asignados","num","cvr","cvr_meta","delta_meta","delta_team","delta_global"];
      const csv = [headers.join(",")].concat(
        this.filteredRows.map(r => headers.map(h => {
          const v = r[h];
          if (v == null) return "";
          if (typeof v === "number") return v.toString();
          return `"${v.toString().replace(/"/g,'""')}"`;
        }).join(","))
      ).join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const cicloTag = (this.selectedCiclos || []).length ? "c" + [...this.selectedCiclos].sort((a,b)=>a-b).join("-") : "ctodos";
      a.download = `conv_seller_${this.producto}_${cicloTag}_${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
  };
}
