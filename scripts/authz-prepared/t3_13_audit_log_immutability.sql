-- ============================================================================
-- T3/§3.4 PREPARED SQL — audit-log immutability (append-only enforce).
-- STATUS: APPLIED production 2026-07-18 (audit §3.4 fix-now).
-- LÝ DO: invoice_audit_log + income_expense_audit_log GRANT DELETE/TRUNCATE/
--   UPDATE cho anon+authenticated → client xoá sạch lịch sử audit (RLS không
--   cover TRUNCATE). Audit log là append-only theo thiết kế: chỉ INSERT (append)
--   + SELECT (read) là hợp lệ; KHÔNG caller nào mutate/xoá. Revoke 3 quyền ghi-đè
--   khỏi client + BEFORE trigger phòng thủ (raise nếu UPDATE/DELETE/TRUNCATE).
--   An toàn (không caller hợp lệ), reversible.
-- ============================================================================

begin;

do $immut$
declare t text;
begin
  foreach t in array array['invoice_audit_log','income_expense_audit_log'] loop
    execute format('revoke update, delete, truncate on public.%I from anon, authenticated, public', t);
  end loop;
end $immut$;

create or replace function app_private.guard_audit_log_append_only()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $fn$
begin
  raise exception 'audit log is append-only (%. %)', tg_table_name, tg_op
    using errcode = '55000';
end;
$fn$;
revoke all on function app_private.guard_audit_log_append_only() from public, anon, authenticated, service_role;

do $trig$
declare t text;
begin
  foreach t in array array['invoice_audit_log','income_expense_audit_log'] loop
    execute format('drop trigger if exists a00_audit_append_only on public.%I', t);
    execute format($q$create trigger a00_audit_append_only
      before update or delete on public.%I
      for each row execute function app_private.guard_audit_log_append_only()$q$, t);
    execute format('drop trigger if exists a00_audit_no_truncate on public.%I', t);
    execute format($q$create trigger a00_audit_no_truncate
      before truncate on public.%I
      for each statement execute function app_private.guard_audit_log_append_only()$q$, t);
  end loop;
end $trig$;

commit;
