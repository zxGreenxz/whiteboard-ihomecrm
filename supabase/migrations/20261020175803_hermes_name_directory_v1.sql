-- B5d: danh bạ toà/phòng TRONG PHẠM VI để connector giải TÊN → ID cho mọi tool đọc danh sách (21/10/2026).
--
-- Sự cố 21/10 00:11 VN: "khách nào đang ở phòng London 5 950NK" → mô hình gọi crm_read_customers
-- {buildingId:<UUID đúng>, query:"LONDON 5"} → 0 dòng: lõi chỉ khớp tên/SĐT khách, không tool nào nhận
-- tên toà/phòng, crm_auth_context không trả danh sách toà. Connector nay nhận buildingName/roomName,
-- giải thành ID qua ba hàm dưới rồi gọi RPC đọc NHƯ CŨ (các hàm đọc hermes_domain_read_* không đổi,
-- hermes_request_v1 vẫn khoá đúng tập khoá input).
--  (1) public.hermes_building_directory_v1(org, toà[]) — SECURITY INVOKER dưới RLS của người hỏi:
--      {"buildings":[{id,name,code}]} của các toà trong danh sách mà RLS cho thấy, bỏ deleted_at và
--      is_virtual, sắp theo name rồi id. Toà ngoài RLS đơn giản không xuất hiện (không lộ tên).
--  (2) public.hermes_room_directory_v1(org, toà[], tên) — SECURITY INVOKER: {"rooms":[{id,name,code,floor,
--      buildingId}]} phòng trong các toà đó khớp tên/mã không phân biệt hoa thường (khớp BẰNG trước; không
--      có thì CHỨA), bỏ phòng deleted_at và phòng của toà deleted_at/is_virtual, tối đa 50 dòng.
--  (3) public.hermes_organization_name_v1(org) — helper DEFINER nhỏ trả {"id","name"} của CHÍNH công ty mà
--      người gọi là thành viên ACTIVE (RLS organizations không cho người dùng thường đọc dòng của mình —
--      cùng lý do get_my_organizations, 20260809030000). Không nhận org khác (42501).
-- Trả jsonb OBJECT (không phải mảng/scalar) vì transport bound-user-rpc của connector chỉ nhận object.
-- Không ghi dữ liệu; không đổi hàm đọc; không hàm copilot_*.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE item text[];
BEGIN
  FOREACH item SLICE 1 IN ARRAY ARRAY[['public.buildings','name'],['public.buildings','code'],['public.buildings','is_virtual'],
    ['public.buildings','deleted_at'],['public.buildings','organization_id'],['public.rooms','name'],['public.rooms','code'],
    ['public.rooms','floor'],['public.rooms','deleted_at'],['public.rooms','building_id'],['public.organizations','name'],
    ['public.organizations','status'],['public.organization_memberships','revoked_at'],['public.organization_memberships','valid_to']] LOOP
    IF to_regclass(item[1]) IS NULL OR NOT EXISTS(SELECT 1 FROM pg_attribute
        WHERE attrelid=to_regclass(item[1]) AND attname=item[2] AND attnum>0 AND NOT attisdropped) THEN
      RAISE EXCEPTION 'hermes_name_directory_dependency_invalid: %.%',item[1],item[2]; END IF;
  END LOOP;
  IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('auth.role()') IS NULL THEN
    RAISE EXCEPTION 'hermes_name_directory_dependency_invalid: auth.uid()/auth.role()'; END IF;
END $requires$;

-- 1. Danh bạ toà trong danh sách, dưới RLS của người hỏi (INVOKER; thân plpgsql không nêu app_private).
CREATE OR REPLACE FUNCTION public.hermes_building_directory_v1(p_organization_id uuid,p_building_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_result jsonb;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'hermes_name_directory_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_building_ids IS NULL OR array_ndims(p_building_ids) IS DISTINCT FROM 1
    OR cardinality(p_building_ids)<1 OR cardinality(p_building_ids)>256 OR array_position(p_building_ids,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'hermes_name_directory_invalid' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',b.id,'name',b.name,'code',b.code) ORDER BY b.name,b.id),'[]'::jsonb) INTO v_result
    FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND b.id=ANY(p_building_ids) AND b.deleted_at IS NULL AND NOT b.is_virtual;
  RETURN jsonb_build_object('buildings',v_result);
END $fn$;

-- 2. Danh bạ phòng theo tên/mã trong các toà đã cho, dưới RLS của người hỏi (INVOKER).
CREATE OR REPLACE FUNCTION public.hermes_room_directory_v1(p_organization_id uuid,p_building_ids uuid[],p_room_name text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_needle text; v_result jsonb;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'hermes_name_directory_denied' USING ERRCODE='42501'; END IF;
  v_needle:=lower(btrim(p_room_name));
  IF p_organization_id IS NULL OR p_building_ids IS NULL OR array_ndims(p_building_ids) IS DISTINCT FROM 1
    OR cardinality(p_building_ids)<1 OR cardinality(p_building_ids)>256 OR array_position(p_building_ids,NULL) IS NOT NULL
    OR v_needle IS NULL OR v_needle='' OR char_length(v_needle)>60 OR v_needle ~ '[\x01-\x1f\x7f]' THEN
    RAISE EXCEPTION 'hermes_name_directory_invalid' USING ERRCODE='22023'; END IF;
  WITH candidate AS (
    SELECT r.id,r.name,r.code,r.floor,r.building_id,b.name AS building_name,
      (lower(r.name)=v_needle OR lower(COALESCE(r.code,''))=v_needle) AS exact
    FROM public.rooms r JOIN public.buildings b ON b.id=r.building_id
    WHERE b.organization_id=p_organization_id AND b.id=ANY(p_building_ids) AND b.deleted_at IS NULL AND NOT b.is_virtual
      AND r.deleted_at IS NULL
      AND (position(v_needle IN lower(r.name))>0 OR position(v_needle IN lower(COALESCE(r.code,'')))>0)),
  chosen AS (
    SELECT c.* FROM candidate c WHERE c.exact OR NOT EXISTS(SELECT 1 FROM candidate e WHERE e.exact)
    ORDER BY c.building_name,c.building_id,c.name,c.id LIMIT 50)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'code',c.code,'floor',c.floor,'buildingId',c.building_id)
    ORDER BY c.building_name,c.building_id,c.name,c.id),'[]'::jsonb) INTO v_result FROM chosen c;
  RETURN jsonb_build_object('rooms',v_result);
