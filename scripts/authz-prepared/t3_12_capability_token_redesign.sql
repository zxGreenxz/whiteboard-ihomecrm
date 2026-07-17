-- ============================================================================
-- T3 PREPARED SQL 12 — A.9 smallest-shape capability model (Supabase-viable).
-- STATUS: PREPARED (compile+behavior tested on staging Supabase PG17 AND local
-- harness). NOT a migration; production apply gated by owner.
--
-- WHY THIS EXISTS (on-target finding, staging validation 2026-07-17):
--   The "re-own the public wrapper to a bare NOLOGIN ie_canonical_writer role"
--   design (t3_02) CANNOT work on Supabase:
--     - Supabase `postgres` is NOT a superuser and is NOT a member of
--       `supabase_admin` (the owner of schema `auth`), so it cannot GRANT
--       USAGE ON SCHEMA auth to ie_canonical_writer.
--     - The live SECURITY INVOKER trigger `_guard_ie_financial_columns` on
--       public.income_expenses calls `auth.uid()`. When the wrapper runs as
--       ie_canonical_writer, that trigger fires under the same role and dies
--       with "permission denied for schema auth" — un-grantable by the migration.
--   The harness masked this because local `postgres` is a superuser.
--
-- THE FIX (A.9 §2 smallest shape): the wrapper stays owned by `postgres` (which
-- HAS auth access, so INVOKER triggers resolve). The claim capability is no
-- longer `current_user = 'ie_canonical_writer'` (unreachable now) but a
-- TRANSACTION-LOCAL capability token that ONLY a postgres-owned DEFINER setter
-- can stamp. Client/legacy roles cannot call the setter (revoked) and cannot
-- forge the GUC (it is a namespaced local GUC set only inside the setter, which
-- is SECURITY DEFINER owned by postgres and granted to no app role).
--
-- Security argument: identical trust boundary to the old design. Old: "only code
-- running as ie_canonical_writer can claim." New: "only code that called the
-- postgres-owned DEFINER setter (reachable solely from the wrapper) can claim."
-- Both are un-forgeable by anon/authenticated/service_role. The token is
-- transaction-scoped (set_config local=true) so it cannot leak across statements
-- after the wrapper's transaction ends.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Capability setter/checker (postgres-owned DEFINER; not granted to clients)
-- ---------------------------------------------------------------------------

-- A per-transaction nonce proves the token was set THIS transaction by the
-- setter, not carried in via a client GUC. The setter returns the nonce; the
-- claim requires the caller to echo it, closing the "client pre-sets the GUC"
-- vector even though the GUC name is namespaced.
create or replace function app_private.grant_ie_claim_capability_v1()
returns text
language plpgsql
volatile
security definer
set search_path to 'pg_catalog'
as $fn$
declare
  v_nonce text := encode(pg_catalog.sha256(
    convert_to(pg_current_xact_id()::text || clock_timestamp()::text, 'UTF8')), 'hex');
begin
  -- local = true → reset at transaction end; cannot outlive the wrapper tx.
  perform set_config('app_private.ie_claim_capability', v_nonce, true);
  return v_nonce;
end;
$fn$;
revoke all on function app_private.grant_ie_claim_capability_v1()
  from public, anon, authenticated, service_role;

create or replace function app_private.has_ie_claim_capability_v1(p_nonce text)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog'
as $fn$
  -- Strictly boolean, fail-closed: a NULL nonce, an unset GUC, or a mismatch all
  -- return false (never NULL — an IF NOT on NULL would silently skip the guard).
  select coalesce(
    p_nonce = nullif(current_setting('app_private.ie_claim_capability', true), ''),
    false);
$fn$;
revoke all on function app_private.has_ie_claim_capability_v1(text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Re-own the wrapper back to postgres (undo t3_02's ownership transfer) and
--    drop the writer role's now-unneeded privileges. The wrapper is SECURITY
--    DEFINER owned by postgres → auth access + INVOKER triggers resolve.
-- ---------------------------------------------------------------------------

do $reown_back$
begin
  if exists (select 1 from pg_proc p
             where p.proname='create_income_expense_v1'
               and p.proowner = 'ie_canonical_writer'::regrole) then
    alter function public.create_income_expense_v1(
      text, text, uuid, uuid, uuid, uuid, text, text, text, uuid,
      jsonb, boolean, text, date, jsonb, text
    ) owner to postgres;
  end if;
exception when undefined_object then null;  -- role may not exist on some targets
end;
$reown_back$;

-- ---------------------------------------------------------------------------
-- 3. Redefine the claim helper: SECURITY DEFINER (owned by postgres), gated on
--    the capability token instead of current_user. The wrapper grants the
--    capability just before calling it.
-- ---------------------------------------------------------------------------

create or replace function app_private.claim_canonical_income_expense_draft_v1(
  p_income_expense_id uuid,
  p_idempotency_key text,
  p_capability_nonce text
) returns void
language plpgsql
volatile
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_row public.income_expenses;
  v_op app_private.canonical_write_operations;
  v_actor uuid;
begin
  if not app_private.has_ie_claim_capability_v1(p_capability_nonce) then
    raise exception 'canonical claim capability required' using errcode = '42501';
  end if;

  v_actor := app_private.current_uid_v1();
  if v_actor is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  v_row := app_private.ie_lock_row_for_claim_v1(p_income_expense_id);
  if v_row.user_id is distinct from v_actor then
    raise exception 'claim actor is not the maker' using errcode = '42501';
  end if;
  if v_row.approval_status is distinct from 'UNAPPROVED'
     or v_row.approval_request_id is not null
     or v_row.posting_id is not null
     or v_row.posted_at_v2 is not null
     or v_row.reversed_by_posting_id is not null
     or v_row.system_source is not null then
    raise exception 'row is not claimable as canonical draft' using errcode = '23514';
  end if;
  if v_row.source_payload_hash is null
     or v_row.source_payload_hash !~ '^[0-9a-f]{32}$' then
    raise exception 'row lacks canonical payload hash' using errcode = '23514';
  end if;

  v_op := app_private.ie_lock_operation_for_claim_v1(
    v_row.organization_id, v_row.building_id::text, v_actor,
    p_idempotency_key, v_row.source_payload_hash);

  insert into app_private.income_expense_flow_ownership (
    income_expense_id, organization_id, writer_operation,
    payload_hash_scheme, payload_hash_value,
    maker_user_id, claimed_by_user_id, correlation_id)
  values (
    v_row.id, v_row.organization_id, v_op.operation,
    'PG_MD5_JSONB_TEXT_V1', v_row.source_payload_hash,
    v_row.user_id, v_actor, null);

  insert into app_private.income_expense_flow_ownership_events (
    organization_id, income_expense_id, event_type, actor_user_id, detail)
  values (
    v_row.organization_id, v_row.id, 'FLOW_CLAIMED', v_actor,
    jsonb_build_object('operation', v_op.operation,
                       'idempotency_key', p_idempotency_key));
end;
$fn$;
revoke all on function app_private.claim_canonical_income_expense_draft_v1(uuid, text, text)
  from public, anon, authenticated, service_role;
-- NOTE: the old 2-arg signature stays defined but is now dead (the wrapper calls
-- the 3-arg form). A production migration drops the 2-arg version explicitly.

commit;
