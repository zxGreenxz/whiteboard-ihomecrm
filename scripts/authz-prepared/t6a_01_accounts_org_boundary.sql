-- ============================================================================
-- T6a POINT-FIX — org-boundary RESTRICTIVE trên public.accounts.
-- STATUS: APPLIED lên production 2026-07-18 (mega-window), verify 2 chiều.
-- LÝ DO: W1-F4 — accounts THIẾU policy org_boundary (Sprint 3b chỉ phủ 28 bảng);
--   demo user đọc được 37 account của org thật (cross-tenant read leak trên bảng
--   tài chính). Mẫu y hệt invoices_org_boundary (RESTRICTIVE ALL, authenticated,
--   USING == WITH CHECK). Verify: demo real-read 37→0, demo own 3 giữ nguyên,
--   real-org user own 47 giữ nguyên. organization_id IS NULL = account shared/
--   global vẫn cho phép; is_account_shared_with_me vẫn hiệu lực TRONG cùng org.
-- LƯU Ý: đây chỉ là POINT-FIX một bảng. T6a đầy đủ (RLS v2 org-boundary cho toàn
--   bộ ~100 bảng tenant còn thiếu) phải làm theo shadow-compare, KHÔNG big-bang.
-- ============================================================================

drop policy if exists accounts_org_boundary on public.accounts;
create policy accounts_org_boundary on public.accounts as restrictive for all to authenticated
using (
  (organization_id is null)
  or (select public.is_super_admin())
  or (organization_id in (select unnest(public.my_org_ids())))
)
with check (
  (organization_id is null)
  or (select public.is_super_admin())
  or (organization_id in (select unnest(public.my_org_ids())))
);
