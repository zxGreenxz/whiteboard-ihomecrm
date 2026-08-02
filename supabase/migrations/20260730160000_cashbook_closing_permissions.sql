-- =====================================================================
-- Đợt 6 (bước 1/2) — HAI KHOÁ QUYỀN CHO NGHI THỨC CHỐT SỔ
--
-- Migration này CỐ Ý đi TRƯỚC và MỘT MÌNH. Không có một writer nào ở đây.
--
-- Lý do: `app_private.authorize_tenant_action_v3` nạp khoá bằng
--   permission as materialized (
--     select pd.* from public.permission_definitions pd ...
--      where pd.key = p_permission_key and pd.permission_domain='TENANT' and pd.is_active)
-- rồi
--   when not exists (select 1 from permission) then false   -- 'PERMISSION_INACTIVE_OR_MISSING'
-- ⇒ FAIL-CLOSED với khoá lạ. Đã đo trên prod: hỏi 'cashbooks.close' cho
-- demo.chunha/ketoan/quanly đều trả allowed=false, reason
-- PERMISSION_INACTIVE_OR_MISSING. Nếu writer lên trước khoá thì MỌI người
-- trong MỌI tổ chức ăn 42501 vĩnh viễn.
--
-- Hai bảng phải điền theo ĐÚNG thứ tự vì role_permissions có FK về
-- permission_definitions(key), và có trigger a00_guard_tenant_role_permission_domain
-- chặn khoá không phải TENANT.
--
-- ⚠ KHÔNG làm lối tắt `member_type='OWNER'`: nó đi vòng qua
--   `app_private.tenant_emergency_denies` và mọi tầng DENY. Và
--   `is_org_owner_v1` nhận diện chủ theo TÊN vai trò 'Chủ sở hữu tổ chức',
--   không kiểm valid_from/valid_to, không kiểm cạnh phạm vi — đo trên DEMO có
--   2 tài khoản member_type='STAFF' vẫn là owner_v1=true. Nó dùng được như một
--   cửa phụ cho chủ, KHÔNG dùng được như mô hình phân quyền.
--
-- scope_kinds = {ORGANIZATION, CASHBOOK}: sao chép cashbooks.edit chứ KHÔNG
-- sao chép cashbooks.post/manage_custody. Hai khoá kia đặt
-- requires_cashbook_possession=true + required_dimensions={CASHBOOK}, nghĩa là
-- CHỈ người đang giữ sổ mới qua. Với chốt sổ điều đó SAI ở cả hai vế:
--   - người ĐỀ NGHỊ chốt là người đang giữ sổ (đúng), nhưng
--   - người XÁC NHẬN là người NHẬN bàn giao — theo định nghĩa họ CHƯA giữ sổ.
-- Đặt possession=true là khoá vĩnh viễn vế thứ hai. Việc "phải đang giữ sổ mới
-- được đề nghị chốt" sẽ do writer tự kiểm bằng assert_cashbook_access_v2.
-- =====================================================================

BEGIN;

-- ── 1. Danh mục quyền ───────────────────────────────────────────────
INSERT INTO public.permission_definitions
  (key, resource, action, sensitivity, permission_domain, scope_kinds,
   is_active, scope_match_mode, requires_cashbook_possession,
   accepted_possession_kinds, required_dimensions)
VALUES
  ('cashbooks.close', 'cashbooks', 'close', 'ELEVATED', 'TENANT',
   ARRAY['ORGANIZATION','CASHBOOK'], true, 'ANY_MATCH', false,
   ARRAY[]::text[], ARRAY[]::text[]),
  ('cashbooks.close_confirm', 'cashbooks', 'close_confirm', 'ELEVATED', 'TENANT',
   ARRAY['ORGANIZATION','CASHBOOK'], true, 'ANY_MATCH', false,
   ARRAY[]::text[], ARRAY[]::text[])
ON CONFLICT (key) DO UPDATE
  SET is_active = true,
      sensitivity = excluded.sensitivity,
      scope_kinds = excluded.scope_kinds,
      requires_cashbook_possession = excluded.requires_cashbook_possession,
      accepted_possession_kinds = excluded.accepted_possession_kinds,
      required_dimensions = excluded.required_dimensions;

