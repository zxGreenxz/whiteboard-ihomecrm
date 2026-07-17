-- ============================================================================
-- T8/§9.3 PREPARED SQL — SECURITY DEFINER ACL burn-down (safe subset).
-- STATUS: APPLIED production 2026-07-18 (mega-window, audit §1.3 fix-now).
-- LÝ DO (audit 2026-07-18): 100 public secdef còn anon-EXECUTE; 63 trigger fn
--   còn client EXECUTE thừa; 6 money/admin fn anon-callable. Plan §9.1/§20.12:
--   ZERO internal/trigger/helper executable bởi anon/PUBLIC.
-- AN TOÀN: (1) trigger fn chạy dưới quyền owner khi trigger fire — REVOKE
--   EXECUTE KHÔNG ảnh hưởng trigger, chỉ chặn CALL trực tiếp (không caller hợp lệ
--   nào gọi trực tiếp trigger fn). (2) Money/admin fn: chỉ revoke ANON (client
--   chưa đăng nhập không có nghiệp vụ gọi); GIỮ authenticated (UI thật dùng, có
--   auth check nội bộ) để không gãy app. Reversible (re-grant nếu cần).
-- PHẦN CÒN LẠI (không trong file này): burn-down 100→allowlist đầy đủ cần
--   classify từng signature + CI gate — T8 gate riêng.
-- ============================================================================

begin;

-- 1. Revoke client EXECUTE khỏi MỌI trigger function (return trigger) trong
--    public + app_private. Trigger vẫn fire (chạy như owner). An toàn tuyệt đối.
do $revoke_triggers$
declare r record;
begin
  for r in
    select n.nspname, p.proname,
           pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname in ('public','app_private')
       and p.prorettype = 'pg_catalog.trigger'::regtype
  loop
    execute format('revoke execute on function %I.%I(%s) from public, anon, authenticated',
                   r.nspname, r.proname, r.args);
  end loop;
end $revoke_triggers$;

-- 2. Revoke ANON khỏi money/admin fn (giữ authenticated). anon = chưa đăng nhập,
--    không có nghiệp vụ gọi các hàm này.
do $revoke_sensitive_anon$
declare r record;
begin
  for r in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public'
       and p.proname in ('delete_staff_member','record_invoice_payment_v2',
         'record_invoice_payment_v3','super_admin_force_cancel_invoice',
         'restore_income_expense','award_job_bonus','update_income_expense_quick',
         'create_commission_voucher','pay_utility_bill')
       and has_function_privilege('anon', p.oid, 'EXECUTE')
  loop
    execute format('revoke execute on function public.%I(%s) from anon, public',
                   r.proname, r.args);
  end loop;
end $revoke_sensitive_anon$;

commit;
