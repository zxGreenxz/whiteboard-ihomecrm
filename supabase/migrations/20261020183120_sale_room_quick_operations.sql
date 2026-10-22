-- Local candidate: one scoped inventory and one patch writer for the quick
-- board and Hermes. No occupancy/contract/money fields may be patched here.
CREATE TABLE IF NOT EXISTS app_private.sale_room_change_receipts (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  request_id uuid NOT NULL,
  room_id uuid NOT NULL REFERENCES public.rooms(id),
  payload_hash text NOT NULL,
  before_values jsonb NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, actor_id, request_id)
);
CREATE INDEX IF NOT EXISTS sale_room_change_receipts_room_idx
  ON app_private.sale_room_change_receipts(room_id, created_at DESC);
REVOKE ALL ON app_private.sale_room_change_receipts FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.sale_room_can_v1(p_org uuid, p_building uuid, p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  SELECT auth.uid() IS NOT NULL
    AND COALESCE(p_org = ANY(public.my_org_ids()), false)
    AND COALESCE(public.can_access_building(p_building), false)
    AND EXISTS (
      SELECT 1 FROM app_private.authorized_scope_v3(p_permission, p_org) s
      WHERE s.org_wide OR p_building = ANY(s.building_ids)
    )
$fn$;
REVOKE ALL ON FUNCTION app_private.sale_room_can_v1(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_sale_room_inventory_v1(
  p_organization_id uuid, p_building_id uuid DEFAULT NULL, p_room_id uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false)
    OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id=p_organization_id AND status='ACTIVE')
    OR (public.is_super_admin() AND COALESCE(p_organization_id = ANY(public.sandbox_org_ids()), false)) THEN
    RAISE EXCEPTION 'Không có quyền xem phòng trong tổ chức này' USING ERRCODE='42501';
  END IF;
  WITH allowed_buildings AS MATERIALIZED (
    SELECT b.*,
      app_private.sale_room_can_v1(b.organization_id,b.id,'rooms.edit') AS can_edit,
      app_private.sale_room_can_v1(b.organization_id,b.id,'sale_phong.manage_images') AS can_images,
      app_private.sale_room_can_v1(b.organization_id,b.id,'sale_phong.manage_pass_listings') AS can_pass,
      app_private.sale_room_can_v1(b.organization_id,b.id,'sale_phong.lock_room') AS can_lock,
      app_private.sale_room_can_v1(b.organization_id,b.id,'deposits.create') AS can_deposit
    FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL AND NOT b.is_virtual
      AND (p_building_id IS NULL OR b.id=p_building_id)
      AND (app_private.sale_room_can_v1(b.organization_id,b.id,'rooms.view')
        OR app_private.sale_room_can_v1(b.organization_id,b.id,'sale_phong.view'))
  ), inventory AS MATERIALIZED (
    SELECT r.id, r.building_id, r.floor, r.name, r.code, r.area, r.rent_price,
      r.deposit_amount, r.max_occupants, r.amenities, r.images, r.description,
      r.sale_note, CASE WHEN b.can_edit THEN r.sale_bonus_note END AS sale_bonus_note,
      r.room_type, r.updated_at, md5(to_jsonb(r)::text) AS revision,
      fact.status_public, fact.sale_state, fact.avail_date, fact.sale_today, fact.expected_ready_on,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_name END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_phone END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN pl.sale_policy END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      CASE WHEN lk.id IS NOT NULL THEN jsonb_build_object(
        'id',lk.id,'hours',lk.hours,'note',lk.note,'locked_at',lk.locked_at,'expires_at',lk.expires_at,
        'locked_by_name',COALESCE(NULLIF(btrim(lp.full_name),''),'Người dùng'),
        'locked_by_me',lk.locked_by=auth.uid()) END AS sale_lock,
      jsonb_build_object(
        'edit',b.can_edit,'images',b.can_edit OR b.can_images,'pass',b.can_pass,
        'lock',b.can_lock AND fact.status_public IN ('free','soon') AND lk.id IS NULL,
        'releaseLock',lk.id IS NOT NULL AND ((lk.locked_by=auth.uid() AND b.can_lock) OR b.can_deposit),
        'deposit',b.can_deposit
      ) AS capabilities,
      audit.updated_by_name
    FROM public.rooms r
    JOIN allowed_buildings b ON b.id=r.building_id AND b.organization_id=r.organization_id
    LEFT JOIN public.public_room_settings settings ON settings.owner_id=b.user_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id=r.id AND pl.organization_id=r.organization_id AND pl.active
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(
      r.id,r.organization_id,r.status::text,pl.id IS NOT NULL,COALESCE(settings.soon_days,30)
    ) fact
    LEFT JOIN LATERAL (
      SELECT l.* FROM public.room_sale_locks l
      WHERE l.room_id=r.id AND l.organization_id=r.organization_id
        AND l.released_at IS NULL AND l.expires_at>now()
        AND fact.status_public='rented'
        AND EXISTS (SELECT 1 FROM app_private.room_sale_workflow_base_fact_v1(
          r.id,r.organization_id,r.status::text,pl.id IS NOT NULL,COALESCE(settings.soon_days,30)
        ) base WHERE base.status_public IN ('free','soon'))
      ORDER BY l.locked_at DESC LIMIT 1
    ) lk ON true
    LEFT JOIN public.profiles lp ON lp.id=lk.locked_by
    LEFT JOIN LATERAL (
      SELECT COALESCE(NULLIF(btrim(p.full_name),''),'Người dùng') AS updated_by_name
      FROM app_private.sale_room_change_receipts cr
      LEFT JOIN public.profiles p ON p.id=cr.actor_id
      WHERE cr.room_id=r.id AND cr.organization_id=r.organization_id
        AND cr.response->>'revision'=md5(to_jsonb(r)::text)
      ORDER BY cr.created_at DESC LIMIT 1
    ) audit ON true
    WHERE r.organization_id=p_organization_id AND r.deleted_at IS NULL
      AND (p_room_id IS NULL OR r.id=p_room_id)
  )
  SELECT jsonb_build_object(
    'server_now',now(),'areas','[]'::jsonb,
    'contact',jsonb_build_object('name',NULL,'phone',NULL),
    'rooms',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.building_id,i.floor,i.name,i.id) FROM inventory i),'[]'::jsonb),
    'buildings',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',b.id,'name',b.name,'code',b.code,'district',b.district,'ward',b.ward,
      'address',concat_ws(', ',NULLIF(b.street_address,''),NULLIF(b.ward,''),NULLIF(b.district,''),NULLIF(b.province,'')),
      'total_floors',b.total_floors,'images',b.images,'public_contact_name',b.public_contact_name,
      'public_contact_phone',b.public_contact_phone,'public_map_url',b.public_map_url,
      'public_lift_type',b.public_lift_type
    ) ORDER BY b.name,b.id) FROM allowed_buildings b
      WHERE EXISTS (SELECT 1 FROM inventory i WHERE i.building_id=b.id)),'[]'::jsonb)
  ) INTO result;
  RETURN result;
