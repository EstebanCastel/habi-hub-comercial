"""Router de Rechazos y Aprobaciones del comité en el tiempo.

Replica el análisis de razones de rechazo/aprobación (el reporte de Looker):
para cada nid que pasó por `pre-comité validado`, determina si terminó
Aprobado General, Rechazo Comité o Rechazo Remodelaciones, y con qué razón.

Fuentes:
  - `papyrus-master.squad_bi_global.hubspot_historical` (oportunidad_del_negocio)
  - `papyrus-data.habi_wh_analytics.ultima_razon_rechazo_comite`
  - `papyrus-data.habi_wh_analytics.ultima_razon_rechazo_remodelaciones`
  - `papyrus-master.squad_bi_global.hubspot_deal` (owner, ciudad)

Lógica (idéntica al query original):
  - Prioridad a rechazo de remodelaciones; si no, rechazo de comité (o si la
    oportunidad = 'descartado por comité'); si nada aplica → 'Aprobado General'.
  - La razón puede registrarse el mismo mes o el siguiente → IFNULL(mes, mes+1).
  - Se excluyen negocios aún en vuelo (en pre-comité/aprobación en los últimos 30 días).

Endpoints:
  GET /          → página
  GET /filters   → { areas: [ciudades] }
  GET /data      → { meses, serie:{...}, razones:[...] } (una query agrupada)
"""
from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates

from webapp import bq

router = APIRouter()
templates = Jinja2Templates(directory=Path(__file__).parent.parent / "templates")

FECHA_INICIO = "2026-01-01"

# Valores que en remodelaciones cuentan como aprobación (no rechazo).
_REMO_APROBADO = (
    "'Aprobado','Aprobado Virtual','aprobado sin servicios publicos',"
    "'Aprobado, inmueble sin contadores','Aprobado sin servicios públicos - obra gris'"
)


def _quote_list(items: list[str]) -> str:
    return ", ".join("'" + i.replace("'", "''") + "'" for i in items)


def _area_expr(alias: str = "h") -> str:
    """Área metropolitana curada a partir de `ciudad`.

    El campo `area_metropolitana` de hubspot_deal agrupa toda la Costa bajo
    'Barranquilla' (incluye Cartagena/Santa Marta) y deja negocios con área nula,
    por eso NO se usa. Se deriva del `ciudad`, que es granular y confiable.
    """
    c = f"LOWER(TRIM({alias}.ciudad))"
    return f"""CASE
      WHEN {c} IN ('bogotá','bogota','soacha','madrid','zipaquirá','zipaquira','tocancipá','tocancipa','mosquera','chía','chia','cajica','cajicá','funza','facatativa','facatativá','cota','la calera','sopó','sopo','tenjo','sibaté','sibate') THEN 'Bogotá'
      WHEN {c} IN ('medellín','medellin','bello','sabaneta','rionegro','itagui','itagüí','itagui','la estrella','envigado','copacabana','girardota','caldas','barbosa') THEN 'Medellín'
      WHEN {c} IN ('cali','yumbo','palmira','jamundí','jamundi','candelaria') THEN 'Cali'
      WHEN {c} IN ('barranquilla','soledad','puerto colombia','malambo','galapa','sabanagrande') THEN 'Barranquilla'
      WHEN {c} IN ('cartagena') THEN 'Cartagena'
      WHEN {c} IN ('santa marta') THEN 'Santa Marta'
      WHEN {c} IS NULL OR {c} = '' THEN NULL
      ELSE 'Otras'
    END"""


def _period_expr(gran: str, field: str = "f.fecha") -> str:
    """Expresión SQL que devuelve la etiqueta de período (ordenable) según granularidad.
    Mismas granularidades que el Funnel MM: mes | semana | dia | mes_com | sem_com."""
    d = f"DATE({field})"
    if gran == "dia":
        return f"FORMAT_DATE('%Y-%m-%d', {d})"
    if gran == "semana":
        return f"FORMAT_DATE('%Y-%m-%d', DATE_TRUNC({d}, WEEK(MONDAY)))"
    if gran in ("mes_com", "sem_com"):
        cycles = bq.load_cycles()
        whens = []
        if gran == "mes_com":
            for c in cycles:
                mes_short = c["mes"][:3].capitalize()
                label = f"C{c['ciclo']:02d} · {mes_short} {str(c['year'])[2:]}"
                whens.append(f"WHEN {d} BETWEEN '{c['inicio']}' AND '{c['fin']}' THEN '{label}'")
        else:
            for c in cycles:
                for s in c["semanas"]:
                    label = f"C{c['ciclo']:02d}-S{s['num']:02d}"
                    whens.append(f"WHEN {d} BETWEEN '{s['inicio']}' AND '{s['fin']}' THEN '{label}'")
        return "CASE " + " ".join(whens) + " ELSE NULL END"
    return f"FORMAT_DATE('%Y-%m', {d})"  # mes (default)


