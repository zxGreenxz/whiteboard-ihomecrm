-- =============================================================================
-- Danh bạ tổ chức cho Copilot — nguồn của "công ty đang chọn"
--
-- VẤN ĐỀ ĐANG SỬA
--   `OrganizationContext` hiện đặt `organization = organizations[0]`, tức công ty
--   ĐẦU TIÊN trong danh sách trả về. Không có nơi nào để chọn, và không có gì nói
--   cho người dùng biết họ đang xem sổ của công ty nào. Với người thuộc nhiều
--   công ty, Copilot đọc — và sắp tới là ghi — vào một công ty được chọn bằng
--   thứ tự sắp xếp. Đó không phải một lựa chọn, đó là một sự tình cờ.
--
-- VÌ SAO KHÔNG DÙNG LẠI `get_my_organizations()`
--   Hàm đó cố ý hẹp: chỉ trả tổ chức người gọi CÓ MEMBERSHIP. Super admin không
--   có membership ở đâu cả, nên với họ nó trả mảng rỗng — không chọn được gì.
--   Nhưng cũng KHÔNG được sửa hàm cũ: nó đang phục vụ luồng khác, và nới rộng
--   một hàm đang chạy là cách đổi hành vi của những nơi chưa ai rà lại.
--
--   Thêm nữa, hàm cũ không lọc `organizations.status`. Với danh bạ để CHỌN thì
--   phải lọc: chọn trúng một công ty SUSPENDED rồi đọc sổ của nó là chuyện khác
--   hẳn với việc nó tình cờ nằm trong danh sách membership cũ.
--
-- QUYỀN CỦA SUPER ADMIN Ở ĐÂY LÀ QUYỀN *NHÌN THẤY ĐỂ CHỌN*, KHÔNG PHẢI QUYỀN LÀM
--   Hàm này chỉ mở rộng danh sách chọn được. Mọi thao tác sau đó vẫn đi qua
--   policy biên giới, quyền trên tài nguyên cuối và (với ghi) maker-checker.
--   Một danh bạ rộng không tự nó cho phép làm gì thêm.
--
-- ORG SANDBOX BỊ LOẠI, CÓ CHỦ Ý
--   `20260801020000` giấu org sandbox khỏi super admin bằng ~110 policy
--   RESTRICTIVE, với lý do ghi thẳng trong đó: "App KHÔNG có nút chuyển công ty…
--   super admin thấy MỌI org dù không là thành viên", và org TEST từng lọt vào
--   engine tính toán làm lệch −17,3 triệu.
--
--   Đưa org sandbox vào danh bạ này sẽ cho super admin CHỌN một công ty mà lớp
--   policy bên dưới đã quyết là không cho thấy dữ liệu. Kết quả không phải rò rỉ
--   mà là một màn hình rỗng khó hiểu — và tệ hơn, hai lớp nói hai điều khác nhau
--   về cùng một câu hỏi. Danh bạ phải khớp với thứ policy sẽ trả về.
--
-- KHÔNG NHẬN THAM SỐ NGƯỜI DÙNG
--   Cùng lý do đã ghi ở `get_my_organizations`: hàm SECURITY DEFINER bỏ qua RLS,
--   nên mọi tham số nhận từ client là một đường để hỏi thay người khác.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.list_my_copilot_organizations_v1()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $f$
  SELECT jsonb_build_object(
    'user_id',    (SELECT auth.uid()),
    'is_super',   public.is_super_admin(),
    -- MỘT truy vấn với LEFT JOIN, KHÔNG phải UNION hai nhánh.
    --
    -- UNION trông tự nhiên hơn (một nhánh cho người thường, một nhánh cho super
    -- admin) nhưng sai với người vừa là super admin vừa có membership: hai nhánh
    -- trả cùng một công ty với `member_type` khác nhau, UNION không gộp được vì
    -- các dòng KHÔNG bằng nhau, và danh bạ hiện công ty đó hai lần.
    'organizations', coalesce((
      SELECT jsonb_agg(t ORDER BY t.name)
        FROM (
          SELECT o.id, o.name, o.slug, o.status, o.is_demo, m.member_type
            FROM public.organizations o
            LEFT JOIN public.organization_memberships m
                   ON m.organization_id = o.id
                  AND m.user_id = (SELECT auth.uid())
                  AND m.status  = 'ACTIVE'
           WHERE o.status = 'ACTIVE'
             AND (
                   -- thành viên ACTIVE của chính công ty này …
                   m.user_id IS NOT NULL
                   -- … hoặc super admin, trừ org sandbox (xem đầu file).
                   OR (public.is_super_admin()
                       AND NOT (o.id = ANY (public.sandbox_org_ids())))
                 )
        ) t
    ), '[]'::jsonb)
  );
$f$;

COMMENT ON FUNCTION public.list_my_copilot_organizations_v1() IS
  'Danh bạ công ty CHỌN ĐƯỢC cho Copilot. Người dùng thường: membership ACTIVE trên org ACTIVE. '
  'Super admin: mọi org ACTIVE trừ org sandbox (khớp với lớp policy *_hide_sandbox_admin). '
  'Đây là quyền NHÌN THẤY ĐỂ CHỌN, không phải quyền thao tác — mọi hành động sau đó vẫn qua '
  'policy biên giới và quyền trên tài nguyên cuối. Không nhận tham số: hàm SECURITY DEFINER bỏ qua '
  'RLS nên tham số từ client là đường hỏi thay người khác.';

