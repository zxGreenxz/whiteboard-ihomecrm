-- Draft forward migration; allocate its timestamp with tao-ten-migration.mjs
-- when integration ownership is granted. No Copilot schema/RPC is changed.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE TABLE IF NOT EXISTS app_private.hermes_room_schedules (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  connection_id uuid NOT NULL REFERENCES app_private.hermes_connections(id),
  grant_id uuid NOT NULL,
  revision bigint NOT NULL CHECK(revision>0 AND revision<9007199254740991),
  state text NOT NULL CHECK(state IN ('ACTIVE','REVOKED')),
  last_request_id uuid NOT NULL,
  last_request_digest bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  last_polled_at timestamptz,
  CHECK((state='REVOKED')=(revoked_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS app_private.hermes_schedule_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES app_private.hermes_room_schedules(id) DEFERRABLE INITIALLY DEFERRED,
  revision bigint NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  connection_id uuid NOT NULL REFERENCES app_private.hermes_connections(id),
  binding_id uuid NOT NULL REFERENCES app_private.hermes_zalo_bindings(id),
  binding_epoch bigint NOT NULL,
  account_id uuid NOT NULL REFERENCES public.zalo_accounts(id),
  settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object'),
  request_id uuid NOT NULL,
  request_digest bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  UNIQUE(schedule_id,revision),
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days')
);
DO $migration$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_private.hermes_room_schedules'::regclass AND conname='hermes_room_schedules_grant_fk') THEN
    ALTER TABLE app_private.hermes_room_schedules ADD CONSTRAINT hermes_room_schedules_grant_fk
      FOREIGN KEY(grant_id) REFERENCES app_private.hermes_schedule_grants(id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $migration$;
CREATE TABLE IF NOT EXISTS app_private.hermes_schedule_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES app_private.hermes_room_schedules(id),
  grant_id uuid NOT NULL REFERENCES app_private.hermes_schedule_grants(id),
  local_date date NOT NULL,
  conversation_id uuid NOT NULL REFERENCES public.zalo_conversations(id),
  outcome text NOT NULL CHECK(outcome IN ('queued','no_rooms','missed')),
  dispatch_id uuid REFERENCES app_private.hermes_group_dispatches(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(schedule_id,local_date,conversation_id),
  CHECK((outcome='queued')=(dispatch_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS app_private.hermes_schedule_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES app_private.hermes_room_schedules(id),
  grant_id uuid NOT NULL REFERENCES app_private.hermes_schedule_grants(id),
  actor uuid NOT NULL REFERENCES auth.users(id),
  event text NOT NULL CHECK(event IN ('created','updated','revoked')),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS hermes_room_schedules_active ON app_private.hermes_room_schedules(organization_id,connection_id) WHERE state='ACTIVE';
CREATE INDEX IF NOT EXISTS hermes_schedule_runs_day ON app_private.hermes_schedule_runs(schedule_id,local_date,created_at);
DO $permissions$ DECLARE n text; BEGIN
  FOREACH n IN ARRAY ARRAY['hermes_room_schedules','hermes_schedule_grants','hermes_schedule_runs','hermes_schedule_events'] LOOP
    EXECUTE format('ALTER TABLE app_private.%I OWNER TO postgres',n);
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',n);
    EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',n);
  END LOOP;
END $permissions$;
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_immutable_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN RAISE EXCEPTION 'hermes_schedule_evidence_immutable' USING ERRCODE='42501'; END $fn$;
DO $triggers$ DECLARE n text; BEGIN
  FOREACH n IN ARRAY ARRAY['hermes_schedule_grants','hermes_schedule_runs','hermes_schedule_events'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS hermes_schedule_immutable ON app_private.%I',n);
    EXECUTE format('CREATE TRIGGER hermes_schedule_immutable BEFORE UPDATE OR DELETE ON app_private.%I FOR EACH ROW EXECUTE FUNCTION app_private.hermes_schedule_immutable_v1()',n);
  END LOOP;
END $triggers$;

-- Canonical settings have no actor/org/account/credential fields. All targets
-- are current CRM IDs; names, model output and saved content grant no access.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_settings_v1(p jsonb,p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE k text; ids uuid[]; days integer[]; expiry timestamptz; result jsonb:=p;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>9
    OR NOT(p ?& ARRAY['template','buildingIds','conversationIds','weekdays','time','timeZone','maxRooms','maxMessagesPerDay','expiresAt'])
    OR p->>'template' IS DISTINCT FROM 'rooms_public_text_v1' OR p->>'timeZone' IS DISTINCT FROM app_private.org_timezone_v1(p_org)
    OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=p->>'timeZone')
    OR jsonb_typeof(p->'time') IS DISTINCT FROM 'string' OR p->>'time' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
  FOREACH k IN ARRAY ARRAY['buildingIds','conversationIds'] LOOP
    IF jsonb_typeof(p->k) IS DISTINCT FROM 'array' OR jsonb_array_length(p->k) NOT BETWEEN 1 AND (CASE WHEN k='buildingIds' THEN 20 ELSE 8 END)
      THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
    SELECT array_agg(app_private.hermes_uuid_v1(value) ORDER BY value#>>'{}') INTO ids FROM jsonb_array_elements(p->k);
    IF cardinality(ids)<>(SELECT count(DISTINCT x) FROM unnest(ids) x) THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
    result:=jsonb_set(result,ARRAY[k],to_jsonb(ids));
  END LOOP;
  IF jsonb_typeof(p->'weekdays') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'weekdays') NOT BETWEEN 1 AND 7
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'weekdays') d WHERE jsonb_typeof(d)<>'number' OR d::text !~ '^[1-7]$')
    THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
  SELECT array_agg(d::integer ORDER BY d::integer) INTO days FROM jsonb_array_elements_text(p->'weekdays') d;
  IF cardinality(days)<>(SELECT count(DISTINCT d) FROM unnest(days) d) THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
  result:=jsonb_set(result,'{weekdays}',to_jsonb(days));
  FOREACH k IN ARRAY ARRAY['maxRooms','maxMessagesPerDay'] LOOP
    IF jsonb_typeof(p->k) IS DISTINCT FROM 'number' OR p->>k !~ '^[1-9][0-9]{0,2}$'
      OR (p->>k)::integer>(CASE WHEN k='maxRooms' THEN 20 ELSE 200 END) THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (p->>'maxMessagesPerDay')::integer<jsonb_array_length(p->'conversationIds') OR jsonb_typeof(p->'expiresAt') IS DISTINCT FROM 'string'
    OR p->>'expiresAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
  BEGIN expiry:=(p->>'expiresAt')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END;
  IF expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '30 days' THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
  RETURN result;
END $fn$;

-- Worker supplies only the persisted schedule ID. Resolve the currently live
-- credential/session/member revisions internally; no worker JWT impersonation
-- and no saved access token or model-supplied actor is accepted.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_binding_v1(p_grant app_private.hermes_schedule_grants,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; session app_private.hermes_sessions; token app_private.hermes_connection_tokens;
  policy app_private.hermes_org_policies; member jsonb;
BEGIN
  PERFORM app_private.lock_org_for_decision_v1(p_grant.organization_id);
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=p_grant.connection_id;
  IF c.user_id IS DISTINCT FROM p_grant.user_id OR c.organization_id IS DISTINCT FROM p_grant.organization_id
    THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO session FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  SELECT * INTO token FROM app_private.hermes_connection_tokens WHERE connection_id=c.id AND revoked_at IS NULL
    AND expires_at>clock_timestamp() AND created_at+interval '30 days'>clock_timestamp() ORDER BY created_at DESC,token_digest LIMIT 1;
  IF token.token_digest IS NULL THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
  RETURN jsonb_build_object('connectionId',c.id,'tokenDigest',token.token_digest,'expectedEpoch',c.epoch,
    'expectedPolicyVersion',policy.version,'expectedMembershipId',member->'membershipId','expectedAuthorizationVersion',member->'authorizationVersion',
    'expectedSessionRevision',session.revision,'requestId',p_request);
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_schedule_current_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s app_private.hermes_room_schedules; g app_private.hermes_schedule_grants; x app_private.hermes_zalo_bindings;
  context jsonb; current jsonb; org uuid;
BEGIN
  SELECT organization_id INTO org FROM app_private.hermes_room_schedules WHERE id=(p->>'scheduleId')::uuid;
  IF org IS NULL THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(org);
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes-room-schedule:'||org::text,0));
  SELECT * INTO s FROM app_private.hermes_room_schedules WHERE id=(p->>'scheduleId')::uuid FOR SHARE;
  SELECT * INTO g FROM app_private.hermes_schedule_grants WHERE id=s.grant_id;
  IF s.state<>'ACTIVE' OR g.id::text IS DISTINCT FROM p->>'grantId' OR s.revision::text IS DISTINCT FROM p->>'scheduleRevision'
    OR g.expires_at<=clock_timestamp() OR g.connection_id::text IS DISTINCT FROM p->>'connectionId'
    OR g.user_id IS DISTINCT FROM s.user_id OR g.organization_id IS DISTINCT FROM s.organization_id
    THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  context:=app_private.hermes_external_group_context_v1(p-ARRAY['scheduleId','grantId','scheduleRevision','roomIds','conversationIds','expectedContextVersion','intentDigest','roomReadDigest']);
  SELECT * INTO x FROM app_private.hermes_zalo_bindings WHERE id=g.binding_id;
  IF x.state IS DISTINCT FROM 'ACTIVE' OR x.revoked_at IS NOT NULL OR x.epoch IS DISTINCT FROM g.binding_epoch
    OR x.account_id IS DISTINCT FROM g.account_id OR x.connection_id IS DISTINCT FROM g.connection_id
    OR context#>>'{recipientRead,sender,accountId}' IS DISTINCT FROM g.account_id::text
    THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_schedule_scope_v1(g.connection_id,g.settings,context);
  PERFORM app_private.hermes_schedule_owner_v1(s.id,s.organization_id,g.settings);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'conversationIds') id WHERE NOT(g.settings->'conversationIds' ? id))
    OR EXISTS(SELECT 1 FROM public.rooms r WHERE p->'roomIds' ? r.id::text AND NOT(g.settings->'buildingIds' ? r.building_id::text))
    OR jsonb_array_length(p->'roomIds')>(g.settings->>'maxRooms')::integer
    THEN RAISE EXCEPTION 'hermes_schedule_scope_denied' USING ERRCODE='42501'; END IF;
  current:=app_private.hermes_external_group_current_v1(p-ARRAY['scheduleId','grantId','scheduleRevision']);
  RETURN current||jsonb_build_object('origin','standing_grant','scheduleId',s.id,'grantId',g.id,'scheduleRevision',s.revision);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_room_schedule_due_v1(p_instance_id uuid,p_organization_ids uuid[] DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' OR p_organization_ids IS NULL OR cardinality(p_organization_ids)>100
    OR NOT EXISTS(SELECT 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id
      AND heartbeat_at>clock_timestamp()-interval '30 seconds' AND heartbeat_at<=clock_timestamp())
    THEN RAISE EXCEPTION 'hermes_schedule_worker_denied' USING ERRCODE='42501'; END IF;
  -- Persist candidate progress before attempting runs. Failed ACL/temporary
  -- backpressure cannot keep the same first 100 schedules at the head forever.
  WITH candidates AS (SELECT s.id FROM app_private.hermes_room_schedules s JOIN app_private.hermes_schedule_grants g ON g.id=s.grant_id
    WHERE s.state='ACTIVE' AND g.expires_at>clock_timestamp() AND (cardinality(p_organization_ids)=0 OR s.organization_id=ANY(p_organization_ids))
      AND g.settings->>'timeZone'=app_private.org_timezone_v1(s.organization_id)
      AND g.settings->'weekdays' @> to_jsonb(extract(isodow FROM clock_timestamp() AT TIME ZONE (g.settings->>'timeZone'))::integer)
      AND (clock_timestamp() AT TIME ZONE (g.settings->>'timeZone'))::time>=(g.settings->>'time')::time
      AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(g.settings->'conversationIds') target WHERE NOT EXISTS(
        SELECT 1 FROM app_private.hermes_schedule_runs r WHERE r.schedule_id=s.id AND r.conversation_id::text=target
          AND r.local_date=(clock_timestamp() AT TIME ZONE (g.settings->>'timeZone'))::date))
    ORDER BY s.last_polled_at NULLS FIRST,s.id LIMIT 100 FOR UPDATE OF s SKIP LOCKED),
  polled AS (UPDATE app_private.hermes_room_schedules s SET last_polled_at=clock_timestamp()
    FROM candidates c WHERE s.id=c.id RETURNING s.id,s.revision)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('scheduleId',id,'revision',revision) ORDER BY id),'[]'::jsonb) INTO result FROM polled;
  RETURN result;
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_room_schedule_run_v1(p_schedule_id uuid,p_expected_revision bigint,p_instance_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s app_private.hermes_room_schedules; g app_private.hermes_schedule_grants; z public.zalo_conversations;
  context jsonb; binding jsonb; snapshot jsonb; request jsonb; room_ids uuid[]; room public.rooms; building public.buildings;
  fact record; selected uuid; org uuid; today date; local_now timestamp; scheduled timestamp; previous timestamptz;
  dispatch uuid:=gen_random_uuid(); message_id uuid; job_id uuid; queue jsonb; body text; expiry timestamptz;
  soon_days integer; has_pass boolean; count_today integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'hermes_schedule_worker_denied' USING ERRCODE='42501'; END IF;
  SELECT organization_id INTO org FROM app_private.hermes_room_schedules WHERE id=p_schedule_id;
  IF org IS NULL THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(org);
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes-room-schedule:'||org::text,0));
  SELECT * INTO s FROM app_private.hermes_room_schedules WHERE id=p_schedule_id FOR UPDATE;
  SELECT * INTO g FROM app_private.hermes_schedule_grants WHERE id=s.grant_id;
  IF s.state<>'ACTIVE' OR s.revision<>p_expected_revision OR g.expires_at<=clock_timestamp()
    THEN RETURN jsonb_build_object('status','skipped','reason','inactive_or_changed'); END IF;
  binding:=app_private.hermes_schedule_binding_v1(g,dispatch);
  context:=app_private.hermes_external_group_context_v1(binding);
  PERFORM app_private.hermes_schedule_scope_v1(g.connection_id,g.settings,context);
  PERFORM app_private.hermes_schedule_owner_v1(s.id,s.organization_id,g.settings);
  IF NOT EXISTS(SELECT 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id
    AND heartbeat_at>clock_timestamp()-interval '30 seconds' AND heartbeat_at<=clock_timestamp())
    THEN RAISE EXCEPTION 'hermes_schedule_worker_denied' USING ERRCODE='42501'; END IF;
  local_now:=clock_timestamp() AT TIME ZONE (g.settings->>'timeZone'); today:=local_now::date;
  scheduled:=today+(g.settings->>'time')::time;
  IF NOT(g.settings->'weekdays' @> to_jsonb(extract(isodow FROM local_now)::integer)) OR local_now<scheduled
    THEN RETURN jsonb_build_object('status','skipped','reason','not_due'); END IF;
  SELECT target::uuid INTO selected FROM jsonb_array_elements_text(g.settings->'conversationIds') target WHERE NOT EXISTS(
    SELECT 1 FROM app_private.hermes_schedule_runs r WHERE r.schedule_id=s.id AND r.local_date=today AND r.conversation_id::text=target) ORDER BY target LIMIT 1;
  IF selected IS NULL THEN RETURN jsonb_build_object('status','already_run'); END IF;
  -- Existing automation catch-up limit is 180 minutes. Close all remaining
  -- recipients for a missed day, never replay a backlog after downtime.
  IF local_now>scheduled+interval '180 minutes' THEN
    INSERT INTO app_private.hermes_schedule_runs(schedule_id,grant_id,local_date,conversation_id,outcome)
      SELECT s.id,g.id,today,target::uuid,'missed' FROM jsonb_array_elements_text(g.settings->'conversationIds') target
      ON CONFLICT(schedule_id,local_date,conversation_id) DO NOTHING;
    RETURN jsonb_build_object('status','skipped','reason','missed_window');
  END IF;
  SELECT max(created_at),count(*) FILTER(WHERE outcome='queued') INTO previous,count_today FROM app_private.hermes_schedule_runs
    WHERE schedule_id=s.id AND local_date=today;
  IF previous>clock_timestamp()-interval '180 seconds' THEN RETURN jsonb_build_object('status','skipped','reason','recipient_spacing'); END IF;
  IF count_today>=(g.settings->>'maxMessagesPerDay')::integer THEN RETURN jsonb_build_object('status','skipped','reason','daily_limit'); END IF;
  IF (SELECT count(*) FROM public.zalo_send_queue WHERE organization_id=org AND status IN ('queued','processing'))>=200
    THEN RETURN jsonb_build_object('status','skipped','reason','queue_capacity'); END IF;
  -- Fresh public-sale facts. Do not turn an unexpected formatter error into an
  -- empty report; only rooms the shared sale fact marks free/soon are selected.
  room_ids:='{}';
  FOR room IN SELECT * FROM public.rooms r WHERE r.organization_id=org AND r.deleted_at IS NULL
    AND g.settings->'buildingIds' ? r.building_id::text ORDER BY r.building_id,r.id LOOP
    SELECT * INTO building FROM public.buildings WHERE id=room.building_id AND organization_id=org AND deleted_at IS NULL AND NOT is_virtual;
    IF building.id IS NULL THEN RAISE EXCEPTION 'hermes_schedule_scope_denied' USING ERRCODE='42501'; END IF;
    SELECT p.soon_days INTO soon_days FROM public.public_room_settings p WHERE p.owner_id=building.user_id
      AND (p.organization_id=org OR p.organization_id IS NULL) ORDER BY p.organization_id NULLS LAST LIMIT 1;
    SELECT EXISTS(SELECT 1 FROM public.room_pass_listings WHERE room_id=room.id AND user_id=building.user_id
      AND (organization_id=org OR organization_id IS NULL) AND active) INTO has_pass;
    SELECT * INTO fact FROM app_private.room_sale_workflow_fact_v1(room.id,org,room.status::text,has_pass,COALESCE(soon_days,30));
    IF fact.status_public IN ('free','soon') THEN room_ids:=array_append(room_ids,room.id); END IF;
    EXIT WHEN cardinality(room_ids)>(g.settings->>'maxRooms')::integer;
  END LOOP;
  IF cardinality(room_ids)=0 THEN
    INSERT INTO app_private.hermes_schedule_runs(schedule_id,grant_id,local_date,conversation_id,outcome) VALUES(s.id,g.id,today,selected,'no_rooms');
    RETURN jsonb_build_object('status','skipped','reason','no_rooms');
  END IF;
  -- Do not silently omit rooms when the user's bounded template is too small.
  IF cardinality(room_ids)>(g.settings->>'maxRooms')::integer THEN RETURN jsonb_build_object('status','skipped','reason','room_limit'); END IF;
  request:=binding||jsonb_build_object('roomIds',to_jsonb(room_ids),'conversationIds',jsonb_build_array(selected),
    'expectedContextVersion',context#>>'{authority,contextVersion}','intentDigest',encode(g.request_digest,'hex'),'roomReadDigest',repeat('0',64),
    'scheduleId',s.id,'grantId',g.id,'scheduleRevision',s.revision);
  snapshot:=app_private.hermes_schedule_current_v1(request);
  SELECT 'BẢN TIN PHÒNG TRỐNG'||E'\n'||string_agg(ord::text||'. '||(f->>'buildingLabel')||' · '||(f->>'roomLabel')||' | '||
    regexp_replace(regexp_replace(app_private.hermes_group_number_vi_v1((f->>'areaM2')::numeric),',00$',''),'(,[0-9])0$','\1')||' m² | '||
    regexp_replace(regexp_replace(app_private.hermes_group_number_vi_v1((f->>'rentVnd')::numeric),',00$',''),'(,[0-9])0$','\1')||' đ/tháng | '||
    (f#>>'{availability,label}'),E'\n' ORDER BY ord) INTO body FROM jsonb_array_elements(snapshot->'publicFacts') WITH ORDINALITY entry(f,ord);
  IF body IS NULL OR octet_length(body)>16000 THEN RAISE EXCEPTION 'hermes_schedule_message_invalid' USING ERRCODE='22023'; END IF;
  expiry:=LEAST(g.expires_at,clock_timestamp()+interval '5 minutes',
    (SELECT expires_at FROM app_private.hermes_connection_tokens WHERE token_digest=binding->>'tokenDigest'),
    (SELECT expires_at FROM app_private.hermes_sessions WHERE id=(SELECT credential_ref FROM app_private.hermes_connections WHERE id=g.connection_id)));
  INSERT INTO app_private.hermes_group_dispatches(id,user_id,organization_id,command_id,origin,request_id,request,snapshot,body,payload_digest,expires_at)
    VALUES(dispatch,g.user_id,org,NULL,'standing_grant',dispatch,request,snapshot,body,
      sha256(convert_to(jsonb_build_object('request',request,'snapshot',snapshot,'body',body)::text,'UTF8')),expiry);
  SELECT * INTO z FROM public.zalo_conversations WHERE id=selected;
  message_id:=gen_random_uuid(); job_id:=gen_random_uuid();
  INSERT INTO public.zalo_messages(id,user_id,organization_id,conversation_id,account_id,direction,msg_type,body,status,sent_by,sent_at,client_dedup_key)
    VALUES(message_id,z.user_id,org,z.id,z.account_id,'out','text',body,'pending',g.user_id,clock_timestamp(),'hermes-group:'||dispatch||':'||z.id);
  queue:=jsonb_build_object('id',job_id,'user_id',z.user_id,'organization_id',org,'account_id',z.account_id,
    'conversation_id',z.id,'message_id',message_id,'channel','personal','payload',jsonb_build_object('type','text','body',body));
  INSERT INTO app_private.hermes_group_jobs(job_id,dispatch_id,conversation_id,queue_snapshot) VALUES(job_id,dispatch,z.id,queue);
  INSERT INTO public.zalo_send_queue(id,user_id,organization_id,conversation_id,account_id,message_id,channel,payload,status,hermes_group_dispatch_id)
    VALUES(job_id,z.user_id,org,z.id,z.account_id,message_id,'personal',jsonb_build_object('type','text','body',body),'queued',dispatch);
  UPDATE public.zalo_conversations SET last_message_text=body,last_message_at=clock_timestamp(),last_message_dir='out',updated_at=clock_timestamp() WHERE id=z.id;
  INSERT INTO app_private.hermes_schedule_runs(schedule_id,grant_id,local_date,conversation_id,outcome,dispatch_id) VALUES(s.id,g.id,today,z.id,'queued',dispatch);
  RETURN jsonb_build_object('status','queued','dispatchId',dispatch,'conversationId',z.id);
END $fn$;

-- Ownership/authentication does not depend on the worker being online; revoking
-- a schedule remains possible while Zalo is disconnected. SQL holds the same
-- org decision lock used by connection/policy/CRM permission changes.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_actor_v1(p jsonb,p_manage boolean)
RETURNS app_private.hermes_connections LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; s app_private.hermes_sessions; policy app_private.hermes_org_policies; member jsonb; decision record; key text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p))<>8 OR NOT(p ?& ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion',
      'expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision','requestId']) THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  c:=app_private.hermes_private_command_connection_v1(p->>'tokenDigest');
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  IF c.user_id IS DISTINCT FROM auth.uid() OR s.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
    OR c.id::text IS DISTINCT FROM p->>'connectionId' OR c.epoch::text IS DISTINCT FROM p->>'expectedEpoch'
    OR policy.version::text IS DISTINCT FROM p->>'expectedPolicyVersion' OR s.revision::text IS DISTINCT FROM p->>'expectedSessionRevision'
    OR member->>'membershipId' IS DISTINCT FROM p->>'expectedMembershipId' OR member->>'authorizationVersion' IS DISTINCT FROM p->>'expectedAuthorizationVersion'
    THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  key:=CASE WHEN p_manage THEN 'chat_zalo.manage_automation' ELSE 'chat_zalo.view' END;
  SELECT * INTO decision FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,key);
  IF decision.allowed IS DISTINCT FROM true OR NOT(key=ANY(CASE WHEN p_manage THEN c.action_capabilities ELSE c.read_capabilities END))
    OR NOT(key=ANY(CASE WHEN p_manage THEN policy.action_capabilities ELSE policy.read_capabilities END))
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability=key AND enabled AND mode=CASE WHEN p_manage THEN 'action' ELSE 'read' END)
    THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  RETURN c;
