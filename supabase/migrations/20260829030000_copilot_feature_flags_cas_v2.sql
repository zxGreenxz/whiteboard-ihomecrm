-- Forward-only hardening for Copilot rollout transitions.
-- The legacy setter remains present for compatibility but is no longer a write path.
BEGIN;
SET LOCAL lock_timeout = '15s';

-- Keep this forward migration safe to dry-run against a schema where the
-- preceding Copilot migration has been rolled back; production deployments
-- retain the richer v1 definitions via IF NOT EXISTS.
CREATE SEQUENCE IF NOT EXISTS public.copilot_feature_rollout_revision_seq
  AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1;
CREATE TABLE IF NOT EXISTS public.copilot_feature_flags (
  scope text NOT NULL,
  contract_id text NOT NULL,
  state text NOT NULL DEFAULT 'disabled',
  canary_org uuid,
  updated_by uuid,
  revision bigint NOT NULL DEFAULT 1,
  reason text NOT NULL DEFAULT 'initial deny-by-default seed',
  evidence_link text NOT NULL DEFAULT 'migration:20260828170000_copilot_feature_flags_v1',
  expires_at timestamptz,
  rollback_reference text NOT NULL DEFAULT 'migration:20260828170000_copilot_feature_flags_v1',
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope, contract_id)
);
CREATE TABLE IF NOT EXISTS public.copilot_feature_flag_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope text NOT NULL,
  contract_id text NOT NULL,
  previous_state text,
  next_state text NOT NULL,
  previous_canary_org uuid,
  canary_org uuid,
  previous_expires_at timestamptz,
  expires_at timestamptz,
  revision bigint NOT NULL,
  updated_by uuid,
  reason text NOT NULL,
  evidence_link text NOT NULL,
  rollback_reference text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION public.copilot_feature_flags_audit_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
BEGIN
  INSERT INTO public.copilot_feature_flag_audit (
    scope,
    contract_id,
    previous_state,
    next_state,
    previous_canary_org,
    canary_org,
    previous_expires_at,
    expires_at,
    revision,
    updated_by,
    reason,
    evidence_link,
    rollback_reference
  )
  VALUES (
    NEW.scope,
    NEW.contract_id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.state ELSE NULL END,
    NEW.state,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.canary_org ELSE NULL END,
    NEW.canary_org,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.expires_at ELSE NULL END,
    NEW.expires_at,
    NEW.revision,
    NEW.updated_by,
    NEW.reason,
    NEW.evidence_link,
    NEW.rollback_reference
  );
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_copilot_feature_flags_audit_change
  ON public.copilot_feature_flags;
CREATE TRIGGER trg_copilot_feature_flags_audit_change
  AFTER INSERT OR UPDATE ON public.copilot_feature_flags
  FOR EACH ROW EXECUTE FUNCTION public.copilot_feature_flags_audit_change();

-- Runtime writes must come from the typed transition RPC. The RPC sets this
-- transaction-local marker immediately before taking the row lock/update.
CREATE OR REPLACE FUNCTION public.copilot_feature_flags_bump_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
BEGIN
  IF current_setting('app.copilot_feature_flag_transition', true)
       IS DISTINCT FROM 'v2' THEN
    RAISE EXCEPTION 'copilot_feature_flag_write_requires_transition_rpc'
      USING ERRCODE = '42501';
  END IF;

  NEW.revision := nextval('public.copilot_feature_rollout_revision_seq');
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_copilot_feature_flags_bump_revision
  ON public.copilot_feature_flags;
CREATE TRIGGER trg_copilot_feature_flags_bump_revision
  BEFORE INSERT OR UPDATE ON public.copilot_feature_flags
  FOR EACH ROW EXECUTE FUNCTION public.copilot_feature_flags_bump_revision();

