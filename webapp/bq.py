"""Cliente BigQuery con caché en memoria (TTL)."""
from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
from typing import Any

from cachetools import TTLCache
from google.cloud import bigquery

log = logging.getLogger(__name__)

# Default project (Habi MM data)
DEFAULT_PROJECT = os.getenv("BQ_PROJECT", "papyrus-data")

# Cache: 500 queries simultáneas, 2 horas TTL.
# Los usuarios pueden forzar refresh manual con el botón "Actualizar" del tablero
# (que llama a /admin/cache/clear y vuelve a pedir los datos).
_cache: TTLCache = TTLCache(maxsize=500, ttl=7200)

_client: bigquery.Client | None = None


def get_client() -> bigquery.Client:
    """Cliente BQ singleton — usa ADC (Application Default Credentials)."""
    global _client
    if _client is None:
        _client = bigquery.Client(project=DEFAULT_PROJECT)
    return _client


def _key(sql: str) -> str:
    return hashlib.md5(sql.encode("utf-8")).hexdigest()


def query(sql: str, *, use_cache: bool = True) -> list[dict]:
    """Ejecuta una query y devuelve list[dict]. Cacheada por hash del SQL (5 min)."""
    k = _key(sql)
    if use_cache and k in _cache:
        log.debug(f"BQ cache hit ({k[:8]})")
        return _cache[k]
    log.info(f"BQ query ({k[:8]}) — len={len(sql)}")
    client = get_client()
    rows = [dict(r) for r in client.query(sql).result()]
    # Convertir dates/datetimes a strings para JSON serializability
    for r in rows:
        for k2, v in list(r.items()):
            if hasattr(v, "isoformat"):
                r[k2] = v.isoformat()
    if use_cache:
        _cache[k] = rows
    return rows


def cache_clear() -> int:
    """Vacía el caché. Devuelve cantidad de entradas borradas."""
    n = len(_cache)
    _cache.clear()
    return n


# ── Helpers para cargar metadata estática ────────────────────────────────────
ROOT = Path(__file__).parent.parent
CYCLES_FILE = ROOT / "reports" / "comercial_cycles.json"
COMERCIALES_CSV = ROOT / "comerciales.csv"


def load_cycles() -> list[dict]:
    return json.loads(CYCLES_FILE.read_text(encoding="utf-8"))


_MESES_ABBR = ["ene", "feb", "mar", "abr", "may", "jun",
               "jul", "ago", "sep", "oct", "nov", "dic"]


def cycle_label(c: dict) -> str:
    """Etiqueta corta de un ciclo comercial (ej. 'C06 · Jul 26')."""
    mes_short = str(c["mes"])[:3].capitalize()
    return f"C{c['ciclo']:02d} · {mes_short} {str(c['year'])[2:]}"


def kpi_windows(granularidad: str, hoy=None) -> dict:
    """Ventanas 'actual' vs 'anterior' para los KPIs (comparación a-la-fecha).

    - Calendario (mes/semana/dia): mes actual (días 1..hoy) vs los mismos días del
      mes anterior (MTD).
    - Comercial (mes_com/sem_com): ciclo actual desde su inicio hasta hoy vs los mismos
      días transcurridos del ciclo anterior (ciclo-a-la-fecha, CTD).

    Devuelve fechas ISO de ambas ventanas + labels + dia_corte + modo ('mes'|'ciclo').
    """
    from datetime import date as _date, timedelta
    hoy = hoy or _date.today()

    if granularidad in ("mes_com", "sem_com"):
        cycles = load_cycles()
        # Ciclo en curso (inicio <= hoy <= fin); si hoy cae fuera, el último ya iniciado.
        cur_idx = next((i for i, c in enumerate(cycles)
                        if c["inicio"] <= hoy.isoformat() <= c["fin"]), None)
        if cur_idx is None:
            past = [i for i, c in enumerate(cycles) if c["inicio"] <= hoy.isoformat()]
            cur_idx = past[-1] if past else 0
        cur = cycles[cur_idx]
        inicio_actual = _date.fromisoformat(cur["inicio"])
        fin_actual = min(hoy, _date.fromisoformat(cur["fin"]))
        offset = (fin_actual - inicio_actual).days  # días transcurridos (0-based)
        if cur_idx > 0:
            prev = cycles[cur_idx - 1]
            inicio_anterior = _date.fromisoformat(prev["inicio"])
            fin_anterior = min(inicio_anterior + timedelta(days=offset),
                               _date.fromisoformat(prev["fin"]))
            label_anterior = cycle_label(prev)
        else:
            # No hay ciclo previo → ventana vacía (anterior = 0, sin delta)
            inicio_anterior = inicio_actual
            fin_anterior = inicio_actual - timedelta(days=1)
            label_anterior = "—"
        return {
            "inicio_actual": inicio_actual.isoformat(),
            "fin_actual": fin_actual.isoformat(),
            "inicio_anterior": inicio_anterior.isoformat(),
            "fin_anterior": fin_anterior.isoformat(),
            "label_actual": cycle_label(cur),
            "label_anterior": label_anterior,
            "dia_corte": offset + 1,
            "modo": "ciclo",
        }

    # Calendario (MTD)
    inicio_actual = hoy.replace(day=1)
    inicio_anterior = (inicio_actual - timedelta(days=1)).replace(day=1)
    fin_anterior = inicio_anterior + (hoy - inicio_actual)
    return {
        "inicio_actual": inicio_actual.isoformat(),
        "fin_actual": hoy.isoformat(),
        "inicio_anterior": inicio_anterior.isoformat(),
        "fin_anterior": fin_anterior.isoformat(),
        "label_actual": f"{_MESES_ABBR[inicio_actual.month - 1]} {inicio_actual.year}",
        "label_anterior": f"{_MESES_ABBR[inicio_anterior.month - 1]} {inicio_anterior.year}",
        "dia_corte": hoy.day,
        "modo": "mes",
    }


def load_comerciales() -> list[dict]:
    import csv as csvmod
    out = []
    if not COMERCIALES_CSV.exists():
        return out
    with COMERCIALES_CSV.open(encoding="utf-8") as f:
        for row in csvmod.DictReader(f):
            email = (row.get("Comercial") or "").strip().lower()
            if not email:
                continue
            out.append({
                "email": email,
                "equipo": (row.get("Equipo") or "").strip(),
                "categoria": (row.get("Categoría") or row.get("Categoria") or "").strip(),
                "lider": (row.get("Líder") or row.get("Lider") or "").strip(),
                "especialidad": (row.get("Especialidad") or "").strip(),
            })
    return out
