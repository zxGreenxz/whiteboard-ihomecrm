-- Opt-in to one ready room on one public link. Existing links have no exceptions.
CREATE TABLE IF NOT EXISTS app_private.public_room_link_ready_rooms (
  token text NOT NULL REFERENCES public.public_room_share_tokens(token) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  building_id uuid NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token, room_id)
);
REVOKE ALL ON app_private.public_room_link_ready_rooms FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_public_room_link_ready_room_v1(p_token text, p_room_id uuid, p_enabled boolean)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, public, app_private
AS $fn$
DECLARE
  actor uuid := auth.uid();
  target public.public_room_share_tokens%ROWTYPE;
  building uuid;
BEGIN
  IF actor IS NULL OR p_room_id IS NULL OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'Invalid room publication request' USING ERRCODE='42501';
  END IF;
  SELECT * INTO target FROM public.public_room_share_tokens t
    WHERE t.token=p_token AND t.owner_id=actor AND t.organization_id IS NOT NULL FOR UPDATE;
  IF NOT FOUND OR NOT app_private.is_org_owner_v1(target.organization_id,actor) THEN
    RAISE EXCEPTION 'Only the organization owner managing this link can publish a room' USING ERRCODE='42501';
  END IF;
  IF NOT p_enabled THEN
    DELETE FROM app_private.public_room_link_ready_rooms WHERE token=p_token AND room_id=p_room_id;
    RETURN false;
  END IF;
  IF target.revoked OR NOT EXISTS (
    SELECT 1 FROM app_private.authorized_scope_v3('sale_phong.manage_tokens',target.organization_id) s
    JOIN public.rooms r ON r.id=p_room_id AND r.organization_id=target.organization_id
    WHERE s.org_wide OR r.building_id=ANY(s.building_ids)
  ) THEN RAISE EXCEPTION 'No publication permission for this link and room' USING ERRCODE='42501'; END IF;
  SELECT b.id INTO building FROM public.rooms r JOIN public.buildings b
    ON b.id=r.building_id AND b.organization_id=r.organization_id
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(r.id,r.organization_id,r.status::text,false,30) f
    WHERE r.id=p_room_id AND r.organization_id=target.organization_id AND b.deleted_at IS NULL
    AND NOT b.is_virtual AND r.deleted_at IS NULL AND f.sale_state='READY';
  IF NOT FOUND THEN RAISE EXCEPTION 'Room is not ready for publication' USING ERRCODE='22023'; END IF;
  INSERT INTO app_private.public_room_link_ready_rooms(token,room_id,building_id,organization_id,owner_id)
    VALUES(p_token,p_room_id,building,target.organization_id,actor)
    ON CONFLICT(token,room_id) DO UPDATE SET building_id=excluded.building_id,
      organization_id=excluded.organization_id,owner_id=excluded.owner_id;
  RETURN true;
