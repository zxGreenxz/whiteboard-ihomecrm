-- G5-C2 (bổ sung, theo yêu cầu điều phối viên sau khi G5-DE E2E phát hiện
-- thiếu tài khoản) — DML thuần: dựng hai tài khoản E2E cho org DEMO
-- (dddd0000-0000-4000-8000-000000000001) ĐỂ MỘT MÌNH:
--
--   1. Super admin hệ thống `nguyentamca165@gmail.com`
--      (90450d5f-29b6-4897-bdef-cdb5fb53f339) trở thành thành viên ACTIVE của
--      DEMO, mang ĐÚNG vai trò của `demo.chunha` — để một kế hoạch L5 thật (PIN
--      step-up + quyền tài chính) chạy được bằng một actor vừa là super admin
--      vừa có role_binding thật trong org DEMO, không dựa vào lối tắt
--      `is_super_admin()` của RLS.
--   2. `demo.ketoan@username.ihomecrm.local` được cấp NGOẠI LỆ quyền
--      `income_expenses.approve` trên DEMO — role hiện tại của ketoan (đo
--      trước khi viết migration) có đủ create/edit/view/cancel/print/export/
--      reverse/delete/all_buildings/self_approve_within_limit nhưng THIẾU
--      đúng `approve`, nên `income_expense.duyet` (G5-C) không tự chạy được
--      bằng actor này — cần cho nhánh "người NỘP khác người DUYỆT" của
--      `income_expense.nop_ho_so` (G3) đo được maker ≠ approver bằng một
--      approver có PIN.
--
-- ĐI ĐÚNG BẢNG APP DÙNG — không tự bịa cơ chế. `update_member_authorization_v1`
-- (production, đọc qua Management API 03/09/2026) ghi vai trò vào
-- `role_bindings`/`role_binding_scopes`, và ngoại lệ quyền vào
-- `member_permission_overrides`/`member_override_scopes` — migration này viết
-- THẲNG vào đúng bốn bảng đó, đúng hình dạng RPC kia tự ghi (xem migration
-- 20260903212600 — copy nguyên văn logic ghi của nó).
--
-- IDEMPOTENT — mọi INSERT theo `WHERE NOT EXISTS`. DB RỖNG (Restore
-- Drill/schema-only): org DEMO hoặc hai tài khoản demo. chunha/.ketoan không
-- tồn tại → RAISE NOTICE rồi RETURN, không lỗi, không ghi gì.
--
-- CHỈ MỘT MÌNH ORG DEMO — mọi câu lệnh khoá theo ORG (hằng số), không đụng
-- production thật.
BEGIN;
SET LOCAL lock_timeout = '15s';

DO $seed$
DECLARE
  ORG constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  SUPER_ADMIN constant uuid := '90450d5f-29b6-4897-bdef-cdb5fb53f339';
  v_org_ton_tai       boolean;
  v_super_email       text;
  v_chunha_membership uuid;
  v_chunha_role_id    uuid;
  v_chunha_scope_id   uuid;
  v_chunha_member_type text;
  v_ketoan_membership uuid;
  v_super_membership  uuid;
  v_role_binding_id   uuid;
