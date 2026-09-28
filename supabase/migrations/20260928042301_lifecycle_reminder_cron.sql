-- P5 production invocation only. The existing PROD service JWT is provisioned
-- into this dedicated Vault slot during reviewed release, never in migration.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION app_private.lifecycle_reminder_service_jwt_v1()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,app_private AS $credential$
DECLARE token text; encoded text; claims jsonb;
BEGIN
  -- TEST sync deliberately has a marker and its own separately guarded job.
  IF to_regclass('test_env.danh_dau') IS NOT NULL THEN
    RAISE EXCEPTION 'Production lifecycle dispatch is disabled on marked TEST databases' USING ERRCODE='55000';
  END IF;
  SELECT decrypted_secret INTO token FROM vault.decrypted_secrets WHERE name='lifecycle_reminders_service_jwt';
  IF token IS NULL OR btrim(token)='' THEN
    RAISE EXCEPTION 'Configure lifecycle_reminders_service_jwt in Vault with the existing PROD service JWT before scheduling' USING ERRCODE='55000';
  END IF;
  BEGIN
    IF array_length(string_to_array(token,'.'),1)<>3 THEN RAISE EXCEPTION 'Invalid JWT'; END IF;
    encoded:=translate(split_part(token,'.',2),'-_','+/');
    claims:=convert_from(decode(rpad(encoded,((length(encoded)+3)/4)*4,'='),'base64'),'UTF8')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Lifecycle Vault credential must be a valid service JWT' USING ERRCODE='55000';
  END;
  IF claims->>'role' IS DISTINCT FROM 'service_role' OR claims->>'ref' IS DISTINCT FROM 'tryymsxyyckgbrmmvozx' THEN
    RAISE EXCEPTION 'Lifecycle Vault JWT must belong to production and have service_role' USING ERRCODE='55000';
  END IF;
  RETURN token;
END $credential$;
REVOKE ALL ON FUNCTION app_private.lifecycle_reminder_service_jwt_v1() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.dispatch_lifecycle_reminders_v1()
RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,app_private AS $dispatch$
DECLARE token text; request_id bigint;
BEGIN
  token:=app_private.lifecycle_reminder_service_jwt_v1();
  IF to_regprocedure('public.lifecycle_reminder_sweep_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Apply the reviewed P5 lifecycle reminder migration first' USING ERRCODE='55000';
  END IF;
  SELECT net.http_post(url:='https://tryymsxyyckgbrmmvozx.supabase.co/functions/v1/lifecycle-reminders',
    headers:=jsonb_build_object('Authorization','Bearer '||token,'Content-Type','application/json'),
    body:='{}'::jsonb,timeout_milliseconds:=120000) INTO request_id;
  -- This is a pg_net enqueue receipt, not proof of successful sweep or push.
  RETURN request_id;
END $dispatch$;
REVOKE ALL ON FUNCTION app_private.dispatch_lifecycle_reminders_v1() FROM PUBLIC,anon,authenticated,service_role;

DO $schedule$
DECLARE job bigint;
BEGIN
  IF to_regclass('test_env.danh_dau') IS NOT NULL THEN
    -- Remove only a copied P5 production job; TEST bootstrap owns its own job.
    FOR job IN SELECT jobid FROM cron.job WHERE jobname='lifecycle-reminders-15m' LOOP
      PERFORM cron.unschedule(job);
    END LOOP;
    RETURN;
  END IF;
  PERFORM app_private.lifecycle_reminder_service_jwt_v1();
  IF to_regprocedure('public.lifecycle_reminder_sweep_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Apply the reviewed P5 lifecycle reminder migration first' USING ERRCODE='55000';
  END IF;
  PERFORM cron.schedule('lifecycle-reminders-15m','*/15 * * * *','SELECT app_private.dispatch_lifecycle_reminders_v1();');
END $schedule$;
