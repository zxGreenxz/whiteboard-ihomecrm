-- Runtime regression for the admin status compatibility projection.
--
-- 20260729134000 shipped public.network_center_admin_status_v1 projecting
-- `state.enabled` and `state.cutover_finalized_at` from
-- app_private.network_worker_compatibility_state, a table that has neither
-- column. plpgsql binds column references when a statement first EXECUTES, so
-- the migration applied, the catalog-shaped post-apply audit passed, and the
-- function only failed -- 42703, "column state.enabled does not exist" -- when
-- an operator called it. Every mutating admin command calls it as its readback
-- AFTER its RPC has committed, so the defect produced committed writes paired
-- with a failed command.
--
-- 20260729140000 replaces the body. This fixture proves the replacement by
-- EXECUTING the shipped function against the real migration set and comparing
-- its `enabled` flag with the admission decision the shipped compatibility
-- helper actually makes, in all three window states. Nothing here reads source
-- text, and nothing is seeded by hand that production code can produce: the
-- finalized state is reached by calling the shipped finalize RPC.
--
-- Three transactions, each owning its own BEGIN ... ROLLBACK and emitting one
-- verdict, because the finalized and expired windows are one-way and cannot be
-- undone inside a single transaction.

-- =============================================================================
-- Transaction A: the live window, and every projection in the body resolving.
-- =============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $preflight$
BEGIN
  IF to_regprocedure('public.network_center_admin_status_v1(uuid,integer)') IS NULL
     OR to_regprocedure(
       'public.network_center_admin_finalize_worker_compatibility_v1()'
     ) IS NULL
     OR to_regprocedure(
       'app_private.network_center_compatibility_worker_v1()'
     ) IS NULL
     OR to_regclass('app_private.network_worker_compatibility_state') IS NULL THEN
    RAISE EXCEPTION 'admin status proof requires the hardened control plane';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app_private.network_worker_compatibility_state state
    WHERE state.singleton
      AND state.finalized_at IS NULL
      AND state.expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'admin status proof requires a live compatibility window';
  END IF;
END
$preflight$;

CREATE TEMP TABLE _ncas_results (
  case_id text PRIMARY KEY,
  passed boolean NOT NULL,
  detail jsonb NOT NULL
) ON COMMIT DROP;

DO $live_window$
DECLARE
  v_status jsonb;
  v_entry jsonb;
  v_admits boolean := false;
  v_admission_error text := NULL;
  v_expected_worker_key text;
BEGIN
  v_status := public.network_center_admin_status_v1(NULL, 200);
  v_entry := (v_status -> 'compatibility') -> 0;

  SELECT worker.worker_key
  INTO v_expected_worker_key
  FROM app_private.network_worker_compatibility_state state
  JOIN public.network_workers worker ON worker.id = state.worker_id
  WHERE state.singleton;

  BEGIN
    PERFORM 1 FROM app_private.network_center_compatibility_worker_v1();
    v_admits := true;
  EXCEPTION
    WHEN others THEN
      v_admits := false;
      v_admission_error := SQLSTATE;
  END;

  INSERT INTO _ncas_results(case_id, passed, detail)
  VALUES (
    'admin-status-projections-resolve',
    v_status IS NOT NULL
      AND jsonb_typeof(v_status -> 'settings') = 'array'
      AND jsonb_typeof(v_status -> 'connections') = 'array'
      AND jsonb_typeof(v_status -> 'workers') = 'array'
      AND jsonb_typeof(v_status -> 'credentialWindows') = 'array'
      AND jsonb_typeof(v_status -> 'assignments') = 'array'
      AND jsonb_typeof(v_status -> 'compatibility') = 'array'
      AND jsonb_array_length(v_status -> 'workers') > 0
      AND jsonb_array_length(v_status -> 'assignments') > 0,
    jsonb_build_object(
      'keys', (
        SELECT jsonb_agg(key ORDER BY key)
        FROM jsonb_object_keys(v_status) AS key
      ),
      'workers', jsonb_array_length(v_status -> 'workers'),
      'assignments', jsonb_array_length(v_status -> 'assignments'),
      'compatibility', jsonb_array_length(v_status -> 'compatibility')
    )
  );

  INSERT INTO _ncas_results(case_id, passed, detail)
  VALUES (
    'compat-window-live',
    jsonb_array_length(v_status -> 'compatibility') = 1
      AND v_entry ->> 'workerKey' = v_expected_worker_key
      AND (v_entry -> 'enabled') = 'true'::jsonb
      AND (v_entry -> 'cutoverFinalizedAt') = 'null'::jsonb
      AND v_admits
      AND (
        SELECT array_agg(key ORDER BY key)
        FROM jsonb_object_keys(v_entry) AS key
      ) = ARRAY['cutoverFinalizedAt', 'enabled', 'workerKey'],
    jsonb_build_object(
      'entry', v_entry,
      'expected_worker_key', v_expected_worker_key,
      'helper_admits', v_admits,
      'helper_sqlstate', v_admission_error
    )
  );
