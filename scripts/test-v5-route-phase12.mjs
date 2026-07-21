#!/usr/bin/env node
// Compile the route migration against live schema, assert invariants, then rollback.
import { readFileSync } from "node:fs";

const migrationFile =
  "supabase/migrations/20260721140000_v5_route_planning_phase12.sql";
const liveOnly = process.argv.includes("--live");
const projectRef = readFileSync("supabase/.temp/project-ref", "utf8").trim();
const localConfig = readFileSync("CLAUDE.local.md", "utf8");
const pat = (localConfig.match(/sbp_[a-z0-9]+/) || [])[0];

if (!pat) {
  console.error("Missing Supabase PAT in CLAUDE.local.md");
  process.exit(1);
}

const migrationBody = readFileSync(migrationFile, "utf8")
  .replace(/^\uFEFF?\s*BEGIN;\s*/i, "")
  .replace(/\s*COMMIT;[\s\S]*$/i, "");

const assertions = String.raw`
DO $sentinel_fixture$
DECLARE
  v_user uuid;
  v_building uuid;
  v_today date := public.vn_local_date(now());
BEGIN
  SELECT u.staff_id, c.building_id
  INTO v_user, v_building
  FROM (
    SELECT DISTINCT sa.staff_id
    FROM public.staff_assignments sa
    WHERE sa.staff_id IS NOT NULL
  ) u
  JOIN LATERAL public.v5_route_candidates(u.staff_id) c ON true
  JOIN public.buildings b ON b.id = c.building_id
  WHERE b.organization_id = 'dddd0000-0000-4000-8000-000000000001'::uuid
  ORDER BY (c.last_full_date IS NULL) DESC, u.staff_id, c.building_id
  LIMIT 1;

  IF v_user IS NOT NULL THEN
    UPDATE public.inspection_sessions ins
    SET session_date = v_today - 1000
    WHERE ins.building_id = v_building
      AND ins.type = 'FULL'
      AND ins.status = 'passed'
      AND ins.session_date >= v_today - 999;

    INSERT INTO public.inspection_sessions (
      user_id,
      building_id,
      type,
      status,
      session_date,
      ended_at,
      checklist
    ) VALUES (
      v_user,
      v_building,
      'FULL',
      'passed',
      v_today - 999,
      now(),
      '[]'::jsonb
    );
  END IF;

  PERFORM set_config(
    'v5_route_test.sentinel_user',
    COALESCE(v_user::text, ''),
    true
  );
  PERFORM set_config(
    'v5_route_test.sentinel_building',
    COALESCE(v_building::text, ''),
    true
  );
END;
$sentinel_fixture$;

DO $test$
DECLARE
  v_bad_count integer;
  v_sentinel_age integer;
  v_cfg jsonb := public.get_salary_v5_config();
  v_sla integer := COALESCE((v_cfg->'coverage_v5'->>'sla_days')::integer, 4);
  v_sla_hot integer := COALESCE((v_cfg->'coverage_v5'->>'sla_hot_days')::integer, 3);
  v_full_interval integer := COALESCE((v_cfg->'coverage_v5'->>'full_interval_days')::integer, 7);
  v_today date := public.vn_local_date(now());
  v_checklist_oid oid := to_regprocedure(
    'public.v5_checklist_for_building(uuid,date,text)'
  )::oid;
  v_start_oid oid := to_regprocedure(
    'public.start_inspection(uuid,text,uuid)'
  )::oid;
  v_service_role_oid oid;
  v_route_definition text;
BEGIN
  IF v_checklist_oid IS NULL THEN
    RAISE EXCEPTION 'checklist helper signature is missing';
  END IF;

  IF v_start_oid IS NULL THEN
    RAISE EXCEPTION 'start_inspection signature is missing';
  END IF;

  SELECT r.oid INTO v_service_role_oid
  FROM pg_roles r
  WHERE r.rolname = 'service_role';

  IF v_service_role_oid IS NULL THEN
    RAISE EXCEPTION 'service_role is missing';
  END IF;

  IF has_function_privilege(
    'authenticated',
    v_checklist_oid,
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    v_checklist_oid,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'client roles can execute internal checklist helper';
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    v_checklist_oid,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'service_role cannot execute checklist helper';
  END IF;

  SELECT count(*)
  INTO v_bad_count
  FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(
    COALESCE(p.proacl, acldefault('f', p.proowner))
  ) acl
  WHERE p.oid = v_checklist_oid
    AND acl.privilege_type = 'EXECUTE'
    AND acl.grantee <> p.proowner
    AND acl.grantee IS DISTINCT FROM v_service_role_oid;

  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'checklist helper has execute ACL outside owner/service_role';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(
      COALESCE(p.proacl, acldefault('f', p.proowner))
    ) acl
    WHERE p.oid = v_checklist_oid
      AND acl.grantee = v_service_role_oid
      AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'checklist helper lacks direct service_role execute ACL';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.oid = v_start_oid
      AND p.prosecdef
      AND has_function_privilege(p.proowner, v_checklist_oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'start_inspection definer cannot execute checklist helper';
  END IF;

  IF NOT has_function_privilege(
    'authenticated',
    v_start_oid,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated cannot execute start_inspection';
  END IF;

  v_route_definition := regexp_replace(
    lower(pg_get_functiondef(to_regprocedure('public.v5_route_candidates(uuid)'))),
    '[[:space:]]+',
    '',
    'g'
  );
  IF position('nullif(p.d_touch,999)' IN v_route_definition) > 0
    OR position('nullif(p.d_full,999)' IN v_route_definition) > 0 THEN
    RAISE EXCEPTION 'route function still nullifies a real 999-day age';
  END IF;

  IF COALESCE(current_setting('v5_route_test.sentinel_user', true), '') <> '' THEN
    SELECT c.days_since_full
    INTO v_sentinel_age
    FROM public.v5_route_candidates(
      current_setting('v5_route_test.sentinel_user')::uuid
    ) c
    WHERE c.building_id = current_setting(
      'v5_route_test.sentinel_building'
    )::uuid;

    IF v_sentinel_age IS DISTINCT FROM 999 THEN
      RAISE EXCEPTION 'real 999-day age was returned as %', v_sentinel_age;
    END IF;
  END IF;

  IF has_function_privilege(
    'authenticated',
    'public.v5_route_candidates(uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated can execute internal route RPC';
  END IF;

  IF has_function_privilege(
    'authenticated',
    'public.v5_daily_missions(uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated can execute legacy parameter RPC';
  END IF;

  IF NOT has_function_privilege(
    'authenticated',
    'public.v5_route_candidates_self()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated cannot execute self route RPC';
  END IF;

  IF NOT has_function_privilege(
    'authenticated',
    'public.set_my_ui_preference(text,jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated cannot execute atomic preference RPC';
  END IF;

  WITH users AS (
    SELECT DISTINCT sa.staff_id
    FROM public.staff_assignments sa
    WHERE sa.staff_id IS NOT NULL
  ), scoped AS (
    SELECT sa.staff_id, sa.building_id
    FROM public.staff_assignments sa
    WHERE sa.building_id IS NOT NULL
    UNION
    SELECT sa.staff_id, ab.building_id
    FROM public.staff_assignments sa
    JOIN public.area_buildings ab ON ab.area_id = sa.area_id
    WHERE sa.area_id IS NOT NULL
    UNION
    SELECT sa.staff_id, b.id
    FROM public.staff_assignments sa
    JOIN public.buildings b ON b.user_id = sa.user_id
    WHERE sa.building_id IS NULL
      AND sa.area_id IS NULL
  ), expected AS (
    SELECT s.staff_id, count(*)::integer AS expected_count
    FROM scoped s
    JOIN public.building_coverage bc ON bc.building_id = s.building_id
    JOIN public.buildings b ON b.id = s.building_id
    WHERE bc.rooms_total > 0
      AND b.deleted_at IS NULL
      AND COALESCE(b.is_virtual, false) = false
      AND b.status = 'ACTIVE'
    GROUP BY s.staff_id
  ), actual AS (
    SELECT u.staff_id, count(c.building_id)::integer AS actual_count
    FROM users u
    LEFT JOIN LATERAL public.v5_route_candidates(u.staff_id) c ON true
    GROUP BY u.staff_id
  )
  SELECT count(*)
  INTO v_bad_count
  FROM users u
  LEFT JOIN expected e ON e.staff_id = u.staff_id
  LEFT JOIN actual a ON a.staff_id = u.staff_id
  WHERE COALESCE(e.expected_count, 0) <> COALESCE(a.actual_count, 0);

  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'route scope mismatch for % staff users', v_bad_count;
  END IF;

  WITH users AS (
    SELECT DISTINCT sa.staff_id
    FROM public.staff_assignments sa
    WHERE sa.staff_id IS NOT NULL
  ), duplicates AS (
    SELECT u.staff_id, c.building_id, count(*)
    FROM users u
    JOIN LATERAL public.v5_route_candidates(u.staff_id) c ON true
    GROUP BY u.staff_id, c.building_id
    HAVING count(*) > 1
  )
  SELECT count(*) INTO v_bad_count FROM duplicates;

  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'route candidates contain duplicate buildings';
  END IF;

  WITH users AS (
    SELECT DISTINCT sa.staff_id
    FROM public.staff_assignments sa
    WHERE sa.staff_id IS NOT NULL
  )
  SELECT count(*)
  INTO v_bad_count
  FROM users u
  JOIN LATERAL public.v5_route_candidates(u.staff_id) c ON true
  JOIN public.building_coverage bc ON bc.building_id = c.building_id
  WHERE c.days_since_touch IS DISTINCT FROM bc.days_since_touch::integer
     OR c.days_since_full IS DISTINCT FROM bc.days_since_full::integer
     OR (c.last_touch_date IS NULL) <> (c.days_since_touch IS NULL)
     OR (c.last_full_date IS NULL) <> (c.days_since_full IS NULL);

  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'route API does not preserve nullable raw ages';
  END IF;

  WITH users AS (
    SELECT DISTINCT sa.staff_id
    FROM public.staff_assignments sa
    WHERE sa.staff_id IS NOT NULL
  ), candidate_rows AS (
    SELECT
      u.staff_id,
      c.*,
      CASE
        WHEN jsonb_typeof(
          v_cfg->'coverage_v5'->'building_overrides'->c.building_id::text
        ) = 'object'
        THEN v_cfg->'coverage_v5'->'building_overrides'->c.building_id::text
        ELSE '{}'::jsonb
      END AS building_override
    FROM users u
    JOIN LATERAL public.v5_route_candidates(u.staff_id) c ON true
  ), resolved_rows AS (
    SELECT
      r.*,
      CASE
        WHEN jsonb_typeof(r.building_override->'is_hot') = 'boolean'
        THEN (r.building_override->>'is_hot')::boolean
        ELSE r.vacant_rooms > 0
      END AS expected_is_hot,
      CASE
        WHEN jsonb_typeof(r.building_override->'sla_days') = 'number' THEN
          CASE
            WHEN (r.building_override->>'sla_days')::numeric >= 1
              AND (r.building_override->>'sla_days')::numeric <= 2147483647
              AND trunc((r.building_override->>'sla_days')::numeric)
                = (r.building_override->>'sla_days')::numeric
            THEN (r.building_override->>'sla_days')::integer
          END
      END AS expected_override_sla
    FROM candidate_rows r
  ), expected_values AS (
    SELECT
      r.*,
      COALESCE(
        r.expected_override_sla,
        CASE WHEN r.expected_is_hot THEN v_sla_hot ELSE v_sla END
      ) AS expected_sla,
      ROUND(
        LEAST(COALESCE(r.days_since_touch, 999), 60)
          * (1 + r.rooms_total / 20.0)
        + CASE WHEN r.expected_is_hot THEN 10 ELSE 0 END
        + LEAST(5 * r.expiring_contracts, 10)
        + CASE WHEN r.open_jobs > 0 THEN 15 ELSE 0 END,
        1
      ) AS expected_score
    FROM resolved_rows r
  ), expected AS (
    SELECT
      r.*,
      CASE
        WHEN r.last_full_date = v_today THEN 4
        WHEN r.last_full_date IS NULL
          OR r.days_since_full >= v_full_interval THEN 0
        WHEN r.last_touch_date IS NULL
          OR r.days_since_touch >= r.expected_sla THEN 1
        WHEN r.days_since_full >= GREATEST(v_full_interval - 1, 0)
          OR r.days_since_touch >= GREATEST(r.expected_sla - 1, 0) THEN 2
        ELSE 3
      END AS expected_bucket
    FROM expected_values r
  )
  SELECT count(*)
  INTO v_bad_count
  FROM expected e
  WHERE e.touch_sla_days IS DISTINCT FROM e.expected_sla
     OR e.score IS DISTINCT FROM e.expected_score
     OR e.full_interval_days IS DISTINCT FROM v_full_interval
     OR e.priority_bucket IS DISTINCT FROM e.expected_bucket
     OR e.checked_today IS DISTINCT FROM COALESCE(e.last_full_date = v_today, false)
     OR e.priority_label IS DISTINCT FROM CASE e.expected_bucket
          WHEN 0 THEN CASE WHEN e.last_full_date IS NULL THEN 'never_full' ELSE 'full_overdue' END
          WHEN 1 THEN 'visit_due'
          WHEN 2 THEN 'due_soon'
          WHEN 4 THEN 'checked_today'
          ELSE 'fresh'
        END
     OR e.color IS DISTINCT FROM CASE
          WHEN e.expected_bucket IN (0, 1) THEN 'red'
          WHEN e.expected_bucket = 2 THEN 'yellow'
          ELSE 'green'
        END;

  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'route bucket/SLA/risk/checked-today invariant failed for % rows', v_bad_count;
  END IF;

  WITH users AS (
    SELECT DISTINCT sa.staff_id
    FROM public.staff_assignments sa
    WHERE sa.staff_id IS NOT NULL
  ), ordered_rows AS (
    SELECT
      u.staff_id,
      c.building_id,
      c.priority_bucket,
      c.days_since_touch,
      c.days_since_full,
      c.score,
      c.building_name,
      c.ordinality
    FROM users u
    CROSS JOIN LATERAL public.v5_route_candidates(u.staff_id)
      WITH ORDINALITY AS c
  ), checked_orders AS (
    SELECT
      o.staff_id,
      array_agg(o.building_id ORDER BY o.ordinality) AS actual_order,
      array_agg(
        o.building_id
        ORDER BY
          o.priority_bucket,
          CASE WHEN o.priority_bucket = 0
            THEN o.days_since_full
            ELSE o.days_since_touch
          END DESC NULLS FIRST,
          o.score DESC,
          o.building_name,
          o.building_id
      ) AS expected_order
    FROM ordered_rows o
    GROUP BY o.staff_id
  )
  SELECT count(*)
  INTO v_bad_count
  FROM checked_orders o
  WHERE o.actual_order IS DISTINCT FROM o.expected_order;

  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'route candidate order is not deterministic';
  END IF;

  WITH actual_floors AS (
    SELECT floor_set.building_id,
           array_agg(floor_set.floor_number ORDER BY floor_set.floor_number) AS floors
    FROM (
      SELECT DISTINCT r.building_id, r.floor AS floor_number
      FROM public.rooms r
      WHERE r.deleted_at IS NULL
        AND r.floor > 0
      UNION
      SELECT DISTINCT f.building_id, f.floor_number
      FROM public.floors f
      WHERE COALESCE(f.status, 'active') = 'active'
        AND f.floor_number > 0
    ) floor_set
    GROUP BY floor_set.building_id
  ), sampled_buildings AS (
    SELECT af.building_id, af.floors
    FROM actual_floors af
    ORDER BY af.building_id
    LIMIT 100
  ), sampled AS (
    SELECT af.building_id,
           af.floors,
           (item->>'floor')::integer AS selected_floor
    FROM sampled_buildings af
    CROSS JOIN generate_series(0, 30) day_offset
    CROSS JOIN LATERAL jsonb_array_elements(
      public.v5_checklist_for_building(
        af.building_id,
        public.vn_local_date(now()) + day_offset,
        'FULL'
      )
    ) item
    WHERE item ? 'floor'
  )
  SELECT count(*)
  INTO v_bad_count
  FROM sampled
  WHERE NOT selected_floor = ANY(floors);

  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'checklist selected a floor that does not exist';
  END IF;

  WITH targets AS (
    SELECT b.id AS building_id
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
    ORDER BY b.id
    LIMIT 100
  ), samples AS (
    SELECT
      t.building_id,
      v_today + day_offset AS sample_date,
      public.v5_checklist_for_building(
        t.building_id,
        v_today + day_offset,
        'FULL'
      ) AS first_result,
      public.v5_checklist_for_building(
        t.building_id,
        v_today + day_offset,
        'FULL'
      ) AS second_result
    FROM targets t
    CROSS JOIN generate_series(0, 6) day_offset
  )
  SELECT count(*)
  INTO v_bad_count
  FROM samples s
  WHERE s.first_result IS DISTINCT FROM s.second_result;

  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'checklist output is not deterministic';
  END IF;
END;
$test$;

DO $auth_fixture$
DECLARE
  v_user uuid;
  v_accessible_building uuid;
  v_other_building uuid;
  v_denied_building uuid;
  v_valid_pair uuid;
  v_mismatched_pair uuid;
BEGIN
  WITH per_user AS (
    SELECT
      u.staff_id,
      array_agg(
        c.building_id
        ORDER BY EXISTS (
          SELECT 1
          FROM public.inspection_sessions ins
          WHERE ins.user_id = u.staff_id
            AND ins.building_id = c.building_id
            AND ins.session_date = public.vn_local_date(now())
            AND ins.status IN ('open', 'presence')
        ), c.building_id
      ) AS buildings
    FROM (
      SELECT DISTINCT sa.staff_id
      FROM public.staff_assignments sa
      WHERE sa.staff_id IS NOT NULL
    ) u
    JOIN public.profiles p ON p.id = u.staff_id
    JOIN LATERAL public.v5_route_candidates(u.staff_id) c ON true
    JOIN public.buildings b ON b.id = c.building_id
    WHERE b.organization_id = 'dddd0000-0000-4000-8000-000000000001'::uuid
      AND NOT EXISTS (
        SELECT 1
        FROM public.super_admins s
        WHERE s.user_id = u.staff_id
      )
    GROUP BY u.staff_id
    HAVING count(*) >= 2
  )
  SELECT p.staff_id, p.buildings[1], p.buildings[2]
  INTO v_user, v_accessible_building, v_other_building
  FROM per_user p
  ORDER BY p.staff_id
  LIMIT 1;

  IF v_user IS NULL OR v_accessible_building IS NULL OR v_other_building IS NULL THEN
    RAISE EXCEPTION 'auth guard test needs a caller with two demo route buildings';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);

  IF NOT COALESCE(public.can_access_building(v_accessible_building), false) THEN
    RAISE EXCEPTION 'route candidate is not accessible to selected caller';
  END IF;
  IF NOT COALESCE(public.can_access_building(v_other_building), false) THEN
    RAISE EXCEPTION 'second route candidate is not accessible to selected caller';
  END IF;

  SELECT b.id
  INTO v_denied_building
  FROM public.buildings b
  WHERE b.deleted_at IS NULL
    AND b.id <> v_accessible_building
    AND NOT COALESCE(public.can_access_building(b.id), false)
  ORDER BY b.id
  LIMIT 1;

  IF v_denied_building IS NULL THEN
    RAISE EXCEPTION 'no inaccessible building available for auth guard test';
  END IF;

  INSERT INTO public.income_expenses (
    user_id,
    type,
    name,
    building_id,
    voucher_date,
    total_amount,
    approval_status,
    collect_geofence_status,
    counts_in_business_result,
    organization_id
  ) VALUES (
    v_user,
    'INCOME',
    '__v5_route_valid_pair',
    v_accessible_building,
    public.vn_local_date(now()),
    0,
    'APPROVED',
    'ok',
    false,
    'dddd0000-0000-4000-8000-000000000001'::uuid
  )
  RETURNING id INTO v_valid_pair;

  INSERT INTO public.income_expenses (
    user_id,
    type,
    name,
    building_id,
    voucher_date,
    total_amount,
    approval_status,
    collect_geofence_status,
    counts_in_business_result,
    organization_id
  ) VALUES (
    v_user,
    'INCOME',
    '__v5_route_mismatched_pair',
    v_other_building,
    public.vn_local_date(now()),
    0,
    'APPROVED',
    'ok',
    false,
    'dddd0000-0000-4000-8000-000000000001'::uuid
  )
  RETURNING id INTO v_mismatched_pair;

  PERFORM set_config(
    'v5_route_test.accessible_building',
    v_accessible_building::text,
    true
  );
  PERFORM set_config(
    'v5_route_test.denied_building',
    v_denied_building::text,
    true
  );
  PERFORM set_config(
    'v5_route_test.valid_pair',
    v_valid_pair::text,
    true
  );
  PERFORM set_config(
    'v5_route_test.mismatched_pair',
    v_mismatched_pair::text,
    true
  );
END;
$auth_fixture$;

SET LOCAL ROLE authenticated;

DO $self_test$
DECLARE
  v_preferences jsonb;
  v_session jsonb;
  v_accessible_building uuid := current_setting(
    'v5_route_test.accessible_building'
  )::uuid;
  v_denied_building uuid := current_setting(
    'v5_route_test.denied_building'
  )::uuid;
  v_valid_pair uuid := current_setting('v5_route_test.valid_pair')::uuid;
  v_mismatched_pair uuid := current_setting(
    'v5_route_test.mismatched_pair'
  )::uuid;
BEGIN
  PERFORM count(*) FROM public.v5_route_candidates_self();

  BEGIN
    PERFORM public.v5_checklist_for_building(
      '00000000-0000-0000-0000-000000000000'::uuid,
      DATE '2026-01-01',
      'QUICK'
    );
    RAISE EXCEPTION 'authenticated executed internal checklist helper';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  v_preferences := public.set_my_ui_preference(
    '__v5_route_phase12_test',
    '{"ok":true}'::jsonb
  );
  IF v_preferences->'__v5_route_phase12_test' IS DISTINCT FROM '{"ok":true}'::jsonb THEN
    RAISE EXCEPTION 'atomic preference RPC did not merge requested value';
  END IF;

  v_session := public.start_inspection(
    v_accessible_building,
    'QUICK',
    NULL
  );
  IF jsonb_typeof(v_session->'checklist') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'start_inspection rejected an accessible route building';
  END IF;

  v_session := public.start_inspection(
    v_accessible_building,
    'QUICK',
    v_valid_pair
  );
  IF jsonb_typeof(v_session->'checklist') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'start_inspection rejected a valid paired receipt';
  END IF;

  BEGIN
    PERFORM public.start_inspection(
      v_accessible_building,
      'QUICK',
      v_mismatched_pair
    );
    RAISE EXCEPTION 'start_inspection accepted a receipt from another building';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.start_inspection(
      v_denied_building,
      'QUICK',
      NULL
    );
    RAISE EXCEPTION 'start_inspection accepted an inaccessible building';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END;
$self_test$;

RESET ROLE;

CREATE TEMP TABLE v5_route_override_fixture (
  user_id uuid NOT NULL,
  valid_building uuid NOT NULL,
  malformed_building uuid NOT NULL,
  cfg jsonb NOT NULL
) ON COMMIT DROP;

INSERT INTO v5_route_override_fixture (
  user_id,
  valid_building,
  malformed_building,
  cfg
)
WITH per_user AS (
  SELECT
    u.staff_id,
    array_agg(c.building_id ORDER BY c.building_id) AS buildings
  FROM (
    SELECT DISTINCT sa.staff_id
    FROM public.staff_assignments sa
    WHERE sa.staff_id IS NOT NULL
  ) u
  JOIN LATERAL public.v5_route_candidates(u.staff_id) c ON true
  JOIN public.buildings b ON b.id = c.building_id
  WHERE b.organization_id = 'dddd0000-0000-4000-8000-000000000001'::uuid
    AND NOT EXISTS (
      SELECT 1
      FROM public.super_admins s
      WHERE s.user_id = u.staff_id
    )
  GROUP BY u.staff_id
  HAVING count(*) >= 2
), selected AS (
  SELECT p.staff_id, p.buildings[1] AS valid_building,
         p.buildings[2] AS malformed_building
  FROM per_user p
  ORDER BY p.staff_id
  LIMIT 1
)
SELECT
  s.staff_id,
  s.valid_building,
  s.malformed_building,
  jsonb_set(
    public.get_salary_v5_config(),
    '{coverage_v5,building_overrides}',
    COALESCE(
      public.get_salary_v5_config()->'coverage_v5'->'building_overrides',
      '{}'::jsonb
    ) || jsonb_build_object(
      s.valid_building::text,
      jsonb_build_object('is_hot', false, 'sla_days', 11),
      s.malformed_building::text,
      jsonb_build_object('is_hot', 'false', 'sla_days', 0)
    ),
    true
  )
FROM selected s;

DO $override_fixture_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM v5_route_override_fixture) THEN
    RAISE EXCEPTION 'override fixture needs one caller with two demo route buildings';
  END IF;
END;
$override_fixture_check$;

CREATE OR REPLACE FUNCTION public.get_salary_v5_config()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $override_config$
  SELECT f.cfg
  FROM pg_temp.v5_route_override_fixture f
  LIMIT 1;
$override_config$;

DO $override_test$
DECLARE
  v_fixture v5_route_override_fixture%ROWTYPE;
  v_valid record;
  v_malformed record;
  v_sla integer;
  v_sla_hot integer;
  v_expected_score numeric;
BEGIN
  SELECT * INTO v_fixture FROM v5_route_override_fixture LIMIT 1;
  v_sla := COALESCE((v_fixture.cfg->'coverage_v5'->>'sla_days')::integer, 4);
  v_sla_hot := COALESCE((v_fixture.cfg->'coverage_v5'->>'sla_hot_days')::integer, 3);

  SELECT * INTO v_valid
  FROM public.v5_route_candidates(v_fixture.user_id) c
  WHERE c.building_id = v_fixture.valid_building;

  IF NOT FOUND OR v_valid.touch_sla_days IS DISTINCT FROM 11 THEN
    RAISE EXCEPTION 'valid building SLA override was not applied';
  END IF;

  v_expected_score := ROUND(
    LEAST(COALESCE(v_valid.days_since_touch, 999), 60)
      * (1 + v_valid.rooms_total / 20.0)
    + LEAST(5 * v_valid.expiring_contracts, 10)
    + CASE WHEN v_valid.open_jobs > 0 THEN 15 ELSE 0 END,
    1
  );
  IF v_valid.score IS DISTINCT FROM v_expected_score THEN
    RAISE EXCEPTION 'is_hot=false override did not remove the hot risk bonus';
  END IF;

  SELECT * INTO v_malformed
  FROM public.v5_route_candidates(v_fixture.user_id) c
  WHERE c.building_id = v_fixture.malformed_building;

  IF NOT FOUND OR v_malformed.touch_sla_days IS DISTINCT FROM (
    CASE
      WHEN v_malformed.vacant_rooms > 0 THEN v_sla_hot
      ELSE v_sla
    END
  ) THEN
    RAISE EXCEPTION 'malformed override did not fall back to default SLA';
  END IF;

  v_expected_score := ROUND(
    LEAST(COALESCE(v_malformed.days_since_touch, 999), 60)
      * (1 + v_malformed.rooms_total / 20.0)
    + CASE WHEN v_malformed.vacant_rooms > 0 THEN 10 ELSE 0 END
    + LEAST(5 * v_malformed.expiring_contracts, 10)
    + CASE WHEN v_malformed.open_jobs > 0 THEN 15 ELSE 0 END,
    1
  );
  IF v_malformed.score IS DISTINCT FROM v_expected_score THEN
    RAISE EXCEPTION 'malformed is_hot override did not fall back safely';
  END IF;
END;
$override_test$;
`;

const migrationUnderTest = liveOnly
  ? ""
  : `${migrationBody}\n${migrationBody}\n`;
const sql = `BEGIN;\n${migrationUnderTest}${assertions}\nROLLBACK;`;
const response = await fetch(
  `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  },
);
const body = await response.text();

if (!response.ok) {
  console.error(`Route Phase 1-2 validation failed (${response.status})`);
  console.error(body.slice(0, 4000));
  process.exit(1);
}

console.log(
  liveOnly
    ? "Validated live V5 route Phase 1-2 SQL invariants."
    : "Validated idempotent V5 route Phase 1-2 SQL invariants with ROLLBACK.",
);
