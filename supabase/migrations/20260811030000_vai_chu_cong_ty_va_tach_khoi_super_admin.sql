-- =============================================================================
-- Vai "Chủ công ty" — tách vai CHỦ SỞ HỮU khỏi vai TÀI KHOẢN HỆ THỐNG
--
-- ------------------------------ VẤN ĐỀ --------------------------------------
-- Đo được: hệ thống KHÔNG có vai chủ công ty. Bảng vai có 5 dòng, và dòng
-- "Super Admin" mà nguyentamca165@gmail.com đang giữ có **0 quyền** trong
-- role_permissions. Sức mạnh của nó không đến từ tầng phân quyền — nó đến từ vế
-- `is_super_admin()` nhúng thẳng vào policy của gần như mọi bảng.
--
-- Nói cách khác: quyền của CHỦ CÔNG TY hôm nay CHÍNH LÀ đường vòng dành cho TÀI
-- KHOẢN HỆ THỐNG. Hai vai đó đang là một, và đó là lý do một tài khoản duy nhất
-- vừa bảo trì hạ tầng vừa xem sổ sách — nên sổ sách của nó cộng gộp mọi công ty.
--
-- Chứng minh hai vai đang là một: dựng thử một tài khoản có membership OWNER +
-- profile đầy đủ nhưng KHÔNG nằm trong super_admins, rồi soi bằng chính vai đó:
--     0 toà nhà · 0 hoá đơn · 0 hợp đồng · 0 phòng
-- Membership một mình không cho quyền gì cả. Nếu cứ thế giao tài khoản cho chủ,
-- người ta đăng nhập vào một cái app trống trơn mà không có lỗi nào báo.
--
-- ------------------------------ CÁCH LÀM ------------------------------------
-- Mô hình phân quyền có ba tầng tách bạch, và may là đủ để dựng đúng:
--     organization_roles + role_permissions  →  ĐƯỢC LÀM GÌ
--     role_bindings                          →  AI GIỮ VAI ĐÓ
--     role_binding_scopes → authorization_scopes → Ở ĐÂU
--
-- Vai này nhận ĐỦ 231 quyền miền TENANT (toàn bộ quyền hệ thống định nghĩa), và
-- phạm vi là dòng `ORGANIZATION` sẵn có của công ty — tức "toàn quyền, toàn bộ
-- toà nhà, trong đúng công ty mình".
--
-- VÌ SAO CẤP TRỌN 231 CHỨ KHÔNG LỌC BỚT: mọi quyền ở đây chỉ có hiệu lực trong
-- phạm vi công ty của chính người giữ — can_v3 kiểm `m.organization_id` ở mọi
-- nhánh, và 304 policy biên giới chặn tuyệt đối chiều ngang. "Chủ không được
-- làm một việc nào đó TRONG CÔNG TY CỦA CHÍNH MÌNH" là hạn chế khó biện minh;
-- và nếu sau này cần siết thì gỡ bớt dễ hơn nhiều so với việc phát hiện thiếu
-- quyền lúc đang vận hành.
--
-- KHÔNG đụng tới is_super_admin(), KHÔNG sửa policy nào. Ranh giới công ty đã do
-- 304 policy biên giới lo, nên tài khoản này KHÔNG THỂ thấy công ty khác kể cả
-- khi muốn — khác hẳn tài khoản hệ thống.
--
-- KHÔNG thêm tài khoản này vào super_admins. Đó là toàn bộ mục đích của file.
--
-- ------------------------- ĐÃ DIỄN TẬP TRƯỚC --------------------------------
-- Chạy nguyên khối này trong BEGIN…ROLLBACK trên chính production rồi soi bằng
-- vai vừa dựng:
--     is_super_admin = 0  ·  toà nhà truy cập được 18/18
--     invoices 1.143  ·  contracts 335  ·  rooms 276  ·  customers 523
--     income_expenses 2.771
-- 1.143 đúng bằng TOÀN BỘ hoá đơn của công ty thật — tức toàn quyền thật, không
-- mượn đường super admin.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

DO $dung$
DECLARE
  ORG    constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  V_EMAIL constant text := 'nguyentam@username.ihomecrm.local';
  v_uid   uuid;
  v_role  uuid;
  v_mem   uuid;
  v_rb    uuid;
  v_scope uuid;
  v_n     int;