def _base_cte(fecha_desde: str, fecha_hasta: str, areas: list[str] | None, gran: str = "mes") -> str:
    """CTE `base`: una fila por (nid, período) que pasó por pre-comité validado, con su
    clasificación 3-way (rechazos_general) y su razón (razon_rechazo_general).

    La razón siempre se atribuye por el MES del evento (así están las tablas de razones);
    la granularidad solo cambia el bucket de salida (`periodo`)."""
    area_clause = ""
    if areas:
        area_clause = f"AND {_area_expr('h')} IN ({_quote_list(areas)})"
    period_sql = _period_expr(gran)

    # Expresiones compartidas (remo → comité → aprobado general)
    remo_is_rechazo = (
        f"IF(rrr.razon_rechazo_remodelaciones IN ({_REMO_APROBADO}), 'Aprobado', "
        f"IF(rrr.razon_rechazo_remodelaciones IS NULL, 'Nulo', 'Rechazo'))"
    )
    comite_val = "IFNULL(rrc.razon_rechazo_comite, rrc_.razon_rechazo_comite)"
    comite_is_rechazo = (
        f"IF(({comite_val} IS NULL OR {comite_val} = ''), 'Aprobado', 'Rechazo')"
    )
    razon_general = (
        f"IF({remo_is_rechazo} = 'Rechazo', rrr.razon_rechazo_remodelaciones, "
        f"IF({comite_is_rechazo} = 'Rechazo' "
        f"OR LOWER(TRIM(odn.oportunidad_del_negocio)) = 'descartado por comité', "
        f"{comite_val}, 'Aprobado General'))"
    )
    rechazos_general = (
        f"IF({remo_is_rechazo} = 'Rechazo', 'Rechazo Remo', "
        f"IF({comite_is_rechazo} = 'Rechazo' "
        f"OR LOWER(TRIM(odn.oportunidad_del_negocio)) = 'descartado por comité', "
        f"'Rechazo Comite', 'Aprobado General'))"
    )
    return f"""
    WITH fecha AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY nid ORDER BY fecha DESC) AS ultimo_envio
      FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY nid, DATE_TRUNC(DATE(fecha), MONTH) ORDER BY fecha DESC) AS numero_envio_mes
        FROM `papyrus-master.squad_bi_global.hubspot_historical` hh
        WHERE hh.propiedad = 'oportunidad_del_negocio' AND LOWER(hh.valor) = 'pre-comité validado'
      )
      WHERE numero_envio_mes = 1
    ),
    rrc_t AS (SELECT nid, fecha_mes, razon_rechazo_comite FROM `papyrus-data.habi_wh_analytics.ultima_razon_rechazo_comite`),
    rrr_t AS (SELECT nid, fecha_mes, razon_rechazo_remodelaciones FROM `papyrus-data.habi_wh_analytics.ultima_razon_rechazo_remodelaciones`),
    odn_t AS (
      SELECT * FROM (
        SELECT nid, fecha, DATE_TRUNC(DATE(fecha), MONTH) fecha_mes, TRIM(valor) AS oportunidad_del_negocio,
          ROW_NUMBER() OVER (PARTITION BY nid, DATE_TRUNC(DATE(fecha), MONTH) ORDER BY fecha DESC) AS n
        FROM `papyrus-master.squad_bi_global.hubspot_historical` hh
        WHERE hh.propiedad = 'oportunidad_del_negocio' AND TRIM(hh.valor) IS NOT NULL AND TRIM(hh.valor) != ''
      )
      WHERE n = 1
    ),
    base AS (
      SELECT
        h.nid AS nid,
        {period_sql} AS periodo,
        {razon_general} AS razon_rechazo_general,
        {rechazos_general} AS rechazos_general
      FROM `papyrus-master.squad_bi_global.hubspot_deal` h
      LEFT JOIN fecha f ON f.nid = h.nid
      LEFT JOIN rrc_t rrc  ON CONCAT(rrc.nid, rrc.fecha_mes)  = CONCAT(f.nid, DATE_TRUNC(DATE(f.fecha), MONTH))
      LEFT JOIN rrc_t rrc_ ON CONCAT(rrc_.nid, rrc_.fecha_mes) = CONCAT(f.nid, DATE_ADD(DATE_TRUNC(DATE(f.fecha), MONTH), INTERVAL 1 MONTH))
      LEFT JOIN rrr_t rrr  ON CONCAT(rrr.nid, rrr.fecha_mes)  = CONCAT(f.nid, DATE_TRUNC(DATE(f.fecha), MONTH))
      LEFT JOIN odn_t odn  ON CONCAT(odn.nid, odn.fecha_mes)  = CONCAT(f.nid, DATE_TRUNC(DATE(f.fecha), MONTH))
      WHERE f.fecha IS NOT NULL
        AND DATE(f.fecha) BETWEEN '{fecha_desde}' AND '{fecha_hasta}'
        AND IF((LOWER(TRIM(odn.oportunidad_del_negocio)) IN ('aprobación comité final', 'aprobación fase 1', 'pre-comité', 'pre-comité validado')
              AND f.ultimo_envio = 1 AND DATE_TRUNC(DATE(f.fecha), MONTH) > DATE_SUB(CURRENT_DATE('-05'), INTERVAL 30 DAY)), 1, 0) = 0
        {area_clause}
    )"""


