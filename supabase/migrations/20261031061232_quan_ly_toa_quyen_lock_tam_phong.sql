-- Cấp quyền CRM "Lock tạm phòng" (sale_phong.lock_room) cho vai "Quản Lý Tòa" của công ty iHome. Chủ quyết 31/10/2026.
--
-- BỐI CẢNH (sự cố 31/10 08:19–08:21, hồ sơ Hermes owner):
--   - contract.room_lock / contract.room_unlock bị báo forbidden và crm_sale_action không có room_lock, vì tài khoản chủ thiếu
--     quyền CRM sale_phong.lock_room.
--   - Lý do: 20261010114500 chỉ cấp khoá này cho vai TENANT_OWNER / tên 'Chủ sở hữu tổ chức'. Vai tự tạo 'Chủ công ty' và
--     'Quản Lý Tòa' (system_key NULL) không có.
--   - Mã connector đúng thiết kế khoá mượn: lớp thao tác mượn khoá, lớp Sale cấp. Test tái hiện ở infra/hermes-broker/server.test.mjs.
--   - 31/10 13:07 chủ tự bổ sung quyền cho chính mình trên web: ghi đè thành viên ALLOW, phạm vi toàn tổ chức. Vai 'Chủ công ty'
--     KHÔNG đổi.
--   - Chủ yêu cầu cấp luôn cho vai 'Quản Lý Tòa' bằng dữ liệu, tức file này.
--
-- PHẠM VI (đo production 31/10, chỉ đọc):
--   - Đúng 1 vai: org iHome aaaa0000-…-0001, tên 'Quản Lý Tòa', system_key NULL, ACTIVE.
--   - Vai chưa có dòng sale_phong.lock_room (không ALLOW, không DENY) ⇒ thêm đúng 1 dòng.
--   - Vai có 11 binding còn hiệu lực của 2 thành viên STAFF, mọi binding đều phạm vi TOÀ (19 toà) ⇒ hai quản lý được lock tạm và
--     gỡ lock ở đúng các toà mình quản lý, trên web và Hermes, không thêm toà nào.
--   - KHÔNG đổi vai 'Quản Lý Tòa' của org DEMO, không đổi mọi vai khác.
--   - KHÔNG cấp ở vai 'Chủ công ty'. Chủ đã có quyền qua ghi đè thành viên; cấp thêm ở vai sẽ thành nguồn thứ hai âm thầm, vẫn còn
--     nếu sau này chủ gỡ ghi đè.
--   - Không đổi binding, scope, ghi đè thành viên, registry Hermes, chính sách công ty hay kết nối.
--
-- NEO VAI: org iHome + system_key NULL + tên + ACTIVE. Unique index org_roles_org_name_lower_uidx bảo đảm org có tối đa một vai
-- trùng tên; file vẫn đếm và đòi đúng 1.
--
-- CHỐT: org iHome có mặt mà vắng khoá, hoặc vai đích vắng (đổi tên / RETIRED / mang system_key) ⇒ dừng để đo lại, không ghi gì.
-- Mọi phép kiểm và lệnh chèn nằm trong cùng một giao dịch.
--
-- IDEMPOTENT: ON CONFLICT DO NOTHING; dòng có sẵn được giữ nguyên, kể cả DENY do chủ tự đặt. Lượt chạy lại không chèn gì nên không
-- tăng authorization_version lần nữa. DB dựng lại từ baseline schema-only không có org iHome ⇒ không làm gì.
--
-- HỆ QUẢ: trigger a10_bump_authz_version tăng authorization_version của org, như mọi lần sửa quyền trên web. Bản xem trước /
-- confirmToken Hermes đang mở có thể gặp context_changed một lần. Không đụng tiền, không đổi schema.
--
-- LÙI: một câu. Trước migration vai này chưa có dòng khoá, nên câu lùi chỉ xoá đúng dòng vừa thêm:
--   DELETE FROM public.role_permissions rp USING public.organization_roles r
--    WHERE rp.organization_id=r.organization_id AND rp.role_id=r.id
--      AND r.organization_id='aaaa0000-0000-4000-8000-000000000001' AND r.system_key IS NULL AND r.name='Quản Lý Tòa'
--      AND rp.permission_key='sale_phong.lock_room' AND rp.effect='ALLOW';
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $grant_lock_room$
DECLARE
  v_ihome constant uuid:='aaaa0000-0000-4000-8000-000000000001';
  v_roles integer;
  v_role uuid;
  v_added integer;
BEGIN
  IF to_regclass('public.role_permissions') IS NULL OR to_regclass('public.organization_roles') IS NULL
    OR to_regclass('public.permission_definitions') IS NULL OR to_regclass('public.organizations') IS NULL THEN
    RAISE EXCEPTION 'quan_ly_toa_lock_room_dependencies_missing';
  END IF;

  -- DB không có org iHome (dựng lại từ baseline) ⇒ không có việc.
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id=v_ihome) THEN
    RETURN;
  END IF;

  -- Khoá có từ 20261010114500; vắng ⇒ dừng, không lặng lẽ bỏ qua.
  IF NOT EXISTS (SELECT 1 FROM public.permission_definitions
      WHERE key='sale_phong.lock_room' AND permission_domain='TENANT' AND is_active) THEN
    RAISE EXCEPTION 'quan_ly_toa_lock_room_permission_missing';
  END IF;

  SELECT count(*) INTO v_roles FROM public.organization_roles r
   WHERE r.organization_id=v_ihome AND r.system_key IS NULL AND r.name='Quản Lý Tòa' AND r.status='ACTIVE';
  IF v_roles<>1 THEN
    RAISE EXCEPTION 'quan_ly_toa_lock_room_role_missing: % vai khớp (cần 1) — vai Quản Lý Tòa của org iHome đã đổi từ lần đo 31/10, đo lại trước khi áp', v_roles;
  END IF;
  SELECT r.id INTO v_role FROM public.organization_roles r
   WHERE r.organization_id=v_ihome AND r.system_key IS NULL AND r.name='Quản Lý Tòa' AND r.status='ACTIVE';

  INSERT INTO public.role_permissions(organization_id, role_id, permission_key, effect)
  VALUES (v_ihome, v_role, 'sale_phong.lock_room', 'ALLOW')
  ON CONFLICT (organization_id, role_id, permission_key) DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;
  RAISE NOTICE 'quan_ly_toa_lock_room: thêm % dòng sale_phong.lock_room', v_added;
END
$grant_lock_room$;

COMMIT;
