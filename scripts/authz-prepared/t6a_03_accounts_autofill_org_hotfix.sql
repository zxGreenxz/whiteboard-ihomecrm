-- ============================================================================
-- T6a HOTFIX — attach _autofill_org to accounts (regression từ t6a_02 NOT NULL).
-- STATUS: APPLIED production 2026-07-18. t6a_02 đặt accounts.organization_id NOT
-- NULL nhưng accounts KHÔNG có trigger autofill (không nằm trong 28 bảng Sprint
-- 3b) → insert legacy (không set org) fail 23502. Bắt được qua browser test
-- cashbook. Gắn _autofill_org (derive parent/membership) → mọi đường insert set
-- org. Verify: legacy insert demo.ketoan → org=demo tự set. (Staff off nên 0 tác
-- động thật.) LƯU Ý: _autofill_org có PROD_DEFAULT_FALLBACK cho actor đa-org —
-- hành vi nhất quán với các bảng khác.
-- ============================================================================
drop trigger if exists a01_autofill_org on public.accounts;
create trigger a01_autofill_org before insert on public.accounts
  for each row execute function public._autofill_org();