CREATE OR REPLACE FUNCTION public.set_copilot_feature_flag_v2(
  p_scope text,
  p_contract_id text,
  p_state text,
  p_expected_revision bigint,
  p_canary_org uuid DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_evidence_link text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_rollback_reference text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_current_revision bigint;
  v_row public.copilot_feature_flags%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'expected_revision_required' USING ERRCODE = '22023';
  END IF;
  IF p_scope NOT IN ('page', 'action')
     OR btrim(COALESCE(p_contract_id, '')) = ''
     OR p_state NOT IN ('disabled', 'shadow', 'enabled') THEN
    RAISE EXCEPTION 'invalid_rollout_contract' USING ERRCODE = '22023';
  END IF;
  IF btrim(COALESCE(p_reason, '')) = ''
     OR btrim(COALESCE(p_evidence_link, '')) = ''
     OR btrim(COALESCE(p_rollback_reference, '')) = '' THEN
    RAISE EXCEPTION 'rollout_evidence_required' USING ERRCODE = '22023';
  END IF;

  -- Serialize the global CAS check before locking the individual flag row.
  PERFORM pg_advisory_xact_lock(hashtext('copilot_feature_rollout_global')::bigint);
  SELECT s.last_value
  INTO v_current_revision
  FROM public.copilot_feature_rollout_revision_seq s;
  IF v_current_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'copilot_rollout_stale_revision'
      USING ERRCODE = '40001',
            DETAIL = format('expected %, current %', p_expected_revision, v_current_revision);
  END IF;

  SELECT f.*
  INTO v_row
  FROM public.copilot_feature_flags f
  WHERE f.scope = p_scope
    AND f.contract_id = btrim(p_contract_id)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_rollout_contract' USING ERRCODE = '22023';
  END IF;
  IF v_row.state = p_state
     OR NOT (
       (v_row.state = 'disabled' AND p_state = 'shadow')
       OR (v_row.state = 'shadow' AND p_state = 'enabled')
       OR (v_row.state = 'shadow' AND p_state = 'disabled')
       OR (v_row.state = 'enabled' AND p_state = 'shadow')
       OR (v_row.state = 'enabled' AND p_state = 'disabled')
     ) THEN
    RAISE EXCEPTION 'invalid_rollout_transition'
      USING ERRCODE = '22023',
            DETAIL = format('% -> %', v_row.state, p_state);
  END IF;
  IF p_state = 'disabled' AND (p_canary_org IS NOT NULL OR p_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION 'disabled_rollout_cannot_be_canary_scoped' USING ERRCODE = '22023';
  END IF;
  IF p_canary_org IS NULL AND p_expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'rollout_expiry_requires_canary_org' USING ERRCODE = '22023';
  END IF;
  IF p_canary_org IS NOT NULL
     AND (p_expires_at IS NULL OR p_expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'canary_expiry_required' USING ERRCODE = '22023';
  END IF;
  IF p_canary_org IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.organizations o
    WHERE o.id = p_canary_org
      AND o.status = 'ACTIVE'
      AND NOT (o.id = ANY(public.sandbox_org_ids()))
  ) THEN
    RAISE EXCEPTION 'invalid_canary_organization' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.copilot_feature_flag_transition', 'v2', true);
  UPDATE public.copilot_feature_flags f
  SET state = p_state,
      canary_org = p_canary_org,
      updated_by = v_actor,
      reason = btrim(p_reason),
      evidence_link = btrim(p_evidence_link),
      expires_at = p_expires_at,
      rollback_reference = btrim(p_rollback_reference)
  WHERE f.scope = v_row.scope
    AND f.contract_id = v_row.contract_id
  RETURNING f.* INTO v_row;
  PERFORM set_config('app.copilot_feature_flag_transition', '', true);

  -- The existing AFTER trigger appends the immutable audit event in this
  -- transaction, carrying the trigger-assigned global revision.
  RETURN jsonb_build_object(
    'scope', v_row.scope,
    'contract_id', v_row.contract_id,
    'state', v_row.state,
    'canary_org', v_row.canary_org,
    'expires_at', v_row.expires_at,
    'revision', v_row.revision,
    'updated_by', v_row.updated_by,
    'updated_at', v_row.updated_at,
    'reason', v_row.reason,
    'evidence_link', v_row.evidence_link,
    'rollback_reference', v_row.rollback_reference
  );
END
$fn$;

-- Reassert the append-only audit guard in the forward migration so the
-- transition contract remains self-contained when deployed on top of v1.
CREATE OR REPLACE FUNCTION public.copilot_feature_flag_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
BEGIN
  RAISE EXCEPTION 'copilot_feature_flag_audit_immutable' USING ERRCODE = '55000';
END
$fn$;

DROP TRIGGER IF EXISTS trg_copilot_feature_flag_audit_immutable
  ON public.copilot_feature_flag_audit;
CREATE TRIGGER trg_copilot_feature_flag_audit_immutable
  BEFORE UPDATE OR DELETE ON public.copilot_feature_flag_audit
  FOR EACH ROW EXECUTE FUNCTION public.copilot_feature_flag_audit_immutable();

CREATE OR REPLACE FUNCTION public.set_copilot_feature_flag_v1(
  p_scope text,
  p_contract_id text,
  p_state text,
  p_canary_org uuid DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_evidence_link text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_rollback_reference text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
BEGIN
  RAISE EXCEPTION 'rollout_transition_requires_expected_revision'
    USING ERRCODE = '42501';
END
$fn$;

-- The global revision is the sequence value, not a max() over row revisions.
CREATE OR REPLACE FUNCTION public.get_my_copilot_availability_v1(
  p_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_fetched_at timestamptz := now();
  v_revision bigint;
  v_digest text;
  v_states jsonb;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.organizations o
       WHERE o.id = p_organization_id
         AND o.status = 'ACTIVE'
     ) THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  IF public.is_super_admin() THEN
    IF p_organization_id = ANY (public.sandbox_org_ids()) THEN
      RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM public.organization_memberships m
    WHERE m.organization_id = p_organization_id
      AND m.user_id = v_actor
      AND m.status = 'ACTIVE'
      AND m.revoked_at IS NULL
      AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= v_fetched_at
      AND (m.valid_to IS NULL OR m.valid_to > v_fetched_at)
  ) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_super_admin()
     AND NOT EXISTS (
       SELECT 1
       FROM app_private.authorized_scope_v3('ai_copilot.view', p_organization_id) s
       WHERE s.org_wide
     ) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  SELECT s.last_value
  INTO v_revision
  FROM public.copilot_feature_rollout_revision_seq s;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'scope', f.scope,
      'contract_id', f.contract_id,
      'state', CASE
        WHEN (f.canary_org IS NULL OR f.canary_org = p_organization_id)
         AND (f.expires_at IS NULL OR f.expires_at > v_fetched_at) THEN f.state
        ELSE 'disabled'
      END,
      'canary_org', f.canary_org,
      'revision', f.revision,
      'updated_at', f.updated_at
    ) ORDER BY f.scope, f.contract_id
  ), '[]'::jsonb)
  INTO v_rows
  FROM public.copilot_feature_flags f;

  SELECT COALESCE(jsonb_object_agg(
    (x ->> 'scope') || ':' || (x ->> 'contract_id'),
    x -> 'state'
  ), '{}'::jsonb)
  INTO v_states
  FROM jsonb_array_elements(v_rows) AS rows(x);

  v_digest := encode(
    extensions.digest(convert_to(v_rows::text, 'UTF8'), 'sha256'),
    'hex'
  );

  RETURN jsonb_build_object(
    'revision', v_revision,
    'fetched_at', v_fetched_at,
    'organization_id', p_organization_id,
    'actor_user_id', v_actor,
    'digest', v_digest,
    'states', v_states
  );
END
$fn$;

REVOKE ALL ON SEQUENCE public.copilot_feature_rollout_revision_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.copilot_feature_flags_bump_revision() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.copilot_feature_flags_audit_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.copilot_feature_flag_audit_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_copilot_feature_flag_v1(text, text, text, uuid, text, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_copilot_feature_flag_v2(text, text, text, bigint, uuid, text, text, timestamptz, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_my_copilot_availability_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_copilot_feature_flag_v2(text, text, text, bigint, uuid, text, text, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_copilot_availability_v1(uuid) TO authenticated;

COMMIT;
