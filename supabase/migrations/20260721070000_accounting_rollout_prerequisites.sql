-- Production-catalog-only guard: fail before any accounting DDL unless the
-- reviewed canonical authz/approval foundation is already installed.
-- This migration intentionally does not support a fresh reset/bare database,
-- bootstrap missing authz objects, or replace the foundation migrations.

BEGIN;

DO $preflight$
DECLARE
  v_object text;
  v_client_role text;
  v_function regprocedure;
  v_function_row record;
  v_namespace_oid oid;
  v_trusted_owner oid;
  v_writer_role oid;
BEGIN
  IF to_regnamespace('app_private') IS NULL THEN
    RAISE EXCEPTION
      'Accounting rollout requires the existing production authz foundation: missing schema app_private';
  END IF;

  SELECT namespace_row.oid, namespace_row.nspowner
    INTO v_namespace_oid, v_trusted_owner
  FROM pg_catalog.pg_namespace namespace_row
  WHERE namespace_row.nspname = 'app_private';

  IF pg_catalog.pg_get_userbyid(v_trusted_owner) <> session_user THEN
    RAISE EXCEPTION
      'Accounting rollout must run as app_private owner %, got %',
      pg_catalog.pg_get_userbyid(v_trusted_owner), session_user;
  END IF;

  SELECT role_row.oid
    INTO v_writer_role
  FROM pg_catalog.pg_roles role_row
  WHERE role_row.rolname = 'ie_canonical_writer'
    AND NOT role_row.rolcanlogin
    AND NOT role_row.rolinherit
    AND NOT role_row.rolsuper
    AND NOT role_row.rolcreaterole
    AND NOT role_row.rolcreatedb
    AND NOT role_row.rolreplication
    AND NOT role_row.rolbypassrls;

  IF v_writer_role IS NULL THEN
    RAISE EXCEPTION
      'Missing or unsafe accounting foundation role ie_canonical_writer (expected NOLOGIN NOINHERIT and no elevated role attributes)';
  END IF;

  IF pg_catalog.to_regrole('supabase_admin') IS NULL THEN
    RAISE EXCEPTION
      'Missing Supabase foundation role supabase_admin';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members membership_row
    WHERE membership_row.roleid = v_writer_role
      AND membership_row.member <> v_trusted_owner
  ) THEN
    RAISE EXCEPTION
      'Unsafe ie_canonical_writer membership: only trusted owner % may be a member',
      pg_catalog.pg_get_userbyid(v_trusted_owner);
  END IF;

  -- PostgreSQL 17 records grants per grantor. Pin both reviewed production
  -- grants so ADMIN/INHERIT/SET cannot silently widen beyond that catalog.
  IF (
    SELECT count(*) <> 2
      OR count(*) FILTER (
        WHERE membership_row.member = v_trusted_owner
          AND membership_row.grantor =
            pg_catalog.to_regrole('supabase_admin')
          AND membership_row.admin_option
          AND NOT membership_row.inherit_option
          AND NOT membership_row.set_option
      ) <> 1
      OR count(*) FILTER (
        WHERE membership_row.member = v_trusted_owner
          AND membership_row.grantor = v_trusted_owner
          AND NOT membership_row.admin_option
          AND membership_row.inherit_option
          AND membership_row.set_option
      ) <> 1
    FROM pg_catalog.pg_auth_members membership_row
    WHERE membership_row.roleid = v_writer_role
  ) THEN
    RAISE EXCEPTION
      'Unsafe ie_canonical_writer membership options: expected exact reviewed trusted-owner grants';
  END IF;

  IF NOT pg_catalog.has_schema_privilege(
      v_writer_role, v_namespace_oid, 'USAGE'
    )
    OR pg_catalog.has_schema_privilege(
      v_writer_role, v_namespace_oid, 'CREATE'
    )
    OR pg_catalog.has_schema_privilege(
      'public', v_namespace_oid, 'USAGE,CREATE'
    ) THEN
    RAISE EXCEPTION
      'Unsafe app_private ACL: ie_canonical_writer needs USAGE only and PUBLIC must have no access';
  END IF;

  FOREACH v_client_role IN ARRAY ARRAY[
    'anon', 'authenticated', 'service_role'
  ] LOOP
    IF to_regrole(v_client_role) IS NULL THEN
      RAISE EXCEPTION
        'Missing Supabase foundation role %', v_client_role;
    END IF;
    IF pg_catalog.has_schema_privilege(
      v_client_role, v_namespace_oid, 'USAGE,CREATE'
    ) THEN
      RAISE EXCEPTION
        'Unsafe app_private ACL: role % must have no schema access',
        v_client_role;
    END IF;
  END LOOP;

  FOREACH v_object IN ARRAY ARRAY[
    'app_private.server_feature_flags',
    'app_private.server_feature_flag_canary_orgs',
    'app_private.server_feature_flag_operations',
    'app_private.canonical_write_operations',
    'app_private.income_expense_flow_ownership',
    'app_private.payment_reversals',
    'app_private.ie_transition_authorization'
  ] LOOP
    IF to_regclass(v_object) IS NULL THEN
      RAISE EXCEPTION 'Missing accounting rollout prerequisite table %', v_object;
    END IF;
    IF (
      SELECT class_row.relowner <> v_trusted_owner
      FROM pg_catalog.pg_class class_row
      WHERE class_row.oid = to_regclass(v_object)
    ) THEN
      RAISE EXCEPTION
        'Accounting rollout prerequisite table % is not owned by trusted owner %',
        v_object, pg_catalog.pg_get_userbyid(v_trusted_owner);
    END IF;
  END LOOP;

  FOREACH v_object IN ARRAY ARRAY[
    'app_private.server_feature_flags',
    'app_private.server_feature_flag_canary_orgs',
    'app_private.server_feature_flag_operations',
    'app_private.canonical_write_operations'
  ] LOOP
    IF NOT pg_catalog.has_table_privilege(
      v_writer_role, to_regclass(v_object), 'SELECT'
    ) OR NOT pg_catalog.has_table_privilege(
      v_writer_role, to_regclass(v_object), 'INSERT'
    ) OR NOT pg_catalog.has_table_privilege(
      v_writer_role, to_regclass(v_object), 'UPDATE'
    ) OR pg_catalog.has_table_privilege(
      v_writer_role, to_regclass(v_object), 'DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) THEN
      RAISE EXCEPTION
        'Unsafe ie_canonical_writer ACL on accounting foundation table %',
        v_object;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_table_privilege(
      v_writer_role,
      'app_private.income_expense_flow_ownership'::regclass,
      'INSERT'
    )
    OR pg_catalog.has_table_privilege(
      v_writer_role,
      'app_private.income_expense_flow_ownership'::regclass,
      'SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) THEN
    RAISE EXCEPTION
      'Unsafe ie_canonical_writer ACL on app_private.income_expense_flow_ownership';
  END IF;

  FOREACH v_object IN ARRAY ARRAY[
    'app_private.payment_reversals',
    'app_private.ie_transition_authorization'
  ] LOOP
    IF pg_catalog.has_table_privilege(
      v_writer_role,
      to_regclass(v_object),
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) THEN
      RAISE EXCEPTION
        'Unsafe ie_canonical_writer ACL: table % must remain owner-only',
        v_object;
    END IF;
    FOREACH v_client_role IN ARRAY ARRAY[
      'public', 'anon', 'authenticated', 'service_role'
    ] LOOP
      IF pg_catalog.has_table_privilege(
        v_client_role,
        to_regclass(v_object),
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ) THEN
        RAISE EXCEPTION
          'Unsafe ACL: role % can access owner-only table %',
          v_client_role, v_object;
      END IF;
    END LOOP;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid =
      'app_private.server_feature_flag_operations'::regclass
      AND constraint_row.contype = 'u'
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid) =
        'UNIQUE (feature_key, config_version, operation_key)'
  ) THEN
    RAISE EXCEPTION
      'Missing unique feature-operation identity constraint';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger trigger_row
    WHERE trigger_row.tgrelid =
      'app_private.server_feature_flag_operations'::regclass
      AND trigger_row.tgname = 'a00_flag_operations_immutable'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Missing immutable feature-operation ledger trigger';
  END IF;

  FOREACH v_object IN ARRAY ARRAY[
    'app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)',
    'app_private.can_edit_invoice_building_v1(uuid)',
    'app_private.evaluate_feature_route(text,uuid)',
    'app_private.is_income_expense_flow_owned(uuid)',
    'app_private.lock_org_for_decision_v1(uuid)',
    'app_private.assert_no_engine_request_v1(uuid)',
    'app_private.submit_financial_request_v1(uuid,uuid,uuid,text)',
    'app_private.set_feature_route_v1(text,bigint,text,timestamp with time zone,timestamp with time zone,integer,numeric,numeric,text,text,text,text,uuid,text)',
    'public.create_invoice_v1(uuid,uuid,uuid,text,date,date,text,numeric,numeric,numeric,numeric,jsonb,text,numeric,text,boolean,jsonb,uuid,text,numeric,text)',
    'public.terminate_contract_forfeit(uuid,date,jsonb)',
    'public.terminate_contract_move_out(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid)'
  ] LOOP
    IF to_regprocedure(v_object) IS NULL THEN
      RAISE EXCEPTION 'Missing accounting rollout prerequisite function %', v_object;
    END IF;
  END LOOP;

  -- Private authz helpers are trusted code: all are postgres-owned, deny
  -- direct client execution, and pin pg_catalog first. The engine-request
  -- assertion intentionally remains SECURITY INVOKER in the reviewed catalog.
  FOREACH v_object IN ARRAY ARRAY[
    'app_private.assert_no_engine_request_v1(uuid)',
    'app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)',
    'app_private.can_edit_invoice_building_v1(uuid)',
    'app_private.evaluate_feature_route(text,uuid)',
    'app_private.is_income_expense_flow_owned(uuid)',
    'app_private.lock_org_for_decision_v1(uuid)',
    'app_private.submit_financial_request_v1(uuid,uuid,uuid,text)',
    'app_private.set_feature_route_v1(text,bigint,text,timestamp with time zone,timestamp with time zone,integer,numeric,numeric,text,text,text,text,uuid,text)'
  ] LOOP
    v_function := to_regprocedure(v_object);
    SELECT procedure_row.proowner,
           procedure_row.prosecdef,
           procedure_row.proconfig
      INTO v_function_row
    FROM pg_catalog.pg_proc procedure_row
    WHERE procedure_row.oid = v_function;

    IF v_function_row.proowner <> v_trusted_owner THEN
      RAISE EXCEPTION
        'Accounting authz dependency % is not owned by trusted owner %',
        v_object, pg_catalog.pg_get_userbyid(v_trusted_owner);
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM unnest(
        COALESCE(v_function_row.proconfig, ARRAY[]::text[])
      ) AS setting(value)
      WHERE pg_catalog.regexp_replace(
        setting.value, '[[:space:]]+', '', 'g'
      ) = ANY (ARRAY[
        'search_path=pg_catalog',
        'search_path=pg_catalog,app_private',
        'search_path=pg_catalog,public',
        'search_path=pg_catalog,app_private,public',
        'search_path=pg_catalog,public,app_private'
      ])
    ) THEN
      RAISE EXCEPTION
        'Accounting authz dependency % must pin pg_catalog first in search_path',
        v_object;
    END IF;
    IF v_object <> 'app_private.assert_no_engine_request_v1(uuid)'
       AND NOT v_function_row.prosecdef THEN
      RAISE EXCEPTION
        'Accounting authz dependency % must be SECURITY DEFINER', v_object;
    END IF;
    IF v_object = 'app_private.assert_no_engine_request_v1(uuid)'
       AND v_function_row.prosecdef THEN
      RAISE EXCEPTION
        'Accounting engine-request assertion unexpectedly became SECURITY DEFINER';
    END IF;

    FOREACH v_client_role IN ARRAY ARRAY[
      'public', 'anon', 'authenticated', 'service_role'
    ] LOOP
      IF pg_catalog.has_function_privilege(
        v_client_role, v_function, 'EXECUTE'
      ) THEN
        RAISE EXCEPTION
          'Unsafe ACL: role % can execute private accounting dependency %',
          v_client_role, v_object;
      END IF;
    END LOOP;
  END LOOP;

  IF NOT pg_catalog.has_function_privilege(
    v_writer_role,
    'app_private.evaluate_feature_route(text,uuid)'::regprocedure,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'ie_canonical_writer lacks EXECUTE on app_private.evaluate_feature_route(text,uuid)';
  END IF;

  IF pg_catalog.has_function_privilege(
    v_writer_role,
    'app_private.assert_no_engine_request_v1(uuid)'::regprocedure,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'app_private.assert_no_engine_request_v1(uuid) must remain owner-only';
  END IF;
END;
$preflight$;

COMMIT;
