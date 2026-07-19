-- t5_25 — VÁ NHANH sau tổng kiểm plan-gap 2026-07-19 (P1 nhỏ, an toàn):
-- 1) super_admin_force_cancel_invoice_v2: probe nhầm public.payment_reversals
--    (bảng thật ở app_private) → nhánh "đã hoàn sạch thì huỷ" không bao giờ
--    đạt (fail-closed). Sửa đúng schema. (bug t5_18)
-- 2) REVOKE anon + PUBLIC khỏi các RPC money/config bị dính default-PUBLIC:
--    get/set_ie_auto_approve_threshold_v1 (t5_23 quên revoke),
--    approve/bulk_approve/unapprove_meter_reading_v1,
--    generate_recurring_vouchers_v2, pay_utility_bill — giữ authenticated.
-- 3) _termination_ensure_type: hạng mục thanh lý sinh động bị organization_id
--    NULL (tổng kiểm bắt 3 dòng mới trong ngày) → resolve org từ membership
--    của p_user_id (nhiều org → ưu tiên org user giữ role Chủ sở hữu tổ chức)
--    + backfill các dòng NULL hiện có cùng logic.

begin;

-- ========== 1) force_cancel_v2 schema fix ==========
CREATE OR REPLACE FUNCTION public.super_admin_force_cancel_invoice_v2(p_invoice_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_inv public.invoices%rowtype;
  v_active_payments int;
  v_has_reversals boolean;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  if not public.is_super_admin() then
    raise exception 'Chỉ super admin được phép huỷ hoá đơn ở trạng thái này' using errcode = '42501';
  end if;

  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'Hoá đơn không tồn tại';
  end if;
  if v_inv.deleted_at is not null then
    raise exception 'Hoá đơn đã bị xoá trước đó';
  end if;
  if v_inv.status = 'CANCELLED' then
    return json_build_object('invoice_id', v_inv.id, 'status', 'CANCELLED', 'noop', true);
  end if;

  -- LUẬT OWNER: mọi phiếu thu phải được huỷ/hoàn TRƯỚC.
  select to_regclass('app_private.payment_reversals') is not null into v_has_reversals;
  if v_has_reversals then
    execute
      'select count(*) from public.payments p
        where p.invoice_id = $1
          and not exists (select 1 from app_private.payment_reversals r
                           where r.original_payment_id = p.id)'
      into v_active_payments using p_invoice_id;
  else
    select count(*) into v_active_payments from public.payments p
     where p.invoice_id = p_invoice_id;
  end if;

  if v_active_payments > 0 then
    raise exception 'Hoá đơn còn % phiếu thu hiệu lực — hãy huỷ/hoàn từng phiếu thu trước rồi mới huỷ hoá đơn', v_active_payments;
  end if;

  -- Sạch phiếu thu: xoá credit gốc sinh TỪ hoá đơn này (không phải từ payment —
  -- các dòng đó thuộc vòng đời payment/reversal), rồi huỷ.
  delete from public.excess_amounts
   where source_invoice_id = p_invoice_id and source_payment_id is null;

  update public.invoices set status = 'CANCELLED' where id = p_invoice_id;

  return json_build_object('invoice_id', v_inv.id, 'status', 'CANCELLED', 'noop', false);
end;
$function$
;

-- ========== 2) REVOKE anon/PUBLIC ==========
revoke execute on function public.get_ie_auto_approve_threshold_v1() from public, anon;
revoke execute on function public.set_ie_auto_approve_threshold_v1(numeric) from public, anon;
revoke execute on function public.approve_meter_reading_v1(uuid) from public, anon;
revoke execute on function public.bulk_approve_meter_readings_v1(uuid[]) from public, anon;
revoke execute on function public.unapprove_meter_reading_v1(uuid) from public, anon;
revoke execute on function public.generate_recurring_vouchers_v2() from public, anon;
revoke execute on function public.pay_utility_bill(uuid, text, numeric, text, date, text, text, uuid, jsonb, uuid) from public, anon;

-- ========== 3) _termination_ensure_type org-stamp ==========
create or replace function public._termination_ensure_type(p_user_id uuid, p_type text, p_name text)
returns uuid
language plpgsql security definer
set search_path to 'public'
as $fn$
declare
  v_id uuid; v_org uuid;
begin
  -- org của người thao tác: 1 membership → dùng luôn; nhiều → ưu tiên org
  -- mà user giữ role "Chủ sở hữu tổ chức" (owner thật thuộc cả demo).
  select min(m.organization_id::text)::uuid into v_org
    from organization_memberships m
   where m.user_id = p_user_id and m.status = 'ACTIVE';
  if (select count(distinct m.organization_id) from organization_memberships m
       where m.user_id = p_user_id and m.status = 'ACTIVE') > 1 then
    select rb.organization_id into v_org
      from role_bindings rb
      join organization_memberships m
        on m.id = rb.membership_id and m.organization_id = rb.organization_id
       and m.user_id = p_user_id and m.status = 'ACTIVE'
      join organization_roles r on r.id = rb.role_id and r.name = 'Chủ sở hữu tổ chức'
     limit 1;
  end if;

  select id into v_id
    from income_expense_types
   where user_id = p_user_id
     and lower(name) = lower(p_name)
     and lower(type) = lower(p_type)
   limit 1;

  if v_id is not null then
    update income_expense_types
       set force_approval = true,
           organization_id = coalesce(organization_id, v_org)
     where id = v_id and (force_approval = false or organization_id is null);
    return v_id;
  end if;

  insert into income_expense_types (user_id, organization_id, type, name, description, force_approval)
  values (p_user_id, v_org, lower(p_type), p_name,
          'Tự tạo khi thanh lý hợp đồng', true)
  returning id into v_id;

  return v_id;
end;
$fn$;

-- backfill các hạng mục thanh lý org-NULL hiện có theo membership người tạo
update public.income_expense_types t
   set organization_id = sub.org
  from (
    select t2.id,
           coalesce(
             (select rb.organization_id
                from public.role_bindings rb
                join public.organization_memberships m2
                  on m2.id = rb.membership_id and m2.organization_id = rb.organization_id
                 and m2.user_id = t2.user_id and m2.status = 'ACTIVE'
                join public.organization_roles r on r.id = rb.role_id and r.name = 'Chủ sở hữu tổ chức'
               limit 1),
             (select min(m3.organization_id::text)::uuid
                from public.organization_memberships m3
               where m3.user_id = t2.user_id and m3.status = 'ACTIVE')
           ) as org
      from public.income_expense_types t2
     where t2.organization_id is null
  ) sub
 where t.id = sub.id and sub.org is not null;

commit;
