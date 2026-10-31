-- Chủ công ty thật thiếu quyền CRM "Lock tạm phòng" (sale_phong.lock_room) ⇒ Hermes ẩn khoá tạm / bỏ giữ phòng (31/10/2026).
--
-- HIỆN TƯỢNG (chat thật 31/10 08:19–08:21, hồ sơ Hermes owner = kết nối 676a886d…cc5388b9 của tài khoản chủ 0520169e…):
--   - crm_action_list page=contract trả 8 thao tác. contract.room_lock / contract.room_unlock nằm ở notPermitted, reason
--     forbidden: khoá đã bật cho công ty và kết nối nhưng người dùng THIẾU quyền CRM.
--   - crm_sale_action list có room_release (nhờ deposits.create) nhưng không có room_lock.
--   - Web cũng ẩn nút Lock tạm của tài khoản này: useMyPermissions → get_my_permissions_v2 → app_private.all_scoped_keys_v3,
--     cùng phép nối role_bindings ⋈ role_binding_scopes.
--
-- NGUYÊN NHÂN (đo production 31/10, chỉ đọc):
--   - 20261010114500 chỉ cấp sale_phong.lock_room cho vai system_key='TENANT_OWNER' hoặc vai tên 'Chủ sở hữu tổ chức'.
--   - Nguồn quyền nghiệp vụ hằng ngày của chủ là vai TỰ TẠO 'Chủ công ty' (system_key NULL, 20260811030000). Vai này có
--     deposits.create/edit, rooms.edit, sale_phong.edit, contracts.* nhưng KHÔNG có sale_phong.lock_room.
--   - Binding của chủ vào vai TENANT_OWNER (20260831160000) chỉ nhằm cho is_org_owner_v1 = TRUE. Binding này không có dòng
--     role_binding_scopes. authorized_scope_v3, all_scoped_keys_v3 và authorize_tenant_action_v3 đều nối INNER
--     role_binding_scopes ⇒ binding không mở được quyền nào.
--   - Kết quả: get_authorization_context_v1 thiếu khoá này, hermes_sale_capabilities_v1 trả {allowed:false, companyEnabled:true}.
--   - Mã connector chạy đúng thiết kế: lớp thao tác MƯỢN khoá, lớp Sale cấp khoá. Test tái hiện ở
--     infra/hermes-broker/server.test.mjs.
--
-- SỬA: cấp sale_phong.lock_room (ALLOW) cho vai 'Chủ công ty' có system_key NULL và đang ACTIVE.
--   - Neo vai giống app_private.ie_actor_is_company_owner_v1.
--   - Ý định của 20261010114500 là "vai chủ sở hữu có sẵn như các quyền sale_phong khác", nhưng file đó bỏ sót vai chủ tự tạo.
--   - Đo production 31/10: đúng 1 vai khớp (org iHome aaaa0000-…-0001), 1 binding là chính chủ, chưa có dòng sale_phong.lock_room
--     ⇒ thêm đúng 1 dòng. Không có vai RETIRED nào trùng tên.
--   - Vai DEMO tên 'Chủ công ty' mang system_key TENANT_OWNER, đã có khoá từ trước, không bị đụng.
--   - Vai khác (Quản Lý Tòa, Partner…) giữ nguyên; chủ tự gán ở Phân quyền. Không đổi binding, scope hay registry Hermes.
--
-- HỆ QUẢ: trigger a10_bump_authz_version tăng authorization_version của org, như mọi lần sửa quyền trên web. Bản xem trước /
-- confirmToken Hermes đang mở có thể gặp context_changed một lần. Không đụng tiền, không đổi schema.
--
-- IDEMPOTENT: ON CONFLICT DO NOTHING; dòng đã có được giữ nguyên, kể cả DENY do chủ tự đặt. Lượt chạy lại không chèn gì nên
-- không tăng authorization_version lần nữa. DB dựng lại từ baseline schema-only không có org hay vai nào ⇒ 0 dòng, không dừng.
--
-- CHỐT: org iHome có mặt mà vai đích vắng (bị đổi tên / RETIRED sau lần đo) hoặc vắng khoá ⇒ dừng để đo lại, không COMMIT xanh
-- mà chẳng sửa gì. Chốt chạy trong cùng giao dịch với lệnh chèn, nên khi dừng thì dòng đã chèn cũng lùi theo.
--
-- LÙI: một câu, chỉ chạm đúng vai đã đo. Trước migration vai đó chưa có dòng này, nên câu lùi chỉ xoá đúng dòng vừa thêm:
--   DELETE FROM public.role_permissions rp USING public.organization_roles r
--    WHERE rp.organization_id=r.organization_id AND rp.role_id=r.id
--      AND r.organization_id='aaaa0000-0000-4000-8000-000000000001' AND r.system_key IS NULL AND r.name='Chủ công ty'
--      AND rp.permission_key='sale_phong.lock_room' AND rp.effect='ALLOW';
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $grant_lock_room$
DECLARE
  v_ihome constant uuid:='aaaa0000-0000-4000-8000-000000000001';
  v_added integer;
