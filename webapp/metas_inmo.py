"""Modelo de metas Inmo Ciclo 5 (junio 2026) — Escenario A "Refrescado mayo".

Portado de reports/funnel_inmo/update.py:compute_metas_inmo. Inputs de referencia
= split de ciudad + CVRs del funnel de MAYO 2026 (mes limpio, sin incidente 7-abr),
para proyectar las metas de junio. Equivale al Escenario A de
reports/metas_inmo_ciclo5/build.py (≈412 captaciones).

Devuelve {etapa: {bucket: {'ciclo-week': valor}}}.
bucket ∈ {Total, A, B, C, Inmobiliaria 1, Inmobiliaria 2, Medellín, Cali, Barranquilla}.

⚠️ El modelo emite UN solo ciclo (CICLO_DEFAULT). Al pasar de ciclo hay que
refrescar CICLO_DEFAULT + los inputs de referencia (split + CVRs), o las metas
del nuevo ciclo saldrán vacías en el webapp.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).parent.parent
BAD_CAPTADOS_CSV = ROOT / "[CO] Corrección Incidente 7 abr Leads Inmo - bquxjob_41c0d194_19d68c1efbf.csv"

# ── Constantes del modelo (Escenario A · referencia mayo 2026) ───────────────
LEADS_TOTAL = 6500
# Asignados por área metropolitana, mayo 2026 ('Valle de Aburrá' → Medellín).
MAYO_ASIG   = {"Bogotá": 4261, "Medellín": 811, "Barranquilla": 330, "Cali": 519}
CAT_SHARE   = {"A": 0.0486, "B": 0.2757, "C": 0.6757}
CAT_CVR     = {"A": 0.25,   "B": 0.09,   "C": 0.046}
FLAT_CVR_EQ = {"Cali": 0.06, "Barranquilla": 0.067, "Medellín": 0.04}

# CVRs del funnel — mayo 2026 (nids por etapa: asignados=8.946 · perfilados=3.202 ·
# aprobado=1.312 · ofertado=1.128 · aceptada=659 · captado=427).
HISTORICAL_CVRS = {
    "asig_to_perf":   3202 / 8946,
    "perf_to_aprob":  1312 / 3202,
    "aprob_to_ofert": 1128 / 1312,
    "ofert_to_ace":   659  / 1128,
    "ace_to_cap":     427  / 659,
}

TARGET_EQUIPOS = ["Inmobiliaria 1", "Inmobiliaria 2", "Medellín", "Cali", "Barranquilla"]
EQUIPO_CIUDAD  = {
    "Inmobiliaria 1": "Bogotá", "Inmobiliaria 2": "Bogotá",
    "Medellín": "Medellín", "Cali": "Cali", "Barranquilla": "Barranquilla",
}

CICLO_DEFAULT = 5
N_SEMANAS_DEFAULT = 4

ETAPAS_ORDER = ["Asignados", "Perfilados", "Aprobados", "Ofertados", "Aceptadas", "Captados"]

# Mapeo etapa (display) → stage key del historical
META_ETAPA_TO_BQ = {
    "Asignados":  ["asignados"],
    "Perfilados": ["perfilados"],
    "Aprobados":  ["aprobado"],
    "Ofertados":  ["ofertado"],
    "Aceptadas":  ["oferta aceptada"],
    "Captados":   ["captado"],
}


def _cat_letter(categoria: str) -> str:
    return (categoria or "").strip().split()[-1].upper()


_cached: dict | None = None


def reset_cache() -> None:
    """Invalida la caché de metas Inmo (modelo calculado) para forzar recálculo."""
    global _cached
    _cached = None


def load_metas(comerciales: list[dict]) -> dict:
    """Calcula metas semanales por etapa para Ciclo 4. Recibe la lista de comerciales del CSV."""
    global _cached
    if _cached is not None:
        return _cached

    # 1) Inmo people del CSV (categoría empieza con "Inmobiliaria" y equipo target)
    people = [c for c in comerciales
              if (c.get("categoria","").startswith("Inmobiliaria")) and c.get("equipo") in TARGET_EQUIPOS]

    # 2) Leads por ciudad según mix mayo (escenario A)
    total_hist = sum(MAYO_ASIG.values())
    ciudad_leads = {c: LEADS_TOTAL * v / total_hist for c, v in MAYO_ASIG.items()}

    # 3) Personas por equipo y categoría
    n_by_eq_cat = {eq: {"A": 0, "B": 0, "C": 0} for eq in TARGET_EQUIPOS}
    for p in people:
        c = _cat_letter(p["categoria"])
        if c in ("A", "B", "C"):
            n_by_eq_cat[p["equipo"]][c] += 1

    # 4) Leads por (equipo, categoría)
    leads_by_eq_cat = {eq: {"A": 0.0, "B": 0.0, "C": 0.0} for eq in TARGET_EQUIPOS}
    # Bogotá: round-robin Inmo1/Inmo2 por categoría
    bog_leads = ciudad_leads["Bogotá"]
    for cat in ("A", "B", "C"):
        cat_leads_bog = bog_leads * CAT_SHARE[cat]
        n1 = n_by_eq_cat["Inmobiliaria 1"][cat]
        n2 = n_by_eq_cat["Inmobiliaria 2"][cat]
        ntot = n1 + n2
        if ntot == 0:
            leads_by_eq_cat["Inmobiliaria 1"][cat] = cat_leads_bog / 2
            leads_by_eq_cat["Inmobiliaria 2"][cat] = cat_leads_bog / 2
        else:
            leads_by_eq_cat["Inmobiliaria 1"][cat] = cat_leads_bog * n1 / ntot
            leads_by_eq_cat["Inmobiliaria 2"][cat] = cat_leads_bog * n2 / ntot
    # Otras ciudades: mix global
    for eq in ["Cali", "Barranquilla", "Medellín"]:
        cl = ciudad_leads[EQUIPO_CIUDAD[eq]]
        for cat in ("A", "B", "C"):
            leads_by_eq_cat[eq][cat] = cl * CAT_SHARE[cat]

    leads_by_eq  = {eq: sum(leads_by_eq_cat[eq].values()) for eq in TARGET_EQUIPOS}
    leads_by_cat = {c: sum(leads_by_eq_cat[eq][c] for eq in TARGET_EQUIPOS) for c in ("A", "B", "C")}

    # 5) Captaciones por (eq, cat) usando CVR flat por equipo o por categoría
    captaciones_by_eq: dict[str, float] = {}
    captaciones_by_cat: dict[str, float] = {"A": 0.0, "B": 0.0, "C": 0.0}
    for eq in TARGET_EQUIPOS:
        flat = FLAT_CVR_EQ.get(eq)
        total = 0.0
        for cat in ("A", "B", "C"):
            cvr = flat if flat is not None else CAT_CVR[cat]
            cap = leads_by_eq_cat[eq][cat] * cvr
            total += cap
            captaciones_by_cat[cat] += cap
        captaciones_by_eq[eq] = total

    # 6) Factor de chain (etapa intermedia)
    h = HISTORICAL_CVRS
    factor = {
        "Asignados":  1.0,
        "Perfilados": h["asig_to_perf"],
        "Aprobados":  h["asig_to_perf"] * h["perf_to_aprob"],
        "Ofertados":  h["asig_to_perf"] * h["perf_to_aprob"] * h["aprob_to_ofert"],
        "Aceptadas":  h["asig_to_perf"] * h["perf_to_aprob"] * h["aprob_to_ofert"] * h["ofert_to_ace"],
    }

    metas: dict = {}
    nw, ciclo = N_SEMANAS_DEFAULT, CICLO_DEFAULT

    def put(etapa: str, bucket: str, total_value: float) -> None:
        weekly = total_value / nw
        metas.setdefault(etapa, {}).setdefault(bucket, {})
        for w in range(1, nw + 1):
            metas[etapa][bucket][f"{ciclo}-{w}"] = round(weekly, 2)

    # Etapas derivadas de Asignados con factor
    for etapa, f in factor.items():
        put(etapa, "Total", LEADS_TOTAL * f)
        for eq in TARGET_EQUIPOS:
            put(etapa, eq, leads_by_eq[eq] * f)
        for cat in ("A", "B", "C"):
            put(etapa, cat, leads_by_cat[cat] * f)

    # Captados: usa CVR ajustado (no chain)
    total_cap = sum(captaciones_by_eq.values())
    put("Captados", "Total", total_cap)
    for eq in TARGET_EQUIPOS:
        put("Captados", eq, captaciones_by_eq[eq])
    for cat in ("A", "B", "C"):
        put("Captados", cat, captaciones_by_cat[cat])

    _cached = metas
    return metas


def load_bad_captados_nids() -> list[str]:
    """Lee la lista de nids del incidente 7-abr para excluir/incluir vía toggle UI."""
    if not BAD_CAPTADOS_CSV.exists():
        return []
    nids: list[str] = []
    with BAD_CAPTADOS_CSV.open() as f:
        next(f)  # header
        for line in f:
            nid = line.split(",")[0].strip()
            if nid and nid.isdigit():
                nids.append(nid)
    return nids
