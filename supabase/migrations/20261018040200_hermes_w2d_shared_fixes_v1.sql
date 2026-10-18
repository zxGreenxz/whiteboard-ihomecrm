-- Đọc đầy đủ đợt 2 — Gói D: sửa HÀM DÙNG CHUNG sau review độc lập PR #203 (head 42602682, 18/10/2026).
-- Chạy SAU 20261018040000 (đã có bản áp trên TEST nên không sửa file đó). Như 040000, file này chỉ có hàm dùng chung
-- public (RPC web gọi được), không hàm trợ lý nào. Không DROP, không đổi chữ ký/kiểu trả về, không ALTER TABLE, không
-- ghi dữ liệu.
--  (P1) public.areas_in_scope_v1 không còn là DEFINER trả payload thay RLS areas: nay SECURITY INVOKER, đọc areas DƯỚI
--       RLS của người hỏi như web useAreas.ts:31-50 (lọc organization_id tường minh). RLS chặn thì trợ lý cũng không
--       thấy; sửa RLS areas (areas_select_rbac còn đọc staff_assignments) là việc của PR vá lỗ hổng riêng.
--       buildings_list_v1/areas_list_v1 gọi helper này nên tự theo RLS, không cần thay.
--  (P3) public.report_text_v1 có guard current_user = authenticated như các hàm public khác.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('public.areas_in_scope_v1(uuid)') IS NULL OR to_regprocedure('public.report_text_v1(text,integer)') IS NULL THEN
    RAISE EXCEPTION 'w2d_shared_fixes_requires_shared_functions';
  END IF;
END $requires$;

-- (P3) Chữ an toàn cho đầu ra: như 040000, thêm guard vai (đổi sang plpgsql STABLE để kiểm current_user/auth.uid()).
CREATE OR REPLACE FUNCTION public.report_text_v1(p_text text,p_max integer)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  RETURN CASE WHEN p_text IS NULL THEN NULL ELSE left(btrim(regexp_replace(
    translate(replace(p_text,chr(13)||chr(10),chr(10)),chr(13)||chr(8232)||chr(8233),chr(10)||chr(10)||chr(10)),
    '[\x01-\x09\x0b-\x1f\x7f-\x9f]','','g'),' '||chr(10)),GREATEST(COALESCE(p_max,0),0)) END;
END $fn$;

-- (P1) Khu của công ty DƯỚI RLS areas của người hỏi (như web useAreas: chưa xoá, mới tạo trước). Cùng chữ ký/kiểu trả về
-- như 040000 để buildings_list_v1/areas_list_v1 không phải thay.
CREATE OR REPLACE FUNCTION public.areas_in_scope_v1(p_organization_id uuid)
RETURNS TABLE(area_id uuid,code text,name text,status text,created_at timestamptz,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission buildings) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('buildings','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT a.id,a.code,a.name,a.status,a.created_at,a.organization_id FROM public.areas a
  WHERE a.organization_id=p_organization_id AND a.deleted_at IS NULL
  ORDER BY a.created_at DESC,a.id;
END $fn$;

ALTER FUNCTION public.report_text_v1(text,integer) OWNER TO postgres;
ALTER FUNCTION public.areas_in_scope_v1(uuid) OWNER TO postgres;
-- ACL như 20261018040000 (nêu lại để file tự đủ): hàm dùng chung chỉ cho người đăng nhập.
REVOKE ALL ON FUNCTION public.report_text_v1(text,integer),public.areas_in_scope_v1(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.report_text_v1(text,integer),public.areas_in_scope_v1(uuid) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
