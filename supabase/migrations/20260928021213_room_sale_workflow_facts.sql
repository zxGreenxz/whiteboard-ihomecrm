-- Read-only sale facts; no room/contract/payment writes, triggers, jobs or permission changes.
-- Base reader definitions captured read-only from TEST on 2026-09-28.
CREATE OR REPLACE FUNCTION app_private.room_sale_workflow_fact_v1(
  p_room_id uuid,p_organization_id uuid,p_room_status text,p_has_pass boolean,p_soon_days integer
)
RETURNS TABLE(status_public text,sale_state text,avail_date date,sale_today date,expected_ready_on date)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE v_today date:=public.org_today_v1(p_organization_id);
  v_occupied boolean;v_current_occupied boolean;v_notice date;v_overdue boolean;v_claim boolean:=false;v_turnover public.room_turnovers%ROWTYPE;
BEGIN
  sale_today:=v_today;avail_date:=NULL;expected_ready_on:=NULL;
  -- P9 is installed later in the forward sequence. Once present, a pure hold
  -- blocks sale without changing physical room status or expiring by itself.
  IF to_regclass('public.room_next_claims') IS NOT NULL THEN
    SELECT EXISTS(SELECT 1 FROM public.room_next_claims c
      WHERE c.organization_id=p_organization_id AND c.room_id=p_room_id AND c.status='LIVE') INTO v_claim;
  END IF;
  -- A pass advertisement is not a claim; valid next-customer holds always block sale.
  IF v_claim OR public.room_has_holding_deposit(p_room_id) OR p_room_status='RESERVED' THEN
    status_public:='rented';sale_state:='RENTED';RETURN NEXT;RETURN;
  END IF;
  SELECT count(*)>0,COALESCE(bool_or(c.start_date<=v_today),false),
    min(c.expected_move_out_date) FILTER (WHERE c.start_date<=v_today
      AND isfinite(c.expected_move_out_date) AND c.expected_move_out_date BETWEEN v_today AND v_today+p_soon_days),
    COALESCE(bool_or(c.start_date<=v_today AND isfinite(c.expected_move_out_date) AND c.expected_move_out_date<v_today),false)
    INTO v_occupied,v_current_occupied,v_notice,v_overdue
    FROM public.contracts c
    WHERE c.room_id=p_room_id AND c.organization_id=p_organization_id AND c.deleted_at IS NULL
      AND c.status IN ('ACTIVE','EXTENDED') AND c.actual_end_date IS NULL;
  IF v_occupied THEN
    IF p_has_pass AND v_current_occupied THEN status_public:='pass';sale_state:='PASS';
    ELSIF v_overdue THEN status_public:='soon';sale_state:='NOTICE_OVERDUE';
    ELSIF v_notice IS NOT NULL THEN status_public:='soon';sale_state:='NOTICE';avail_date:=v_notice;
    ELSE status_public:='rented';sale_state:='RENTED';END IF;
    RETURN NEXT;RETURN;
  END IF;
  IF p_room_status='AVAILABLE' THEN
    status_public:='free';sale_state:='READY';
    SELECT * INTO v_turnover FROM public.room_turnovers t
      WHERE t.room_id=p_room_id AND t.organization_id=p_organization_id AND t.status='PENDING';
    IF FOUND THEN sale_state:='PREPARING';expected_ready_on:=v_turnover.expected_ready_on;END IF;
  ELSE status_public:='rented';sale_state:='RENTED';END IF;
  RETURN NEXT;