END $fn$;

-- This is a restriction check over the existing explicit-actor CRM resolver,
-- never a parallel role map. Validate EVERY building even if it has no rooms.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_scope_v1(p_connection uuid,p_settings jsonb,p_context jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; policy app_private.hermes_org_policies; decision record; building uuid; scopes uuid[];
BEGIN
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=p_connection;
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  SELECT * INTO decision FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,'chat_zalo.manage_automation');
  IF decision.allowed IS DISTINCT FROM true OR NOT('chat_zalo.manage_automation'=ANY(c.action_capabilities))
    OR NOT('chat_zalo.manage_automation'=ANY(policy.action_capabilities))
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.manage_automation' AND mode='action' AND enabled)
    OR NOT(p_context#>'{authority,effective,read}' ?& ARRAY['rooms.view','chat_zalo.view'])
    OR NOT(p_context#>'{authority,effective,action}' ? 'chat_zalo.send')
    OR p_settings->>'timeZone' IS DISTINCT FROM app_private.org_timezone_v1(c.organization_id)
    THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  SELECT array_agg(x::uuid) INTO scopes FROM jsonb_array_elements_text(p_context#>'{authority,scopeIds}') x;
  FOR building IN SELECT x::uuid FROM jsonb_array_elements_text(p_settings->'buildingIds') x ORDER BY x LOOP
    SELECT * INTO decision FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,'rooms.view',building);
    IF decision.allowed IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM public.buildings WHERE id=building AND organization_id=c.organization_id AND deleted_at IS NULL AND NOT is_virtual)
      OR NOT EXISTS(SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(scopes) AND scope.organization_id=c.organization_id
        AND (scope.scope_type='ORGANIZATION' OR scope.scope_type='BUILDING' AND scope.building_id=building OR scope.scope_type='AREA' AND EXISTS(
          SELECT 1 FROM public.area_buildings edge JOIN public.areas ar ON ar.id=edge.area_id WHERE edge.area_id=scope.area_id
          AND edge.organization_id=c.organization_id AND edge.building_id=building AND ar.organization_id=c.organization_id AND ar.deleted_at IS NULL)))
      THEN RAISE EXCEPTION 'hermes_schedule_scope_denied' USING ERRCODE='42501'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_settings->'conversationIds') selected
    WHERE NOT(p_context#>'{recipientRead,allowedConversationIds}' ? selected)) THEN RAISE EXCEPTION 'hermes_schedule_target_denied' USING ERRCODE='42501'; END IF;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_schedule_summary_v1(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT jsonb_build_object('scheduleId',s.id,'revision',s.revision,'state',CASE WHEN s.state='ACTIVE' AND g.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE s.state END,'settings',g.settings,
    'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lastRuns',COALESCE((SELECT jsonb_agg(jsonb_build_object('date',r.local_date,'conversationId',r.conversation_id,'outcome',r.outcome,
      'dispatchId',r.dispatch_id,'deliveryStatus',CASE WHEN r.outcome<>'queued' THEN NULL ELSE COALESCE((
        SELECT CASE WHEN q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true' THEN 'unknown'
          WHEN q.status IN ('sent','failed','processing') THEN q.status ELSE 'queued' END
        FROM app_private.hermes_group_jobs j JOIN public.zalo_send_queue q ON q.id=j.job_id WHERE j.dispatch_id=r.dispatch_id),'unknown') END)
      ORDER BY r.created_at,r.conversation_id) FROM app_private.hermes_schedule_runs r
      WHERE r.schedule_id=s.id AND r.local_date=(SELECT max(local_date) FROM app_private.hermes_schedule_runs WHERE schedule_id=s.id)),'[]'::jsonb))
  FROM app_private.hermes_room_schedules s JOIN app_private.hermes_schedule_grants g ON g.id=s.grant_id WHERE s.id=p_id