-- ── 2. Cấp mặc định — HAI VẾ PHẢI RƠI VÀO HAI NGƯỜI KHÁC NHAU ───────
-- Nghi thức chốt đòi người xác nhận KHÁC người đề nghị. Nếu cấp cả hai khoá
-- cho đúng một vai trò thì ngày ship đã không ai hoàn tất được lần chốt nào —
-- đo trên prod: chỉ 'Chủ sở hữu tổ chức' có cashbooks.post, còn 'Quản Lý Tòa'
-- (17-18 binding, tức nhân sự thật) có cashbooks.edit.
--
-- (a) ĐỀ NGHỊ chốt = người ĐANG GIỮ sổ và đang nộp tiền.
--
--     Cấp qua VAI TRÒ không dùng được: đã đo trên prod, vai trò 'Quản Lý Tòa'
--     (17-18 binding, tức nhân sự thật) chỉ có cạnh phạm vi BUILDING, mà
--     cashbooks.close được hỏi ở phạm vi CASHBOOK — BUILDING không phủ CASHBOOK
--     nên họ vẫn DEFAULT_DENY. Kết quả đo per-cashbook trước khi sửa: cả 20 sổ
--     đều "đề-nghị=1 xác-nhận=1" và là CÙNG một người (chủ) ⇒ nghi thức hai
--     bên bất khả thi.
--
--     Nên cấp bằng ĐÚNG sự thật nghiệp vụ: ai đang GIỮ sổ thì được đề nghị chốt
--     CHÍNH sổ đó. Đây cũng là mẫu đang dùng cho cashbooks.post (override
--     SCOPED theo từng sổ), không phải phát minh mới.
INSERT INTO public.authorization_scopes (organization_id, scope_type, cashbook_id)
SELECT DISTINCT pb.organization_id, 'CASHBOOK', pb.cashbook_id
FROM public.cashbook_possession_bindings pb
WHERE pb.possession_kind = 'CUSTODIAN'
  AND (pb.valid_to IS NULL OR pb.valid_to > now())
  AND NOT EXISTS (
    SELECT 1 FROM public.authorization_scopes s
    WHERE s.organization_id = pb.organization_id
      AND s.scope_type = 'CASHBOOK' AND s.cashbook_id = pb.cashbook_id);

WITH custodians AS (
  SELECT DISTINCT pb.organization_id, pb.membership_id, pb.cashbook_id
  FROM public.cashbook_possession_bindings pb
  JOIN public.organization_memberships m
    ON m.id = pb.membership_id AND m.status = 'ACTIVE'
  JOIN public.accounts a
    ON a.id = pb.cashbook_id AND a.deleted_at IS NULL AND NOT COALESCE(a.is_virtual, false)
  WHERE pb.possession_kind = 'CUSTODIAN'
    AND (pb.valid_to IS NULL OR pb.valid_to > now())
), ins_override AS (
  INSERT INTO public.member_permission_overrides
    (organization_id, membership_id, permission_key, effect, scope_mode, reason)
  SELECT DISTINCT c.organization_id, c.membership_id, 'cashbooks.close', 'ALLOW', 'SCOPED',
         'Đợt 6: người đang giữ sổ được đề nghị chốt & bàn giao chính sổ đó'
  FROM custodians c
  WHERE NOT EXISTS (
    SELECT 1 FROM public.member_permission_overrides o
    WHERE o.organization_id = c.organization_id
      AND o.membership_id = c.membership_id
      AND o.permission_key = 'cashbooks.close'
      AND o.revoked_at IS NULL)
  RETURNING id, organization_id, membership_id
)
INSERT INTO public.member_override_scopes (organization_id, override_id, scope_id)
SELECT DISTINCT o.organization_id, o.id, s.id
FROM ins_override o
JOIN custodians c
  ON c.organization_id = o.organization_id AND c.membership_id = o.membership_id
JOIN public.authorization_scopes s
  ON s.organization_id = c.organization_id
 AND s.scope_type = 'CASHBOOK' AND s.cashbook_id = c.cashbook_id
ON CONFLICT DO NOTHING;

--     Vai trò chủ vẫn được đề nghị (họ cũng có thể tự giữ sổ).
INSERT INTO public.role_permissions (organization_id, role_id, permission_key, effect)
SELECT r.organization_id, r.id, 'cashbooks.close', 'ALLOW'
FROM public.organization_roles r
WHERE r.name = 'Chủ sở hữu tổ chức'
ON CONFLICT (organization_id, role_id, permission_key) DO NOTHING;

-- (b) XÁC NHẬN nhận bàn giao = bên nhận trách nhiệm ⇒ CHỈ vai trò chủ. Đây là
--     chữ ký khoá kỳ VĨNH VIỄN nên mặc định phải hẹp; ai khác cần thì cấp tay
--     trong màn phân quyền.
INSERT INTO public.role_permissions (organization_id, role_id, permission_key, effect)
SELECT r.organization_id, r.id, 'cashbooks.close_confirm', 'ALLOW'
FROM public.organization_roles r
WHERE r.name = 'Chủ sở hữu tổ chức'
ON CONFLICT (organization_id, role_id, permission_key) DO NOTHING;