END;
$function$;
REVOKE ALL ON FUNCTION app_private.room_sale_workflow_fact_v1(uuid,uuid,text,boolean,integer) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.get_my_available_rooms()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_caller  uuid := auth.uid();
  v_owner   uuid;
  v_soon    int;
  v_hotline uuid;
  v_result  jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT sa.user_id INTO v_owner
  FROM public.staff_assignments sa
  WHERE sa.staff_id = v_caller AND sa.user_id <> v_caller
  LIMIT 1;
  IF v_owner IS NULL THEN
    v_owner := v_caller;
  END IF;

  SELECT soon_days, hotline_id INTO v_soon, v_hotline
  FROM public.public_room_settings
  WHERE owner_id = v_owner;
  IF v_soon IS NULL THEN v_soon := 30; END IF;

  WITH rms AS (
    SELECT
      rm.id,
      rm.building_id,
      rm.floor,
      rm.name,
      rm.code,
      rm.area,
      rm.rent_price,
      rm.deposit_amount,
      rm.max_occupants,
      COALESCE(rm.amenities, '[]'::jsonb) AS amenities,
      COALESCE(rm.images,    '[]'::jsonb) AS images,
      rm.description,
      rm.sale_note,
      rm.sale_bonus_note,
      rm.room_type,
      -- Phòng khách nhờ sale (overlay). Khi contact_manager → che SĐT/tên khách.
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_name ELSE NULL END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_phone ELSE NULL END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN pl.sale_policy ELSE NULL END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price ELSE NULL END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date ELSE NULL END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      fact.status_public, fact.sale_state, fact.avail_date, fact.sale_today, fact.expected_ready_on
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id AND b.organization_id = rm.organization_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = rm.id AND pl.user_id = v_owner AND pl.active = true
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,v_soon) fact
    WHERE b.user_id = v_owner
      AND b.is_virtual = false
      AND b.deleted_at IS NULL
      AND rm.deleted_at IS NULL
  ),
  bld_ids AS (
    SELECT DISTINCT building_id FROM rms WHERE status_public IN ('free','soon','pass')
  ),
  rooms_j AS (
    SELECT jsonb_agg(to_jsonb(rms) ORDER BY rms.floor DESC, rms.name) AS j
    FROM rms
    WHERE rms.building_id IN (SELECT building_id FROM bld_ids)
  ),
  blds_j AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id',           b.id,
      'name',         b.name,
      'code',         b.code,
      'area_ids',     COALESCE((
                        SELECT jsonb_agg(ab.area_id)
                        FROM public.area_buildings ab
                        JOIN public.areas a ON a.id = ab.area_id
                        WHERE ab.building_id = b.id AND a.deleted_at IS NULL
                      ), '[]'::jsonb),
      'district',     b.district,
      'ward',         b.ward,
      'address',      CASE
                        WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%'
                          THEN b.street_address
                        ELSE concat_ws(', ',
                               NULLIF(b.street_address, ''),
                               NULLIF(b.ward, ''),
                               NULLIF(b.district, ''),
                               NULLIF(b.province, ''))
                      END,
      'total_floors', b.total_floors,
      'floor_layouts', b.floor_layouts,
      'images',        COALESCE(b.images, '[]'::jsonb),
      'public_contact_name',  b.public_contact_name,
      'public_contact_phone', b.public_contact_phone,
      'public_map_url',       b.public_map_url,
      'public_lift_type',     b.public_lift_type,
      'elec_rate', (
        SELECT COALESCE(bs.unit_price_override, s.unit_price)
        FROM public.building_services bs
        JOIN public.services s ON s.id = bs.service_id
        WHERE bs.building_id = b.id
          AND bs.is_active = true
          AND s.deleted_at IS NULL
          AND s.unit ILIKE 'kwh'
        ORDER BY (s.type = 'FIXED') DESC, s.unit_price
        LIMIT 1
      )
    ) ORDER BY b.name) AS j
    FROM public.buildings b
    WHERE b.id IN (SELECT building_id FROM bld_ids)
  ),
  areas_j AS (
    SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.name) AS j
    FROM public.areas a
    WHERE a.user_id = v_owner AND a.deleted_at IS NULL
  ),
  contact_j AS (
    SELECT jsonb_build_object('name', h.name, 'phone', h.phone_number) AS j
    FROM public.hotlines h
    WHERE h.user_id = v_owner
      AND COALESCE(h.is_active, true) = true
      AND (v_hotline IS NULL OR h.id = v_hotline)
    ORDER BY (h.id = v_hotline) DESC NULLS LAST, h.created_at
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'areas',     COALESCE((SELECT j FROM areas_j), '[]'::jsonb),
    'buildings', COALESCE((SELECT j FROM blds_j), '[]'::jsonb),
    'rooms',     COALESCE((SELECT j FROM rooms_j), '[]'::jsonb),
    'contact',   (SELECT j FROM contact_j)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_public_available_rooms(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_owner   uuid;
  v_soon    int;
  v_hotline uuid;
  v_result  jsonb;
BEGIN
  IF p_token IS NULL OR p_token = '' THEN
    RETURN NULL;
  END IF;

  SELECT owner_id INTO v_owner
  FROM public.public_room_share_tokens
  WHERE token = p_token AND revoked = false;

  IF v_owner IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT soon_days, hotline_id INTO v_soon, v_hotline
  FROM public.public_room_settings
  WHERE owner_id = v_owner;
  IF v_soon IS NULL THEN v_soon := 30; END IF;

  WITH rms AS (
    SELECT
      rm.id,
      rm.building_id,
      rm.floor,
      rm.name,
      rm.code,
      rm.area,
      rm.rent_price,
      rm.deposit_amount,
      rm.max_occupants,
      COALESCE(rm.amenities, '[]'::jsonb) AS amenities,
      COALESCE(rm.images,    '[]'::jsonb) AS images,
      rm.description,
      rm.sale_note,
      rm.room_type,
      -- Phòng khách nhờ sale (overlay). Khi contact_manager → che SĐT/tên khách.
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_name ELSE NULL END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_phone ELSE NULL END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN pl.sale_policy ELSE NULL END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price ELSE NULL END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date ELSE NULL END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      fact.status_public, fact.sale_state, fact.avail_date, fact.sale_today, fact.expected_ready_on
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id AND b.organization_id = rm.organization_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = rm.id AND pl.user_id = v_owner AND pl.active = true
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,v_soon) fact
    WHERE b.user_id = v_owner
      AND b.is_virtual = false
      AND b.deleted_at IS NULL
      AND rm.deleted_at IS NULL
  ),
  bld_ids AS (
    SELECT DISTINCT building_id FROM rms WHERE status_public IN ('free','soon','pass')
  ),
  rooms_j AS (
    SELECT jsonb_agg(to_jsonb(rms) ORDER BY rms.floor DESC, rms.name) AS j
    FROM rms
    WHERE rms.building_id IN (SELECT building_id FROM bld_ids)
  ),
  blds_j AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id',           b.id,
      'name',         b.name,
      'code',         b.code,
      'area_ids',     COALESCE((
                        SELECT jsonb_agg(ab.area_id)
                        FROM public.area_buildings ab
                        JOIN public.areas a ON a.id = ab.area_id
                        WHERE ab.building_id = b.id AND a.deleted_at IS NULL
                      ), '[]'::jsonb),
      'district',     b.district,
      'ward',         b.ward,
      'address',      CASE
                        WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%'
                          THEN b.street_address
                        ELSE concat_ws(', ',
                               NULLIF(b.street_address, ''),
                               NULLIF(b.ward, ''),
                               NULLIF(b.district, ''),
                               NULLIF(b.province, ''))
                      END,
      'total_floors', b.total_floors,
      'floor_layouts', b.floor_layouts,
      'images',        COALESCE(b.images, '[]'::jsonb),
      'public_contact_name',  b.public_contact_name,
      'public_contact_phone', b.public_contact_phone,
      'public_map_url',       b.public_map_url,
      'public_lift_type',     b.public_lift_type,
      'elec_rate', (
        SELECT COALESCE(bs.unit_price_override, s.unit_price)
        FROM public.building_services bs
        JOIN public.services s ON s.id = bs.service_id
        WHERE bs.building_id = b.id
          AND bs.is_active = true
          AND s.deleted_at IS NULL
          AND s.unit ILIKE 'kwh'
        ORDER BY (s.type = 'FIXED') DESC, s.unit_price
        LIMIT 1
      )
    ) ORDER BY b.name) AS j
    FROM public.buildings b
    WHERE b.id IN (SELECT building_id FROM bld_ids)
  ),
  areas_j AS (
    SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.name) AS j
    FROM public.areas a
    WHERE a.user_id = v_owner AND a.deleted_at IS NULL
  ),
  contact_j AS (
    SELECT jsonb_build_object('name', h.name, 'phone', h.phone_number) AS j
    FROM public.hotlines h
    WHERE h.user_id = v_owner
      AND COALESCE(h.is_active, true) = true
      AND (v_hotline IS NULL OR h.id = v_hotline)
    ORDER BY (h.id = v_hotline) DESC NULLS LAST, h.created_at
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'areas',     COALESCE((SELECT j FROM areas_j), '[]'::jsonb),
    'buildings', COALESCE((SELECT j FROM blds_j), '[]'::jsonb),
    'rooms',     COALESCE((SELECT j FROM rooms_j), '[]'::jsonb),
    'contact',   (SELECT j FROM contact_j)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

-- Existing public/authenticated RPC ACLs are retained by CREATE OR REPLACE.
COMMENT ON FUNCTION public.get_public_available_rooms(text) IS 'Existing token scope; public room allowlist, org-local day, valid notices and vacant pending preparation. No internal bonus notes.';
COMMENT ON FUNCTION public.get_my_available_rooms() IS 'Existing authenticated owner scope; same sale facts and hold priority as public availability.';

-- Sale channels share the same operational facts. Existing scope and ACL are preserved.
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
            CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(br.id,br.organization_id,br.status::text,bpl.id IS NOT NULL,
              COALESCE((SELECT prs.soon_days FROM public.public_room_settings prs WHERE prs.owner_id=b0.user_id AND (prs.organization_id=p_organization_id OR prs.organization_id IS NULL) LIMIT 1),30)) fact
            WHERE br.building_id=b0.id AND br.organization_id=p_organization_id AND br.deleted_at IS NULL
              AND fact.status_public IN ('free','soon','pass')
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
        'status_public', rs.status_public, 'avail_date', rs.avail_date,
        'sale_state', rs.sale_state, 'sale_today', rs.sale_today, 'expected_ready_on', rs.expected_ready_on
      ) ORDER BY rs.floor DESC, rs.name)
      FROM (
        SELECT rs0.*
        FROM (
          SELECT r.id, r.building_id, r.floor, r.name, r.code, r.area, r.rent_price, r.deposit_amount, r.max_occupants,
                 r.amenities, r.images, r.description, r.sale_note, r.room_type,
                 CASE WHEN fact.status_public='pass' THEN pl.sale_policy END AS pass_sale_policy,
                 CASE WHEN fact.status_public='pass' THEN pl.pass_price END AS pass_price,
                 CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date END AS pass_avail_date,
                 COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
                 fact.status_public,fact.avail_date,fact.sale_state,fact.sale_today,fact.expected_ready_on
          FROM public.rooms r
          JOIN public.buildings b ON b.id = r.building_id
          LEFT JOIN public.public_room_settings prs ON prs.owner_id = b.user_id AND (prs.organization_id = p_organization_id OR prs.organization_id IS NULL)
          LEFT JOIN public.room_pass_listings pl ON pl.room_id = r.id AND pl.user_id = b.user_id AND (pl.organization_id = p_organization_id OR pl.organization_id IS NULL) AND pl.active = true
          CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(r.id,r.organization_id,r.status::text,pl.id IS NOT NULL,COALESCE(prs.soon_days,30)) fact
          WHERE r.organization_id=p_organization_id AND r.building_id = ANY(v_buildings)
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
$function$;

CREATE OR REPLACE FUNCTION public.zalo_phong_trong_cho_worker_v1(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_soon    int;
  v_hotline uuid;
  v_today   date;
  v_result  jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RETURN jsonb_build_object('areas','[]'::jsonb,'buildings','[]'::jsonb,'rooms','[]'::jsonb,'contact',NULL);
  END IF;

  SELECT prs.soon_days, prs.hotline_id INTO v_soon, v_hotline
    FROM public.public_room_settings prs
   WHERE prs.organization_id = p_organization_id
   LIMIT 1;
  IF v_soon IS NULL THEN v_soon := 30; END IF;

  v_today := public.org_today_v1(p_organization_id);

  WITH rms AS (
    SELECT
      rm.id, rm.building_id, rm.floor, rm.name, rm.code, rm.area,
      rm.rent_price, rm.deposit_amount, rm.max_occupants,
      COALESCE(rm.amenities, '[]'::jsonb) AS amenities,
      COALESCE(rm.images,    '[]'::jsonb) AS images,
      rm.description, rm.sale_note, rm.room_type,
      -- contact_manager = che liên hệ của khách, chỉ để lại "liên hệ quản lý".
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_name END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_phone END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN pl.sale_policy END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      fact.status_public,fact.avail_date,fact.sale_state,fact.sale_today,fact.expected_ready_on
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = rm.id
     AND pl.active = true
     AND (pl.organization_id = p_organization_id OR pl.organization_id IS NULL)
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,v_soon) fact
    WHERE rm.organization_id=p_organization_id AND b.organization_id = p_organization_id
      AND b.is_virtual = false
      AND b.deleted_at IS NULL
      AND rm.deleted_at IS NULL
  ),
  bld_ids AS (
    SELECT DISTINCT building_id FROM rms WHERE status_public IN ('free','soon','pass')
  ),
  rooms_j AS (
    SELECT jsonb_agg(to_jsonb(rms) ORDER BY rms.floor DESC, rms.name) AS j
      FROM rms
     WHERE rms.building_id IN (SELECT building_id FROM bld_ids)
       AND rms.status_public IN ('free','soon','pass')
  ),
  blds_j AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'code', b.code,
      'area_ids', COALESCE((SELECT jsonb_agg(ab.area_id)
                              FROM public.area_buildings ab
                              JOIN public.areas a ON a.id = ab.area_id
                             WHERE ab.building_id = b.id AND a.deleted_at IS NULL), '[]'::jsonb),
      'district', b.district, 'ward', b.ward,
      'address', CASE
                   WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%' THEN b.street_address
                   ELSE concat_ws(', ', NULLIF(b.street_address,''), NULLIF(b.ward,''),
                                        NULLIF(b.district,''), NULLIF(b.province,''))
                 END,
      'total_floors', b.total_floors,
      'images', COALESCE(b.images, '[]'::jsonb),
      'public_contact_name',  b.public_contact_name,
      'public_contact_phone', b.public_contact_phone,
      'public_map_url',       b.public_map_url,
      'public_lift_type',     b.public_lift_type,
      'elec_rate', (
        SELECT COALESCE(bs.unit_price_override, s.unit_price)
          FROM public.building_services bs
          JOIN public.services s ON s.id = bs.service_id
         WHERE bs.building_id = b.id AND bs.is_active = true
           AND s.deleted_at IS NULL AND s.unit ILIKE 'kwh'
         ORDER BY (s.type = 'FIXED') DESC, s.unit_price
         LIMIT 1
      )
    ) ORDER BY b.name) AS j
      FROM public.buildings b
     WHERE b.id IN (SELECT building_id FROM bld_ids)
  ),
  areas_j AS (
    SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.name) AS j
      FROM public.areas a
     WHERE a.organization_id = p_organization_id AND a.deleted_at IS NULL
  ),
  contact_j AS (
    SELECT jsonb_build_object('name', h.name, 'phone', h.phone_number) AS j
      FROM public.hotlines h
     WHERE h.organization_id = p_organization_id
       AND COALESCE(h.is_active, true) = true
       AND (v_hotline IS NULL OR h.id = v_hotline)
     ORDER BY (h.id = v_hotline) DESC NULLS LAST, h.created_at
     LIMIT 1
  )
  SELECT jsonb_build_object(
    'areas',     COALESCE((SELECT j FROM areas_j), '[]'::jsonb),
    'buildings', COALESCE((SELECT j FROM blds_j),  '[]'::jsonb),
    'rooms',     COALESCE((SELECT j FROM rooms_j), '[]'::jsonb),
    'contact',   (SELECT j FROM contact_j)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.copilot_available_rooms_v1(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.copilot_available_rooms_v1(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_phong_trong_cho_worker_v1(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_phong_trong_cho_worker_v1(uuid) TO service_role;
NOTIFY pgrst,'reload schema';
