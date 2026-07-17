-- ============================================================================
-- T3 PREPARED SQL 10 — Freeze-exempt canonical transition path.
-- STATUS: PREPARED (compile+behavior tested on disposable PG17 exact-source
-- restore). NOT a migration; private; no grant.
--
-- Problem: the full-freeze guard (t3_01) blocks ALL UPDATE on canonical-marked
-- income_expenses, but legitimate posting must transition a claimed DRAFT to
-- POSTED (set approval_status/posting_id/posted_at_v2/reversed_by_posting_id).
--
-- Mechanism (NOT a GUC, NOT identity — both forbidden by the review):
--   a transaction-scoped authorization TOKEN in app_private, created ONLY by
--   the private transition routine, keyed by (income_expense_id, xid). The
--   freeze guard allows an UPDATE on a canonical row iff a matching token
--   exists for the current xid AND only lifecycle columns changed (the
--   financial payload — amount, items, account, building, contract — stays
--   frozen even during an authorized transition). Tokens are inserted and
--   deleted inside one SECURITY DEFINER routine, so they never outlive the
--   transition and cannot be forged by client/legacy paths (app_private is
--   revoked from all app roles; the token table has no client writer).
-- ============================================================================

begin;

create table if not exists app_private.ie_transition_authorization (
  income_expense_id uuid primary key,
  xid xid8 not null,
  purpose text not null,
  granted_at timestamptz not null default clock_timestamp()
);
revoke all on app_private.ie_transition_authorization
  from public, anon, authenticated, service_role;

-- Rewrite the parent freeze guard to permit token-authorized lifecycle-only
-- transitions. Payload columns remain frozen unconditionally.
create or replace function app_private.guard_income_expense_owned_payload()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'app_private'
as $fn$
declare
  v_authorized boolean;
begin
  if tg_op = 'DELETE' then
    if app_private.is_income_expense_flow_owned(old.id) then
      raise exception 'canonical income expense % is frozen (delete rejected)', old.id
        using errcode = '55000';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if not app_private.is_income_expense_flow_owned(old.id)
       and not (new.id is distinct from old.id
                and app_private.is_income_expense_flow_owned(new.id)) then
      return new; -- unmarked legacy row: unchanged behavior
    end if;

    -- canonical row: check for a live transition token in THIS transaction
    select exists (
      select 1 from app_private.ie_transition_authorization t
       where t.income_expense_id = old.id and t.xid = pg_current_xact_id()
    ) into v_authorized;

    if not v_authorized then
      raise exception 'canonical income expense % is frozen (update rejected)', old.id
        using errcode = '55000';
    end if;

    -- Even authorized: financial payload columns must NOT change.
    if new.id is distinct from old.id
       or new.organization_id is distinct from old.organization_id
       or new.total_amount is distinct from old.total_amount
       or new.account_id is distinct from old.account_id
       or new.building_id is distinct from old.building_id
       or new.room_id is distinct from old.room_id
       or new.contract_id is distinct from old.contract_id
       or new.tenant_id is distinct from old.tenant_id
       or new.type is distinct from old.type
       or new.attachments is distinct from old.attachments
       or new.source_payload_hash is distinct from old.source_payload_hash then
      raise exception 'authorized transition cannot alter payload of %', old.id
        using errcode = '55000';
    end if;
    return new;
  end if;

  return new;
end;
$fn$;
revoke all on function app_private.guard_income_expense_owned_payload()
  from public, anon, authenticated, service_role;

-- Private transition primitive: grant token, apply the lifecycle UPDATE, revoke
-- token — all in one SECURITY DEFINER call so the exemption is airtight.
create or replace function app_private.transition_canonical_income_expense_v1(
  p_income_expense_id uuid,
  p_new_approval_status text,
  p_posting_id uuid,
  p_reversed_by_posting_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_rows int;
begin
  if not app_private.is_income_expense_flow_owned(p_income_expense_id) then
    raise exception 'not a canonical row: %', p_income_expense_id using errcode='55000';
  end if;
  if p_new_approval_status not in ('APPROVED','CANCELLED','REVERSED','DENIED','REJECTED') then
    raise exception 'illegal transition target %', p_new_approval_status using errcode='22023';
  end if;

  insert into app_private.ie_transition_authorization
    (income_expense_id, xid, purpose)
  values (p_income_expense_id, pg_current_xact_id(), p_new_approval_status);

  update public.income_expenses
     set approval_status = p_new_approval_status,
         posting_id = coalesce(p_posting_id, posting_id),
         posted_at_v2 = case when p_new_approval_status='APPROVED'
                             then clock_timestamp() else posted_at_v2 end,
         reversed_by_posting_id = coalesce(p_reversed_by_posting_id, reversed_by_posting_id)
   where id = p_income_expense_id;
  get diagnostics v_rows = row_count;

  delete from app_private.ie_transition_authorization
   where income_expense_id = p_income_expense_id and xid = pg_current_xact_id();

  if v_rows <> 1 then
    raise exception 'transition affected % rows (expected 1)', v_rows using errcode='55000';
  end if;
end;
$fn$;
revoke all on function app_private.transition_canonical_income_expense_v1(
  uuid, text, uuid, uuid)
  from public, anon, authenticated, service_role;

commit;
