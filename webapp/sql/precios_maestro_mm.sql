-- Maestra de Experimentos COL (Market Maker)
-- Source: query pasada por Juan 2026-05-26
-- Conceptos clave:
--   - precio_base / ask_price_post_remo = ask_price_despues__de_remodelacion (valor estimado vivienda)
--   - precio_minimo, precio_intermedio, precio_maximo = del experimento de armado (price_building_co_v2)
--   - Experimento: 'co-rangos-20260122' inicio 2026-01-26 13:00:00
--   - precio_comite_final_final_final__el_unico____clonada_ = oferta base del comité (a.k.a. precio_oferta_base)
--   - flag_final_aprobado = final_final_aprobado_b_o IS NOT NULL → subsidio aprobado real
-- Output: una fila por nid+orden_aprobado con todas las features de oferta + experimento.

WITH

base_armado AS (
  SELECT
    CAST(nid AS INT64) AS nid,
    SAFE.PARSE_JSON(REPLACE(idm_hesh, "\'", "\"")) AS idm_hesh,
    SAFE.PARSE_JSON(REPLACE(diff_price, "\'", "\"")) AS diff_price,
    DATETIME(fecha_ejecucion) - INTERVAL 5 HOUR AS fecha_ejecucion_armado,
    precio_final AS precio_esperado_compra
  FROM `im-main-prod.habi_wh_analytics.price_building_co_v2`
  QUALIFY ROW_NUMBER() OVER (PARTITION BY nid, DATE(fecha_ejecucion) ORDER BY DATETIME(fecha_ejecucion) DESC) = 1
),

base_armado_v2 AS (
  SELECT
    *,
    JSON_VALUE(diff_price.ab_test) AS ab_test,
    JSON_VALUE(diff_price.experiment_name) AS experiment_name_raw,
    CAST(JSON_VALUE(diff_price.precio_base) AS FLOAT64) AS precio_base,
    JSON_VALUE(diff_price.precio_maximo) AS precio_maximo,
    JSON_VALUE(diff_price.precio_minimo) AS precio_minimo,
    JSON_VALUE(idm_hesh.ask_price_post_remo) AS precio_esperado_venta
  FROM base_armado
  QUALIFY ROW_NUMBER() OVER (PARTITION BY nid, DATE(fecha_ejecucion_armado)) = 1
),

base_ofertas AS (
  SELECT
    *,
    IF(fecha_aprobado IS NOT NULL, 1, 0) AS d_aprobado,
    IF(fecha_cierre IS NOT NULL, 1, 0) AS d_cierre,
    DATE_TRUNC(fecha_cierre, WEEK(MONDAY)) AS semana_cierre,
    DATE_TRUNC(fecha_aprobado, WEEK(MONDAY)) AS semana_aprobado,
    IFNULL(DATE_DIFF(fecha_cierre, fecha_aprobado, WEEK), 50) AS weeks_apro_cie,
    ROW_NUMBER() OVER (PARTITION BY nid ORDER BY fecha_aprobado) AS orden_aprobado
  FROM `papyrus-data.habi_wh.detalle_ofertas_col`
),

base_hubspot AS (
  SELECT
    nid,
    SAFE_CAST(valor_subsidiado AS FLOAT64) AS valor_subsidiado,
    SAFE_CAST(valor_subsidiado_extraordinario AS FLOAT64) AS valor_subsidiado_extraordinario,
    quiere_solicitar_subsidio_,
    valor_solicitado_de_subsidio,
    subsidio_aprobado_lider,
    subsidio_aprobado_director,
    precio_minimo_prestamo,
    precio_maximo_prestamo,
    precio_intermedio,
    precio_comite,
    ask_price_despues__de_remodelacion,
    precio_comite_final_final_final__el_unico____clonada_,
    equipo_sellers,
    final_final_aprobado_b_o
  FROM `sellers-main-prod.hubspot.deals`
),

