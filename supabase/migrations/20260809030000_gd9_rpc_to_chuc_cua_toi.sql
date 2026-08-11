-- =============================================================================
-- GĐ9 — RPC cho khái niệm "tổ chức hiện tại" ở frontend
--
-- Kế hoạch ghi: "frontend chưa có khái niệm 'tổ chức hiện tại', không có
-- OrganizationContext nào". Đúng — `useMyContext` chỉ phân loại super/staff/owner.
--
-- VÌ SAO PHẢI CÓ RPC CHỨ KHÔNG ĐỌC THẲNG BẢNG. Đo bằng vai người dùng thường
-- (nathan, org aaaa) trong BEGIN…ROLLBACK:
--     SELECT count(*) FROM organization_memberships  → 0
--     SELECT count(*) FROM organizations             → 0
--     my_org_ids()                                   → aaaa…  ✓
-- Tức RLS của hai bảng đó KHÔNG cho người dùng thường đọc, kể cả dòng của chính
-- mình. Frontend gọi thẳng sẽ nhận mảng rỗng và hiển thị "không thuộc tổ chức
-- nào" cho MỌI người — sai mà không có lỗi nào nổ ra.
--
-- Cùng lý do và cùng khuôn với `get_my_context` đã có: "RLS của staff_assignments
-- chỉ cho owner đọc — dùng RPC SECURITY DEFINER để staff thấy được context của
-- chính mình."
--
-- PHẠM VI HÀM CỐ Ý HẸP. Nó chỉ trả về tổ chức mà CHÍNH NGƯỜI GỌI có membership
-- ACTIVE, lọc bằng auth.uid() ngay trong thân hàm — không nhận tham số user_id.
-- Hàm SECURITY DEFINER bỏ qua RLS, nên mọi tham số nhận từ client đều là một
-- đường để hỏi thay người khác; không nhận tham số thì không có đường đó.
--
-- Trả jsonb thay vì SETOF: frontend cần biết phân biệt "chưa nạp xong" với
-- "nạp xong và thuộc 0 tổ chức", mà mảng rỗng thì không phân biệt được hai
-- trạng thái đó nếu lẫn với lỗi mạng.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.get_my_organizations()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $f$
  SELECT jsonb_build_object(
    'user_id', (SELECT auth.uid()),
    'organizations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id',          o.id,
               'name',        o.name,
               'slug',        o.slug,
               'member_type', m.member_type)
             ORDER BY o.name)
        FROM public.organization_memberships m
        JOIN public.organizations o ON o.id = m.organization_id
       WHERE m.user_id = (SELECT auth.uid())
         AND m.status = 'ACTIVE'
    ), '[]'::jsonb)
  );
$f$;

COMMENT ON FUNCTION public.get_my_organizations() IS
  'Tổ chức mà NGƯỜI ĐANG GỌI có membership ACTIVE. SECURITY DEFINER vì RLS của organizations/organization_memberships không cho người dùng thường đọc dòng của chính mình. Không nhận tham số — mọi tham số đều là đường hỏi thay người khác.';

REVOKE EXECUTE ON FUNCTION public.get_my_organizations() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_my_organizations() TO authenticated;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — đo bằng vai thật, không suy từ thân hàm.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_uid  uuid;
  v_kq   jsonb;
  v_n    int;
BEGIN
  IF has_function_privilege('anon', 'public.get_my_organizations()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon gọi được get_my_organizations — bề mặt ẩn danh không được phơi thêm. DỪNG.';
  END IF;

  -- Người dùng thường: suy TỪ DATABASE, không hard-code.
  SELECT m.user_id INTO v_uid
    FROM public.organization_memberships m
   WHERE m.status = 'ACTIVE'
     AND NOT EXISTS (SELECT 1 FROM public.super_admins s WHERE s.user_id = m.user_id)
   ORDER BY m.user_id LIMIT 1;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Không có người dùng thường nào để nghiệm thu. DỪNG.';
  END IF;

  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_kq := public.get_my_organizations();
  RESET ROLE;

  v_n := jsonb_array_length(v_kq -> 'organizations');
  IF v_n < 1 THEN
    RAISE EXCEPTION 'Người dùng thường thấy % tổ chức — RPC không vượt được RLS, frontend sẽ hiện "không thuộc tổ chức nào". DỪNG.', v_n;
  END IF;
  IF (v_kq -> 'organizations' -> 0 ->> 'name') IS NULL THEN
    RAISE EXCEPTION 'Tổ chức trả về không có tên — frontend không hiển thị được gì. DỪNG.';
  END IF;

  -- Người mồ côi (không membership nào) phải nhận mảng RỖNG, không phải lỗi và
  -- cũng không phải tổ chức của người khác.
  PERFORM set_config('request.jwt.claims',
    '{"sub":"11111111-2222-4333-8444-555555555555","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  v_kq := public.get_my_organizations();
  RESET ROLE;
  IF jsonb_array_length(v_kq -> 'organizations') <> 0 THEN
    RAISE EXCEPTION 'Người không có membership vẫn thấy % tổ chức. DỪNG.', jsonb_array_length(v_kq -> 'organizations');
  END IF;

  RAISE NOTICE 'Nghiệm thu đạt: người dùng thường thấy % tổ chức có tên, người mồ côi thấy 0.', v_n;
END
$nghiem_thu$;

COMMIT;

-- =============================================================================
-- ROLLBACK: DROP FUNCTION public.get_my_organizations();
-- =============================================================================
