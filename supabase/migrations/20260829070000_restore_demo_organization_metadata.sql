-- Restore the canonical DEMO marker accidentally lost when the org was rebuilt.
-- The marker is metadata only; organization isolation remains policy/RPC based.
BEGIN;
SET LOCAL lock_timeout = '15s';

DO $migration$
DECLARE
  v_updated integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.organizations
    WHERE id = 'dddd0000-0000-4000-8000-000000000001'::uuid
      AND slug = 'ihome-demo'
      AND name = 'iHome CRM (Demo)'
      AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'canonical DEMO organization identity is missing';
  END IF;

  UPDATE public.organizations
  SET is_demo = true,
      updated_at = clock_timestamp()
  WHERE id = 'dddd0000-0000-4000-8000-000000000001'::uuid
    AND slug = 'ihome-demo'
    AND name = 'iHome CRM (Demo)'
    AND status = 'ACTIVE'
    AND is_demo IS DISTINCT FROM true;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'canonical DEMO marker restored; rows updated=%', v_updated;
END
$migration$;

COMMIT;