END
$live_window$;

CREATE TEMP TABLE _ncas_required_cases (
  sequence integer PRIMARY KEY,
  case_id text NOT NULL UNIQUE
) ON COMMIT DROP;
INSERT INTO _ncas_required_cases(sequence, case_id) VALUES
  (1, 'admin-status-projections-resolve'),
  (2, 'compat-window-live');

WITH evaluated AS (
  SELECT
    required.sequence,
    required.case_id,
    coalesce(result.passed, false) AS passed,
    CASE WHEN result.case_id IS NULL
      THEN jsonb_build_object('missing_result', true)
      ELSE result.detail
    END AS detail
  FROM _ncas_required_cases required
  LEFT JOIN _ncas_results result USING (case_id)
)
SELECT jsonb_build_object(
  'passed', bool_and(evaluated.passed),
  'assertion_count', count(*),
  'failed_count', count(*) FILTER (WHERE NOT evaluated.passed),
  'assertions', jsonb_agg(jsonb_build_object(
    'case_id', evaluated.case_id,
    'passed', evaluated.passed,
    'detail', evaluated.detail
  ) ORDER BY evaluated.sequence)
) AS verdict
FROM evaluated;
ROLLBACK;

-- =============================================================================
-- Transaction B: the window closes on its own. Never finalized, just expired.
-- The one-way guard trigger allows shrinking expires_at, which is exactly what
-- an operator-free lapse looks like.
-- =============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TEMP TABLE _ncas_results (
  case_id text PRIMARY KEY,
  passed boolean NOT NULL,
  detail jsonb NOT NULL
) ON COMMIT DROP;

UPDATE app_private.network_worker_compatibility_state
SET expires_at = clock_timestamp() - interval '1 minute'
WHERE singleton;

DO $expired_window$
DECLARE
  v_entry jsonb;
  v_admits boolean := false;
  v_admission_error text := NULL;
  v_finalized_at timestamptz;
BEGIN
  SELECT state.finalized_at INTO v_finalized_at
  FROM app_private.network_worker_compatibility_state state
  WHERE state.singleton;

  v_entry := (
    public.network_center_admin_status_v1(NULL, 200) -> 'compatibility'
  ) -> 0;

  BEGIN
    PERFORM 1 FROM app_private.network_center_compatibility_worker_v1();
    v_admits := true;
  EXCEPTION
    WHEN others THEN
      v_admits := false;
      v_admission_error := SQLSTATE;
  END;

  INSERT INTO _ncas_results(case_id, passed, detail)
  VALUES (
    'compat-window-expired',
    (v_entry -> 'enabled') = 'false'::jsonb
      AND (v_entry -> 'cutoverFinalizedAt') = 'null'::jsonb
      AND v_finalized_at IS NULL
      AND NOT v_admits
      AND v_admission_error = '42501',
    jsonb_build_object(
      'entry', v_entry,
      'stored_finalized_at', v_finalized_at,
      'helper_admits', v_admits,
      'helper_sqlstate', v_admission_error
    )
  );
END
$expired_window$;

