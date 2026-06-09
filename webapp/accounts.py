"""Cuentas que NO son comerciales reales — se excluyen de los tableros.

Fuente única de verdad para bots/queue y buffers. Importar desde aquí en todos
los routers para no duplicar listas.
"""
from __future__ import annotations

# Bots / cuentas de cola (mantienen leads en queue)
MM_BOT_EMAILS   = ["juanquinones@habi.co", "iagabi@habi.co"]
INMO_BOT_EMAILS = ["cristianmartin@habi.co", "jhoanbenavides@habi.co"]

# Buffers: leads parqueados que no se asignan al equipo. Se excluyen de TODOS los
# tableros (Funnel MM, Funnel Inmo, Combinado y Conversión Seller).
BUFFER_EMAILS = [
    "susanaescobar@habi.co",
    "danieljaramillo@habi.co",
    "juancampos@habi.co",
]

# Cuentas a excluir en cualquier tablero MM (bots + buffers).
MM_EXCLUIR_EMAILS   = MM_BOT_EMAILS + BUFFER_EMAILS
# En tableros Inmo: bots Inmo + buffers (los buffers MM también ensucian Inmo si aparecen).
INMO_EXCLUIR_EMAILS = INMO_BOT_EMAILS + BUFFER_EMAILS


def sql_not_in(field: str, emails: list[str]) -> str:
    """Devuelve `LOWER(field) NOT IN ('a','b')`. Si no hay emails, retorna 'TRUE'."""
    if not emails:
        return "TRUE"
    lst = ", ".join("'" + e.lower().replace("'", "''") + "'" for e in emails)
    return f"LOWER({field}) NOT IN ({lst})"
