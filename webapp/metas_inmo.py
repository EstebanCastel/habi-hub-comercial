"""Metas Inmo Ciclo 6 (Julio 2026) — valores explícitos de la planeación.

Antes esto era un modelo calculado (CVR × leads). Ahora las metas vienen dadas
directo del plan comercial (artifact "Metas Inmo · Ciclo 6", tabla `WEEKLY_METAS`
con valores SEMANALES por etapa y equipo), así que solo se replican por las 4
semanas del ciclo. El desglose por categoría A/B/C se omite por ahora (el plan no
lo trae) → el toggle "Categoría" del tablero no mostrará línea de meta.

Devuelve {etapa: {bucket: {'ciclo-week': valor}}}.
bucket ∈ {Total, Inmobiliaria 1, Inmobiliaria 2, Medellín, Cali, Barranquilla}.

⚠️ El webapp usa el calendario compartido (`comercial_cycles.json`) donde
Julio = Ciclo 6, y el tablero Inmo auto-selecciona el ciclo por fecha. Por eso
estas metas se emiten bajo CICLO (=6), aunque el plan Inmo las numere "Ciclo 5".
Al pasar de ciclo hay que refrescar CICLO + N_SEMANAS + WEEKLY_METAS.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).parent.parent
BAD_CAPTADOS_CSV = ROOT / "[CO] Corrección Incidente 7 abr Leads Inmo - bquxjob_41c0d194_19d68c1efbf.csv"

CICLO = 6
N_SEMANAS = 4

TARGET_EQUIPOS = ["Inmobiliaria 1", "Inmobiliaria 2", "Medellín", "Cali", "Barranquilla"]

ETAPAS_ORDER = ["Asignados", "Perfilados", "Aprobados", "Ofertados", "Aceptadas", "Captados"]

# Mapeo etapa (display) → stage key del historical / base_cte
META_ETAPA_TO_BQ = {
    "Asignados":  ["asignados"],
    "Perfilados": ["perfilados"],
    "Aprobados":  ["aprobado"],
    "Ofertados":  ["ofertado"],
    "Aceptadas":  ["oferta aceptada"],
    "Captados":   ["captado"],
}

# ── Metas SEMANALES Ciclo 6 (Julio 2026) ─────────────────────────────────────
# Valores por semana (idénticos las 4 semanas). Total ciclo = valor × 4.
WEEKLY_METAS: dict[str, dict[str, int]] = {
    "Asignados":  {"Total": 1500, "Inmobiliaria 1": 557, "Inmobiliaria 2": 556,
                   "Medellín": 147, "Cali": 118, "Barranquilla": 121},
    "Perfilados": {"Total": 856,  "Inmobiliaria 1": 293, "Inmobiliaria 2": 292,
                   "Medellín": 137, "Cali": 67,  "Barranquilla": 67},
    "Aprobados":  {"Total": 333,  "Inmobiliaria 1": 120, "Inmobiliaria 2": 119,
                   "Medellín": 51,  "Cali": 22,  "Barranquilla": 20},
    "Ofertados":  {"Total": 309,  "Inmobiliaria 1": 118, "Inmobiliaria 2": 118,
                   "Medellín": 26,  "Cali": 24,  "Barranquilla": 23},
    "Aceptadas":  {"Total": 173,  "Inmobiliaria 1": 64,  "Inmobiliaria 2": 64,
                   "Medellín": 17,  "Cali": 13,  "Barranquilla": 15},
    "Captados":   {"Total": 98,   "Inmobiliaria 1": 38,  "Inmobiliaria 2": 39,
                   "Medellín": 6,   "Cali": 7,   "Barranquilla": 8},
}


_cached: dict | None = None


def reset_cache() -> None:
    """Invalida la caché de metas Inmo para forzar recálculo."""
    global _cached
    _cached = None


def load_metas(comerciales: list[dict] | None = None) -> dict:
    """Devuelve {etapa: {bucket: {'ciclo-week': valor}}} para el Ciclo 6.

    `comerciales` se ignora (se mantiene por compatibilidad con los callers).
    """
    global _cached
    if _cached is not None:
        return _cached

    metas: dict = {}
    week_keys = [f"{CICLO}-{w}" for w in range(1, N_SEMANAS + 1)]

    for etapa, buckets in WEEKLY_METAS.items():
        metas[etapa] = {}
        # Total + equipos: valor semanal directo del plan (categorías omitidas)
        for bucket, val in buckets.items():
            metas[etapa][bucket] = {wk: val for wk in week_keys}

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