END
$fn$;
REVOKE ALL ON FUNCTION public.get_sale_room_inventory_v1(uuid,uuid,uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_sale_room_inventory_v1(uuid,uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_room_sale_info_v1(
  p_organization_id uuid, p_room_id uuid, p_expected_revision text,
  p_request_id uuid, p_patch jsonb
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  original public.rooms%ROWTYPE;
  changed public.rooms%ROWTYPE;
  key text;
  element jsonb;
  field_value jsonb;
  images_only boolean;
  edit_allowed boolean;
  image_allowed boolean;
  request_hash text;
  old_receipt app_private.sale_room_change_receipts%ROWTYPE;
  result jsonb;
  before_patch jsonb;
BEGIN
  IF p_room_id IS NULL OR p_request_id IS NULL OR p_organization_id IS NULL
    OR p_expected_revision IS NULL OR p_expected_revision !~ '^[0-9a-f]{32}$'
    OR p_patch IS NULL OR jsonb_typeof(p_patch)<>'object' OR p_patch='{}'::jsonb THEN
    RAISE EXCEPTION 'Thiếu phòng, phiên bản hoặc nội dung cập nhật' USING ERRCODE='22023';
  END IF;
  FOR key,field_value IN SELECT * FROM jsonb_each(p_patch) LOOP
    IF key NOT IN ('rent_price','area','room_type','amenities','sale_note','sale_bonus_note','images','description') THEN
      RAISE EXCEPTION 'Trường không được cập nhật từ Sale Phòng: %',key USING ERRCODE='22023';
    END IF;
    IF key='rent_price' THEN
      IF jsonb_typeof(field_value)<>'number' OR (field_value::text)::numeric<0
        OR (field_value::text)::numeric>9999999999999
        OR trunc((field_value::text)::numeric)<>(field_value::text)::numeric THEN
        RAISE EXCEPTION 'Giá phải là số nguyên VND không âm' USING ERRCODE='22023';
      END IF;
    ELSIF key='area' AND field_value<>'null'::jsonb THEN
      IF jsonb_typeof(field_value)<>'number' OR (field_value::text)::numeric<0
        OR (field_value::text)::numeric>1000000
        OR round((field_value::text)::numeric,2)<>(field_value::text)::numeric THEN
        RAISE EXCEPTION 'Diện tích không hợp lệ' USING ERRCODE='22023';
      END IF;
    ELSIF key IN ('room_type','sale_note','sale_bonus_note','description') AND field_value<>'null'::jsonb THEN
      IF jsonb_typeof(field_value)<>'string'
        OR length(p_patch->>key)>(CASE WHEN key='room_type' THEN 200 ELSE 2000 END) THEN
        RAISE EXCEPTION 'Nội dung trường % không hợp lệ',key USING ERRCODE='22023';
      END IF;
    ELSIF key IN ('amenities','images') THEN
      IF jsonb_typeof(field_value)<>'array' OR jsonb_array_length(field_value)>50 THEN
        RAISE EXCEPTION 'Danh sách % không hợp lệ',key USING ERRCODE='22023';
      END IF;
      FOR element IN SELECT * FROM jsonb_array_elements(field_value) LOOP
        IF jsonb_typeof(element)<>'string' OR length(btrim(element#>>'{}'))=0
          OR length(element#>>'{}')>(CASE WHEN key='images' THEN 2048 ELSE 200 END) THEN
          RAISE EXCEPTION 'Phần tử % không hợp lệ',key USING ERRCODE='22023';
        END IF;
        IF key='images' AND (
          element#>>'{}' ~ '[[:cntrl:]]'
          OR element#>>'{}' ~ '^(blob:|data:|javascript:|file:|http:)'
          OR element#>>'{}' ~ '^//'
          OR (element#>>'{}' ~ ':' AND element#>>'{}' !~ '^https://[^/@[:space:]]+(/|$)')
          OR element#>>'{}' ~ '(^|/)\.\.(/|$)'
        ) THEN
          RAISE EXCEPTION 'Ảnh phải là đường dẫn kho hoặc HTTPS hợp lệ' USING ERRCODE='22023';
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  SELECT r.* INTO original
    FROM public.rooms r JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=r.organization_id
    WHERE r.id=p_room_id AND r.organization_id=p_organization_id
      AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND NOT b.is_virtual;
  IF NOT FOUND OR auth.uid() IS NULL
    OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false)
    OR NOT COALESCE(public.can_access_building(original.building_id),false) THEN
    RAISE EXCEPTION 'Không có quyền cập nhật phòng trong tổ chức/tòa này' USING ERRCODE='42501';
  END IF;
  images_only := p_patch - 'images' = '{}'::jsonb;
  IF NOT app_private.sale_room_can_v1(p_organization_id,original.building_id,'rooms.edit')
    AND NOT (images_only AND app_private.sale_room_can_v1(p_organization_id,original.building_id,'sale_phong.manage_images')) THEN
    RAISE EXCEPTION 'Không có quyền cập nhật thông tin phòng' USING ERRCODE='42501';
  END IF;
  -- Preserve the room -> organization order of the reservation/lock writers.
  SELECT * INTO original FROM public.rooms
    WHERE id=p_room_id AND organization_id=p_organization_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Phòng đã thay đổi' USING ERRCODE='PT409'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  IF NOT EXISTS (SELECT 1 FROM public.buildings WHERE id=original.building_id
      AND organization_id=p_organization_id AND deleted_at IS NULL AND NOT is_virtual)
    OR NOT COALESCE(public.can_access_building(original.building_id),false) THEN
    RAISE EXCEPTION 'Phạm vi phòng đã thay đổi' USING ERRCODE='42501';
  END IF;
  SELECT COALESCE(a.allowed,false) INTO edit_allowed
    FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'rooms.edit',original.building_id,NULL) a;
  IF NOT COALESCE(edit_allowed,false) AND images_only THEN
    SELECT COALESCE(a.allowed,false) INTO image_allowed
      FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'sale_phong.manage_images',original.building_id,NULL) a;
  END IF;
  IF NOT COALESCE(edit_allowed,false) AND NOT COALESCE(image_allowed,false) THEN
    RAISE EXCEPTION 'Quyền cập nhật phòng đã thay đổi' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text||auth.uid()::text||p_request_id::text,0));
  request_hash := md5(jsonb_build_object('room_id',p_room_id,'revision',p_expected_revision,'patch',p_patch)::text);
  SELECT * INTO old_receipt FROM app_private.sale_room_change_receipts
    WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND request_id=p_request_id;
  IF FOUND THEN
    IF old_receipt.payload_hash<>request_hash THEN
      RAISE EXCEPTION 'Mã yêu cầu đã dùng cho nội dung khác' USING ERRCODE='22023';
    END IF;
    RETURN old_receipt.response;
  END IF;
  IF md5(to_jsonb(original)::text)<>p_expected_revision THEN
    RAISE EXCEPTION 'Thông tin phòng đã thay đổi. Tải lại để đối chiếu.' USING ERRCODE='PT409';
  END IF;
  SELECT jsonb_object_agg(k, to_jsonb(original)->k) INTO before_patch FROM jsonb_object_keys(p_patch) k;
  UPDATE public.rooms SET
    rent_price=CASE WHEN p_patch?'rent_price' THEN (p_patch->>'rent_price')::numeric ELSE rent_price END,
    area=CASE WHEN p_patch?'area' THEN (p_patch->>'area')::numeric ELSE area END,
    room_type=CASE WHEN p_patch?'room_type' THEN p_patch->>'room_type' ELSE room_type END,
    amenities=CASE WHEN p_patch?'amenities' THEN p_patch->'amenities' ELSE amenities END,
    sale_note=CASE WHEN p_patch?'sale_note' THEN p_patch->>'sale_note' ELSE sale_note END,
    sale_bonus_note=CASE WHEN p_patch?'sale_bonus_note' THEN p_patch->>'sale_bonus_note' ELSE sale_bonus_note END,
    images=CASE WHEN p_patch?'images' THEN p_patch->'images' ELSE images END,
    description=CASE WHEN p_patch?'description' THEN p_patch->>'description' ELSE description END,
    updated_at=clock_timestamp()
  WHERE id=p_room_id AND organization_id=p_organization_id RETURNING * INTO changed;
  result := jsonb_build_object('room_id',changed.id,'building_id',changed.building_id,
    'revision',md5(to_jsonb(changed)::text),'updated_at',changed.updated_at,
    'request_id',p_request_id,'fields',p_patch);
  INSERT INTO app_private.sale_room_change_receipts
    (organization_id,actor_id,request_id,room_id,payload_hash,before_values,response)
    VALUES(p_organization_id,auth.uid(),p_request_id,p_room_id,request_hash,before_patch,result);
  RETURN result;
END
$fn$;
REVOKE ALL ON FUNCTION public.update_room_sale_info_v1(uuid,uuid,text,uuid,jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.update_room_sale_info_v1(uuid,uuid,text,uuid,jsonb) TO authenticated;
COMMENT ON FUNCTION public.update_room_sale_info_v1(uuid,uuid,text,uuid,jsonb)
  IS 'Scoped sale metadata patch with exact revision, per-actor durable receipt and authority recheck. Occupancy and money remain owned by canonical workflows.';
