-- Add the room and building sources needed by Business Performance realtime.
-- The frontend ignores event payloads and uses events only as cache signals.

BEGIN;

-- Stable migration-specific key serializes concurrent publication writers.
SELECT pg_advisory_xact_lock(20260726030000::bigint);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rooms', 'buildings']
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

COMMIT;