BEGIN
  IF to_regclass('public.role_permissions') IS NULL OR to_regclass('public.organization_roles') IS NULL
    OR to_regclass('public.permission_definitions') IS NULL OR to_regclass('public.organizations') IS NULL THEN
    RAISE EXCEPTION 'chu_cong_ty_lock_room_dependencies_missing';
  END IF;

  -- Khoá có từ 20261010114500. Vắng khoá mà vẫn có vai cần cấp, hoặc có org iHome ⇒ dừng, không lặng lẽ bỏ qua.
  -- DB không có vai nào và không có org iHome (dựng lại từ baseline) ⇒ không có việc.
  IF NOT EXISTS (SELECT 1 FROM public.permission_definitions
      WHERE key='sale_phong.lock_room' AND permission_domain='TENANT' AND is_active) THEN
    IF EXISTS (SELECT 1 FROM public.organization_roles r
        WHERE r.system_key IS NULL AND r.name='Chủ công ty' AND r.status='ACTIVE')
      OR EXISTS (SELECT 1 FROM public.organizations WHERE id=v_ihome) THEN
      RAISE EXCEPTION 'chu_cong_ty_lock_room_permission_missing';
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.role_permissions(organization_id, role_id, permission_key, effect)
  SELECT r.organization_id, r.id, 'sale_phong.lock_room', 'ALLOW'
    FROM public.organization_roles r
   WHERE r.system_key IS NULL AND r.name='Chủ công ty' AND r.status='ACTIVE'
  ON CONFLICT (organization_id, role_id, permission_key) DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;
  RAISE NOTICE 'chu_cong_ty_lock_room: thêm % dòng sale_phong.lock_room', v_added;

  -- Chốt vai đã đo: org iHome có mặt thì vai 'Chủ công ty' (system_key NULL, ACTIVE) của nó phải có mặt và có dòng khoá này
  -- (ALLOW vừa thêm, hoặc dòng có sẵn được giữ nguyên). DB dựng lại không có org này ⇒ bỏ qua.
  IF EXISTS (SELECT 1 FROM public.organizations WHERE id=v_ihome) AND NOT EXISTS (
      SELECT 1 FROM public.organization_roles r
        JOIN public.role_permissions rp ON rp.organization_id=r.organization_id AND rp.role_id=r.id
         AND rp.permission_key='sale_phong.lock_room'
       WHERE r.organization_id=v_ihome AND r.system_key IS NULL AND r.name='Chủ công ty' AND r.status='ACTIVE') THEN
    RAISE EXCEPTION 'chu_cong_ty_lock_room_role_missing: vai Chủ công ty của org iHome đã đổi từ lần đo 31/10 — đo lại trước khi áp';
  END IF;
END
$grant_lock_room$;

COMMIT;