BEGIN
  SELECT u.id INTO v_uid FROM auth.users u WHERE u.email = V_EMAIL;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Chưa có tài khoản % — tạo bằng GoTrue admin trước khi chạy file này. DỪNG.', V_EMAIL;
  END IF;

  -- Chốt tự vệ: file này tồn tại để TÁCH chủ khỏi tài khoản hệ thống. Nếu tài
  -- khoản đích lại là super admin thì việc tách vô nghĩa và phải dừng.
  IF EXISTS (SELECT 1 FROM public.super_admins s WHERE s.user_id = v_uid) THEN
    RAISE EXCEPTION 'Tài khoản % nằm trong super_admins — dựng vai chủ cho nó là vô nghĩa. DỪNG.', V_EMAIL;
  END IF;

  -- 1. Nhãn tổ chức trên profile (dòng profile do trigger trên auth.users tạo sẵn).
  UPDATE public.profiles
     SET organization_id = ORG,
         full_name = coalesce(nullif(full_name, ''), 'Nguyễn Tâm (Chủ công ty)')
   WHERE id = v_uid;

  -- 2. Membership OWNER.
  SELECT id INTO v_mem FROM public.organization_memberships
   WHERE organization_id = ORG AND user_id = v_uid;
  IF v_mem IS NULL THEN
    INSERT INTO public.organization_memberships (organization_id, user_id, member_type, status)
    VALUES (ORG, v_uid, 'OWNER', 'ACTIVE') RETURNING id INTO v_mem;
  END IF;

  -- 3. Vai + đủ 231 quyền TENANT.
  SELECT id INTO v_role FROM public.organization_roles
   WHERE organization_id = ORG AND name = 'Chủ công ty';
  IF v_role IS NULL THEN
    INSERT INTO public.organization_roles (organization_id, name, is_system, version, status)
    VALUES (ORG, 'Chủ công ty', false, 1, 'ACTIVE') RETURNING id INTO v_role;
  END IF;

  INSERT INTO public.role_permissions (organization_id, role_id, permission_key, effect)
  SELECT ORG, v_role, pd.key, 'ALLOW'
    FROM public.permission_definitions pd
   WHERE pd.permission_domain = 'TENANT' AND pd.is_active
     AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp
                      WHERE rp.role_id = v_role AND rp.permission_key = pd.key);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'Vai "Chủ công ty": thêm % quyền.', v_n;

  -- 4. Gán vai.
  SELECT id INTO v_rb FROM public.role_bindings
   WHERE organization_id = ORG AND membership_id = v_mem AND role_id = v_role;
  IF v_rb IS NULL THEN
    INSERT INTO public.role_bindings (organization_id, membership_id, role_id)
    VALUES (ORG, v_mem, v_role) RETURNING id INTO v_rb;
  END IF;

  -- 5. Phạm vi TOÀN CÔNG TY — dùng lại dòng ORGANIZATION sẵn có, không tạo bản sao.
  SELECT id INTO v_scope FROM public.authorization_scopes
   WHERE organization_id = ORG AND scope_type = 'ORGANIZATION' LIMIT 1;
  IF v_scope IS NULL THEN
    RAISE EXCEPTION 'Công ty % không có dòng authorization_scopes kiểu ORGANIZATION — không gán được phạm vi toàn công ty. DỪNG.', ORG;
  END IF;
  INSERT INTO public.role_binding_scopes (organization_id, role_binding_id, scope_id)
  VALUES (ORG, v_rb, v_scope)
  ON CONFLICT DO NOTHING;
END
$dung$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — soi bằng CHÍNH vai vừa dựng, không suy từ số dòng đã insert.
-- Đo HAI mệnh đề: thấy đủ công ty mình, VÀ không phải super admin.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  ORG   constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  v_uid uuid;
  v_that bigint;
  v_thay bigint;
  v_toa  bigint;
  v_sup  boolean;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'nguyentam@username.ihomecrm.local';
  SELECT count(*) INTO v_that FROM public.invoices WHERE organization_id = ORG;

  CREATE TEMP TABLE _nt(k text, v bigint) ON COMMIT DROP;
  GRANT INSERT, SELECT ON _nt TO PUBLIC;

  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO _nt
  SELECT 'sup', (SELECT public.is_super_admin())::int
  UNION ALL SELECT 'toa', (SELECT count(*) FROM (SELECT public.accessible_building_ids()) s)
  UNION ALL SELECT 'inv', (SELECT count(*) FROM public.invoices);
  RESET ROLE;

  SELECT v = 1 INTO v_sup  FROM _nt WHERE k = 'sup';
  SELECT v      INTO v_toa  FROM _nt WHERE k = 'toa';
  SELECT v      INTO v_thay FROM _nt WHERE k = 'inv';

  -- MỆNH ĐỀ 1 — KHÔNG được là tài khoản hệ thống. Đây là toàn bộ lý do file tồn tại.
  IF v_sup THEN
    RAISE EXCEPTION 'Tài khoản chủ lại là super admin — việc tách đã thất bại. DỪNG.';
  END IF;

  -- MỆNH ĐỀ 2 — thấy ĐỦ công ty mình. Chỉ hỏi "không thấy công ty khác" là chưa
  -- đủ: một vai không có quyền gì cũng cho ra đúng kết quả đó.
  IF v_thay <> v_that THEN
    RAISE EXCEPTION 'Chủ thấy % / % hoá đơn của công ty mình — chưa đủ toàn quyền. DỪNG.', v_thay, v_that;
  END IF;
  IF coalesce(v_toa, 0) = 0 THEN
    RAISE EXCEPTION 'Chủ không truy cập được toà nhà nào — phạm vi ORGANIZATION chưa ăn. DỪNG.';
  END IF;

  RAISE NOTICE 'Nghiệm thu đạt: chủ thấy đủ % hoá đơn và % toà nhà, và KHÔNG phải super admin.',
    v_thay, v_toa;
END
$nghiem_thu$;

COMMIT;

-- =============================================================================
-- SAU KHI CHẠY: nguyentamca165@gmail.com vẫn là super admin (tài khoản hệ thống)
-- và vẫn giữ membership OWNER cũ. Muốn tách triệt để thì gỡ membership đó — việc
-- riêng, cần người quyết, vì nó đổi thứ tài khoản hệ thống nhìn thấy mặc định.
--
-- ROLLBACK: xoá role_binding_scopes → role_bindings → role_permissions →
-- organization_roles của vai 'Chủ công ty', và organization_memberships của
-- tài khoản chủ. Không đụng dữ liệu nghiệp vụ nào.
-- =============================================================================
