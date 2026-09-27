-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.copilot_available_rooms_v1(p_organization_id uuid) md5(prosrc)=2816da5a32cb4e501da2f46df757b7ee
CREATE OR REPLACE FUNCTION public.copilot_available_rooms_v1(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE v_buildings uuid[]; v_today date;
BEGIN
  v_buildings := public.copilot_org_scope_buildings_v1('rooms.view', p_organization_id);
  IF COALESCE(cardinality(v_buildings), 0) = 0 THEN RETURN jsonb_build_object('areas','[]'::jsonb,'buildings','[]'::jsonb,'rooms','[]'::jsonb,'contact',NULL); END IF;
  v_today := public.org_today_v1(p_organization_id);
  RETURN jsonb_build_object(
    'areas', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.name)
      FROM (
        SELECT a0.id, a0.name
        FROM public.areas a0
        WHERE a0.organization_id = p_organization_id
          AND a0.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM public.area_buildings ab WHERE ab.area_id = a0.id AND ab.building_id = ANY(v_buildings))
        ORDER BY a0.name
        LIMIT 2000
      ) a
    ), '[]'::jsonb),
    'buildings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', b.id, 'name', b.name, 'code', b.code,
        'area_ids', COALESCE((SELECT jsonb_agg(ab.area_id ORDER BY ab.area_id) FROM public.area_buildings ab WHERE ab.building_id = b.id AND ab.organization_id = p_organization_id), '[]'::jsonb),
        'district', b.district, 'ward', b.ward,
        'address', CASE WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%' THEN b.street_address ELSE concat_ws(', ', NULLIF(b.street_address, ''), NULLIF(b.ward, ''), NULLIF(b.district, ''), NULLIF(b.province, '')) END,
        'total_floors', b.total_floors, 'floor_layouts', b.floor_layouts, 'images', COALESCE(b.images,'[]'::jsonb),
        'public_contact_name', b.public_contact_name, 'public_contact_phone', b.public_contact_phone, 'public_map_url', b.public_map_url, 'public_lift_type', b.public_lift_type
      ) ORDER BY b.name)
      FROM (
        SELECT b0.*
        FROM public.buildings b0
        WHERE b0.id = ANY(v_buildings)
          AND b0.organization_id = p_organization_id
          AND b0.deleted_at IS NULL
          AND b0.is_virtual = false
          AND EXISTS (
            SELECT 1
            FROM public.rooms br
            LEFT JOIN public.room_pass_listings bpl ON bpl.room_id = br.id AND bpl.user_id = b0.user_id AND (bpl.organization_id = p_organization_id OR bpl.organization_id IS NULL) AND bpl.active = true
            WHERE br.building_id = b0.id AND br.deleted_at IS NULL
              AND (bpl.id IS NOT NULL OR (NOT public.room_has_holding_deposit(br.id) AND br.status = 'AVAILABLE') OR (NOT public.room_has_holding_deposit(br.id) AND EXISTS (
                SELECT 1 FROM public.contracts bc
                WHERE bc.room_id = br.id AND bc.deleted_at IS NULL AND bc.status IN ('ACTIVE','EXTENDED')
                  AND ((bc.expected_move_out_date IS NOT NULL AND bc.expected_move_out_date BETWEEN v_today AND v_today + COALESCE((SELECT prs.soon_days FROM public.public_room_settings prs WHERE prs.owner_id = b0.user_id AND (prs.organization_id = p_organization_id OR prs.organization_id IS NULL) LIMIT 1), 30))
                    OR COALESCE(bc.actual_end_date, bc.end_date) BETWEEN v_today AND v_today + COALESCE((SELECT prs.soon_days FROM public.public_room_settings prs WHERE prs.owner_id = b0.user_id AND (prs.organization_id = p_organization_id OR prs.organization_id IS NULL) LIMIT 1), 30))
              )))
          )
        ORDER BY b0.name
        LIMIT 2000
      ) b
    ), '[]'::jsonb),
    'rooms', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', rs.id, 'building_id', rs.building_id, 'floor', rs.floor, 'name', rs.name, 'code', rs.code,
        'area', rs.area, 'rent_price', rs.rent_price, 'deposit_amount', rs.deposit_amount, 'max_occupants', rs.max_occupants,
        'amenities', COALESCE(rs.amenities,'[]'::jsonb), 'images', COALESCE(rs.images,'[]'::jsonb), 'description', rs.description,
        'sale_note', rs.sale_note, 'room_type', rs.room_type,
        'pass_sale_policy', rs.pass_sale_policy, 'pass_price', rs.pass_price, 'pass_avail_date', rs.pass_avail_date, 'pass_contact_manager', rs.pass_contact_manager,
        'status_public', rs.status_public, 'avail_date', rs.avail_date
      ) ORDER BY rs.floor DESC, rs.name)
      FROM (
        SELECT rs0.*
        FROM (
          SELECT r.id, r.building_id, r.floor, r.name, r.code, r.area, r.rent_price, r.deposit_amount, r.max_occupants,
                 r.amenities, r.images, r.description, r.sale_note, r.room_type,
                 pl.sale_policy AS pass_sale_policy,
                 pl.pass_price, pl.avail_date AS pass_avail_date, COALESCE(pl.contact_manager, false) AS pass_contact_manager,
                 CASE
                   WHEN pl.id IS NOT NULL THEN 'pass'
                   WHEN public.room_has_holding_deposit(r.id) THEN 'rented'
                   WHEN EXISTS (
                     SELECT 1 FROM public.contracts c
                     WHERE c.room_id = r.id AND c.deleted_at IS NULL AND c.status IN ('ACTIVE','EXTENDED')
                       AND ((c.expected_move_out_date IS NOT NULL AND c.expected_move_out_date BETWEEN v_today AND v_today + COALESCE(prs.soon_days, 30))
                         OR COALESCE(c.actual_end_date, c.end_date) BETWEEN v_today AND v_today + COALESCE(prs.soon_days, 30))
                   ) THEN 'soon'
                   WHEN EXISTS (SELECT 1 FROM public.contracts c WHERE c.room_id = r.id AND c.deleted_at IS NULL AND c.status IN ('ACTIVE','EXTENDED')) THEN 'rented'
                   WHEN r.status = 'AVAILABLE' THEN 'free'
                   ELSE 'rented'
                 END AS status_public,
                 CASE
                   WHEN pl.id IS NOT NULL THEN pl.avail_date
                   ELSE (
                     SELECT MIN(CASE WHEN c.expected_move_out_date IS NOT NULL AND c.expected_move_out_date BETWEEN v_today AND v_today + COALESCE(prs.soon_days, 30) THEN c.expected_move_out_date ELSE COALESCE(c.actual_end_date, c.end_date) END)
                     FROM public.contracts c
                     WHERE c.room_id = r.id AND c.deleted_at IS NULL AND c.status IN ('ACTIVE','EXTENDED')
                       AND ((c.expected_move_out_date IS NOT NULL AND c.expected_move_out_date BETWEEN v_today AND v_today + COALESCE(prs.soon_days, 30))
                         OR COALESCE(c.actual_end_date, c.end_date) BETWEEN v_today AND v_today + COALESCE(prs.soon_days, 30))
                   )
                 END AS avail_date
          FROM public.rooms r
          JOIN public.buildings b ON b.id = r.building_id
          LEFT JOIN public.public_room_settings prs ON prs.owner_id = b.user_id AND (prs.organization_id = p_organization_id OR prs.organization_id IS NULL)
          LEFT JOIN public.room_pass_listings pl ON pl.room_id = r.id AND pl.user_id = b.user_id AND (pl.organization_id = p_organization_id OR pl.organization_id IS NULL) AND pl.active = true
          WHERE r.building_id = ANY(v_buildings)
            AND b.organization_id = p_organization_id AND b.deleted_at IS NULL AND b.is_virtual = false
            AND r.deleted_at IS NULL
        ) rs0
        WHERE rs0.status_public IN ('free','soon','pass')
        ORDER BY rs0.floor DESC, rs0.name
        LIMIT 2000
      ) rs
    ), '[]'::jsonb),
    'contact', NULL
  );
END
$function$

