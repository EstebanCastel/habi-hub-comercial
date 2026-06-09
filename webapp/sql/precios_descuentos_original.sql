-- ============================================================================
-- DESCUENTOS MM — extract ORIGINAL recuperado del script que generó analisis_mm_col.html
-- (sesión Claude 2026-05-22). Esta es la query + metodología AUTORITATIVA.
-- El endpoint webapp/routers/precios_subsidios.py replica esta lógica.
-- ============================================================================
--
-- MAPEO DE COLUMNAS (confirmado contra el script original):
--   precio_oferta_base ← precio_comite_final_final_final__el_unico____clonada_  (HubSpot)
--   precio_minimo      ← precio_minimo_prestamo        (HubSpot)   "Mín (experimento)"
--   precio_intermedio  ← precio_intermedio             (HubSpot)   "Intermedio (experimento)"
--   precio_maximo      ← precio_maximo_prestamo        (HubSpot)   "Máx (experimento)"
--   ask_price_post_remo (valor estimado) ← ask_price_despues__de_remodelacion (HubSpot)
--   ask_price (precio cliente)            ← ask_price                          (HubSpot)
--
-- METODOLOGÍA DEL DESCUENTO (lo que hace el Python después de esta query):
--   0. ⚠️ AJUSTE (Juan, 2026-05-27): el endpoint usa SÓLO la ÚLTIMA aprobación por nid
--      (QUALIFY ROW_NUMBER() OVER (PARTITION BY nid ORDER BY fecha_aprobado DESC) = 1),
--      esa fecha = fecha del negocio. Un nid aprobado N veces cuenta 1. Esto hace cuadrar
--      los conteos por mes con el reporte (479/465/785/873 vs todas las aprobaciones 786/846/…).
--      El extract de abajo NO deduplica — el endpoint sí (ver precios_subsidios.py base_ofertas).
--   1. Universo: deals con fecha_aprobado >= '2025-01-01' (historia para contexto).
--      Válido = tiene ask_price_post_remo > 0 Y al menos un precio comparable.
--   2. Para cada precio: ratio = precio / ask_price_post_remo (o / ask_price para "vs cliente").
--   3. FILTRO ROBUSTO: sólo cuenta ratios ∈ [0.2, 1.5]. Esto descarta outliers
--      Y excluye naturalmente los precios de préstamo pre-experimento (ratio <0.2).
--      → Por eso las líneas Mín/Inter/Máx arrancan solas en ene-26, SIN flag de experimento.
--   4. descuento = 1 - ratio. Se grafica la MEDIANA por (mes, área, campo).
--   5. Umbral: sólo mostrar mediana si hay >=5 deals con ese precio en el período.
--   6. KPIs scoped al experimento (2026+); charts muestran historia desde 2025.
--
-- NOTA: precio_minimo/maximo del ARMADO (price_building_co_v2 diff_price JSON) NO se usan
-- para las series del chart — esas son las del HubSpot prestamo. El armado sólo aporta
-- experiment_id/experiment_group (no usado en los descuentos finales).
-- ============================================================================

