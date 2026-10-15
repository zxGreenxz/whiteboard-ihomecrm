-- Hermes CRM schedule health (package C). Forward only; no Copilot schema,
-- shared capability catalog/options function or capability registry row is
-- changed. Existing run/grant/event evidence stays immutable.
--   * Every blocked or failed scheduled run leaves machine-readable evidence
--     (incident ledger, missed runs with reason) and the schedule OWNER is told
--     through the existing notifications + send-push channel, once per incident.
--   * Recipient denial stops only that recipient; grant-wide authority/scope
--     denial stops the schedule. Delivery-time checks follow the same split.
--   * A default-OFF public sale-policy change mode reuses this scheduler, queue,
--     dispatch provenance and provider gate. One owner per business+recipients.
--   * Bounded maintenance on the same worker tick: expired private commands
--     and expired Hermes group jobs. No retry, no replay, no reset.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- 1. Template registry. The existing bulletin stays enabled; the new mode is
-- disabled until an operator enables it with reviewed TEST/canary evidence.
CREATE TABLE IF NOT EXISTS app_private.hermes_schedule_templates (
  template text PRIMARY KEY CHECK(template ~ '^[a-z][a-z0-9_]{0,63}$'),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO app_private.hermes_schedule_templates(template,enabled)
  VALUES('rooms_public_text_v1',true),('sale_policy_public_text_v1',false)
  ON CONFLICT(template) DO NOTHING;

-- 2. Run evidence. 'missed' may carry the blocking reason; policy runs keep the
-- digest of the public projection they compared or queued.
ALTER TABLE app_private.hermes_schedule_runs ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE app_private.hermes_schedule_runs ADD COLUMN IF NOT EXISTS policy_digest bytea;
ALTER TABLE app_private.hermes_schedule_runs DROP CONSTRAINT IF EXISTS hermes_schedule_runs_outcome_check;
ALTER TABLE app_private.hermes_schedule_runs ADD CONSTRAINT hermes_schedule_runs_outcome_check
  CHECK(outcome IN ('queued','no_rooms','missed','baseline','unchanged'));
ALTER TABLE app_private.hermes_schedule_runs DROP CONSTRAINT IF EXISTS hermes_schedule_runs_reason_check;
ALTER TABLE app_private.hermes_schedule_runs ADD CONSTRAINT hermes_schedule_runs_reason_check
  CHECK(reason IS NULL OR (outcome='missed' AND reason ~ '^[a-z][a-z0-9_]{0,63}$'));
ALTER TABLE app_private.hermes_schedule_runs DROP CONSTRAINT IF EXISTS hermes_schedule_runs_policy_check;
ALTER TABLE app_private.hermes_schedule_runs ADD CONSTRAINT hermes_schedule_runs_policy_check
  CHECK((outcome NOT IN ('baseline','unchanged') OR policy_digest IS NOT NULL)
    AND (policy_digest IS NULL OR (octet_length(policy_digest)=32 AND outcome IN ('baseline','unchanged','queued'))));
CREATE INDEX IF NOT EXISTS hermes_schedule_runs_queued ON app_private.hermes_schedule_runs(created_at) WHERE outcome='queued';
CREATE INDEX IF NOT EXISTS hermes_schedule_runs_target ON app_private.hermes_schedule_runs(schedule_id,conversation_id,created_at);
-- Mutable operational cursor only; authority is always recomputed.
ALTER TABLE app_private.hermes_room_schedules ADD COLUMN IF NOT EXISTS last_probed_at timestamptz;

-- 3. Incident ledger: one open row per schedule/kind/reason. Identity fields
-- never change; occurrences/detail aggregate repeats; close is final.
CREATE TABLE IF NOT EXISTS app_private.hermes_schedule_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES app_private.hermes_room_schedules(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  kind text NOT NULL CHECK(kind IN ('authority','run','delivery','expiry')),
  reason text NOT NULL CHECK(reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(detail)='object' AND octet_length(detail::text)<=4096),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  occurrences integer NOT NULL DEFAULT 1 CHECK(occurrences>0),
  notified_at timestamptz,
  notify_result jsonb,
  closed_at timestamptz,
  close_reason text CHECK(close_reason IN ('recovered','superseded','schedule_revoked','grant_replaced')),
  closed_notified_at timestamptz,
  CHECK((closed_at IS NULL)=(close_reason IS NULL)),
  CHECK(closed_notified_at IS NULL OR (closed_at IS NOT NULL AND notified_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS hermes_schedule_incidents_open ON app_private.hermes_schedule_incidents(schedule_id,kind,reason) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS hermes_schedule_incidents_pending ON app_private.hermes_schedule_incidents(opened_at) WHERE notified_at IS NULL AND closed_at IS NULL;
CREATE INDEX IF NOT EXISTS hermes_schedule_incidents_owner ON app_private.hermes_schedule_incidents(organization_id,user_id,opened_at DESC);
-- A job outcome is turned into an incident occurrence exactly once.
CREATE TABLE IF NOT EXISTS app_private.hermes_schedule_delivery_observations (
  job_id uuid NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('failed','unknown')),
  schedule_id uuid NOT NULL REFERENCES app_private.hermes_room_schedules(id),
  dispatch_id uuid NOT NULL REFERENCES app_private.hermes_group_dispatches(id),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(job_id,outcome)
);
DO $permissions$ DECLARE n text; BEGIN
  FOREACH n IN ARRAY ARRAY['hermes_schedule_templates','hermes_schedule_incidents','hermes_schedule_delivery_observations'] LOOP
    EXECUTE format('ALTER TABLE app_private.%I OWNER TO postgres',n);
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',n);
    EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',n);
  END LOOP;
END $permissions$;
DROP TRIGGER IF EXISTS hermes_schedule_immutable ON app_private.hermes_schedule_delivery_observations;
CREATE TRIGGER hermes_schedule_immutable BEFORE UPDATE OR DELETE ON app_private.hermes_schedule_delivery_observations
  FOR EACH ROW EXECUTE FUNCTION app_private.hermes_schedule_immutable_v1();
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_incident_guard_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.schedule_id IS DISTINCT FROM OLD.schedule_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
    OR NEW.occurrences<OLD.occurrences
    OR (OLD.closed_at IS NOT NULL AND (NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.close_reason IS DISTINCT FROM OLD.close_reason
      OR NEW.detail IS DISTINCT FROM OLD.detail OR NEW.occurrences IS DISTINCT FROM OLD.occurrences OR NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at))
    OR (OLD.notified_at IS NOT NULL AND (NEW.notified_at IS DISTINCT FROM OLD.notified_at OR NEW.notify_result IS DISTINCT FROM OLD.notify_result))
    OR (OLD.closed_notified_at IS NOT NULL AND NEW.closed_notified_at IS DISTINCT FROM OLD.closed_notified_at)
  THEN RAISE EXCEPTION 'hermes_schedule_incident_immutable' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS hermes_schedule_incident_guard ON app_private.hermes_schedule_incidents;
CREATE TRIGGER hermes_schedule_incident_guard BEFORE UPDATE OR DELETE ON app_private.hermes_schedule_incidents
  FOR EACH ROW EXECUTE FUNCTION app_private.hermes_schedule_incident_guard_v1();

-- 4. Settings: same canonical nine keys; template must be registered+enabled.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_settings_v1(p jsonb,p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE k text; ids uuid[]; days integer[]; expiry timestamptz; result jsonb:=p;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>9
    OR NOT(p ?& ARRAY['template','buildingIds','conversationIds','weekdays','time','timeZone','maxRooms','maxMessagesPerDay','expiresAt'])
    OR jsonb_typeof(p->'template') IS DISTINCT FROM 'string'
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_schedule_templates WHERE template=p->>'template')
    OR p->>'timeZone' IS DISTINCT FROM app_private.org_timezone_v1(p_org)
    OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=p->>'timeZone')
    OR jsonb_typeof(p->'time') IS DISTINCT FROM 'string' OR p->>'time' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_private.hermes_schedule_templates WHERE template=p->>'template' AND enabled)
    THEN RAISE EXCEPTION 'hermes_schedule_template_disabled' USING ERRCODE='42501'; END IF;
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

-- 5. Scope. One building predicate shared by run, delivery gate and diagnosis.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_building_allowed_v1(p_user uuid,p_org uuid,p_building uuid,p_scopes uuid[])
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE decision record;
BEGIN
  SELECT * INTO decision FROM app_private.authorize_tenant_action_v3(p_user,p_org,'rooms.view',p_building);
  RETURN decision.allowed IS NOT DISTINCT FROM true
    AND EXISTS(SELECT 1 FROM public.buildings WHERE id=p_building AND organization_id=p_org AND deleted_at IS NULL AND NOT is_virtual)
    AND EXISTS(SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(COALESCE(p_scopes,'{}'::uuid[])) AND scope.organization_id=p_org
      AND (scope.scope_type='ORGANIZATION' OR scope.scope_type='BUILDING' AND scope.building_id=p_building OR scope.scope_type='AREA' AND EXISTS(
        SELECT 1 FROM public.area_buildings edge JOIN public.areas ar ON ar.id=edge.area_id WHERE edge.area_id=scope.area_id
        AND edge.organization_id=p_org AND edge.building_id=p_building AND ar.organization_id=p_org AND ar.deleted_at IS NULL)));
END $fn$;

-- Grant-wide authority and EVERY building, plus only the named recipients.
-- An empty target list is the grant-wide gate; manage still uses v1 (all).
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_scope_v2(p_connection uuid,p_settings jsonb,p_context jsonb,p_targets jsonb)
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
    IF NOT app_private.hermes_schedule_building_allowed_v1(c.user_id,c.organization_id,building,scopes)
      THEN RAISE EXCEPTION 'hermes_schedule_scope_denied' USING ERRCODE='42501'; END IF;
  END LOOP;
  IF jsonb_typeof(p_targets) IS DISTINCT FROM 'array' OR jsonb_array_length(p_targets)>8
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_targets) t WHERE jsonb_typeof(t)<>'string'
      OR NOT(p_settings->'conversationIds' ? (t#>>'{}')) OR NOT(p_context#>'{recipientRead,allowedConversationIds}' ? (t#>>'{}')))
    THEN RAISE EXCEPTION 'hermes_schedule_target_denied' USING ERRCODE='42501'; END IF;
END $fn$;

-- 6. Ownership. One non-raising state shared by the gate, the legacy trigger
-- and diagnosis. Business = template; legacy broadcast owns room bulletins only.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_owner_state_v1(p_id uuid,p_org uuid,p_settings jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_template text:=COALESCE(p_settings->>'template','rooms_public_text_v1'); v_ids jsonb;
BEGIN
  IF v_template='rooms_public_text_v1' AND EXISTS(SELECT 1 FROM public.zalo_automations a WHERE a.organization_id=p_org AND a.kind='broadcast_vacant' AND a.enabled
      AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_settings->'conversationIds') target WHERE a.config->'recipients' ? target))
    THEN RETURN jsonb_build_object('reason','legacy_owner_active','kind','authority','detail','{}'::jsonb); END IF;
  SELECT jsonb_agg(id ORDER BY id) INTO v_ids FROM (
    SELECT q.id FROM public.zalo_send_queue q WHERE v_template='rooms_public_text_v1' AND q.organization_id=p_org
      AND q.payload->>'tu_dong'='true' AND q.payload->>'auto_reply' IS DISTINCT FROM 'true'
      AND (q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true')
      AND p_settings->'conversationIds' ? q.conversation_id::text
    UNION
    SELECT q.id FROM public.zalo_send_queue q JOIN app_private.hermes_group_dispatches h ON h.id=q.hermes_group_dispatch_id
      JOIN app_private.hermes_schedule_grants og ON og.id=(h.request->>'grantId')::uuid
      WHERE h.origin='standing_grant' AND h.request->>'scheduleId'<>p_id::text AND q.organization_id=p_org
        AND COALESCE(og.settings->>'template','rooms_public_text_v1')=v_template
        AND (q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true')
        AND p_settings->'conversationIds' ? q.conversation_id::text
    ORDER BY 1 LIMIT 10) blocked(id);
  IF v_ids IS NOT NULL THEN RETURN jsonb_build_object('reason','blocked_by_unknown_delivery','kind','authority','detail',jsonb_build_object('jobIds',v_ids)); END IF;
  SELECT jsonb_agg(id ORDER BY id) INTO v_ids FROM (
    SELECT q.id FROM public.zalo_send_queue q WHERE v_template='rooms_public_text_v1' AND q.organization_id=p_org
      AND q.payload->>'tu_dong'='true' AND q.payload->>'auto_reply' IS DISTINCT FROM 'true' AND q.status IN ('queued','processing')
      AND p_settings->'conversationIds' ? q.conversation_id::text
    UNION
    SELECT q.id FROM public.zalo_send_queue q JOIN app_private.hermes_group_dispatches h ON h.id=q.hermes_group_dispatch_id
      JOIN app_private.hermes_schedule_grants og ON og.id=(h.request->>'grantId')::uuid
      WHERE h.origin='standing_grant' AND h.request->>'scheduleId'<>p_id::text AND q.organization_id=p_org
        AND COALESCE(og.settings->>'template','rooms_public_text_v1')=v_template AND q.status IN ('queued','processing')
        AND p_settings->'conversationIds' ? q.conversation_id::text
    ORDER BY 1 LIMIT 10) pending(id);
  IF v_ids IS NOT NULL THEN RETURN jsonb_build_object('reason','other_owner_delivery_pending','kind','authority','detail',jsonb_build_object('jobIds',v_ids)); END IF;
  SELECT jsonb_agg(id ORDER BY id) INTO v_ids FROM (
    SELECT s.id FROM app_private.hermes_room_schedules s JOIN app_private.hermes_schedule_grants g ON g.id=s.grant_id
      WHERE s.id<>p_id AND s.organization_id=p_org AND s.state='ACTIVE' AND g.expires_at>clock_timestamp()
        AND COALESCE(g.settings->>'template','rooms_public_text_v1')=v_template
        AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_settings->'conversationIds') target WHERE g.settings->'conversationIds' ? target)
        AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_settings->'buildingIds') building WHERE g.settings->'buildingIds' ? building)
      ORDER BY s.id LIMIT 10) overlap(id);
  IF v_ids IS NOT NULL THEN RETURN jsonb_build_object('reason','owner_conflict','kind','authority','detail',jsonb_build_object('scheduleIds',v_ids)); END IF;
  RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_schedule_owner_v1(p_id uuid,p_org uuid,p_settings jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes-room-schedule:'||p_org::text,0));
  IF app_private.hermes_schedule_owner_state_v1(p_id,p_org,p_settings) IS NOT NULL
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
      AND COALESCE(g.settings->>'template','rooms_public_text_v1')='rooms_public_text_v1'
      AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(NEW.config->'recipients','[]')) target WHERE g.settings->'conversationIds' ? target))
    OR EXISTS(SELECT 1 FROM public.zalo_send_queue q JOIN app_private.hermes_group_dispatches h ON h.id=q.hermes_group_dispatch_id
      JOIN app_private.hermes_schedule_grants og ON og.id=(h.request->>'grantId')::uuid
      WHERE h.origin='standing_grant' AND q.organization_id=NEW.organization_id
        AND COALESCE(og.settings->>'template','rooms_public_text_v1')='rooms_public_text_v1'
        AND (q.status IN ('queued','processing') OR q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true')
        AND NEW.config->'recipients' ? q.conversation_id::text)
    THEN RAISE EXCEPTION 'hermes_schedule_owner_conflict' USING ERRCODE='PT409'; END IF;
  RETURN NEW;
END $fn$;

-- 7. Public sale-policy projection: the company sale_policy printed on public
-- room lists and the sale_note of rooms currently offered free/soon in the
-- grant buildings. No sale_bonus_note, description, contacts, pass-guest
-- data, prices or internal fields. Deterministic order for the digest.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_policy_projection_v1(p_org uuid,p_settings jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE b public.buildings; r public.rooms; fact record; v_soon integer; v_pass boolean; v_text text;
  v_common text[]:='{}'; v_rooms jsonb:='[]'::jsonb;
BEGIN
  FOR b IN SELECT * FROM public.buildings WHERE organization_id=p_org AND deleted_at IS NULL AND NOT is_virtual
      AND p_settings->'buildingIds' ? id::text ORDER BY id LOOP
    v_text:=NULL; v_soon:=NULL;
    SELECT NULLIF(btrim(prs.sale_policy),''),prs.soon_days INTO v_text,v_soon FROM public.public_room_settings prs
      WHERE prs.owner_id=b.user_id AND (prs.organization_id=p_org OR prs.organization_id IS NULL)
      ORDER BY prs.organization_id NULLS LAST LIMIT 1;
    IF v_text IS NOT NULL AND NOT(v_text=ANY(v_common)) THEN v_common:=v_common||v_text; END IF;
    FOR r IN SELECT * FROM public.rooms WHERE organization_id=p_org AND building_id=b.id AND deleted_at IS NULL
        AND NULLIF(btrim(sale_note),'') IS NOT NULL ORDER BY COALESCE(code,name),id LOOP
      SELECT EXISTS(SELECT 1 FROM public.room_pass_listings WHERE room_id=r.id AND user_id=b.user_id
        AND (organization_id=p_org OR organization_id IS NULL) AND active) INTO v_pass;
      SELECT * INTO fact FROM app_private.room_sale_workflow_fact_v1(r.id,p_org,r.status::text,v_pass,COALESCE(v_soon,30));
      IF fact.status_public IN ('free','soon') THEN
        v_rooms:=v_rooms||jsonb_build_array(jsonb_build_object('roomId',r.id,'buildingId',b.id,
          'buildingLabel',COALESCE(NULLIF(btrim(b.name),''),NULLIF(btrim(b.code),''),'Tòa'),
          'roomLabel',COALESCE(NULLIF(btrim(r.code),''),NULLIF(btrim(r.name),''),'Phòng'),'note',btrim(r.sale_note)));
      END IF;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('commonPolicies',COALESCE((SELECT to_jsonb(array_agg(x ORDER BY x)) FROM unnest(v_common) x),'[]'::jsonb),
    'roomNotes',v_rooms);
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_schedule_policy_body_v1(p jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
  SELECT 'CẬP NHẬT CHÍNH SÁCH SALE'
    ||COALESCE(E'\n'||(SELECT string_agg(v,E'\n' ORDER BY ord) FROM jsonb_array_elements_text(p->'commonPolicies') WITH ORDINALITY x(v,ord)),'')
    ||COALESCE(E'\nChính sách riêng từng phòng:\n'||(SELECT string_agg(ord::text||'. '||(f->>'buildingLabel')||' · '||(f->>'roomLabel')||': '||(f->>'note'),E'\n' ORDER BY ord)
      FROM jsonb_array_elements(p->'roomNotes') WITH ORDINALITY x(f,ord)),'')
    ||CASE WHEN jsonb_array_length(p->'commonPolicies')=0 AND jsonb_array_length(p->'roomNotes')=0
      THEN E'\nHiện không còn chính sách sale công khai trong phạm vi tòa đã chọn.' ELSE '' END
$fn$;

-- Same provenance fields the provider gate and queue-origin trigger read
-- (sender/recipients); policy facts replace room facts and are recomputed.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_policy_snapshot_v1(p jsonb,g app_private.hermes_schedule_grants,p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; policy app_private.hermes_org_policies; a public.zalo_accounts;
  v_convs uuid[]; v_groups jsonb; v_scopes uuid[]; v_projection jsonb;
BEGIN
  IF NOT(p_context#>'{authority,effective,read}' ?& ARRAY['rooms.view','chat_zalo.view'])
    OR NOT(p_context#>'{authority,effective,action}' ? 'chat_zalo.send')
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=g.connection_id;
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  SELECT * INTO a FROM public.zalo_accounts WHERE id=(p_context#>>'{recipientRead,sender,accountId}')::uuid;
  SELECT array_agg(j::uuid ORDER BY j) INTO v_convs FROM jsonb_array_elements_text(p->'conversationIds') j;
  IF cardinality(v_convs) IS NULL OR cardinality(v_convs) NOT BETWEEN 1 AND 8 THEN RAISE EXCEPTION 'hermes_group_invalid' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO v_scopes FROM (
    SELECT unnest(c.scope_ids) AS id INTERSECT SELECT unnest(policy.scope_ids) AS id) effective;
  PERFORM 1 FROM public.zalo_conversations WHERE id=ANY(v_convs) ORDER BY id FOR UPDATE;
  SELECT jsonb_agg(jsonb_build_object('conversationId',z.id,'threadId',z.thread_id,'name',z.peer_name) ORDER BY z.id)
    INTO v_groups FROM public.zalo_conversations z WHERE z.id=ANY(v_convs) AND z.account_id=a.id AND z.organization_id=c.organization_id
      AND z.thread_type='group' AND NULLIF(btrim(z.thread_id),'') IS NOT NULL AND NULLIF(btrim(z.peer_name),'') IS NOT NULL;
  IF jsonb_array_length(v_groups) IS DISTINCT FROM cardinality(v_convs)
    OR (SELECT count(DISTINCT x->>'threadId') FROM jsonb_array_elements(v_groups) x)<>cardinality(v_convs)
    THEN RAISE EXCEPTION 'hermes_group_target_changed' USING ERRCODE='PT409'; END IF;
  PERFORM 1 FROM public.buildings WHERE organization_id=c.organization_id AND g.settings->'buildingIds' ? id::text ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.rooms WHERE organization_id=c.organization_id AND g.settings->'buildingIds' ? building_id::text
    AND NULLIF(btrim(sale_note),'') IS NOT NULL ORDER BY id FOR SHARE;
  v_projection:=app_private.hermes_schedule_policy_projection_v1(c.organization_id,g.settings);
  RETURN jsonb_build_object('origin','standing_grant','owner',p_context#>'{authority,owner}','binding',p_context#>'{authority,binding}',
    'contextVersion',p_context#>>'{authority,contextVersion}','scopeIds',to_jsonb(v_scopes),
    'sender',(p_context#>'{recipientRead,sender}')||jsonb_build_object('accountOwnerId',a.user_id),'recipients',v_groups,
    'policy',v_projection||jsonb_build_object('digest',encode(sha256(convert_to(v_projection::text,'UTF8')),'hex')));
END $fn$;

-- 8. Current standing-grant facts, used at enqueue and again immediately
-- before provider I/O. Only the job's own recipient is rechecked; grant-wide
-- authority, every building, owner state and template switch always are.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_current_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s app_private.hermes_room_schedules; g app_private.hermes_schedule_grants; x app_private.hermes_zalo_bindings;
  context jsonb; current jsonb; org uuid; v_template text;
BEGIN
  SELECT organization_id INTO org FROM app_private.hermes_room_schedules WHERE id=(p->>'scheduleId')::uuid;
  IF org IS NULL THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(org);
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes-room-schedule:'||org::text,0));
  SELECT * INTO s FROM app_private.hermes_room_schedules WHERE id=(p->>'scheduleId')::uuid FOR SHARE;
  SELECT * INTO g FROM app_private.hermes_schedule_grants WHERE id=s.grant_id;
  v_template:=g.settings->>'template';
  IF s.state<>'ACTIVE' OR g.id::text IS DISTINCT FROM p->>'grantId' OR s.revision::text IS DISTINCT FROM p->>'scheduleRevision'
    OR g.expires_at<=clock_timestamp() OR g.connection_id::text IS DISTINCT FROM p->>'connectionId'
    OR g.user_id IS DISTINCT FROM s.user_id OR g.organization_id IS DISTINCT FROM s.organization_id
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_schedule_templates WHERE template=v_template AND enabled)
    THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  context:=app_private.hermes_external_group_context_v1(p-ARRAY['scheduleId','grantId','scheduleRevision','roomIds','conversationIds',
    'expectedContextVersion','intentDigest','roomReadDigest','policyDigest']);
  SELECT * INTO x FROM app_private.hermes_zalo_bindings WHERE id=g.binding_id;
  IF x.state IS DISTINCT FROM 'ACTIVE' OR x.revoked_at IS NOT NULL OR x.epoch IS DISTINCT FROM g.binding_epoch
    OR x.account_id IS DISTINCT FROM g.account_id OR x.connection_id IS DISTINCT FROM g.connection_id
    OR context#>>'{recipientRead,sender,accountId}' IS DISTINCT FROM g.account_id::text
    THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p->'conversationIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'conversationIds') NOT BETWEEN 1 AND 8
    THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
  PERFORM app_private.hermes_schedule_scope_v2(g.connection_id,g.settings,context,p->'conversationIds');
  PERFORM app_private.hermes_schedule_owner_v1(s.id,s.organization_id,g.settings);
  IF v_template='rooms_public_text_v1' THEN
    IF p ? 'policyDigest' OR jsonb_typeof(p->'roomIds') IS DISTINCT FROM 'array'
      OR EXISTS(SELECT 1 FROM public.rooms r WHERE p->'roomIds' ? r.id::text AND NOT(g.settings->'buildingIds' ? r.building_id::text))
      OR jsonb_array_length(p->'roomIds')>(g.settings->>'maxRooms')::integer
      THEN RAISE EXCEPTION 'hermes_schedule_scope_denied' USING ERRCODE='42501'; END IF;
    current:=app_private.hermes_external_group_current_v1(p-ARRAY['scheduleId','grantId','scheduleRevision']);
  ELSE
    IF p ?| ARRAY['roomIds','roomReadDigest'] OR jsonb_typeof(p->'policyDigest') IS DISTINCT FROM 'string'
      THEN RAISE EXCEPTION 'hermes_schedule_invalid' USING ERRCODE='22023'; END IF;
    current:=app_private.hermes_schedule_policy_snapshot_v1(p,g,context);
    IF jsonb_array_length(current#>'{policy,roomNotes}')>(g.settings->>'maxRooms')::integer
      THEN RAISE EXCEPTION 'hermes_schedule_scope_denied' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN current||jsonb_build_object('origin','standing_grant','scheduleId',s.id,'grantId',g.id,'scheduleRevision',s.revision);
END $fn$;

-- 9. One run attempt (worker service role). v1 keeps its contract (raise on
-- denial); run_v2 below records evidence. Recipients are selected only from
-- current allowed targets, so one denied group cannot stop the others.
CREATE OR REPLACE FUNCTION public.hermes_room_schedule_run_v1(p_schedule_id uuid,p_expected_revision bigint,p_instance_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s app_private.hermes_room_schedules; g app_private.hermes_schedule_grants; z public.zalo_conversations;
  context jsonb; binding jsonb; snapshot jsonb; request jsonb; room_ids uuid[]; room public.rooms; building public.buildings;
  fact record; selected uuid; org uuid; today date; local_now timestamp; scheduled timestamp; previous timestamptz;
  dispatch uuid:=gen_random_uuid(); message_id uuid; job_id uuid; queue jsonb; body text; expiry timestamptz;
  soon_days integer; has_pass boolean; count_today integer; v_template text; v_policy boolean; v_denied jsonb;
  v_projection jsonb; v_digest bytea; v_base bytea; v_prior record; v_delivery text;
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
  v_template:=g.settings->>'template';
  IF v_template IS NULL OR v_template NOT IN ('rooms_public_text_v1','sale_policy_public_text_v1')
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_schedule_templates WHERE template=v_template AND enabled)
    THEN RAISE EXCEPTION 'hermes_schedule_template_disabled' USING ERRCODE='42501'; END IF;
  v_policy:=v_template='sale_policy_public_text_v1';
  binding:=app_private.hermes_schedule_binding_v1(g,dispatch);
  context:=app_private.hermes_external_group_context_v1(binding);
  PERFORM app_private.hermes_schedule_scope_v2(g.connection_id,g.settings,context,'[]'::jsonb);
  PERFORM app_private.hermes_schedule_owner_v1(s.id,s.organization_id,g.settings);
  IF NOT EXISTS(SELECT 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id
    AND heartbeat_at>clock_timestamp()-interval '30 seconds' AND heartbeat_at<=clock_timestamp())
    THEN RAISE EXCEPTION 'hermes_schedule_worker_denied' USING ERRCODE='42501'; END IF;
  local_now:=clock_timestamp() AT TIME ZONE (g.settings->>'timeZone'); today:=local_now::date;
  scheduled:=today+(g.settings->>'time')::time;
  IF NOT(g.settings->'weekdays' @> to_jsonb(extract(isodow FROM local_now)::integer)) OR local_now<scheduled
    THEN RETURN jsonb_build_object('status','skipped','reason','not_due'); END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(g.settings->'conversationIds') target WHERE NOT EXISTS(
    SELECT 1 FROM app_private.hermes_schedule_runs r WHERE r.schedule_id=s.id AND r.local_date=today AND r.conversation_id::text=target))
    THEN RETURN jsonb_build_object('status','already_run'); END IF;
  SELECT COALESCE(jsonb_agg(target ORDER BY target),'[]'::jsonb) INTO v_denied FROM jsonb_array_elements_text(g.settings->'conversationIds') target
    WHERE NOT(context#>'{recipientRead,allowedConversationIds}' ? target) AND NOT EXISTS(
      SELECT 1 FROM app_private.hermes_schedule_runs r WHERE r.schedule_id=s.id AND r.local_date=today AND r.conversation_id::text=target);
  -- Existing automation catch-up limit is 180 minutes. Close all remaining
  -- recipients for a missed day, never replay a backlog after downtime. A
  -- recipient that was denied keeps that reason on its missed row.
  IF local_now>scheduled+interval '180 minutes' THEN
    INSERT INTO app_private.hermes_schedule_runs(schedule_id,grant_id,local_date,conversation_id,outcome,reason)
      SELECT s.id,g.id,today,target::uuid,'missed',CASE WHEN v_denied ? target THEN 'target_denied' END
      FROM jsonb_array_elements_text(g.settings->'conversationIds') target
      ON CONFLICT(schedule_id,local_date,conversation_id) DO NOTHING;
    GET DIAGNOSTICS count_today=ROW_COUNT;
    RETURN jsonb_build_object('status','skipped','reason','missed_window','deniedTargets',v_denied,
      'missedAllowed',count_today-jsonb_array_length(v_denied));
  END IF;
  SELECT target::uuid INTO selected FROM jsonb_array_elements_text(g.settings->'conversationIds') target
    WHERE context#>'{recipientRead,allowedConversationIds}' ? target AND NOT EXISTS(
      SELECT 1 FROM app_private.hermes_schedule_runs r WHERE r.schedule_id=s.id AND r.local_date=today AND r.conversation_id::text=target)
    ORDER BY target LIMIT 1;
  IF selected IS NULL THEN RETURN jsonb_build_object('status','skipped','reason','target_denied','conversationIds',v_denied); END IF;
  IF v_policy THEN
    -- Compare with the last projection this recipient is known to have
    -- received. Unknown blocks; failed/not-sent was never delivered.
    v_projection:=app_private.hermes_schedule_policy_projection_v1(org,g.settings);
    v_digest:=sha256(convert_to(v_projection::text,'UTF8'));
    FOR v_prior IN SELECT r.outcome,r.policy_digest,r.dispatch_id FROM app_private.hermes_schedule_runs r
        WHERE r.schedule_id=s.id AND r.conversation_id=selected AND r.outcome IN ('baseline','unchanged','queued')
        ORDER BY r.created_at DESC,r.id DESC LIMIT 60 LOOP
      IF v_prior.outcome<>'queued' THEN v_base:=v_prior.policy_digest; EXIT; END IF;
      v_delivery:=NULL;
      SELECT CASE WHEN q.result#>>'{reconciliation,decision}'='sent' THEN 'sent'
          WHEN q.result#>>'{reconciliation,decision}'='not_sent' THEN 'failed'
          WHEN q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true' THEN 'unknown'
          WHEN q.status='sent' THEN 'sent' WHEN q.status='failed' THEN 'failed' ELSE 'pending' END INTO v_delivery
        FROM app_private.hermes_group_jobs j JOIN public.zalo_send_queue q ON q.id=j.job_id WHERE j.dispatch_id=v_prior.dispatch_id;
      IF v_delivery='sent' THEN v_base:=v_prior.policy_digest; EXIT; END IF;
      IF v_delivery='unknown' THEN RETURN jsonb_build_object('status','skipped','reason','delivery_unknown','dispatchId',v_prior.dispatch_id); END IF;
      IF v_delivery IS DISTINCT FROM 'failed' THEN RETURN jsonb_build_object('status','skipped','reason','delivery_pending'); END IF;
    END LOOP;
    IF v_base IS NULL AND v_delivery IS NULL THEN
      INSERT INTO app_private.hermes_schedule_runs(schedule_id,grant_id,local_date,conversation_id,outcome,policy_digest)
        VALUES(s.id,g.id,today,selected,'baseline',v_digest);
      RETURN jsonb_build_object('status','skipped','reason','baseline','conversationId',selected);
    END IF;
    IF v_base=v_digest THEN
      INSERT INTO app_private.hermes_schedule_runs(schedule_id,grant_id,local_date,conversation_id,outcome,policy_digest)
        VALUES(s.id,g.id,today,selected,'unchanged',v_digest);
      RETURN jsonb_build_object('status','skipped','reason','unchanged','conversationId',selected);
    END IF;
    IF jsonb_array_length(v_projection->'roomNotes')>(g.settings->>'maxRooms')::integer
      THEN RETURN jsonb_build_object('status','skipped','reason','room_limit'); END IF;
  END IF;
  SELECT max(created_at),count(*) FILTER(WHERE outcome='queued') INTO previous,count_today FROM app_private.hermes_schedule_runs
    WHERE schedule_id=s.id AND local_date=today;
  IF previous>clock_timestamp()-interval '180 seconds' THEN RETURN jsonb_build_object('status','skipped','reason','recipient_spacing'); END IF;
  IF count_today>=(g.settings->>'maxMessagesPerDay')::integer THEN RETURN jsonb_build_object('status','skipped','reason','daily_limit'); END IF;
  IF (SELECT count(*) FROM public.zalo_send_queue WHERE organization_id=org AND status IN ('queued','processing'))>=200
    THEN RETURN jsonb_build_object('status','skipped','reason','queue_capacity'); END IF;
  IF v_policy THEN
    body:=app_private.hermes_schedule_policy_body_v1(v_projection);
    request:=binding||jsonb_build_object('conversationIds',jsonb_build_array(selected),
      'expectedContextVersion',context#>>'{authority,contextVersion}','intentDigest',encode(g.request_digest,'hex'),
      'policyDigest',encode(v_digest,'hex'),'scheduleId',s.id,'grantId',g.id,'scheduleRevision',s.revision);
    snapshot:=app_private.hermes_schedule_current_v1(request);
    IF snapshot#>>'{policy,digest}' IS DISTINCT FROM encode(v_digest,'hex')
      THEN RAISE EXCEPTION 'hermes_group_context_changed' USING ERRCODE='PT409'; END IF;
  ELSE
    -- Fresh public-sale facts. Do not turn an unexpected formatter error into an
    -- empty report; only rooms the shared sale fact marks free/soon are selected.
    room_ids:='{}';
    FOR room IN SELECT * FROM public.rooms r WHERE r.organization_id=org AND r.deleted_at IS NULL
      AND g.settings->'buildingIds' ? r.building_id::text ORDER BY r.building_id,r.id LOOP
      SELECT * INTO building FROM public.buildings WHERE id=room.building_id AND organization_id=org AND deleted_at IS NULL AND NOT is_virtual;
      IF building.id IS NULL THEN RAISE EXCEPTION 'hermes_schedule_scope_denied' USING ERRCODE='42501'; END IF;
      soon_days:=NULL;
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
  END IF;
  -- The dispatch ledger accepts at most 8192 bytes; report it, never truncate.
  IF body IS NULL OR octet_length(body)>8192 THEN RAISE EXCEPTION 'hermes_schedule_message_invalid' USING ERRCODE='22023'; END IF;
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
  INSERT INTO app_private.hermes_schedule_runs(schedule_id,grant_id,local_date,conversation_id,outcome,dispatch_id,policy_digest)
    VALUES(s.id,g.id,today,z.id,'queued',dispatch,CASE WHEN v_policy THEN v_digest END);
  RETURN jsonb_build_object('status','queued','dispatchId',dispatch,'conversationId',z.id);
END $fn$;

-- 10. Diagnosis: first precise reason a schedule cannot run, without raising.
-- It reads the same current CRM authority, overlay, company policy, registry,
-- binding/sender, scope, recipient and ownership facts as the run gate.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_diagnose_v1(p_schedule uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s app_private.hermes_room_schedules; g app_private.hermes_schedule_grants; c app_private.hermes_connections;
  t app_private.hermes_connection_tokens; ss app_private.hermes_sessions; x app_private.hermes_zalo_bindings;
  policy app_private.hermes_org_policies; decision record; v_context jsonb; v_key text; v_mode text; v_list jsonb;
  v_scopes uuid[]; v_state text; v_message text; v_owner jsonb;
BEGIN
  SELECT * INTO s FROM app_private.hermes_room_schedules WHERE id=p_schedule;
  IF s.id IS NULL OR s.state<>'ACTIVE' THEN RETURN jsonb_build_object('reason','schedule_inactive','kind','authority','detail','{}'::jsonb); END IF;
  SELECT * INTO g FROM app_private.hermes_schedule_grants WHERE id=s.grant_id;
  IF g.expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('reason','grant_expired','kind','expiry','detail',
    jsonb_build_object('grantId',g.id,'expiresAt',to_char(g.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))); END IF;
  IF NOT EXISTS(SELECT 1 FROM app_private.hermes_schedule_templates WHERE template=g.settings->>'template' AND enabled)
    THEN RETURN jsonb_build_object('reason','template_disabled','kind','authority','detail',jsonb_build_object('template',g.settings->>'template')); END IF;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=g.connection_id;
  IF c.id IS NULL OR c.state<>'ACTIVE' OR c.revoked_at IS NOT NULL OR c.user_id<>s.user_id OR c.organization_id<>s.organization_id
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_assistants WHERE id=c.assistant_id AND state='ACTIVE')
    THEN RETURN jsonb_build_object('reason','connection_revoked','kind','authority','detail','{}'::jsonb); END IF;
  SELECT * INTO t FROM app_private.hermes_connection_tokens WHERE connection_id=c.id AND revoked_at IS NULL
    AND expires_at>clock_timestamp() AND created_at+interval '30 days'>clock_timestamp() ORDER BY created_at DESC,token_digest LIMIT 1;
  IF t.token_digest IS NULL THEN RETURN jsonb_build_object('reason','connection_token_expired','kind','authority','detail','{}'::jsonb); END IF;
  SELECT * INTO ss FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  IF ss.id IS NULL OR ss.state<>'ACTIVE' OR ss.quarantine_reason IS NOT NULL OR ss.expires_at<=clock_timestamp()
    THEN RETURN jsonb_build_object('reason','session_expired','kind','authority','detail','{}'::jsonb); END IF;
  BEGIN PERFORM app_private.hermes_member_v1(c.user_id,c.organization_id);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;
    RETURN jsonb_build_object('reason',CASE WHEN v_message='hermes_ordinary_org_ambiguous' THEN 'membership_ambiguous' ELSE 'membership_inactive' END,
      'kind','authority','detail','{}'::jsonb);
  END;
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  IF NOT COALESCE(policy.enabled,false) THEN RETURN jsonb_build_object('reason','company_policy_disabled','kind','authority','detail','{}'::jsonb); END IF;
  FOR v_key,v_mode IN SELECT k,m FROM (VALUES('chat_zalo.manage_automation','action',1),('chat_zalo.send','action',2),
      ('chat_zalo.view','read',3),('rooms.view','read',4)) required(k,m,o) ORDER BY o LOOP
    IF NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability=v_key AND mode=v_mode AND enabled)
      THEN RETURN jsonb_build_object('reason','capability_disabled','kind','authority','detail',jsonb_build_object('capability',v_key)); END IF;
    IF v_key<>'rooms.view' THEN
      SELECT * INTO decision FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,v_key);
      IF decision.allowed IS DISTINCT FROM true
        THEN RETURN jsonb_build_object('reason','user_permission_revoked','kind','authority','detail',jsonb_build_object('permission',v_key)); END IF;
    END IF;
    IF NOT(v_key=ANY(CASE WHEN v_mode='action' THEN c.action_capabilities ELSE c.read_capabilities END))
      THEN RETURN jsonb_build_object('reason','hermes_overlay_revoked','kind','authority','detail',jsonb_build_object('capability',v_key)); END IF;
    IF NOT(v_key=ANY(CASE WHEN v_mode='action' THEN policy.action_capabilities ELSE policy.read_capabilities END))
      THEN RETURN jsonb_build_object('reason','company_policy_revoked','kind','authority','detail',jsonb_build_object('capability',v_key)); END IF;
  END LOOP;
  -- The connection is usable only while its whole overlay stays inside the
  -- company ceiling (shared connection validator); report what was removed.
  IF NOT(c.read_capabilities<@policy.read_capabilities) OR NOT(c.action_capabilities<@policy.action_capabilities) OR NOT(c.scope_ids<@policy.scope_ids) THEN
    RETURN jsonb_build_object('reason','company_policy_revoked','kind','authority','detail',jsonb_build_object(
      'capabilities',COALESCE((SELECT jsonb_agg(k ORDER BY k) FROM ((SELECT unnest(c.read_capabilities) EXCEPT SELECT unnest(policy.read_capabilities))
        UNION (SELECT unnest(c.action_capabilities) EXCEPT SELECT unnest(policy.action_capabilities))) removed(k)),'[]'::jsonb),
      'scopeIds',COALESCE((SELECT jsonb_agg(k ORDER BY k) FROM (SELECT unnest(c.scope_ids) EXCEPT SELECT unnest(policy.scope_ids)) removed(k)),'[]'::jsonb)));
  END IF;
  IF g.settings->>'timeZone' IS DISTINCT FROM app_private.org_timezone_v1(c.organization_id)
    THEN RETURN jsonb_build_object('reason','timezone_changed','kind','authority','detail','{}'::jsonb); END IF;
  SELECT * INTO x FROM app_private.hermes_zalo_bindings WHERE id=g.binding_id;
  IF x.id IS NULL OR x.state<>'ACTIVE' OR x.revoked_at IS NOT NULL OR x.epoch<>g.binding_epoch OR x.account_id<>g.account_id OR x.connection_id<>g.connection_id
    THEN RETURN jsonb_build_object('reason','zalo_binding_changed','kind','authority','detail','{}'::jsonb); END IF;
  BEGIN
    v_context:=app_private.hermes_external_group_context_v1(app_private.hermes_schedule_binding_v1(g,gen_random_uuid()));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state=RETURNED_SQLSTATE,v_message=MESSAGE_TEXT;
    RETURN jsonb_build_object('reason',CASE WHEN v_message='hermes_group_directory_too_large' THEN 'zalo_directory_too_large'
      WHEN v_state='PT409' THEN 'context_changed' ELSE 'zalo_sender_unavailable' END,'kind','authority','detail',jsonb_build_object('sqlstate',v_state));
  END;
  IF v_context#>>'{recipientRead,sender,accountId}' IS DISTINCT FROM g.account_id::text
    THEN RETURN jsonb_build_object('reason','zalo_binding_changed','kind','authority','detail','{}'::jsonb); END IF;
  IF NOT(v_context#>'{authority,effective,read}' ? 'rooms.view') THEN
    RETURN jsonb_build_object('reason','scope_narrowed','kind','authority','detail',jsonb_build_object('buildingIds',g.settings->'buildingIds'));
  END IF;
  SELECT array_agg(v::uuid) INTO v_scopes FROM jsonb_array_elements_text(v_context#>'{authority,scopeIds}') v;
  SELECT COALESCE(jsonb_agg(b ORDER BY b),'[]'::jsonb) INTO v_list FROM jsonb_array_elements_text(g.settings->'buildingIds') b
    WHERE NOT app_private.hermes_schedule_building_allowed_v1(c.user_id,c.organization_id,b::uuid,v_scopes);
  IF jsonb_array_length(v_list)>0 THEN RETURN jsonb_build_object('reason','scope_narrowed','kind','authority','detail',jsonb_build_object('buildingIds',v_list)); END IF;
  v_owner:=app_private.hermes_schedule_owner_state_v1(s.id,s.organization_id,g.settings);
  IF v_owner IS NOT NULL THEN RETURN v_owner; END IF;
  SELECT COALESCE(jsonb_agg(v ORDER BY v),'[]'::jsonb) INTO v_list FROM jsonb_array_elements_text(g.settings->'conversationIds') v
    WHERE NOT(v_context#>'{recipientRead,allowedConversationIds}' ? v);
  IF jsonb_array_length(v_list)>0 THEN RETURN jsonb_build_object('reason','target_denied','kind','authority','detail',
    jsonb_build_object('conversationIds',v_list,'partial',jsonb_array_length(v_list)<jsonb_array_length(g.settings->'conversationIds'))); END IF;
  RETURN jsonb_build_object('reason',NULL);
END $fn$;

-- 11. Incident bookkeeping. A repeat only aggregates; a different grant-wide
-- authority reason supersedes the previous one (recipient denial is separate).
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_incident_open_v1(p_schedule uuid,p_kind text,p_reason text,p_detail jsonb)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s app_private.hermes_room_schedules; v_id uuid; v_detail jsonb:=COALESCE(p_detail,'{}'::jsonb);
BEGIN
  SELECT * INTO s FROM app_private.hermes_room_schedules WHERE id=p_schedule;
  IF s.id IS NULL OR p_reason IS NULL OR p_reason='schedule_inactive' THEN RETURN NULL; END IF;
  IF jsonb_typeof(v_detail)<>'object' OR octet_length(v_detail::text)>4096 THEN v_detail:='{}'::jsonb; END IF;
  IF p_kind='authority' AND p_reason<>'target_denied' THEN
    UPDATE app_private.hermes_schedule_incidents SET closed_at=clock_timestamp(),close_reason='superseded'
      WHERE schedule_id=s.id AND kind='authority' AND reason NOT IN (p_reason,'target_denied') AND closed_at IS NULL;
  END IF;
  INSERT INTO app_private.hermes_schedule_incidents AS i(schedule_id,user_id,organization_id,kind,reason,detail)
    VALUES(s.id,s.user_id,s.organization_id,p_kind,p_reason,v_detail)
    ON CONFLICT(schedule_id,kind,reason) WHERE closed_at IS NULL DO UPDATE
      SET last_seen_at=clock_timestamp(),occurrences=CASE WHEN i.occurrences<2147483647 THEN i.occurrences+1 ELSE i.occurrences END,detail=EXCLUDED.detail
    RETURNING i.id INTO v_id;
  RETURN v_id;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_schedule_incident_close_v1(p_schedule uuid,p_kinds text[],p_except text[],p_close text)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_count integer;
BEGIN
  UPDATE app_private.hermes_schedule_incidents SET closed_at=clock_timestamp(),close_reason=p_close
    WHERE schedule_id=p_schedule AND closed_at IS NULL AND kind=ANY(p_kinds) AND NOT(reason=ANY(COALESCE(p_except,'{}'::text[])));
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END $fn$;

-- Run results are classified only by the fixed vocabulary below.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_observe_v1(p_schedule uuid,p_result jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_status text:=p_result->>'status'; v_reason text:=p_result->>'reason';
BEGIN
  IF v_status='queued' OR (v_status='skipped' AND v_reason IN ('no_rooms','baseline','unchanged')) THEN
    PERFORM app_private.hermes_schedule_incident_close_v1(p_schedule,ARRAY['authority','run'],ARRAY['target_denied'],'recovered');
  ELSIF v_status='skipped' AND v_reason='missed_window' THEN
    -- Recipients missed only because they were denied are already reported.
    IF COALESCE((p_result->>'missedAllowed')::integer,1)>0 THEN
      PERFORM app_private.hermes_schedule_incident_open_v1(p_schedule,'run','missed_window','{}'::jsonb);
    END IF;
  ELSIF v_status='skipped' AND v_reason IN ('queue_capacity','room_limit','daily_limit') THEN
    PERFORM app_private.hermes_schedule_incident_open_v1(p_schedule,'run',v_reason,'{}'::jsonb);
  ELSIF v_status='skipped' AND v_reason='target_denied' THEN
    PERFORM app_private.hermes_schedule_incident_open_v1(p_schedule,'authority','target_denied',
      jsonb_build_object('conversationIds',COALESCE(p_result->'conversationIds','[]'::jsonb),'partial',true));
  ELSIF v_status='skipped' AND v_reason='delivery_unknown' THEN
    PERFORM app_private.hermes_schedule_incident_open_v1(p_schedule,'delivery','delivery_unknown',
      jsonb_build_object('dispatchId',p_result->'dispatchId'));
  END IF;
END $fn$;

-- Message text never claims a send happened; enqueue is not delivery.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_message_v1(p_reason text,p_phase text,p_detail jsonb,p_label text,p_expires timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
  SELECT CASE WHEN p_phase='recovered' THEN jsonb_build_object('title','Lịch Hermes đã chạy lại',
      'body',p_label||' không còn lỗi đã báo; lịch tiếp tục theo nhịp đã đặt. Kết quả từng tin xem trong danh sách lịch.')
    ELSE jsonb_build_object('title',CASE p_reason WHEN 'grant_expiring' THEN 'Lịch Hermes sắp hết hạn' WHEN 'grant_expired' THEN 'Lịch Hermes đã hết hạn'
        WHEN 'delivery_unknown' THEN 'Tin của lịch Hermes chưa rõ kết quả' WHEN 'delivery_failed' THEN 'Tin của lịch Hermes chưa gửi được'
        ELSE 'Lịch Hermes đang bị chặn' END,
      'body',p_label||': '||CASE p_reason
        WHEN 'user_permission_revoked' THEN 'tài khoản không còn quyền CRM cần cho lịch ('||COALESCE(p_detail->>'permission','')||'). Nhờ quản trị cấp lại quyền hoặc thu hồi lịch.'
        WHEN 'hermes_overlay_revoked' THEN 'kết nối Hermes đã tắt quyền cần cho lịch ('||COALESCE(p_detail->>'capability','')||'). Tạo kết nối mới có đủ quyền rồi tạo lại lịch.'
        WHEN 'company_policy_revoked' THEN 'chính sách Hermes của công ty không còn cho phép quyền lịch đang dùng. Quản trị công ty cần bật lại; lịch tạm dừng đến khi đó.'
        WHEN 'company_policy_disabled' THEN 'công ty đang tắt Hermes. Lịch tạm dừng đến khi quản trị bật lại.'
        WHEN 'capability_disabled' THEN 'tính năng này đang tắt trên hệ thống. Lịch tạm dừng đến khi được bật lại.'
        WHEN 'template_disabled' THEN 'chế độ lịch này đang tắt trên hệ thống. Lịch tạm dừng đến khi được bật lại.'
        WHEN 'connection_revoked' THEN 'kết nối Hermes của lịch đã bị thu hồi. Kết nối lại Hermes và tạo lại lịch nếu vẫn cần.'
        WHEN 'connection_token_expired' THEN 'mã kết nối Hermes của lịch đã hết hạn. Kết nối lại Hermes và tạo lại lịch nếu vẫn cần.'
        WHEN 'session_expired' THEN 'phiên CRM của kết nối Hermes đã hết hạn. Kết nối lại Hermes và tạo lại lịch nếu vẫn cần.'
        WHEN 'membership_inactive' THEN 'tài khoản không còn là thành viên đang hoạt động của công ty.'
        WHEN 'scope_narrowed' THEN 'phạm vi tòa nhà của bạn hoặc của kết nối đã bị thu hẹp. Sửa lịch bỏ tòa không còn quyền, hoặc nhờ cấp lại phạm vi.'
        WHEN 'target_denied' THEN 'một số nhóm nhận không còn trong phạm vi được gửi. Các nhóm còn quyền vẫn chạy; sửa lịch để bỏ nhóm này.'
        WHEN 'timezone_changed' THEN 'múi giờ công ty đã đổi. Sửa lịch theo múi giờ mới.'
        WHEN 'zalo_binding_changed' THEN 'liên kết Zalo của Hermes đã đổi. Liên kết lại Zalo rồi tạo lại lịch.'
        WHEN 'zalo_sender_unavailable' THEN 'nick Zalo gửi hoặc worker Zalo chưa sẵn sàng. Kiểm tra kết nối Zalo trong CRM.'
        WHEN 'zalo_directory_too_large' THEN 'nick Zalo gửi có quá nhiều nhóm để kiểm phạm vi an toàn.'
        WHEN 'legacy_owner_active' THEN 'tự động hóa cũ đang gửi phòng trống cho cùng nhóm. Tắt tự động hóa cũ cho nhóm này hoặc bỏ nhóm khỏi lịch.'
        WHEN 'blocked_by_unknown_delivery' THEN 'còn tin trước đó chưa rõ đã tới nhóm hay chưa. Kiểm tra trên Zalo rồi xác nhận ở mục Đối soát trong Trợ lý Hermes; hệ thống không gửi lại tự động.'
        WHEN 'other_owner_delivery_pending' THEN 'tin của lịch khác cho cùng nhóm vẫn đang chờ gửi quá lâu. Kiểm tra hàng chờ Zalo.'
        WHEN 'owner_conflict' THEN 'đã có lịch khác cùng nghiệp vụ cho nhóm và tòa này. Thu hồi một trong hai lịch.'
        WHEN 'queue_capacity' THEN 'hàng chờ gửi Zalo của công ty đang đầy. Lịch sẽ thử lại trong khung giờ cho phép.'
        WHEN 'room_limit' THEN 'số phòng vượt giới hạn của lịch nên chưa gửi, không cắt bớt. Tăng giới hạn phòng hoặc thu hẹp tòa.'
        WHEN 'daily_limit' THEN 'đã chạm trần số tin mỗi ngày của lịch.'
        WHEN 'message_too_large' THEN 'nội dung vượt giới hạn một tin nên chưa gửi, không cắt bớt. Thu hẹp phạm vi lịch.'
        WHEN 'missed_window' THEN 'lịch hôm nay đã quá 180 phút sau giờ hẹn mà chưa xếp hàng được cho mọi nhóm; không gửi bù. Kiểm tra worker Zalo và các báo lỗi khác của lịch.'
        WHEN 'membership_ambiguous' THEN 'tài khoản đang thuộc nhiều công ty nên Hermes tạm dừng truy cập CRM. Nhờ quản trị kiểm tra tư cách thành viên.'
        WHEN 'room_data_changed' THEN 'dữ liệu phòng công khai chưa hợp lệ để lập bản tin. Kiểm tra tên tòa, mã phòng và trạng thái phòng.'
        WHEN 'context_changed' THEN 'quyền hoặc kết nối thay đổi liên tục trong lúc chạy.'
        WHEN 'delivery_failed' THEN 'một tin của lịch chưa gửi được ('||COALESCE(p_detail->>'errorCode','không rõ mã')||'). Không gửi lại tự động; lượt sau chạy theo nhịp.'
        WHEN 'delivery_unknown' THEN 'một tin của lịch chưa rõ đã tới nhóm hay chưa. Kiểm tra trên Zalo rồi xác nhận ở mục Đối soát trong Trợ lý Hermes; hệ thống không gửi lại tự động.'
        WHEN 'grant_expiring' THEN 'ủy quyền lịch hết hạn lúc '||to_char(p_expires AT TIME ZONE 'Asia/Ho_Chi_Minh','HH24:MI DD/MM')||'. Sửa lịch để gia hạn nếu vẫn cần.'
        WHEN 'grant_expired' THEN 'ủy quyền lịch đã hết hạn nên lịch đã dừng. Tạo hoặc sửa lịch nếu muốn tiếp tục.'
        ELSE 'lịch không chạy được (mã '||p_reason||'). Kiểm tra lại cấu hình lịch.' END)
    END
$fn$;

-- Same delivery channel as the Zalo watchdog: in-app bell row plus send-push
-- through pg_net with the reminder service JWT slot. A marked TEST database
-- refuses that JWT, so TEST records only the bell. One idempotency key per
-- incident phase; the incident row records the attempt and never resends.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_notify_v1(p_incident uuid,p_phase text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,app_private,public AS $fn$
DECLARE i app_private.hermes_schedule_incidents; g app_private.hermes_schedule_grants; v_label text; v_text jsonb;
  v_jwt text; v_error text; v_req bigint;
BEGIN
  SELECT * INTO i FROM app_private.hermes_schedule_incidents WHERE id=p_incident;
  IF i.id IS NULL OR p_phase NOT IN ('opened','recovered') THEN RETURN jsonb_build_object('skipped','invalid'); END IF;
  IF NOT EXISTS(SELECT 1 FROM public.organization_memberships m JOIN public.organizations o ON o.id=m.organization_id
    WHERE m.user_id=i.user_id AND m.organization_id=i.organization_id AND o.status='ACTIVE' AND m.status='ACTIVE' AND m.revoked_at IS NULL
      AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=clock_timestamp() AND (m.valid_to IS NULL OR m.valid_to>clock_timestamp()))
    THEN RETURN jsonb_build_object('skipped','owner_inactive'); END IF;
  SELECT g2.* INTO g FROM app_private.hermes_room_schedules s JOIN app_private.hermes_schedule_grants g2 ON g2.id=s.grant_id WHERE s.id=i.schedule_id;
  v_label:=CASE WHEN g.settings->>'template'='sale_policy_public_text_v1' THEN 'Lịch báo đổi chính sách' ELSE 'Lịch bản tin phòng' END
    ||' …'||right(i.schedule_id::text,8);
  v_text:=app_private.hermes_schedule_message_v1(i.reason,p_phase,i.detail,v_label,g.expires_at);
  INSERT INTO public.notifications(organization_id,user_id,type,channel,status,subject,content,metadata)
    VALUES(i.organization_id,i.user_id,'CUSTOM','IN_APP','PENDING',v_text->>'title',v_text->>'body',
      jsonb_build_object('v5','hermes_schedule','incidentId',i.id,'scheduleId',i.schedule_id,'reason',i.reason,'phase',p_phase,'url','/settings/hermes'));
  BEGIN
    v_jwt:=app_private.lifecycle_reminder_service_jwt_v1();
  EXCEPTION WHEN OTHERS THEN v_jwt:=NULL; v_error:=left(SQLSTATE||': '||SQLERRM,300); END;
  IF v_jwt IS NOT NULL THEN
    v_req:=net.http_post(
      url:='https://tryymsxyyckgbrmmvozx.supabase.co/functions/v1/send-push',
      body:=jsonb_build_object('userId',i.user_id,'title',v_text->>'title','body',v_text->>'body','url','/settings/hermes',
        'tag','hermes-schedule:'||i.schedule_id::text,'idempotencyKey',left('hermes-schedule:'||i.id::text||':'||p_phase,128)),
      headers:=jsonb_build_object('Authorization','Bearer '||v_jwt,'Content-Type','application/json'),
      timeout_milliseconds:=30000);
  END IF;
  RETURN jsonb_build_object('bell',true,'pushRequestId',v_req,'pushError',v_error);
END $fn$;

-- After the catch-up window a blocked day is closed with its reason, so the
-- tick stops re-attempting it; the next scheduled day is evaluated afresh.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_close_blocked_day_v1(p_schedule uuid,p_reason text)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s app_private.hermes_room_schedules; g app_private.hermes_schedule_grants; local_now timestamp; v_count integer:=0;
BEGIN
  SELECT * INTO s FROM app_private.hermes_room_schedules WHERE id=p_schedule;
  SELECT * INTO g FROM app_private.hermes_schedule_grants WHERE id=s.grant_id;
  IF s.id IS NULL OR g.id IS NULL OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=g.settings->>'timeZone') THEN RETURN 0; END IF;
  local_now:=clock_timestamp() AT TIME ZONE (g.settings->>'timeZone');
  IF g.settings->'weekdays' @> to_jsonb(extract(isodow FROM local_now)::integer)
    AND local_now>local_now::date+(g.settings->>'time')::time+interval '180 minutes' THEN
    INSERT INTO app_private.hermes_schedule_runs(schedule_id,grant_id,local_date,conversation_id,outcome,reason)
      SELECT s.id,g.id,local_now::date,target::uuid,'missed',p_reason FROM jsonb_array_elements_text(g.settings->'conversationIds') target
      ON CONFLICT(schedule_id,local_date,conversation_id) DO NOTHING;
    GET DIAGNOSTICS v_count=ROW_COUNT;
  END IF;
  RETURN v_count;
END $fn$;

-- 12. Worker entry: same attempt as v1 inside a subtransaction, then durable
-- evidence in the outer transaction under the same org/schedule locks.
CREATE OR REPLACE FUNCTION public.hermes_room_schedule_run_v2(p_schedule_id uuid,p_expected_revision bigint,p_instance_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE org uuid; result jsonb; diag jsonb; v_state text; v_message text; v_reason text; v_closed integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'hermes_schedule_worker_denied' USING ERRCODE='42501'; END IF;
  SELECT organization_id INTO org FROM app_private.hermes_room_schedules WHERE id=p_schedule_id;
  IF org IS NULL THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(org);
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes-room-schedule:'||org::text,0));
  -- A stale or foreign worker records nothing.
  IF NOT EXISTS(SELECT 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id
    AND heartbeat_at>clock_timestamp()-interval '30 seconds' AND heartbeat_at<=clock_timestamp())
    THEN RAISE EXCEPTION 'hermes_schedule_worker_denied' USING ERRCODE='42501'; END IF;
  BEGIN
    result:=public.hermes_room_schedule_run_v1(p_schedule_id,p_expected_revision,p_instance_id);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state=RETURNED_SQLSTATE,v_message=MESSAGE_TEXT;
    IF v_message='hermes_schedule_worker_denied' THEN RAISE; END IF;
    result:=NULL;
  END;
  IF result IS NOT NULL THEN
    PERFORM app_private.hermes_schedule_observe_v1(p_schedule_id,result);
    RETURN result;
  END IF;
  diag:=app_private.hermes_schedule_diagnose_v1(p_schedule_id);
  v_reason:=diag->>'reason';
  -- v1 already skips denied recipients, so a recipient denial never explains
  -- an exception: keep it as its own incident and classify the error itself.
  IF v_reason='target_denied' THEN
    PERFORM app_private.hermes_schedule_incident_open_v1(p_schedule_id,'authority','target_denied',diag->'detail');
    v_reason:=NULL;
  END IF;
  IF v_reason IS NULL THEN
    v_reason:=CASE WHEN v_message IN ('hermes_group_rooms_changed','hermes_group_rooms_incomplete') THEN 'room_data_changed'
      WHEN v_message='hermes_schedule_message_invalid' THEN 'message_too_large'
      WHEN v_message IN ('hermes_group_context_changed','hermes_group_target_changed') OR v_state IN ('40001','40P01','55P03') THEN 'context_changed'
      ELSE 'unclassified' END;
    diag:=jsonb_build_object('reason',v_reason,'kind','run','detail',jsonb_build_object('sqlstate',v_state,
      'code',CASE WHEN v_message ~ '^hermes_[a-z0-9_]{1,60}$' THEN v_message END));
  END IF;
  IF v_reason<>'schedule_inactive' THEN
    -- The blocking incident already tells the owner; the closed day only
    -- stops re-attempts and keeps the reason on each missed recipient row.
    PERFORM app_private.hermes_schedule_incident_open_v1(p_schedule_id,diag->>'kind',v_reason,diag->'detail');
    v_closed:=app_private.hermes_schedule_close_blocked_day_v1(p_schedule_id,v_reason);
  END IF;
  RETURN jsonb_build_object('status','blocked','reason',v_reason,'closedRecipients',COALESCE(v_closed,0));
END $fn$;

-- 13. Proactive probe: report authority/scope/overlay/policy changes before
-- the next due time. Separate short transaction per schedule.
CREATE OR REPLACE FUNCTION public.hermes_room_schedule_probe_v1(p_schedule_id uuid,p_instance_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE org uuid; s app_private.hermes_room_schedules; diag jsonb; v_reason text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'hermes_schedule_worker_denied' USING ERRCODE='42501'; END IF;
  SELECT organization_id INTO org FROM app_private.hermes_room_schedules WHERE id=p_schedule_id;
  IF org IS NULL THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(org);
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes-room-schedule:'||org::text,0));
  IF NOT EXISTS(SELECT 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id
    AND heartbeat_at>clock_timestamp()-interval '30 seconds' AND heartbeat_at<=clock_timestamp())
    THEN RAISE EXCEPTION 'hermes_schedule_worker_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO s FROM app_private.hermes_room_schedules WHERE id=p_schedule_id FOR UPDATE;
  UPDATE app_private.hermes_room_schedules SET last_probed_at=clock_timestamp() WHERE id=s.id;
  diag:=app_private.hermes_schedule_diagnose_v1(s.id);
  v_reason:=diag->>'reason';
  IF v_reason IS NULL THEN
    PERFORM app_private.hermes_schedule_incident_close_v1(s.id,ARRAY['authority'],'{}'::text[],'recovered');
    RETURN jsonb_build_object('status','healthy');
  END IF;
  IF v_reason IN ('schedule_inactive','grant_expired') THEN RETURN jsonb_build_object('status','inactive','reason',v_reason); END IF;
  IF v_reason='target_denied' THEN
    PERFORM app_private.hermes_schedule_incident_close_v1(s.id,ARRAY['authority'],ARRAY['target_denied'],'recovered');
  END IF;
  PERFORM app_private.hermes_schedule_incident_open_v1(s.id,diag->>'kind',v_reason,diag->'detail');
  RETURN jsonb_build_object('status','blocked','reason',v_reason);
END $fn$;

-- 14. Maintenance + delivery outcomes + expiry + notifications on the existing
-- worker tick. Bounded batches; never takes the lease row lock.
CREATE OR REPLACE FUNCTION public.hermes_room_schedule_sweep_v1(p_instance_id uuid,p_organization_ids uuid[] DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_pruned jsonb; v_expired integer:=0; v_observed integer:=0; v_notified integer:=0; v_expiry integer:=0; v_closed integer:=0;
  v_row record; v_incident app_private.hermes_schedule_incidents; v_result jsonb; v_probes jsonb; v_jobs uuid[]; v_messages uuid[];
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' OR p_organization_ids IS NULL OR cardinality(p_organization_ids)>100
    OR NOT EXISTS(SELECT 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id
      AND heartbeat_at>clock_timestamp()-interval '30 seconds' AND heartbeat_at<=clock_timestamp())
    THEN RAISE EXCEPTION 'hermes_schedule_worker_denied' USING ERRCODE='42501'; END IF;
  -- (a) Expired private commands: DISPATCHED becomes UNKNOWN_EFFECT, the rest
  -- EXPIRED; content cleared. Existing helper, no replay.
  v_pruned:=app_private.hermes_store_prune_private_commands_v1(jsonb_build_object('limit',64));
  -- (b) Queued Hermes group jobs whose dispatch expired can never be admitted
  -- by the provider gate. Mark them failed (definitely not sent).
  WITH picked AS (SELECT q.id,q.message_id FROM public.zalo_send_queue q JOIN app_private.hermes_group_dispatches h ON h.id=q.hermes_group_dispatch_id
      WHERE q.status='queued' AND q.provider_started_at IS NULL AND h.expires_at<=clock_timestamp()
        AND (cardinality(p_organization_ids)=0 OR q.organization_id=ANY(p_organization_ids))
      ORDER BY h.expires_at,q.id LIMIT 128 FOR UPDATE OF q SKIP LOCKED),
    expired AS (UPDATE public.zalo_send_queue q SET status='failed',processed_at=clock_timestamp(),
      last_error='EXPIRED_HERMES_DISPATCH: hết hạn trước khi gửi; không tự gửi lại',
      result=COALESCE(q.result,'{}'::jsonb)||jsonb_build_object('outcome','expired')
      FROM picked WHERE q.id=picked.id AND q.status='queued' RETURNING q.id,q.message_id)
  SELECT array_agg(id),array_agg(message_id) FILTER(WHERE message_id IS NOT NULL) INTO v_jobs,v_messages FROM expired;
  v_expired:=COALESCE(cardinality(v_jobs),0);
  IF v_expired>0 THEN
    UPDATE public.zalo_messages SET status='failed' WHERE id=ANY(v_messages) AND status='pending';
  END IF;
  -- (c) Terminal delivery outcomes of scheduled jobs become incidents once.
  FOR v_row IN SELECT r.schedule_id,r.dispatch_id,r.conversation_id,q.id AS job_id,
      CASE WHEN q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true' THEN 'unknown' ELSE 'failed' END AS outcome,
      substring(q.last_error FROM '^([A-Z][A-Z_]{2,40})') AS error_code
    FROM app_private.hermes_schedule_runs r JOIN app_private.hermes_group_jobs j ON j.dispatch_id=r.dispatch_id
      JOIN public.zalo_send_queue q ON q.id=j.job_id JOIN app_private.hermes_room_schedules s ON s.id=r.schedule_id
    WHERE r.outcome='queued' AND r.created_at>clock_timestamp()-interval '8 days' AND q.status='failed' AND NOT(COALESCE(q.result,'{}'::jsonb) ? 'reconciliation')
      AND (cardinality(p_organization_ids)=0 OR s.organization_id=ANY(p_organization_ids))
      AND NOT EXISTS(SELECT 1 FROM app_private.hermes_schedule_delivery_observations o WHERE o.job_id=q.id
        AND o.outcome=CASE WHEN q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true' THEN 'unknown' ELSE 'failed' END)
    ORDER BY r.created_at,q.id LIMIT 50 LOOP
    INSERT INTO app_private.hermes_schedule_delivery_observations(job_id,outcome,schedule_id,dispatch_id)
      VALUES(v_row.job_id,v_row.outcome,v_row.schedule_id,v_row.dispatch_id) ON CONFLICT DO NOTHING;
    PERFORM app_private.hermes_schedule_incident_open_v1(v_row.schedule_id,'delivery','delivery_'||v_row.outcome,
      jsonb_build_object('jobId',v_row.job_id,'dispatchId',v_row.dispatch_id,'conversationId',v_row.conversation_id,'errorCode',v_row.error_code));
    v_observed:=v_observed+1;
  END LOOP;
  -- Close delivery incidents that no longer hold: unknowns reconciled, or a
  -- later scheduled delivery confirmed sent after the failure was seen.
  UPDATE app_private.hermes_schedule_incidents i SET closed_at=clock_timestamp(),close_reason='recovered'
    WHERE i.closed_at IS NULL AND i.kind='delivery' AND (cardinality(p_organization_ids)=0 OR i.organization_id=ANY(p_organization_ids))
      AND ((i.reason='delivery_unknown' AND NOT EXISTS(SELECT 1 FROM app_private.hermes_schedule_runs r
          JOIN app_private.hermes_group_jobs j ON j.dispatch_id=r.dispatch_id JOIN public.zalo_send_queue q ON q.id=j.job_id
          WHERE r.schedule_id=i.schedule_id AND r.outcome='queued' AND q.status='failed'
            AND (q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true')))
        OR (i.reason='delivery_failed' AND EXISTS(SELECT 1 FROM app_private.hermes_schedule_runs r
          JOIN app_private.hermes_group_jobs j ON j.dispatch_id=r.dispatch_id JOIN public.zalo_send_queue q ON q.id=j.job_id
          WHERE r.schedule_id=i.schedule_id AND r.outcome='queued' AND q.status='sent' AND q.processed_at>i.last_seen_at)));
  GET DIAGNOSTICS v_closed=ROW_COUNT;
  -- (d) Revoked schedules: their incidents end without a recovery notice.
  UPDATE app_private.hermes_schedule_incidents i SET closed_at=clock_timestamp(),close_reason='schedule_revoked'
    FROM app_private.hermes_room_schedules s WHERE s.id=i.schedule_id AND i.closed_at IS NULL AND s.state='REVOKED'
      AND (cardinality(p_organization_ids)=0 OR i.organization_id=ANY(p_organization_ids));
  -- (e) Standing-grant expiry: one warning per grant 72 hours ahead, one notice
  -- at expiry; a replaced grant closes the old notices silently.
  UPDATE app_private.hermes_schedule_incidents i SET closed_at=clock_timestamp(),close_reason='grant_replaced'
    FROM app_private.hermes_room_schedules s WHERE s.id=i.schedule_id AND i.closed_at IS NULL AND i.kind='expiry'
      AND i.detail->>'grantId' IS DISTINCT FROM s.grant_id::text;
  FOR v_row IN SELECT s.id,g.id AS grant_id,g.expires_at FROM app_private.hermes_room_schedules s JOIN app_private.hermes_schedule_grants g ON g.id=s.grant_id
    WHERE s.state='ACTIVE' AND g.expires_at<=clock_timestamp()+interval '72 hours'
      AND (cardinality(p_organization_ids)=0 OR s.organization_id=ANY(p_organization_ids))
      AND NOT EXISTS(SELECT 1 FROM app_private.hermes_schedule_incidents i WHERE i.schedule_id=s.id AND i.kind='expiry'
        AND i.detail->>'grantId'=g.id::text AND i.reason=CASE WHEN g.expires_at<=clock_timestamp() THEN 'grant_expired' ELSE 'grant_expiring' END)
    ORDER BY g.expires_at,s.id LIMIT 50 LOOP
    IF v_row.expires_at<=clock_timestamp() THEN
      -- The expired grant is now the only reason the schedule stopped; open
      -- delivery reconciliation work stays open.
      UPDATE app_private.hermes_schedule_incidents SET closed_at=clock_timestamp(),close_reason='superseded'
        WHERE schedule_id=v_row.id AND closed_at IS NULL AND (kind IN ('authority','run') OR (kind='expiry' AND reason='grant_expiring'));
    END IF;
    PERFORM app_private.hermes_schedule_incident_open_v1(v_row.id,'expiry',
      CASE WHEN v_row.expires_at<=clock_timestamp() THEN 'grant_expired' ELSE 'grant_expiring' END,
      jsonb_build_object('grantId',v_row.grant_id,'expiresAt',to_char(v_row.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    v_expiry:=v_expiry+1;
  END LOOP;
  -- (f) Notify the schedule owner once per incident. Transient causes wait
  -- 15 minutes so a short flap closes silently.
  FOR v_incident IN SELECT * FROM app_private.hermes_schedule_incidents i
    WHERE i.closed_at IS NULL AND i.notified_at IS NULL AND (cardinality(p_organization_ids)=0 OR i.organization_id=ANY(p_organization_ids))
      AND i.opened_at<=clock_timestamp()-CASE WHEN i.reason IN ('zalo_sender_unavailable','queue_capacity','other_owner_delivery_pending',
        'room_data_changed','context_changed','unclassified') THEN interval '15 minutes' ELSE interval '0' END
    ORDER BY i.opened_at,i.id LIMIT 20 FOR UPDATE SKIP LOCKED LOOP
    -- A failing bell/push write must not stall maintenance; the attempt and
    -- its error are recorded once, never retried in a loop.
    BEGIN v_result:=app_private.hermes_schedule_notify_v1(v_incident.id,'opened');
    EXCEPTION WHEN OTHERS THEN v_result:=jsonb_build_object('error',SQLSTATE); END;
    UPDATE app_private.hermes_schedule_incidents SET notified_at=clock_timestamp(),notify_result=v_result WHERE id=v_incident.id;
    v_notified:=v_notified+1;
  END LOOP;
  FOR v_incident IN SELECT * FROM app_private.hermes_schedule_incidents i
    WHERE i.close_reason='recovered' AND i.notified_at IS NOT NULL AND i.closed_notified_at IS NULL AND i.kind IN ('authority','run')
      AND (cardinality(p_organization_ids)=0 OR i.organization_id=ANY(p_organization_ids))
    ORDER BY i.closed_at,i.id LIMIT 20 FOR UPDATE SKIP LOCKED LOOP
    BEGIN PERFORM app_private.hermes_schedule_notify_v1(v_incident.id,'recovered');
    EXCEPTION WHEN OTHERS THEN NULL; END;
    UPDATE app_private.hermes_schedule_incidents SET closed_notified_at=clock_timestamp() WHERE id=v_incident.id;
    v_notified:=v_notified+1;
  END LOOP;
  -- (g) Probe candidates; each probe runs in its own worker call.
  SELECT COALESCE(jsonb_agg(id ORDER BY ord),'[]'::jsonb) INTO v_probes FROM (
    SELECT s.id,row_number() OVER(ORDER BY s.last_probed_at NULLS FIRST,s.id) ord FROM app_private.hermes_room_schedules s
      JOIN app_private.hermes_schedule_grants g ON g.id=s.grant_id
    WHERE s.state='ACTIVE' AND g.expires_at>clock_timestamp() AND (s.last_probed_at IS NULL OR s.last_probed_at<clock_timestamp()-interval '10 minutes')
      AND (cardinality(p_organization_ids)=0 OR s.organization_id=ANY(p_organization_ids))
    ORDER BY s.last_probed_at NULLS FIRST,s.id LIMIT 5) candidates;
  RETURN jsonb_build_object('prunedCommands',COALESCE((v_pruned->>'count')::integer,0),'expiredJobs',v_expired,'observed',v_observed,
    'closed',v_closed,'expiry',v_expiry,'notified',v_notified,'probes',v_probes);
END $fn$;

-- 15. ACL. Worker gets run_v2/probe/sweep only; helpers are private.
DO $permissions$
DECLARE signature text; name text;
BEGIN
  FOR signature,name IN SELECT p.oid::regprocedure::text,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE (n.nspname='app_private' AND p.proname IN ('hermes_schedule_incident_guard_v1','hermes_schedule_settings_v1','hermes_schedule_building_allowed_v1',
      'hermes_schedule_scope_v2','hermes_schedule_owner_state_v1','hermes_schedule_owner_v1','hermes_schedule_legacy_owner_v1',
      'hermes_schedule_policy_projection_v1','hermes_schedule_policy_body_v1','hermes_schedule_policy_snapshot_v1','hermes_schedule_current_v1',
      'hermes_schedule_diagnose_v1','hermes_schedule_incident_open_v1','hermes_schedule_incident_close_v1','hermes_schedule_observe_v1',
      'hermes_schedule_message_v1','hermes_schedule_notify_v1','hermes_schedule_close_blocked_day_v1'))
      OR (n.nspname='public' AND p.proname IN ('hermes_room_schedule_run_v1','hermes_room_schedule_run_v2','hermes_room_schedule_probe_v1',
        'hermes_room_schedule_sweep_v1')) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',signature);
    IF name IN ('hermes_room_schedule_run_v1','hermes_room_schedule_run_v2','hermes_room_schedule_probe_v1','hermes_room_schedule_sweep_v1')
      THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',signature); END IF;
  END LOOP;
END $permissions$;
COMMIT;
NOTIFY pgrst,'reload schema';
