-- Offline forward candidate. Hermes acts with the user's current CRM rights
-- intersected with current company/connection capability and room scopes.
-- Explicit user instruction: no mandatory CRM approval/PIN for this path.
-- Generic Copilot approval, standing grants, policies and RPCs are unchanged.
-- No capability, company policy or rollout is enabled by this migration.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE TABLE IF NOT EXISTS app_private.hermes_group_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  command_id uuid NOT NULL UNIQUE REFERENCES app_private.hermes_zalo_private_commands(id),
  request_id uuid NOT NULL,
  request jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  body text NOT NULL CHECK(octet_length(body) BETWEEN 1 AND 8192),
  payload_digest bytea NOT NULL CHECK(octet_length(payload_digest)=32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  UNIQUE(user_id,request_id)
);
CREATE TABLE IF NOT EXISTS app_private.hermes_group_jobs (
  job_id uuid PRIMARY KEY REFERENCES public.zalo_send_queue(id) DEFERRABLE INITIALLY DEFERRED,
  dispatch_id uuid NOT NULL REFERENCES app_private.hermes_group_dispatches(id),
  conversation_id uuid NOT NULL REFERENCES public.zalo_conversations(id),
  queue_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(dispatch_id,conversation_id)
);
ALTER TABLE app_private.hermes_group_dispatches OWNER TO postgres;
ALTER TABLE app_private.hermes_group_jobs OWNER TO postgres;
ALTER TABLE app_private.hermes_group_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.hermes_group_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.hermes_group_dispatches,app_private.hermes_group_jobs FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER TABLE public.zalo_send_queue ADD COLUMN IF NOT EXISTS hermes_group_dispatch_id uuid REFERENCES app_private.hermes_group_dispatches(id);

CREATE OR REPLACE FUNCTION app_private.hermes_group_immutable_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  RAISE EXCEPTION 'hermes_group_origin_immutable' USING ERRCODE='42501';
END $fn$;

DROP TRIGGER IF EXISTS hermes_group_immutable ON app_private.hermes_group_dispatches;
CREATE TRIGGER hermes_group_immutable BEFORE UPDATE OR DELETE ON app_private.hermes_group_dispatches
  FOR EACH ROW EXECUTE FUNCTION app_private.hermes_group_immutable_v1();
DROP TRIGGER IF EXISTS hermes_group_immutable ON app_private.hermes_group_jobs;
CREATE TRIGGER hermes_group_immutable BEFORE UPDATE OR DELETE ON app_private.hermes_group_jobs
  FOR EACH ROW EXECUTE FUNCTION app_private.hermes_group_immutable_v1();

CREATE OR REPLACE FUNCTION app_private.hermes_group_number_vi_v1(p numeric)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
  SELECT CASE WHEN p IS NULL THEN 'chưa công bố'
    ELSE replace(replace(replace(to_char(round(p,2),'FM999,999,999,999,999,990.00'),',','#'),'.',','),'#','.')
      -- Fractional zeros are removed below without stripping integer zeros.
    END
$fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_group_room_fact_v1(p_org uuid,p_room uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE r public.rooms; b public.buildings; f record; v_kind text; v_label text; v_date date; v_soon integer; v_pass boolean;
BEGIN
  SELECT * INTO r FROM public.rooms WHERE id=p_room AND organization_id=p_org AND deleted_at IS NULL;
  SELECT * INTO b FROM public.buildings WHERE id=r.building_id AND organization_id=p_org AND deleted_at IS NULL AND NOT is_virtual;
  IF r.id IS NULL OR b.id IS NULL THEN RAISE EXCEPTION 'hermes_group_rooms_changed' USING ERRCODE='PT409'; END IF;
  SELECT soon_days INTO v_soon FROM public.public_room_settings WHERE owner_id=b.user_id
    AND (organization_id=p_org OR organization_id IS NULL) ORDER BY organization_id NULLS LAST LIMIT 1;
  SELECT EXISTS(SELECT 1 FROM public.room_pass_listings WHERE room_id=r.id AND user_id=b.user_id
    AND (organization_id=p_org OR organization_id IS NULL) AND active) INTO v_pass;
  SELECT * INTO f FROM app_private.room_sale_workflow_fact_v1(r.id,p_org,r.status::text,v_pass,COALESCE(v_soon,30));
  IF f.status_public NOT IN ('free','soon') OR f.status_public IS NULL
    OR NULLIF(btrim(COALESCE(r.code,r.name)),'') IS NULL OR NULLIF(btrim(b.name),'') IS NULL
    OR COALESCE(r.area<0 OR r.area>9007199254740991,false) OR COALESCE(r.rent_price<0 OR r.rent_price>9007199254740991,false)
    THEN RAISE EXCEPTION 'hermes_group_rooms_changed' USING ERRCODE='PT409'; END IF;
  IF f.status_public='soon' THEN
    IF f.sale_state='NOTICE_OVERDUE' OR f.sale_today IS NULL OR f.avail_date IS NULL OR f.avail_date<f.sale_today THEN
      v_kind:='confirm_notice'; v_label:='Cần xác nhận ngày trống';
    ELSE v_kind:='notice'; v_date:=f.avail_date; v_label:='Sắp trống · '||to_char(v_date,'DD/MM/YYYY'); END IF;
  ELSIF f.sale_state='PREPARING' THEN
    v_kind:='preparing';
    IF f.expected_ready_on IS NULL THEN v_label:='Đang chuẩn bị · chưa có ngày dự kiến';
    ELSIF f.sale_today IS NULL OR f.expected_ready_on<f.sale_today THEN v_label:='Đang chuẩn bị · cần xác nhận ngày sẵn sàng';
    ELSE v_date:=f.expected_ready_on; v_label:='Đang chuẩn bị · dự kiến '||to_char(v_date,'DD/MM/YYYY'); END IF;
  ELSE v_kind:='ready'; v_label:='Trống sẵn'; END IF;
  RETURN jsonb_build_object('roomId',r.id,'buildingId',b.id,'roomLabel',COALESCE(r.code,r.name),'buildingLabel',b.name,
    'areaM2',r.area,'rentVnd',r.rent_price,'status',f.status_public,
    'availability',jsonb_build_object('kind',v_kind,'label',v_label,'availableOn',v_date));
END $fn$;

-- Same authority lock order as private command dispatch: org -> session ->
-- connection/token/assistant/policy -> worker lease -> account/bot/ingress ->
-- binding/command -> selected conversations/buildings/rooms. Never acquire org
-- authority after the singleton worker lock. Explicit actor resolver is shared
-- with CRM; worker service JWT is never rewritten into a user JWT.
CREATE OR REPLACE FUNCTION app_private.hermes_group_current_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; q app_private.hermes_zalo_private_commands;
  a public.zalo_accounts; s app_private.hermes_sessions; policy app_private.hermes_org_policies;
  x app_private.hermes_zalo_bindings; bot app_private.hermes_zalo_bots; ingress app_private.hermes_zalo_ingress_sessions;
  v_member jsonb; v_auth record; v_id uuid; v_building uuid; v_fact jsonb; v_facts jsonb:='[]'; v_groups jsonb;
  v_rooms uuid[]; v_convs uuid[]; v_scopes uuid[]; v_now timestamptz;
BEGIN
  c:=app_private.hermes_private_command_connection_v1(p->>'tokenDigest');
  -- Take the strongest lease lock once. Concurrent admissions must not both
  -- hold SHARE then deadlock while upgrading to UPDATE.
  PERFORM 1 FROM public.zalo_worker_lease WHERE id='singleton'
    AND heartbeat_at>clock_timestamp()-interval '30 seconds' AND heartbeat_at<=clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  q:=app_private.hermes_private_command_lock_v1(c,(p->>'commandId')::uuid,p->>'tokenDigest');
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  SELECT * INTO policy FROM app_private.hermes_org_policies WHERE organization_id=c.organization_id;
  SELECT * INTO a FROM public.zalo_accounts WHERE id=q.account_id;
  SELECT * INTO x FROM app_private.hermes_zalo_bindings WHERE id=q.binding_id;
  SELECT * INTO bot FROM app_private.hermes_zalo_bots WHERE account_id=a.id;
  SELECT * INTO ingress FROM app_private.hermes_zalo_ingress_sessions WHERE account_id=a.id;
  v_member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
  v_now:=clock_timestamp();
  IF c.id::text IS DISTINCT FROM p->>'connectionId' OR q.claim_id::text IS DISTINCT FROM p->>'claimId'
    OR c.epoch::text IS DISTINCT FROM p->>'expectedEpoch' OR policy.version::text IS DISTINCT FROM p->>'expectedPolicyVersion'
    OR s.revision::text IS DISTINCT FROM p->>'expectedSessionRevision'
    OR v_member->>'membershipId' IS DISTINCT FROM p->>'expectedMembershipId'
    OR v_member->>'authorizationVersion' IS DISTINCT FROM p->>'expectedAuthorizationVersion'
    OR q.ingress_generation IS DISTINCT FROM ingress.generation
    OR NOT('rooms.view'=ANY(c.read_capabilities)) OR NOT('rooms.view'=ANY(policy.read_capabilities))
    OR NOT('chat_zalo.view'=ANY(c.read_capabilities)) OR NOT('chat_zalo.view'=ANY(policy.read_capabilities))
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.view' AND mode='read' AND enabled)
    OR NOT('chat_zalo.send'=ANY(c.action_capabilities)) OR NOT('chat_zalo.send'=ANY(policy.action_capabilities))
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='rooms.view' AND mode='read' AND enabled)
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.send' AND mode='action' AND enabled)
    THEN RAISE EXCEPTION 'hermes_group_context_changed' USING ERRCODE='PT409'; END IF;
    -- The helper checks current membership, offboarding, emergency deny and
    -- the actual org-wide send/view rights; no duplicated role permission map.
    SELECT * INTO v_auth FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,'chat_zalo.send');
    IF v_auth.allowed IS DISTINCT FROM true OR v_auth.authorization_version::text IS DISTINCT FROM p->>'expectedAuthorizationVersion'
      THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
    SELECT * INTO v_auth FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,'chat_zalo.view');
    IF v_auth.allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  SELECT array_agg(j::uuid ORDER BY j) INTO v_rooms FROM jsonb_array_elements_text(p->'roomIds') j;
  SELECT array_agg(j::uuid ORDER BY j) INTO v_convs FROM jsonb_array_elements_text(p->'conversationIds') j;
  IF cardinality(v_rooms) NOT BETWEEN 1 AND 20 OR cardinality(v_convs) NOT BETWEEN 1 AND 8
    THEN RAISE EXCEPTION 'hermes_group_invalid' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO v_scopes FROM (
    SELECT unnest(c.scope_ids) AS id INTERSECT SELECT unnest(policy.scope_ids) AS id
  ) effective;
  PERFORM 1 FROM public.zalo_conversations WHERE id=ANY(v_convs) ORDER BY id FOR UPDATE;
  SELECT jsonb_agg(jsonb_build_object('conversationId',z.id,'threadId',z.thread_id,'name',z.peer_name) ORDER BY z.id)
    INTO v_groups FROM public.zalo_conversations z WHERE id=ANY(v_convs) AND account_id=a.id AND organization_id=c.organization_id
      AND thread_type='group' AND NULLIF(btrim(thread_id),'') IS NOT NULL AND NULLIF(btrim(peer_name),'') IS NOT NULL;
  IF jsonb_array_length(v_groups) IS DISTINCT FROM cardinality(v_convs)
    OR (SELECT count(DISTINCT g->>'threadId') FROM jsonb_array_elements(v_groups) g)<>cardinality(v_convs)
    THEN RAISE EXCEPTION 'hermes_group_target_changed' USING ERRCODE='PT409'; END IF;
  PERFORM 1 FROM public.buildings WHERE id IN (SELECT building_id FROM public.rooms WHERE id=ANY(v_rooms)) ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.rooms WHERE id=ANY(v_rooms) ORDER BY id FOR SHARE;
  FOREACH v_id IN ARRAY v_rooms LOOP
    v_fact:=app_private.hermes_group_room_fact_v1(c.organization_id,v_id); v_building:=(v_fact->>'buildingId')::uuid;
    SELECT * INTO v_auth FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,'rooms.view',v_building);
    IF v_auth.allowed IS DISTINCT FROM true OR NOT EXISTS(
      SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(v_scopes) AND scope.organization_id=c.organization_id
        AND (scope.scope_type='ORGANIZATION' OR (scope.scope_type='BUILDING' AND scope.building_id=v_building)
          OR (scope.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings edge JOIN public.areas ar ON ar.id=edge.area_id
            WHERE edge.area_id=scope.area_id AND edge.organization_id=c.organization_id AND edge.building_id=v_building
              AND ar.organization_id=c.organization_id AND ar.deleted_at IS NULL))))
      THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
    v_facts:=v_facts||jsonb_build_array(v_fact);
  END LOOP;
  RETURN jsonb_build_object('owner',jsonb_build_object('userId',c.user_id,'organizationId',c.organization_id,'assistantId',c.assistant_id,'connectionId',c.id),
    'binding',jsonb_build_object('epoch',c.epoch,'policyVersion',policy.version,'membershipId',v_member->'membershipId',
      'authorizationVersion',v_member->'authorizationVersion','sessionRevision',s.revision,'bindingId',x.id,'bindingEpoch',x.epoch,
      'assistantEpoch',(SELECT context_epoch FROM app_private.hermes_assistants WHERE id=c.assistant_id)),
    'scopeIds',to_jsonb(v_scopes),'sender',jsonb_build_object('accountId',a.id,'accountOwnerId',a.user_id,'name',a.name,
      'ownUid',ingress.own_uid,'loginRequestedAt',a.login_requested_at,'botVersion',bot.version,'ingressGeneration',ingress.generation),
    'recipients',v_groups,'publicFacts',v_facts);
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_group_assert_dispatch_v1(p_dispatch_id uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE h app_private.hermes_group_dispatches; v_current jsonb;
BEGIN
  SELECT * INTO h FROM app_private.hermes_group_dispatches WHERE id=p_dispatch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  v_current:=app_private.hermes_group_current_v1(h.request);
  IF h.expires_at<=clock_timestamp() OR h.snapshot IS DISTINCT FROM v_current
    OR h.payload_digest IS DISTINCT FROM sha256(convert_to(jsonb_build_object('request',h.request,'snapshot',h.snapshot,'body',h.body)::text,'UTF8'))
    THEN RAISE EXCEPTION 'hermes_group_context_changed' USING ERRCODE='PT409'; END IF;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_group_queue_origin_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE j app_private.hermes_group_jobs; h app_private.hermes_group_dispatches; v_queue jsonb;
BEGIN
  SELECT * INTO j FROM app_private.hermes_group_jobs WHERE job_id=NEW.id;
  IF j.job_id IS NULL AND NEW.hermes_group_dispatch_id IS NULL THEN RETURN NEW; END IF;
  v_queue:=jsonb_build_object('id',NEW.id,'user_id',NEW.user_id,'organization_id',NEW.organization_id,'account_id',NEW.account_id,
    'conversation_id',NEW.conversation_id,'message_id',NEW.message_id,'channel',NEW.channel,'payload',NEW.payload);
  IF j.job_id IS NULL OR NEW.hermes_group_dispatch_id IS DISTINCT FROM j.dispatch_id OR v_queue IS DISTINCT FROM j.queue_snapshot
    THEN RAISE EXCEPTION 'hermes_group_job_immutable' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.hermes_group_dispatch_id IS DISTINCT FROM NEW.hermes_group_dispatch_id
      OR (OLD.provider_started_at IS NOT NULL AND NEW.provider_started_at IS DISTINCT FROM OLD.provider_started_at)
      THEN RAISE EXCEPTION 'hermes_group_job_immutable' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO h FROM app_private.hermes_group_dispatches WHERE id=j.dispatch_id;
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS DISTINCT FROM h.user_id
    OR h.expires_at<=clock_timestamp() OR NEW.organization_id IS DISTINCT FROM h.organization_id
    OR NEW.account_id::text IS DISTINCT FROM h.snapshot#>>'{sender,accountId}'
    OR NEW.user_id::text IS DISTINCT FROM h.snapshot#>>'{sender,accountOwnerId}' OR NEW.channel IS DISTINCT FROM 'personal'
    OR NEW.payload IS DISTINCT FROM jsonb_build_object('type','text','body',h.body)
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(h.snapshot->'recipients') r WHERE r->>'conversationId'=NEW.conversation_id::text)
    OR NOT EXISTS(SELECT 1 FROM public.zalo_messages m WHERE m.id=NEW.message_id AND m.sent_by=h.user_id
      AND m.organization_id=h.organization_id AND m.account_id=NEW.account_id AND m.conversation_id=NEW.conversation_id
      AND m.direction='out' AND m.msg_type='text' AND m.body=h.body AND m.status='pending')
    THEN RAISE EXCEPTION 'hermes_group_enqueue_denied' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS hermes_group_queue_origin ON public.zalo_send_queue;
