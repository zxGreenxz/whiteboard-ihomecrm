-- ============================================================================
-- T3 PREPARED SQL 02 — Re-own the T5 public wrapper to ie_canonical_writer.
-- STATUS: PREPARED (compile-tested on disposable PG17 exact-source restore).
-- NOT a migration; production apply gated by owner per T3 doc §A.9.
--
-- Ownership-transfer mechanics per A.9 #1 (Supabase postgres = CREATEROLE):
--   1. grant role to postgres (transient) so postgres can SET/assign it
--   2. grant CREATE on schema public to the role for the transfer
--   3. ALTER FUNCTION ... OWNER TO ie_canonical_writer
--   4. revoke schema CREATE; revoke role membership from postgres is NOT done
--      here on the harness (postgres is superuser locally); on Supabase the
--      exact migration must `revoke ie_canonical_writer from postgres` and
--      keep only ADMIN OPTION.
-- After transfer, current_user inside the DEFINER wrapper = ie_canonical_writer,
-- which is exactly what the claim helper's capability gate requires.
-- ============================================================================

begin;

do $reown$
begin
  -- transient membership for transfer. On PG16+ (Supabase) a plain GRANT gives
  -- ADMIN but NOT the ability to SET ROLE unless WITH SET TRUE is specified, and
  -- ALTER FUNCTION ... OWNER TO requires the grantor to be able to become the new
  -- owner. pg_has_role(...,'USAGE') is the version-portable check for "can SET ROLE".
  if not pg_has_role(current_user, 'ie_canonical_writer', 'USAGE') then
    begin
      execute format('grant ie_canonical_writer to %I with set true', current_user);
    exception when syntax_error then
      execute format('grant ie_canonical_writer to %I', current_user); -- PG15 fallback
    end;
  end if;
end;
$reown$;

-- CREATE is transiently needed for the ownership transfer; USAGE is PERMANENT
-- (a SECURITY DEFINER function running as this role must resolve objects in
-- schema public — without USAGE it fails "permission denied for schema public"
-- at first call on Supabase, where the role is not a superuser).
grant usage, create on schema public to ie_canonical_writer;

alter function public.create_income_expense_v1(
  text, text, uuid, uuid, uuid, uuid, text, text, text, uuid,
  jsonb, boolean, text, date, jsonb, text
) owner to ie_canonical_writer;

revoke create on schema public from ie_canonical_writer;  -- keep USAGE

-- The wrapper (now owned by the writer role) needs to reach app_private
-- helpers it already calls; USAGE + selective EXECUTE were granted in t3_01.
-- The wrapper body's business-table access runs under SECURITY DEFINER with
-- current_user = ie_canonical_writer, so the role needs table privileges the
-- postgres-owned original had implicitly. Delegate-heavy redesign (A.9 #2
-- smallest shape) is the target; until the writer body is split, grant the
-- minimum table set the current body touches.
grant select on
  public.contract_tenants,
  public.staff_assignments,
  public.roles,
  public.super_admins,
  public.income_expense_audit_log
to ie_canonical_writer;

-- The writer takes FOR SHARE witness locks on these tables; PostgreSQL
-- requires UPDATE privilege for any row-locking clause. The role never
-- performs a real UPDATE on them (no UPDATE statements target these tables in
-- the wrapper body); the privilege exists only to allow the lock.
grant select, update on
  public.organizations,
  public.organization_memberships,
  public.buildings,
  public.rooms,
  public.tenants,
  public.contracts,
  public.accounts,
  public.account_shared_users,
  public.income_expense_types
to ie_canonical_writer;

grant select, insert, update on
  public.income_expenses,
  public.income_expense_items
to ie_canonical_writer;

grant insert on public.income_expense_audit_log to ie_canonical_writer;

