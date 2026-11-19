-- Copied TEST memberships are used only inside ROLLBACK; no personal IDs in source.
CREATE TEMP TABLE mc_before (actor uuid, org uuid, module text, action text, scope jsonb);
CREATE TEMP TABLE mc_auto_before(actor uuid,building uuid,allowed boolean);
CREATE TEMP TABLE mc_actors AS
  SELECT DISTINCT m.user_id actor,r.organization_id org,r.id source_role
  FROM public.organization_roles r JOIN public.role_bindings b ON b.role_id=r.id
  JOIN public.organization_memberships m ON m.id=b.membership_id
  WHERE r.name='Quản Lý Tòa' AND r.status='ACTIVE' AND m.status='ACTIVE'
    AND coalesce(b.valid_from,'-infinity')<=now() AND (b.valid_to IS NULL OR b.valid_to>now());
DO $test$
DECLARE a record; o record; v_before jsonb; v_after jsonb; v_key text; v_scope jsonb; v_expected jsonb;
  v_cfg jsonb; v_id uuid; v_target uuid; v_count integer; v_cash_count integer;
BEGIN
  IF EXISTS(SELECT * FROM mc_expected EXCEPT SELECT * FROM app_private.manager_collaboration_catalog_v1())
    OR EXISTS(SELECT * FROM app_private.manager_collaboration_catalog_v1() EXCEPT SELECT * FROM mc_expected)
  THEN RAISE EXCEPTION 'Catalog differs from approved decisions'; END IF;
  IF NOT EXISTS(SELECT 1 FROM mc_actors) THEN RAISE EXCEPTION 'No active manager fixtures in TEST'; END IF;
  FOR a IN SELECT * FROM mc_actors LOOP
    PERFORM set_config('request.jwt.claim.sub',a.actor::text,true);
    INSERT INTO mc_auto_before SELECT a.actor,b.id,
      public.can_access_building(b.id) OR public.ie_all_buildings_scope(b.id) OR b.user_id=a.actor
      FROM public.buildings b WHERE b.organization_id=a.org AND b.deleted_at IS NULL;
    INSERT INTO mc_before SELECT a.actor,a.org,mo.key,ac.key,ac.value
      FROM jsonb_each(public.get_my_permissions_v2(a.org)) mo
      CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(mo.value)='object' THEN mo.value ELSE '{}'::jsonb END) ac;
  END LOOP;
  FOR o IN SELECT DISTINCT org,source_role FROM mc_actors LOOP
    SELECT user_id INTO v_id FROM public.organization_memberships
      WHERE organization_id=o.org AND member_type='OWNER' AND status='ACTIVE'
      AND coalesce(valid_from,'-infinity')<=now() AND (valid_to IS NULL OR valid_to>now()) LIMIT 1;
    IF v_id IS NULL THEN RAISE EXCEPTION 'No active owner fixture'; END IF;
    PERFORM set_config('request.jwt.claim.sub',v_id::text,true);
    v_cfg:=public.configure_manager_collaboration_v1(o.org,o.source_role);
    -- Re-applying must not create more roles/bindings.
    SELECT count(*) INTO v_count FROM app_private.manager_collaboration_bindings;
    PERFORM public.configure_manager_collaboration_v1(o.org,o.source_role);
    IF v_count<>(SELECT count(*) FROM app_private.manager_collaboration_bindings) THEN RAISE EXCEPTION 'Non-idempotent provisioning'; END IF;
  END LOOP;
  FOR a IN SELECT * FROM mc_actors LOOP
    PERFORM set_config('request.jwt.claim.sub',a.actor::text,true);
    v_after:=public.get_my_permissions_v2(a.org);
    IF coalesce((v_after->>'__superadmin')::boolean,false) THEN RAISE EXCEPTION 'Manager became admin'; END IF;
    FOR v_key IN SELECT DISTINCT permission_key FROM mc_expected WHERE scope_kind='company' LOOP
      -- Owner DENY exceptions continue to override the additive company grant.
      IF EXISTS(SELECT 1 FROM public.member_permission_overrides ov
        JOIN public.organization_memberships m ON m.id=ov.membership_id
        WHERE m.user_id=a.actor AND m.organization_id=a.org AND ov.permission_key=v_key
          AND ov.effect='DENY' AND ov.revoked_at IS NULL AND (ov.expires_at IS NULL OR ov.expires_at>now()))
      THEN CONTINUE; END IF;
      v_scope:=v_after#>string_to_array(v_key,'.');
      IF v_scope IS NULL OR (coalesce((v_scope->>'org_wide')::boolean,false) IS NOT TRUE AND EXISTS(
        SELECT 1 FROM public.buildings WHERE organization_id=a.org AND deleted_at IS NULL AND NOT is_virtual
          AND NOT coalesce(v_scope->'building_ids','[]'::jsonb) ? id::text))
      THEN RAISE EXCEPTION 'Chosen company permission not effective: %',v_key; END IF;
    END LOOP;
    FOR v_key,v_scope IN SELECT mo.key||'.'||ac.key,ac.value FROM jsonb_each(v_after) mo
      CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(mo.value)='object' THEN mo.value ELSE '{}'::jsonb END) ac
      WHERE mo.key||'.'||ac.key NOT IN(SELECT permission_key FROM mc_expected)
    LOOP
      SELECT scope INTO v_expected FROM mc_before WHERE actor=a.actor AND org=a.org AND module||'.'||action=v_key;
      IF v_scope IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'New undecided permission: %',v_key; END IF;
    END LOOP;
    FOR v_key,v_scope IN SELECT module||'.'||action,scope FROM mc_before WHERE actor=a.actor AND org=a.org
      AND module||'.'||action NOT IN(SELECT permission_key FROM mc_expected)
    LOOP
      v_expected:=v_after#>string_to_array(v_key,'.');
      IF v_expected IS DISTINCT FROM v_scope THEN RAISE EXCEPTION 'Undecided permission changed: %',v_key; END IF;
    END LOOP;
    -- Chosen operational scope reaches every physical building of this organization.
    IF EXISTS(SELECT 1 FROM mc_auto_before WHERE actor=a.actor
      AND allowed IS DISTINCT FROM app_private.manager_collaboration_fee_auto_allowed_v1(building))
    THEN RAISE EXCEPTION 'Fee auto-approval scope changed'; END IF;
    FOR v_target IN SELECT id FROM public.buildings WHERE organization_id=a.org AND deleted_at IS NULL AND NOT is_virtual LOOP
      IF NOT app_private.can_v3('buildings.view',v_target,NULL) OR NOT app_private.can_v3('contracts.edit',v_target,NULL)
        OR NOT app_private.can_v3('income_expenses.create',v_target,NULL)
      THEN RAISE EXCEPTION 'Chosen cross-building action still denied'; END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM public.buildings WHERE organization_id<>a.org AND deleted_at IS NULL
      AND organization_id NOT IN(SELECT organization_id FROM public.organization_memberships WHERE user_id=a.actor AND status='ACTIVE')
      AND app_private.can_v3('contracts.edit',id,NULL)) THEN RAISE EXCEPTION 'Cross-tenant scope leaked'; END IF;
    FOR v_target IN SELECT cp.cashbook_id FROM public.cashbook_possession_bindings cp
      JOIN public.organization_memberships m ON m.id=cp.membership_id
      WHERE m.user_id=a.actor AND m.organization_id=a.org AND cp.valid_from<=now() AND (cp.valid_to IS NULL OR cp.valid_to>now())
    LOOP
      IF NOT app_private.can_v3('cashbooks.view',NULL,v_target) OR NOT app_private.can_v3('cashbooks.close_confirm',NULL,v_target)
      THEN RAISE EXCEPTION 'Assigned cashbook still unavailable'; END IF;
    END LOOP;
    -- No authenticated manager may configure grants for themselves.
    BEGIN
      PERFORM public.configure_manager_collaboration_v1(a.org,a.source_role);
      RAISE EXCEPTION 'Manager configured authorization';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  END LOOP;
  -- Expiry and revocation of the original assignment must propagate to generated grants.
  BEGIN
  SELECT b.id INTO v_id FROM public.role_bindings b JOIN mc_actors fixture ON fixture.source_role=b.role_id
    WHERE b.valid_from<now()-interval '1 hour' AND b.valid_to IS NULL LIMIT 1;
  IF v_id IS NULL THEN RAISE EXCEPTION 'No source binding for lifecycle test'; END IF;
  UPDATE public.role_bindings SET valid_to=now()-interval '1 minute' WHERE id=v_id;
  IF EXISTS(SELECT 1 FROM public.role_bindings b JOIN app_private.manager_collaboration_bindings m ON m.supplemental_binding_id=b.id
    WHERE m.source_binding_id=v_id AND (b.valid_to IS NULL OR b.valid_to>now())) THEN RAISE EXCEPTION 'Expired source still grants access'; END IF;
  SELECT count(*) INTO v_count FROM public.role_bindings;
  SELECT count(*) INTO v_cash_count FROM app_private.manager_collaboration_bindings WHERE source_binding_id=v_id;
  DELETE FROM public.role_bindings WHERE id=v_id;
  IF (SELECT count(*) FROM public.role_bindings)<>v_count-v_cash_count-1 THEN RAISE EXCEPTION 'Revoked source left orphan grants'; END IF;
  -- Restore the source fixture before the independent authenticated RLS checks.
  RAISE EXCEPTION 'restore lifecycle fixture' USING ERRCODE='PZ001';
  EXCEPTION WHEN SQLSTATE 'PZ001' THEN NULL;
  END;
  RAISE NOTICE 'PASS: selected scopes, all unchanged permission projections, cross-tenant deny, owner gate, idempotency, expiry, revocation';
