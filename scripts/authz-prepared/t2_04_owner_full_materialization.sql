-- ============================================================================
-- T2 PREPARED SQL 04 — materialize FULL TENANT_OWNER permission set.
-- STATUS: APPLIED production 2026-07-18 (mega-window).
-- LÝ DO (shadow-parity 2026-07-18): resolver v3 deny owner (DEFAULT_DENY) trong
--   135/150 kiểm, trong khi legacy can_do_on_building cho owner qua (owner
--   shortcut). Root cause: role TENANT_OWNER chỉ có 12/213 active TENANT
--   permission (seed cong queo) → owner thiếu thu_tien.collect, invoices.create,
--   contracts.create, meter_readings.create… Binding owner→TENANT_OWNER có scope
--   ORGANIZATION (phủ hết) nhưng role thiếu key. Fix: cấp ĐỦ 213 TENANT
--   permission (effect ALLOW) cho MỌI TENANT_OWNER role. Không grant quyền thực
--   tế mới (owner đã có tất cả qua legacy parachute) — chỉ đồng bộ đường
--   normalized để canonical writer authorize owner qua resolver thay vì rơi
--   fallback legacy. Idempotent (ON CONFLICT DO NOTHING giữ 12 seed cũ). Bump
--   authorization_version để invalidate cache. Verify shadow parity sau khi apply.
-- ============================================================================

begin;

insert into public.role_permissions (organization_id, role_id, permission_key, effect)
select r.organization_id, r.id, pd.key, 'ALLOW'
  from public.organization_roles r
  cross join public.permission_definitions pd
 where r.system_key = 'TENANT_OWNER'
   and pd.permission_domain = 'TENANT'
   and pd.is_active
on conflict (organization_id, role_id, permission_key) do nothing;

-- Cache invalidation: bump authorization_version cho mọi org có TENANT_OWNER.
update public.organizations o
   set authorization_version = authorization_version + 1
 where exists (select 1 from public.organization_roles r
                where r.organization_id = o.id and r.system_key = 'TENANT_OWNER');

commit;
