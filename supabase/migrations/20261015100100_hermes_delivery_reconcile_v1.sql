-- Human-confirmed reconciliation of UNKNOWN_EFFECT deliveries (package K6).
-- Forward only. A person who may currently see/manage the delivery records
-- "sent" or "not sent" with a note: immutable audit row, the queue row stops
-- requiring reconciliation, and schedule ownership blocks are released.
-- Nothing is ever re-sent here; sending again is a new command with a new ID.
-- Private DM replies stay terminal UNKNOWN_EFFECT; only the attestation is
-- recorded. Connector access reuses the schedule tool contract (manage_v2).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE TABLE IF NOT EXISTS app_private.hermes_delivery_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  actor uuid NOT NULL REFERENCES auth.users(id),
  target_kind text NOT NULL CHECK(target_kind IN ('queue_job','private_command')),
  job_id uuid,
  command_id uuid REFERENCES app_private.hermes_zalo_private_commands(id),
  decision text NOT NULL CHECK(decision IN ('sent','not_sent')),
  note text NOT NULL CHECK(char_length(note) BETWEEN 1 AND 500 AND btrim(note)<>''),
  request_id uuid NOT NULL,
  via text NOT NULL CHECK(via IN ('crm_ui','hermes_connector')),
  connection_id uuid REFERENCES app_private.hermes_connections(id),
  prior jsonb NOT NULL CHECK(jsonb_typeof(prior)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((target_kind='queue_job')=(job_id IS NOT NULL) AND (target_kind='private_command')=(command_id IS NOT NULL)),
  CHECK((via='hermes_connector')=(connection_id IS NOT NULL)),
  UNIQUE(actor,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS hermes_delivery_reconciliations_job ON app_private.hermes_delivery_reconciliations(job_id) WHERE job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hermes_delivery_reconciliations_command ON app_private.hermes_delivery_reconciliations(command_id) WHERE command_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hermes_delivery_reconciliations_org ON app_private.hermes_delivery_reconciliations(organization_id,created_at DESC);
ALTER TABLE app_private.hermes_delivery_reconciliations OWNER TO postgres;
ALTER TABLE app_private.hermes_delivery_reconciliations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.hermes_delivery_reconciliations FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
DROP TRIGGER IF EXISTS hermes_delivery_reconciliation_immutable ON app_private.hermes_delivery_reconciliations;
CREATE TRIGGER hermes_delivery_reconciliation_immutable BEFORE UPDATE OR DELETE ON app_private.hermes_delivery_reconciliations
  FOR EACH ROW EXECUTE FUNCTION app_private.hermes_schedule_immutable_v1();

CREATE OR REPLACE FUNCTION app_private.hermes_delivery_reconciliation_json_v1(r app_private.hermes_delivery_reconciliations)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
  SELECT jsonb_build_object('id',r.id,'kind',r.target_kind,'targetId',COALESCE(r.job_id,r.command_id),'decision',r.decision,
    'note',r.note,'via',r.via,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$fn$;

-- Core state transition. Callers authorize on the target's immutable origin
-- (dispatch owner/origin, schedule connection, command owner) while holding
-- the org decision lock; this function locks the row and checks its state.
CREATE OR REPLACE FUNCTION app_private.hermes_delivery_reconcile_apply_v1(p_actor uuid,p_org uuid,p_kind text,p_target uuid,
  p_decision text,p_note text,p_request uuid,p_via text,p_connection uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE r app_private.hermes_delivery_reconciliations; q public.zalo_send_queue; cmd app_private.hermes_zalo_private_commands;
BEGIN
  IF p_actor IS NULL OR p_org IS NULL OR p_target IS NULL OR p_request IS NULL OR p_kind NOT IN ('queue_job','private_command')
    OR p_decision NOT IN ('sent','not_sent') OR p_note IS NULL OR char_length(p_note) NOT BETWEEN 1 AND 500 OR btrim(p_note)=''
    OR p_note ~ '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' OR p_via NOT IN ('crm_ui','hermes_connector') OR (p_via='hermes_connector')<>(p_connection IS NOT NULL)
    THEN RAISE EXCEPTION 'hermes_reconcile_invalid' USING ERRCODE='22023'; END IF;
  -- Same advisory lock as schedule ownership/run, so an owner check never
  -- observes a half-applied reconciliation.
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes-room-schedule:'||p_org::text,0));
  SELECT * INTO r FROM app_private.hermes_delivery_reconciliations WHERE actor=p_actor AND request_id=p_request;
  IF r.id IS NOT NULL THEN
    IF r.organization_id=p_org AND r.target_kind=p_kind AND COALESCE(r.job_id,r.command_id)=p_target AND r.decision=p_decision
      AND r.note=p_note AND r.via=p_via AND r.connection_id IS NOT DISTINCT FROM p_connection
      THEN RETURN app_private.hermes_delivery_reconciliation_json_v1(r); END IF;
    RAISE EXCEPTION 'hermes_reconcile_request_reused' USING ERRCODE='PT409';
  END IF;
  IF p_kind='queue_job' THEN
    SELECT * INTO q FROM public.zalo_send_queue WHERE id=p_target FOR UPDATE;
    IF q.id IS NULL OR q.organization_id IS DISTINCT FROM p_org THEN RAISE EXCEPTION 'hermes_reconcile_denied' USING ERRCODE='42501'; END IF;
    IF COALESCE(q.result,'{}'::jsonb) ? 'reconciliation' THEN RAISE EXCEPTION 'hermes_reconcile_already_resolved' USING ERRCODE='PT409'; END IF;
    IF q.status IS DISTINCT FROM 'failed' OR NOT(q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true')
      THEN RAISE EXCEPTION 'hermes_reconcile_not_unknown' USING ERRCODE='PT409'; END IF;
    INSERT INTO app_private.hermes_delivery_reconciliations(organization_id,actor,target_kind,job_id,decision,note,request_id,via,connection_id,prior)
      VALUES(p_org,p_actor,'queue_job',q.id,p_decision,p_note,p_request,p_via,p_connection,jsonb_build_object('status',q.status,'result',q.result,
        'lastError',left(q.last_error,300),'providerStartedAt',q.provider_started_at,'processedAt',q.processed_at))
      RETURNING * INTO r;
    -- Operational state only; the original outcome stays in the audit row and
    -- previous_outcome. Message rows are untouched (no provider receipt).
    UPDATE public.zalo_send_queue SET status=CASE WHEN p_decision='sent' THEN 'sent' ELSE 'failed' END,
      result=COALESCE(q.result,'{}'::jsonb)||jsonb_build_object('outcome','reconciled_'||p_decision,'requires_reconciliation',false,
        'previous_outcome',q.result->'outcome','reconciliation',jsonb_build_object('id',r.id,'decision',p_decision,
          'at',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
      WHERE id=q.id;
  ELSE
    SELECT * INTO cmd FROM app_private.hermes_zalo_private_commands WHERE id=p_target FOR SHARE;
    IF cmd.id IS NULL OR cmd.organization_id IS DISTINCT FROM p_org OR cmd.user_id IS DISTINCT FROM p_actor
      THEN RAISE EXCEPTION 'hermes_reconcile_denied' USING ERRCODE='42501'; END IF;
    IF cmd.state IS DISTINCT FROM 'UNKNOWN_EFFECT' THEN RAISE EXCEPTION 'hermes_reconcile_not_unknown' USING ERRCODE='PT409'; END IF;
    IF EXISTS(SELECT 1 FROM app_private.hermes_delivery_reconciliations WHERE command_id=cmd.id)
      THEN RAISE EXCEPTION 'hermes_reconcile_already_resolved' USING ERRCODE='PT409'; END IF;
    INSERT INTO app_private.hermes_delivery_reconciliations(organization_id,actor,target_kind,command_id,decision,note,request_id,via,connection_id,prior)
      VALUES(p_org,p_actor,'private_command',cmd.id,p_decision,p_note,p_request,p_via,p_connection,jsonb_build_object('state',cmd.state,
        'failureCode',cmd.failure_code,'replyOutcome',cmd.reply_outcome,'completedAt',cmd.completed_at,'replyDispatchedAt',cmd.reply_dispatched_at))
      RETURNING * INTO r;
  END IF;
  RETURN app_private.hermes_delivery_reconciliation_json_v1(r);
END $fn$;

-- CRM UI (human JWT). Own Hermes sends need chat_zalo.view; organisation
-- automation (legacy broadcast and every standing grant) needs
-- chat_zalo.manage_automation; a private reply only ever its own user.
CREATE OR REPLACE FUNCTION app_private.hermes_delivery_reconcile_caller_v1(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_actor uuid:=auth.uid(); v_view record; v_manage record;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR v_actor IS NULL OR p_org IS NULL
    THEN RAISE EXCEPTION 'hermes_reconcile_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_org);
  PERFORM app_private.hermes_member_v1(v_actor,p_org);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_reconcile_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_view FROM app_private.authorize_tenant_action_v3(v_actor,p_org,'chat_zalo.view');
  SELECT * INTO v_manage FROM app_private.authorize_tenant_action_v3(v_actor,p_org,'chat_zalo.manage_automation');
  RETURN jsonb_build_object('actor',v_actor,'view',COALESCE(v_view.allowed,false),'manage',COALESCE(v_manage.allowed,false));
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_delivery_job_allowed_v1(p_job uuid,p_org uuid,p_caller jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT EXISTS(SELECT 1 FROM public.zalo_send_queue q LEFT JOIN app_private.hermes_group_dispatches h ON h.id=q.hermes_group_dispatch_id
    WHERE q.id=p_job AND q.organization_id=p_org AND (
      (h.id IS NOT NULL AND h.organization_id=p_org AND h.user_id::text=p_caller->>'actor' AND (p_caller->>'view')::boolean)
      OR ((p_caller->>'manage')::boolean AND ((h.id IS NOT NULL AND h.origin='standing_grant' AND h.organization_id=p_org)
        OR (h.id IS NULL AND q.payload->>'tu_dong'='true' AND q.payload->>'auto_reply' IS DISTINCT FROM 'true')))))
$fn$;

CREATE OR REPLACE FUNCTION public.hermes_delivery_reconcile_list_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_caller jsonb; v_actor uuid; v_view boolean; v_manage boolean; v_items jsonb; v_recent jsonb;
BEGIN
  v_caller:=app_private.hermes_delivery_reconcile_caller_v1(p_organization_id);
  v_actor:=(v_caller->>'actor')::uuid; v_view:=(v_caller->>'view')::boolean; v_manage:=(v_caller->>'manage')::boolean;
  SELECT COALESCE(jsonb_agg(item ORDER BY sort_at DESC,item->>'id'),'[]'::jsonb) INTO v_items FROM (
    SELECT * FROM (
      SELECT q.created_at AS sort_at,jsonb_build_object('kind','queue_job','id',q.id,
        'origin',CASE WHEN h.id IS NULL THEN 'automation' WHEN h.origin='standing_grant' THEN 'hermes_schedule'
          WHEN h.origin='external_mcp' THEN 'hermes_connector' ELSE 'hermes_private_command' END,
        'scheduleId',CASE WHEN h.origin='standing_grant' THEN h.request->'scheduleId' ELSE 'null'::jsonb END,
        'conversationId',q.conversation_id,'conversationName',CASE WHEN v_view THEN left(z.peer_name,160) END,
        'preview',CASE WHEN v_view THEN left(COALESCE(q.payload->>'body',''),160) END,
        'errorCode',substring(q.last_error FROM '^([A-Z][A-Z_]{2,40})'),
        'createdAt',to_char(q.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'processedAt',to_char(q.processed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS item
      FROM public.zalo_send_queue q LEFT JOIN app_private.hermes_group_dispatches h ON h.id=q.hermes_group_dispatch_id
        LEFT JOIN public.zalo_conversations z ON z.id=q.conversation_id AND z.organization_id=q.organization_id
      WHERE q.organization_id=p_organization_id AND q.status='failed'
        AND (q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true') AND NOT(COALESCE(q.result,'{}'::jsonb) ? 'reconciliation')
        AND ((h.id IS NOT NULL AND h.user_id=v_actor AND v_view)
          OR (v_manage AND ((h.id IS NOT NULL AND h.origin='standing_grant') OR (h.id IS NULL AND q.payload->>'tu_dong'='true' AND q.payload->>'auto_reply' IS DISTINCT FROM 'true'))))
      ORDER BY q.created_at DESC,q.id LIMIT 50) jobs
    UNION ALL
    SELECT * FROM (
      SELECT cmd.accepted_at AS sort_at,jsonb_build_object('kind','private_command','id',cmd.id,'origin','private_reply','scheduleId',NULL,
        'conversationId',NULL,'conversationName',NULL,'preview',NULL,'errorCode',cmd.failure_code,
        'createdAt',to_char(cmd.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'processedAt',to_char(cmd.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS item
      FROM app_private.hermes_zalo_private_commands cmd
      WHERE cmd.organization_id=p_organization_id AND cmd.user_id=v_actor AND cmd.state='UNKNOWN_EFFECT'
        AND NOT EXISTS(SELECT 1 FROM app_private.hermes_delivery_reconciliations r WHERE r.command_id=cmd.id)
      ORDER BY cmd.accepted_at DESC,cmd.id LIMIT 50) commands
    ORDER BY sort_at DESC LIMIT 50) items;
  SELECT COALESCE(jsonb_agg(app_private.hermes_delivery_reconciliation_json_v1(r)||jsonb_build_object('mine',r.actor=v_actor)
    ORDER BY r.created_at DESC,r.id),'[]'::jsonb) INTO v_recent FROM (
    SELECT * FROM app_private.hermes_delivery_reconciliations r WHERE r.organization_id=p_organization_id
      AND (r.actor=v_actor OR (v_manage AND r.target_kind='queue_job')) ORDER BY r.created_at DESC,r.id LIMIT 20) r;
  RETURN jsonb_build_object('organizationId',p_organization_id,'userId',v_actor,'canManage',v_manage,'items',v_items,'recent',v_recent);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_delivery_reconcile_resolve_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_org uuid; v_caller jsonb; v_kind text; v_target uuid; v_result jsonb;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['organizationId','requestId','kind','targetId','decision','note']);
  IF jsonb_typeof(p->'kind') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'decision') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p->'note') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'hermes_reconcile_invalid' USING ERRCODE='22023'; END IF;
  v_org:=app_private.hermes_uuid_v1(p->'organizationId'); v_target:=app_private.hermes_uuid_v1(p->'targetId'); v_kind:=p->>'kind';
  v_caller:=app_private.hermes_delivery_reconcile_caller_v1(v_org);
  IF v_kind='queue_job' AND NOT app_private.hermes_delivery_job_allowed_v1(v_target,v_org,v_caller)
    THEN RAISE EXCEPTION 'hermes_reconcile_denied' USING ERRCODE='42501'; END IF;
  v_result:=app_private.hermes_delivery_reconcile_apply_v1((v_caller->>'actor')::uuid,v_org,v_kind,v_target,p->>'decision',p->>'note',
    app_private.hermes_uuid_v1(p->'requestId'),'crm_ui',NULL);
  RETURN jsonb_build_object('organizationId',v_org,'userId',v_caller->>'actor','reconciliation',v_result);
END $fn$;

-- Connector path: the delivery must originate from THIS Hermes connection,
-- and the action it attests to must still be allowed by current CRM rights
-- intersected with the connection overlay, company policy and registry.
CREATE OR REPLACE FUNCTION app_private.hermes_delivery_reconcile_connector_v1(c app_private.hermes_connections,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE h app_private.hermes_group_dispatches; s app_private.hermes_room_schedules; policy app_private.hermes_org_policies;
  decision record; v_key text; v_job uuid;
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_input))<>4
    OR NOT(p_input ?& ARRAY['requestId','jobId','decision','note']) OR jsonb_typeof(p_input->'decision') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_input->'note') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
  v_job:=app_private.hermes_uuid_v1(p_input->'jobId');
  SELECT h2.* INTO h FROM app_private.hermes_group_jobs j JOIN app_private.hermes_group_dispatches h2 ON h2.id=j.dispatch_id WHERE j.job_id=v_job;
  IF h.id IS NULL OR h.organization_id<>c.organization_id OR h.user_id<>c.user_id THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  IF h.origin='standing_grant' THEN
    SELECT * INTO s FROM app_private.hermes_room_schedules WHERE id=(h.request->>'scheduleId')::uuid;
    IF s.connection_id IS DISTINCT FROM c.id THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
    v_key:='chat_zalo.manage_automation';
  ELSIF h.origin='external_mcp' AND h.snapshot#>>'{owner,connectionId}'=c.id::text THEN v_key:='chat_zalo.send';
  ELSE RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  SELECT * INTO decision FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,v_key);
  IF decision.allowed IS DISTINCT FROM true OR NOT(v_key=ANY(c.action_capabilities)) OR NOT(v_key=ANY(policy.action_capabilities))
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability=v_key AND mode='action' AND enabled)
    THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  RETURN app_private.hermes_delivery_reconcile_apply_v1(c.user_id,c.organization_id,'queue_job',v_job,p_input->>'decision',p_input->>'note',
    app_private.hermes_uuid_v1(p_input->'requestId'),'hermes_connector',c.id);
END $fn$;

-- Summary with the extended run vocabulary, reconciliation state and the
-- schedule's open incidents. manage_v1/summary_v1 keep their old shape.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_summary_v2(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT jsonb_build_object('scheduleId',s.id,'revision',s.revision,'state',CASE WHEN s.state='ACTIVE' AND g.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE s.state END,
    'settings',g.settings,'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lastRuns',COALESCE((SELECT jsonb_agg(jsonb_build_object('date',r.local_date,'conversationId',r.conversation_id,'outcome',r.outcome,'reason',r.reason,
      'dispatchId',r.dispatch_id,'deliveryStatus',CASE WHEN r.outcome<>'queued' THEN NULL ELSE COALESCE((
        SELECT CASE WHEN COALESCE(q.result,'{}'::jsonb) ? 'reconciliation' THEN 'confirmed_'||(q.result#>>'{reconciliation,decision}')
          WHEN q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true' THEN 'unknown'
          WHEN q.status IN ('sent','failed','processing') THEN q.status ELSE 'queued' END
        FROM app_private.hermes_group_jobs j JOIN public.zalo_send_queue q ON q.id=j.job_id WHERE j.dispatch_id=r.dispatch_id),'unknown') END)
      ORDER BY r.created_at,r.conversation_id) FROM app_private.hermes_schedule_runs r
      WHERE r.schedule_id=s.id AND r.local_date=(SELECT max(local_date) FROM app_private.hermes_schedule_runs WHERE schedule_id=s.id)),'[]'::jsonb),
    'openIssues',COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',i.kind,'reason',i.reason,'occurrences',i.occurrences,
      'openedAt',to_char(i.opened_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY i.opened_at,i.id)
      FROM (SELECT * FROM app_private.hermes_schedule_incidents WHERE schedule_id=s.id AND closed_at IS NULL ORDER BY opened_at,id LIMIT 10) i),'[]'::jsonb))
  FROM app_private.hermes_room_schedules s JOIN app_private.hermes_schedule_grants g ON g.id=s.grant_id WHERE s.id=p_id
$fn$;

CREATE OR REPLACE FUNCTION public.hermes_room_schedule_manage_v2(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE op text; input jsonb; result jsonb; c app_private.hermes_connections; page_limit integer; page_cursor uuid; page_ids uuid[];
  v_schedule uuid; v_issues jsonb; v_unknown jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>3 OR NOT(p ?& ARRAY['binding','operation','input'])
    OR jsonb_typeof(p->'input') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
  op:=p->>'operation'; input:=p->'input';
  IF op IN ('create','update','revoke') THEN
    -- Same validation, actor, grant, ownership and idempotency as v1.
    result:=public.hermes_room_schedule_manage_v1(p);
    RETURN jsonb_build_object('schedule',app_private.hermes_schedule_summary_v2((result#>>'{schedule,scheduleId}')::uuid));
  END IF;
  IF op IS NULL OR op NOT IN ('list','issues','reconcile') THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
  c:=app_private.hermes_schedule_actor_v1(p->'binding',false);
  IF op='list' THEN
    IF input-ARRAY['limit','cursor']<>'{}'::jsonb THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
    page_limit:=CASE WHEN input ? 'limit' THEN app_private.hermes_integer_v1(input->'limit') ELSE 20 END;
    page_cursor:=CASE WHEN NOT(input ? 'cursor') OR input->'cursor'='null'::jsonb THEN NULL ELSE app_private.hermes_uuid_v1(input->'cursor') END;
    IF page_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
    SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO page_ids FROM (
      SELECT id FROM app_private.hermes_room_schedules WHERE connection_id=c.id AND user_id=c.user_id AND organization_id=c.organization_id
        AND (page_cursor IS NULL OR id>page_cursor) ORDER BY id LIMIT page_limit+1) page;
    RETURN jsonb_build_object('schedules',COALESCE((SELECT jsonb_agg(app_private.hermes_schedule_summary_v2(id) ORDER BY id)
      FROM unnest(page_ids[1:page_limit]) id),'[]'::jsonb),
      'nextCursor',CASE WHEN cardinality(page_ids)>page_limit THEN page_ids[page_limit] ELSE NULL END);
  ELSIF op='issues' THEN
    IF input-ARRAY['limit','scheduleId']<>'{}'::jsonb THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
    page_limit:=CASE WHEN input ? 'limit' THEN app_private.hermes_integer_v1(input->'limit') ELSE 20 END;
    IF page_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
    v_schedule:=CASE WHEN NOT(input ? 'scheduleId') OR input->'scheduleId'='null'::jsonb THEN NULL ELSE app_private.hermes_uuid_v1(input->'scheduleId') END;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('incidentId',i.id,'scheduleId',i.schedule_id,'kind',i.kind,'reason',i.reason,'detail',i.detail,
      'occurrences',i.occurrences,'openedAt',to_char(i.opened_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'lastSeenAt',to_char(i.last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'closedAt',to_char(i.closed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'closeReason',i.close_reason)
      ORDER BY i.closed_at IS NULL DESC,i.opened_at DESC,i.id),'[]'::jsonb) INTO v_issues FROM (
      SELECT i.* FROM app_private.hermes_schedule_incidents i JOIN app_private.hermes_room_schedules s ON s.id=i.schedule_id
        WHERE s.connection_id=c.id AND s.user_id=c.user_id AND s.organization_id=c.organization_id AND (v_schedule IS NULL OR s.id=v_schedule)
          AND (i.closed_at IS NULL OR i.closed_at>clock_timestamp()-interval '7 days')
        ORDER BY i.closed_at IS NULL DESC,i.opened_at DESC,i.id LIMIT page_limit) i;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('jobId',u.id,'dispatchId',u.dispatch_id,'origin',u.origin,'scheduleId',u.schedule_id,
      'conversationId',u.conversation_id,'createdAt',to_char(u.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ORDER BY u.created_at DESC,u.id),'[]'::jsonb) INTO v_unknown FROM (
      SELECT q.id,h.id AS dispatch_id,h.origin,s.id AS schedule_id,q.conversation_id,q.created_at
        FROM public.zalo_send_queue q JOIN app_private.hermes_group_dispatches h ON h.id=q.hermes_group_dispatch_id
          LEFT JOIN app_private.hermes_room_schedules s ON h.origin='standing_grant' AND s.id::text=h.request->>'scheduleId'
        WHERE q.organization_id=c.organization_id AND h.organization_id=c.organization_id AND h.user_id=c.user_id AND q.status='failed'
          AND (q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true')
          AND ((h.origin='standing_grant' AND s.connection_id=c.id) OR (h.origin='external_mcp' AND h.snapshot#>>'{owner,connectionId}'=c.id::text))
          AND (v_schedule IS NULL OR s.id=v_schedule)
        ORDER BY q.created_at DESC,q.id LIMIT page_limit) u;
    RETURN jsonb_build_object('issues',v_issues,'unknownDeliveries',v_unknown);
  END IF;
  RETURN jsonb_build_object('reconciliation',app_private.hermes_delivery_reconcile_connector_v1(c,input));
END $fn$;

DO $permissions$
DECLARE signature text; name text;
BEGIN
  FOR signature,name IN SELECT p.oid::regprocedure::text,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE (n.nspname='app_private' AND p.proname IN ('hermes_delivery_reconciliation_json_v1','hermes_delivery_reconcile_apply_v1',
      'hermes_delivery_reconcile_caller_v1','hermes_delivery_job_allowed_v1','hermes_delivery_reconcile_connector_v1','hermes_schedule_summary_v2'))
      OR (n.nspname='public' AND p.proname IN ('hermes_delivery_reconcile_list_v1','hermes_delivery_reconcile_resolve_v1','hermes_room_schedule_manage_v2')) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',signature);
    IF name IN ('hermes_delivery_reconcile_list_v1','hermes_delivery_reconcile_resolve_v1','hermes_room_schedule_manage_v2')
      THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',signature); END IF;
  END LOOP;
END $permissions$;
COMMIT;
NOTIFY pgrst,'reload schema';