END
$test$;

-- Exercise real RLS with authenticated, not the connection's postgres bypass.

-- Exercise the editor round-trip, not only direct UPDATE/DELETE of the source.
DO $lifecycle$
DECLARE a record; owner_id uuid; mid uuid; payload jsonb; bindings jsonb; cfg record;
  denied_id uuid; scope_id uuid; target uuid; k text;
BEGIN
  FOR a IN SELECT * FROM mc_actors LOOP
    BEGIN
      SELECT id INTO mid FROM public.organization_memberships WHERE user_id=a.actor AND organization_id=a.org AND status='ACTIVE' LIMIT 1;
      SELECT user_id INTO owner_id FROM public.organization_memberships WHERE organization_id=a.org AND member_type='OWNER' AND status='ACTIVE' LIMIT 1;
      PERFORM set_config('request.jwt.claim.sub',owner_id::text,true);
      payload:=public.get_member_authorization_v1(mid);
      SELECT * INTO cfg FROM app_private.manager_collaboration_roles WHERE source_role_id=a.source_role;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'roleBindings') b
        WHERE (b->>'roleId')::uuid IN(cfg.company_role_id,cfg.cashbook_role_id,cfg.cashbook_reader_role_id))
      THEN RAISE EXCEPTION 'Editor exposes inherited roles'; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(public.list_organization_roles_v1()) r
        WHERE (r->>'roleId')::uuid IN(cfg.company_role_id,cfg.cashbook_role_id,cfg.cashbook_reader_role_id))
      THEN RAISE EXCEPTION 'Picker exposes inherited roles'; END IF;
      SELECT jsonb_agg(jsonb_build_object('role_id',role_id,'scope_ids',scopes)) INTO bindings FROM (
        SELECT b->>'roleId' role_id,jsonb_agg(DISTINCT s) scopes
        FROM jsonb_array_elements(payload->'roleBindings') b
        CROSS JOIN LATERAL jsonb_array_elements(b->'scopeIds') s GROUP BY b->>'roleId'
      ) grouped;
      PERFORM public.update_member_authorization_v1(mid,(payload->>'version')::bigint,bindings,NULL,'TEST rollback: editor roundtrip');
      IF NOT EXISTS(SELECT 1 FROM public.role_bindings WHERE membership_id=mid AND role_id=cfg.company_role_id AND inherited_from_binding_id IS NOT NULL)
      THEN RAISE EXCEPTION 'Saving lost inherited grants'; END IF;
      BEGIN
        INSERT INTO public.role_bindings(organization_id,membership_id,role_id,valid_from)
          VALUES(a.org,mid,cfg.company_role_id,now());
        RAISE EXCEPTION 'Companion role assigned independently';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END;
      DELETE FROM public.cashbook_possession_bindings WHERE membership_id=mid;
      IF EXISTS(SELECT 1 FROM public.role_bindings WHERE membership_id=mid AND role_id IN(cfg.cashbook_role_id,cfg.cashbook_reader_role_id))
      THEN RAISE EXCEPTION 'Possession revocation left cashbook grants'; END IF;
      DELETE FROM public.role_bindings WHERE membership_id=mid AND role_id=a.source_role;
      IF EXISTS(SELECT 1 FROM public.role_bindings WHERE membership_id=mid AND role_id IN(cfg.company_role_id,cfg.cashbook_role_id,cfg.cashbook_reader_role_id))
      THEN RAISE EXCEPTION 'Editor roundtrip left orphan grants after revocation'; END IF;
      RAISE EXCEPTION 'restore fixture' USING ERRCODE='PZ001';
    EXCEPTION WHEN SQLSTATE 'PZ001' THEN NULL; END;
    BEGIN
      SELECT id INTO mid FROM public.organization_memberships WHERE user_id=a.actor AND organization_id=a.org AND status='ACTIVE' LIMIT 1;
      SELECT id INTO target FROM public.buildings WHERE organization_id=a.org AND deleted_at IS NULL LIMIT 1;
      SELECT id INTO scope_id FROM public.authorization_scopes WHERE organization_id=a.org AND scope_type='ORGANIZATION';
      FOREACH k IN ARRAY ARRAY['buildings.view','income_expenses.all_buildings'] LOOP
        INSERT INTO public.member_permission_overrides(organization_id,membership_id,permission_key,effect,reason,created_by,scope_mode)
          VALUES(a.org,mid,k,'DENY','TEST rollback: preserve owner denial',owner_id,'ORGANIZATION') RETURNING id INTO denied_id;
        INSERT INTO public.member_override_scopes VALUES(a.org,denied_id,scope_id);
      END LOOP;
      PERFORM set_config('request.jwt.claim.sub',owner_id::text,true);
      PERFORM public.configure_manager_collaboration_v1(a.org,a.source_role);
      PERFORM set_config('request.jwt.claim.sub',a.actor::text,true);
      IF app_private.can_v3('buildings.view',target,NULL)
        OR app_private.manager_collaboration_fee_auto_allowed_v1(target)
      THEN RAISE EXCEPTION 'Existing DENY lost after configure'; END IF;
      RAISE EXCEPTION 'restore fixture' USING ERRCODE='PZ001';
    EXCEPTION WHEN SQLSTATE 'PZ001' THEN NULL; END;
  END LOOP;
