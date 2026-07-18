-- ============================================================================
-- T6a/§16.8 + §20.1 PREPARED SQL — money tables organization_id NOT NULL + composite.
-- STATUS: APPLIED production 2026-07-18 (audit §3.2 fix-now, additive/fail-safe).
-- LÝ DO: 5 bảng tiền đạt zero-null nhưng attnotnull=f (có thể regress về NULL);
--   composite UNIQUE(org,id) chỉ có ở income_expenses → parent-child cross-org
--   consistency chưa khoá. Thêm NOT NULL (0 row vi phạm → an toàn) + composite
--   UNIQUE(org,id) làm target cho composite FK sau. Fail-safe: nếu có NULL thì
--   lệnh BÁO LỖI dừng, không hỏng dữ liệu.
-- ============================================================================

begin;

do $notnull$
declare t text; n bigint;
begin
  foreach t in array array['income_expenses','invoices','payments','accounts','excess_amounts'] loop
    execute format('select count(*) from public.%I where organization_id is null', t) into n;
    if n > 0 then
      raise exception 'T6a: % còn % dòng organization_id NULL — dừng, không set NOT NULL', t, n;
    end if;
    execute format('alter table public.%I alter column organization_id set not null', t);
    -- composite UNIQUE(organization_id, id) nếu chưa có (target cho composite FK)
    if not exists (
      select 1 from pg_constraint c join pg_class r on r.oid=c.conrelid
       where r.relname=t and c.contype='u'
         and pg_get_constraintdef(c.oid) ilike '%(organization_id, id)%'
    ) then
      execute format('alter table public.%I add constraint %I unique (organization_id, id)',
                     t, t||'_org_id_uq');
    end if;
  end loop;
end $notnull$;

commit;
