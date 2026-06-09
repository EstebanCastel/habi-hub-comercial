-- ============================================================================
-- ASIGNADOS OFICIAL COL (definición que pasó Juan, 2026-05-27)
-- Primera asignación por nid (HubSpot historical), excluyendo agentes/bots/call
-- y leads de baja calidad. Es la definición correcta de "asignados comerciales".
--
-- Filtros clave:
--   - h.propiedad = 'hubspot_owner_id' → eventos de cambio de owner; MIN(fecha) = 1ª asignación
--   - Excluye emails con %agente% %delta% %call% + cuentas MX + bots
--     (lauracruz, alejandrobravo, juanquinones, juanarcos) salvo que tengan contacto_digital
--   - ig.check_a_pricing = 1, ig.fuente_id IN (3,47,7)
--   - calificacion_del_lead_v2 NOT IN ('n','nh')
--   - estado IN ('sin pricing incial','no gestionado','cierre','no hay suficientes datos para comparar')
--   - mz.deleted_at IS NULL
--
-- NO confundir con f.valor='Primer_asigancion' de funnel_diarios_col, que tiene
-- spikes de scraping (Ventana metió 12.844 en jul-24). Esta es la limpia.
-- Resultado: ~5.000-6.600/mes, sin spikes. 2024 mediana 5.736 → 2026 5.132 (-11%).
-- ============================================================================

SELECT
  DATE(DATE_TRUNC(base.fecha_primer_asignacion, MONTH)) AS mes,
  base.fecha_primer_asignacion AS fecha,
  EXTRACT(DAY FROM base.fecha_primer_asignacion) AS dia,
  COUNT(DISTINCT base.nid) AS asignados_total,
  sc.label AS equipo_asignacion,
  ig.fuente, ig.equipo_sellers, ig.area_metropolitana,
  base.zona_mediana_habi, base.hubspot_owner_id, base.flag_piloto_medellin
FROM (
  SELECT
    hd.estado, h.nid, hd.precio_comite, hd.internal_price,
    hd.zona_mediana_habi, hd.hubspot_owner_id, hd.flag_piloto_medellin,
    MIN(h.fecha) AS fecha_primer_asignacion
  FROM `sellers-main-prod.hubspot.historical` AS h
  LEFT JOIN `papyrus-data.habi_wh_bi.sc_users_hubspot` AS sc ON h.valor = CAST(sc.id_segundario AS STRING)
  LEFT JOIN `sellers-main-prod.hubspot_staging.deal` AS hd ON hd.nid = h.nid
  WHERE h.propiedad = "hubspot_owner_id"
    AND IFNULL(sc.email, h.valor) NOT LIKE "%agente%"
    AND IFNULL(sc.email, h.valor) NOT LIKE "%delta%"
    AND IFNULL(sc.email, h.valor) NOT LIKE "%call%"
    AND IFNULL(sc.email, h.valor) NOT LIKE "%victorialechtig@tuhabi.mx%"
    AND IFNULL(sc.email, h.valor) NOT LIKE "%alejandroaguirre@habi.co%"
    AND IFNULL(sc.email, h.valor) NOT LIKE "%erickcastillo@tuhabi.mx%"
    AND ((IFNULL(sc.email, h.valor) LIKE "%habi.%"
          AND IFNULL(sc.email, h.valor) NOT IN ('lauracruz@habi.co','alejandrobravo@habi.co','juanquinones@habi.co','juanarcos@habi.co'))
      OR (IFNULL(sc.email, h.valor) IN ('lauracruz@habi.co','alejandrobravo@habi.co','juanquinones@habi.co','juanarcos@habi.co') AND hd.contacto_digital IS NOT NULL))
  GROUP BY 1,2,3,4,5,6,7
) AS base
LEFT JOIN `papyrus-data.habi_wh_bi.tabla_inmuebles_general` ig ON base.nid = ig.nid
LEFT JOIN `papyrus-data.habi_wh_bi.tabla_general_mkt` AS mkt ON base.nid = mkt.nid
LEFT JOIN `sellers-main-prod.co_rds_staging.habi_sellers_company_median_zone` AS mz ON mz.median_zone_id = ig.zona_mediana_id
LEFT JOIN `sellers-main-prod.co_rds_staging.habi_sellers_company` AS sc ON sc.id = mz.company_id
WHERE ig.fecha_creacion IS NOT NULL
  AND ig.check_a_pricing = 1
  AND ig.nid IS NOT NULL
  AND ig.fuente_id IN (35,20,47,39,3,7)   -- actualizado 2026-05-27 (antes 3,47,7)
  AND LOWER(ig.calificacion_del_lead_v2) NOT IN ("n","nh")
  AND LOWER(TRIM(base.estado)) IN ('sin pricing incial','no gestionado','cierre','no hay suficientes datos para comparar')
  AND mz.deleted_at IS NULL
GROUP BY 1,2,3,5,6,7,8,9,10,11;