$fn$;

-- Both directions of ownership/cutover share this lock. Legacy owner must be
-- disabled and queued/processing/unknown deliveries drained before adoption.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_owner_v1(p_id uuid,p_org uuid,p_settings jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes-room-schedule:'||p_org::text,0));
  IF EXISTS(SELECT 1 FROM public.zalo_automations a WHERE a.organization_id=p_org AND a.kind='broadcast_vacant' AND a.enabled
      AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_settings->'conversationIds') target WHERE a.config->'recipients' ? target))
    OR EXISTS(SELECT 1 FROM public.zalo_send_queue q WHERE q.organization_id=p_org AND q.payload->>'tu_dong'='true'
      AND q.payload->>'auto_reply' IS DISTINCT FROM 'true' AND (q.status IN ('queued','processing') OR q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true')
      AND p_settings->'conversationIds' ? q.conversation_id::text)
    OR EXISTS(SELECT 1 FROM public.zalo_send_queue q JOIN app_private.hermes_group_dispatches h ON h.id=q.hermes_group_dispatch_id
      WHERE h.origin='standing_grant' AND h.request->>'scheduleId'<>p_id::text AND q.organization_id=p_org
        AND (q.status IN ('queued','processing') OR q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true')
        AND p_settings->'conversationIds' ? q.conversation_id::text)
    OR EXISTS(SELECT 1 FROM app_private.hermes_room_schedules s JOIN app_private.hermes_schedule_grants g ON g.id=s.grant_id
      WHERE s.id<>p_id AND s.organization_id=p_org AND s.state='ACTIVE' AND g.expires_at>clock_timestamp()
      AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_settings->'conversationIds') target WHERE g.settings->'conversationIds' ? target)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_settings->'buildingIds') building WHERE g.settings->'buildingIds' ? building))
    THEN RAISE EXCEPTION 'hermes_schedule_owner_conflict' USING ERRCODE='PT409'; END IF;
