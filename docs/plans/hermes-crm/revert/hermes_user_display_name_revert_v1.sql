-- R2c part 2 (c) REVERT — prepared 21/10/2026 next to the forward file; NOT a migration (docs/plans/hermes-crm/revert/).
-- Removes public.hermes_user_display_name_v1() that 20261021044821_hermes_user_display_name_v1.sql created. Effect:
-- PostgREST answers PGRST202 and the connector's crm_auth_context reports userName null (optional read); nothing else
-- reads it. No data is touched.
-- SAFE ORDER: none (the connector treats the function as optional). Do NOT revoke EXECUTE instead: a permission error
-- is not PGRST202 and would make crm_auth_context fail closed.
-- TO APPLY: copy into supabase/migrations under the name `node scripts/tao-ten-migration.mjs
-- hermes_user_display_name_revert_v1` gives; the DROP FUNCTION of a hermes_ function needs the explicit review the
-- durable-schema contract asks for (scripts/__tests__/hermes-durable-schema.test.mjs forbids it by default) and the
-- removal from its PUBLIC / NAME_DIRECTORY_INVOKER lists; TEST lane, then production. Idempotent (IF EXISTS).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DROP FUNCTION IF EXISTS public.hermes_user_display_name_v1();

DO $assert$
BEGIN
  IF to_regprocedure('public.hermes_user_display_name_v1()') IS NOT NULL
    THEN RAISE EXCEPTION 'hermes_user_display_name_revert_not_removed'; END IF;
END $assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