END
$fn$;
REVOKE ALL ON FUNCTION public.set_public_room_link_ready_room_v1(text,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.set_public_room_link_ready_room_v1(text,uuid,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_public_available_rooms(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_owner   uuid;
  v_org uuid;
  v_soon    int;
  v_hotline uuid;
  v_sale_policy text;
  v_result  jsonb;
BEGIN
  IF p_token IS NULL OR p_token = '' THEN
    RETURN NULL;
  END IF;

  SELECT owner_id, organization_id INTO v_owner, v_org
  FROM public.public_room_share_tokens
  WHERE token = p_token AND revoked = false;

  IF v_owner IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT soon_days, hotline_id, sale_policy INTO v_soon, v_hotline, v_sale_policy
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
    WHERE (b.user_id = v_owner OR (
        b.organization_id=v_org AND fact.sale_state='READY' AND EXISTS (
          SELECT 1 FROM app_private.public_room_link_ready_rooms g
          WHERE g.token=p_token AND g.owner_id=v_owner AND g.organization_id=v_org
            AND g.room_id=rm.id AND g.building_id=b.id
            AND app_private.is_org_owner_v1(v_org,v_owner)
        )
      ))
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
      'floor_layouts', CASE WHEN b.user_id=v_owner THEN b.floor_layouts ELSE NULL END,
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
    'contact',   (SELECT j FROM contact_j),
    'sale_policy', NULLIF(btrim(v_sale_policy), '')
  ) INTO v_result;

  RETURN app_private.room_sale_policy_overlay_v1(v_result);
END;
$function$;
REVOKE ALL ON FUNCTION public.get_public_available_rooms(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_available_rooms(text) TO anon, authenticated, service_role;

-- Revalidate grants against current room, building, link and organization ownership.
CREATE OR REPLACE FUNCTION app_private.public_room_link_grants_v1(p_org uuid)
RETURNS TABLE(token text, room_id uuid, building_id uuid, owner_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT g.token,g.room_id,g.building_id,g.owner_id
  FROM app_private.public_room_link_ready_rooms g
  JOIN public.public_room_share_tokens t ON t.token=g.token AND t.organization_id=g.organization_id
    AND t.owner_id=g.owner_id AND NOT t.revoked
  JOIN public.rooms r ON r.id=g.room_id AND r.organization_id=g.organization_id AND r.building_id=g.building_id
  JOIN public.buildings b ON b.id=g.building_id AND b.organization_id=g.organization_id
  LEFT JOIN public.public_room_settings ps ON ps.owner_id=g.owner_id
  LEFT JOIN public.room_pass_listings pl ON pl.room_id=r.id AND pl.user_id=g.owner_id AND pl.active
  CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(r.id,r.organization_id,r.status::text,pl.id IS NOT NULL,COALESCE(ps.soon_days,30)) fact
  WHERE fact.sale_state='READY' AND g.organization_id=p_org AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND NOT b.is_virtual
    AND app_private.is_org_owner_v1(g.organization_id,g.owner_id)
$fn$;
REVOKE ALL ON FUNCTION app_private.public_room_link_grants_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.public_sale_rooms_payload_v1(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE v_page_owner uuid; v_extra record; v_room jsonb; v_building jsonb; v_token text; v_page jsonb; v_pages integer:=0; v_areas jsonb:='[]'::jsonb; v_buildings jsonb:='[]'::jsonb;
  v_rooms jsonb:='[]'::jsonb; v_contact jsonb; v_policy jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RETURN jsonb_build_object('areas','[]'::jsonb,'buildings','[]'::jsonb,'rooms','[]'::jsonb,'contact',NULL,'pages',0);
  END IF;
  -- Mọi link của một chủ ra cùng một trang (trang chỉ dùng owner_id) ⇒ một link/chủ. Token không rời hàm.
  FOR v_token,v_page_owner IN SELECT DISTINCT ON (t.owner_id) t.token,t.owner_id FROM public.public_room_share_tokens t
      WHERE t.organization_id=p_organization_id AND t.revoked=false
      ORDER BY t.owner_id,t.created_at,t.token LOOP
    v_page:=public.get_public_available_rooms(v_token);
    IF v_page IS NULL OR jsonb_typeof(v_page->'buildings') IS DISTINCT FROM 'array' OR jsonb_typeof(v_page->'rooms') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Trang Sale phòng của công ty chưa đọc được' USING ERRCODE='55000'; END IF;
    v_pages:=v_pages+1;
    -- Trang trả MỌI phòng của toà còn chỗ (để vẽ sơ đồ tầng); bản tin chỉ chào phòng còn chào được.
    v_rooms:=v_rooms||COALESCE((SELECT jsonb_agg(pr) FROM jsonb_array_elements(v_page->'rooms') pr
      WHERE pr->>'status_public' IN ('free','soon','pass')
        AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=(pr->>'building_id')::uuid AND b.organization_id=p_organization_id AND b.user_id=v_page_owner)),'[]'::jsonb);
    v_buildings:=v_buildings||COALESCE((SELECT jsonb_agg((pb-'floor_layouts') || jsonb_build_object('page_contact_name',v_page#>'{contact,name}', 'page_contact_phone',v_page#>'{contact,phone}', 'page_sale_policy',v_page->'sale_policy')) FROM jsonb_array_elements(v_page->'buildings') pb
      WHERE EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=(pb->>'id')::uuid AND b.organization_id=p_organization_id AND b.user_id=v_page_owner)),'[]'::jsonb);
    IF jsonb_typeof(v_page->'areas')='array' THEN v_areas:=v_areas||(v_page->'areas'); END IF;
    IF v_contact IS NULL AND jsonb_typeof(v_page->'contact')='object' THEN v_contact:=v_page->'contact'; END IF;
    IF v_policy IS NULL AND jsonb_typeof(v_page->'sale_policy')='string' THEN v_policy:=v_page->'sale_policy'; END IF;
  END LOOP;
  -- Một toà chỉ thuộc một chủ; trùng là dữ liệu bất thường ⇒ dừng, không gộp đoán (như Hermes).
  IF (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(v_buildings) x)<>jsonb_array_length(v_buildings)
    OR (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(v_rooms) x)<>jsonb_array_length(v_rooms) THEN
    RAISE EXCEPTION 'Trang Sale phòng của công ty có toà/phòng trùng' USING ERRCODE='55000'; END IF;
  -- Owner pages stay unique. Only explicitly selected ready rooms can contribute
  -- from other links. A room already represented is counted once.
  FOR v_extra IN SELECT g.token,g.room_id,g.building_id FROM app_private.public_room_link_grants_v1(p_organization_id) g ORDER BY g.token,g.room_id LOOP
    IF v_rooms @> jsonb_build_array(jsonb_build_object('id',v_extra.room_id)) THEN CONTINUE; END IF;
    v_page:=public.get_public_available_rooms(v_extra.token);
    SELECT x INTO v_room FROM jsonb_array_elements(v_page->'rooms') x WHERE x->>'id'=v_extra.room_id::text
      AND x->>'building_id'=v_extra.building_id::text AND x->>'sale_state'='READY';
    IF v_room IS NULL THEN CONTINUE; END IF;
    SELECT (x-'floor_layouts') || jsonb_build_object('page_contact_name',v_page#>'{contact,name}', 'page_contact_phone',v_page#>'{contact,phone}', 'page_sale_policy',v_page->'sale_policy') INTO v_building FROM jsonb_array_elements(v_page->'buildings') x
      WHERE x->>'id'=v_extra.building_id::text;
    IF v_building IS NULL THEN CONTINUE; END IF;
    v_rooms:=v_rooms||jsonb_build_array(v_room);
    IF NOT v_buildings @> jsonb_build_array(jsonb_build_object('id',v_extra.building_id)) THEN
      v_buildings:=v_buildings||jsonb_build_array(v_building);
    END IF;
  END LOOP;
  RETURN jsonb_build_object(
    'areas',COALESCE((SELECT jsonb_agg(a ORDER BY a->>'name',a->>'id') FROM (
        SELECT DISTINCT ON (x->>'id') x AS a FROM jsonb_array_elements(v_areas) x ORDER BY x->>'id') d),'[]'::jsonb),
    -- Toà còn ít nhất một phòng chào được; thứ tự tên như trang.
    'buildings',COALESCE((SELECT jsonb_agg(x ORDER BY x->>'name',x->>'id') FROM jsonb_array_elements(v_buildings) x
        WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(v_rooms) r WHERE r->>'building_id'=x->>'id')),'[]'::jsonb),
    'rooms',v_rooms,
    'contact',v_contact,
    'sale_policy',v_policy,
    'pages',v_pages);
END;
$function$;

REVOKE ALL ON FUNCTION app_private.public_sale_rooms_payload_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.zalo_phong_trong_cho_worker_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT jsonb_set(p,'{buildings}',COALESCE((SELECT jsonb_agg(b-ARRAY['page_contact_name','page_contact_phone','page_sale_policy'] ORDER BY ord)
    FROM jsonb_array_elements(p->'buildings') WITH ORDINALITY v(b,ord)),'[]'::jsonb))
  FROM app_private.public_sale_rooms_payload_v1(p_organization_id) p
$fn$;
REVOKE ALL ON FUNCTION public.zalo_phong_trong_cho_worker_v1(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_phong_trong_cho_worker_v1(uuid) TO service_role;

CREATE OR REPLACE FUNCTION app_private.hermes_sale_listing_payload_v1(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_page jsonb; v_pages integer; v_buildings jsonb; v_rooms jsonb;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'hermes_sale_listing_invalid' USING ERRCODE='22023'; END IF;
  v_page:=app_private.public_sale_rooms_payload_v1(p_org);
  v_pages:=(v_page->>'pages')::integer;
    v_buildings:=COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',pb->'id','name',pb->'name','code',pb->'code','district',pb->'district','ward',pb->'ward','address',pb->'address',
        'public_contact_name',pb->'public_contact_name','public_contact_phone',pb->'public_contact_phone',
        'public_lift_type',pb->'public_lift_type',
        'page_contact_name',pb->'page_contact_name','page_contact_phone',pb->'page_contact_phone',
        'page_sale_policy',pb->'page_sale_policy'))
      FROM jsonb_array_elements(v_page->'buildings') pb
      WHERE EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=(pb->>'id')::uuid AND b.organization_id=p_org)),'[]'::jsonb);
    v_rooms:=COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',pr->'id','building_id',pr->'building_id','floor',pr->'floor','name',pr->'name','code',pr->'code',
        'area',pr->'area','rent_price',pr->'rent_price','deposit_amount',pr->'deposit_amount',
        'amenities',pr->'amenities','description',pr->'description','sale_note',pr->'sale_note','room_type',pr->'room_type',
        'status_public',pr->'status_public','sale_state',pr->'sale_state','avail_date',pr->'avail_date',
        'sale_today',pr->'sale_today','expected_ready_on',pr->'expected_ready_on',
        'pass_contact_name',pr->'pass_contact_name','pass_contact_phone',pr->'pass_contact_phone',
        'pass_sale_policy',pr->'pass_sale_policy','pass_price',pr->'pass_price','pass_avail_date',pr->'pass_avail_date',
        'pass_contact_manager',pr->'pass_contact_manager'))
      FROM jsonb_array_elements(v_page->'rooms') pr
      WHERE pr->>'status_public' IN ('free','soon','pass')
        AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=(pr->>'building_id')::uuid AND b.organization_id=p_org)),'[]'::jsonb);
  RETURN jsonb_build_object('pages',v_pages,
    'buildings',COALESCE((SELECT jsonb_agg(x ORDER BY x->>'name',x->>'id') FROM jsonb_array_elements(v_buildings) x),'[]'::jsonb),
    'rooms',COALESCE((SELECT jsonb_agg(x ORDER BY bx->>'name',bx->>'id',(x->>'floor')::numeric DESC NULLS LAST,x->>'name',x->>'id')
      FROM jsonb_array_elements(v_rooms) x JOIN jsonb_array_elements(v_buildings) bx ON bx->>'id'=x->>'building_id'),'[]'::jsonb));
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_available_rooms_page_v1(p_binding jsonb,p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL,
  p_building_name text DEFAULT '',p_statuses text[] DEFAULT NULL,p_limit integer DEFAULT 50,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE plan jsonb; v_org uuid; v_scope uuid[]; v_statuses text[]; v_result jsonb;
BEGIN
  plan:=app_private.hermes_room_page_admission_v1(p_binding);
  v_org:=(plan->>'organizationId')::uuid;
  IF p_organization_id IS NULL OR p_organization_id<>v_org THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(v::uuid ORDER BY v::uuid),'{}'::uuid[]) INTO v_scope FROM jsonb_array_elements_text(plan->'buildingIds') v;
  -- Tập tòa rỗng là từ chối (kết nối không còn tòa nào), không phải trang rỗng.
  IF cardinality(v_scope)<1 THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 2000
    OR p_building_name IS NULL OR char_length(p_building_name)>120
    OR (p_building_ids IS NOT NULL AND (cardinality(p_building_ids)<1 OR cardinality(p_building_ids)>256 OR array_ndims(p_building_ids)<>1
      OR array_position(p_building_ids,NULL) IS NOT NULL OR cardinality(p_building_ids)<>(SELECT count(DISTINCT x) FROM unnest(p_building_ids) x)))
    OR (p_statuses IS NOT NULL AND (cardinality(p_statuses)<1 OR cardinality(p_statuses)>3 OR array_ndims(p_statuses)<>1
      OR EXISTS(SELECT 1 FROM unnest(p_statuses) x WHERE x IS NULL OR x NOT IN ('free','soon','pass'))
      OR cardinality(p_statuses)<>(SELECT count(DISTINCT x) FROM unnest(p_statuses) x)))
    THEN RAISE EXCEPTION 'hermes_rooms_page_invalid' USING ERRCODE='22023'; END IF;
  IF p_building_ids IS NOT NULL THEN
    -- Chỉ thu hẹp: mọi tòa yêu cầu phải nằm trong tập DB đã suy ra; ngoài tập là từ chối, không cắt bớt âm thầm.
    IF NOT(p_building_ids<@v_scope) THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;
    SELECT COALESCE(array_agg(x ORDER BY x),'{}'::uuid[]) INTO v_scope FROM unnest(p_building_ids) x;
  END IF;
  v_statuses:=COALESCE(p_statuses,ARRAY['free','soon','pass']);
  -- Chép vị từ chọn trang của public.get_public_available_rooms: chủ có link còn hiệu lực của
  -- công ty (publishedPages = số chủ), tòa thật của chủ đó, cấu hình/hotline theo chủ.
  WITH owners AS MATERIALIZED (
    SELECT t.owner_id FROM public.public_room_share_tokens t
    WHERE t.organization_id=v_org AND t.revoked=false
    GROUP BY t.owner_id
  ),
  grants AS MATERIALIZED (SELECT * FROM app_private.public_room_link_grants_v1(v_org) WHERE building_id=ANY(v_scope)),
  cb AS MATERIALIZED (
    SELECT b.id,b.name,b.code,pub.owner_id, (o.owner_id IS NOT NULL) AS owned,b.public_contact_name,b.public_contact_phone,
      CASE WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%' THEN b.street_address
        ELSE concat_ws(', ',NULLIF(b.street_address,''),NULLIF(b.ward,''),NULLIF(b.district,''),NULLIF(b.province,'')) END AS address,
      COALESCE(ps.soon_days,30) AS soon_days,NULLIF(btrim(ps.sale_policy),'') AS page_sale_policy,
      h.name AS page_contact_name,h.phone_number AS page_contact_phone
    FROM public.buildings b
    LEFT JOIN owners o ON o.owner_id=b.user_id
    CROSS JOIN LATERAL (SELECT COALESCE(o.owner_id,(SELECT g.owner_id FROM grants g WHERE g.building_id=b.id ORDER BY g.token,g.room_id LIMIT 1)) AS owner_id) pub
    LEFT JOIN public.public_room_settings ps ON ps.owner_id=pub.owner_id
    LEFT JOIN LATERAL (
      SELECT h.name,h.phone_number FROM public.hotlines h
      WHERE h.user_id=pub.owner_id AND COALESCE(h.is_active,true)=true AND (ps.hotline_id IS NULL OR h.id=ps.hotline_id)
      ORDER BY (h.id=ps.hotline_id) DESC NULLS LAST,h.created_at LIMIT 1) h ON true
    WHERE pub.owner_id IS NOT NULL AND b.organization_id=v_org AND b.is_virtual=false AND b.deleted_at IS NULL AND b.id=ANY(v_scope)
      AND (p_building_name='' OR strpos(lower(b.name),lower(p_building_name))>0)
  ),
  facts AS MATERIALIZED (
    SELECT rm.id,rm.building_id,rm.floor,rm.name,rm.code,rm.area,rm.rent_price,rm.deposit_amount,
      COALESCE(rm.amenities,'[]'::jsonb) AS amenities,left(rm.description,241) AS description,left((SELECT CASE WHEN active.txt IS NULL THEN rm.sale_note ELSE concat_ws(E'\n',NULLIF(btrim(rm.sale_note),''),active.txt) END FROM (SELECT app_private.room_sale_policy_active_text_v1(rm.organization_id,rm.id,statement_timestamp()) AS txt) active),241) AS sale_note,left(rm.room_type,121) AS room_type,
      -- Overlay khách pass đúng chủ và active; contact_manager ⇒ che tên/SĐT khách như trang.
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN left(pl.contact_name,81) END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN left(pl.contact_phone,81) END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN left(pl.sale_policy,241) END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      fact.status_public,fact.sale_state,fact.avail_date,fact.sale_today,fact.expected_ready_on
    FROM public.rooms rm
    JOIN cb ON cb.id=rm.building_id
    LEFT JOIN public.room_pass_listings pl ON pl.room_id=rm.id AND cb.owned AND pl.user_id=cb.owner_id AND pl.active=true
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,cb.soon_days) fact
    WHERE rm.organization_id=v_org AND rm.deleted_at IS NULL AND (cb.owned OR
      (fact.sale_state='READY' AND EXISTS (SELECT 1 FROM grants g WHERE g.room_id=rm.id AND g.building_id=rm.building_id)))
  ),
  listed AS MATERIALIZED (
    SELECT f.*,row_number() OVER (ORDER BY cb.name,cb.id,f.floor DESC NULLS LAST,f.name,f.id) AS rn
    FROM facts f JOIN cb ON cb.id=f.building_id
    WHERE f.status_public IN ('free','soon','pass') AND f.status_public=ANY(v_statuses)
  ),
  total AS (SELECT count(*)::integer AS n FROM listed),
  page AS (SELECT * FROM listed WHERE rn>p_offset AND rn<=p_offset+p_limit),
  rooms_j AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'building_id',p.building_id,'floor',p.floor,'name',p.name,'code',p.code,
      'area',p.area,'rent_price',p.rent_price,'deposit_amount',p.deposit_amount,'amenities',p.amenities,'description',p.description,
      'sale_note',p.sale_note,'room_type',p.room_type,'status_public',p.status_public,'sale_state',p.sale_state,'avail_date',p.avail_date,
      'sale_today',p.sale_today,'expected_ready_on',p.expected_ready_on,'pass_contact_name',p.pass_contact_name,
      'pass_contact_phone',p.pass_contact_phone,'pass_sale_policy',p.pass_sale_policy,'pass_price',p.pass_price,
      'pass_avail_date',p.pass_avail_date,'pass_contact_manager',p.pass_contact_manager) ORDER BY p.rn),'[]'::jsonb) AS j
    FROM page p
  ),
  blds_j AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',cb.id,'name',cb.name,'code',cb.code,'address',left(cb.address,301),
      'public_contact_name',left(cb.public_contact_name,121),'public_contact_phone',left(cb.public_contact_phone,65),
      'page_contact_name',left(cb.page_contact_name,121),'page_contact_phone',left(cb.page_contact_phone,65)) ORDER BY cb.name,cb.id),'[]'::jsonb) AS j
    FROM cb WHERE cb.id IN (SELECT building_id FROM page)
  ),
  policies_j AS (
    SELECT COALESCE(jsonb_agg(x.page_sale_policy ORDER BY x.first_rn),'[]'::jsonb) AS j FROM (
      SELECT cb.page_sale_policy,min(l.rn) AS first_rn FROM listed l JOIN cb ON cb.id=l.building_id
      WHERE cb.page_sale_policy IS NOT NULL GROUP BY cb.page_sale_policy) x
  )
  SELECT jsonb_build_object('publishedPages',(SELECT count(*) FROM owners),'totalCount',(SELECT n FROM total),
    'offset',p_offset,'limit',p_limit,
    'nextOffset',CASE WHEN p_offset+p_limit<(SELECT n FROM total) AND p_offset+p_limit<=2000 THEN p_offset+p_limit END,
    'rooms',(SELECT j FROM rooms_j),'buildings',(SELECT j FROM blds_j),'salePolicies',(SELECT j FROM policies_j)) INTO v_result;
  RETURN jsonb_build_object('authority',jsonb_build_object('organizationId',plan->'organizationId','userId',plan->'userId',
    'connectionId',plan->'connectionId','permission',plan->'permission','buildingIds',plan->'buildingIds','cashbookIds',plan->'cashbookIds'),
    'result',v_result);
END $fn$;

REVOKE ALL ON FUNCTION app_private.hermes_sale_listing_payload_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer) TO authenticated;
NOTIFY pgrst, 'reload schema';