base_auxiliar_armado AS (
  SELECT
    o.nid,
    o.fecha_aprobado,
    CAST(a.precio_esperado_compra AS FLOAT64) AS precio_esperado_compra,
    CAST(a.precio_esperado_venta AS FLOAT64) AS precio_esperado_venta,
    a.ab_test AS experiment_group,
    a.fecha_ejecucion_armado,
    CAST(a.precio_base AS FLOAT64) AS precio_base,
    CAST(a.precio_maximo AS FLOAT64) AS precio_maximo,
    CAST(a.precio_minimo AS FLOAT64) AS precio_minimo,
    CASE
      WHEN a.experiment_name_raw = 'co-rangos-20260122'
        AND a.fecha_ejecucion_armado >= '2026-01-26 13:00:00'
      THEN 'co-rangos-20260122'
      ELSE NULL
    END AS experiment_id
  FROM base_ofertas o
  LEFT JOIN base_armado_v2 a ON o.nid = a.nid
  WHERE a.fecha_ejecucion_armado <= o.fecha_aprobado
  QUALIFY ROW_NUMBER() OVER (PARTITION BY o.nid, o.fecha_aprobado ORDER BY a.fecha_ejecucion_armado DESC) = 1
),

base_final_mm AS (
  SELECT
    IFNULL(o.nid, a.nid) AS nid,
    o.fecha_aprobado,
    o.fecha_cierre,
    o.d_aprobado,
    o.d_cierre,
    o.semana_aprobado,
    o.orden_aprobado,
    o.estado_aprobado,
    o.categoria_final,
    a.precio_esperado_compra,
    a.precio_esperado_venta,
    a.experiment_group,
    a.fecha_ejecucion_armado,
    a.precio_base,
    a.precio_maximo,
    a.precio_minimo,
    a.experiment_id
  FROM base_ofertas o
  FULL JOIN base_auxiliar_armado a ON o.nid = a.nid AND DATE(a.fecha_aprobado) = DATE(o.fecha_aprobado)
)

SELECT
  bf.*,
  hs.valor_subsidiado,
  hs.subsidio_aprobado_lider,
  hs.precio_minimo_prestamo,
  hs.precio_maximo_prestamo,
  hs.precio_intermedio,
  hs.precio_comite,
  hs.ask_price_despues__de_remodelacion AS ask_price_post_remo,
  hs.precio_comite_final_final_final__el_unico____clonada_ AS precio_oferta_base,
  hs.equipo_sellers,
  hs.final_final_aprobado_b_o,
  tam.name AS metropolitan_area,
  CASE
    WHEN ti.tipo_inmueble_id = 1 THEN '1. Apto en condominio'
    WHEN ti.tipo_inmueble_id = 2 THEN '2. Casa sola'
    WHEN ti.tipo_inmueble_id = 3 THEN '3. Casa en condominio'
    WHEN ti.tipo_inmueble_id = 4 THEN '4. Apto solo'
    ELSE NULL
  END AS tipo_inmueble
FROM base_final_mm bf
LEFT JOIN base_hubspot hs ON bf.nid = hs.nid
LEFT JOIN `papyrus-data.habi_db.tabla_negocio_inmueble` tni ON tni.nid = bf.nid
LEFT JOIN `papyrus-data.habi_db.tabla_inmueble_v2` ti ON ti.id = tni.inmueble_id
LEFT JOIN `papyrus-data.habi_db.tabla_localizacion_inmueble_v2` tli ON tli.id = ti.localizacion_new_id
LEFT JOIN `papyrus-data.habi_wh.tabla_zona_mediana` tzm ON tzm.id = tli.zona_mediana_id
LEFT JOIN `papyrus-data.habi_wh.tabla_zona_grande` tzg ON tzg.id = tzm.zona_grande_id
LEFT JOIN `papyrus-data.habi_wh.tabla_ciudad` tc ON tc.id = tzg.ciudad_id
LEFT JOIN `papyrus-data.habi_wh.tabla_area_metropolitana` tam ON tam.id = tc.area_metropolitana_id
WHERE bf.fecha_aprobado IS NOT NULL;
