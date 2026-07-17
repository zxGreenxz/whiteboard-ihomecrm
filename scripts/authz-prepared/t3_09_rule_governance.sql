-- ============================================================================
-- T3 PREPARED SQL 09 — Rule governance lifecycle (T3 §4.13).
-- STATUS: PREPARED (compile+behavior tested on disposable PG17 exact-source
-- restore). NOT a migration; private; no grant.
--
-- DRAFT → ACTIVE → RETIRED publish transitions; published versions immutable;
-- exactly one ACTIVE version per (org, transaction_domain) at any effective
-- instant; each ACTIVE version must have exactly one fallback rule
-- (REQUIRE_APPROVAL). Rule resolution fail-closed: not exactly one ACTIVE
-- version or ambiguous match → raise (never auto-post).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Publish a DRAFT rule set → ACTIVE, retiring the current ACTIVE atomically.
-- ---------------------------------------------------------------------------

create or replace function app_private.publish_rule_set_v1(
  p_rule_set_id uuid, p_actor uuid)
returns void
language plpgsql
volatile
security definer
set search_path to 'pg_catalog', 'public'
as $fn$
declare
  v_rs public.approval_rule_sets;
  v_fallbacks int;
begin
  select * into v_rs from public.approval_rule_sets
   where id = p_rule_set_id for update;
  if not found then raise exception 'rule set not found' using errcode='P0002'; end if;
  if v_rs.status <> 'DRAFT' then
    raise exception 'only DRAFT rule sets can be published (is %)', v_rs.status
      using errcode='55000';
  end if;

  -- exactly one fallback REQUIRE_APPROVAL rule
  select count(*) into v_fallbacks from public.approval_rules
   where rule_set_id = p_rule_set_id and is_fallback and effect = 'REQUIRE_APPROVAL';
  if v_fallbacks <> 1 then
    raise exception 'rule set must have exactly one fallback REQUIRE_APPROVAL rule (has %)',
      v_fallbacks using errcode='55000';
  end if;

  -- retire the current ACTIVE version for the same (org, domain)
  update public.approval_rule_sets
     set status = 'RETIRED', effective_to = clock_timestamp()
   where organization_id = v_rs.organization_id
     and transaction_domain = v_rs.transaction_domain
     and status = 'ACTIVE'
     and id <> p_rule_set_id;

  update public.approval_rule_sets
     set status = 'ACTIVE',
         effective_from = clock_timestamp(),
         published_by = p_actor,
         published_at = clock_timestamp()
   where id = p_rule_set_id;
end;
$fn$;
revoke all on function app_private.publish_rule_set_v1(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Immutability guard: ACTIVE/RETIRED rule sets and their rules are frozen.
-- ---------------------------------------------------------------------------

create or replace function app_private.guard_published_rule_set()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $fn$
declare
  v_status text;
begin
  if tg_table_name = 'approval_rule_sets' then
    -- allow the publish transition itself (DRAFT→ACTIVE, ACTIVE→RETIRED) but
    -- forbid content edits once published. We detect content edits by checking
    -- the OLD status: a published row may only change status/effective_to/
    -- published_*.
    if tg_op = 'UPDATE' and old.status in ('ACTIVE','RETIRED') then
      if new.transaction_domain is distinct from old.transaction_domain
         or new.version is distinct from old.version
         or new.organization_id is distinct from old.organization_id then
        raise exception 'published rule set content is immutable' using errcode='55000';
      end if;
    end if;
    if tg_op = 'DELETE' and old.status in ('ACTIVE','RETIRED') then
      raise exception 'published rule set cannot be deleted' using errcode='55000';
    end if;
    return case when tg_op='DELETE' then old else new end;
  end if;

  -- approval_rules: frozen once their rule set is published
  select status into v_status from public.approval_rule_sets
   where id = coalesce(new.rule_set_id, old.rule_set_id);
  if v_status in ('ACTIVE','RETIRED') then
    raise exception 'rules of a published rule set are immutable' using errcode='55000';
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$fn$;
revoke all on function app_private.guard_published_rule_set()
  from public, anon, authenticated, service_role;

drop trigger if exists a00_rule_set_immutable on public.approval_rule_sets;
create trigger a00_rule_set_immutable
before update or delete on public.approval_rule_sets
for each row execute function app_private.guard_published_rule_set();
alter table public.approval_rule_sets
  enable always trigger a00_rule_set_immutable;

drop trigger if exists a00_rules_immutable on public.approval_rules;
create trigger a00_rules_immutable
before insert or update or delete on public.approval_rules
for each row execute function app_private.guard_published_rule_set();
alter table public.approval_rules
  enable always trigger a00_rules_immutable;

-- ---------------------------------------------------------------------------
-- Fail-closed rule resolution: exactly one ACTIVE version, unique match.
-- ---------------------------------------------------------------------------

create or replace function app_private.resolve_active_rule_set_v1(
  p_organization_id uuid, p_transaction_domain text)
returns uuid
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $fn$
declare
  v_count int;
  v_id uuid;
begin
  select count(*) into v_count
    from public.approval_rule_sets
   where organization_id = p_organization_id
     and transaction_domain = p_transaction_domain
     and status = 'ACTIVE'
     and effective_from <= clock_timestamp()
     and (effective_to is null or effective_to > clock_timestamp());
  if v_count <> 1 then
    raise exception 'rule resolution not unique: % ACTIVE versions for %/%',
      v_count, p_organization_id, p_transaction_domain using errcode='55000';
  end if;
  select id into v_id
    from public.approval_rule_sets
   where organization_id = p_organization_id
     and transaction_domain = p_transaction_domain
     and status = 'ACTIVE'
     and effective_from <= clock_timestamp()
     and (effective_to is null or effective_to > clock_timestamp());
  return v_id;
end;
$fn$;
revoke all on function app_private.resolve_active_rule_set_v1(uuid, text)
  from public, anon, authenticated, service_role;

commit;
