-- ============================================================================
-- T5 PREPARED SQL 03 — Cashbook (accounts) canonical writers.
-- STATUS: PREPARED / flag-OFF / non-routed. Not a migration. No EXECUTE grant.
-- useAccounts.ts (create/update/lock/delete) stays on direct DML until canary.
--
-- Grounded in live public.accounts (= cashbooks):
--  NOT NULL: user_id, name, is_default, code, initial_amount, initial_date,
--    is_virtual. organization_id nullable → derive+validate. code auto-gen via
--    trg_accounts_set_code. lock_date (nullable) is the period lock, enforced by
--    the live income_expenses_check_lock trigger (P0001 on vouchers <= lock_date).
--  Balance = initial_amount + sum(income_expenses effects); opening adjustment is
--    a FORWARD-FIX compensating income_expense, never a raw initial_amount edit.
--  Permissions: cashbooks.create (ORGANIZATION), cashbooks.edit, cashbooks.post
--    (CASHBOOK + possession), cashbooks.manage_custody, cashbooks.delete.
-- ============================================================================

begin;

insert into app_private.server_feature_flags
  (feature_key, domain, risk_class, mode, config_version,
   max_operation_count, max_single_amount_vnd, max_total_amount_vnd)
values
  ('cashbook.create.v1', 'CASHBOOK', 'MONEY', 'OFF', 1, 0, 0, 0),
  ('cashbook.opening_adjust.v1', 'CASHBOOK', 'MONEY', 'OFF', 1, 0, 0, 0),
  ('cashbook.lock_period.v1', 'CASHBOOK', 'NON_MONEY', 'OFF', 1, 0, 0, 0),
  ('cashbook.archive.v1', 'CASHBOOK', 'NON_MONEY', 'OFF', 1, 0, 0, 0)
on conflict (feature_key) do nothing;