CREATE TEMP TABLE _ncas_required_cases (
  sequence integer PRIMARY KEY,
  case_id text NOT NULL UNIQUE
) ON COMMIT DROP;
INSERT INTO _ncas_required_cases(sequence, case_id) VALUES
  (1, 'compat-window-expired');

WITH evaluated AS (
  SELECT
    required.sequence,
    required.case_id,
    coalesce(result.passed, false) AS passed,
    CASE WHEN result.case_id IS NULL
      THEN jsonb_build_object('missing_result', true)
      ELSE result.detail
    END AS detail
  FROM _ncas_required_cases required
  LEFT JOIN _ncas_results result USING (case_id)
)
SELECT jsonb_build_object(
  'passed', bool_and(evaluated.passed),
  'assertion_count', count(*),
  'failed_count', count(*) FILTER (WHERE NOT evaluated.passed),
  'assertions', jsonb_agg(jsonb_build_object(
    'case_id', evaluated.case_id,
    'passed', evaluated.passed,
    'detail', evaluated.detail
  ) ORDER BY evaluated.sequence)
) AS verdict
FROM evaluated;
ROLLBACK;

-- =============================================================================
-- Transaction C: the operator-driven cutover, executed through the shipped
-- finalize RPC rather than a hand-written UPDATE.
-- =============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TEMP TABLE _ncas_results (
  case_id text PRIMARY KEY,
  passed boolean NOT NULL,
  detail jsonb NOT NULL
) ON COMMIT DROP;

SELECT public.network_center_admin_finalize_worker_compatibility_v1()
  AS finalize_operation;

DO $finalized_window$
DECLARE
  v_entry jsonb;
  v_admits boolean := false;
  v_admission_error text := NULL;
  v_finalized_at timestamptz;
BEGIN
  SELECT state.finalized_at INTO v_finalized_at
  FROM app_private.network_worker_compatibility_state state
  WHERE state.singleton;

  v_entry := (
    public.network_center_admin_status_v1(NULL, 200) -> 'compatibility'
  ) -> 0;

  BEGIN
    PERFORM 1 FROM app_private.network_center_compatibility_worker_v1();
    v_admits := true;
  EXCEPTION
    WHEN others THEN
      v_admits := false;
      v_admission_error := SQLSTATE;
  END;

  INSERT INTO _ncas_results(case_id, passed, detail)
  VALUES (
    'compat-window-finalized',
    v_finalized_at IS NOT NULL
      AND (v_entry -> 'enabled') = 'false'::jsonb
      AND (v_entry ->> 'cutoverFinalizedAt')::timestamptz = v_finalized_at
      AND NOT v_admits
      AND v_admission_error = '42501',
    jsonb_build_object(
      'entry', v_entry,
      'stored_finalized_at', v_finalized_at,
      'helper_admits', v_admits,
      'helper_sqlstate', v_admission_error
    )
  );
END
$finalized_window$;

CREATE TEMP TABLE _ncas_required_cases (
  sequence integer PRIMARY KEY,
  case_id text NOT NULL UNIQUE
) ON COMMIT DROP;
INSERT INTO _ncas_required_cases(sequence, case_id) VALUES
  (1, 'compat-window-finalized');

WITH evaluated AS (
  SELECT
    required.sequence,
    required.case_id,
    coalesce(result.passed, false) AS passed,
    CASE WHEN result.case_id IS NULL
      THEN jsonb_build_object('missing_result', true)
      ELSE result.detail
    END AS detail
  FROM _ncas_required_cases required
  LEFT JOIN _ncas_results result USING (case_id)
)
SELECT jsonb_build_object(
  'passed', bool_and(evaluated.passed),
  'assertion_count', count(*),
  'failed_count', count(*) FILTER (WHERE NOT evaluated.passed),
  'assertions', jsonb_agg(jsonb_build_object(
    'case_id', evaluated.case_id,
    'passed', evaluated.passed,
    'detail', evaluated.detail
  ) ORDER BY evaluated.sequence)
) AS verdict
FROM evaluated;
ROLLBACK;