REVOKE EXECUTE ON FUNCTION public.list_my_copilot_organizations_v1() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.list_my_copilot_organizations_v1() TO authenticated;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — đo bằng vai thật trong giao dịch này, không suy từ thân hàm.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_uid       uuid;
  v_super     uuid;
  v_kq        jsonb;
  v_n         int;
  v_n_super   int;
  v_tong_act  int;
BEGIN
  IF has_function_privilege('anon', 'public.list_my_copilot_organizations_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon gọi được danh bạ tổ chức — bề mặt ẩn danh không được phơi thêm. DỪNG.';
  END IF;

  -- (1) Người dùng thường thấy ĐÚNG công ty mình, không hơn.
  SELECT m.user_id INTO v_uid
    FROM public.organization_memberships m
    JOIN public.organizations o ON o.id = m.organization_id
   WHERE m.status = 'ACTIVE' AND o.status = 'ACTIVE'
     AND NOT EXISTS (SELECT 1 FROM public.super_admins s WHERE s.user_id = m.user_id)
   ORDER BY m.user_id LIMIT 1;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Không có người dùng thường nào để nghiệm thu. DỪNG.';
  END IF;

  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_kq := public.list_my_copilot_organizations_v1();
  RESET ROLE;

  v_n := jsonb_array_length(v_kq -> 'organizations');
  IF v_n < 1 THEN
    RAISE EXCEPTION 'Người dùng thường thấy % công ty — RPC không vượt được RLS. DỪNG.', v_n;
  END IF;
  IF (v_kq ->> 'is_super')::boolean THEN
    RAISE EXCEPTION 'Người dùng thường bị đánh dấu is_super. DỪNG.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_kq -> 'organizations') e
     WHERE (e ->> 'status') <> 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Danh bạ trả về công ty không ACTIVE — không được cho chọn. DỪNG.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_kq -> 'organizations') e
     WHERE NOT EXISTS (
       SELECT 1 FROM public.organization_memberships m
        WHERE m.user_id = v_uid AND m.status = 'ACTIVE'
          AND m.organization_id = (e ->> 'id')::uuid)
  ) THEN
    RAISE EXCEPTION 'Người dùng thường thấy công ty KHÔNG phải của mình. DỪNG.';
  END IF;

  -- (2) Super admin thấy rộng hơn, nhưng KHÔNG thấy org sandbox.
  SELECT s.user_id INTO v_super FROM public.super_admins s ORDER BY s.user_id LIMIT 1;
  IF v_super IS NULL THEN
    RAISE EXCEPTION 'Không có super admin nào để nghiệm thu. DỪNG.';
  END IF;

  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_super::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_kq := public.list_my_copilot_organizations_v1();
  RESET ROLE;

  v_n_super := jsonb_array_length(v_kq -> 'organizations');
  SELECT count(*) INTO v_tong_act
    FROM public.organizations o
   WHERE o.status = 'ACTIVE' AND NOT (o.id = ANY (public.sandbox_org_ids()));

  IF NOT (v_kq ->> 'is_super')::boolean THEN
    RAISE EXCEPTION 'Super admin KHÔNG được đánh dấu is_super. DỪNG.';
  END IF;
  IF v_n_super <> v_tong_act THEN
    RAISE EXCEPTION 'Super admin thấy % công ty, đáng ra %. DỪNG.', v_n_super, v_tong_act;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_kq -> 'organizations') e
     WHERE (e ->> 'id')::uuid = ANY (public.sandbox_org_ids())
  ) THEN
    RAISE EXCEPTION 'Org sandbox lọt vào danh bạ super admin — lệch với lớp policy hide_sandbox. DỪNG.';
  END IF;

  -- Không công ty nào xuất hiện HAI LẦN. Bản viết bằng UNION hai nhánh sai đúng
  -- chỗ này: super admin mà CÓ membership sẽ khớp cả hai nhánh với `member_type`
  -- khác nhau, nên UNION không gộp và danh bạ hiện trùng.
  IF (SELECT count(*) FROM jsonb_array_elements(v_kq -> 'organizations') e)
     <> (SELECT count(DISTINCT e ->> 'id') FROM jsonb_array_elements(v_kq -> 'organizations') e)
  THEN
    RAISE EXCEPTION 'Danh bạ super admin có công ty trùng — ô chọn sẽ hiện hai dòng giống nhau. DỪNG.';
  END IF;

  -- (3) Người mồ côi: mảng RỖNG, không phải lỗi, không phải công ty người khác.
  PERFORM set_config('request.jwt.claims',
    '{"sub":"11111111-2222-4333-8444-555555555555","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  v_kq := public.list_my_copilot_organizations_v1();
  RESET ROLE;
  IF jsonb_array_length(v_kq -> 'organizations') <> 0 THEN
    RAISE EXCEPTION 'Người không membership vẫn thấy % công ty. DỪNG.',
      jsonb_array_length(v_kq -> 'organizations');
  END IF;

  RAISE NOTICE 'Nghiệm thu đạt: thường=% công ty · super=%/% · mồ côi=0.',
    v_n, v_n_super, v_tong_act;
END
$nghiem_thu$;

COMMIT;

-- =============================================================================
-- ROLLBACK: DROP FUNCTION public.list_my_copilot_organizations_v1();
-- =============================================================================
