-- P1a.2: atomic, bounded driving-table cutover. Existing monetary policy,
-- permission checks and business lock order are retained. Capability has no FK.
-- Reviewed preconditions include P1a.1 approval eligibility on TEST.
-- Definition fingerprints normalize CRLF pairs to LF only; bare CR and all
-- other bytes remain significant. Owner/ACL/security/config checks stay exact.
DO $migration$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('guard_contract_termination_settlement()') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='983735d0c72c3bf4cb60c7fb801194e4' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('approve_contract_termination_v1(uuid,text)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='6a403e83918b8d5453f59294edbe9e0b' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: approve_contract_termination_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.begin_contract_termination_write_v1(uuid,text)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='5e8bcaa95e89128cd72d3a78cb6288f0' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, app_private, public']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: begin_contract_termination_write_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.close_termination_write_v2(uuid)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='14f203609a052476d85276784ccce63f' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: close_termination_write_v2'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('create_contract_termination_draft_v1(uuid,date,text,text,numeric,numeric,numeric,integer,numeric,numeric,numeric,numeric,numeric,numeric,payment_method,text)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='38ffb94b0aab4b7839980f36129e153d' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: create_contract_termination_draft_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.end_contract_termination_write_v1(uuid)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='382f53de40affd1408fe8fa3df3fa7df' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, app_private, public']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: end_contract_termination_write_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('guard_contract_termination_settlement()') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='983735d0c72c3bf4cb60c7fb801194e4' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: guard_contract_termination_settlement'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('has_contract_termination_write_v1(uuid)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='3e5e94607e6d11e41eb0a92b64a6ddc1' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, app_private, public']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: has_contract_termination_write_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.open_termination_write_v2(uuid,uuid,uuid,text,text,jsonb,jsonb,text,text,text)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='4724488912c79281bd5e7078a64299ed' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: open_termination_write_v2'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('reject_contract_termination_v1(uuid,text)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='f8aec733e0ea3bf02949f1d64568ae43' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: reject_contract_termination_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('terminate_contract_forfeit(uuid,date,jsonb)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='af02d924fc8ee495e48bbcdf7096e8c5' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: terminate_contract_forfeit'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('terminate_contract_forfeit_impl(uuid,date,jsonb)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='71d861426074b80fbac5c6941f289e00' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=public']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: terminate_contract_forfeit_impl'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('terminate_contract_forfeit_with_credit_v1(uuid,date,jsonb,text)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='0063e98e71e2d5e39da19980a82060c6' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: terminate_contract_forfeit_with_credit_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('terminate_contract_move_out(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='af9cf234be5bbf27dd1176801dd910c3' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: terminate_contract_move_out'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='cefce92ca899b31c98eb80767b17401d' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=public']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: terminate_contract_move_out_impl'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('terminate_contract_move_out_with_credit_v1(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,text,jsonb)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='9bc5208bf731f969e20f30c5b77e4d9e' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: terminate_contract_move_out_with_credit_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.contract_terminations'::regclass AND tgname='a00_contract_termination_settlement_guard' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_contract_termination_settlement_guard BEFORE INSERT OR DELETE OR UPDATE ON public.contract_terminations FOR EACH ROW EXECUTE FUNCTION guard_contract_termination_settlement(''pre'')') THEN RAISE EXCEPTION 'P1a2 trigger drift'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.contract_terminations'::regclass AND tgname='contract_terminations_set_user_id_audit' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER contract_terminations_set_user_id_audit BEFORE INSERT ON public.contract_terminations FOR EACH ROW EXECUTE FUNCTION set_user_id_from_auth()') THEN RAISE EXCEPTION 'P1a2 trigger drift'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.contract_terminations'::regclass AND tgname='trg_autofill_org' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.contract_terminations FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict()') THEN RAISE EXCEPTION 'P1a2 trigger drift'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.contract_terminations'::regclass AND tgname='trigger_auto_calculate_termination_financials' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER trigger_auto_calculate_termination_financials BEFORE INSERT OR UPDATE ON public.contract_terminations FOR EACH ROW EXECUTE FUNCTION auto_calculate_termination_financials()') THEN RAISE EXCEPTION 'P1a2 trigger drift'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.contract_terminations'::regclass AND tgname='trigger_termination_final_guard' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER trigger_termination_final_guard BEFORE INSERT OR UPDATE ON public.contract_terminations FOR EACH ROW EXECUTE FUNCTION guard_contract_termination_settlement(''final'')') THEN RAISE EXCEPTION 'P1a2 trigger drift'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.contract_terminations'::regclass AND tgname='trigger_update_contract_on_termination' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER trigger_update_contract_on_termination BEFORE UPDATE OF status ON public.contract_terminations FOR EACH ROW EXECUTE FUNCTION update_contract_on_termination_approved()') THEN RAISE EXCEPTION 'P1a2 trigger drift'; END IF;
  IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_private.termination_write_capabilities'::regclass AND contype='f')
    OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='app_private.termination_write_capabilities'::regclass)
    OR EXISTS(SELECT 1 FROM information_schema.role_table_grants WHERE table_schema='app_private' AND table_name='termination_write_capabilities' AND grantee IN ('PUBLIC','anon','authenticated','service_role'))
    OR (SELECT count(*) FROM pg_attribute WHERE attrelid='app_private.termination_write_capabilities'::regclass AND attname IN ('organization_id','actor_id') AND attnotnull)<>2
  THEN RAISE EXCEPTION 'P1a2 capability storage boundary drift'; END IF;

    RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('approve_contract_termination_v1(uuid,text)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='e5bec0c847f543bb1df1213336cc75fa' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: approve_contract_termination_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.begin_contract_termination_write_v1(uuid,text)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='5e8bcaa95e89128cd72d3a78cb6288f0' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, app_private, public']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: begin_contract_termination_write_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.end_contract_termination_write_v1(uuid)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='382f53de40affd1408fe8fa3df3fa7df' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, app_private, public']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: end_contract_termination_write_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('guard_contract_termination_settlement()') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='7a6552ed4d57734c5e136367ab5fbc97' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.prosecdef=false AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: guard_contract_termination_settlement'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('has_contract_termination_write_v1(uuid)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='3e5e94607e6d11e41eb0a92b64a6ddc1' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, app_private, public']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: has_contract_termination_write_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('reject_contract_termination_v1(uuid,text)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='1316562d119902607b2ca904f51d1e6c' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: reject_contract_termination_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('terminate_contract_forfeit(uuid,date,jsonb)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='20c97cce83ed98d810a157256ddd457f' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: terminate_contract_forfeit'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('terminate_contract_forfeit_impl(uuid,date,jsonb)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='7e90f0f91f1d57ec51da82bd6bce7003' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=public']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: terminate_contract_forfeit_impl'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('terminate_contract_forfeit_with_credit_v1(uuid,date,jsonb,text)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='0c34e7be81350a1125f120c95cc1cc22' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: terminate_contract_forfeit_with_credit_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('terminate_contract_move_out(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='82a4cdbf74b4c0570d4078cbca78adac' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: terminate_contract_move_out'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='eae1e32af39b4abbffcf26075f1a94d2' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=public']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: terminate_contract_move_out_impl'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('terminate_contract_move_out_with_credit_v1(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,text,jsonb)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='fe8c5453ffdc35951c7a750a35da7d01' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: terminate_contract_move_out_with_credit_v1'; END IF;
  EXECUTE $install$
-- Authorization only: no replay payload, foreign keys or business-row locks.
CREATE TABLE IF NOT EXISTS app_private.termination_write_capabilities (
  transaction_id xid8 NOT NULL,
  backend_pid integer NOT NULL,
  termination_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('DRAFT','FORFEIT','MOVE_OUT','APPROVE','COMPLETE','REJECT','DELETE')),
  operation text,
  subject_scope text,
  idempotency_key text,
  payload_hash text NOT NULL,
  intent_hash text NOT NULL,
  expected_before jsonb,
  expected_after jsonb,
  phase integer NOT NULL DEFAULT 0 CHECK (phase BETWEEN -1 AND 2),
  PRIMARY KEY (transaction_id,backend_pid,termination_id),
  CHECK ((operation IS NULL AND subject_scope IS NULL AND idempotency_key IS NULL)
      OR (operation IS NOT NULL AND subject_scope IS NOT NULL AND idempotency_key IS NOT NULL))
);
REVOKE ALL ON app_private.termination_write_capabilities FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE app_private.termination_write_capabilities ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app_private.open_termination_write_v2(
  p_termination uuid,p_contract uuid,p_org uuid,p_action text,p_hash text,
  p_before jsonb,p_after jsonb,p_operation text DEFAULT NULL,p_key text DEFAULT NULL,p_intent_hash text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,app_private AS $function$
BEGIN
  IF auth.uid() IS NULL OR p_org IS NULL OR p_contract IS NULL OR p_termination IS NULL THEN
    RAISE EXCEPTION 'Missing exact termination scope' USING ERRCODE='42501';
  END IF;
  IF p_operation IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app_private.canonical_write_operations o
    WHERE o.organization_id=p_org AND o.operation=p_operation
      AND o.subject_scope=p_contract::text AND o.actor_id=auth.uid()
      AND o.idempotency_key=p_key AND o.payload_hash=p_hash AND o.completed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Missing ongoing canonical operation' USING ERRCODE='42501';
  END IF;
  INSERT INTO app_private.termination_write_capabilities
    (transaction_id,backend_pid,termination_id,contract_id,organization_id,actor_id,
     action,operation,subject_scope,idempotency_key,payload_hash,intent_hash,expected_before,expected_after,phase)
  VALUES (pg_current_xact_id(),pg_backend_pid(),p_termination,p_contract,p_org,auth.uid(),
    p_action,p_operation,CASE WHEN p_operation IS NOT NULL THEN p_contract::text END,p_key,p_hash,coalesce(p_intent_hash,p_hash),
    p_before-ARRAY['refund_amount','total_deductions'],p_after-ARRAY['refund_amount','total_deductions'],
    CASE WHEN p_after IS NULL AND p_action IN ('FORFEIT','MOVE_OUT') THEN -1 ELSE 0 END);
END
$function$;
REVOKE ALL ON FUNCTION app_private.open_termination_write_v2(uuid,uuid,uuid,text,text,jsonb,jsonb,text,text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.close_termination_write_v2(p_termination uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,app_private AS $function$
BEGIN
  DELETE FROM app_private.termination_write_capabilities
  WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid()
    AND termination_id=p_termination AND actor_id=auth.uid() AND phase=2;
  IF NOT FOUND THEN RAISE EXCEPTION 'Termination proof was not consumed' USING ERRCODE='42501'; END IF;
END
$function$;
REVOKE ALL ON FUNCTION app_private.close_termination_write_v2(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.guard_contract_termination_settlement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,app_private AS $function$
DECLARE
  v_cap app_private.termination_write_capabilities%rowtype;
  v_old jsonb := CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD)-ARRAY['refund_amount','total_deductions'] END;
  v_new jsonb := CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW)-ARRAY['refund_amount','total_deductions'] END;
  v_id uuid := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  v_meta text[] := ARRAY['notes','internal_notes','damage_description','damage_images','other_fees_description','updated_at'];
  v_normal text[] := ARRAY[]::text[];
  v_field text;
BEGIN
  SELECT * INTO v_cap FROM app_private.termination_write_capabilities
  WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid()
    AND termination_id=v_id AND actor_id=auth.uid();
  IF NOT FOUND THEN
    IF TG_OP<>'UPDATE' THEN
      RAISE EXCEPTION 'Termination write requires exact capability' USING ERRCODE='42501';
    END IF;
    IF TG_ARGV[0]='final' THEN
      NEW.outstanding_debt:=OLD.outstanding_debt;
      NEW.prorated_rent:=OLD.prorated_rent;
      NEW.prorated_days:=OLD.prorated_days;
      NEW.prorated_services:=OLD.prorated_services;
      NEW.total_deposit:=OLD.total_deposit;
      v_new:=to_jsonb(NEW)-ARRAY['refund_amount','total_deductions'];
    END IF;
    IF (v_new-v_meta) IS DISTINCT FROM (v_old-v_meta) THEN
      RAISE EXCEPTION 'Protected termination change requires exact capability' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF v_cap.organization_id IS DISTINCT FROM COALESCE(NEW.organization_id,OLD.organization_id)
     OR v_cap.contract_id IS DISTINCT FROM COALESCE(NEW.contract_id,OLD.contract_id)
     OR (TG_OP='UPDATE' AND (OLD.organization_id IS DISTINCT FROM v_cap.organization_id OR OLD.contract_id IS DISTINCT FROM v_cap.contract_id))
     OR (TG_OP='INSERT' AND v_cap.action NOT IN ('DRAFT','FORFEIT','MOVE_OUT'))
     OR (TG_OP='UPDATE' AND v_cap.action NOT IN ('APPROVE','COMPLETE','REJECT'))
     OR (TG_OP='DELETE' AND v_cap.action<>'DELETE') THEN
    RAISE EXCEPTION 'Termination proof scope/action mismatch' USING ERRCODE='42501';
  END IF;
  IF (v_cap.action='DRAFT' AND NEW.status IS DISTINCT FROM 'DRAFT')
     OR (v_cap.action IN ('FORFEIT','MOVE_OUT') AND NEW.status IS DISTINCT FROM 'COMPLETED')
     OR (v_cap.action='FORFEIT' AND NEW.termination_type IS DISTINCT FROM 'FORFEIT')
     OR (v_cap.action='MOVE_OUT' AND NEW.termination_type IS DISTINCT FROM 'NORMAL')
     OR (v_cap.action='REJECT' AND NEW.status IS DISTINCT FROM 'DRAFT')
     OR (v_cap.action='COMPLETE' AND (OLD.status IS DISTINCT FROM 'APPROVED' OR NEW.status IS DISTINCT FROM 'COMPLETED'))
     OR (v_cap.action='APPROVE' AND (OLD.status='COMPLETED' OR NEW.status IS DISTINCT FROM 'APPROVED')) THEN
    RAISE EXCEPTION 'Termination transition mismatch' USING ERRCODE='42501';
  END IF;
  IF v_cap.operation IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app_private.canonical_write_operations o
    WHERE o.organization_id=v_cap.organization_id AND o.actor_id=v_cap.actor_id
      AND o.operation=v_cap.operation AND o.subject_scope=v_cap.subject_scope
      AND o.idempotency_key=v_cap.idempotency_key AND o.payload_hash=v_cap.payload_hash
      AND o.completed_at IS NULL
  ) THEN RAISE EXCEPTION 'Termination canonical binding mismatch' USING ERRCODE='42501'; END IF;
  IF TG_ARGV[0]='pre' THEN
    IF v_cap.phase<>0 OR v_old IS DISTINCT FROM v_cap.expected_before OR v_new IS DISTINCT FROM v_cap.expected_after THEN
      RAISE EXCEPTION 'Termination proof incoming payload mismatch' USING ERRCODE='42501';
    END IF;
    UPDATE app_private.termination_write_capabilities SET phase=CASE WHEN TG_OP='DELETE' THEN 2 ELSE 1 END
    WHERE transaction_id=v_cap.transaction_id AND backend_pid=v_cap.backend_pid AND termination_id=v_id;
  ELSE
    FOREACH v_field IN ARRAY ARRAY['outstanding_debt','prorated_rent','prorated_days','prorated_services','total_deposit'] LOOP
      IF v_cap.expected_after->v_field='null'::jsonb THEN v_normal:=array_append(v_normal,v_field); END IF;
    END LOOP;
    IF v_cap.phase<>1 OR (v_new-v_normal) IS DISTINCT FROM (v_cap.expected_after-v_normal) THEN
      RAISE EXCEPTION 'Termination proof normalized payload mismatch' USING ERRCODE='42501';
    END IF;
    -- This validator runs before the existing contract-writing approval trigger.
    IF v_cap.action='APPROVE' AND (NEW.status<>'APPROVED' OR NEW.approved_by IS DISTINCT FROM auth.uid() OR NEW.approved_at IS DISTINCT FROM now()) THEN
      RAISE EXCEPTION 'Termination approval stamps mismatch' USING ERRCODE='42501';
    END IF;
    UPDATE app_private.termination_write_capabilities SET phase=2
    WHERE transaction_id=v_cap.transaction_id AND backend_pid=v_cap.backend_pid AND termination_id=v_id;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS a00_contract_termination_settlement_guard ON public.contract_terminations;
CREATE TRIGGER a00_contract_termination_settlement_guard BEFORE INSERT OR UPDATE OR DELETE ON public.contract_terminations
FOR EACH ROW EXECUTE FUNCTION public.guard_contract_termination_settlement('pre');
DROP TRIGGER IF EXISTS trigger_termination_final_guard ON public.contract_terminations;
CREATE TRIGGER trigger_termination_final_guard BEFORE INSERT OR UPDATE ON public.contract_terminations
FOR EACH ROW EXECUTE FUNCTION public.guard_contract_termination_settlement('final');

CREATE OR REPLACE FUNCTION public.approve_contract_termination_v1(p_termination_id uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_current public.contract_terminations%rowtype;
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_term public.contract_terminations%rowtype;
  v_contract public.contracts%rowtype;
  v_building uuid;
  v_refund numeric;
  v_refund_raw numeric;
  v_deposit_real numeric;
  v_capped boolean := false;
  v_notes text;
  v_type_id uuid;
  v_voucher_id uuid;
  v_voucher_kind text;
  v_type_names text[];
  v_desc text;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;

  select * into v_term from public.contract_terminations
   where id = p_termination_id for update;
  if not found then
    raise exception 'Không tìm thấy yêu cầu thanh lý hoặc bạn không có quyền' using errcode = '42501';
  end if;

  select * into v_contract from public.contracts
   where id = v_term.contract_id for update;
  if not found then
    raise exception 'Hợp đồng của yêu cầu thanh lý không còn tồn tại';
  end if;

  -- Validate the locked termination/contract against the room/building scope.
  -- Snapshot consistency only: this bounded patch adds no room/building locks.
  if v_term.organization_id is null
     or v_term.organization_id is distinct from v_contract.organization_id
     or not exists (
       select 1 from public.rooms r
       join public.buildings b on b.id = r.building_id
       where r.id = v_contract.room_id
         and r.organization_id = v_contract.organization_id
         and b.organization_id = v_contract.organization_id
     ) then
    raise exception 'Phạm vi yêu cầu thanh lý không khớp hợp đồng, phòng hoặc tòa nhà'
      using errcode = '42501';
  end if;

  -- contracts KHÔNG có cột building_id — toà suy qua phòng (helper chuẩn RLS).
  v_building := public.building_of_contract(v_contract.id);
  if not (public.is_super_admin()
          or public.can_do_on_building('contracts', 'edit', v_building)) then
    raise exception 'Không có quyền duyệt thanh lý hợp đồng này' using errcode = '42501';
  end if;

  if v_term.status = 'COMPLETED' then
    return jsonb_build_object('termination_id', v_term.id, 'status', 'COMPLETED',
                              'voucher_id', null, 'noop', true);
  end if;

  -- Authorized COMPLETED replay above remains an exact no-op.
  if v_contract.deleted_at is not null
     or v_contract.status not in ('ACTIVE', 'EXTENDED') then
    raise exception 'Hợp đồng không còn đủ điều kiện duyệt thanh lý'
      using errcode = '55000';
  end if;

  select coalesce(nullif(btrim(full_name), ''), nullif(btrim(email), ''), 'Người dùng')
    into v_actor_name from public.profiles where id = v_actor;

  -- 1-3: chuỗi trạng thái (giữ nguyên thứ tự legacy, nay atomic trong 1 tx)
  PERFORM app_private.open_termination_write_v2(v_term.id,v_term.contract_id,v_term.organization_id,'APPROVE',md5(coalesce(p_note,'')),to_jsonb(v_term),to_jsonb(v_term)||jsonb_build_object('status','APPROVED','approved_by',v_actor,'approved_at',now()));
  update public.contract_terminations
     set status = 'APPROVED', approved_by = v_actor, approved_at = now()
   where id = v_term.id;
  PERFORM app_private.close_termination_write_v2(v_term.id);

  update public.contracts
     set status = 'TERMINATED', updated_at = now()
   where id = v_contract.id;

  SELECT * INTO v_current FROM public.contract_terminations WHERE id=v_term.id;
  PERFORM app_private.open_termination_write_v2(v_term.id,v_term.contract_id,v_term.organization_id,'COMPLETE',md5(coalesce(p_note,'')),to_jsonb(v_current),to_jsonb(v_current)||jsonb_build_object('status','COMPLETED','refund_date',now()::date));
  update public.contract_terminations
     set status = 'COMPLETED', refund_date = now()
   where id = v_term.id;
  PERFORM app_private.close_termination_write_v2(v_term.id);

  -- 4: bút toán tiền (thay cash_book đã chết) — phiếu NHÁP chờ kế toán
  --
  -- [H2.3a] contract_terminations.refund_amount là cột GENERATED:
  --     refund_amount = total_deposit − (công nợ + tiền thuê + phí + …)
  -- total_deposit là cọc GHI TRÊN HỒ SƠ, không phải cọc đã vào két. Ký cọc
  -- 10tr, mới đóng 4tr, không khấu trừ gì ⇒ cột ra 10tr và phiếu chi cũ ghi
  -- đúng 10tr: chi ra 6tr chưa từng thu. preview_termination_refund_v1 đã báo
  -- đúng việc này (VUOT_COC_THAT) nhưng chỉ là cảnh báo trên màn hình, writer
  -- vẫn ghi theo cột. Nay kẹp cứng ở writer theo cọc THỰC NHẬN.
  --
  -- Chỉ KẸP, không tính lại: kẹp là chặn trên đơn điệu, không bao giờ ghi
  -- nhiều hơn hôm nay. Phần chênh còn lại (khấu trừ vốn đã trừ trên cọc thoả
  -- thuận) là bài toán của đường thanh lý mới — đợt 4 plan 2 hoàn cọc đang tạm
  -- dừng theo quyết định chủ 28/08/2026.
  v_refund_raw := coalesce(v_term.refund_amount, 0);
  v_refund := v_refund_raw;
  if v_refund > 0 then
    v_deposit_real := coalesce(public.contract_deposit_paid_derived(v_contract.id), 0);
    if v_refund > v_deposit_real then
      v_refund := v_deposit_real;
      v_capped := true;
    end if;
  end if;

  v_notes := nullif(btrim(coalesce(p_note, '')), '');
  if v_capped then
    v_notes := coalesce(v_notes || E'\n', '')
      || '[Kẹp theo cọc thực nhận] Hồ sơ thanh lý tính hoàn '
      || round(v_refund_raw)::bigint || 'đ theo cọc thoả thuận, nhưng cọc THỰC NHẬN '
      || 'của hợp đồng chỉ có ' || round(v_deposit_real)::bigint
      || 'đ. Phiếu ghi theo cọc thực nhận. Chênh '
      || round(v_refund_raw - v_deposit_real)::bigint
      || 'đ là khoản chưa từng vào két — muốn hoàn thì phải có phiếu thu cọc đứng sau.';
  end if;

  if v_refund <> 0 then
    if v_refund > 0 then
      v_voucher_kind := 'EXPENSE';
      v_type_names := array['Hoàn cọc / tiền thừa khi thanh lý',
                            'Hoàn trả thanh lý',
                            'Hoàn cọc thanh lý',
                            'Hoàn tiền thừa thanh lý'];
      v_desc := 'Hoàn cọc thanh lý hợp đồng';
    else
      v_voucher_kind := 'INCOME';
      v_type_names := array['Thu thanh lý (khách trả thêm)',
                            'Doanh thu thanh lý'];
      v_desc := 'Thu thêm từ thanh lý hợp đồng';
    end if;

    -- Resolve hạng mục trong org theo thứ tự ưu tiên; trùng tên → bản cũ nhất.
    select t.id into v_type_id
      from public.income_expense_types t
     where t.organization_id = v_term.organization_id
       and lower(t.type) = lower(v_voucher_kind)
       and t.name = any (v_type_names)
     order by array_position(v_type_names, t.name), t.created_at
     limit 1;
    if v_type_id is null then
      raise exception 'Org chưa có hạng mục "%" cho bút toán thanh lý — tạo hạng mục rồi duyệt lại',
        v_type_names[1];
    end if;

    insert into public.income_expenses (
      user_id, creator_name, type, name,
      building_id, room_id, contract_id, account_id,
      payer_name, approval_status, voucher_date, attachments,
      notes, organization_id
    ) values (
      v_actor, coalesce(v_actor_name, 'Người dùng'), v_voucher_kind,
      v_desc || ' ' || coalesce(v_contract.contract_number, left(v_contract.id::text, 8)),
      v_building, v_contract.room_id, v_contract.id, null,
      null, 'UNAPPROVED', public.org_today_v1(NULL), '[]'::jsonb,
      v_notes, v_term.organization_id
    ) returning id into v_voucher_id;

    -- [H2.3b] Truyền `amount` tường minh. Hôm nay trigger auto_calc_item_amount
    -- ghi đè amount := quantity * unit_price nên giá trị này trùng khít; đó
    -- đúng là lý do phải viết ra — lúc H3.1 gỡ ghi đè, call-site đã sẵn sàng
    -- chứ không đẻ ra item amount NULL.
    insert into public.income_expense_items (
      income_expense_id, income_expense_type_id, description,
      quantity, unit_price, amount, start_date, end_date
    ) values (
      v_voucher_id, v_type_id,
      v_desc || ' (yêu cầu ' || left(v_term.id::text, 8) || ')',
      1, abs(v_refund), abs(v_refund), public.org_today_v1(NULL), public.org_today_v1(NULL)
    );
  end if;

  -- 5: trả phòng
  --
  -- [H2.3c] Trước đây: update rooms set status='AVAILABLE' VÔ ĐIỀU KIỆN. Hai
  -- thứ bị cướp:
  --   · hợp đồng còn hiệu lực KHÁC trên cùng phòng (ở ghép / chồng kỳ) — phòng
  --     đang OCCUPIED bị trả trống dù còn người ở;
  --   · cờ RESERVED của khách kế đã đặt cọc giữ chỗ.
  -- Dòng dưới dùng ĐÚNG predicate NOT EXISTS của trigger
  -- update_room_status_on_contract_change (plan con F sở hữu trigger đó — ở đây
  -- chỉ chép predicate, không sửa trigger), rồi gọi helper chuẩn để dựng lại
  -- RESERVED. recompute_room_reservation tự bỏ qua MAINTENANCE/UNAVAILABLE và
  -- tự nhường phòng còn hợp đồng hiệu lực, nên gọi lại luôn an toàn.
  if v_contract.room_id is not null then
    update public.rooms
       set status = 'AVAILABLE', updated_at = now()
     where id = v_contract.room_id
       and not exists (
         select 1 from public.contracts c
          where c.room_id = v_contract.room_id
            and c.deleted_at is null
            and c.status in ('ACTIVE', 'EXTENDED')
            and c.id <> v_contract.id
       );

    perform public.recompute_room_reservation(v_contract.room_id);
  end if;

  return jsonb_build_object('termination_id', v_term.id, 'status', 'COMPLETED',
                            'voucher_id', v_voucher_id, 'room_id', v_contract.room_id,
                            'refund_amount', v_refund,
                            'refund_amount_requested', v_refund_raw,
                            'refund_capped', v_capped);
end;
$function$;
CREATE OR REPLACE FUNCTION public.reject_contract_termination_v1(p_termination_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_term public.contract_terminations%rowtype;
  v_building uuid;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;

  select * into v_term from public.contract_terminations
   where id = p_termination_id for update;
  if not found then
    raise exception 'Không tìm thấy yêu cầu thanh lý hoặc bạn không có quyền' using errcode = '42501';
  end if;

  v_building := public.building_of_contract(v_term.contract_id);
  if not (public.is_super_admin()
          or public.can_do_on_building('contracts', 'edit', v_building)) then
    raise exception 'Không có quyền từ chối yêu cầu thanh lý này' using errcode = '42501';
  end if;

  if v_term.status = 'COMPLETED' then
    raise exception 'Yêu cầu đã hoàn tất thanh lý — không thể từ chối';
  end if;

  IF NOT EXISTS (SELECT 1 FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id JOIN public.buildings b ON b.id=r.building_id WHERE c.id=v_term.contract_id AND c.organization_id=v_term.organization_id AND r.organization_id=v_term.organization_id AND b.organization_id=v_term.organization_id) THEN RAISE EXCEPTION 'Termination organization linkage mismatch' USING ERRCODE='42501'; END IF;
  PERFORM app_private.open_termination_write_v2(v_term.id,v_term.contract_id,v_term.organization_id,'REJECT',md5(coalesce(p_reason,'')),to_jsonb(v_term),to_jsonb(v_term)||jsonb_build_object('status','DRAFT','notes',CASE WHEN nullif(btrim(coalesce(p_reason,'')),'') IS NOT NULL THEN '[Từ chối] '||btrim(p_reason) ELSE v_term.notes END));
  -- Mirror legacy: trả về DRAFT (không phải REJECTED) + prefix lý do vào notes.
  update public.contract_terminations
     set status = 'DRAFT',
         notes = case when nullif(btrim(coalesce(p_reason, '')), '') is not null
                      then '[Từ chối] ' || btrim(p_reason)
                      else notes end
   where id = v_term.id;
  PERFORM app_private.close_termination_write_v2(v_term.id);
end;
$function$;
CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit(p_contract_id uuid, p_forfeit_date date, p_extra_charges jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_term_id uuid;
  v_opened_term boolean := false;
  v_room uuid;
  v_org uuid;
  v_core_writer boolean;
  v_opened_writer boolean := false;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT contract_row.room_id, contract_row.organization_id
    INTO v_room, v_org
  FROM public.contracts contract_row
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE OF contract_row;

  IF NOT (
    public.is_super_admin()
    OR (
      v_room IS NOT NULL
      AND public.can_do_on_building(
        'contracts', 'edit',
        (SELECT room_row.building_id
         FROM public.rooms room_row
         WHERE room_row.id = v_room)
      )
    )
  ) THEN
    RAISE EXCEPTION 'Missing permission to terminate contract'
      USING ERRCODE = '42501';
  END IF;

  IF v_org IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id JOIN public.buildings b ON b.id=r.building_id
    WHERE c.id=p_contract_id AND c.organization_id=v_org AND r.organization_id=v_org AND b.organization_id=v_org
  ) THEN RAISE EXCEPTION 'Contract organization linkage mismatch' USING ERRCODE='42501'; END IF;
  IF EXISTS (SELECT 1 FROM public.contracts WHERE id=p_contract_id AND status IN ('TERMINATED','EXPIRED')) THEN
    RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.contracts WHERE id=p_contract_id AND deleted_at IS NULL AND status IN ('ACTIVE','EXTENDED')) THEN
    RAISE EXCEPTION 'Contract is not eligible for termination' USING ERRCODE='55000';
  END IF;
  SELECT termination_id INTO v_term_id FROM app_private.termination_write_capabilities
  WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid()
    AND contract_id=p_contract_id AND organization_id=v_org AND actor_id=auth.uid()
    AND action='FORFEIT' AND phase=-1 AND intent_hash=md5(jsonb_build_object('contract_id',p_contract_id,'forfeit_date',p_forfeit_date,'extra_charges',coalesce(p_extra_charges,'[]'::jsonb))::text);
  IF v_term_id IS NULL THEN
    v_term_id:=gen_random_uuid();
    PERFORM app_private.open_termination_write_v2(v_term_id,p_contract_id,v_org,'FORFEIT',md5(jsonb_build_object('contract_id',p_contract_id,'forfeit_date',p_forfeit_date,'extra_charges',coalesce(p_extra_charges,'[]'::jsonb))::text),NULL,NULL);
    v_opened_term:=true;
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_core_writer;

  IF NOT v_core_writer THEN
    PERFORM app_private.assert_contract_has_no_customer_credit_v1(
      p_contract_id, v_org
    );
    PERFORM app_private.begin_accounting_chain_write_v1();
    v_opened_writer := true;
  END IF;

  BEGIN
    v_result := public.terminate_contract_forfeit_impl(
      p_contract_id, p_forfeit_date, COALESCE(p_extra_charges, '[]'::jsonb)
    );
  EXCEPTION WHEN OTHERS THEN
    IF v_opened_writer THEN
      PERFORM app_private.end_accounting_chain_write_v1();
    END IF;
    RAISE;
  END;

  IF v_opened_writer THEN
    PERFORM app_private.end_accounting_chain_write_v1();
  END IF;
  IF v_opened_term THEN PERFORM app_private.close_termination_write_v2(v_term_id); END IF;
  RETURN v_result;
END;
$function$;
CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit_with_credit_v1(p_contract_id uuid, p_forfeit_date date, p_extra_charges jsonb, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_term_id uuid;
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_org uuid;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_credit_balance numeric(15,2);
  v_termination jsonb;
  v_credit jsonb;
  v_response jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid idempotency_key' USING ERRCODE = '22023';
  END IF;

  SELECT contract_row.organization_id INTO v_org
  FROM public.contracts contract_row
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Contract not found' USING ERRCODE = '42501';
  END IF;

  IF v_org IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id JOIN public.buildings b ON b.id=r.building_id
    WHERE c.id=p_contract_id AND c.organization_id=v_org AND r.organization_id=v_org AND b.organization_id=v_org
  ) THEN RAISE EXCEPTION 'Contract organization linkage mismatch' USING ERRCODE='42501'; END IF;
  IF NOT (public.is_super_admin() OR public.can_do_on_building('contracts','edit',public.building_of_contract(p_contract_id))) THEN RAISE EXCEPTION 'Missing permission to terminate contract' USING ERRCODE='42501'; END IF;
  v_hash := md5(jsonb_build_object(
    'contract_id', p_contract_id,
    'forfeit_date', p_forfeit_date,
    'extra_charges', COALESCE(p_extra_charges, '[]'::jsonb)
  )::text);
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id,
    idempotency_key, payload_hash
  ) VALUES (
    v_org, 'contract.terminate.forfeit.credit.v1', p_contract_id::text,
    v_actor, v_key, v_hash
  ) ON CONFLICT (
    organization_id, operation, subject_scope, actor_id, idempotency_key
  ) DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'contract.terminate.forfeit.credit.v1'
    AND operation_row.subject_scope = p_contract_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;
  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key was reused with a different payload'
      USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  IF EXISTS (SELECT 1 FROM public.contracts WHERE id=p_contract_id AND status IN ('TERMINATED','EXPIRED')) THEN
    RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.contracts WHERE id=p_contract_id AND deleted_at IS NULL AND status IN ('ACTIVE','EXTENDED')) THEN
    RAISE EXCEPTION 'Contract is not eligible for termination' USING ERRCODE='55000';
  END IF;
  v_term_id:=gen_random_uuid();
  PERFORM app_private.open_termination_write_v2(v_term_id,p_contract_id,v_org,'FORFEIT',v_hash,NULL,NULL,'contract.terminate.forfeit.credit.v1',v_key,md5(jsonb_build_object('contract_id',p_contract_id,'forfeit_date',p_forfeit_date,'extra_charges',coalesce(p_extra_charges,'[]'::jsonb))::text));
  v_credit_balance := app_private.contract_customer_credit_balance_v1(
    p_contract_id, v_org
  );
  PERFORM app_private.begin_accounting_chain_write_v1();
  v_termination := public.terminate_contract_forfeit(
    p_contract_id, p_forfeit_date, COALESCE(p_extra_charges, '[]'::jsonb)
  );
  PERFORM app_private.end_accounting_chain_write_v1();
  IF v_credit_balance > 0
     AND app_private.evaluate_feature_route('customer.credit.apply.v1', v_org) = 'CANONICAL' THEN
    v_credit := app_private.apply_customer_credit_fifo_v1(
      v_actor, p_contract_id, NULL, NULL, 'FORFEIT',
      'Forfeit remaining customer credit on contract termination', v_key
    );
  ELSIF v_credit_balance > 0 THEN
    -- Tính năng xử lý "tiền khách trả dư" chưa bật (route <> CANONICAL): KHÔNG
    -- chặn thanh lý. Gác khoản dư lại, đánh dấu deferred để xử lý riêng (hoàn/cấn
    -- trừ thủ công) sau. Trước đây nhánh này gọi apply_customer_credit_fifo_v1 vô
    -- điều kiện → ném 55000 "Customer credit writer is not enabled" làm gãy cả
    -- thao tác thanh lý bỏ cọc.
    v_credit := jsonb_build_object(
      'contract_id', p_contract_id,
      'invoice_id', NULL,
      'application_kind', 'FORFEIT',
      'applied_amount', 0,
      'remaining_amount', v_credit_balance,
      'applications', '[]'::jsonb,
      'deferred', true,
      'deferred_reason', 'customer_credit_writer_not_enabled'
    );
  ELSE
    v_credit := jsonb_build_object(
      'contract_id', p_contract_id,
      'invoice_id', NULL,
      'application_kind', 'FORFEIT',
      'applied_amount', 0,
      'remaining_amount', 0,
      'applications', '[]'::jsonb
    );
  END IF;
  v_response := jsonb_build_object(
    'termination', v_termination,
    'credit', v_credit
  );

  PERFORM app_private.close_termination_write_v2(v_term_id);
  UPDATE app_private.canonical_write_operations
     SET subject_id = p_contract_id,
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_org
     AND operation = 'contract.terminate.forfeit.credit.v1'
     AND subject_scope = p_contract_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;
  RETURN v_response;
END;
$function$;
CREATE OR REPLACE FUNCTION public.terminate_contract_move_out(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric DEFAULT 0, p_penalty_fee numeric DEFAULT 0, p_excess_rent numeric DEFAULT 0, p_outstanding_debt numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_extra_charges jsonb DEFAULT '[]'::jsonb, p_shortfall_mode text DEFAULT 'PAID'::text, p_receipt_account_id uuid DEFAULT NULL::uuid, p_refund_items jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_term_id uuid;
  v_opened_term boolean := false;
  v_room uuid;
  v_org uuid;
  v_owner uuid;
  v_building uuid;
  v_deposit_paid numeric;
  v_extra numeric := 0;
  v_cash_shortfall numeric := 0;
  v_receipt_account uuid;
  v_cash_authz boolean;
  v_core_writer boolean;
  v_opened_writer boolean := false;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT
    contract_row.room_id,
    contract_row.organization_id,
    contract_row.user_id,
    room_row.building_id,
    contract_row.deposit_paid
    INTO v_room, v_org, v_owner, v_building, v_deposit_paid
  FROM public.contracts contract_row
  LEFT JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE OF contract_row;

  IF NOT (
    public.is_super_admin()
    OR (
      v_room IS NOT NULL
      AND public.can_do_on_building(
        'contracts', 'edit',
        (SELECT room_row.building_id
         FROM public.rooms room_row
         WHERE room_row.id = v_room)
      )
    )
  ) THEN
    RAISE EXCEPTION 'Missing permission to terminate contract'
      USING ERRCODE = '42501';
  END IF;

  IF p_receipt_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.accounts account_row
    WHERE account_row.id = p_receipt_account_id
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
  ) THEN
    RAISE EXCEPTION 'Receipt account is outside the contract organization or is not a real active cashbook'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(sum((entry->>'amount')::numeric), 0)
      INTO v_extra
    FROM jsonb_array_elements(COALESCE(p_extra_charges, '[]'::jsonb)) item(entry)
    WHERE NULLIF(entry->>'amount', '') IS NOT NULL
      AND (entry->>'amount')::numeric > 0;
  END IF;

  v_cash_shortfall := GREATEST(
    COALESCE(p_outstanding_debt, 0)
      + COALESCE(p_penalty_fee, 0)
      + v_extra
      - LEAST(
          GREATEST(COALESCE(p_deposit_refund, 0), 0),
          COALESCE(v_deposit_paid, 0)
        )
      - GREATEST(COALESCE(p_excess_rent, 0), 0)
      - COALESCE((
          SELECT SUM((entry->>'amount')::numeric)
          FROM jsonb_array_elements(COALESCE(p_refund_items, '[]'::jsonb)) item(entry)
          WHERE jsonb_typeof(COALESCE(p_refund_items, '[]'::jsonb)) = 'array'
            AND NULLIF(entry->>'amount', '') IS NOT NULL
            AND (entry->>'amount')::numeric > 0
        ), 0),
    0
  );

  IF upper(COALESCE(p_shortfall_mode, 'PAID')) = 'PAID'
     AND v_cash_shortfall > 0 THEN
    v_receipt_account := COALESCE(
      p_receipt_account_id,
      public._collector_thu_account(auth.uid()),
      public._termination_pick_account(v_owner, v_building)
    );

    IF v_receipt_account IS NULL THEN
      RAISE EXCEPTION 'Cannot resolve an active real receipt account in the contract organization'
        USING ERRCODE = '42501';
    END IF;
    PERFORM 1
    FROM public.accounts account_row
    WHERE account_row.id = v_receipt_account
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cannot resolve an active real receipt account in the contract organization'
        USING ERRCODE = '42501';
    END IF;

    PERFORM app_private.lock_org_for_decision_v1(v_org);
    SELECT decision.allowed
      INTO v_cash_authz
    FROM app_private.authorize_tenant_action_v3(
      auth.uid(), v_org, 'thu_tien.collect', v_building, v_receipt_account
    ) decision;
    IF NOT COALESCE(v_cash_authz, false) THEN
      RAISE EXCEPTION 'Missing receipt permission or cashbook possession for termination collection'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    v_receipt_account := p_receipt_account_id;
  END IF;

  IF v_org IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id JOIN public.buildings b ON b.id=r.building_id
    WHERE c.id=p_contract_id AND c.organization_id=v_org AND r.organization_id=v_org AND b.organization_id=v_org
  ) THEN RAISE EXCEPTION 'Contract organization linkage mismatch' USING ERRCODE='42501'; END IF;
  IF EXISTS (SELECT 1 FROM public.contracts WHERE id=p_contract_id AND status IN ('TERMINATED','EXPIRED')) THEN
    RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.contracts WHERE id=p_contract_id AND deleted_at IS NULL AND status IN ('ACTIVE','EXTENDED')) THEN
    RAISE EXCEPTION 'Contract is not eligible for termination' USING ERRCODE='55000';
  END IF;
  SELECT termination_id INTO v_term_id FROM app_private.termination_write_capabilities
  WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid()
    AND contract_id=p_contract_id AND organization_id=v_org AND actor_id=auth.uid()
    AND action='MOVE_OUT' AND phase=-1 AND intent_hash=md5(jsonb_build_object('contract_id',p_contract_id,'move_out_date',p_move_out_date,'deposit_refund',coalesce(p_deposit_refund,0),'penalty_fee',coalesce(p_penalty_fee,0),'excess_rent',coalesce(p_excess_rent,0),'outstanding_debt',coalesce(p_outstanding_debt,0),'notes',p_notes,'extra_charges',coalesce(p_extra_charges,'[]'::jsonb),'shortfall_mode',coalesce(p_shortfall_mode,'PAID'),'receipt_account_id',p_receipt_account_id,'refund_items',coalesce(p_refund_items,'[]'::jsonb))::text);
  IF v_term_id IS NULL THEN
    v_term_id:=gen_random_uuid();
    PERFORM app_private.open_termination_write_v2(v_term_id,p_contract_id,v_org,'MOVE_OUT',md5(jsonb_build_object('contract_id',p_contract_id,'move_out_date',p_move_out_date,'deposit_refund',coalesce(p_deposit_refund,0),'penalty_fee',coalesce(p_penalty_fee,0),'excess_rent',coalesce(p_excess_rent,0),'outstanding_debt',coalesce(p_outstanding_debt,0),'notes',p_notes,'extra_charges',coalesce(p_extra_charges,'[]'::jsonb),'shortfall_mode',coalesce(p_shortfall_mode,'PAID'),'receipt_account_id',p_receipt_account_id,'refund_items',coalesce(p_refund_items,'[]'::jsonb))::text),NULL,NULL);
    v_opened_term:=true;
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_core_writer;

  IF NOT v_core_writer THEN
    PERFORM app_private.assert_contract_has_no_customer_credit_v1(
      p_contract_id, v_org
    );
    PERFORM app_private.begin_accounting_chain_write_v1();
    v_opened_writer := true;
  END IF;

  INSERT INTO app_private.termination_move_out_writer_context (
    transaction_id, backend_pid, organization_id, user_id,
    contract_id, building_id, room_id, move_out_date, opened_at
  ) VALUES (
    txid_current(), pg_backend_pid(), v_org, v_owner,
    p_contract_id, v_building, v_room, p_move_out_date, clock_timestamp()
  ) ON CONFLICT (transaction_id, backend_pid) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      user_id = EXCLUDED.user_id,
      contract_id = EXCLUDED.contract_id,
      building_id = EXCLUDED.building_id,
      room_id = EXCLUDED.room_id,
      move_out_date = EXCLUDED.move_out_date,
      opened_at = EXCLUDED.opened_at;

  BEGIN
    v_result := public.terminate_contract_move_out_impl(
      p_contract_id, p_move_out_date, COALESCE(p_deposit_refund, 0),
      COALESCE(p_penalty_fee, 0), COALESCE(p_excess_rent, 0),
      COALESCE(p_outstanding_debt, 0), p_notes,
      COALESCE(p_extra_charges, '[]'::jsonb),
      COALESCE(p_shortfall_mode, 'PAID'), v_receipt_account,
      COALESCE(p_refund_items, '[]'::jsonb)
    );
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM app_private.termination_move_out_writer_context
    WHERE transaction_id = txid_current()
      AND backend_pid = pg_backend_pid();
    IF v_opened_writer THEN
      PERFORM app_private.end_accounting_chain_write_v1();
    END IF;
    RAISE;
  END;

  DELETE FROM app_private.termination_move_out_writer_context
  WHERE transaction_id = txid_current()
    AND backend_pid = pg_backend_pid();

  IF v_opened_writer THEN
    PERFORM app_private.end_accounting_chain_write_v1();
  END IF;
  IF v_opened_term THEN PERFORM app_private.close_termination_write_v2(v_term_id); END IF;
  RETURN v_result;
END;
$function$;
CREATE OR REPLACE FUNCTION public.terminate_contract_move_out_with_credit_v1(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric, p_penalty_fee numeric, p_excess_rent numeric, p_outstanding_debt numeric, p_notes text, p_extra_charges jsonb, p_shortfall_mode text, p_receipt_account_id uuid, p_idempotency_key text, p_refund_items jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_room uuid;
  v_owner uuid;
  v_building uuid;
  v_deposit_paid numeric;
  v_extra numeric := 0;
  v_cash_shortfall numeric := 0;
  v_receipt_account uuid;
  v_cash_authz boolean;

  v_term_id uuid;
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_credit_amount numeric(15,2) := round(COALESCE(p_excess_rent, 0), 2);
  v_org uuid;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_termination jsonb;
  v_credit jsonb;
  v_response jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_excess_rent = 'NaN'::numeric
     OR COALESCE(p_excess_rent, 0) < 0
     OR COALESCE(p_excess_rent, 0) IS DISTINCT FROM round(
       COALESCE(p_excess_rent, 0), 2
     ) THEN
    RAISE EXCEPTION 'Move-out credit amount must be non-negative with at most two decimals'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    contract_row.room_id,
    contract_row.organization_id,
    contract_row.user_id,
    room_row.building_id,
    contract_row.deposit_paid
    INTO v_room, v_org, v_owner, v_building, v_deposit_paid
  FROM public.contracts contract_row
  LEFT JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE OF contract_row;

  IF NOT (
    public.is_super_admin()
    OR (
      v_room IS NOT NULL
      AND public.can_do_on_building(
        'contracts', 'edit',
        (SELECT room_row.building_id
         FROM public.rooms room_row
         WHERE room_row.id = v_room)
      )
    )
  ) THEN
    RAISE EXCEPTION 'Missing permission to terminate contract'
      USING ERRCODE = '42501';
  END IF;

  IF p_receipt_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.accounts account_row
    WHERE account_row.id = p_receipt_account_id
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
  ) THEN
    RAISE EXCEPTION 'Receipt account is outside the contract organization or is not a real active cashbook'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(sum((entry->>'amount')::numeric), 0)
      INTO v_extra
    FROM jsonb_array_elements(COALESCE(p_extra_charges, '[]'::jsonb)) item(entry)
    WHERE NULLIF(entry->>'amount', '') IS NOT NULL
      AND (entry->>'amount')::numeric > 0;
  END IF;

  v_cash_shortfall := GREATEST(
    COALESCE(p_outstanding_debt, 0)
      + COALESCE(p_penalty_fee, 0)
      + v_extra
      - LEAST(
          GREATEST(COALESCE(p_deposit_refund, 0), 0),
          COALESCE(v_deposit_paid, 0)
        )
      - GREATEST(COALESCE(p_excess_rent, 0), 0)
      - COALESCE((
          SELECT SUM((entry->>'amount')::numeric)
          FROM jsonb_array_elements(COALESCE(p_refund_items, '[]'::jsonb)) item(entry)
          WHERE jsonb_typeof(COALESCE(p_refund_items, '[]'::jsonb)) = 'array'
            AND NULLIF(entry->>'amount', '') IS NOT NULL
            AND (entry->>'amount')::numeric > 0
        ), 0),
    0
  );

  IF upper(COALESCE(p_shortfall_mode, 'PAID')) = 'PAID'
     AND v_cash_shortfall > 0 THEN
    v_receipt_account := COALESCE(
      p_receipt_account_id,
      public._collector_thu_account(auth.uid()),
      public._termination_pick_account(v_owner, v_building)
    );

    IF v_receipt_account IS NULL THEN
      RAISE EXCEPTION 'Cannot resolve an active real receipt account in the contract organization'
        USING ERRCODE = '42501';
    END IF;
    PERFORM 1
    FROM public.accounts account_row
    WHERE account_row.id = v_receipt_account
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cannot resolve an active real receipt account in the contract organization'
        USING ERRCODE = '42501';
    END IF;

    PERFORM app_private.lock_org_for_decision_v1(v_org);
    SELECT decision.allowed
      INTO v_cash_authz
    FROM app_private.authorize_tenant_action_v3(
      auth.uid(), v_org, 'thu_tien.collect', v_building, v_receipt_account
    ) decision;
    IF NOT COALESCE(v_cash_authz, false) THEN
      RAISE EXCEPTION 'Missing receipt permission or cashbook possession for termination collection'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    v_receipt_account := p_receipt_account_id;
  END IF;

  IF v_org IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id JOIN public.buildings b ON b.id=r.building_id
    WHERE c.id=p_contract_id AND c.organization_id=v_org AND r.organization_id=v_org AND b.organization_id=v_org
  ) THEN RAISE EXCEPTION 'Contract organization linkage mismatch' USING ERRCODE='42501'; END IF;
  v_hash := md5(jsonb_build_object(
    'contract_id', p_contract_id,
    'move_out_date', p_move_out_date,
    'deposit_refund', p_deposit_refund,
    'penalty_fee', p_penalty_fee,
    'excess_rent', p_excess_rent,
    'outstanding_debt', p_outstanding_debt,
    'notes', p_notes,
    'extra_charges', COALESCE(p_extra_charges, '[]'::jsonb),
    'shortfall_mode', p_shortfall_mode,
    'receipt_account_id', p_receipt_account_id,
    'refund_items', COALESCE(p_refund_items, '[]'::jsonb)
  )::text);
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id,
    idempotency_key, payload_hash
  ) VALUES (
    v_org, 'contract.terminate.move_out.credit.v1', p_contract_id::text,
    v_actor, v_key, v_hash
  ) ON CONFLICT (
    organization_id, operation, subject_scope, actor_id, idempotency_key
  ) DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'contract.terminate.move_out.credit.v1'
    AND operation_row.subject_scope = p_contract_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;
  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key was reused with a different payload'
      USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  IF EXISTS (SELECT 1 FROM public.contracts WHERE id=p_contract_id AND status IN ('TERMINATED','EXPIRED')) THEN
    RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.contracts WHERE id=p_contract_id AND deleted_at IS NULL AND status IN ('ACTIVE','EXTENDED')) THEN
    RAISE EXCEPTION 'Contract is not eligible for termination' USING ERRCODE='55000';
  END IF;
  v_term_id:=gen_random_uuid();
  PERFORM app_private.open_termination_write_v2(v_term_id,p_contract_id,v_org,'MOVE_OUT',v_hash,NULL,NULL,'contract.terminate.move_out.credit.v1',v_key,md5(jsonb_build_object('contract_id',p_contract_id,'move_out_date',p_move_out_date,'deposit_refund',coalesce(p_deposit_refund,0),'penalty_fee',coalesce(p_penalty_fee,0),'excess_rent',coalesce(p_excess_rent,0),'outstanding_debt',coalesce(p_outstanding_debt,0),'notes',p_notes,'extra_charges',coalesce(p_extra_charges,'[]'::jsonb),'shortfall_mode',coalesce(p_shortfall_mode,'PAID'),'receipt_account_id',p_receipt_account_id,'refund_items',coalesce(p_refund_items,'[]'::jsonb))::text));
  -- [A2] Tính năng áp credit chưa bật ⇒ CHẶN SỚM, trước khi ghi bất cứ thứ gì.
  -- Không sao chép nhánh deferred của forfeit sang đây: terminate_contract_move_out
  -- đã TIÊU credit trên trục tiền (cấn nợ CT + phiếu hoàn) NGAY trong lệnh dưới,
  -- nên hoãn burn-down = chi HAI LẦN. Chặn trước là cách duy nhất đúng.
  IF v_credit_amount > 0
     AND app_private.evaluate_feature_route('customer.credit.apply.v1', v_org)
         IS DISTINCT FROM 'CANONICAL' THEN
    RAISE EXCEPTION 'Tính năng áp tiền trả dư (credit) vào quyết toán chưa được kích hoạt, nên không thể thanh lý kèm % đ tiền thừa. Hãy để ô "Tiền phòng thừa" bằng 0 rồi thanh lý; khoản dư giữ nguyên trên sổ và xử lý riêng.',
      round(v_credit_amount)::bigint
      USING ERRCODE = '55000';
  END IF;
  PERFORM app_private.begin_accounting_chain_write_v1();
  v_termination := public.terminate_contract_move_out(
    p_contract_id, p_move_out_date, COALESCE(p_deposit_refund, 0),
    COALESCE(p_penalty_fee, 0), COALESCE(p_excess_rent, 0),
    COALESCE(p_outstanding_debt, 0), p_notes,
    COALESCE(p_extra_charges, '[]'::jsonb),
    COALESCE(p_shortfall_mode, 'PAID'), p_receipt_account_id,
    COALESCE(p_refund_items, '[]'::jsonb)
  );
  PERFORM app_private.end_accounting_chain_write_v1();

  IF v_credit_amount > 0 THEN
    v_credit := app_private.apply_customer_credit_fifo_v1(
      v_actor, p_contract_id, v_credit_amount, NULL, 'MOVE_OUT',
      'Apply customer credit during move-out settlement', v_key
    );
  ELSE
    v_credit := jsonb_build_object(
      'contract_id', p_contract_id,
      'application_kind', 'MOVE_OUT',
      'applied_amount', 0,
      'applications', '[]'::jsonb
    );
  END IF;

  v_response := jsonb_build_object(
    'termination', v_termination,
    'credit', v_credit
  );
  PERFORM app_private.close_termination_write_v2(v_term_id);
  UPDATE app_private.canonical_write_operations
     SET subject_id = p_contract_id,
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_org
     AND operation = 'contract.terminate.move_out.credit.v1'
     AND subject_scope = p_contract_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;
  RETURN v_response;
