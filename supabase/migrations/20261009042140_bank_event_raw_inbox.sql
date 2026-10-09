-- Global raw-event inbox. It has no financial writer or bank-transaction semantics.
-- Payload encryption/decryption belongs to the Edge functions; keys never enter SQL.
CREATE TABLE IF NOT EXISTS app_private.bank_event_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 enabled boolean NOT NULL DEFAULT true, revoked_at timestamptz, device_id uuid,
 organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), created_by uuid NOT NULL,
 last_seen_at timestamptz, last_event_at timestamptz, heartbeat jsonb,
 CHECK(heartbeat IS NULL OR jsonb_typeof(heartbeat)='object')
);
CREATE TABLE IF NOT EXISTS app_private.bank_event_credentials (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES app_private.bank_event_sources(id),
 digest text NOT NULL UNIQUE CHECK(digest ~ '^[a-f0-9]{64}$'), fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_event_one_active_credential ON app_private.bank_event_credentials(source_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS app_private.bank_inbound_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES app_private.bank_event_sources(id),
 external_id text NOT NULL CHECK(external_id ~ '^[a-f0-9]{64}$'), device_id uuid NOT NULL,
 event_type text NOT NULL CHECK(event_type IN ('sms.received','notification.received','gateway.test')),
 occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 ciphertext text NOT NULL CHECK(length(ciphertext) BETWEEN 20 AND 90000), nonce text NOT NULL,
 key_id text NOT NULL CHECK(length(key_id) BETWEEN 1 AND 64), duplicate_count bigint NOT NULL DEFAULT 0,
 UNIQUE(source_id,external_id)
);
CREATE INDEX IF NOT EXISTS bank_events_received_cursor ON app_private.bank_inbound_events(received_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS bank_events_source_cursor ON app_private.bank_inbound_events(source_id,received_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS app_private.bank_event_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id uuid NOT NULL,
 action text NOT NULL, source_id uuid REFERENCES app_private.bank_event_sources(id),
 event_id uuid REFERENCES app_private.bank_inbound_events(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE app_private.bank_event_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.bank_event_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.bank_inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.bank_event_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.bank_event_sources,app_private.bank_event_credentials,app_private.bank_inbound_events,app_private.bank_event_audit FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE app_private.bank_event_audit_id_seq FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.bank_event_source_json_v1(p_source app_private.bank_event_sources)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
 SELECT jsonb_build_object('id',p_source.id,'name',p_source.name,'enabled',p_source.enabled,
  'revokedAt',p_source.revoked_at,'deviceId',p_source.device_id,'organizationId',p_source.organization_id,
  'createdAt',p_source.created_at,'lastSeenAt',p_source.last_seen_at,'lastEventAt',p_source.last_event_at,
  'heartbeat',p_source.heartbeat,'credentialFingerprint',c.fingerprint,'credentialCreatedAt',c.created_at)
 FROM (SELECT 1) x LEFT JOIN LATERAL (
  SELECT fingerprint,created_at FROM app_private.bank_event_credentials WHERE source_id=p_source.id AND revoked_at IS NULL
 ) c ON true;
$fn$;
CREATE OR REPLACE FUNCTION app_private.bank_event_metadata_v1(p_event app_private.bank_inbound_events,p_source app_private.bank_event_sources)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
 SELECT jsonb_build_object('id',p_event.id,'externalId',p_event.external_id,'sourceId',p_event.source_id,
  'sourceName',p_source.name,'eventType',p_event.event_type,'deviceId',p_event.device_id,
  'occurredAt',p_event.occurred_at,'receivedAt',p_event.received_at,'duplicateCount',p_event.duplicate_count,
  'organizationId',p_source.organization_id);
$fn$;
REVOKE ALL ON FUNCTION app_private.bank_event_source_json_v1(app_private.bank_event_sources),app_private.bank_event_metadata_v1(app_private.bank_inbound_events,app_private.bank_event_sources) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.bank_event_ingest_v1(p_digest text,p_external_id text,p_device_id uuid,
 p_event_type text,p_occurred_at timestamptz,p_payload_hash text,p_ciphertext text,p_nonce text,p_key_id text,p_heartbeat jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s app_private.bank_event_sources; c app_private.bank_event_credentials; e app_private.bank_inbound_events; sid uuid; now_at timestamptz;
BEGIN
 IF p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Unauthorized source' USING ERRCODE='28000'; END IF;
 SELECT source_id INTO sid FROM app_private.bank_event_credentials WHERE digest=p_digest;
 IF sid IS NULL THEN RAISE EXCEPTION 'Unauthorized source' USING ERRCODE='28000'; END IF;
 -- Always lock source before credentials. Rotation, pause and concurrent first binding serialize here.
 SELECT * INTO s FROM app_private.bank_event_sources WHERE id=sid FOR UPDATE;
 SELECT * INTO c FROM app_private.bank_event_credentials WHERE digest=p_digest AND source_id=s.id FOR UPDATE;
 IF c.id IS NULL OR c.revoked_at IS NOT NULL OR s.revoked_at IS NOT NULL OR NOT s.enabled THEN
  RAISE EXCEPTION 'Unauthorized source' USING ERRCODE='28000'; END IF;
 now_at:=clock_timestamp();
 IF p_device_id IS NULL OR p_external_id IS NULL OR p_external_id !~ '^[a-f0-9]{64}$'
  OR p_event_type IS NULL OR p_event_type NOT IN ('sms.received','notification.received','gateway.test','gateway.heartbeat')
  OR p_occurred_at IS NULL OR NOT isfinite(p_occurred_at) THEN RAISE EXCEPTION 'Invalid event' USING ERRCODE='22023'; END IF;
 IF s.device_id IS NOT NULL AND s.device_id<>p_device_id THEN RAISE EXCEPTION 'Device binding conflict' USING ERRCODE='PT409'; END IF;
 IF p_event_type='gateway.heartbeat' THEN
  IF p_heartbeat IS NULL OR jsonb_typeof(p_heartbeat)<>'object' OR length(p_heartbeat::text)>2048 THEN
   RAISE EXCEPTION 'Invalid heartbeat' USING ERRCODE='22023'; END IF;
  UPDATE app_private.bank_event_sources SET device_id=COALESCE(device_id,p_device_id),last_seen_at=now_at,
   heartbeat=CASE WHEN heartbeat IS NULL OR p_occurred_at>=(heartbeat->>'receivedAt')::timestamptz THEN p_heartbeat ELSE heartbeat END WHERE id=s.id;
  RETURN jsonb_build_object('status','heartbeat','acceptedAt',now_at,'eventId',NULL,'sourceId',s.id,'externalId',p_external_id);
 END IF;
 IF p_payload_hash IS NULL OR p_payload_hash !~ '^[a-f0-9]{64}$' OR p_ciphertext IS NULL
  OR p_nonce IS NULL OR p_nonce !~ '^[A-Za-z0-9+/]{16}$' OR p_key_id IS NULL THEN
  RAISE EXCEPTION 'Invalid encrypted event' USING ERRCODE='22023'; END IF;
 SELECT * INTO e FROM app_private.bank_inbound_events WHERE source_id=s.id AND external_id=p_external_id;
 IF e.id IS NOT NULL THEN
  IF e.payload_hash<>p_payload_hash THEN RAISE EXCEPTION 'Event id conflict' USING ERRCODE='PT409'; END IF;
  UPDATE app_private.bank_inbound_events SET duplicate_count=duplicate_count+1 WHERE id=e.id;
  UPDATE app_private.bank_event_sources SET last_seen_at=now_at WHERE id=s.id;
  RETURN jsonb_build_object('status','duplicate','eventId',e.id,'acceptedAt',e.received_at,'sourceId',s.id,'externalId',p_external_id);
 END IF;
 INSERT INTO app_private.bank_inbound_events(source_id,external_id,device_id,event_type,occurred_at,payload_hash,ciphertext,nonce,key_id)
 VALUES(s.id,p_external_id,p_device_id,p_event_type,p_occurred_at,p_payload_hash,p_ciphertext,p_nonce,p_key_id) RETURNING * INTO e;
 UPDATE app_private.bank_event_sources SET device_id=COALESCE(device_id,p_device_id),last_seen_at=now_at,last_event_at=now_at WHERE id=s.id;
 RETURN jsonb_build_object('status','accepted','eventId',e.id,'acceptedAt',e.received_at,'sourceId',s.id,'externalId',p_external_id);
END;
$fn$;
REVOKE ALL ON FUNCTION public.bank_event_ingest_v1(text,text,uuid,text,timestamptz,text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.bank_event_ingest_v1(text,text,uuid,text,timestamptz,text,text,text,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.bank_event_admin_v1(p_action text,p_input jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE actor uuid:=auth.uid(); s app_private.bank_event_sources; e app_private.bank_inbound_events; v_source_filter uuid;
 rows_json jsonb; before_time timestamptz; before_id uuid; from_time timestamptz; to_time timestamptz;
 lim integer; query_text text; event_filter text;
BEGIN
 -- This is an explicit global super-admin surface, independent from company-admin permissions.
 IF actor IS NULL OR NOT COALESCE(public.is_super_admin(),false) THEN RAISE EXCEPTION 'Super admin only' USING ERRCODE='42501'; END IF;
 IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' THEN RAISE EXCEPTION 'Invalid input' USING ERRCODE='22023'; END IF;
 IF p_action='list_sources' THEN
  SELECT COALESCE(jsonb_agg(app_private.bank_event_source_json_v1(x) ORDER BY x.created_at DESC,x.id DESC),'[]'::jsonb) INTO rows_json FROM app_private.bank_event_sources x;
  RETURN jsonb_build_object('sources',rows_json);
 ELSIF p_action='status' THEN
  RETURN jsonb_build_object('serverTime',clock_timestamp(),
   'totalSources',(SELECT count(*) FROM app_private.bank_event_sources),
   'enabledSources',(SELECT count(*) FROM app_private.bank_event_sources WHERE enabled AND revoked_at IS NULL),
   'totalEvents',(SELECT count(*) FROM app_private.bank_inbound_events),
   'lastReceivedAt',(SELECT max(received_at) FROM app_private.bank_inbound_events));
 ELSIF p_action IN ('create_source','rotate_source','set_source_enabled','revoke_source') THEN
  IF p_action='create_source' THEN
   IF p_input->>'name' IS NULL OR length(btrim(p_input->>'name')) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'Invalid name' USING ERRCODE='22023'; END IF;
   INSERT INTO app_private.bank_event_sources(name,created_by) VALUES(btrim(p_input->>'name'),actor) RETURNING * INTO s;
  ELSE
   SELECT * INTO s FROM app_private.bank_event_sources WHERE id=(p_input->>'sourceId')::uuid FOR UPDATE;
   IF s.id IS NULL THEN RAISE EXCEPTION 'Source not found' USING ERRCODE='P0002'; END IF;
   IF s.revoked_at IS NOT NULL AND p_action<>'revoke_source' THEN RAISE EXCEPTION 'Source revoked' USING ERRCODE='PT409'; END IF;
  END IF;
  IF p_action IN ('create_source','rotate_source') THEN
   IF p_input->>'credentialDigest' IS NULL OR p_input->>'credentialDigest' !~ '^[a-f0-9]{64}$'
    OR p_input->>'fingerprint' IS NULL OR p_input->>'fingerprint' !~ '^sha256:[a-f0-9]{12}$' THEN
    RAISE EXCEPTION 'Invalid credential' USING ERRCODE='22023'; END IF;
   UPDATE app_private.bank_event_credentials SET revoked_at=clock_timestamp() WHERE source_id=s.id AND revoked_at IS NULL;
   INSERT INTO app_private.bank_event_credentials(source_id,digest,fingerprint) VALUES(s.id,p_input->>'credentialDigest',p_input->>'fingerprint');
  ELSIF p_action='set_source_enabled' THEN
   IF jsonb_typeof(p_input->'enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Invalid enabled flag' USING ERRCODE='22023'; END IF;
   UPDATE app_private.bank_event_sources SET enabled=(p_input->>'enabled')::boolean WHERE id=s.id RETURNING * INTO s;
  ELSE
   UPDATE app_private.bank_event_sources SET revoked_at=COALESCE(revoked_at,clock_timestamp()),enabled=false WHERE id=s.id RETURNING * INTO s;
   UPDATE app_private.bank_event_credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE source_id=s.id;
  END IF;
  INSERT INTO app_private.bank_event_audit(actor_id,action,source_id) VALUES(actor,p_action,s.id);
  RETURN jsonb_build_object('source',app_private.bank_event_source_json_v1(s));
 ELSIF p_action='list_events' THEN
  lim:=COALESCE((p_input->>'limit')::integer,25);
  IF lim NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid limit' USING ERRCODE='22023'; END IF;
  v_source_filter:=(p_input->>'sourceId')::uuid; event_filter:=p_input->>'eventType'; query_text:=p_input->>'query';
  IF length(query_text)>120 OR (event_filter IS NOT NULL AND event_filter NOT IN ('sms.received','notification.received','gateway.test')) THEN RAISE EXCEPTION 'Invalid filter' USING ERRCODE='22023'; END IF;
  before_time:=(p_input->>'beforeTime')::timestamptz; before_id:=(p_input->>'beforeId')::uuid;
  from_time:=(p_input->>'from')::timestamptz; to_time:=(p_input->>'to')::timestamptz;
  IF (before_time IS NULL)<>(before_id IS NULL) OR (from_time IS NOT NULL AND NOT isfinite(from_time))
   OR (to_time IS NOT NULL AND NOT isfinite(to_time)) OR (before_time IS NOT NULL AND NOT isfinite(before_time)) THEN RAISE EXCEPTION 'Invalid cursor' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(jsonb_agg(x.item ORDER BY x.received_at DESC,x.id DESC),'[]'::jsonb) INTO rows_json FROM (
   SELECT app_private.bank_event_metadata_v1(ev,src) item,ev.received_at,ev.id
   FROM app_private.bank_inbound_events ev JOIN app_private.bank_event_sources src ON src.id=ev.source_id
   WHERE (v_source_filter IS NULL OR ev.source_id=v_source_filter) AND (event_filter IS NULL OR ev.event_type=event_filter)
    AND (query_text IS NULL OR strpos(lower(src.name),lower(query_text))>0 OR strpos(ev.external_id,lower(query_text))>0)
    AND (from_time IS NULL OR ev.received_at>=from_time) AND (to_time IS NULL OR ev.received_at<to_time)
    AND (before_time IS NULL OR (ev.received_at,ev.id)<(before_time,before_id))
   ORDER BY ev.received_at DESC,ev.id DESC LIMIT lim+1
  ) x;
  RETURN jsonb_build_object('events',rows_json);
 ELSIF p_action='get_event' THEN
  SELECT * INTO e FROM app_private.bank_inbound_events WHERE id=(p_input->>'eventId')::uuid;
  IF e.id IS NULL THEN RAISE EXCEPTION 'Event not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO s FROM app_private.bank_event_sources WHERE id=e.source_id;
  INSERT INTO app_private.bank_event_audit(actor_id,action,source_id,event_id) VALUES(actor,'read_event',s.id,e.id);
  RETURN jsonb_build_object('event',app_private.bank_event_metadata_v1(e,s),'ciphertext',e.ciphertext,
   'nonce',e.nonce,'keyId',e.key_id,'payloadHash',e.payload_hash);
 END IF;
 RAISE EXCEPTION 'Unknown action' USING ERRCODE='22023';
END;
$fn$;
REVOKE ALL ON FUNCTION public.bank_event_admin_v1(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.bank_event_admin_v1(text,jsonb) TO authenticated;