END $fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_legacy_owner_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF NEW.kind<>'broadcast_vacant' OR NOT NEW.enabled THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes-room-schedule:'||NEW.organization_id::text,0));
  IF EXISTS(SELECT 1 FROM app_private.hermes_room_schedules s JOIN app_private.hermes_schedule_grants g ON g.id=s.grant_id
    WHERE s.organization_id=NEW.organization_id AND s.state='ACTIVE' AND g.expires_at>clock_timestamp()
      AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(NEW.config->'recipients','[]')) target WHERE g.settings->'conversationIds' ? target))
    OR EXISTS(SELECT 1 FROM public.zalo_send_queue q JOIN app_private.hermes_group_dispatches h ON h.id=q.hermes_group_dispatch_id
      WHERE h.origin='standing_grant' AND q.organization_id=NEW.organization_id
        AND (q.status IN ('queued','processing') OR q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true')
        AND NEW.config->'recipients' ? q.conversation_id::text)
    THEN RAISE EXCEPTION 'hermes_schedule_owner_conflict' USING ERRCODE='PT409'; END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS hermes_schedule_legacy_owner ON public.zalo_automations;
CREATE TRIGGER hermes_schedule_legacy_owner BEFORE INSERT OR UPDATE OF enabled,config,organization_id,kind ON public.zalo_automations
  FOR EACH ROW EXECUTE FUNCTION app_private.hermes_schedule_legacy_owner_v1();

CREATE OR REPLACE FUNCTION public.hermes_room_schedule_manage_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; s app_private.hermes_room_schedules; x app_private.hermes_zalo_bindings;
  op text; input jsonb; settings jsonb; context jsonb; digest bytea; request_id uuid; schedule_id uuid; grant_id uuid; revision bigint;
  page_limit integer; page_cursor uuid; page_ids uuid[];
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>3 OR NOT(p ?& ARRAY['binding','operation','input'])
    OR jsonb_typeof(p->'input') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
  op:=p->>'operation'; input:=p->'input';
  IF op NOT IN ('create','update','revoke','list') OR op IS NULL THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
  c:=app_private.hermes_schedule_actor_v1(p->'binding',op<>'list');
  IF op='list' THEN
    IF input-ARRAY['limit','cursor']<>'{}'::jsonb THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
    page_limit:=CASE WHEN input ? 'limit' THEN app_private.hermes_integer_v1(input->'limit') ELSE 20 END;
    page_cursor:=CASE WHEN NOT(input ? 'cursor') OR input->'cursor'='null'::jsonb THEN NULL ELSE app_private.hermes_uuid_v1(input->'cursor') END;
    IF page_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
    SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO page_ids FROM (
      SELECT id FROM app_private.hermes_room_schedules WHERE connection_id=c.id AND user_id=c.user_id AND organization_id=c.organization_id
        AND (page_cursor IS NULL OR id>page_cursor) ORDER BY id LIMIT page_limit+1) page;
    RETURN jsonb_build_object('schedules',COALESCE((SELECT jsonb_agg(app_private.hermes_schedule_summary_v1(id) ORDER BY id)
      FROM unnest(page_ids[1:page_limit]) id),'[]'::jsonb),
      'nextCursor',CASE WHEN cardinality(page_ids)>page_limit THEN page_ids[page_limit] ELSE NULL END);
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(input))<>(CASE op WHEN 'create' THEN 2 WHEN 'update' THEN 4 ELSE 3 END)
    OR NOT(input ?& CASE op WHEN 'create' THEN ARRAY['requestId','settings'] WHEN 'update' THEN ARRAY['requestId','scheduleId','expectedRevision','settings'] ELSE ARRAY['requestId','scheduleId','expectedRevision'] END)
    THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
  request_id:=app_private.hermes_uuid_v1(input->'requestId');
  schedule_id:=CASE WHEN op='create' THEN request_id ELSE app_private.hermes_uuid_v1(input->'scheduleId') END;
  IF op<>'create' AND (jsonb_typeof(input->'expectedRevision') IS DISTINCT FROM 'number' OR input->>'expectedRevision' !~ '^[1-9][0-9]{0,15}$'
    OR (input->>'expectedRevision')::numeric>=9007199254740991) THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
  digest:=sha256(convert_to(jsonb_build_object('operation',op,'input',input)::text,'UTF8'));
  -- Serialize all competing CRM schedule owners before inspecting a row.
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes-room-schedule:'||c.organization_id::text,0));
  SELECT * INTO s FROM app_private.hermes_room_schedules WHERE id=schedule_id FOR UPDATE;
  IF s.id IS NOT NULL THEN
    IF s.user_id<>c.user_id OR s.organization_id<>c.organization_id OR s.connection_id<>c.id THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
    IF s.last_request_id=request_id THEN
      IF s.last_request_digest IS DISTINCT FROM digest THEN RAISE EXCEPTION 'hermes_schedule_request_reused' USING ERRCODE='PT409'; END IF;
      RETURN jsonb_build_object('schedule',app_private.hermes_schedule_summary_v1(s.id));
    END IF;
    IF op='create' OR s.state<>'ACTIVE' OR s.revision<>(input->>'expectedRevision')::bigint
      THEN RAISE EXCEPTION 'hermes_schedule_revision_changed' USING ERRCODE='PT409'; END IF;
  ELSIF op<>'create' THEN RAISE EXCEPTION 'hermes_schedule_not_found' USING ERRCODE='PT409'; END IF;
  IF op='revoke' THEN
    UPDATE app_private.hermes_room_schedules SET state='REVOKED',revoked_at=clock_timestamp(),revision=s.revision+1,
      last_request_id=request_id,last_request_digest=digest WHERE id=s.id;
    INSERT INTO app_private.hermes_schedule_events(schedule_id,grant_id,actor,event,request_id) VALUES(s.id,s.grant_id,c.user_id,'revoked',request_id);
    RETURN jsonb_build_object('schedule',app_private.hermes_schedule_summary_v1(s.id));
  END IF;
  settings:=app_private.hermes_schedule_settings_v1(input->'settings',c.organization_id);
  context:=app_private.hermes_external_group_context_v1(p->'binding');
  PERFORM app_private.hermes_schedule_scope_v1(c.id,settings,context);
  PERFORM app_private.hermes_schedule_owner_v1(schedule_id,c.organization_id,settings);
  SELECT * INTO x FROM app_private.hermes_zalo_bindings WHERE connection_id=c.id AND state='ACTIVE' AND revoked_at IS NULL;
  grant_id:=gen_random_uuid(); revision:=COALESCE(s.revision,0)+1;
  INSERT INTO app_private.hermes_schedule_grants(id,schedule_id,revision,user_id,organization_id,connection_id,binding_id,binding_epoch,account_id,
    settings,request_id,request_digest,expires_at) VALUES(grant_id,schedule_id,revision,c.user_id,c.organization_id,c.id,x.id,x.epoch,x.account_id,
      settings,request_id,digest,(settings->>'expiresAt')::timestamptz);
  INSERT INTO app_private.hermes_room_schedules(id,user_id,organization_id,connection_id,grant_id,revision,state,last_request_id,last_request_digest)
    VALUES(schedule_id,c.user_id,c.organization_id,c.id,grant_id,revision,'ACTIVE',request_id,digest)
    ON CONFLICT(id) DO UPDATE SET grant_id=EXCLUDED.grant_id,revision=EXCLUDED.revision,last_request_id=EXCLUDED.last_request_id,last_request_digest=EXCLUDED.last_request_digest;
  INSERT INTO app_private.hermes_schedule_events(schedule_id,grant_id,actor,event,request_id) VALUES(schedule_id,grant_id,c.user_id,CASE op WHEN 'create' THEN 'created' ELSE 'updated' END,request_id);
  RETURN jsonb_build_object('schedule',app_private.hermes_schedule_summary_v1(schedule_id));
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
  IF NOT ((h.origin='standing_grant' AND auth.role()='service_role') OR (h.origin<>'standing_grant' AND auth.role()='authenticated' AND auth.uid()=h.user_id))
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
CREATE OR REPLACE FUNCTION app_private.hermes_group_assert_dispatch_v1(p_dispatch_id uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE h app_private.hermes_group_dispatches; v_current jsonb;
BEGIN
  SELECT * INTO h FROM app_private.hermes_group_dispatches WHERE id=p_dispatch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  IF h.origin='standing_grant' THEN v_current:=app_private.hermes_schedule_current_v1(h.request);
  ELSIF h.origin='external_mcp' THEN v_current:=app_private.hermes_external_group_current_v1(h.request);
  ELSE v_current:=app_private.hermes_group_current_v1(h.request); END IF;
  IF h.expires_at<=clock_timestamp() OR h.snapshot IS DISTINCT FROM v_current
    OR h.payload_digest IS DISTINCT FROM sha256(convert_to(jsonb_build_object('request',h.request,'snapshot',h.snapshot,'body',h.body)::text,'UTF8'))
    THEN RAISE EXCEPTION 'hermes_group_context_changed' USING ERRCODE='PT409'; END IF;
END $fn$;

ALTER TABLE app_private.hermes_group_dispatches DROP CONSTRAINT IF EXISTS hermes_group_origin_check;
ALTER TABLE app_private.hermes_group_dispatches ADD CONSTRAINT hermes_group_origin_check CHECK(
  (origin='private_command' AND command_id IS NOT NULL) OR (origin='external_mcp' AND command_id IS NULL)
  OR (origin='standing_grant' AND command_id IS NULL AND request ?& ARRAY['scheduleId','grantId','scheduleRevision']));

-- Every new surface is private by default. Worker gets only due/run; a real
-- verified user gets management. There is no generic SQL or actor override.
DO $permissions$
DECLARE signature text; name text;
BEGIN
  FOR signature,name IN SELECT p.oid::regprocedure::text,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE (n.nspname='app_private' AND p.proname IN ('hermes_schedule_immutable_v1','hermes_schedule_settings_v1','hermes_schedule_actor_v1',
      'hermes_schedule_scope_v1','hermes_schedule_summary_v1','hermes_schedule_owner_v1','hermes_schedule_legacy_owner_v1',
      'hermes_schedule_binding_v1','hermes_schedule_current_v1'))
      OR (n.nspname='public' AND p.proname IN ('hermes_room_schedule_manage_v1','hermes_room_schedule_due_v1','hermes_room_schedule_run_v1')) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',signature);
    IF name='hermes_room_schedule_manage_v1' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',signature);
    ELSIF name IN ('hermes_room_schedule_due_v1','hermes_room_schedule_run_v1') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',signature); END IF;
  END LOOP;
END $permissions$;
COMMIT;