END;
$function$;
CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit_impl(p_contract_id uuid, p_forfeit_date date, p_extra_charges jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_audit public.contract_terminations%rowtype;
  v_term_id uuid;
  v_contract       RECORD;
  v_building_id    uuid;
  v_invoice_id     uuid;
  v_extra_inv      uuid;
  v_extra          numeric(15,2) := 0;
  v_deposit        numeric(15,2);
  v_billing        text;
  v_cnumber        text;
  v_marker         text;
  v_acc_int        uuid;
  v_type_off       uuid;
  v_type_inc       uuid;
  v_chi_id         uuid;
  v_thu_id         uuid;
  v_kept_paid      numeric(15,2);
  v_paid_cnt       integer;
  v_unpaid_cnt     integer;
  v_cancelled_cnt  integer;
BEGIN
  SELECT * INTO v_contract
    FROM contracts
   WHERE id = p_contract_id
     AND deleted_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;
  SELECT termination_id INTO STRICT v_term_id FROM app_private.termination_write_capabilities
  WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid()
    AND actor_id=auth.uid() AND organization_id=v_contract.organization_id
    AND contract_id=p_contract_id AND action='FORFEIT' AND phase=-1;
  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN
    RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn';
  END IF;
  IF v_contract.room_id IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý';
  END IF;
  IF p_forfeit_date < v_contract.start_date THEN
    RAISE EXCEPTION 'Ngày bỏ cọc (%) không được trước ngày bắt đầu hợp đồng (%)',
      to_char(p_forfeit_date,'DD/MM/YYYY'), to_char(v_contract.start_date,'DD/MM/YYYY');
  END IF;
  SELECT building_id INTO v_building_id FROM rooms WHERE id = v_contract.room_id;
  IF v_building_id IS NULL THEN
    RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng';
  END IF;

  -- Cọc forfeit = cọc THỰC đã thu (nguồn sự thật: contracts.deposit_paid).
  -- [A9] Cọc đã thu > cọc theo hợp đồng ⇒ DỪNG, không đoán.
  -- Công thức LEAST() bên dưới lấy số NHỎ hơn, nên khi ô "Tiền cọc" trên hợp
  -- đồng khai 0 mà thực đã thu (vd HĐT-062953: 0 / 4.000.000) thì v_deposit = 0
  -- và TOÀN BỘ khối doanh thu bị bỏ qua trong im lặng: không hoá đơn, không
  -- phiếu, 0đ doanh thu trên tiền đang giữ trong két.
  --
  -- KHÔNG sửa thành COALESCE(deposit_paid,0): đo được 3/4 hợp đồng dôi ra là do
  -- phiếu "[Accounting repair] Contract deposit" ĐẾM TRÙNG với phiếu thu cọc
  -- tường minh (2.000.000 + 1.500.000 + 300.000 = 3.800.000đ). Lấy thẳng
  -- deposit_paid sẽ ghi KHỐNG đúng số đó vào KQKD rồi chảy sang chia lợi nhuận.
  IF COALESCE(v_contract.deposit_paid, 0) > COALESCE(v_contract.total_deposit, 0) THEN
    RAISE EXCEPTION 'Không thanh lý được: cọc ĐÃ THU (% đ) lớn hơn cọc THEO HỢP ĐỒNG (% đ), dôi % đ. Hệ thống không tự đoán số nào đúng. Hãy kiểm tra sổ cọc của hợp đồng: nếu có phiếu cọc bị ĐẾM TRÙNG thì huỷ/điều chỉnh phiếu đó; nếu ô "Tiền cọc" trên hợp đồng khai thiếu thì sửa lại cho khớp số THỰC NHẬN. Đừng nâng "Tiền cọc" chỉ để chạy được lệnh — làm vậy sẽ ghi khống phần dôi thành doanh thu.',
      round(COALESCE(v_contract.deposit_paid, 0))::bigint,
      round(COALESCE(v_contract.total_deposit, 0))::bigint,
      round(COALESCE(v_contract.deposit_paid,0) - COALESCE(v_contract.total_deposit,0))::bigint
      USING ERRCODE = '55000';
  END IF;
  v_deposit := LEAST(COALESCE(v_contract.total_deposit, 0), COALESCE(v_contract.deposit_paid, 0));
  v_billing := to_char(COALESCE(p_forfeit_date, public.org_today_v1(NULL)), 'YYYY-MM');
  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_marker  := '[CẤN CỌC BỎ CỌC ' || p_contract_id::text || ']';

  v_acc_int := public._internal_settlement_account(v_contract.user_id);

  SELECT COALESCE(SUM(paid_amount), 0)
    INTO v_kept_paid
    FROM invoices
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN ('APPROVED','OVERDUE','PARTIAL_PAID')
     AND COALESCE(paid_amount, 0) > 0;

  UPDATE invoices
     SET status       = 'CANCELLED',
         total_amount = COALESCE(paid_amount, 0),
         notes        = CASE
                        WHEN notes IS NULL OR length(btrim(notes)) = 0
                          THEN '[Huỷ — thanh lý bỏ cọc ngày '
                               || to_char(p_forfeit_date,'DD/MM/YYYY')
                               || '; giữ lại ' || round(COALESCE(paid_amount,0))::bigint
                               || 'đ đã thu làm doanh thu, huỷ phần nợ '
                               || round(COALESCE(remaining_amount,0))::bigint || 'đ]'
                        ELSE notes
                             || E'\n[Huỷ — thanh lý bỏ cọc ngày '
                             || to_char(p_forfeit_date,'DD/MM/YYYY')
                             || '; giữ lại ' || round(COALESCE(paid_amount,0))::bigint
                             || 'đ đã thu làm doanh thu, huỷ phần nợ '
                             || round(COALESCE(remaining_amount,0))::bigint || 'đ]'
                      END,
         updated_at = NOW()
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN ('APPROVED','OVERDUE','PARTIAL_PAID')
     AND COALESCE(paid_amount, 0) > 0;
  GET DIAGNOSTICS v_paid_cnt = ROW_COUNT;

  UPDATE invoices
     SET status       = 'CANCELLED',
         total_amount = 0,
         notes        = CASE
                        WHEN notes IS NULL OR length(btrim(notes)) = 0
                          THEN '[Huỷ tự động — thanh lý bỏ cọc ngày '
                               || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                        ELSE notes
                             || E'\n[Huỷ tự động — thanh lý bỏ cọc ngày '
                             || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                      END,
         updated_at   = NOW()
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN ('APPROVED','OVERDUE','PARTIAL_PAID')
     AND COALESCE(paid_amount, 0) = 0;
  GET DIAGNOSTICS v_unpaid_cnt = ROW_COUNT;

  v_cancelled_cnt := COALESCE(v_paid_cnt, 0) + COALESCE(v_unpaid_cnt, 0);

  IF v_deposit > 0 THEN
    -- v4: hoá đơn bù cọc mang ĐÚNG kỳ tháng bỏ cọc (kind='SETTLEMENT' —
    -- partial unique không còn chặn; thôi mượn slot tháng trống).
    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id,
      kind, billing_month, issue_date, due_date,
      status, subtotal, discount_amount, total_amount,
      notes
    ) VALUES (
      v_contract.user_id, p_contract_id,
      v_building_id, v_contract.room_id,
      'SETTLEMENT', v_billing, p_forfeit_date, p_forfeit_date,
      'APPROVED'::invoice_status, v_deposit, 0, v_deposit,
      'Hoá đơn thanh lý — khách bỏ cọc ngày ' || to_char(p_forfeit_date,'DD/MM/YYYY')
        || CASE WHEN v_cancelled_cnt > 0
                  THEN E'\n(Đã huỷ ' || v_cancelled_cnt || ' hoá đơn còn nợ'
                       || CASE WHEN v_kept_paid > 0
                                 THEN '; giữ lại ' || round(v_kept_paid)::bigint
                                      || 'đ đã thu làm doanh thu'
                                 ELSE '' END
                       || ')'
                  ELSE '' END
    )
    RETURNING id INTO v_invoice_id;

    INSERT INTO invoice_items (
      invoice_id, type, description,
      unit_price, quantity, coefficient, amount, sort_order
    ) VALUES (
      v_invoice_id, 'PENALTY',
      'Phí phạt khách bỏ cọc (giữ tiền cọc đã thu)',
      v_deposit, 1, 1, v_deposit, 1
    );

    -- Cặp bút toán nội bộ TỰ DUYỆT — CẢ 2 CHÂN trên sổ nội bộ (net 0).
    v_type_off := public._termination_ensure_type(v_contract.user_id, 'expense', 'Cấn cọc chuyển doanh thu');
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu bỏ cọc');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', 'Cấn cọc bỏ cọc → chuyển doanh thu — HĐ ' || v_cnumber,
            v_building_id, v_contract.room_id, p_contract_id, v_acc_int, p_forfeit_date, v_deposit, 'UNAPPROVED',
            v_marker || ' Bút toán nội bộ: cọc khách bỏ chuyển thành doanh thu (tự duyệt; không phải tiền thật — không vào sổ quỹ).',
            'termination.forfeit_offset')
    RETURNING id INTO v_chi_id;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_chi_id, v_type_off, 'Cấn cọc bỏ cọc chuyển doanh thu', 1, v_deposit, p_forfeit_date, p_forfeit_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'INCOME', 'Doanh thu bỏ cọc — HĐ ' || v_cnumber,
            v_building_id, v_contract.room_id, p_contract_id, v_acc_int, v_invoice_id, p_forfeit_date, v_deposit, 'UNAPPROVED',
            v_marker || ' Bút toán nội bộ: doanh thu bỏ cọc (tự duyệt → tất toán hoá đơn thanh lý; KQKD đếm theo hạng mục).',
            'termination.forfeit_revenue')
    RETURNING id INTO v_thu_id;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_thu_id, v_type_inc, 'Doanh thu bỏ cọc (cọc khách bỏ)', 1, v_deposit, p_forfeit_date, p_forfeit_date);

    -- 7af: cặp bút toán nội bộ TỰ DUYỆT ngay trong writer (hướng A).
    -- Đóng dấu bản chất trước — Finance V2 hết coi đây là phiếu tiền thật.
    -- 7b1: review_state đi CÙNG cú duyệt, KHÔNG đi trước. Ở nhịp này cả 2
    -- chân còn UNAPPROVED, mà ie_unapproved_review_state_ck cấm cặp
    -- (UNAPPROVED, RESOLVED) — đặt ở đây là 23514, chặn cứng thanh lý.
    UPDATE public.income_expenses
       SET posting_mode   = 'NON_CASH',
           posting_status = 'NOT_APPLICABLE'
     WHERE id IN (v_chi_id, v_thu_id);

    -- Token cho CẢ HAI chân: chân doanh thu do lệnh dưới đổi, chân đối ứng do
    -- cascade trg_forfeit_settle_on_approve đổi — guard a05 đòi token từng phiếu.
    INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
    VALUES (v_thu_id, pg_current_xact_id(), 'APPROVED'),
           (v_chi_id, pg_current_xact_id(), 'APPROVED');

    -- Duyệt chân doanh thu → cascade duyệt chân đối ứng + tất toán hoá đơn.
    UPDATE public.income_expenses
       SET approval_status = 'APPROVED',
           approved_by     = COALESCE(auth.uid(), v_contract.user_id),
           approved_at     = now(),
           review_state    = 'RESOLVED',
           review_version  = income_expenses.review_version + 1
     WHERE id = v_thu_id;

    DELETE FROM app_private.ie_transition_authorization
     WHERE income_expense_id IN (v_thu_id, v_chi_id)
       AND xid = pg_current_xact_id();
  END IF;

  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(SUM((j->>'amount')::numeric), 0) INTO v_extra
      FROM jsonb_array_elements(p_extra_charges) AS t(j)
     WHERE (j->>'amount') IS NOT NULL AND (j->>'amount') <> ''
       AND (j->>'amount')::numeric > 0;
  END IF;

  IF v_extra > 0 THEN
    -- v4: hoá đơn thu thêm cũng mang ĐÚNG kỳ tháng bỏ cọc, kind='SETTLEMENT'.
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, kind, billing_month, issue_date, due_date, status, subtotal, discount_amount, total_amount, notes)
    VALUES (v_contract.user_id, p_contract_id, v_building_id, v_contract.room_id, 'SETTLEMENT', v_billing, p_forfeit_date, p_forfeit_date,
            'APPROVED'::invoice_status, 0, 0, 0,
            'Hoá đơn thu thêm khi thanh lý — khách bỏ cọc ngày ' || to_char(p_forfeit_date,'DD/MM/YYYY')
              || ' (thu riêng — không liên quan hoá đơn bù cọc).')
    RETURNING id INTO v_extra_inv;
    PERFORM public._termination_apply_extra_charges(v_extra_inv, p_extra_charges, p_forfeit_date, v_contract.user_id, p_contract_id);
    PERFORM public.recompute_invoice_for_id(v_extra_inv);
  END IF;

  UPDATE contracts
     SET status          = 'TERMINATED',
         actual_end_date = p_forfeit_date,
         notes           = CASE
                             WHEN notes IS NULL OR length(btrim(notes)) = 0
                               THEN '[Thanh lý — khách bỏ cọc ' || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                             ELSE notes || E'\n[Thanh lý — khách bỏ cọc ' || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                           END,
         updated_at      = NOW()
   WHERE id = p_contract_id;

      v_audit.id:=gen_random_uuid();
  v_audit.user_id:=NULL;
  v_audit.contract_id:=NULL;
  v_audit.termination_date:=CURRENT_DATE;
  v_audit.actual_move_out_date:=NULL;
  v_audit.notice_date:=NULL;
  v_audit.termination_type:=NULL;
  v_audit.outstanding_debt:=0;
  v_audit.prorated_days:=0;
  v_audit.prorated_rent:=0;
  v_audit.prorated_services:=0;
  v_audit.early_termination_fee:=0;
  v_audit.notice_violation_fee:=0;
  v_audit.damage_fee:=0;
  v_audit.damage_description:=NULL;
  v_audit.damage_images:='[]'::jsonb;
  v_audit.cleaning_fee:=0;
  v_audit.other_fees:=0;
  v_audit.other_fees_description:=NULL;
  v_audit.total_deposit:=NULL;
  v_audit.refund_method:=NULL;
  v_audit.refund_date:=NULL;
  v_audit.refund_receipt_url:=NULL;
  v_audit.status:='DRAFT'::text;
  v_audit.approved_by:=NULL;
  v_audit.approved_at:=NULL;
  v_audit.notes:=NULL;
  v_audit.internal_notes:=NULL;
  v_audit.created_at:=now();
  v_audit.updated_at:=now();
  v_audit.organization_id:=NULL;
  v_audit.rent_refund_amount:=0;
  v_audit.id:=v_term_id;
  v_audit.organization_id:=v_contract.organization_id;
  v_audit.user_id:=v_contract.user_id;
  v_audit.contract_id:=p_contract_id;
  v_audit.termination_date:=p_forfeit_date;
  v_audit.actual_move_out_date:=p_forfeit_date;
  v_audit.termination_type:='FORFEIT';
  v_audit.outstanding_debt:=0;
  v_audit.early_termination_fee:=v_deposit;
  v_audit.prorated_rent:=0;
  v_audit.prorated_days:=0;
  v_audit.prorated_services:=0;
  v_audit.total_deposit:=v_deposit;
  v_audit.status:='COMPLETED';
  v_audit.approved_by:=auth.uid();
  v_audit.approved_at:=NOW();
  v_audit.notes:='Khách bỏ cọc — đã tạo phiếu thu "Doanh thu bỏ cọc" (chờ duyệt) cho phần cọc thực thu ' || round(v_deposit)::bigint || 'đ.'
        || CASE WHEN v_kept_paid > 0
                  THEN ' Đã giữ lại ' || round(v_kept_paid)::bigint
                       || 'đ đã thu làm doanh thu.'
                  ELSE '' END
        || CASE WHEN v_extra > 0
                  THEN ' Hoá đơn thu thêm riêng ' || round(v_extra)::bigint || 'đ (chờ thu).'
                  ELSE '' END;
  UPDATE app_private.termination_write_capabilities SET expected_after=to_jsonb(v_audit)-ARRAY['refund_amount','total_deductions'],phase=0
  WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid() AND termination_id=v_term_id
    AND actor_id=auth.uid() AND phase=-1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing audit insert proof' USING ERRCODE='42501'; END IF;
  INSERT INTO public.contract_terminations (id,user_id,contract_id,termination_date,actual_move_out_date,notice_date,termination_type,outstanding_debt,prorated_days,prorated_rent,prorated_services,early_termination_fee,notice_violation_fee,damage_fee,damage_description,damage_images,cleaning_fee,other_fees,other_fees_description,total_deposit,refund_method,refund_date,refund_receipt_url,status,approved_by,approved_at,notes,internal_notes,created_at,updated_at,organization_id,rent_refund_amount) VALUES (v_audit.id,v_audit.user_id,v_audit.contract_id,v_audit.termination_date,v_audit.actual_move_out_date,v_audit.notice_date,v_audit.termination_type,v_audit.outstanding_debt,v_audit.prorated_days,v_audit.prorated_rent,v_audit.prorated_services,v_audit.early_termination_fee,v_audit.notice_violation_fee,v_audit.damage_fee,v_audit.damage_description,v_audit.damage_images,v_audit.cleaning_fee,v_audit.other_fees,v_audit.other_fees_description,v_audit.total_deposit,v_audit.refund_method,v_audit.refund_date,v_audit.refund_receipt_url,v_audit.status,v_audit.approved_by,v_audit.approved_at,v_audit.notes,v_audit.internal_notes,v_audit.created_at,v_audit.updated_at,v_audit.organization_id,v_audit.rent_refund_amount);

  RETURN jsonb_build_object(
    'contract_id',                p_contract_id,
    'invoice_id',                 v_invoice_id,
    'settlement_invoice_id',      v_invoice_id,
    'extra_invoice_id',           v_extra_inv,
    'extra_charges_total',        v_extra,
    'forfeit_amount',             v_deposit,
    'cancelled_invoices',         v_cancelled_cnt,
    'kept_paid_amount',           v_kept_paid,
    'pending_income_voucher_id',  v_thu_id,
    'pending_expense_voucher_id', v_chi_id,
    'acc_internal',               v_acc_int
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.terminate_contract_move_out_impl(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric DEFAULT 0, p_penalty_fee numeric DEFAULT 0, p_excess_rent numeric DEFAULT 0, p_outstanding_debt numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_extra_charges jsonb DEFAULT '[]'::jsonb, p_shortfall_mode text DEFAULT 'PAID'::text, p_receipt_account_id uuid DEFAULT NULL::uuid, p_refund_items jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_audit public.contract_terminations%rowtype;
  v_term_id uuid;
  v_contract  RECORD;
  v_building  uuid;
  v_acc_op    uuid;   -- sổ vận hành (fallback nhận tiền thật)
  v_acc_int   uuid;   -- sổ bút toán nội bộ (cả 2 chân cấn cọc)
  v_acc_rcpt  uuid;   -- sổ NHẬN "khách trả thêm" (tiền thật)
  v_billing   text;
  v_cnumber   text;
  v_deposit   numeric(15,2);
  v_penalty   numeric(15,2) := COALESCE(p_penalty_fee,    0);
  v_excess    numeric(15,2) := COALESCE(p_excess_rent,    0);
  v_debt      numeric(15,2) := COALESCE(p_outstanding_debt, 0);
  v_extra     numeric(15,2) := 0;
  v_owed      numeric(15,2) := 0;   -- tổng "Hoàn lại khách" (mình nợ khách)
  v_charges_left numeric(15,2);
  v_owed_applied numeric(15,2);
  v_refund_owed  numeric(15,2);
  v_type_rentref uuid;
  v_charges   numeric(15,2);
  v_pool      numeric(15,2);
  v_applied   numeric(15,2);
  v_applied_dep numeric(15,2);
  v_refund_dep  numeric(15,2);
  v_refund_exc  numeric(15,2);
  v_S         numeric(15,2);
  v_budget    numeric(15,2);
  v_pay       numeric(15,2);
  v_settle_inv uuid;
  v_next_sort integer;
  v_type_inc  uuid;
  v_type_off  uuid;
  v_type_dep  uuid;
  v_type_excr uuid;
  v_voucher   uuid;
  v_refund_voucher uuid;
  v_breakdown text;
  rec         RECORD;
BEGIN
  IF p_shortfall_mode NOT IN ('PAID', 'DEBT') THEN
    RAISE EXCEPTION 'p_shortfall_mode phải là PAID hoặc DEBT';
  END IF;

  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hợp đồng không tồn tại'; END IF;
  SELECT termination_id INTO STRICT v_term_id FROM app_private.termination_write_capabilities
  WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid()
    AND actor_id=auth.uid() AND organization_id=v_contract.organization_id
    AND contract_id=p_contract_id AND action='MOVE_OUT' AND phase=-1;
  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn'; END IF;
  IF v_contract.room_id IS NULL THEN RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý'; END IF;
  IF p_move_out_date < v_contract.start_date THEN
    RAISE EXCEPTION 'Ngày chuyển đi (%) không được trước ngày bắt đầu hợp đồng (%)',
      to_char(p_move_out_date,'DD/MM/YYYY'), to_char(v_contract.start_date,'DD/MM/YYYY');
  END IF;
  SELECT building_id INTO v_building FROM rooms WHERE id = v_contract.room_id;
  IF v_building IS NULL THEN RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng'; END IF;

  v_billing := to_char(COALESCE(p_move_out_date, public.org_today_v1(NULL)), 'YYYY-MM');
  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_acc_op  := public._termination_pick_account(v_contract.user_id, v_building);
  v_acc_int := public._internal_settlement_account(v_contract.user_id);

  -- Sổ NHẬN "khách trả thêm" (tiền thật): form chọn > sổ %Thu của người bấm > sổ vận hành toà.
  v_acc_rcpt := COALESCE(p_receipt_account_id, public._collector_thu_account(auth.uid()), v_acc_op);
  IF p_receipt_account_id IS NOT NULL THEN
    PERFORM 1 FROM accounts a WHERE a.id = p_receipt_account_id AND a.deleted_at IS NULL AND a.is_virtual = false;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ nhận tiền không hợp lệ (không tồn tại hoặc là sổ ảo)';
    END IF;
  END IF;

  -- A1: hoàn/cấn cọc tối đa bằng cọc THỰC THU (deposit_paid).
  v_deposit := LEAST(GREATEST(COALESCE(p_deposit_refund, 0), 0), COALESCE(v_contract.deposit_paid, 0));

  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(SUM((j->>'amount')::numeric), 0) INTO v_extra
      FROM jsonb_array_elements(p_extra_charges) AS t(j)
     WHERE (j->>'amount') IS NOT NULL AND (j->>'amount') <> ''
       AND (j->>'amount')::numeric > 0;
  END IF;

  IF jsonb_typeof(COALESCE(p_refund_items, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(SUM((j->>'amount')::numeric), 0) INTO v_owed
      FROM jsonb_array_elements(p_refund_items) AS t(j)
     WHERE (j->>'amount') IS NOT NULL AND (j->>'amount') <> ''
       AND (j->>'amount')::numeric > 0;
  END IF;

  v_charges     := v_debt + v_penalty + v_extra;
  v_pool        := v_deposit + v_excess;
  v_applied     := LEAST(v_pool + v_owed, v_charges);
  v_applied_dep := LEAST(v_deposit, v_charges);
  v_refund_dep  := v_deposit - v_applied_dep;
  v_refund_exc  := v_excess - LEAST(v_excess, GREATEST(v_charges - v_deposit, 0));
  -- "Hoàn lại khách" CHỈ được cấn vào phần công nợ CÒN LẠI sau khi cọc và credit
  -- đã cấn xong. Cấn sớm hơn sẽ làm v_refund_dep xê dịch — mà con số đó phải
  -- khớp cột GENERATED contract_terminations.refund_amount, nền của cảnh báo
  -- VUOT_COC_THAT trong nghĩa vụ hoàn cọc (preview_termination_refund_v1).
  v_charges_left := GREATEST(v_charges - v_deposit - v_excess, 0);
  v_owed_applied := LEAST(v_owed, v_charges_left);
  v_refund_owed  := v_owed - v_owed_applied;
  v_S           := v_pool + v_owed - v_charges;

  v_breakdown :=
       'QUYẾT TOÁN THANH LÝ ' || to_char(p_move_out_date,'DD/MM/YYYY') || ' — HĐ ' || v_cnumber
    || E'\n• Cọc đã thu: ' || to_char(v_deposit, 'FM999G999G999G990') || 'đ'
    || E'\n• Khấu trừ: công nợ ' || to_char(v_debt, 'FM999G999G999G990') || 'đ'
    || CASE WHEN v_penalty > 0 THEN ' + phí phạt ' || to_char(v_penalty, 'FM999G999G999G990') || 'đ' ELSE '' END
    || CASE WHEN v_extra   > 0 THEN ' + thu thêm ' || to_char(v_extra, 'FM999G999G999G990') || 'đ' ELSE '' END
    || ' = ' || to_char(v_charges, 'FM999G999G999G990') || 'đ'
    || E'\n• Cọc cấn vào khấu trừ: ' || to_char(v_applied_dep, 'FM999G999G999G990') || 'đ (bút toán nội bộ, không đụng sổ tiền thật)'
    || CASE WHEN v_excess > 0 THEN E'\n• Tiền thừa (credit) áp dụng: ' || to_char(v_excess, 'FM999G999G999G990') || 'đ (cấn ' || to_char(v_excess - v_refund_exc, 'FM999G999G999G990') || 'đ, hoàn ' || to_char(v_refund_exc, 'FM999G999G999G990') || 'đ)' ELSE '' END
    || CASE WHEN v_owed > 0 THEN E'\n• Hoàn lại khách (tiền phòng ngày không ở…): ' || to_char(v_owed, 'FM999G999G999G990') || 'đ (cấn ' || to_char(v_owed_applied, 'FM999G999G999G990') || 'đ, chi ' || to_char(v_refund_owed, 'FM999G999G999G990') || 'đ)' ELSE '' END
    || E'\n• Hoàn cọc lại khách: ' || to_char(v_refund_dep, 'FM999G999G999G990') || 'đ'
    || CASE WHEN v_S < 0 THEN E'\n• Khách còn phải trả: ' || to_char(-v_S, 'FM999G999G999G990') || 'đ ('
         || CASE WHEN p_shortfall_mode = 'PAID' THEN 'đã thu ngay khi thanh lý' ELSE 'GHI NỢ — chờ thu' END || ')'
       ELSE '' END
    || CASE WHEN v_refund_dep + v_refund_exc + v_refund_owed > 0 THEN E'\n• Tổng chi hoàn khách: ' || to_char(v_refund_dep + v_refund_exc + v_refund_owed, 'FM999G999G999G990') || 'đ (phiếu chi chờ duyệt — chọn sổ quỹ khi duyệt)' ELSE '' END;

  -- 1. HOÁ ĐƠN THANH LÝ RIÊNG (kind='SETTLEMENT', ĐÚNG kỳ tháng trả phòng).
  --    v4: KHÔNG đụng hoá đơn tháng nữa — dù nó chưa/đã PAID. Công nợ của nó
  --    vẫn được gạch ở bước 2 bằng payments 'CT' (không sửa nội dung hoá đơn).
  IF v_penalty > 0 OR v_extra > 0 THEN
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, kind, billing_month, issue_date, due_date, status, subtotal, total_amount, notes)
    VALUES (v_contract.user_id, p_contract_id, v_building, v_contract.room_id, 'SETTLEMENT',
      v_billing, p_move_out_date, p_move_out_date, 'APPROVED'::invoice_status, 0, 0,
      'Hoá đơn thanh lý — khách rời phòng ngày ' || to_char(p_move_out_date,'DD/MM/YYYY') || COALESCE(E'\n' || p_notes, ''))
    RETURNING id INTO v_settle_inv;
  END IF;

  IF v_penalty > 0 THEN
    SELECT COALESCE(MAX(sort_order),0)+1 INTO v_next_sort FROM invoice_items WHERE invoice_id = v_settle_inv;
    INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
    VALUES (v_settle_inv, 'PENALTY', 'Phí phạt thanh lý', v_penalty, 1, 1, v_penalty, v_next_sort);
    UPDATE invoices SET subtotal = COALESCE(subtotal,0)+v_penalty, total_amount = COALESCE(total_amount,0)+v_penalty, updated_at = NOW() WHERE id = v_settle_inv;
  END IF;

  IF v_extra > 0 THEN
    PERFORM public._termination_apply_extra_charges(v_settle_inv, p_extra_charges, p_move_out_date, v_contract.user_id, p_contract_id);
  END IF;

  IF v_settle_inv IS NOT NULL THEN
    UPDATE invoices
       SET notes = COALESCE(notes || E'\n\n', '') || v_breakdown,
           updated_at = NOW()
     WHERE id = v_settle_inv;
  END IF;

  -- 2. Quyết toán hoá đơn còn nợ bằng CẤN TRỪ 'CT' (PAID: gạch hết; DEBT: trong pool).
  v_budget := CASE WHEN p_shortfall_mode = 'DEBT' THEN v_applied ELSE NULL END;
  FOR rec IN
    SELECT id, (total_amount - paid_amount) AS remaining FROM invoices
     WHERE contract_id = p_contract_id AND deleted_at IS NULL AND status <> 'CANCELLED'
       AND (total_amount - paid_amount) > 0
     ORDER BY billing_month, created_at
  LOOP
    v_pay := rec.remaining;
    IF v_budget IS NOT NULL THEN
      EXIT WHEN v_budget <= 0;
      v_pay := LEAST(v_pay, v_budget);
      v_budget := v_budget - v_pay;
    END IF;
    IF v_pay > 0 THEN
      INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes)
      VALUES (v_contract.user_id, rec.id, v_pay, 'CT'::payment_method, p_move_out_date,
              'Quyết toán khi thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY'));
    END IF;
  END LOOP;

  -- 3. CẶP BÚT TOÁN NỘI BỘ (cấn cọc → doanh thu) — CẢ 2 CHÂN trên sổ nội bộ,
  --    net 0/thương vụ; KHÔNG đụng sổ tiền thật (mô hình chốt 04/07).
  IF v_applied_dep > 0 THEN
    v_type_off := public._termination_ensure_type(v_contract.user_id, 'expense', 'Cấn cọc chuyển doanh thu');
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu thanh lý');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', 'Cấn cọc → chuyển doanh thu — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, p_move_out_date, v_applied_dep, 'APPROVED',
      '[CHUYỂN KHOẢN] Bút toán nội bộ: cọc cấn công nợ/phạt (không phải tiền thật).' || E'\n\n' || v_breakdown,
      'termination.offset')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_off, 'Cấn cọc chuyển doanh thu', 1, v_applied_dep, p_move_out_date, p_move_out_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'INCOME', 'Doanh thu thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, v_settle_inv, p_move_out_date, v_applied_dep, 'APPROVED',
      '[CHUYỂN KHOẢN] Bút toán nội bộ: ghi nhận doanh thu thanh lý từ cọc cấn nợ/phạt (KQKD đếm theo hạng mục).',
      'termination.revenue')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Doanh thu thanh lý (cấn cọc)', 1, v_applied_dep, p_move_out_date, p_move_out_date);
  END IF;

  -- 3b. KHOẢN HOÀN BỊ CẤN VÀO CÔNG NỢ — cặp bút toán nội bộ, net 0 trên sổ nội
  --     bộ, KHÔNG đụng sổ tiền thật. Gương của cặp cấn cọc ở bước 3, khác ở chỗ
  --     chân chi mang loại is_deposit=FALSE: tiền phòng đã ghi doanh thu rồi nên
  --     trả lại là GIẢM LÃI THẬT, còn cọc là tiền giữ hộ nên nằm ngoài KQKD.
  IF v_owed_applied > 0 THEN
    v_type_rentref := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn tiền phòng thanh lý');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_rentref AND is_deposit IS DISTINCT FROM FALSE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu thanh lý');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', 'Hoàn tiền phòng cấn công nợ — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, p_move_out_date, v_owed_applied, 'APPROVED',
      '[CHUYỂN KHOẢN] Bút toán nội bộ: khoản hoàn cho khách được cấn vào công nợ còn lại (không phải tiền thật).' || E'\n\n' || v_breakdown,
      'termination.rent_refund_offset')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_rentref, 'Hoàn tiền phòng (cấn công nợ)', 1, v_owed_applied, p_move_out_date, p_move_out_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'INCOME', 'Doanh thu thanh lý (khoản hoàn cấn nợ) — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, v_settle_inv, p_move_out_date, v_owed_applied, 'APPROVED',
      '[CHUYỂN KHOẢN] Bút toán nội bộ: ghi nhận doanh thu từ phần công nợ được khoản hoàn cấn trừ.',
      'termination.rent_refund_revenue')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Doanh thu thanh lý (khoản hoàn cấn nợ)', 1, v_owed_applied, p_move_out_date, p_move_out_date);
  END IF;

  -- 4. HOÀN KHÁCH = TIỀN THẬT: 1 phiếu chi NHÁP, SỔ TRỐNG (chọn khi duyệt).
  IF v_refund_dep > 0 OR v_refund_exc > 0 OR v_refund_owed > 0 THEN
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', COALESCE(app_private.termination_refund_name_v1(p_contract_id, p_move_out_date), 'Trả khách thanh lý — HĐ ' || v_cnumber), v_building, v_contract.room_id, p_contract_id, NULL, p_move_out_date, v_refund_dep + v_refund_exc + v_refund_owed, 'UNAPPROVED',
      '[HOÀN KHÁCH THANH LÝ] Phiếu chi hoàn khách (tiền thật). CHỌN SỔ QUỸ chi tiền (Sửa phiếu) rồi mới duyệt được.' || E'\n\n' || v_breakdown || COALESCE(E'\n' || p_notes, ''),
      'termination.refund')
    RETURNING id INTO v_refund_voucher;

    IF v_refund_dep > 0 THEN
      v_type_dep := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn cọc thanh lý');
      UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type_dep AND is_deposit IS DISTINCT FROM TRUE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_dep, 'Trả lại khách (cọc sau khấu trừ)', 1, v_refund_dep, p_move_out_date, p_move_out_date);
    END IF;

    IF v_refund_exc > 0 THEN
      v_type_excr := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn tiền thừa thanh lý');
      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_excr AND is_deposit IS DISTINCT FROM FALSE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_excr, 'Hoàn tiền thừa khi thanh lý', 1, v_refund_exc, p_move_out_date, p_move_out_date);
    END IF;

    IF v_refund_owed > 0 THEN
      v_type_rentref := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn tiền phòng thanh lý');
      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_rentref AND is_deposit IS DISTINCT FROM FALSE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_rentref, 'Hoàn tiền phòng ngày khách không ở', 1, v_refund_owed, p_move_out_date, p_move_out_date);
    END IF;
  END IF;

  -- 4c. Khách trả thêm (TIỀN THẬT) — chế độ PAID: vào SỔ NHẬN đã chọn.
  IF v_S < 0 AND p_shortfall_mode = 'PAID' THEN
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Thu thanh lý (khách trả thêm)');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'INCOME', 'Khách trả thêm khi thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_rcpt, v_settle_inv, p_move_out_date, -v_S, 'APPROVED',
      'Khách trả thêm phần công nợ vượt tiền cọc khi thanh lý (tiền thật vào sổ nhận).' || COALESCE(E'\n' || p_notes, ''),
      'termination.extra_receipt')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Khách trả thêm khi thanh lý', 1, -v_S, p_move_out_date, p_move_out_date);
  END IF;

  -- 5. Recompute hoá đơn quyết toán.
  IF v_settle_inv IS NOT NULL THEN PERFORM public.recompute_invoice_for_id(v_settle_inv); END IF;

  -- 6. Thanh lý hợp đồng (ghi chú kèm bản quyết toán đầy đủ).
  UPDATE contracts
     SET status = 'TERMINATED', actual_end_date = p_move_out_date,
         notes = CASE WHEN notes IS NULL OR length(btrim(notes)) = 0
                        THEN '[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']' || COALESCE(E'\n' || p_notes, '') || E'\n' || v_breakdown
                        ELSE notes || E'\n[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']' || COALESCE(E'\n' || p_notes, '') || E'\n' || v_breakdown END,
         updated_at = NOW()
   WHERE id = p_contract_id;

  -- 7. Audit.
  --
  -- [H2.4 - 15/09/2026] DA GO khoi bat loi trum (BEGIN ... WHEN OTHERS ... END)
  -- bao quanh INSERT nay. Audit "best-effort" o day nghia la: hop dong DA
  -- TERMINATED, hoa don quyet toan DA dung, phieu tien DA ghi - ma bang
  -- contract_terminations khong co mot dong nao. Sau do khong ai tra loi duoc
  -- "khach tra phong ngay nao, quyet toan ra sao", va moi read model dung tren
  -- bang do thieu doan trong im lang (man /deposits, KPI hoan coc, preview
  -- nghia vu hoan). Dung lop loi da va cho transfer_room o 20260731050000:
  -- loi audit => rollback toan bo, vi mot cu thanh ly khong ghi duoc vet thi
  -- tha dung xay ra.
    v_audit.id:=gen_random_uuid();
  v_audit.user_id:=NULL;
  v_audit.contract_id:=NULL;
  v_audit.termination_date:=CURRENT_DATE;
  v_audit.actual_move_out_date:=NULL;
  v_audit.notice_date:=NULL;
  v_audit.termination_type:=NULL;
  v_audit.outstanding_debt:=0;
  v_audit.prorated_days:=0;
  v_audit.prorated_rent:=0;
  v_audit.prorated_services:=0;
  v_audit.early_termination_fee:=0;
  v_audit.notice_violation_fee:=0;
  v_audit.damage_fee:=0;
  v_audit.damage_description:=NULL;
  v_audit.damage_images:='[]'::jsonb;
  v_audit.cleaning_fee:=0;
  v_audit.other_fees:=0;
  v_audit.other_fees_description:=NULL;
  v_audit.total_deposit:=NULL;
  v_audit.refund_method:=NULL;
  v_audit.refund_date:=NULL;
  v_audit.refund_receipt_url:=NULL;
  v_audit.status:='DRAFT'::text;
  v_audit.approved_by:=NULL;
  v_audit.approved_at:=NULL;
  v_audit.notes:=NULL;
  v_audit.internal_notes:=NULL;
  v_audit.created_at:=now();
  v_audit.updated_at:=now();
  v_audit.organization_id:=NULL;
  v_audit.rent_refund_amount:=0;
  v_audit.id:=v_term_id;
  v_audit.organization_id:=v_contract.organization_id;
  v_audit.user_id:=v_contract.user_id;
  v_audit.contract_id:=p_contract_id;
  v_audit.termination_date:=p_move_out_date;
  v_audit.actual_move_out_date:=p_move_out_date;
  v_audit.termination_type:='NORMAL';
  v_audit.outstanding_debt:=v_debt;
  v_audit.early_termination_fee:=v_penalty + v_extra;
  v_audit.prorated_rent:=0;
  v_audit.prorated_days:=0;
  v_audit.prorated_services:=0;
  v_audit.total_deposit:=v_deposit;
  v_audit.rent_refund_amount:=v_owed;
  v_audit.refund_method:=CASE WHEN v_refund_dep > 0 OR v_refund_exc > 0 OR v_refund_owed > 0 THEN 'TM'::payment_method ELSE NULL END;
  v_audit.status:='COMPLETED';
  v_audit.approved_by:=auth.uid();
  v_audit.approved_at:=NOW();
  v_audit.notes:=COALESCE(p_notes || E'\n', '') || v_breakdown;
  UPDATE app_private.termination_write_capabilities SET expected_after=to_jsonb(v_audit)-ARRAY['refund_amount','total_deductions'],phase=0
  WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid() AND termination_id=v_term_id
    AND actor_id=auth.uid() AND phase=-1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing audit insert proof' USING ERRCODE='42501'; END IF;
  INSERT INTO public.contract_terminations (id,user_id,contract_id,termination_date,actual_move_out_date,notice_date,termination_type,outstanding_debt,prorated_days,prorated_rent,prorated_services,early_termination_fee,notice_violation_fee,damage_fee,damage_description,damage_images,cleaning_fee,other_fees,other_fees_description,total_deposit,refund_method,refund_date,refund_receipt_url,status,approved_by,approved_at,notes,internal_notes,created_at,updated_at,organization_id,rent_refund_amount) VALUES (v_audit.id,v_audit.user_id,v_audit.contract_id,v_audit.termination_date,v_audit.actual_move_out_date,v_audit.notice_date,v_audit.termination_type,v_audit.outstanding_debt,v_audit.prorated_days,v_audit.prorated_rent,v_audit.prorated_services,v_audit.early_termination_fee,v_audit.notice_violation_fee,v_audit.damage_fee,v_audit.damage_description,v_audit.damage_images,v_audit.cleaning_fee,v_audit.other_fees,v_audit.other_fees_description,v_audit.total_deposit,v_audit.refund_method,v_audit.refund_date,v_audit.refund_receipt_url,v_audit.status,v_audit.approved_by,v_audit.approved_at,v_audit.notes,v_audit.internal_notes,v_audit.created_at,v_audit.updated_at,v_audit.organization_id,v_audit.rent_refund_amount);

  RETURN jsonb_build_object(
    'contract_id', p_contract_id, 'settlement_invoice_id', v_settle_inv,
    'charges', v_charges, 'extra_charges_total', v_extra,
    'applied', v_applied, 'applied_deposit', v_applied_dep,
    'refund_deposit', v_refund_dep, 'refund_excess', v_refund_exc,
    'customer_refund_total', v_owed, 'customer_refund_applied', v_owed_applied,
    'refund_customer', v_refund_owed,
    'refund_voucher_id', v_refund_voucher,
    'net_settlement', v_S, 'shortfall_mode', p_shortfall_mode,
    'receipt_account_id', CASE WHEN v_S < 0 AND p_shortfall_mode = 'PAID' THEN v_acc_rcpt END,
    'acc_op', v_acc_op, 'acc_internal', v_acc_int
  );