END $lifecycle$;

GRANT SELECT ON mc_actors TO authenticated;

-- Run the real create/revise RPCs against an expanded building, inside ROLLBACK.
DO $money$
DECLARE a record; target uuid; typ uuid; v public.income_expenses; replay public.income_expenses;
  items jsonb; tested integer:=0; key text; result jsonb; approved public.income_expenses;
BEGIN
  FOR a IN SELECT * FROM mc_actors LOOP
    PERFORM set_config('request.jwt.claim.sub',a.actor::text,true);
    SELECT b.id INTO target FROM public.buildings b
      WHERE b.organization_id=a.org AND b.deleted_at IS NULL AND NOT b.is_virtual
        AND NOT app_private.authorize_income_expense_on_building(a.actor,a.org,'create',b.id)
        AND NOT app_private.ie_can_edit_money_axis_v1(a.org,b.id)
      LIMIT 1;
    IF target IS NULL THEN CONTINUE; END IF;
    SELECT id INTO typ FROM public.income_expense_types
      WHERE organization_id=a.org AND type='expense' AND archived_at IS NULL
        AND NOT is_restricted AND NOT is_deposit AND NOT system_only AND NOT internal_transfer
        AND NOT force_approval AND merged_into_id IS NULL LIMIT 1;
    IF typ IS NULL THEN RAISE EXCEPTION 'No ordinary expense type fixture'; END IF;
    key:='mc-test-'||gen_random_uuid()::text;
    items:=jsonb_build_array(jsonb_build_object('income_expense_type_id',typ,'quantity',1,'unit_price',100,
      'start_date',current_date::text,'end_date',current_date::text,'description','TEST rollback'));
    SET LOCAL ROLE authenticated;
    v:=public.create_income_expense_v1('EXPENSE','TEST manager draft',target,NULL,NULL,NULL,
      NULL,NULL,NULL,NULL,'[]',true,'TEST rollback',current_date,items,key);
    IF v.approval_status<>'UNAPPROVED' OR v.posting_status='POSTED'
      THEN RAISE EXCEPTION 'Expanded create auto-approved expense'; END IF;
    replay:=public.create_income_expense_v1('EXPENSE','TEST manager draft',target,NULL,NULL,NULL,
      NULL,NULL,NULL,NULL,'[]',true,'TEST rollback',current_date,items,key);
    IF replay.id<>v.id THEN RAISE EXCEPTION 'Create idempotency failed'; END IF;
    result:=public.revise_pending_income_expense_v1(v.id,v.approval_version,
      '{"name":"TEST manager draft revised"}'::jsonb,NULL,'TEST draft revision',key||'-edit');
    RESET ROLE;
    IF (SELECT name FROM public.income_expenses WHERE id=v.id)<>'TEST manager draft revised'
      THEN RAISE EXCEPTION 'Draft revision did not persist'; END IF;
    IF EXISTS(SELECT 1 FROM public.income_expense_postings WHERE voucher_id=v.id)
      THEN RAISE EXCEPTION 'Pending draft generated a posting'; END IF;
    SELECT * INTO approved FROM public.income_expenses WHERE organization_id=a.org
      AND approval_status='APPROVED' AND deleted_at IS NULL AND NOT coalesce(has_restricted_item,false) LIMIT 1;
    IF approved.id IS NULL THEN RAISE EXCEPTION 'No approved voucher fixture'; END IF;
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM public.revise_pending_income_expense_v1(approved.id,approved.approval_version,
        '{"name":"TEST forbidden posted edit"}',NULL,'TEST deny',key||'-denied');
      RAISE EXCEPTION 'Draft permission edited approved voucher';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
    RESET ROLE;
    tested:=tested+1;
  END LOOP;
  IF tested=0 THEN RAISE EXCEPTION 'No expanded-create fixture exercised'; END IF;
END $money$;

SET LOCAL ROLE authenticated;
DO $rls$
DECLARE fixture record; v_count integer;
BEGIN
  FOR fixture IN SELECT * FROM mc_actors LOOP
    PERFORM set_config('request.jwt.claim.sub',fixture.actor::text,true);
    IF current_user<>'authenticated' THEN RAISE EXCEPTION 'RLS harness bypass'; END IF;
    SELECT count(*) INTO v_count FROM public.buildings WHERE organization_id=fixture.org AND deleted_at IS NULL;
    IF v_count=0 THEN RAISE EXCEPTION 'RLS did not expose company buildings'; END IF;
    IF EXISTS(SELECT 1 FROM public.buildings WHERE organization_id<>fixture.org
      AND organization_id<>ALL(public.my_org_ids())) THEN RAISE EXCEPTION 'RLS exposed another organization'; END IF;
    IF EXISTS(SELECT 1 FROM public.salary_monthly WHERE staff_id<>fixture.actor) THEN RAISE EXCEPTION 'Other staff salary exposed'; END IF;
  END LOOP;
END
$rls$;
RESET ROLE;
