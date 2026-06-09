"""Parser y modelo de metas MM.

Lee el CSV de metas y replica el modelo de:
- Asignados por zona  → meta base
- Aplica share por categoría (A/B/C)
- Aplica CVRs encadenados por (región, categoría)
- Devuelve metas por etapa × bucket × (ciclo-week)

bucket ∈ {Total, A, B, C, Norte, Sur, Medellin, Cali, Barranquilla, Centro}
"""
from __future__ import annotations

import csv as csvmod
from pathlib import Path

ROOT = Path(__file__).parent.parent
CSV_FILE = ROOT / "mm 2030 Sellers interno - MM Col Ciclos Todo el Funnel (Ciudades y equipos).csv"

# Zona del CSV → equipo (comerciales.csv / agrupación)
ZONA_TO_EQUIPO = {
    "Norte":        "Bogotá Norte",
    "Sur":          "Bogotá Sur",
    "Medellin":     "Medellín",
    "Cali":         "Cali",
    "Barranquilla": "Barranquilla",
}

META_ETAPA_TO_BQ = {
    "Asignados": ["Primer_asigancion"],
    "Agendas":   ["Cita agendada"],
    "Visitas":   ["Visita efectuada"],
    "Comites":   ["pre-comité validado"],
    "Aprobados": ["Aprobado"],
    "Cierres":   ["Cierre - Comprado"],
}

ETAPAS_ORDER = ["Asignados", "Agendas", "Visitas", "Comites", "Aprobados", "Cierres"]

CAT_SHARE = {"A": 0.25, "B": 0.43, "C": 0.32}

# CVRs encadenados: Asig→Agenda, Agenda→Visita, Visita→Comité, Comité→Aprobado, Aprobado→Cierre
CVR_BY_REGION = {
    "Bogotá": {
        "A": (0.6326, 0.7263, 0.9113, 0.7000, 0.3987),
        "B": (0.3415, 0.7842, 0.9113, 0.6000, 0.3154),
        "C": (0.2460, 0.7419, 0.8696, 0.5000, 0.2000),
    },
    "Ciudades": {
        "A": (0.6783, 0.7320, 0.8438, 0.7263, 0.3333),
        "B": (0.2914, 0.7711, 0.8438, 0.7778, 0.3333),
        "C": (0.1586, 0.8372, 0.8333, 0.7381, 0.1250),
    },
}

ZONA_TO_REGION = {
    "Norte":        "Bogotá",
    "Sur":          "Bogotá",
    "Medellin":     "Ciudades",
    "Cali":         "Ciudades",
    "Barranquilla": "Ciudades",
}


def _parse_val(s: str | None) -> int | None:
    s = (s or "").strip().replace(",", "").replace('"', "")
    if not s or s.startswith("#"):
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def _compute_cat_metas(metas: dict) -> None:
    """Inyecta metas por categoría A/B/C derivadas del modelo."""
    asig = metas.get("Asignados", {})
    if not asig:
        return
    zonas = list(ZONA_TO_REGION.keys())
    all_keys: set[str] = set()
    for z in zonas:
        if z in asig:
            all_keys.update(asig[z].keys())

    for etapa_idx, etapa in enumerate(ETAPAS_ORDER):
        if etapa not in metas:
            continue
        for cat in ("A", "B", "C"):
            metas[etapa][cat] = {}
        total_dict = metas[etapa].get("Total", {})

        for wk in all_keys:
            raw = {"A": 0.0, "B": 0.0, "C": 0.0}
            for zona in zonas:
                asig_z = asig.get(zona, {}).get(wk)
                if asig_z is None:
                    continue
                region = ZONA_TO_REGION[zona]
                cvrs_by_cat = CVR_BY_REGION[region]
                for cat in ("A", "B", "C"):
                    asig_zc = asig_z * CAT_SHARE[cat]
                    factor = 1.0
                    if etapa_idx > 0:
                        cvrs = cvrs_by_cat[cat]
                        for k in range(etapa_idx):
                            factor *= cvrs[k]
                    raw[cat] += asig_zc * factor

            sum_raw = raw["A"] + raw["B"] + raw["C"]
            total_csv = total_dict.get(wk)
            if total_csv and sum_raw > 0:
                scale = total_csv / sum_raw
                scaled = {c: raw[c] * scale for c in ("A", "B", "C")}
                rounded = {c: int(scaled[c]) for c in ("A", "B", "C")}
                drift = total_csv - sum(rounded.values())
                fracs = sorted(("A", "B", "C"), key=lambda c: -(scaled[c] - rounded[c]))
                for i in range(int(drift)):
                    rounded[fracs[i % 3]] += 1
                for cat in ("A", "B", "C"):
                    metas[etapa][cat][wk] = rounded[cat]
            else:
                for cat in ("A", "B", "C"):
                    metas[etapa][cat][wk] = round(raw[cat])


_cached_metas: dict | None = None


def reset_cache() -> None:
    """Invalida la caché de metas para forzar re-lectura del CSV (tras actualizarlo)."""
    global _cached_metas
    _cached_metas = None


def load_metas() -> dict:
    """Devuelve {etapa: {bucket: {'ciclo-week': int}}}.

    Cache simple: solo se lee el CSV una vez por proceso.
    """
    global _cached_metas
    if _cached_metas is not None:
        return _cached_metas

    if not CSV_FILE.exists():
        _cached_metas = {}
        return _cached_metas

    rows: list[list[str]] = []
    with CSV_FILE.open(encoding="utf-8") as f:
        for r in csvmod.reader(f):
            rows.append(r)
    if len(rows) < 4:
        _cached_metas = {}
        return _cached_metas

    ciclo_row, week_row = rows[1], rows[2]
    col_to_cw: dict[int, tuple[int, int]] = {}
    for i in range(1, max(len(ciclo_row), len(week_row))):
        c = (ciclo_row[i] if i < len(ciclo_row) else "").strip()
        w = (week_row[i]  if i < len(week_row)  else "").strip()
        if c.isdigit() and w.isdigit():
            col_to_cw[i] = (int(c), int(w))

    ETAPAS_LBL = set(META_ETAPA_TO_BQ.keys())
    ZONAS = set(ZONA_TO_EQUIPO.keys()) | {"Centro"}
    CATS = {"A", "B", "C"}

    metas: dict = {}
    current: str | None = None
    for row in rows[3:]:
        if not row or not (row[0] or "").strip():
            continue
        label = row[0].strip()
        bucket: str | None = None
        if label in ETAPAS_LBL:
            current = label
            metas[current] = {"Total": {}}
            bucket = "Total"
        elif current and label in ZONAS and label not in metas[current]:
            metas[current][label] = {}
            bucket = label
        elif current == "Cierres" and label in CATS and label not in metas[current]:
            metas[current][label] = {}
            bucket = label
        if bucket is None:
            continue
        for i, cw in col_to_cw.items():
            if i >= len(row):
                continue
            v = _parse_val(row[i])
            if v is not None:
                metas[current][bucket][f"{cw[0]}-{cw[1]}"] = v

    _compute_cat_metas(metas)
    _cached_metas = metas
    return metas
