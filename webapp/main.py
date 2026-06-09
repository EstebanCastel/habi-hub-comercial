"""App FastAPI — Hub comercial Habi.

Sirve los reportes con HTMX + Tailwind, queries en vivo a BigQuery (con caché).
"""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from webapp import bq, metas_mm, metas_inmo
from webapp.routers import funnel_mm, funnel_inmo, funnel_combinado, conversion_seller, precios_subsidios

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)s  %(name)s  %(message)s",
)

BASE_DIR = Path(__file__).parent
app = FastAPI(title="Habi Comercial Hub")

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

templates = Jinja2Templates(directory=BASE_DIR / "templates")
# Inyectar template global accesible desde templates
templates.env.globals["app_name"] = "Hub Comercial"


# ── Home ─────────────────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse("index.html", {
        "request": request,
        "reports": [
            {
                "slug": "funnel-mm",
                "title": "Funnel Comercial — MM",
                "desc": "Volumen por etapa del funnel ibuyer (asignación → cierre). Filtros por equipo, categoría, fuente y área metropolitana.",
                "badge": "Activo",
                "icon": "📊",
                "url": "/funnel/mm",
                "color": "purple",
            },
            {
                "slug": "funnel-inmo",
                "title": "Funnel Comercial — Inmobiliaria",
                "desc": "Volumen por etapa del pipeline inmobiliaria (asignado → captado). Filtros por equipo, área y prioridad.",
                "badge": "Activo",
                "icon": "🏘️",
                "url": "/funnel/inmo",
                "color": "teal",
            },
            {
                "slug": "funnel-combinado",
                "title": "Funnel Combinado — MM + Inmo",
                "desc": "CVR cruzando ambos productos. Editás numerador y denominador (presets combinados o etapas individuales).",
                "badge": "Activo",
                "icon": "🔀",
                "url": "/funnel/combinado",
                "color": "indigo",
            },
            {
                "slug": "conversion-seller",
                "title": "Conversión por Seller",
                "desc": "CVR Asignado → Cierre (MM) y Asignado → Captado (Inmo) por comercial individual, con benchmarks vs meta / equipo / global.",
                "badge": "Activo",
                "icon": "📈",
                "url": "/conversion/seller",
                "color": "pink",
            },
        ],
    })


# ── Health (Cloud Run) ───────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/admin/cache/clear")
def cache_clear():
    n = bq.cache_clear()
    # También invalida las cachés de metas (módulo) para re-leer los CSV tras actualizarlos.
    metas_mm.reset_cache()
    metas_inmo.reset_cache()
    return {"cleared": n, "metas_reset": True}


# ── Routers ──────────────────────────────────────────────────────────────────
app.include_router(funnel_mm.router,          prefix="/funnel/mm",       tags=["funnel-mm"])
app.include_router(funnel_inmo.router,        prefix="/funnel/inmo",     tags=["funnel-inmo"])
app.include_router(funnel_combinado.router,   prefix="/funnel/combinado", tags=["funnel-combinado"])
app.include_router(conversion_seller.router,  prefix="/conversion/seller", tags=["conversion-seller"])
app.include_router(precios_subsidios.router,  prefix="/funnel/mm/precios-subsidios", tags=["precios-subsidios"])
