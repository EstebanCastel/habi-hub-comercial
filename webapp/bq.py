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