-- The current monolithic writer body reads auth.users + public.profiles for
-- the actor display name, and calls auth.uid(). On Supabase the role needs
-- USAGE on schema auth (EXECUTE on auth.uid() alone is insufficient — object
-- resolution requires schema USAGE, which surfaces as "permission denied for
-- schema auth" at first call). The A.9 smallest-shape split would remove these
-- grants; until then they are part of the reviewed capability set.
do $auth_grants$
begin
  execute 'grant usage on schema auth to ie_canonical_writer';
  execute 'grant select on auth.users to ie_canonical_writer';
exception when undefined_table or invalid_schema_name or insufficient_privilege then null;
end;
$auth_grants$;
grant select on public.profiles to ie_canonical_writer;

grant select, insert, update on
  app_private.server_feature_flags,
  app_private.server_feature_flag_canary_orgs,
  app_private.server_feature_flag_operations,
  app_private.server_feature_flag_events,
  app_private.canonical_write_operations
to ie_canonical_writer;

grant execute on function app_private.evaluate_feature_route(text, uuid)
  to ie_canonical_writer;
grant execute on function app_private.authorize_income_expense_on_building(uuid, uuid, text, uuid)
  to ie_canonical_writer;

-- RLS: the role is NOBYPASSRLS and not a table owner, so DEFINER execution
-- under it hits RLS everywhere. A role with zero policies default-denies, so
-- each table the wrapper touches needs an explicit policy. Business-table
-- writes stay maker-scoped; witness/reference tables are read+lock only (the
-- UPDATE privilege exists solely for FOR SHARE — WITH CHECK (false) makes an
-- actual UPDATE through RLS impossible).
do $policies$
declare
  t text;
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='income_expenses'
      and policyname='ie_canonical_writer_rw') then
    create policy ie_canonical_writer_rw on public.income_expenses
      as permissive for all to ie_canonical_writer
      using (true) with check (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='income_expense_items'
      and policyname='ie_item_canonical_writer_rw') then
    create policy ie_item_canonical_writer_rw on public.income_expense_items
      as permissive for all to ie_canonical_writer
      using (true) with check (true);
  end if;
  foreach t in array array[
    'organizations','organization_memberships','buildings','rooms','tenants',
    'contracts','contract_tenants','accounts','account_shared_users',
    'income_expense_types','staff_assignments','roles','super_admins',
    'income_expense_audit_log','profiles']
  loop
    if not exists (select 1 from pg_policies
      where schemaname='public' and tablename=t
        and policyname='ie_canonical_writer_read') then
      execute format(
        'create policy ie_canonical_writer_read on public.%I
           as permissive for select to ie_canonical_writer using (true)', t);
    end if;
    -- lock-only UPDATE policy (USING true so rows are lockable; WITH CHECK
    -- false so no real UPDATE can pass RLS) for witness tables we FOR SHARE.
    if t in ('organizations','organization_memberships','buildings','rooms',
             'tenants','contracts','accounts','account_shared_users',
             'income_expense_types') then
      if not exists (select 1 from pg_policies
        where schemaname='public' and tablename=t
          and policyname='ie_canonical_writer_lock') then
        execute format(
          'create policy ie_canonical_writer_lock on public.%I
             as permissive for update to ie_canonical_writer
             using (true) with check (false)', t);
      end if;
    end if;
  end loop;
  -- audit log insert policy
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='income_expense_audit_log'
      and policyname='ie_canonical_writer_audit_insert') then
    create policy ie_canonical_writer_audit_insert
      on public.income_expense_audit_log
      as permissive for insert to ie_canonical_writer with check (true);
  end if;
end;
$policies$;

-- Post-transfer invariants (fail closed).
do $assert$
declare v_cnt int;
begin
  select count(*) into v_cnt from pg_proc
   where proowner = 'ie_canonical_writer'::regrole;
  if v_cnt <> 1 then
    raise exception 'ie_canonical_writer must own exactly 1 function, owns %', v_cnt;
  end if;
  if exists (select 1 from pg_class c
    where c.relowner = 'ie_canonical_writer'::regrole) then
    raise exception 'ie_canonical_writer must not own tables';
  end if;
  if exists (select 1 from pg_roles
    where rolname='ie_canonical_writer' and (rolcanlogin or rolbypassrls)) then
    raise exception 'ie_canonical_writer must be NOLOGIN NOBYPASSRLS';
  end if;
end;
$assert$;

commit;