CREATE TRIGGER hermes_group_queue_origin AFTER INSERT OR UPDATE ON public.zalo_send_queue
  FOR EACH ROW EXECUTE FUNCTION app_private.hermes_group_queue_origin_v1();

CREATE OR REPLACE FUNCTION public.hermes_group_send_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_decision jsonb; v_snapshot jsonb; v_body text; v_dispatch jsonb; v_receipts jsonb:='[]'; v_queue jsonb;
  h app_private.hermes_group_dispatches; c app_private.hermes_connections; q app_private.hermes_zalo_private_commands;
  z public.zalo_conversations; v_exp timestamptz; v_request uuid; v_group jsonb; v_msg uuid; v_job uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  -- Fixed 15-key request. No model-controlled body/actor/account or claimed
  -- verified context. The actual Auth JWT and active command claim are checked.
  v_decision:=public.hermes_group_preview_decision_v1(p);
  v_snapshot:=app_private.hermes_group_current_v1(p);
  v_decision:=public.hermes_group_preview_decision_v1(p);
  IF v_snapshot#>>'{owner,userId}' IS DISTINCT FROM auth.uid()::text THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  v_request:=(p->>'requestId')::uuid;
  -- Command row is locked by current_v1; one DM command has at most one
  -- durable dispatch, even if requestId or model intent changes after lost ACK.
  SELECT * INTO h FROM app_private.hermes_group_dispatches WHERE command_id=(p->>'commandId')::uuid;
  IF FOUND THEN
    IF h.user_id IS DISTINCT FROM auth.uid() OR (h.request-'requestId') IS DISTINCT FROM (p-'requestId')
      OR h.snapshot IS DISTINCT FROM v_snapshot OR h.expires_at<=clock_timestamp()
      OR EXISTS(SELECT 1 FROM app_private.hermes_group_jobs j JOIN public.zalo_send_queue job ON job.id=j.job_id
        WHERE j.dispatch_id=h.id AND job.status<>'queued') THEN
      RAISE EXCEPTION 'hermes_group_request_reused' USING ERRCODE='PT409';
    END IF;
    SELECT jsonb_agg(jsonb_build_object('conversationId',j.conversation_id,'jobId',j.job_id,'status','queued') ORDER BY j.conversation_id)
      INTO v_receipts FROM app_private.hermes_group_jobs j WHERE dispatch_id=h.id;
    IF jsonb_array_length(v_receipts) IS DISTINCT FROM jsonb_array_length(h.snapshot->'recipients')
      THEN RAISE EXCEPTION 'hermes_group_origin_changed' USING ERRCODE='PT409'; END IF;
  ELSE
    SELECT 'PHÒNG ĐÃ CHỌN'||E'\n'||string_agg(ord::text||'. '||(f->>'buildingLabel')||' · '||(f->>'roomLabel')||' | '||
      regexp_replace(regexp_replace(app_private.hermes_group_number_vi_v1((f->>'areaM2')::numeric),',00$',''),'(,[0-9])0$','\1')||' m² | '||
      regexp_replace(regexp_replace(app_private.hermes_group_number_vi_v1((f->>'rentVnd')::numeric),',00$',''),'(,[0-9])0$','\1')||' đ/tháng | '||
      (f#>>'{availability,label}'),E'\n' ORDER BY ord) INTO v_body
      FROM jsonb_array_elements(v_snapshot->'publicFacts') WITH ORDINALITY AS facts(f,ord);
    SELECT * INTO c FROM app_private.hermes_connections WHERE id=(p->>'connectionId')::uuid;
    SELECT * INTO q FROM app_private.hermes_zalo_private_commands WHERE id=(p->>'commandId')::uuid;
    SELECT LEAST(clock_timestamp()+interval '5 minutes',q.expires_at,s.expires_at,t.expires_at,t.created_at+interval '30 days',m.valid_to)
      INTO v_exp FROM app_private.hermes_sessions s CROSS JOIN app_private.hermes_connection_tokens t
        CROSS JOIN public.organization_memberships m WHERE s.id=c.credential_ref AND t.token_digest=p->>'tokenDigest' AND m.id=(p->>'expectedMembershipId')::uuid;
    IF v_exp IS NULL OR v_exp<=clock_timestamp() THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
    INSERT INTO app_private.hermes_group_dispatches(id,user_id,organization_id,command_id,request_id,request,snapshot,body,payload_digest,expires_at)
      VALUES(v_request,auth.uid(),c.organization_id,q.id,v_request,p,v_snapshot,v_body,
        sha256(convert_to(jsonb_build_object('request',p,'snapshot',v_snapshot,'body',v_body)::text,'UTF8')),v_exp) RETURNING * INTO h;
    FOR v_group IN SELECT value FROM jsonb_array_elements(v_snapshot->'recipients') ORDER BY value->>'conversationId' LOOP
      SELECT * INTO z FROM public.zalo_conversations WHERE id=(v_group->>'conversationId')::uuid;
      v_msg:=gen_random_uuid(); v_job:=gen_random_uuid();
      INSERT INTO public.zalo_messages(id,user_id,organization_id,conversation_id,account_id,direction,msg_type,body,status,sent_by,sent_at,client_dedup_key)
        VALUES(v_msg,z.user_id,h.organization_id,z.id,z.account_id,'out','text',h.body,'pending',h.user_id,clock_timestamp(),'hermes-group:'||h.id||':'||z.id);
      v_queue:=jsonb_build_object('id',v_job,'user_id',z.user_id,'organization_id',h.organization_id,'account_id',z.account_id,
        'conversation_id',z.id,'message_id',v_msg,'channel','personal','payload',jsonb_build_object('type','text','body',h.body));
      -- Reserve private provenance before INSERT; the deferred FK verifies the
      -- queue row at commit. A generic enqueue cannot mint this reservation.
      INSERT INTO app_private.hermes_group_jobs(job_id,dispatch_id,conversation_id,queue_snapshot) VALUES(v_job,h.id,z.id,v_queue);
      INSERT INTO public.zalo_send_queue(id,user_id,organization_id,conversation_id,account_id,message_id,channel,payload,status,hermes_group_dispatch_id)
        VALUES(v_job,z.user_id,h.organization_id,z.id,z.account_id,v_msg,'personal',jsonb_build_object('type','text','body',h.body),'queued',h.id);
      UPDATE public.zalo_conversations SET last_message_text=h.body,last_message_at=clock_timestamp(),last_message_dir='out',updated_at=clock_timestamp() WHERE id=z.id;
      v_receipts:=v_receipts||jsonb_build_array(jsonb_build_object('conversationId',z.id,'jobId',v_job,'status','queued'));
    END LOOP;
  END IF;
  v_dispatch:=jsonb_build_object('id',h.id,'expiresAt',to_char(h.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'recipients',v_receipts);
  RETURN v_decision||jsonb_build_object('dispatch',v_dispatch);
END $fn$;

CREATE OR REPLACE FUNCTION public.zalo_worker_begin_hermes_group_provider_v1(p_job_id uuid,p_instance_id uuid,p_delivery jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE j app_private.hermes_group_jobs; h app_private.hermes_group_dispatches; q public.zalo_send_queue;
  m public.zalo_messages; ingress app_private.hermes_zalo_ingress_sessions; v_thread text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RETURN false; END IF;
  SELECT * INTO j FROM app_private.hermes_group_jobs WHERE job_id=p_job_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO h FROM app_private.hermes_group_dispatches WHERE id=j.dispatch_id;
  -- Current actor rights/restrictions and source facts first, before worker or
  -- job locks. The command may now be READY; it need not remain DISPATCHED.
  PERFORM app_private.hermes_group_assert_dispatch_v1(h.id);
  PERFORM 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id
    AND heartbeat_at>clock_timestamp()-interval '30 seconds' AND heartbeat_at<=clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO q FROM public.zalo_send_queue WHERE id=p_job_id FOR UPDATE;
  SELECT * INTO m FROM public.zalo_messages WHERE id=q.message_id FOR SHARE;
  SELECT * INTO ingress FROM app_private.hermes_zalo_ingress_sessions WHERE account_id=q.account_id;
  SELECT r->>'threadId' INTO v_thread FROM jsonb_array_elements(h.snapshot->'recipients') r WHERE r->>'conversationId'=q.conversation_id::text;
  IF q.status IS DISTINCT FROM 'processing' OR q.processing_instance_id IS DISTINCT FROM p_instance_id OR q.provider_started_at IS NOT NULL
    OR q.hermes_group_dispatch_id IS DISTINCT FROM h.id OR m.body IS DISTINCT FROM h.body OR m.sent_by IS DISTINCT FROM h.user_id
    OR m.status IS DISTINCT FROM 'pending' OR m.direction IS DISTINCT FROM 'out' OR m.msg_type IS DISTINCT FROM 'text'
    OR m.account_id IS DISTINCT FROM q.account_id OR m.conversation_id IS DISTINCT FROM q.conversation_id OR m.organization_id IS DISTINCT FROM h.organization_id
    OR p_delivery IS DISTINCT FROM jsonb_build_object('method','sendMessage','body',h.body,'threadId',v_thread,'threadType','group',
      'ownUid',h.snapshot#>>'{sender,ownUid}','generation',h.snapshot#>>'{sender,ingressGeneration}')
    OR ingress.instance_id IS DISTINCT FROM p_instance_id
    OR jsonb_build_object('id',q.id,'user_id',q.user_id,'organization_id',q.organization_id,'account_id',q.account_id,
      'conversation_id',q.conversation_id,'message_id',q.message_id,'channel',q.channel,'payload',q.payload) IS DISTINCT FROM j.queue_snapshot
    THEN RETURN false; END IF;
  UPDATE public.zalo_send_queue SET provider_started_at=clock_timestamp() WHERE id=q.id;
  RETURN true;
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_group_send_status_v1(p_dispatch_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE h app_private.hermes_group_dispatches; c app_private.hermes_connections; policy app_private.hermes_org_policies;
  s app_private.hermes_sessions; v_auth record; v_rows jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO h FROM app_private.hermes_group_dispatches WHERE id=p_dispatch_id AND user_id=auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_group_not_found' USING ERRCODE='P0002'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(h.organization_id);
  PERFORM app_private.hermes_member_v1(auth.uid(),h.organization_id);
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=(h.snapshot#>>'{owner,connectionId}')::uuid;
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref FOR SHARE;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=(h.snapshot#>>'{owner,connectionId}')::uuid FOR SHARE;
  SELECT * INTO policy FROM app_private.hermes_org_policies WHERE organization_id=h.organization_id FOR SHARE;
  IF c.id IS NULL OR c.user_id IS DISTINCT FROM auth.uid() OR c.organization_id IS DISTINCT FROM h.organization_id OR c.state<>'ACTIVE'
    OR c.revoked_at IS NOT NULL OR s.id IS DISTINCT FROM c.credential_ref OR s.state IS DISTINCT FROM 'ACTIVE'
    OR s.user_id IS DISTINCT FROM c.user_id OR s.organization_id IS DISTINCT FROM c.organization_id OR s.assistant_id IS DISTINCT FROM c.assistant_id
    OR s.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
    OR s.quarantine_reason IS NOT NULL OR s.expires_at<=clock_timestamp() OR policy.organization_id IS NULL OR NOT policy.enabled
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_assistants WHERE id=c.assistant_id AND user_id=auth.uid() AND organization_id=h.organization_id AND state='ACTIVE')
    OR NOT('chat_zalo.view'=ANY(c.read_capabilities)) OR NOT('chat_zalo.view'=ANY(policy.read_capabilities))
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.view' AND mode='read' AND enabled)
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_auth FROM app_private.authorize_tenant_action_v3(auth.uid(),h.organization_id,'chat_zalo.view');
  IF v_auth.allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  -- Expired dispatches remain readable with CURRENT group-read authority. Status never retries
  -- delivery; unknown has priority over the queue's coarse failed/sent field.
  SELECT jsonb_agg(jsonb_build_object('conversationId',j.conversation_id,'jobId',j.job_id,'name',z.peer_name,
    'status',CASE WHEN q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true' THEN 'unknown'
      WHEN q.status='sent' THEN 'sent' WHEN q.status='failed' THEN 'failed' WHEN q.status='processing' THEN 'processing' ELSE 'queued' END)
    ORDER BY j.conversation_id) INTO v_rows FROM app_private.hermes_group_jobs j JOIN public.zalo_send_queue q ON q.id=j.job_id
    JOIN public.zalo_conversations z ON z.id=j.conversation_id AND z.organization_id=h.organization_id
      AND z.account_id=(h.snapshot#>>'{sender,accountId}')::uuid AND z.thread_type='group'
    CROSS JOIN LATERAL jsonb_array_elements(h.snapshot->'recipients') r
    WHERE j.dispatch_id=h.id AND r->>'conversationId'=j.conversation_id::text;
  IF jsonb_array_length(v_rows) IS DISTINCT FROM jsonb_array_length(h.snapshot->'recipients')
    THEN RAISE EXCEPTION 'hermes_group_origin_changed' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('id',h.id,'expiresAt',to_char(h.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'recipients',v_rows);
END $fn$;

-- WORKER_FENCE_AND_ACL
DO $patch$
DECLARE v_signature regprocedure:=to_regprocedure('public.zalo_worker_begin_provider_v1(uuid,uuid)'); v_definition text; v_sha text; v_before record; v_after record;
BEGIN
  IF v_signature IS NULL THEN RAISE EXCEPTION 'missing public.zalo_worker_begin_provider_v1'; END IF;
  SELECT proowner,proacl,provolatile,prosecdef,proconfig INTO v_before FROM pg_proc WHERE oid=v_signature;
  IF v_before.proowner IS DISTINCT FROM 'postgres'::regrole OR v_before.provolatile IS DISTINCT FROM 'v'::"char" OR NOT v_before.prosecdef THEN
    RAISE EXCEPTION 'unexpected public.zalo_worker_begin_provider_v1 security metadata';
  END IF;
  SELECT encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex'),replace(pg_get_functiondef(oid),E'\r\n',E'\n')
    INTO v_sha,v_definition FROM pg_proc WHERE oid=v_signature;
  IF v_sha='73deb1cf865ce3b77369e8203051cb34b58dc046f5efc95f3a8bea9a8b99ad65' THEN RETURN; END IF;
  IF v_sha IS DISTINCT FROM '2310b70ca4b48ba39cbda53f5baba9df5995f8c3eb028965f52dbd55f12a9402' THEN RAISE EXCEPTION 'unexpected public.zalo_worker_begin_provider_v1 source %',v_sha; END IF;
  v_definition:=replace(v_definition,$old0$BEGIN
  PERFORM 1 FROM public.zalo_worker_lease$old0$,$new0$BEGIN
  IF EXISTS(SELECT 1 FROM app_private.hermes_group_jobs WHERE job_id=p_job_id) THEN RETURN false; END IF;
  PERFORM 1 FROM public.zalo_worker_lease$new0$);
  EXECUTE v_definition;
  SELECT proowner,proacl,provolatile,prosecdef,proconfig INTO v_after FROM pg_proc WHERE oid=v_signature;
  SELECT encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex') INTO v_sha FROM pg_proc WHERE oid=v_signature;
  IF v_after IS DISTINCT FROM v_before OR v_sha IS DISTINCT FROM '73deb1cf865ce3b77369e8203051cb34b58dc046f5efc95f3a8bea9a8b99ad65' THEN RAISE EXCEPTION 'patch attestation failed public.zalo_worker_begin_provider_v1'; END IF;
END $patch$;

ALTER FUNCTION app_private.hermes_group_immutable_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_group_immutable_v1() FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

ALTER FUNCTION app_private.hermes_group_number_vi_v1(numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_group_number_vi_v1(numeric) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

ALTER FUNCTION app_private.hermes_group_room_fact_v1(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_group_room_fact_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

ALTER FUNCTION app_private.hermes_group_current_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_group_current_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

ALTER FUNCTION app_private.hermes_group_assert_dispatch_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_group_assert_dispatch_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

ALTER FUNCTION app_private.hermes_group_queue_origin_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_group_queue_origin_v1() FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

ALTER FUNCTION public.hermes_group_send_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_group_send_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_group_send_v1(jsonb) TO authenticated;

ALTER FUNCTION public.hermes_group_send_status_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_group_send_status_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_group_send_status_v1(uuid) TO authenticated;

ALTER FUNCTION public.zalo_worker_begin_provider_v1(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.zalo_worker_begin_provider_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.zalo_worker_begin_provider_v1(uuid,uuid) TO service_role;

ALTER FUNCTION public.zalo_worker_begin_hermes_group_provider_v1(uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.zalo_worker_begin_hermes_group_provider_v1(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.zalo_worker_begin_hermes_group_provider_v1(uuid,uuid,jsonb) TO service_role;

COMMIT;
NOTIFY pgrst,'reload schema';
