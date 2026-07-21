-- Atomic admission accounting for money-writer CANARY routes.

BEGIN;

CREATE OR REPLACE FUNCTION app_private.claim_feature_operation_v1(
  p_feature_key text,
  p_organization_id uuid,
  p_subject_scope text,
  p_actor_id uuid,
  p_idempotency_key text,
  p_amount_vnd numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $$
DECLARE
  v_feature app_private.server_feature_flags%ROWTYPE;
  v_route text;
  v_now timestamptz;
  v_operation_count bigint;
  v_total_amount numeric;
  v_operation_key text;
BEGIN
  IF NULLIF(btrim(COALESCE(p_feature_key, '')), '') IS NULL
     OR p_organization_id IS NULL
     OR NULLIF(btrim(COALESCE(p_subject_scope, '')), '') IS NULL
     OR p_actor_id IS NULL
     OR NULLIF(btrim(COALESCE(p_idempotency_key, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Invalid feature operation identity'
      USING ERRCODE = '22023';
  END IF;
  IF p_amount_vnd IS NULL
     OR p_amount_vnd::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount_vnd < 0
     OR round(p_amount_vnd, 2) <> p_amount_vnd THEN
    RAISE EXCEPTION 'Feature operation amount must be finite, non-negative and have at most two decimals'
      USING ERRCODE = '22023';
  END IF;

  -- Keep release identity/config stable through commit. ON routes do not need
  -- cap accounting; only CANARY buckets are serialized and written here.
  SELECT * INTO v_feature
  FROM app_private.server_feature_flags feature_row
  WHERE feature_row.feature_key = p_feature_key
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Canonical writer is not configured'
      USING ERRCODE = '55000';
  END IF;

  IF v_feature.mode = 'CANARY' THEN
    PERFORM 1
    FROM app_private.server_feature_flag_canary_orgs canary_row
    WHERE canary_row.feature_key = v_feature.feature_key
      AND canary_row.organization_id = p_organization_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Organization is not enrolled in this canary'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF v_feature.mode <> 'CANARY' THEN
    v_route := app_private.evaluate_feature_route(
      v_feature.feature_key, p_organization_id
    );
    IF v_route <> 'CANONICAL' THEN
      RAISE EXCEPTION 'Canonical writer is disabled or frozen for this organization'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_feature.feature_key || ':' || v_feature.config_version::text,
      0
    )
  );

  v_now := clock_timestamp();
  IF v_feature.force_freeze
     OR NULLIF(btrim(v_feature.commit_sha), '') IS NULL
     OR NULLIF(btrim(v_feature.migration_sha256), '') IS NULL
     OR NULLIF(btrim(v_feature.maintenance_window_id), '') IS NULL
     OR NULLIF(btrim(v_feature.approval_reference), '') IS NULL
     OR v_feature.starts_at IS NULL
     OR v_feature.ends_at IS NULL
     OR NOT isfinite(v_feature.starts_at)
     OR NOT isfinite(v_feature.ends_at)
     OR v_feature.starts_at >= v_feature.ends_at
     OR v_now < v_feature.starts_at
     OR v_now >= v_feature.ends_at THEN
    RAISE EXCEPTION 'Canary window is no longer valid'
      USING ERRCODE = '55000';
  END IF;
  IF v_feature.max_operation_count <= 0
     OR v_feature.max_single_amount_vnd::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_feature.max_total_amount_vnd::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_feature.max_single_amount_vnd <= 0
     OR v_feature.max_total_amount_vnd <= 0 THEN
    RAISE EXCEPTION 'Canary limits are invalid'
      USING ERRCODE = '55000';
  END IF;
  IF p_amount_vnd > v_feature.max_single_amount_vnd THEN
    RAISE EXCEPTION 'Operation exceeds the canary single-amount limit'
      USING ERRCODE = '54000';
  END IF;

  SELECT count(*), COALESCE(sum(operation_row.amount_vnd), 0)
    INTO v_operation_count, v_total_amount
  FROM app_private.server_feature_flag_operations operation_row
  WHERE operation_row.feature_key = v_feature.feature_key
    AND operation_row.config_version = v_feature.config_version;

  IF v_operation_count >= v_feature.max_operation_count THEN
    RAISE EXCEPTION 'Canary operation-count limit is exhausted'
      USING ERRCODE = '54000';
  END IF;
  IF v_total_amount + p_amount_vnd > v_feature.max_total_amount_vnd THEN
    RAISE EXCEPTION 'Canary total-amount limit is exhausted'
      USING ERRCODE = '54000';
  END IF;

  v_operation_key := md5(concat_ws(
    '|',
    v_feature.feature_key,
    p_organization_id::text,
    p_subject_scope,
    p_actor_id::text,
    p_idempotency_key
  ));

  INSERT INTO app_private.server_feature_flag_operations (
    feature_key, config_version, operation_key, organization_id, amount_vnd
  ) VALUES (
    v_feature.feature_key, v_feature.config_version, v_operation_key,
    p_organization_id, p_amount_vnd
  );
END;
$$;

REVOKE ALL ON FUNCTION app_private.claim_feature_operation_v1(
  text, uuid, text, uuid, text, numeric
) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.claim_feature_operation_v1(
  text, uuid, text, uuid, text, numeric
) IS
  'Atomically admits one CANARY money operation and appends its cap-ledger row.';

COMMIT;
