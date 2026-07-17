-- ============================================================================
-- T5 PREPARED SQL 01 — Rollout config CAS admin RPC + evaluator hardening +
-- append-only cap/event ledger guards.
-- STATUS: PREPARED (compile+behavior tested on disposable PG17 exact-source
-- restore). NOT a migration; production apply gated by owner.
--
-- Closes the rollout defects the 40-stream review found in the applied
-- 20260716120200 infra:
--   - config_version was a DEFAULT-1 column with NO CAS mechanism → add
--     set_feature_route_v1(...) that bumps config_version under CAS + emits an
--     event; direct client DML stays denied.
--   - server_feature_flag_events had no writer and no append-only guard → add
--     writer (inside the RPC) + ENABLE ALWAYS immutability trigger.
--   - server_feature_flag_operations (cap ledger) had no non-negative CHECK and
--     no append-only guard → add both.
--   - applied evaluator ignored release identity + VND caps → the strict
--     evaluator already exists in the writer artifact; this file installs the
--     append-only guards + CAS admin path that make ON/CANARY safe.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Cap-ledger integrity: non-negative amounts, append-only
-- ---------------------------------------------------------------------------

do $cap_check$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'app_private.server_feature_flag_operations'::regclass
       and conname = 'server_feature_flag_operations_amount_nonneg'
  ) then
    alter table app_private.server_feature_flag_operations
      add constraint server_feature_flag_operations_amount_nonneg
      check (amount_vnd >= 0);
  end if;
end;
$cap_check$;

create or replace function app_private.guard_rollout_ledger_immutable()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $fn$
begin
  raise exception 'rollout ledger is append-only' using errcode = '55000';
end;
$fn$;
revoke all on function app_private.guard_rollout_ledger_immutable()
  from public, anon, authenticated, service_role;

drop trigger if exists a00_flag_operations_immutable on app_private.server_feature_flag_operations;
create trigger a00_flag_operations_immutable
before update or delete on app_private.server_feature_flag_operations
for each row execute function app_private.guard_rollout_ledger_immutable();
alter table app_private.server_feature_flag_operations
  enable always trigger a00_flag_operations_immutable;

drop trigger if exists a00_flag_events_immutable on app_private.server_feature_flag_events;
create trigger a00_flag_events_immutable
before update or delete on app_private.server_feature_flag_events
for each row execute function app_private.guard_rollout_ledger_immutable();
alter table app_private.server_feature_flag_events
  enable always trigger a00_flag_events_immutable;

-- ---------------------------------------------------------------------------
-- 2. CAS admin RPC: mutate a feature route only via compare-and-swap +
--    release identity + event. Private; owner-approved wrapper grants EXECUTE.
-- ---------------------------------------------------------------------------

create or replace function app_private.set_feature_route_v1(
  p_feature_key text,
  p_expected_config_version bigint,
  p_mode text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_max_operation_count integer,
  p_max_single_amount_vnd numeric,
  p_max_total_amount_vnd numeric,
  p_commit_sha text,
  p_migration_sha256 text,
  p_maintenance_window_id text,
  p_approval_reference text,
  p_actor uuid,
  p_reason text
) returns bigint
language plpgsql
volatile
security definer
set search_path to 'pg_catalog', 'app_private'
as $fn$
declare
  v_flag app_private.server_feature_flags;
  v_new_version bigint;
begin
  if p_mode not in ('OFF','SHADOW','CANARY','ON') then
    raise exception 'invalid mode %', p_mode using errcode='22023';
  end if;

  select * into v_flag from app_private.server_feature_flags
   where feature_key = p_feature_key for update;
  if not found then
    raise exception 'feature % not found', p_feature_key using errcode='P0002';
  end if;
  -- CAS: caller must present the current config_version
  if v_flag.config_version <> p_expected_config_version then
    raise exception 'config_version conflict (have %, expected %)',
      v_flag.config_version, p_expected_config_version using errcode='40001';
  end if;

  -- release identity required for any active (ON/CANARY) mode
  if p_mode in ('ON','CANARY') then
    if p_commit_sha !~ '^[0-9a-f]{40}$'
       or p_migration_sha256 !~ '^[0-9a-f]{64}$'
       or coalesce(btrim(p_maintenance_window_id), '') = ''
       or coalesce(btrim(p_approval_reference), '') = '' then
      raise exception 'ON/CANARY requires full release identity' using errcode='22023';
    end if;
  end if;
  -- CANARY requires a finite half-open window and positive caps
  if p_mode = 'CANARY' then
    if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
      raise exception 'CANARY requires a finite half-open window' using errcode='22023';
    end if;
    if coalesce(p_max_operation_count,0) <= 0
       or coalesce(p_max_single_amount_vnd,0) <= 0
       or coalesce(p_max_total_amount_vnd,0) <= 0 then
      raise exception 'CANARY requires positive caps' using errcode='22023';
    end if;
  end if;

  v_new_version := v_flag.config_version + 1;

  update app_private.server_feature_flags
     set mode = p_mode,
         config_version = v_new_version,
         starts_at = p_starts_at,
         ends_at = p_ends_at,
         max_operation_count = coalesce(p_max_operation_count, 0),
         max_single_amount_vnd = coalesce(p_max_single_amount_vnd, 0),
         max_total_amount_vnd = coalesce(p_max_total_amount_vnd, 0),
         commit_sha = p_commit_sha,
         migration_sha256 = p_migration_sha256,
         maintenance_window_id = p_maintenance_window_id,
         approval_reference = p_approval_reference,
         reason = p_reason,
         updated_by = p_actor,
         updated_at = clock_timestamp()
   where feature_key = p_feature_key
     and config_version = p_expected_config_version;

  insert into app_private.server_feature_flag_events
    (feature_key, event_type, before_mode, after_mode,
     before_version, after_version, detail, actor, created_at)
  values
    (p_feature_key, 'ROUTE_CHANGED', v_flag.mode, p_mode,
     v_flag.config_version, v_new_version,
     jsonb_build_object('reason', p_reason), p_actor, clock_timestamp());

  return v_new_version;
end;
$fn$;

revoke all on function app_private.set_feature_route_v1(
  text, bigint, text, timestamptz, timestamptz, integer, numeric, numeric,
  text, text, text, text, uuid, text)
  from public, anon, authenticated, service_role;

commit;
