-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- app_private.guard_canonical_write_operation() md5(prosrc)=8c32aed702db6705a15dd795c99f39a5
CREATE OR REPLACE FUNCTION app_private.guard_canonical_write_operation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private'
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Canonical operation ledger is append-only'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.subject_id IS NOT NULL
     OR OLD.response_payload IS NOT NULL
     OR OLD.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Completed canonical operation is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.subject_scope IS DISTINCT FROM OLD.subject_scope
     OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Canonical operation identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.subject_id IS NULL
     OR NEW.response_payload IS NULL
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'Canonical operation can only transition once to completed'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$function$

