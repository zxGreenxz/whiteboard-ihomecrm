-- =============================================================================
-- Network Center admin credential reconciliation.
--
-- Provisioning writes the only plaintext credential to an owner-only file
-- before invoking PostgreSQL. This exact readback lets the admin CLI distinguish
-- a committed mutation whose response was lost from an operation that remains
-- genuinely unknown, without exposing verifier material.
-- =============================================================================

BEGIN;

SELECT pg_advisory_xact_lock(20260729137000::bigint);

CREATE OR REPLACE FUNCTION public.network_center_admin_worker_credential_status_v1(
  p_worker_key text,
  p_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_status jsonb;
BEGIN
  IF p_worker_key IS NULL
     OR p_worker_key !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
     OR p_fingerprint IS NULL
     OR p_fingerprint !~ '^sha256:[a-f0-9]{12,64}$' THEN
    RAISE EXCEPTION 'Invalid worker credential status request'
      USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_build_object(
    'found', true,
    'workerKey', worker.worker_key,
    'credentialFingerprint', credential.fingerprint,
    'notBefore', credential.not_before,
    'expiresAt', credential.expires_at,
    'revokedAt', credential.revoked_at
  )
  INTO v_status
  FROM public.network_worker_credentials credential
  JOIN public.network_workers worker ON worker.id = credential.worker_id
  WHERE worker.worker_key = p_worker_key
    AND credential.fingerprint = p_fingerprint;

  IF v_status IS NULL THEN
    RETURN jsonb_build_object(
      'found', false,
      'workerKey', p_worker_key,
      'credentialFingerprint', p_fingerprint
    );
  END IF;

  RETURN v_status;
END;
$fn$;

REVOKE ALL ON FUNCTION public.network_center_admin_worker_credential_status_v1(
  text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_admin_worker_credential_status_v1(
  text, text
) TO service_role;

COMMENT ON FUNCTION public.network_center_admin_worker_credential_status_v1(text, text) IS
  'Service-role-only exact worker and fingerprint readback for ambiguous admin mutations.';

COMMIT;

NOTIFY pgrst, 'reload schema';
