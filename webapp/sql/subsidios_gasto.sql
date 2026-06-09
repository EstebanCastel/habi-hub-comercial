-- Subsidios — Gasto de subsidios por equipo
-- Source: query pasada por Juan 2026-05-26
-- Identifica deals con subsidio_aprobado_lider = 'Si' y calcula gasto en bolsas.
-- Bolsas: 1ª bolsa = precio_intermedio - precio_minimo_prestamo
--         2ª bolsa = (final_final_aprobado_b_o - precio_intermedio) si es positivo
-- "Gasto real" = sólo los Firmados (label = 'Firmado').

WITH aprobados_jf AS (
  SELECT *
  FROM `sellers-main-prod.hubspot.historical` h
  WHERE propiedad = 'subsidio_aprobado_lider'
    AND valor = 'Si'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY h.nid ORDER BY h.fecha DESC) = 1
),
base AS (
  SELECT
    jf.nid,
    jf.fecha AS fecha_aprobacion_sub,
    hd.precio_minimo_prestamo,
    hd.precio_intermedio,
    hd.precio_maximo_prestamo,
    hd.valor_solicitado_de_subsidio,
    hd.equipo_sellers,
    hd.valor_subsidiado,
    hd.precio_intermedio - hd.precio_minimo_prestamo AS subsidio_aprobado,
    ds.label,
    hd.final_final_aprobado_b_o,
    hd.final_final_aprobado_b_o - hd.precio_minimo_prestamo AS gasto_total_bolsa,
    CASE
      WHEN (hd.final_final_aprobado_b_o - hd.precio_intermedio) <= 0
        THEN hd.final_final_aprobado_b_o - hd.precio_minimo_prestamo
      ELSE hd.precio_intermedio - hd.precio_minimo_prestamo
    END AS gasto_primer_bolsa,
    CASE
      WHEN (hd.final_final_aprobado_b_o - hd.precio_intermedio) > 0
        THEN hd.final_final_aprobado_b_o - hd.precio_intermedio
      ELSE 0
    END AS gasto_segunda_bolsa
  FROM aprobados_jf AS jf
  LEFT JOIN `sellers-main-prod.hubspot.deals` hd ON hd.nid = jf.nid
  LEFT JOIN `sellers-main-prod.hubspot.deal_pipelines_stages` ds ON hd.dealstage = ds.id
  WHERE hd.subsidio_aprobado_lider = 'Si'
)

SELECT
  equipo_sellers,
  CAST(ROUND(SUM(subsidio_aprobado)) AS INT64) AS gasto_bolsa,
  COUNT(nid) AS subsidios_aprobados,
  CAST(ROUND(SUM(CASE WHEN label = 'Firmado' THEN CAST(ROUND(subsidio_aprobado) AS INT64) ELSE 0 END)) AS INT64) AS gasto_real,
  COUNT(DISTINCT CASE WHEN label = 'Firmado' THEN nid ELSE NULL END) AS subsidios_cerrados,
  CAST(ROUND(SUM(CASE WHEN label = 'Firmado' THEN CAST(ROUND(gasto_total_bolsa) AS INT64) ELSE 0 END)) AS INT64) AS gasto_real_bolsa,
  CAST(ROUND(SUM(CASE WHEN label = 'Firmado' THEN CAST(ROUND(gasto_primer_bolsa) AS INT64) ELSE 0 END)) AS INT64) AS gasto_real_1bolsa,
  CAST(ROUND(SUM(CASE WHEN label = 'Firmado' THEN CAST(ROUND(gasto_segunda_bolsa) AS INT64) ELSE 0 END)) AS INT64) AS gasto_real_2bolsa
FROM base
GROUP BY 1
ORDER BY 1;