BEGIN
  SELECT EXISTS(SELECT 1 FROM public.organizations WHERE id = ORG) INTO v_org_ton_tai;
  IF NOT v_org_ton_tai THEN
    RAISE NOTICE 'demo_l5_e2e_accounts_seed_v1: to chuc DEMO % khong ton tai (DB rong hoac chua seed) — bo qua, khong loi.', ORG;
    RETURN;
  END IF;

  SELECT email INTO v_super_email FROM auth.users WHERE id = SUPER_ADMIN;
  IF v_super_email IS DISTINCT FROM 'nguyentamca165@gmail.com' THEN
    RAISE NOTICE 'demo_l5_e2e_accounts_seed_v1: uid super admin % khong khop email mong doi (thay: %) — bo qua, khong loi.',
      SUPER_ADMIN, v_super_email;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.super_admins sa WHERE sa.user_id = SUPER_ADMIN) THEN
    RAISE NOTICE 'demo_l5_e2e_accounts_seed_v1: % khong con la super admin — bo qua, khong loi.', SUPER_ADMIN;
    RETURN;
  END IF;

  -- Vai + phạm vi + member_type của demo.chunha (chép NGUYÊN VĂN, không đoán).
  SELECT rb.role_id, rbs.scope_id, m.member_type
    INTO v_chunha_role_id, v_chunha_scope_id, v_chunha_member_type
    FROM public.organization_memberships m
    JOIN auth.users u ON u.id = m.user_id
    JOIN public.role_bindings rb ON rb.membership_id = m.id AND rb.valid_to IS NULL
    JOIN public.role_binding_scopes rbs ON rbs.role_binding_id = rb.id
   WHERE m.organization_id = ORG
     AND u.email = 'demo.chunha@username.ihomecrm.local'
     AND m.status = 'ACTIVE'
   ORDER BY rb.valid_from
   LIMIT 1;
  IF v_chunha_role_id IS NULL THEN
    RAISE NOTICE 'demo_l5_e2e_accounts_seed_v1: demo.chunha khong co vai tro hieu luc trong DEMO — bo qua, khong loi.';
    RETURN;
  END IF;

  SELECT m.id INTO v_chunha_membership
    FROM public.organization_memberships m
    JOIN auth.users u ON u.id = m.user_id
   WHERE m.organization_id = ORG AND u.email = 'demo.chunha@username.ihomecrm.local';

  SELECT m.id INTO v_ketoan_membership
    FROM public.organization_memberships m
    JOIN auth.users u ON u.id = m.user_id
   WHERE m.organization_id = ORG AND u.email = 'demo.ketoan@username.ihomecrm.local'
     AND m.status = 'ACTIVE';
  IF v_ketoan_membership IS NULL THEN
    RAISE NOTICE 'demo_l5_e2e_accounts_seed_v1: demo.ketoan khong ton tai/khong ACTIVE trong DEMO — bo qua phan cap quyen, khong loi.';
  END IF;

  -- ── 1. Super admin trở thành thành viên ACTIVE của DEMO, mang vai của
  -- chunha. member_type ĐỌC ĐỘNG từ hàng chunha (v_chunha_member_type, khớp
  -- Y HỆT — F3, review G5-C2 fix round 1: bản trước hardcode literal 'OWNER'
  -- trong khi comment nói "chép từ hàng chunha", hai thứ đó KHÔNG khớp nhau
  -- về mặt mã nguồn dù trùng giá trị hôm nay; sửa để mã nguồn tự đúng nếu
  -- chunha đổi member_type sau này). ──
  INSERT INTO public.organization_memberships
    (organization_id, user_id, member_type, status, valid_from, activated_at, version)
  SELECT ORG, SUPER_ADMIN, v_chunha_member_type, 'ACTIVE', clock_timestamp(), clock_timestamp(), 1
   WHERE NOT EXISTS (
     SELECT 1 FROM public.organization_memberships
      WHERE organization_id = ORG AND user_id = SUPER_ADMIN
   );

  SELECT id INTO v_super_membership
    FROM public.organization_memberships
   WHERE organization_id = ORG AND user_id = SUPER_ADMIN;

  -- Idempotent theo Ý NGHĨA (đúng role + đúng scope), không theo id: chạy lại
  -- migration này không được đẻ thêm role_binding trùng.
  IF NOT EXISTS (
    SELECT 1 FROM public.role_bindings rb
      JOIN public.role_binding_scopes rbs ON rbs.role_binding_id = rb.id
     WHERE rb.membership_id = v_super_membership
       AND rb.role_id = v_chunha_role_id
       AND rbs.scope_id = v_chunha_scope_id
       AND rb.valid_to IS NULL
  ) THEN
    v_role_binding_id := gen_random_uuid();
    INSERT INTO public.role_bindings
      (id, organization_id, membership_id, role_id, valid_from, version)
    VALUES
      (v_role_binding_id, ORG, v_super_membership, v_chunha_role_id, clock_timestamp(), 1);
    INSERT INTO public.role_binding_scopes (organization_id, role_binding_id, scope_id)
    VALUES (ORG, v_role_binding_id, v_chunha_scope_id);
  END IF;

  -- ── 2. Ngoại lệ quyền income_expenses.approve cho demo.ketoan (nếu ketoan
  -- tồn tại — đã NOTICE ở trên nếu không). ──
  IF v_ketoan_membership IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.member_permission_overrides o
      JOIN public.member_override_scopes os ON os.override_id = o.id
     WHERE o.membership_id = v_ketoan_membership
       AND o.permission_key = 'income_expenses.approve'
       AND o.effect = 'ALLOW'
       AND o.revoked_at IS NULL
       AND os.scope_id = v_chunha_scope_id
  ) THEN
    DECLARE
      v_override_id uuid := gen_random_uuid();
    BEGIN
      INSERT INTO public.member_permission_overrides
        (id, organization_id, membership_id, permission_key, effect, reason,
         created_by, created_at, scope_mode)
      VALUES
        (v_override_id, ORG, v_ketoan_membership, 'income_expenses.approve', 'ALLOW',
         'Fixture E2E G5-C2/G5-DE — cần một approver != maker cho income_expense.nop_ho_so',
         SUPER_ADMIN, clock_timestamp(), 'ORGANIZATION');
      INSERT INTO public.member_override_scopes (organization_id, override_id, scope_id)
      VALUES (ORG, v_override_id, v_chunha_scope_id);
    END;
  END IF;

  -- Đổi phân quyền → tăng authorization_version, giống hệt cách
  -- `update_member_authorization_v1`/`set_membership_status_v1` tự làm — cache
  -- quyền phía client phải biết mà nạp lại.
  UPDATE public.organizations SET authorization_version = authorization_version + 1 WHERE id = ORG;

  RAISE NOTICE 'demo_l5_e2e_accounts_seed_v1: super admin % la thanh vien ACTIVE cua DEMO mang vai cua chunha; ketoan % duoc cap income_expenses.approve.',
    SUPER_ADMIN, COALESCE(v_ketoan_membership::text, '(khong ton tai)');