-- ---------------------------------------------------------------------------
-- A — create_cashbook_v1: opening balance server-controlled; org derived.
-- ---------------------------------------------------------------------------
create or replace function public.create_cashbook_v1(
  p_name text,
  p_initial_amount numeric,
  p_initial_date date,
  p_bank_name text,
  p_account_number text,
  p_quick_default_building_id uuid,
  p_idempotency_key text
) returns json
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_authz boolean;
  v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype;
  v_route text;
  v_id uuid;
  v_resp json;
  c_op constant text := 'cashbook.create.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  v_key := btrim(coalesce(p_idempotency_key,''));
  if char_length(v_key) < 8 or char_length(v_key) > 200
     or v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if coalesce(length(btrim(p_name)),0) = 0 then raise exception 'Tên sổ quỹ trống'; end if;
  if p_initial_amount is null or round(p_initial_amount,2) <> p_initial_amount then
    raise exception 'Số dư đầu không hợp lệ'; end if;
  if p_initial_date is null then raise exception 'Ngày đầu kỳ trống'; end if;

  -- org: derive from the actor's single ACTIVE membership (a cashbook is org-level,
  -- there is no parent building for a bare cashbook). Fail closed if ambiguous.
  select m.organization_id into v_org from public.organization_memberships m
   where m.user_id = v_actor and m.status='ACTIVE'
   group by m.organization_id
   having count(*) = 1;
  if v_org is null then
    raise exception 'Không xác định được tổ chức duy nhất của người dùng' using errcode='42501'; end if;

  -- optional building must be same-org.
  if p_quick_default_building_id is not null then
    perform 1 from public.buildings b where b.id=p_quick_default_building_id
      and b.deleted_at is null and b.organization_id=v_org for share;
    if not found then raise exception 'Toà nhà mặc định không thuộc tổ chức' using errcode='42501'; end if;
  end if;

  -- exact permission cashbooks.create (ORGANIZATION scope).
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'cashbooks.create', null, null);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền tạo sổ quỹ (cashbooks.create)' using errcode='42501'; end if;

  v_hash := md5(jsonb_build_object('name',p_name,'org',v_org,'init',p_initial_amount,'date',p_initial_date)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, v_org::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=v_org::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer sổ quỹ chưa bật' using errcode='55000'; end if;

  insert into public.accounts
    (user_id, organization_id, name, initial_amount, initial_date, is_default,
     is_virtual, bank_name, account_number, quick_default_building_id)
  values (v_actor, v_org, btrim(p_name), p_initial_amount, p_initial_date, false,
          false, nullif(btrim(p_bank_name),''), nullif(btrim(p_account_number),''),
          p_quick_default_building_id)
  returning id into v_id;

  v_resp := json_build_object('cashbook_id', v_id);
  update app_private.canonical_write_operations
     set subject_id=v_id, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op and subject_scope=v_org::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$fn$;
revoke all on function public.create_cashbook_v1(text, numeric, date, text, text, uuid, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- B — request_opening_balance_adjustment_v1: FORWARD-FIX. Never overwrites
-- initial_amount; posts a compensating adjustment income_expense (INCOME if
-- +, EXPENSE if -) dated at/after the opening so the running balance corrects
-- while the audit trail is preserved. Requires cashbooks.edit + possession.
-- ---------------------------------------------------------------------------
create or replace function public.request_opening_balance_adjustment_v1(
  p_cashbook_id uuid,
  p_delta numeric,
  p_reason text,
  p_idempotency_key text
) returns json
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_acct record;
  v_authz boolean;
  v_holds boolean;
  v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype;
  v_route text;
  v_type uuid; v_voucher uuid;
  v_resp json;
  c_op constant text := 'cashbook.opening_adjust.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  v_key := btrim(coalesce(p_idempotency_key,''));
  if char_length(v_key) < 8 or char_length(v_key) > 200
     or v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_delta is null or p_delta = 0 or round(p_delta,2) <> p_delta then
    raise exception 'Giá trị điều chỉnh không hợp lệ'; end if;
  if coalesce(length(btrim(p_reason)),0) < 5 then raise exception 'Lý do điều chỉnh quá ngắn'; end if;

  select a.id, a.organization_id, a.initial_date, a.lock_date, a.quick_default_building_id
    into v_acct from public.accounts a
   where a.id=p_cashbook_id and a.deleted_at is null for update;
  if not found then raise exception 'Không tìm thấy sổ quỹ' using errcode='42501'; end if;
  v_org := v_acct.organization_id;
  if v_org is null then raise exception 'Sổ quỹ chưa gắn tổ chức' using errcode='23514'; end if;
  -- income_expenses.building_id is NOT NULL; an adjustment must be attributed to
  -- a building. Use the cashbook's default building, else the org's first one.
  if v_acct.quick_default_building_id is null then
    select id into v_acct.quick_default_building_id from public.buildings
     where organization_id=v_org and deleted_at is null order by created_at limit 1;
    if v_acct.quick_default_building_id is null then
      raise exception 'Không có toà nhà để ghi phiếu điều chỉnh' using errcode='55000'; end if;
  end if;

  -- exact permission cashbooks.post (requires possession) on this cashbook.
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'cashbooks.post', null, p_cashbook_id);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền điều chỉnh sổ quỹ (cashbooks.post + possession)' using errcode='42501'; end if;

  v_hash := md5(jsonb_build_object('cb',p_cashbook_id,'org',v_org,'delta',p_delta)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_cashbook_id::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=p_cashbook_id::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer điều chỉnh sổ quỹ chưa bật' using errcode='55000'; end if;

  -- get-or-create the adjustment type; post a compensating voucher.
  select id into v_type from public.income_expense_types
   where organization_id=v_org and name='Điều chỉnh số dư đầu kỳ'
     and lower(coalesce(type,'income')) = case when p_delta > 0 then 'income' else 'expense' end
   limit 1;
  if v_type is null then
    insert into public.income_expense_types (organization_id, name, type)
    values (v_org, 'Điều chỉnh số dư đầu kỳ', case when p_delta>0 then 'income' else 'expense' end)
    returning id into v_type;
  end if;

  insert into public.income_expenses
    (user_id, organization_id, type, name, account_id, building_id, voucher_date,
     approval_status, approved_by, approved_at, notes)
  values (v_actor, v_org, case when p_delta>0 then 'INCOME' else 'EXPENSE' end,
          'Điều chỉnh số dư đầu kỳ', p_cashbook_id, v_acct.quick_default_building_id,
          greatest(v_acct.initial_date, coalesce(v_acct.lock_date, v_acct.initial_date) + 1),
          'APPROVED', v_actor, now(), 'Điều chỉnh: ' || p_reason)
  returning id into v_voucher;
  insert into public.income_expense_items
    (income_expense_id, organization_id, income_expense_type_id, description, quantity, unit_price)
  values (v_voucher, v_org, v_type, 'Điều chỉnh số dư đầu kỳ', 1, abs(p_delta));

  v_resp := json_build_object('adjustment_voucher_id', v_voucher, 'delta', p_delta);
  update app_private.canonical_write_operations
     set subject_id=v_voucher, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op and subject_scope=p_cashbook_id::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$fn$;
revoke all on function public.request_opening_balance_adjustment_v1(uuid, numeric, text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- C — lock_cashbook_period_v1 / unlock: set/clear accounts.lock_date (the live
-- income_expenses_check_lock trigger enforces it). Monotonic: cannot move the
-- lock earlier (unlock is a distinct permissioned op). cashbooks.edit.
-- ---------------------------------------------------------------------------
create or replace function public.lock_cashbook_period_v1(
  p_cashbook_id uuid, p_lock_date date, p_unlock boolean default false)
returns json
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := auth.uid();
  v_acct record; v_org uuid; v_authz boolean; v_route text; v_new date;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  select a.id, a.organization_id, a.lock_date into v_acct
    from public.accounts a where a.id=p_cashbook_id and a.deleted_at is null for update;
  if not found then raise exception 'Không tìm thấy sổ quỹ' using errcode='42501'; end if;
  v_org := v_acct.organization_id;
  if v_org is null then raise exception 'Sổ quỹ chưa gắn tổ chức' using errcode='23514'; end if;

  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'cashbooks.edit', null, p_cashbook_id);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền khoá sổ (cashbooks.edit)' using errcode='42501'; end if;

  v_route := app_private.evaluate_feature_route('cashbook.lock_period.v1', v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer khoá sổ chưa bật' using errcode='55000'; end if;

  if p_unlock then
    v_new := null; -- clearing the lock is the explicit unlock branch
  else
    if p_lock_date is null then raise exception 'Ngày khoá trống'; end if;
    -- monotonic: cannot move an existing lock earlier
    if v_acct.lock_date is not null and p_lock_date < v_acct.lock_date then
      raise exception 'Không thể lùi ngày khoá sổ' using errcode='55000'; end if;
    v_new := p_lock_date;
  end if;

  update public.accounts set lock_date = v_new where id = p_cashbook_id;
  return json_build_object('cashbook_id', p_cashbook_id, 'lock_date', v_new);
end;
$fn$;
revoke all on function public.lock_cashbook_period_v1(uuid, date, boolean)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- D — archive_cashbook_v1: soft-delete (deleted_at), guarded — cannot archive a
-- cashbook that still has non-deleted vouchers (balance integrity). cashbooks.delete.
-- ---------------------------------------------------------------------------
create or replace function public.archive_cashbook_v1(p_cashbook_id uuid)
returns json
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := auth.uid();
  v_acct record; v_org uuid; v_authz boolean; v_route text; v_vouchers int;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  select a.id, a.organization_id into v_acct
    from public.accounts a where a.id=p_cashbook_id and a.deleted_at is null for update;
  if not found then raise exception 'Không tìm thấy sổ quỹ' using errcode='42501'; end if;
  v_org := v_acct.organization_id;
  if v_org is null then raise exception 'Sổ quỹ chưa gắn tổ chức' using errcode='23514'; end if;

  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'cashbooks.delete', null, p_cashbook_id);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền lưu trữ sổ quỹ (cashbooks.delete)' using errcode='42501'; end if;

  v_route := app_private.evaluate_feature_route('cashbook.archive.v1', v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer lưu trữ sổ quỹ chưa bật' using errcode='55000'; end if;

  select count(*) into v_vouchers from public.income_expenses
   where account_id=p_cashbook_id and deleted_at is null;
  if v_vouchers > 0 then
    raise exception 'Sổ quỹ còn % phiếu — không thể lưu trữ', v_vouchers using errcode='55000'; end if;

  update public.accounts set deleted_at = now() where id = p_cashbook_id;
  return json_build_object('cashbook_id', p_cashbook_id, 'archived', true);
end;
$fn$;
revoke all on function public.archive_cashbook_v1(uuid)
  from public, anon, authenticated, service_role;

commit;