END $function$;
CREATE OR REPLACE FUNCTION public.create_contract_termination_draft_v1(p_contract_id uuid,p_move_out_date date,p_idempotency_key text,p_termination_type text DEFAULT 'NORMAL',p_total_deposit numeric DEFAULT NULL,p_outstanding_debt numeric DEFAULT 0,p_prorated_rent numeric DEFAULT 0,p_prorated_days integer DEFAULT 0,p_prorated_services numeric DEFAULT 0,p_early_termination_fee numeric DEFAULT 0,p_notice_violation_fee numeric DEFAULT 0,p_damage_fee numeric DEFAULT 0,p_cleaning_fee numeric DEFAULT 0,p_other_fees numeric DEFAULT 0,p_refund_method public.payment_method DEFAULT NULL,p_notes text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,app_private AS $function$
DECLARE
  v_actor uuid:=auth.uid();
  v_key text:=btrim(coalesce(p_idempotency_key,''));
  v_contract public.contracts%rowtype;
  v_audit public.contract_terminations%rowtype;
  v_op app_private.canonical_write_operations%rowtype;
  v_hash text;
  v_response jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN RAISE EXCEPTION 'Invalid idempotency_key' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_contract FROM public.contracts WHERE id=p_contract_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_do_on_building('contracts','create',public.building_of_contract(p_contract_id)) THEN
    RAISE EXCEPTION 'Missing permission to create termination draft' USING ERRCODE='42501';
  END IF;
  IF v_contract.organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id JOIN public.buildings b ON b.id=r.building_id
    WHERE c.id=p_contract_id AND c.organization_id=v_contract.organization_id AND r.organization_id=v_contract.organization_id AND b.organization_id=v_contract.organization_id
  ) THEN RAISE EXCEPTION 'Contract organization linkage mismatch' USING ERRCODE='42501'; END IF;
  v_hash:=md5(jsonb_build_object('p_contract_id',p_contract_id,'p_move_out_date',p_move_out_date,'p_termination_type',p_termination_type,'p_total_deposit',p_total_deposit,'p_outstanding_debt',p_outstanding_debt,'p_prorated_rent',p_prorated_rent,'p_prorated_days',p_prorated_days,'p_prorated_services',p_prorated_services,'p_early_termination_fee',p_early_termination_fee,'p_notice_violation_fee',p_notice_violation_fee,'p_damage_fee',p_damage_fee,'p_cleaning_fee',p_cleaning_fee,'p_other_fees',p_other_fees,'p_refund_method',p_refund_method,'p_notes',p_notes)::text);

  INSERT INTO app_private.canonical_write_operations(organization_id,operation,subject_scope,actor_id,idempotency_key,payload_hash)
  VALUES(v_contract.organization_id,'contract.termination.draft.v1',p_contract_id::text,v_actor,v_key,v_hash)
  ON CONFLICT(organization_id,operation,subject_scope,actor_id,idempotency_key) DO NOTHING;
  SELECT * INTO v_op FROM app_private.canonical_write_operations
  WHERE organization_id=v_contract.organization_id AND operation='contract.termination.draft.v1'
    AND subject_scope=p_contract_id::text AND actor_id=v_actor AND idempotency_key=v_key FOR UPDATE;
  IF v_op.payload_hash<>v_hash THEN RAISE EXCEPTION 'idempotency_key was reused with a different payload' USING ERRCODE='23505'; END IF;
  IF v_op.completed_at IS NOT NULL THEN RETURN v_op.response_payload; END IF;
  IF v_contract.deleted_at IS NOT NULL OR v_contract.status NOT IN ('ACTIVE','EXTENDED') THEN
    RAISE EXCEPTION 'Contract is not eligible for termination draft' USING ERRCODE='55000';
  END IF;
  v_audit.id:=gen_random_uuid();
  v_audit.user_id:=NULL;
  v_audit.contract_id:=NULL;
  v_audit.termination_date:=CURRENT_DATE;
  v_audit.actual_move_out_date:=NULL;
  v_audit.notice_date:=NULL;
  v_audit.termination_type:=NULL;
  v_audit.outstanding_debt:=0;
  v_audit.prorated_days:=0;
  v_audit.prorated_rent:=0;
  v_audit.prorated_services:=0;
  v_audit.early_termination_fee:=0;
  v_audit.notice_violation_fee:=0;
  v_audit.damage_fee:=0;
  v_audit.damage_description:=NULL;
  v_audit.damage_images:='[]'::jsonb;
  v_audit.cleaning_fee:=0;
  v_audit.other_fees:=0;
  v_audit.other_fees_description:=NULL;
  v_audit.total_deposit:=NULL;
  v_audit.refund_method:=NULL;
  v_audit.refund_date:=NULL;
  v_audit.refund_receipt_url:=NULL;
  v_audit.status:='DRAFT'::text;
  v_audit.approved_by:=NULL;
  v_audit.approved_at:=NULL;
  v_audit.notes:=NULL;
  v_audit.internal_notes:=NULL;
  v_audit.created_at:=now();
  v_audit.updated_at:=now();
  v_audit.organization_id:=NULL;
  v_audit.rent_refund_amount:=0;
  v_audit.contract_id:=p_contract_id;
  v_audit.organization_id:=v_contract.organization_id;
  v_audit.user_id:=v_actor;
  v_audit.actual_move_out_date:=p_move_out_date;
  v_audit.termination_type:=p_termination_type;
  v_audit.total_deposit:=p_total_deposit;
  v_audit.outstanding_debt:=p_outstanding_debt;
  v_audit.prorated_rent:=p_prorated_rent;
  v_audit.prorated_days:=p_prorated_days;
  v_audit.prorated_services:=p_prorated_services;
  v_audit.early_termination_fee:=p_early_termination_fee;
  v_audit.notice_violation_fee:=p_notice_violation_fee;
  v_audit.damage_fee:=p_damage_fee;
  v_audit.cleaning_fee:=p_cleaning_fee;
  v_audit.other_fees:=p_other_fees;
  v_audit.refund_method:=p_refund_method;
  v_audit.notes:=p_notes;
  PERFORM app_private.open_termination_write_v2(v_audit.id,p_contract_id,v_contract.organization_id,'DRAFT',v_hash,NULL,to_jsonb(v_audit),'contract.termination.draft.v1',v_key);
  INSERT INTO public.contract_terminations (id,user_id,contract_id,termination_date,actual_move_out_date,notice_date,termination_type,outstanding_debt,prorated_days,prorated_rent,prorated_services,early_termination_fee,notice_violation_fee,damage_fee,damage_description,damage_images,cleaning_fee,other_fees,other_fees_description,total_deposit,refund_method,refund_date,refund_receipt_url,status,approved_by,approved_at,notes,internal_notes,created_at,updated_at,organization_id,rent_refund_amount) VALUES (v_audit.id,v_audit.user_id,v_audit.contract_id,v_audit.termination_date,v_audit.actual_move_out_date,v_audit.notice_date,v_audit.termination_type,v_audit.outstanding_debt,v_audit.prorated_days,v_audit.prorated_rent,v_audit.prorated_services,v_audit.early_termination_fee,v_audit.notice_violation_fee,v_audit.damage_fee,v_audit.damage_description,v_audit.damage_images,v_audit.cleaning_fee,v_audit.other_fees,v_audit.other_fees_description,v_audit.total_deposit,v_audit.refund_method,v_audit.refund_date,v_audit.refund_receipt_url,v_audit.status,v_audit.approved_by,v_audit.approved_at,v_audit.notes,v_audit.internal_notes,v_audit.created_at,v_audit.updated_at,v_audit.organization_id,v_audit.rent_refund_amount);
  PERFORM app_private.close_termination_write_v2(v_audit.id);
  v_response:=jsonb_build_object('termination_id',v_audit.id,'status','DRAFT');
  UPDATE app_private.canonical_write_operations SET subject_id=v_audit.id,completed_at=clock_timestamp(),response_payload=v_response
  WHERE organization_id=v_contract.organization_id AND operation='contract.termination.draft.v1'
    AND subject_scope=p_contract_id::text AND actor_id=v_actor AND idempotency_key=v_key;
  RETURN v_response;
