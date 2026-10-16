-- Worker Zalo đọc ĐÚNG trang Sale Phòng/link chia sẻ (16/10/2026), như Hermes đã căn ở
-- 20261016080232/20261016085117. Áp cho ảnh bảng + tin chi tiết của lượt định kỳ lẫn lượt một lần.
--
-- Trước: zalo_phong_trong_cho_worker_v1 (20261010022101) lọc theo CÔNG TY nên
--  (a) lấy cả toà của chủ dữ liệu không có link chia sẻ — toà đó không có trên trang/link;
--  (b) ghép khách pass không theo chủ toà; (c) soon_days/hotline/chính sách lấy một dòng bất kỳ
--      của công ty, trong khi trang lấy theo chủ link.
-- Sau: với mỗi chủ có link còn hiệu lực của công ty, gọi NGUYÊN public.get_public_available_rooms(token)
-- (không viết lại bộ lọc), giữ toà thuộc công ty và phòng free/soon/pass; khu = hợp các trang;
-- liên hệ/chính sách = trang đầu tiên có (công ty một chủ ⇒ đúng trang). Thêm khoá 'pages' (số trang
-- đọc được): 0 ⇒ công ty chưa có link chia sẻ còn hiệu lực — worker báo riêng, không gọi là hết phòng.
-- Giữ chữ ký, kiểu trả về jsonb, STABLE, SECURITY DEFINER, ACL chỉ service_role; vẫn không trả
-- sale_bonus_note (trang công khai cũng không trả). Không ghi dữ liệu.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE OR REPLACE FUNCTION public.zalo_phong_trong_cho_worker_v1(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE v_token text; v_page jsonb; v_pages integer:=0; v_areas jsonb:='[]'::jsonb; v_buildings jsonb:='[]'::jsonb;
  v_rooms jsonb:='[]'::jsonb; v_contact jsonb; v_policy jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RETURN jsonb_build_object('areas','[]'::jsonb,'buildings','[]'::jsonb,'rooms','[]'::jsonb,'contact',NULL,'pages',0);
  END IF;
  -- Mọi link của một chủ ra cùng một trang (trang chỉ dùng owner_id) ⇒ một link/chủ. Token không rời hàm.
  FOR v_token IN SELECT DISTINCT ON (t.owner_id) t.token FROM public.public_room_share_tokens t
      WHERE t.organization_id=p_organization_id AND t.revoked=false
      ORDER BY t.owner_id,t.created_at,t.token LOOP
    v_page:=public.get_public_available_rooms(v_token);
    IF v_page IS NULL OR jsonb_typeof(v_page->'buildings') IS DISTINCT FROM 'array' OR jsonb_typeof(v_page->'rooms') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Trang Sale phòng của công ty chưa đọc được' USING ERRCODE='55000'; END IF;
    v_pages:=v_pages+1;
    -- Trang trả MỌI phòng của toà còn chỗ (để vẽ sơ đồ tầng); bản tin chỉ chào phòng còn chào được.
    v_rooms:=v_rooms||COALESCE((SELECT jsonb_agg(pr) FROM jsonb_array_elements(v_page->'rooms') pr
      WHERE pr->>'status_public' IN ('free','soon','pass')
        AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=(pr->>'building_id')::uuid AND b.organization_id=p_organization_id)),'[]'::jsonb);
    v_buildings:=v_buildings||COALESCE((SELECT jsonb_agg(pb-'floor_layouts') FROM jsonb_array_elements(v_page->'buildings') pb
      WHERE EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=(pb->>'id')::uuid AND b.organization_id=p_organization_id)),'[]'::jsonb);
    IF jsonb_typeof(v_page->'areas')='array' THEN v_areas:=v_areas||(v_page->'areas'); END IF;
    IF v_contact IS NULL AND jsonb_typeof(v_page->'contact')='object' THEN v_contact:=v_page->'contact'; END IF;
    IF v_policy IS NULL AND jsonb_typeof(v_page->'sale_policy')='string' THEN v_policy:=v_page->'sale_policy'; END IF;
  END LOOP;
  -- Một toà chỉ thuộc một chủ; trùng là dữ liệu bất thường ⇒ dừng, không gộp đoán (như Hermes).
  IF (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(v_buildings) x)<>jsonb_array_length(v_buildings)
    OR (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(v_rooms) x)<>jsonb_array_length(v_rooms) THEN
    RAISE EXCEPTION 'Trang Sale phòng của công ty có toà/phòng trùng' USING ERRCODE='55000'; END IF;
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

REVOKE ALL ON FUNCTION public.zalo_phong_trong_cho_worker_v1(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_phong_trong_cho_worker_v1(uuid) TO service_role;

DO $assert$
BEGIN
  IF position('get_public_available_rooms' IN pg_get_functiondef('public.zalo_phong_trong_cho_worker_v1(uuid)'::regprocedure))=0
    OR position('sale_bonus' IN pg_get_functiondef('public.zalo_phong_trong_cho_worker_v1(uuid)'::regprocedure))>0
    THEN RAISE EXCEPTION 'zalo worker rooms parity source'; END IF;
  IF has_function_privilege('anon','public.zalo_phong_trong_cho_worker_v1(uuid)','EXECUTE')
    OR has_function_privilege('authenticated','public.zalo_phong_trong_cho_worker_v1(uuid)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.zalo_phong_trong_cho_worker_v1(uuid)','EXECUTE')
    THEN RAISE EXCEPTION 'zalo worker rooms parity ACL'; END IF;
END
$assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