END
$seed$;

-- ---------------------------------------------------------------------------
-- NGHIEM THU — F3 (review G5-C2 fix round 1): phải soi ĐÚNG những điều kiện
-- bỏ-qua-an-toàn mà khối $seed$ ở trên đã kiểm (org tồn tại, super admin còn
-- hợp lệ, VÀ demo.chunha còn vai trò hiệu lực) — bản trước chỉ soi hai điều
-- kiện đầu rồi RAISE EXCEPTION vô điều kiện nếu không thấy membership/role,
-- nên một lượt seed hợp lệ NHƯNG bị body bỏ qua vì thiếu điều kiện thứ ba
-- (chunha không có role hiệu lực) sẽ bị nghiệm thu báo lỗi SAI (dữ liệu chưa
-- từng được kỳ vọng tồn tại). Đồng thời KHÔNG hardcode tên vai trò
-- ('Chủ công ty') — tra lại role_id/scope_id ĐỘNG từ chính hàng demo.chunha,
-- y hệt cách khối $seed$ đã làm, rồi so khớp theo id, không theo tên.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  ORG constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  SUPER_ADMIN constant uuid := '90450d5f-29b6-4897-bdef-cdb5fb53f339';
  v_super_email     text;
  v_chunha_role_id  uuid;
  v_chunha_scope_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = ORG) THEN
    RAISE NOTICE 'demo_l5_e2e_accounts_seed_v1: nghiem thu bo qua — to chuc DEMO khong ton tai.';
    RETURN;
  END IF;

  SELECT email INTO v_super_email FROM auth.users WHERE id = SUPER_ADMIN;
  IF v_super_email IS DISTINCT FROM 'nguyentamca165@gmail.com' THEN
    RAISE NOTICE 'demo_l5_e2e_accounts_seed_v1: nghiem thu bo qua — uid super admin khong khop email mong doi.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.super_admins WHERE user_id = SUPER_ADMIN) THEN
    RAISE NOTICE 'demo_l5_e2e_accounts_seed_v1: nghiem thu bo qua — % khong/khong con la super admin.', SUPER_ADMIN;
    RETURN;
  END IF;

  SELECT rb.role_id, rbs.scope_id
    INTO v_chunha_role_id, v_chunha_scope_id
    FROM public.organization_memberships m
    JOIN auth.users u ON u.id = m.user_id
    JOIN public.role_bindings rb ON rb.membership_id = m.id AND rb.valid_to IS NULL
    JOIN public.role_binding_scopes rbs ON rbs.role_binding_id = rb.id
   WHERE m.organization_id = ORG
     AND u.email = 'demo.chunha@username.ihomecrm.local'
     AND m.status = 'ACTIVE'
   ORDER BY rb.valid_from
   LIMIT 1;
  IF v_chunha_role_id IS NULL THEN
    RAISE NOTICE 'demo_l5_e2e_accounts_seed_v1: nghiem thu bo qua — demo.chunha khong con vai tro hieu luc trong DEMO.';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships
     WHERE organization_id = ORG AND user_id = SUPER_ADMIN AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'demo_l5_e2e_accounts_seed_v1: super admin khong phai thanh vien ACTIVE cua DEMO sau khi seed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.organization_memberships m
      JOIN public.role_bindings rb ON rb.membership_id = m.id AND rb.valid_to IS NULL
      JOIN public.role_binding_scopes rbs ON rbs.role_binding_id = rb.id
     WHERE m.organization_id = ORG AND m.user_id = SUPER_ADMIN
       AND rb.role_id = v_chunha_role_id
       AND rbs.scope_id = v_chunha_scope_id
  ) THEN
    RAISE EXCEPTION 'demo_l5_e2e_accounts_seed_v1: super admin chua mang dung vai+pham vi cua demo.chunha trong DEMO sau khi seed';
  END IF;
END
$nghiem_thu$;

COMMIT;
