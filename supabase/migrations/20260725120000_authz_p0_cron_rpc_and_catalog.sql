-- =============================================================================
-- P0 + chuẩn bị catalog cho cutover — phát hiện từ vòng kiểm chứng 179 agent
--
-- (1) LỖ HỔNG ĐANG MỞ: public.run_recurring_vouchers_job()
--     SECURITY DEFINER (chạy quyền postgres ⇒ bỏ qua RLS), KHÔNG có guard
--     auth.uid() nào, nhưng EXECUTE cấp cho cả `anon` lẫn `authenticated`.
--     Thân hàm gọi generate_recurring_vouchers(NULL) — SINH PHIẾU hàng loạt.
--     ⇒ bất kỳ ai có anon key công khai đều kích hoạt được việc sinh phiếu.
--
--     Ghi chú: generate_recurring_vouchers đã bị thu hồi anon+authenticated ở
--     20260710130500, nhưng wrapper này là SECURITY DEFINER nên nó vượt qua —
--     đúng mẫu "wrapper phá vỡ revoke" mà AUTHORIZATION-PLAN §9.3 điểm 6 cảnh báo.
--     Gate check-definer-acl không bắt vì hàm nằm trong baseline lịch sử.
--
--     Hàm chỉ có 1 caller hợp lệ: một pg_cron job (chạy dưới quyền postgres,
--     không phụ thuộc GRANT của anon/authenticated) ⇒ revoke an toàn.
--
-- (2) THIẾU 5 KEY TRONG CATALOG (chặn Ngày G)
--     98 cặp (resource, action) được policy + hàm truyền vào helper; 5 cặp không
--     có key trong permission_definitions:
--       settings.create · settings.delete
--       notifications.create · notifications.edit
--       sale_phong.edit
--     Ruột helper mới dừng ở tầng "quyền phải tồn tại & đang bật" ⇒ nếu không vá,
--     Ngày G sẽ mất các chức năng tương ứng.
--
--     `sale_phong.edit` là nhánh OR thứ ba của public.can_manage_pass_listing —
--     lần quét đầu của tôi bỏ sót vì trong THÂN HÀM đối số không có ép kiểu
--     ::text (khác với pg_policies.qual đã chuẩn hoá).
--
--     ⚠ role_permissions.permission_key và member_permission_overrides.permission_key
--     đều có FK tới permission_definitions(key) ⇒ PHẢI thêm catalog TRƯỚC khi cấp
--     bất kỳ quyền nào cho các key này.
--
--     Metadata (scope_kinds / sensitivity / required_dimensions) chép từ key anh em
--     cùng resource để không tự bịa ngữ nghĩa phạm vi.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- (1) Khoá RPC cron
-- -----------------------------------------------------------------------------
revoke all on function public.run_recurring_vouchers_job() from public, anon, authenticated;

comment on function public.run_recurring_vouchers_job() is
  'CHỈ pg_cron. SECURITY DEFINER không có guard actor nên KHÔNG được cấp cho anon/authenticated. Đã thu hồi 2026-07-25 sau khi phát hiện anon gọi được.';

-- -----------------------------------------------------------------------------
-- (2) Bổ sung 5 key còn thiếu, kế thừa metadata từ key anh em cùng resource
-- -----------------------------------------------------------------------------
insert into public.permission_definitions
  (key, resource, action, sensitivity, permission_domain, scope_kinds, is_active,
   scope_match_mode, requires_cashbook_possession, accepted_possession_kinds, required_dimensions)
select v.key, v.resource, v.action, v.sensitivity, sib.permission_domain, sib.scope_kinds, true,
       sib.scope_match_mode, false, '{}'::text[], sib.required_dimensions
from (values
        ('settings.create',      'settings',      'create', 'MANAGE'),
        ('settings.delete',      'settings',      'delete', 'MANAGE'),
        ('notifications.create', 'notifications', 'create', 'MANAGE'),
        ('notifications.edit',   'notifications', 'edit',   'MANAGE'),
        ('sale_phong.edit',      'sale_phong',    'edit',   'MANAGE')
     ) as v(key, resource, action, sensitivity)
cross join lateral (
  select pd.permission_domain, pd.scope_kinds, pd.scope_match_mode, pd.required_dimensions
    from public.permission_definitions pd
   where pd.resource = v.resource
   order by case pd.action when 'edit' then 0 when 'view' then 1 else 2 end
   limit 1
) sib
where not exists (select 1 from public.permission_definitions d where d.key = v.key);

commit;
