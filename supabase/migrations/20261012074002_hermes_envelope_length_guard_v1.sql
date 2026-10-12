-- PostgreSQL bounded regex repetition cannot express the ciphertext size cap.
-- Keep the same envelope limit with an explicit length check and character set.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION app_private.hermes_envelope_v1(p jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path=pg_catalog,app_private
AS $fn$
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['v','algorithm','keyVersion','nonce','ciphertext','tag']);
  IF p->'v' IS DISTINCT FROM '1'::jsonb OR p->>'algorithm' IS DISTINCT FROM 'A256GCM'
    OR jsonb_typeof(p->'keyVersion')<>'string' OR (p->>'keyVersion') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    OR jsonb_typeof(p->'nonce')<>'string' OR (p->>'nonce') !~ '^[A-Za-z0-9_-]{16}$'
    OR jsonb_typeof(p->'tag')<>'string' OR (p->>'tag') !~ '^[A-Za-z0-9_-]{22}$'
    OR jsonb_typeof(p->'ciphertext')<>'string'
    OR char_length(p->>'ciphertext') NOT BETWEEN 1 AND 87382
    OR (p->>'ciphertext') !~ '^[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'hermes_envelope_invalid' USING ERRCODE='22023'; END IF;
END
$fn$;
ALTER FUNCTION app_private.hermes_envelope_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_envelope_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
COMMIT;
