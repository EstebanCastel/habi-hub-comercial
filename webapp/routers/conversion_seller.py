"""Router de Conversión por Seller.

CVR throughput por (ciclo, seller):
  - MM:   Asignados → Cierres
  - Inmo: Asignados → Captados

Atribución:
  - MM: hubspot_owner_id_historico (owner al momento del evento; hubspot_owner_id en funnel_diarios_col es el owner ACTUAL).
  - Inmo: hubspot_owner_id actual del deal.

Endpoints:
  GET /         → página
  GET /cycles   → períodos de asignación y cierre por ciclo
  GET /data     → JSON {mm:[...], inmo:[...]} para todos los ciclos
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates

from webapp import bq

# ── Exclusión de nids (mass-reassignments etc.) ──────────────────────────────
EXCLUSION_CSV = Path(__file__).parent.parent.parent / "NID's para excluir asignaciones Colombia - nids_MM.csv"
METAS_COM_CSV = Path(__file__).parent.parent.parent / "metas_comerciales_co.csv"


def _load_excluded_nids() -> list[str]:
    if not EXCLUSION_CSV.exists():
        return []
    import csv as csvmod
    nids: list[str] = []
    with EXCLUSION_CSV.open(encoding="utf-8") as f:
        for row in csvmod.DictReader(f):
            # Header tiene espacio: "nids_a_excluir "
            v = (row.get("nids_a_excluir") or row.get("nids_a_excluir ") or "").strip()
            if v.isdigit():
                nids.append(v)
    return nids


def _load_metas_comerciales() -> list[dict]:
    """Lee metas_comerciales_co.csv (export del Sheet)."""
    if not METAS_COM_CSV.exists():
        return []
    import csv as csvmod
    out: list[dict] = []
    with METAS_COM_CSV.open(encoding="utf-8") as f:
        for row in csvmod.DictReader(f):
            cid = (row.get("comercial_id") or "").strip().lower()
            mes = (row.get("mes") or "").strip()
            if not cid or not mes.isdigit():
                continue
            out.append({
                "comercial_id":  cid,
                "equipo":        (row.get("Equipo") or "").strip(),
                "mes":           int(mes),
                "meta_captacion": (row.get("meta_captacion") or "").strip(),
                "meta_pcv":       (row.get("meta_pcv") or "").strip(),
                "rol":           (row.get("rol") or "").strip(),
                "categoria":     (row.get("Categoria") or "").strip(),
            })
    return out


def _comerciales_activos_inmo_unnest() -> str:
    """SQL UNNEST con los comerciales activos Inmo del CSV.

    Replica el filtro del Looker:
      - 202512/202601: Equipo='Inmobiliaria' AND meta_captacion NOT NULL
      - 202602-202604: meta_pcv NOT NULL (legacy)
      - 202605+:       meta_pcv NOT NULL AND rol='Inmobiliaria'
    """
    rows = _load_metas_comerciales()
    activos = []
    for r in rows:
        mes = r["mes"]
        meta_cap = r["meta_captacion"]
        meta_pcv = r["meta_pcv"]
        rol = r["rol"]
        equipo = r["equipo"]
        is_active = False
        if mes in (202512, 202601) and meta_cap and equipo == "Inmobiliaria":
            is_active = True
        elif 202602 <= mes <= 202604 and meta_pcv:
            is_active = True
        elif mes >= 202605 and meta_pcv and rol == "Inmobiliaria":
            is_active = True
        if is_active:
            activos.append(r)

    if not activos:
        return "SELECT '' AS comercial_id, '' AS Equipo, '' AS Categoria, '' AS rol, 202601 AS mes, DATE '2026-01-01' AS mes_date WHERE FALSE"

    def esc(s: str) -> str:
        return (s or "").replace("\\", "\\\\").replace("'", "\\'")
    structs = []
    for r in activos:
        mes = r["mes"]
        yyyy, mm = mes // 100, mes % 100
        mes_date = f"DATE '{yyyy:04d}-{mm:02d}-01'"
        structs.append(
            f"STRUCT('{esc(r['comercial_id'])}' AS comercial_id, "
            f"'{esc(r['equipo'])}' AS Equipo, "
            f"'{esc(r['categoria'])}' AS Categoria, "
            f"'{esc(r['rol'])}' AS rol, "
            f"{mes} AS mes, "
            f"{mes_date} AS mes_date)"
        )
    return "SELECT * FROM UNNEST([" + ", ".join(structs) + "])"

log = logging.getLogger(__name__)
router = APIRouter()
templates = Jinja2Templates(directory=Path(__file__).parent.parent / "templates")

# (ciclo, asig_start, asig_end, cierre_start, cierre_end)
CYCLE_PERIODS = [
    (2,  "2026-02-26", "2026-03-24", "2026-03-04", "2026-03-31"),
    (3,  "2026-03-25", "2026-04-28", "2026-04-01", "2026-05-05"),
    (4,  "2026-04-29", "2026-05-26", "2026-05-06", "2026-06-02"),
    (5,  "2026-05-27", "2026-06-23", "2026-06-03", "2026-06-30"),
    (6,  "2026-06-24", "2026-07-28", "2026-07-01", "2026-08-04"),
    (7,  "2026-07-29", "2026-08-25", "2026-08-05", "2026-09-01"),
    (8,  "2026-08-26", "2026-09-22", "2026-09-02", "2026-09-29"),
    (9,  "2026-09-23", "2026-10-27", "2026-09-30", "2026-11-03"),
    (10, "2026-10-28", "2026-11-24", "2026-11-04", "2026-12-01"),
    (11, "2026-11-25", "2026-12-22", "2026-12-02", "2026-12-29"),
]
EARLIEST_ASIG = min(p[1] for p in CYCLE_PERIODS)
LATEST_CIERRE = max(p[4] for p in CYCLE_PERIODS)

# (Legacy) Fuentes válidas cuando el denominador MM salía de funnel_diarios_col.
# Ya no se usa: el denominador ahora viene de seguimiento_asignacion_ibuyer_co
# (ver _fetch_mm), que filtra fuente NOT IN (Broker, comercial, Ventana).
ASIG_FUENTES_VALIDAS_MM = ["WEB", "Estudio Inmueble", "CRM", "lead_forms"]

# ── Metas CVR por (equipo, categoría) ────────────────────────────────────────
META_CVR_MM_BOGOTA = {"A": 0.12, "B": 0.04, "C": 0.02}
META_CVR_MM_CIUDADES = {
    "Medellín":     {"A": 0.12, "B": 0.03, "C": 0.03},
    "Cali":         {"A": 0.10, "B": 0.03, "C": 0.03},
    "Barranquilla": {"A": 0.10, "B": 0.03, "C": 0.03},
}
EQUIPOS_BOGOTA_MM = {"Bogotá Norte", "Bogotá Sur"}
META_CVR_INMO = {"A": 0.25, "B": 0.09, "C": 0.046}

# Cuentas que NO son comerciales reales (bots/queue + buffers) — fuente única en accounts.py.
# Las @tuhabi.mx (México) se excluyen aparte por dominio. Los @habi.co sin equipo que
# sobreviven = ex-empleados CO, se muestran como "Sin equipo".
from webapp.accounts import (  # noqa: E402
    MM_BOT_EMAILS, INMO_BOT_EMAILS, BUFFER_EMAILS,
    MM_EXCLUIR_EMAILS, INMO_EXCLUIR_EMAILS, sql_not_in,
)

# ── Filtros del denominador MM (query oficial de Juan, seguimiento_asignacion_ibuyer_co) ──
# Fuentes que NO entran al denominador comercial.
MM_FUENTES_EXCLUIDAS = ["Broker", "comercial", "Ventana"]
# Zonas medianas que NO compramos (zona_mediana_id) — se excluyen de asignados y cierres.
MM_ZONAS_NO_COMPRAMOS = [5418, 5462, 5464, 47, 2279]
# Blacklist de inmuebles (lote_id) que no cuentan en el funnel comercial.
MM_BLACKLIST_LOTE_IDS = [
    1805032, 1720249, 1715504, 1714970, 1704035, 1703723, 1703718, 1702232, 1702125,
    1701484, 1701482, 1700962, 1700322, 1699990, 1699267, 1698865, 1698539, 1696304,
    1696115, 1696097, 1695572, 1695552, 1695506, 1695145, 1695054, 1695009, 1694993,
    1694781, 1694270, 1693883, 1693760, 1693746, 1693624, 1693603, 1693593, 1693482,
    1693347, 1693334, 1693132, 1693131, 1693111, 1693099, 1693037, 1693036, 1693023,
    1693021, 1693018, 1692393, 1692379, 1692247, 1692219, 1692201, 1692198, 1692183,
    1692182, 1691702, 1691639, 1691588, 1691548, 1691165, 1691145, 1691107, 1690943,
    1690879, 1690870, 1690310, 1690183, 1665413, 1636808, 1633459, 1587499, 1584888,
    1582771, 1582455, 1572908, 1567869, 1562361, 1562350, 1562349, 1545499, 1545497,
    1545471, 1528264, 1511780, 1462998, 1451689, 1451664, 1448720, 1446102, 1437353,
    1437174, 1437011, 1428790, 1428789, 1427377, 1425878, 1421416, 1415358, 1415351,
    1415342, 1414067, 1397986, 1377404, 1362499, 1362490, 1359264, 1357414, 1357402,
    1357387, 1354452, 1352986, 1351275, 1339190, 1333870, 1304373, 1298527, 1298472,
    1298396, 1298359, 1294977, 1284315, 1281464, 1281421, 1263808, 1260525, 1260518,
    1254599, 1254594, 1234352, 1221639, 1217202, 1214793, 1208649, 1208589, 1208100,
    1208031, 1207813, 1207789, 1207738, 1207716, 1207567, 1207269, 1201430, 1201335,
    1199818, 1199667, 1199522, 1198813, 1194519, 1192844, 1192826, 1187934, 1186740,
    1186739, 1185930, 1185083, 1184348, 1184177, 1184021, 1184019, 1184012, 1183260,
    1183202, 1182478, 1182475, 1182474, 1182450, 1182449, 1182437, 1182341, 1182324,
    1182286, 1182155, 1182142, 1182131, 1182124, 1182069, 1181709, 1181671, 1181461,
    1181441, 1181326, 1181263, 1180318, 1180135, 1180107, 1180100, 1179995, 1179941,
    1179854, 1179772, 1171329, 1167824, 1167823, 1167822, 1167821, 1167788, 1167776,
    1167763, 1167761, 1167753, 1167712, 1167711, 1167707, 1167706, 1167688, 1167559,
    1167544, 1167543, 1167542, 1167541, 1167539, 1167032, 1167027, 1161764, 1153488,
    1153193, 1153192, 1153190, 1123208, 1073694, 1073693, 1073692, 1073691, 1073690,
    1073689, 1073688, 1073687, 1073686, 1073685, 1073684, 1073683, 1073666, 1073665,
    1073664, 1073662, 1073661, 1073660, 1073659, 1073658, 1073657, 1073655, 1073654,
    1073650, 964135, 964076, 963964, 963936, 963831, 963661, 962756, 942087, 924343,
    924068, 923966, 923103, 921948, 920305, 920092, 911526, 911485, 909625, 896183,
    895361, 894425, 880954, 878959, 877057, 872316, 871631, 871435, 871401, 871274,
    871239, 871230, 871227, 871199, 871156, 871093, 870837, 870732, 870731, 870724,
    870554, 870422, 870249, 870141, 869733, 868610, 868517, 868290, 868276, 867213,
    867192, 865955, 864900, 864899, 864897, 864595, 864529, 864437, 864217, 864201,
    863448, 863242, 862922, 862921, 862918, 861218, 860971, 860933, 860821, 860281,
    859780, 859630, 859629, 834748, 762494, 746952, 745156, 744925, 670376, 665434,
    663730, 642966, 638727, 615879, 587045, 574648, 566624, 549393, 548699, 548323,
    548322, 547715, 547712, 542387, 541833, 541468, 540768, 540230, 540104, 537822,
    536193, 531494, 531493, 524096, 523761, 518906, 518700, 518699, 511834, 507300,
    502214, 472879, 466773, 447236, 445514, 445246, 434446, 433807, 430048, 429669,
    429665, 429124, 428472, 417183, 416320, 410656, 397316, 379986, 379715, 379636,
    379554, 379357, 376905, 376879, 376866, 376821, 298178, 294014, 261062, 233942,
    233934, 231381, 230768, 228450, 224302, 223206, 222961, 219896, 219819, 219508,
    219505, 207980, 178074, 171369, 170794, 162441, 160134, 159705, 159467, 147987,
    132081, 84318, 73910, 73331, 62926, 56298, 55088, 40389, 40253, 37493, 36598,
    34871, 32836, 28630, 26656, 25972, 23761, 21636, 17458, 14889, 13669, 13355,
    12968, 6788, 6704, 4328, 4167, 2440, 743, 650,
]


# ── Pipeline Inmo ────────────────────────────────────────────────────────────
PIPELINE_STAGES_INMO = [
    "1182117549", "1182117546", "1182117545", "1182117550", "1182117547",
    "1182117548", "1182117544", "1182117555", "1182117559", "1182117634",
    "1182117640", "1182117553", "1182117636", "1182117560", "1182117637",
    "1182117638", "1182117554", "1182117558", "1182117561", "1182117635",
    "1182117632", "1182117633", "1182117557", "1182117556", "1182117639",
    "1196757523",
]
STAGE_ID_CAPTADO_INMO = "1182117633"


def _campaign_in(field: str, campaigns: list[str]) -> str:
    """Cláusula `AND TRIM(field) IN (...)` para filtrar por utm_campaign.

    Devuelve '' si no hay campañas seleccionadas (sin filtro). El match se hace
    contra `TRIM(...)` porque las opciones (/campaigns) también salen trimmeadas.
    """
    if not campaigns:
        return ""
    def esc(s: str) -> str:
        return (s or "").replace("\\", "\\\\").replace("'", "\\'")
    lst = ", ".join(f"'{esc(c)}'" for c in campaigns)
    return f"AND TRIM({field}) IN ({lst})"


def _cat_letter(s: str) -> str:
    return (s or "").strip().split()[-1].upper() if s else ""


def _meta_cvr_mm(equipo: str, categoria: str) -> float | None:
    cat = _cat_letter(categoria)
    if cat not in ("A", "B", "C"):
        return None
    if equipo in EQUIPOS_BOGOTA_MM:
        return META_CVR_MM_BOGOTA.get(cat)
    if equipo in META_CVR_MM_CIUDADES:
        return META_CVR_MM_CIUDADES[equipo].get(cat)
    return None


def _meta_cvr_inmo(equipo: str, categoria: str) -> float | None:
    return META_CVR_INMO.get(_cat_letter(categoria))


def _comerciales_unnest() -> str:
    com = bq.load_comerciales()
    if not com:
        return "SELECT '' AS email, '' AS equipo, '' AS categoria WHERE FALSE"
    def esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace("'", "\\'")
    structs = [
        f"STRUCT('{esc(c['email'])}' AS email, '{esc(c['equipo'])}' AS equipo, '{esc(c['categoria'])}' AS categoria)"
        for c in com
    ]
    return "SELECT * FROM UNNEST([" + ", ".join(structs) + "])"


def _cycle_case(field: str, idx_start: int, idx_end: int) -> str:
    """CASE WHEN para mapear DATE(field) → ciclo. idx 1,2 = asig · 3,4 = cierre."""
    cases = []
    for p in CYCLE_PERIODS:
        cases.append(f"WHEN DATE({field}) BETWEEN '{p[idx_start]}' AND '{p[idx_end]}' THEN {p[0]}")
    return "CASE " + " ".join(cases) + " ELSE NULL END"


# ── Página ───────────────────────────────────────────────────────────────────
@router.get("", response_class=HTMLResponse)
def page(request: Request):
    return templates.TemplateResponse("conversion_seller/page.html", {
        "request": request,
        "cycles": CYCLE_PERIODS,
    })


# ── /cycles → períodos ───────────────────────────────────────────────────────
@router.get("/cycles")
def cycles():
    return JSONResponse({
        "periods": [
            {"ciclo": p[0], "asig_start": p[1], "asig_end": p[2],
             "cierre_start": p[3], "cierre_end": p[4]}
            for p in CYCLE_PERIODS
        ],
    })


# ── /campaigns → opciones de utm_campaign ────────────────────────────────────
@router.get("/campaigns")
def campaigns():
    """Lista de utm_campaign presentes en el universo del tab (asignados MM + Inmo).

    Se acota a los nids que aparecen como asignación (MM: seguimiento_asignacion_ibuyer_co;
    Inmo: owner-change en historical) dentro de la ventana de ciclos, para que la lista
    sea relevante a CO y no traiga campañas MX ni deals fuera de scope.
    """
    sql = f"""
    WITH universe AS (
      SELECT nid FROM `sellers-main-prod.bi_co.seguimiento_asignacion_ibuyer_co`
      WHERE DATE(fecha_asignacion) BETWEEN '{EARLIEST_ASIG}' AND '{LATEST_CIERRE}'
      UNION DISTINCT
      SELECT nid FROM `sellers-main-prod.hubspot.historical`
      WHERE propiedad = 'hubspot_owner_id'
        AND DATE(fecha) BETWEEN '{EARLIEST_ASIG}' AND '{LATEST_CIERRE}'
    )
    SELECT DISTINCT TRIM(d.utm_campaign) AS campaign
    FROM `sellers-main-prod.hubspot.deals` d
    JOIN universe u ON u.nid = d.nid
    WHERE d.utm_campaign IS NOT NULL AND TRIM(d.utm_campaign) != ''
    ORDER BY campaign
    """
    rows = bq.query(sql)
    return JSONResponse({"campaigns": [r["campaign"] for r in rows]})


# ── Enriquecimiento fila por seller (compartido por /data y /kpis-compare) ───
def _enrich(rows: list[dict], producto: str) -> list[dict]:
    out = []
    for r in rows:
        equipo = r["equipo_csv"]
        cat = _cat_letter(r["categoria_csv"])
        if producto == "mm":
            meta = _meta_cvr_mm(equipo, cat)
            num = r["cierres_in_cycle"]
        else:
            meta = _meta_cvr_inmo(equipo, cat)
            num = r["captados_in_cycle"]
        asig = r["asignados"]
        cvr = (num / asig) if asig > 0 else None
        if producto == "mm":
            # Categoría del LEAD (del query); "SC" = sin categoría
            asig_cat = {"A": r["asig_a"], "B": r["asig_b"], "C": r["asig_c"], "SC": r["asig_sc"]}
            num_cat  = {"A": r["cie_a"],  "B": r["cie_b"],  "C": r["cie_c"],  "SC": r["cie_sc"]}
        else:
            # Inmo no tiene categoría de lead separada → se atribuye a la del seller
            k = cat if cat in ("A", "B", "C") else "SC"
            asig_cat = {"A": 0, "B": 0, "C": 0, "SC": 0}; asig_cat[k] = asig
            num_cat  = {"A": 0, "B": 0, "C": 0, "SC": 0}; num_cat[k]  = num
        out.append({
            "ciclo":     r["ciclo"],
            "email":     r["owner_email"],
            "equipo":    equipo,
            "categoria": cat,
            "asignados": asig,
            "num":       num,
            "cvr":       cvr,
            "cvr_meta":  meta,
            "asig_cat":  asig_cat,
            "num_cat":   num_cat,
            # Breakdown por prioridad de gestión inmo (solo Inmo; MM = {})
            "asig_prio": r.get("asig_prio", {}),
            "num_prio":  r.get("num_prio", {}),
        })
    return out


# ── /data → rows {mm, inmo} ──────────────────────────────────────────────────
@router.get("/data")
def data(campaign: Annotated[list[str] | None, Query()] = None):
    """Trae las dos series (MM, Inmo) con todos los ciclos.

    `campaign` (repetible) filtra por utm_campaign del deal, aplicado a num y den.
    """
    campaigns = [c for c in (campaign or []) if c]
    return JSONResponse({
        "mm":   _enrich(_fetch_mm(campaigns),   "mm"),
        "inmo": _enrich(_fetch_inmo(campaigns), "inmo"),
    })


# ── /kpis-compare → comparativo cycle-to-date vs ciclo anterior ──────────────
@router.get("/kpis-compare")
def kpis_compare(
    ciclo: Annotated[int, Query()],
    producto: Annotated[str, Query()] = "mm",
    campaign: Annotated[list[str] | None, Query()] = None,
):
    """Filas por-seller del ciclo ANTERIOR, truncadas a los MISMOS días
    transcurridos que el ciclo seleccionado (por ventana: asignación y cierre
    cuentan sus días por separado, ya que arrancan en fechas distintas).

    El frontend les aplica los mismos filtros de tabla (equipo/categoría/comercial/
    búsqueda/prioridad/mín. asignados) y agrega, para que la referencia respete los
    filtros igual que la vista actual.
    """
    campaigns = [c for c in (campaign or []) if c]
    periods = {p[0]: p for p in CYCLE_PERIODS}
    cur = periods.get(ciclo)
    prev = periods.get(ciclo - 1)
    if not cur or not prev:
        return JSONResponse({"prev_ciclo": None, "prev_rows": []})

    today = date.today()
    cur_asig_start   = date.fromisoformat(cur[1])
    cur_cierre_start = date.fromisoformat(cur[3])
    # Días transcurridos por ventana (clamp ≥ 0). Si el ciclo ya terminó, el cap
    # de la ventana previa se recorta a su fin → compara ciclo completo vs completo.
    elapsed_asig   = max((today - cur_asig_start).days, 0)
    elapsed_cierre = max((today - cur_cierre_start).days, 0)

    prev_asig_start   = date.fromisoformat(prev[1])
    prev_asig_end     = date.fromisoformat(prev[2])
    prev_cierre_start = date.fromisoformat(prev[3])
    prev_cierre_end   = date.fromisoformat(prev[4])
    prev_asig_cut   = min(prev_asig_start + timedelta(days=elapsed_asig), prev_asig_end)
    prev_cierre_cut = min(prev_cierre_start + timedelta(days=elapsed_cierre), prev_cierre_end)

    if producto == "mm":
        raw = _fetch_mm(campaigns, prev_asig_cut.isoformat(), prev_cierre_cut.isoformat())
    else:
        raw = _fetch_inmo(campaigns, prev_asig_cut.isoformat(), prev_cierre_cut.isoformat())
    prev_rows = [r for r in _enrich(raw, producto) if r["ciclo"] == ciclo - 1]

    return JSONResponse({
        "producto": producto,
        "ciclo": ciclo,
        "prev_ciclo": ciclo - 1,
        "elapsed_asig_days": elapsed_asig,
        "elapsed_cierre_days": elapsed_cierre,
        "prev_asig_cut": prev_asig_cut.isoformat(),
        "prev_cierre_cut": prev_cierre_cut.isoformat(),
        "prev_rows": prev_rows,
    })


def _fetch_mm(campaigns: list[str] | None = None,
              asig_cutoff: str | None = None,
              cierre_cutoff: str | None = None) -> list[dict]:
    """Throughput MM: asignados (período asig) vs cierres (período cierre).

    Asignados (denominador) = PRIMERA asignación al comercial REAL, desde la fuente
    oficial `seguimiento_asignacion_ibuyer_co` con `tipo_asignacion_comercial =
    'Primer Asignación comercial'`. Esto salta las cuentas bot/queue: si el lead cayó
    primero en un bot, esa columna ya marca como "Primer Asignación comercial" la
    siguiente asignación (al comercial real), cosa que `funnel_diarios_col` no permite
    reconstruir limpio. Filtros oficiales: fuente NOT IN (Broker, comercial, Ventana),
    excluye referidos, blacklist de lote_id y zonas que no compramos.

    Cierres (numerador) = `funnel_diarios_col.valor='Cierre - Comprado'`, atribuido al
    `hubspot_owner_id_historico` (owner al momento del evento, no el actual), con la
    misma exclusión de blacklist/zonas.
    """
    campaigns    = campaigns or []
    asig_case    = _cycle_case("s.fecha_asignacion", 1, 2)
    cierre_case  = _cycle_case("f.fecha", 3, 4)
    bots_lst     = ", ".join(f"'{x}'" for x in MM_EXCLUIR_EMAILS)
    fuentes_excl = ", ".join(f"'{x}'" for x in MM_FUENTES_EXCLUIDAS)
    blacklist    = ", ".join(str(x) for x in sorted(set(MM_BLACKLIST_LOTE_IDS)))
    zonas        = ", ".join(str(x) for x in MM_ZONAS_NO_COMPRAMOS)
    # Filtro utm_campaign: asig ya tiene JOIN a deals (alias d); cierres sale de
    # funnel_diarios_col sin deals → se agrega un JOIN condicional (alias dcam).
    asig_campaign_clause = _campaign_in("d.utm_campaign", campaigns)
    cierre_campaign_join = (
        "LEFT JOIN `sellers-main-prod.hubspot.deals` dcam ON dcam.nid = f.nid"
        if campaigns else ""
    )
    cierre_campaign_clause = _campaign_in("dcam.utm_campaign", campaigns)
    # Corte "a la fecha" (para comparativos cycle-to-date): cap el evento a <= cutoff.
    asig_cutoff_clause   = f"AND DATE(s.fecha_asignacion) <= '{asig_cutoff}'" if asig_cutoff else ""
    cierre_cutoff_clause = f"AND DATE(f.fecha) <= '{cierre_cutoff}'" if cierre_cutoff else ""
    sql = f"""
    WITH comerciales AS ({_comerciales_unnest()}),
    asig_per_seller AS (
      SELECT
        {asig_case} AS ciclo,
        LOWER(s.hubspot_owner_id) AS owner_email,
        COUNT(DISTINCT s.nid) AS asignados,
        -- Breakdown por categoría del LEAD (categoria_comercial del nid)
        COUNT(DISTINCT IF(UPPER(TRIM(s.categoria_comercial))='A', s.nid, NULL)) AS asig_a,
        COUNT(DISTINCT IF(UPPER(TRIM(s.categoria_comercial))='B', s.nid, NULL)) AS asig_b,
        COUNT(DISTINCT IF(UPPER(TRIM(s.categoria_comercial))='C', s.nid, NULL)) AS asig_c,
        COUNT(DISTINCT IF(s.categoria_comercial IS NULL OR UPPER(TRIM(s.categoria_comercial)) NOT IN ('A','B','C'), s.nid, NULL)) AS asig_sc
      FROM `sellers-main-prod.bi_co.seguimiento_asignacion_ibuyer_co` s
      LEFT JOIN `papyrus-data.habi_wh_bi.tabla_inmuebles_general` ig ON ig.nid = s.nid
      LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = s.nid
      WHERE s.tipo_asignacion_comercial = 'Primer Asignación comercial'
        AND DATE(s.fecha_asignacion) BETWEEN '{EARLIEST_ASIG}' AND '{LATEST_CIERRE}'
        AND s.hubspot_owner_id IS NOT NULL
        AND s.hubspot_owner_id != ''
        AND LOWER(s.hubspot_owner_id) NOT IN ({bots_lst})
        AND LOWER(s.hubspot_owner_id) NOT LIKE '%@tuhabi.mx'
        AND s.fuente NOT IN ({fuentes_excl})
        AND d.prioridad_gestion_market_maker IS NOT NULL
        AND d.prioridad_gestion_market_maker != ''
        AND LOWER(IFNULL(ig.campana_mercadeo, '')) NOT LIKE '%referido%'
        AND IFNULL(ig.lote_id, -1) NOT IN ({blacklist})
        AND IFNULL(ig.zona_mediana_id, -1) NOT IN ({zonas})
        {asig_campaign_clause}
        {asig_cutoff_clause}
      GROUP BY 1, 2
      HAVING ciclo IS NOT NULL
    ),
    cierres_nid AS (
      -- Una fila por (ciclo, owner, nid) con UNA categoría (la del cierre más reciente),
      -- para que el breakdown por categoría sume exacto al total de cierres.
      SELECT
        {cierre_case} AS ciclo,
        LOWER(f.hubspot_owner_id_historico) AS owner_email,
        f.nid,
        UPPER(TRIM(f.categoria_comercial)) AS cat
      FROM `papyrus-data.habi_wh_bi.funnel_diarios_col` f
      {cierre_campaign_join}
      WHERE f.valor = 'Cierre - Comprado'
        AND DATE(f.fecha) BETWEEN '{EARLIEST_ASIG}' AND '{LATEST_CIERRE}'
        AND f.hubspot_owner_id_historico IS NOT NULL
        AND f.hubspot_owner_id_historico != ''
        AND LOWER(f.hubspot_owner_id_historico) NOT IN ({bots_lst})
        AND LOWER(f.hubspot_owner_id_historico) NOT LIKE '%@tuhabi.mx'
        {cierre_campaign_clause}
        {cierre_cutoff_clause}
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY {cierre_case}, LOWER(f.hubspot_owner_id_historico), f.nid
        ORDER BY f.fecha DESC
      ) = 1
    ),
    cierres_per_seller AS (
      -- Numerador: TODOS los cierres reales (no se aplica blacklist/zonas aquí, solo
      -- al denominador — decisión de Juan 2026-06-01: no penalizar un cierre logrado).
      SELECT
        ciclo,
        owner_email,
        COUNT(*) AS cierres,
        COUNTIF(cat = 'A') AS cie_a,
        COUNTIF(cat = 'B') AS cie_b,
        COUNTIF(cat = 'C') AS cie_c,
        COUNTIF(cat IS NULL OR cat NOT IN ('A','B','C')) AS cie_sc
      FROM cierres_nid
      GROUP BY 1, 2
      HAVING ciclo IS NOT NULL
    )
    SELECT
      COALESCE(a.ciclo, c.ciclo) AS ciclo,
      COALESCE(a.owner_email, c.owner_email) AS owner_email,
      COALESCE(co.equipo, '')    AS equipo_csv,
      COALESCE(co.categoria, '') AS categoria_csv,
      COALESCE(a.asignados, 0) AS asignados,
      COALESCE(c.cierres,   0) AS cierres_in_cycle,
      COALESCE(a.asig_a, 0) AS asig_a, COALESCE(a.asig_b, 0) AS asig_b,
      COALESCE(a.asig_c, 0) AS asig_c, COALESCE(a.asig_sc, 0) AS asig_sc,
      COALESCE(c.cie_a, 0) AS cie_a, COALESCE(c.cie_b, 0) AS cie_b,
      COALESCE(c.cie_c, 0) AS cie_c, COALESCE(c.cie_sc, 0) AS cie_sc
    FROM asig_per_seller a
    FULL OUTER JOIN cierres_per_seller c
      ON a.ciclo = c.ciclo AND a.owner_email = c.owner_email
    LEFT JOIN comerciales co ON co.email = COALESCE(a.owner_email, c.owner_email)
    """
    rows = bq.query(sql)
    int_cols = ("asignados", "cierres_in_cycle", "asig_a", "asig_b", "asig_c",
                "asig_sc", "cie_a", "cie_b", "cie_c", "cie_sc")
    for r in rows:
        r["ciclo"] = int(r["ciclo"])
        for col in int_cols:
            r[col] = int(r[col])
    return rows


def _fetch_inmo(campaigns: list[str] | None = None,
                asig_cutoff: str | None = None,
                cierre_cutoff: str | None = None) -> list[dict]:
    """Throughput Inmo: Asignados (denominador) + Captados (numerador).

    - Asignados: fuente OFICIAL `bi_co.tablero_asignacion_inmo_col` (1 fila/nid, con
      fecha_primera_asignacion, comercial_asignado, equipo, categoria, prioridad_inmo).
      Ciclo por fecha_primera_asignacion; excluye bots/buffers, MX y nids sin prioridad.
    - Captados: eventos dealstage=captado en `historical`, atribuidos al owner del deal.
    """
    campaigns = campaigns or []
    pipeline_list = ", ".join(f'"{s}"' for s in PIPELINE_STAGES_INMO)
    asig_case   = _cycle_case("t.fecha_primera_asignacion", 1, 2)
    cierre_case = _cycle_case("h.fecha", 3, 4)
    bots_inmo   = ", ".join(f"'{e}'" for e in INMO_EXCLUIR_EMAILS)
    cap_campaign_clause = _campaign_in("d.utm_campaign", campaigns)
    # Campaña en asignados: el tablero no une deals → semi-join a los nids con esa utm_campaign.
    asig_campaign_clause = (
        f"AND t.nid IN (SELECT nid FROM `sellers-main-prod.hubspot.deals` d2 "
        f"WHERE TRUE {_campaign_in('d2.utm_campaign', campaigns)})"
        if campaigns else ""
    )
    # Corte "a la fecha" (comparativos cycle-to-date): cap el evento a <= cutoff.
    asig_cutoff_clause   = f"AND DATE(t.fecha_primera_asignacion) <= '{asig_cutoff}'" if asig_cutoff else ""
    cierre_cutoff_clause = f"AND DATE(h.fecha) <= '{cierre_cutoff}'" if cierre_cutoff else ""

    sql = f"""
    WITH comerciales AS ({_comerciales_unnest()}),
    -- Asignados (denominador): fuente OFICIAL tablero_asignacion_inmo_col (1 fila/nid).
    -- Ciclo por fecha_primera_asignacion; excluye bots/buffers y cuentas MX.
    -- ⚠️ Solo cuenta asignaciones CONSISTENTES (asignacion_consistente = TRUE): el flag
    -- oficial del tablero (asignación en el mismo mes de la prioridad). Sin él se cuelan
    -- reasignaciones inconsistentes y el total no cuadra con el reporte comercial.
    asig_per_seller AS (
      SELECT
        {asig_case} AS ciclo,
        LOWER(t.comercial_asignado)               AS owner_email,
        COALESCE(t.prioridad_de_gestion_inmo, '') AS prioridad,
        ANY_VALUE(t.equipo)                       AS equipo_src,
        ANY_VALUE(t.categoria)                    AS categoria_src,
        COUNT(DISTINCT t.nid)                     AS asignados
      FROM `sellers-main-prod.bi_co.tablero_asignacion_inmo_col` t
      WHERE t.comercial_asignado IS NOT NULL AND t.comercial_asignado != ''
        AND LOWER(t.comercial_asignado) NOT IN ({bots_inmo})
        AND LOWER(t.comercial_asignado) NOT LIKE '%@tuhabi.mx'
        AND t.asignacion_consistente = TRUE
        {asig_campaign_clause}
        {asig_cutoff_clause}
      GROUP BY 1, 2, 3
      HAVING ciclo IS NOT NULL
    ),
    historical_inmo AS (
      SELECT h.nid, h.fecha, h.valor AS stage_id
      FROM `sellers-main-prod.hubspot.historical` h
      WHERE h.propiedad = 'dealstage'
        AND h.valor IN ({pipeline_list})
        AND DATE(h.fecha) BETWEEN '{EARLIEST_ASIG}' AND '{LATEST_CIERRE}'
        {cierre_cutoff_clause}
    ),
    captados_per_seller AS (
      SELECT
        {cierre_case} AS ciclo,
        LOWER(d.hubspot_owner_id) AS owner_email,
        COALESCE(d.prioridad_de_gestion_inmo, '') AS prioridad,
        COUNT(DISTINCT h.nid) AS captados
      FROM historical_inmo h
      LEFT JOIN `sellers-main-prod.hubspot.deals` d ON d.nid = h.nid
      WHERE h.stage_id = '{STAGE_ID_CAPTADO_INMO}'
        AND {sql_not_in("d.hubspot_owner_id", INMO_EXCLUIR_EMAILS)}
        {cap_campaign_clause}
      GROUP BY 1, 2, 3
      HAVING ciclo IS NOT NULL AND owner_email IS NOT NULL AND owner_email != ''
    )
    SELECT
      COALESCE(a.ciclo, c.ciclo)             AS ciclo,
      COALESCE(a.owner_email, c.owner_email) AS owner_email,
      COALESCE(a.prioridad, c.prioridad, '') AS prioridad,
      -- Equipo/Categoría: comerciales.csv (foto actual con "Inmobiliaria 1" / "2") sobre metas (que tiene "Inmobiliaria" genérico para periodos viejos)
      COALESCE(NULLIF(co.equipo, ''), a.equipo_src, '')    AS equipo_csv,
      COALESCE(NULLIF(co.categoria, ''), a.categoria_src, '') AS categoria_csv,
      COALESCE(a.asignados, 0)               AS asignados,
      COALESCE(c.captados,  0)               AS captados_in_cycle
    FROM asig_per_seller a
    FULL OUTER JOIN captados_per_seller c
      ON a.ciclo = c.ciclo AND a.owner_email = c.owner_email AND a.prioridad = c.prioridad
    LEFT JOIN comerciales co ON co.email = COALESCE(a.owner_email, c.owner_email)
    """
    rows = bq.query(sql)
    # El query devuelve grano (ciclo, seller, prioridad). Se pivotea a una fila por
    # (ciclo, seller) con breakdown por prioridad (asig_prio/num_prio) para poder
    # filtrar por prioridad de gestión inmo en el frontend.
    agg: dict[tuple[int, str], dict] = {}
    for r in rows:
        ciclo = int(r["ciclo"])
        email = r["owner_email"]
        prio = (r.get("prioridad") or "").strip() or "Sin prioridad"
        asig = int(r["asignados"])
        cap = int(r["captados_in_cycle"])
        key = (ciclo, email)
        a = agg.get(key)
        if a is None:
            a = agg[key] = {
                "ciclo": ciclo,
                "owner_email": email,
                "equipo_csv": r.get("equipo_csv") or "",
                "categoria_csv": r.get("categoria_csv") or "",
                "asignados": 0,
                "captados_in_cycle": 0,
                "asig_prio": {},
                "num_prio": {},
            }
        a["asignados"] += asig
        a["captados_in_cycle"] += cap
        if asig:
            a["asig_prio"][prio] = a["asig_prio"].get(prio, 0) + asig
        if cap:
            a["num_prio"][prio] = a["num_prio"].get(prio, 0) + cap
        if not a["equipo_csv"] and r.get("equipo_csv"):
            a["equipo_csv"] = r["equipo_csv"]
        if not a["categoria_csv"] and r.get("categoria_csv"):
            a["categoria_csv"] = r["categoria_csv"]
    return list(agg.values())