WITH
base_armado AS (
  SELECT CAST(nid AS INT64) AS nid,
    SAFE.PARSE_JSON(REPLACE(idm_hesh, "\'", "\"")) AS idm_hesh,
    SAFE.PARSE_JSON(REPLACE(diff_price, "\'", "\"")) AS diff_price,
    DATETIME(fecha_ejecucion) - INTERVAL 5 HOUR AS fecha_ejecucion_armado,
    precio_final AS precio_esperado_compra
  FROM `im-main-prod.habi_wh_analytics.price_building_co_v2`
  QUALIFY ROW_NUMBER() OVER(PARTITION BY nid, DATE(fecha_ejecucion) ORDER BY DATETIME(fecha_ejecucion) DESC) = 1
),
base_armado_v2 AS (
  SELECT *,
    JSON_VALUE(diff_price.ab_test) AS ab_test,
    JSON_VALUE(diff_price.experiment_name) AS experiment_name_raw,
    CAST(JSON_VALUE(diff_price.precio_base) AS FLOAT64) AS precio_base,
    CAST(JSON_VALUE(diff_price.precio_maximo) AS FLOAT64) AS precio_maximo_armado,
    CAST(JSON_VALUE(diff_price.precio_minimo) AS FLOAT64) AS precio_minimo_armado,
    CAST(JSON_VALUE(idm_hesh.ask_price_post_remo) AS FLOAT64) AS precio_esperado_venta
  FROM base_armado
  QUALIFY ROW_NUMBER() OVER(PARTITION BY nid, DATE(fecha_ejecucion_armado)) = 1
),
base_ofertas AS (
  SELECT nid, fecha_aprobado, fecha_cierre, fecha_rechazo,
    IF(fecha_aprobado IS NOT NULL, 1, 0) AS d_aprobado,
    IF(fecha_cierre   IS NOT NULL, 1, 0) AS d_cierre,
    ROW_NUMBER() OVER(PARTITION BY nid ORDER BY fecha_aprobado) AS orden_aprobado
  FROM `papyrus-data.habi_wh.detalle_ofertas_col`
),
base_hubspot AS (
  SELECT nid,
    SAFE_CAST(precio_minimo_prestamo  AS FLOAT64) AS precio_minimo,
    SAFE_CAST(precio_intermedio       AS FLOAT64) AS precio_intermedio,
    SAFE_CAST(precio_maximo_prestamo  AS FLOAT64) AS precio_maximo,
    SAFE_CAST(precio_comite           AS FLOAT64) AS precio_comite,
    SAFE_CAST(ask_price_despues__de_remodelacion AS FLOAT64) AS ask_price_post_remo,
    SAFE_CAST(precio_comite_final_final_final__el_unico____clonada_ AS FLOAT64) AS precio_oferta_base,
    SAFE_CAST(valor_subsidiado AS FLOAT64) AS valor_subsidiado,
    SAFE_CAST(valor_subsidiado_extraordinario AS FLOAT64) AS valor_subsidiado_extraordinario
  FROM `sellers-main-prod.hubspot.deals`
),
base_auxiliar_armado AS (
  SELECT o.nid, o.fecha_aprobado,
    a.precio_esperado_compra, a.precio_esperado_venta,
    a.ab_test AS experiment_group,
    a.precio_base, a.precio_maximo_armado, a.precio_minimo_armado,
    CASE WHEN a.experiment_name_raw = 'co-rangos-20260122' AND a.fecha_ejecucion_armado >= '2026-01-26 13:00:00' THEN 'co-rangos-20260122' ELSE NULL END AS experiment_id
  FROM base_ofertas o
  LEFT JOIN base_armado_v2 a ON o.nid=a.nid
  WHERE a.fecha_ejecucion_armado <= o.fecha_aprobado
  QUALIFY ROW_NUMBER() OVER(PARTITION BY o.nid, o.fecha_aprobado ORDER BY a.fecha_ejecucion_armado DESC) = 1
)
SELECT
  IFNULL(o.nid, a.nid) AS nid,
  o.fecha_aprobado,
  DATE_TRUNC(DATE(o.fecha_aprobado), MONTH) AS mes_aprobado,
  a.experiment_id, a.experiment_group,
  a.precio_esperado_compra, a.precio_esperado_venta, a.precio_base,
  a.precio_minimo_armado, a.precio_maximo_armado,
  hs.ask_price_post_remo, hs.precio_oferta_base,
  hs.precio_minimo, hs.precio_intermedio, hs.precio_maximo, hs.precio_comite,
  hs.valor_subsidiado, hs.valor_subsidiado_extraordinario,
  tam.name AS metropolitan_area
FROM base_ofertas AS o
FULL JOIN base_auxiliar_armado AS a ON o.nid=a.nid AND DATE(a.fecha_aprobado)=DATE(o.fecha_aprobado)
LEFT JOIN base_hubspot hs ON IFNULL(o.nid, a.nid) = hs.nid
LEFT JOIN `papyrus-data.habi_db.tabla_negocio_inmueble`     AS tni ON tni.nid = IFNULL(o.nid, a.nid)
LEFT JOIN `papyrus-data.habi_db.tabla_inmueble_v2`          AS ti  ON ti.id = tni.inmueble_id
LEFT JOIN `papyrus-data.habi_db.tabla_localizacion_inmueble_v2` AS tli ON tli.id = ti.localizacion_new_id
LEFT JOIN `papyrus-data.habi_wh.tabla_zona_mediana`         AS tzm ON tzm.id = tli.zona_mediana_id
LEFT JOIN `papyrus-data.habi_wh.tabla_zona_grande`          AS tzg ON tzg.id = tzm.zona_grande_id
LEFT JOIN `papyrus-data.habi_wh.tabla_ciudad`               AS tc  ON tc.id = tzg.ciudad_id
LEFT JOIN `papyrus-data.habi_wh.tabla_area_metropolitana`   AS tam ON tam.id = tc.area_metropolitana_id
WHERE o.fecha_aprobado IS NOT NULL
  AND DATE(o.fecha_aprobado) >= '2025-01-01';