-- ── 3. TỰ ASSERT TRƯỚC KHI COMMIT ───────────────────────────────────
-- Không tin "INSERT chạy xong là xong": hỏi ngược chính evaluator, đúng chữ ký
-- mà writer sẽ gọi. Nếu chưa ai qua được thì migration này vô dụng và phải
-- dừng ngay, còn hơn để Đợt 6 lên rồi cả nhà 42501.
DO $assert$
DECLARE
  v_missing int;
  v_ok_org int;
  v_org uuid;
  v_actor uuid;
  v_allowed boolean;
  v_reason text;
BEGIN
  SELECT count(*) INTO v_missing FROM (VALUES ('cashbooks.close'), ('cashbooks.close_confirm')) AS k(key)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.permission_definitions pd
      WHERE pd.key = k.key AND pd.permission_domain = 'TENANT' AND pd.is_active);
  IF v_missing <> 0 THEN
    RAISE EXCEPTION 'Thiếu % khoá trong permission_definitions — authorize_tenant_action_v3 sẽ fail-closed', v_missing;
  END IF;

  -- Bất biến THẬT của nghi thức hai bên, kiểm THEO TỪNG SỔ (writer sẽ hỏi
  -- authorize_tenant_action_v3 ở phạm vi CASHBOOK, không phải ORGANIZATION):
  -- phải tồn tại một người ĐỀ NGHỊ được và một người KHÁC xác nhận được.
  --
  -- Đây là ĐIỀU KIỆN ĐỦ chứ không phải điều kiện cần cho từng sổ: sổ mà chỉ
  -- một người dính líu thì KHÔNG có bên thứ hai để bàn giao — đó là sự thật
  -- nghiệp vụ, không phải lỗi cấu hình, và tổ chức phải tự chỉ định người nhận.
  -- Migration chỉ hard-fail khi KHÔNG MỘT SỔ NÀO chốt được, tức là cơ chế sai.
  DECLARE
    v_ok_books int := 0;
    v_bad_books int := 0;
    v_names text := '';
    bk record;
    a int; b int; c int;
  BEGIN
    FOR bk IN
      SELECT ac.id, ac.name, ac.organization_id
      FROM public.accounts ac
      JOIN public.organizations org ON org.id = ac.organization_id AND org.status = 'ACTIVE'
      WHERE ac.deleted_at IS NULL AND NOT COALESCE(ac.is_virtual, false)
    LOOP
      SELECT count(*) FILTER (WHERE p_ok),
             count(*) FILTER (WHERE c_ok),
             count(*) FILTER (WHERE p_ok AND c_ok)
        INTO a, b, c
      FROM (
        SELECT
          COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
            m.user_id, bk.organization_id, 'cashbooks.close', NULL, bk.id)), false) AS p_ok,
          COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
            m.user_id, bk.organization_id, 'cashbooks.close_confirm', NULL, bk.id)), false) AS c_ok
        FROM public.organization_memberships m
        WHERE m.organization_id = bk.organization_id AND m.status = 'ACTIVE'
      ) x;

      IF a >= 1 AND b >= 1 AND NOT (a = 1 AND b = 1 AND c = 1) THEN
        v_ok_books := v_ok_books + 1;
      ELSE
        v_bad_books := v_bad_books + 1;
        v_names := v_names || ' · ' || bk.name;
      END IF;
    END LOOP;

    IF v_ok_books = 0 THEN
      RAISE EXCEPTION
        'KHÔNG sổ quỹ nào có đủ hai bên để chốt — cơ chế cấp quyền sai, dừng lại (% sổ hỏng)', v_bad_books;
    END IF;
    RAISE NOTICE 'Chốt sổ: %/% sổ đã đủ hai bên.', v_ok_books, v_ok_books + v_bad_books;
    IF v_bad_books > 0 THEN
      RAISE NOTICE
        '% sổ CHƯA có người thứ hai để bàn giao (chỉ một người dính líu) — tổ chức phải tự chỉ định người xác nhận:%',
        v_bad_books, v_names;
    END IF;
  END;

  -- Khoá xác nhận phải HẸP HƠN khoá đề nghị, nếu không thì "hai bên" chỉ là
  -- lời nói: ai đề nghị cũng tự xác nhận được cho nhau.
  SELECT count(*) INTO v_missing
  FROM public.role_permissions rp
  WHERE rp.permission_key = 'cashbooks.close_confirm' AND rp.effect = 'ALLOW'
    AND rp.role_id NOT IN (SELECT id FROM public.organization_roles WHERE name = 'Chủ sở hữu tổ chức');
  IF v_missing <> 0 THEN
    RAISE NOTICE 'Có % vai trò ngoài "Chủ sở hữu tổ chức" được cấp close_confirm — kiểm lại chủ ý', v_missing;
  END IF;
END
$assert$;

COMMIT;

NOTIFY pgrst, 'reload schema';