END $fn$;

-- 3. Tên công ty của chính người gọi (thành viên ACTIVE, còn hiệu lực); công ty khác hoặc không ACTIVE ⇒ 42501.
CREATE OR REPLACE FUNCTION public.hermes_organization_name_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_actor uuid:=auth.uid(); v_now timestamptz:=now(); v_name text;
BEGIN
  IF p_organization_id IS NULL THEN RAISE EXCEPTION 'organization_required' USING ERRCODE='22023'; END IF;
  IF v_actor IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE='42501'; END IF;
  SELECT o.name INTO v_name FROM public.organizations o
    WHERE o.id=p_organization_id AND o.status='ACTIVE'
      AND EXISTS(SELECT 1 FROM public.organization_memberships m
        WHERE m.organization_id=o.id AND m.user_id=v_actor AND m.status='ACTIVE' AND m.revoked_at IS NULL
          AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=v_now AND (m.valid_to IS NULL OR m.valid_to>v_now));
  IF v_name IS NULL THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('id',p_organization_id,'name',v_name);
END $fn$;

ALTER FUNCTION public.hermes_building_directory_v1(uuid,uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_building_directory_v1(uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_building_directory_v1(uuid,uuid[]) TO authenticated;
ALTER FUNCTION public.hermes_room_directory_v1(uuid,uuid[],text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_room_directory_v1(uuid,uuid[],text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_room_directory_v1(uuid,uuid[],text) TO authenticated;
ALTER FUNCTION public.hermes_organization_name_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_organization_name_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_organization_name_v1(uuid) TO authenticated;
COMMENT ON FUNCTION public.hermes_building_directory_v1(uuid,uuid[]) IS
  'Hermes: danh bạ toà {id,name,code} trong danh sách toà đã cho, dưới RLS người hỏi; bỏ deleted_at/is_virtual; connector giải buildingName → buildingId.';
COMMENT ON FUNCTION public.hermes_room_directory_v1(uuid,uuid[],text) IS
  'Hermes: phòng {id,name,code,floor,buildingId} khớp tên/mã (bằng trước, chứa sau) trong các toà đã cho, dưới RLS người hỏi, ≤50; connector giải roomName.';
COMMENT ON FUNCTION public.hermes_organization_name_v1(uuid) IS
  'Hermes: tên công ty của chính người gọi (thành viên ACTIVE); crm_auth_context trả organizationName.';

-- Tự kiểm trước khi commit: đúng quyền, đúng tính chất hàm, đúng nguồn vị từ.
DO $assert$
DECLARE p record; signature text; src text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['public.hermes_building_directory_v1(uuid,uuid[])','public.hermes_room_directory_v1(uuid,uuid[],text)',
    'public.hermes_organization_name_v1(uuid)'] LOOP
    IF has_function_privilege('anon',signature,'EXECUTE') OR has_function_privilege('service_role',signature,'EXECUTE')
      OR has_function_privilege('hermes_store_executor',signature,'EXECUTE') OR NOT has_function_privilege('authenticated',signature,'EXECUTE')
      THEN RAISE EXCEPTION 'hermes name directory ACL: %',signature; END IF;
    SELECT pr.prosecdef,pr.provolatile,pg_get_userbyid(pr.proowner) AS owner INTO p FROM pg_proc pr WHERE pr.oid=to_regprocedure(signature);
    IF NOT FOUND OR p.provolatile<>'s' OR p.owner<>'postgres'
      OR p.prosecdef<>(signature='public.hermes_organization_name_v1(uuid)') THEN
      RAISE EXCEPTION 'hermes name directory definition: %',signature; END IF;
  END LOOP;
  src:=pg_get_functiondef('public.hermes_building_directory_v1(uuid,uuid[])'::regprocedure);
  IF position('b.deleted_at IS NULL AND NOT b.is_virtual' IN src)=0 OR position('app_private' IN src)>0 THEN
    RAISE EXCEPTION 'hermes name directory source: buildings'; END IF;
  src:=pg_get_functiondef('public.hermes_room_directory_v1(uuid,uuid[],text)'::regprocedure);
  IF position('r.deleted_at IS NULL' IN src)=0 OR position('LIMIT 50' IN src)=0 OR position('app_private' IN src)>0 THEN
    RAISE EXCEPTION 'hermes name directory source: rooms'; END IF;
  src:=pg_get_functiondef('public.hermes_organization_name_v1(uuid)'::regprocedure);
  IF position('m.revoked_at IS NULL' IN src)=0 OR position('o.status=''ACTIVE''' IN src)=0 THEN
    RAISE EXCEPTION 'hermes name directory source: organization'; END IF;
END
$assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