@router.get("", response_class=HTMLResponse)
def page(request: Request):
    return templates.TemplateResponse("rechazos/page.html", {
        "request": request,
        "fecha_desde": FECHA_INICIO,
        "fecha_hasta": date.today().isoformat(),
    })


@router.get("/filters")
def filters(
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
):
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    sql = _base_cte(fecha_desde, fecha_hasta, None) + f"""
    SELECT DISTINCT area FROM (
      SELECT {_area_expr('h')} AS area
      FROM `papyrus-master.squad_bi_global.hubspot_deal` h
      JOIN base b ON b.nid = h.nid
    )
    WHERE area IS NOT NULL AND area != ''
    ORDER BY area
    """
    rows = bq.query(sql)
    return JSONResponse({"areas": [r["area"] for r in rows if r.get("area")]})


@router.get("/data")
def data(
    fecha_desde: Annotated[str, Query()] = FECHA_INICIO,
    fecha_hasta: Annotated[str | None, Query()] = None,
    area: Annotated[list[str] | None, Query()] = None,
    granularidad: Annotated[str, Query()] = "mes",
):
    """Una sola query agrupada por (período, tipo, razón). De ahí se arman chart y tabla."""
    if not fecha_hasta:
        fecha_hasta = date.today().isoformat()
    areas = [a for a in (area or []) if a]
    sql = _base_cte(fecha_desde, fecha_hasta, areas, granularidad) + """
    SELECT periodo AS mes, rechazos_general, razon_rechazo_general, COUNT(DISTINCT nid) AS n
    FROM base
    WHERE periodo IS NOT NULL
    GROUP BY 1, 2, 3
    ORDER BY 1
    """
    rows = bq.query(sql)

    meses = sorted({r["mes"] for r in rows})
    tipos = ["Aprobado General", "Rechazo Comite", "Rechazo Remo"]
    # serie[tipo][mes] = count
    serie = {t: {m: 0 for m in meses} for t in tipos}
    # razones: {(tipo, razon): {mes: count}}
    razones: dict[tuple[str, str], dict[str, int]] = {}
    tot_mes = {m: 0 for m in meses}
    for r in rows:
        m = r["mes"]; t = r["rechazos_general"]; n = int(r["n"])
        razon = (r["razon_rechazo_general"] or "").strip() or "(sin razón)"
        if t in serie:
            serie[t][m] += n
        tot_mes[m] += n
        key = (t, razon)
        razones.setdefault(key, {mm: 0 for mm in meses})
        razones[key][m] += n

    serie_out = {}
    for t in tipos:
        counts = [serie[t][m] for m in meses]
        pct = [round(serie[t][m] / tot_mes[m] * 100, 1) if tot_mes[m] else 0 for m in meses]
        serie_out[t] = {"counts": counts, "pct": pct}

    razones_out = []
    for (t, razon), by_mes in razones.items():
        razones_out.append({
            "tipo": t,
            "razon": razon,
            "counts": [by_mes[m] for m in meses],
            "total": sum(by_mes.values()),
        })
    razones_out.sort(key=lambda x: -x["total"])

    return JSONResponse({
        "meses": meses,
        "total_mes": [tot_mes[m] for m in meses],
        "serie": serie_out,
        "razones": razones_out,
    })
