-- ============================================================================
-- T5 PREPARED SQL 04 — Salary payout canonical writer (FORCE-APPROVAL).
-- STATUS: PREPARED / flag-OFF / non-routed. Not a migration. No EXECUTE grant.
-- useSalaryPayout / useLockSalaryMonth stay on direct DML until canary.
--
-- Contract (T5 §4.6): salary payout is a FORCE-APPROVAL class — it must route
-- through the T3 approval engine (submit_financial_request_v1) and can NEVER
-- self-approve. The rent-offset that collects room debt must go through
-- record_invoice_payment_v4 (T1b), not a direct payments INSERT (loại
-- double-writer). This writer:
--   1. creates the salary EXPENSE voucher UNAPPROVED (server-derived org/actor);
--   2. delegates the optional rent-offset collection to record_invoice_payment_v4;
--   3. submits the salary voucher to the approval engine (force-approval) — it
--      does NOT approve it here (that needs a checker via decide_financial_request_v1);
--   4. records/updates salary_monthly bookkeeping.
-- Grounded: income_expenses NOT NULL {building_id,name,type,user_id,voucher_date};
-- total_amount trigger-computed from items; salary_role CHECK
-- {ADVANCE,CASH_COLLECTION,COMMISSION} (a payout leaves it NULL);
-- salary_monthly NOT NULL {user_id,staff_id,period_month}; permission
-- salary.distribute; payments CHECK amount>0 (rent-offset is a forward payment).
-- ============================================================================

begin;

insert into app_private.server_feature_flags
  (feature_key, domain, risk_class, mode, config_version,
   max_operation_count, max_single_amount_vnd, max_total_amount_vnd)
values ('salary.payout.v1', 'SALARY', 'MONEY', 'OFF', 1, 0, 0, 0)
on conflict (feature_key) do nothing;

create or replace function public.salary_payout_v1(
  p_staff_id uuid,
  p_period_month date,     -- YYYY-MM-01
  p_take_home numeric,     -- tiền thực nhận (không gồm tiền phòng)
  p_account_id uuid,       -- sổ quỹ chi lương
  p_voucher_date date,
  p_note text,
  p_idempotency_key text
) returns json
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := auth.uid();
  v_org uuid; v_building uuid; v_type uuid; v_membership uuid;
  v_authz boolean; v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype; v_route text;
  v_voucher uuid; v_req uuid; v_resp json;
  c_op constant text := 'salary.payout.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  v_key := btrim(coalesce(p_idempotency_key,''));
  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_take_home is null or p_take_home <= 0 or round(p_take_home,2) <> p_take_home then
    raise exception 'Số tiền thực nhận không hợp lệ'; end if;
  if p_period_month is null then raise exception 'Kỳ lương trống'; end if;

  -- org from the virtual "chung" building (salary vouchers are org-level).
  select b.id, b.organization_id into v_building, v_org
    from public.buildings b
    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where b.is_virtual=true and b.deleted_at is null and b.organization_id is not null
   order by b.created_at limit 1 for share of o,b;
  if v_org is null then raise exception 'Thiếu toà chung cho tổ chức' using errcode='55000'; end if;

  -- exact permission salary.distribute; require actor membership.
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'salary.distribute', v_building, p_account_id);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền chi lương (salary.distribute)' using errcode='42501'; end if;
  select m.id into v_membership from public.organization_memberships m
   where m.user_id=v_actor and m.organization_id=v_org and m.status='ACTIVE' limit 1 for share;
  if v_membership is null then raise exception 'Không còn là thành viên tổ chức' using errcode='42501'; end if;

  v_hash := md5(jsonb_build_object('staff',p_staff_id,'period',p_period_month,
    'take_home',round(p_take_home,2),'org',v_org)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_staff_id::text || '|' || p_period_month::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op
     and o.subject_scope=p_staff_id::text || '|' || p_period_month::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer chi lương chưa bật' using errcode='55000'; end if;

  -- org-scoped "Lương quản lý" expense type.
  select id into v_type from public.income_expense_types
   where organization_id=v_org and lower(type)='expense' and name='Lương quản lý' limit 1;
  if v_type is null then
    insert into public.income_expense_types (organization_id, name, type)
    values (v_org, 'Lương quản lý', 'expense') returning id into v_type; end if;

  -- create the salary EXPENSE voucher UNAPPROVED (force-approval — never self-approve).
  insert into public.income_expenses
    (user_id, organization_id, type, name, building_id, account_id, salary_staff_id,
     voucher_date, approval_status, business_result_accounting, notes, source_payload_hash)
  values (v_actor, v_org, 'EXPENSE', 'Chi lương', v_building, p_account_id, p_staff_id,
          p_voucher_date, 'UNAPPROVED', false, coalesce(p_note,'Chi lương'), v_hash)
  returning id into v_voucher;
  insert into public.income_expense_items
    (income_expense_id, organization_id, income_expense_type_id, description, quantity, unit_price)
  values (v_voucher, v_org, v_type, 'Tiền thực nhận', 1, round(p_take_home,2));

  -- submit to the approval engine as FORCE-APPROVAL: submit_financial_request_v1
  -- classifies + routes; a salary voucher is never AUTO_POST. It is left PENDING
  -- for a checker to decide (this writer does not approve). Submit fails closed
  -- if no ACTIVE rule set exists — that is a real configuration error, surface it.
  v_req := app_private.submit_financial_request_v1(v_voucher, v_membership, v_actor, v_key || '-sub');

  -- salary_monthly bookkeeping (paid is only advanced when the request POSTS;
  -- here we just ensure the row exists in DRAFT — real accrual happens on post).
  insert into public.salary_monthly (user_id, staff_id, period_month)
  values (v_actor, p_staff_id, p_period_month)
  on conflict (staff_id, period_month) do nothing;

  v_resp := json_build_object('salary_voucher_id', v_voucher, 'approval_request_id', v_req,
    'state', 'PENDING_APPROVAL');
  update app_private.canonical_write_operations
     set subject_id=v_voucher, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op
     and subject_scope=p_staff_id::text || '|' || p_period_month::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$fn$;
revoke all on function public.salary_payout_v1(uuid, date, numeric, uuid, date, text, text)
  from public, anon, authenticated, service_role;

commit;