END
$function$;
REVOKE ALL ON FUNCTION public.create_contract_termination_draft_v1(uuid,date,text,text,numeric,numeric,numeric,integer,numeric,numeric,numeric,numeric,numeric,numeric,public.payment_method,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.create_contract_termination_draft_v1(uuid,date,text,text,numeric,numeric,numeric,integer,numeric,numeric,numeric,numeric,numeric,numeric,public.payment_method,text) TO authenticated;
REVOKE ALL ON FUNCTION terminate_contract_forfeit_impl(uuid,date,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION app_private.begin_contract_termination_write_v1(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION app_private.end_contract_termination_write_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION has_contract_termination_write_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst, 'reload schema';
$install$;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('approve_contract_termination_v1(uuid,text)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='6a403e83918b8d5453f59294edbe9e0b' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: approve_contract_termination_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.begin_contract_termination_write_v1(uuid,text)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='5e8bcaa95e89128cd72d3a78cb6288f0' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, app_private, public']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: begin_contract_termination_write_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.close_termination_write_v2(uuid)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='14f203609a052476d85276784ccce63f' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: close_termination_write_v2'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('create_contract_termination_draft_v1(uuid,date,text,text,numeric,numeric,numeric,integer,numeric,numeric,numeric,numeric,numeric,numeric,payment_method,text)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='38ffb94b0aab4b7839980f36129e153d' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: create_contract_termination_draft_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.end_contract_termination_write_v1(uuid)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='382f53de40affd1408fe8fa3df3fa7df' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, app_private, public']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: end_contract_termination_write_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('guard_contract_termination_settlement()') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='983735d0c72c3bf4cb60c7fb801194e4' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: guard_contract_termination_settlement'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('has_contract_termination_write_v1(uuid)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='3e5e94607e6d11e41eb0a92b64a6ddc1' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, app_private, public']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: has_contract_termination_write_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.open_termination_write_v2(uuid,uuid,uuid,text,text,jsonb,jsonb,text,text,text)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='4724488912c79281bd5e7078a64299ed' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: open_termination_write_v2'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('reject_contract_termination_v1(uuid,text)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='f8aec733e0ea3bf02949f1d64568ae43' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: reject_contract_termination_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('terminate_contract_forfeit(uuid,date,jsonb)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='af02d924fc8ee495e48bbcdf7096e8c5' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: terminate_contract_forfeit'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('terminate_contract_forfeit_impl(uuid,date,jsonb)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='71d861426074b80fbac5c6941f289e00' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=public']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: terminate_contract_forfeit_impl'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('terminate_contract_forfeit_with_credit_v1(uuid,date,jsonb,text)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='0063e98e71e2d5e39da19980a82060c6' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: terminate_contract_forfeit_with_credit_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('terminate_contract_move_out(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='af9cf234be5bbf27dd1176801dd910c3' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: terminate_contract_move_out'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='cefce92ca899b31c98eb80767b17401d' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=public']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: terminate_contract_move_out_impl'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('terminate_contract_move_out_with_credit_v1(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,text,jsonb)') AND md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)))='9bc5208bf731f969e20f30c5b77e4d9e' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres}' AND p.prosecdef=true AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public, app_private']::text[]) THEN RAISE EXCEPTION 'P1a2 function definition/metadata drift: terminate_contract_move_out_with_credit_v1'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.contract_terminations'::regclass AND tgname='a00_contract_termination_settlement_guard' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_contract_termination_settlement_guard BEFORE INSERT OR DELETE OR UPDATE ON public.contract_terminations FOR EACH ROW EXECUTE FUNCTION guard_contract_termination_settlement(''pre'')') THEN RAISE EXCEPTION 'P1a2 trigger drift'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.contract_terminations'::regclass AND tgname='contract_terminations_set_user_id_audit' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER contract_terminations_set_user_id_audit BEFORE INSERT ON public.contract_terminations FOR EACH ROW EXECUTE FUNCTION set_user_id_from_auth()') THEN RAISE EXCEPTION 'P1a2 trigger drift'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.contract_terminations'::regclass AND tgname='trg_autofill_org' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.contract_terminations FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict()') THEN RAISE EXCEPTION 'P1a2 trigger drift'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.contract_terminations'::regclass AND tgname='trigger_auto_calculate_termination_financials' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER trigger_auto_calculate_termination_financials BEFORE INSERT OR UPDATE ON public.contract_terminations FOR EACH ROW EXECUTE FUNCTION auto_calculate_termination_financials()') THEN RAISE EXCEPTION 'P1a2 trigger drift'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.contract_terminations'::regclass AND tgname='trigger_termination_final_guard' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER trigger_termination_final_guard BEFORE INSERT OR UPDATE ON public.contract_terminations FOR EACH ROW EXECUTE FUNCTION guard_contract_termination_settlement(''final'')') THEN RAISE EXCEPTION 'P1a2 trigger drift'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.contract_terminations'::regclass AND tgname='trigger_update_contract_on_termination' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER trigger_update_contract_on_termination BEFORE UPDATE OF status ON public.contract_terminations FOR EACH ROW EXECUTE FUNCTION update_contract_on_termination_approved()') THEN RAISE EXCEPTION 'P1a2 trigger drift'; END IF;
  IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_private.termination_write_capabilities'::regclass AND contype='f')
    OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='app_private.termination_write_capabilities'::regclass)
    OR EXISTS(SELECT 1 FROM information_schema.role_table_grants WHERE table_schema='app_private' AND table_name='termination_write_capabilities' AND grantee IN ('PUBLIC','anon','authenticated','service_role'))
    OR (SELECT count(*) FROM pg_attribute WHERE attrelid='app_private.termination_write_capabilities'::regclass AND attname IN ('organization_id','actor_id') AND attnotnull)<>2
  THEN RAISE EXCEPTION 'P1a2 capability storage boundary drift'; END IF;

END
$migration$;
