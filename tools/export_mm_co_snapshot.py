#!/usr/bin/env python3
"""Exporta un SNAPSHOT (día vencido) del Funnel MM CO a un HTML autocontenido (artifact).

Consume los endpoints de la webapp YA CORRIENDO en :8765 (misma lógica/SQL que la app
en vivo), arma el JSON por equipo + total, y lo embebe en un HTML de un solo archivo
con Chart.js (CDN). Abrible en el navegador o pegable como artifact HTML en claude.ai.

NO toca la webapp — corre en paralelo. Para refrescar: volver a ejecutar este script.

Uso:
    python3 tools/export_mm_co_snapshot.py
Salida:
    artifact_snapshot/funnel_mm_co_snapshot.html
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

BASE = "http://127.0.0.1:8765/funnel/mm"
OUT = Path(__file__).parent.parent / "artifact_snapshot" / "funnel_mm_co_snapshot.html"

FECHA_DESDE = "2026-01-01"
FECHA_HASTA = (date.today() - timedelta(days=1)).isoformat()  # día vencido (ayer)


def _get(path: str, params: dict) -> dict:
    qs = urllib.parse.urlencode(params, doseq=True)
    with urllib.request.urlopen(f"{BASE}{path}?{qs}", timeout=120) as r:
        return json.loads(r.read())


def _common(equipo: str | None) -> dict:
    p = {"fecha_desde": FECHA_DESDE, "fecha_hasta": FECHA_HASTA}
    if equipo:
        p["equipo"] = equipo
    return p


def export() -> dict:
    filt = _get("/filters", {"fecha_desde": FECHA_DESDE, "fecha_hasta": FECHA_HASTA})
    equipos = filt.get("equipos", [])
    print(f"Equipos: {len(equipos)} → {equipos}")

    data: dict[str, dict] = {}
    # 'Todos' (sin filtro) + cada equipo
    targets = [("Todos", None)] + [(e, e) for e in equipos]
    for label, eq in targets:
        print(f"  exportando: {label} …")
        p = _common(eq)
        data[label] = {
            "volumen_mes":   _get("/volumen", {**p, "granularidad": "mes"}),
            "volumen_sem":   _get("/volumen", {**p, "granularidad": "semana"}),
            "share":         _get("/share-cat", {**p, "granularidad": "mes"}),
            "cvr":           _get("/conv-time", {**p, "granularidad": "mes"}),
        }
    return {
        "meta": {
            "vista": "Funnel MM · Colombia",
            "fecha_desde": FECHA_DESDE,
            "fecha_hasta": FECHA_HASTA,
            "generado": date.today().isoformat(),
        },
        "equipos": ["Todos"] + equipos,
        "data": data,
    }


HTML = """<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Funnel MM CO — Snapshot</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.4/chart.umd.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', system-ui, sans-serif; background: #f8fafc; color: #1e293b; padding: 24px; }
  .wrap { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 22px; font-weight: 700; }
  .sub { color: #64748b; font-size: 13px; margin-top: 4px; }
  .badge { display:inline-block; background:#fef3c7; color:#92400e; font-size:11px; font-weight:600; padding:3px 8px; border-radius:6px; margin-left:8px; }
  .controls { display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; margin: 18px 0; }
  label { display:flex; flex-direction:column; gap:4px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; color:#64748b; }
  select, .seg button { font-size:13px; }
  select { padding:8px 10px; border:1px solid #cbd5e1; border-radius:8px; background:#fff; }
  .seg { display:inline-flex; border:1px solid #cbd5e1; border-radius:8px; overflow:hidden; }
  .seg button { padding:8px 14px; border:0; background:#fff; cursor:pointer; color:#475569; }
  .seg button.active { background:#7c3aed; color:#fff; }
  .card { background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:18px; margin-bottom:16px; box-shadow:0 1px 2px rgba(0,0,0,.04); }
  .card h2 { font-size:15px; font-weight:600; margin-bottom:12px; }
  .grid2 { display:grid; grid-template-columns: 220px 1fr; gap:18px; align-items:center; }
  .legend > div { display:flex; align-items:center; gap:8px; font-size:13px; padding:4px 0; border-top:1px solid #f1f5f9; }
  .legend .sw { width:11px; height:11px; border-radius:3px; }
  .totals { font-size:13px; color:#475569; }
  canvas { max-height: 380px; }
</style>
</head>
<body>
<div class="wrap">
  <div>
    <h1 id="title">Funnel MM · Colombia <span class="badge" id="badge">snapshot</span></h1>
    <div class="sub" id="meta"></div>
  </div>

  <div class="controls">
    <label>Equipo
      <select id="equipo"></select>
    </label>
    <label>Granularidad
      <div class="seg" id="gran">
        <button data-g="mes" class="active">Mes</button>
        <button data-g="semana">Semana</button>
      </div>
    </label>
  </div>

  <div class="card">
    <h2>Volumen por etapa</h2>
    <canvas id="chartVol"></canvas>
  </div>

  <div class="card">
    <h2>Share por categoría (Primera asignación)</h2>
    <div class="grid2">
      <div style="position:relative;height:200px"><canvas id="chartDonut"></canvas></div>
      <div id="shareLegend" class="legend"></div>
    </div>
    <div style="margin-top:14px"><canvas id="chartShareBars"></canvas></div>
  </div>

  <div class="card">
    <h2>Tasa de conversión en el tiempo <span class="totals" id="cvrTotals"></span></h2>
    <canvas id="chartCvr"></canvas>
  </div>
</div>

<script>
const SNAP = __DATA__;
let equipo = "Todos", gran = "mes";
const charts = {};
const fmt = n => (n ?? 0).toLocaleString("es-CO");

function mk(id, cfg){ if(charts[id]) charts[id].destroy(); charts[id] = new Chart(document.getElementById(id), cfg); }

function render(){
  const d = SNAP.data[equipo];
  // Volumen
  const vol = gran === "mes" ? d.volumen_mes : d.volumen_sem;
  mk("chartVol", { type:"bar", data:{ labels: vol.labels, datasets: vol.datasets.map(s=>({label:s.label,data:s.data,backgroundColor:s.color,borderRadius:4})) },
    options:{ responsive:true, plugins:{legend:{position:"top",align:"start",labels:{usePointStyle:true,pointStyle:"rect",font:{size:11}}},
      tooltip:{callbacks:{label:c=>` ${c.dataset.label}: ${fmt(c.parsed.y)}`}}}, scales:{x:{grid:{display:false}},y:{beginAtZero:true,ticks:{callback:v=>v>=1000?(v/1000).toFixed(0)+"k":v}}}}});
  // Share donut + bars + leyenda
  const sh = d.share;
  mk("chartDonut", { type:"doughnut", data:{labels:sh.donut.labels, datasets:[{data:sh.donut.values, backgroundColor:sh.donut.colors, borderWidth:2}]},
    options:{responsive:true, maintainAspectRatio:false, cutout:"62%", plugins:{legend:{display:false}, tooltip:{callbacks:{label:c=>{const p=sh.donut.total>0?(c.parsed/sh.donut.total*100).toFixed(1):"0";return ` ${c.label}: ${fmt(c.parsed)} (${p}%)`;}}}}}});
  document.getElementById("shareLegend").innerHTML =
    `<div style="border:0;font-size:10px;font-weight:700;text-transform:uppercase;color:#64748b">Total asignados</div>`+
    `<div style="border:0;font-size:22px;font-weight:700">${fmt(sh.donut.total)}</div>`+
    sh.donut.labels.map((l,i)=>{const v=sh.donut.values[i];const p=sh.donut.total>0?(v/sh.donut.total*100).toFixed(1):"0";
      return `<div><span class="sw" style="background:${sh.donut.colors[i]}"></span><span style="flex:1">${l}</span><span>${fmt(v)}</span><strong style="color:${sh.donut.colors[i]}">${p}%</strong></div>`;}).join("");
  mk("chartShareBars", { type:"bar", data:{labels:sh.bars.labels, datasets:sh.bars.datasets.map(x=>({label:x.label,data:x.data,backgroundColor:x.color,stack:"c",borderRadius:3}))},
    options:{responsive:true, plugins:{legend:{position:"top",align:"start",labels:{usePointStyle:true,pointStyle:"rect",font:{size:11}}}}, scales:{x:{stacked:true,grid:{display:false}},y:{stacked:true,beginAtZero:true}}}});
  // CVR
  const cv = d.cvr;
  document.getElementById("cvrTotals").textContent = cv.total_cvr==null?"":`· Total ${fmt(cv.total_num)}/${fmt(cv.total_den)} = ${cv.total_cvr.toFixed(2)}%`;
  mk("chartCvr", { data:{labels:cv.labels, datasets:[
      {type:"line",label:"CVR %",yAxisID:"y1",data:cv.cvr,borderColor:"#7c3aed",backgroundColor:"rgba(124,58,237,.12)",fill:true,tension:.25,pointRadius:3},
      {type:"bar",label:"Numerador",yAxisID:"y2",data:cv.num,backgroundColor:"rgba(16,185,129,.55)",borderRadius:3},
      {type:"bar",label:"Denominador",yAxisID:"y2",data:cv.den,backgroundColor:"rgba(148,163,184,.3)",borderRadius:3}]},
    options:{responsive:true, interaction:{mode:"index",intersect:false}, plugins:{legend:{position:"top",align:"start",labels:{usePointStyle:true,pointStyle:"rect",font:{size:11}}},
      tooltip:{callbacks:{label:c=>c.dataset.label==="CVR %"?` CVR: ${c.parsed.y==null?"—":c.parsed.y.toFixed(2)+"%"}`:` ${c.dataset.label}: ${fmt(c.parsed.y)}`}}},
      scales:{y1:{position:"left",beginAtZero:true,ticks:{callback:v=>v.toFixed(0)+"%"}},y2:{position:"right",beginAtZero:true,grid:{display:false},ticks:{callback:v=>v>=1000?(v/1000).toFixed(0)+"k":v}}}}});
}

// init
const sel = document.getElementById("equipo");
SNAP.equipos.forEach(e=>{const o=document.createElement("option");o.value=e;o.textContent=e;sel.appendChild(o);});
sel.onchange = e => { equipo = e.target.value; render(); };
document.querySelectorAll("#gran button").forEach(b=>b.onclick=()=>{gran=b.dataset.g;document.querySelectorAll("#gran button").forEach(x=>x.classList.toggle("active",x===b));render();});
document.getElementById("meta").textContent = `${SNAP.meta.fecha_desde} → ${SNAP.meta.fecha_hasta} · datos al cierre del ${SNAP.meta.fecha_hasta} (día vencido) · generado ${SNAP.meta.generado}`;
render();
</script>
</body>
</html>
"""


def main():
    snap = export()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    html = HTML.replace("__DATA__", json.dumps(snap, ensure_ascii=False))
    OUT.write_text(html, encoding="utf-8")
    size_kb = OUT.stat().st_size / 1024
    print(f"\n✅ {OUT}  ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
