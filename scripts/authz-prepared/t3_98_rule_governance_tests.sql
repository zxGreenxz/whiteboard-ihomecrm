-- ============================================================================
-- T3 PREPARED TEST 98 — rule governance lifecycle (harness). ROLLBACK at end.
-- Uses a fresh transaction_domain so it never collides with restored rules.
-- ============================================================================

begin;

do $tests$
declare
  v_org uuid;
  v_actor uuid := gen_random_uuid();
  v_dom text := 'HARNESS_DOMAIN_' || substr(md5(clock_timestamp()::text),1,8);
  v_draft uuid; v_draft2 uuid;
  v_active uuid;
begin
  select id into v_org from public.organizations limit 1;

  -- build a DRAFT rule set with one fallback rule
  insert into public.approval_rule_sets
    (organization_id, transaction_domain, version, status, effective_from)
  values (v_org, v_dom, 1, 'DRAFT', clock_timestamp()) returning id into v_draft;

  -- T1: publish fails with no fallback rule
  begin
    perform app_private.publish_rule_set_v1(v_draft, v_actor);
    raise exception 'T1 FAILED: published without fallback';
  exception when object_not_in_prerequisite_state then null;
  end;

  insert into public.approval_rules
    (organization_id, rule_set_id, name, priority, effect, is_fallback, active)
  values (v_org, v_draft, 'fallback', 100, 'REQUIRE_APPROVAL', true, true);

  -- T2: publish succeeds → ACTIVE
  perform app_private.publish_rule_set_v1(v_draft, v_actor);
  if (select status from public.approval_rule_sets where id=v_draft) <> 'ACTIVE' then
    raise exception 'T2 FAILED: not ACTIVE';
  end if;

  -- T3: resolution returns the single ACTIVE version
  if app_private.resolve_active_rule_set_v1(v_org, v_dom) <> v_draft then
    raise exception 'T3 FAILED: resolution wrong';
  end if;

  -- T4: published rules are immutable
  begin
    update public.approval_rules set effect='DENY' where rule_set_id=v_draft;
    raise exception 'T4 FAILED: published rule mutable';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T5: publishing a v2 draft retires v1 atomically (still exactly one ACTIVE)
  insert into public.approval_rule_sets
    (organization_id, transaction_domain, version, status, effective_from)
  values (v_org, v_dom, 2, 'DRAFT', clock_timestamp()) returning id into v_draft2;
  insert into public.approval_rules
    (organization_id, rule_set_id, name, priority, effect, is_fallback, active)
  values (v_org, v_draft2, 'fallback2', 100, 'REQUIRE_APPROVAL', true, true);
  perform app_private.publish_rule_set_v1(v_draft2, v_actor);
  if (select status from public.approval_rule_sets where id=v_draft) <> 'RETIRED' then
    raise exception 'T5 FAILED: v1 not retired';
  end if;
  if app_private.resolve_active_rule_set_v1(v_org, v_dom) <> v_draft2 then
    raise exception 'T5 FAILED: resolution not v2';
  end if;

  -- T6: retired rule set cannot be deleted
  begin
    delete from public.approval_rule_sets where id=v_draft;
    raise exception 'T6 FAILED: retired set deletable';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T7: resolution fails closed when no ACTIVE version exists
  begin
    perform app_private.resolve_active_rule_set_v1(v_org, 'NO_SUCH_DOMAIN_XYZ');
    raise exception 'T7 FAILED: resolved with zero ACTIVE';
  exception when object_not_in_prerequisite_state then null;
  end;

  raise notice 'ALL 7 RULE GOVERNANCE TESTS PASSED';
end;
$tests$;

rollback;
