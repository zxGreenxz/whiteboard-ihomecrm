-- Independent recorder domain. No camera is represented as a router or an AP.
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(20261022145352::bigint);

CREATE TABLE IF NOT EXISTS public.camera_recorders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 128),
  vendor text NOT NULL CHECK (vendor IN ('KBVISION','DAHUA')),
  model text CHECK (length(model) <= 128),
  channel_count integer NOT NULL CHECK (channel_count BETWEEN 1 AND 256),
  enabled boolean NOT NULL DEFAULT false,
  stale_after_seconds integer NOT NULL DEFAULT 180 CHECK (stale_after_seconds BETWEEN 60 AND 3600),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,building_id,id),
  FOREIGN KEY (organization_id,building_id) REFERENCES public.buildings(organization_id,id) ON DELETE RESTRICT
);

-- Transport and opaque credential reference are never browser-visible.
CREATE TABLE IF NOT EXISTS app_private.camera_recorder_connections (
  recorder_id uuid PRIMARY KEY REFERENCES public.camera_recorders(id) ON DELETE RESTRICT,
  router_connection_id uuid NOT NULL REFERENCES public.network_device_connections(id) ON DELETE RESTRICT,
  endpoint text NOT NULL CHECK (endpoint ~ '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' AND length(endpoint) <= 300),
  credential_ref text NOT NULL CHECK (credential_ref ~ '^camera/[A-Za-z0-9._/-]{1,120}$'),
  poll_interval_seconds integer NOT NULL DEFAULT 60 CHECK (poll_interval_seconds BETWEEN 30 AND 3600),
  connect_timeout_ms integer NOT NULL DEFAULT 8000 CHECK (connect_timeout_ms BETWEEN 1000 AND 30000)
);
REVOKE ALL ON app_private.camera_recorder_connections FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE IF NOT EXISTS public.camera_recorder_current (
  recorder_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('ONLINE','OFFLINE','UNKNOWN','AUTH_DENIED')),
  checked_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  channels jsonb NOT NULL CHECK (jsonb_typeof(channels)='array' AND jsonb_array_length(channels)<=256),
  storage jsonb NOT NULL CHECK (jsonb_typeof(storage)='array' AND jsonb_array_length(storage)<=32),
  event_coverage text NOT NULL CHECK (event_coverage IN ('STATE_POLLING_ONLY','EVENT_STREAM')),
  issues text[] NOT NULL DEFAULT '{}' CHECK (cardinality(issues)<=6),
  FOREIGN KEY (organization_id,building_id,recorder_id) REFERENCES public.camera_recorders(organization_id,building_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.camera_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recorder_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('RECORDER','CHANNEL','STORAGE','DEVICE')),
  channel integer CHECK (channel BETWEEN 1 AND 256),
  slot integer CHECK (slot BETWEEN 1 AND 32),
  previous_state text,
  state text NOT NULL,
  code text,
  action text CHECK (action IN ('Start','Stop','Pulse')),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(recorder_id,event_key),
  FOREIGN KEY (organization_id,building_id,recorder_id) REFERENCES public.camera_recorders(organization_id,building_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS camera_events_building_time_idx ON public.camera_events(building_id,observed_at DESC,id DESC);

-- Enrollment is a service-operator action, not a worker-supplied identity. The
-- caller supplies an exact existing router connection and its expected tenant.
CREATE OR REPLACE FUNCTION public.network_center_admin_enroll_camera_v1(
  p_recorder_id uuid,p_organization_id uuid,p_building_id uuid,p_router_connection_id uuid,
  p_display_name text,p_vendor text,p_model text,p_channel_count integer,p_endpoint text,p_credential_ref text,
  p_enabled boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $fn$
DECLARE r public.camera_recorders%ROWTYPE;
BEGIN
  IF p_recorder_id IS NULL OR p_organization_id IS NULL OR p_building_id IS NULL OR p_router_connection_id IS NULL THEN
    RAISE EXCEPTION 'Exact camera identity required' USING ERRCODE='22023';
  END IF;
  -- Same recorder lock as ingest, including first enrollment before a row exists.
  PERFORM pg_advisory_xact_lock(hashtextextended('camera:'||p_recorder_id::text,0));
  SELECT * INTO r FROM public.camera_recorders WHERE id=p_recorder_id FOR UPDATE;
  PERFORM 1 FROM public.network_device_connections n JOIN public.network_devices d ON d.id=n.device_id
    WHERE n.id=p_router_connection_id AND n.organization_id=p_organization_id AND n.building_id=p_building_id
      AND d.organization_id=n.organization_id AND d.building_id=n.building_id AND d.device_kind='MIKROTIK' AND d.is_active
    FOR UPDATE OF n;
  IF NOT FOUND THEN RAISE EXCEPTION 'Camera router scope mismatch' USING ERRCODE='42501'; END IF;
  -- Re-enrollment may update metadata/transport, never move retained history.
  IF r.id IS NOT NULL AND (r.organization_id<>p_organization_id OR r.building_id<>p_building_id) THEN
    RAISE EXCEPTION 'Camera scope is immutable' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.camera_recorders(id,organization_id,building_id,display_name,vendor,model,channel_count,enabled)
    VALUES(p_recorder_id,p_organization_id,p_building_id,p_display_name,p_vendor,p_model,p_channel_count,p_enabled)
    ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,vendor=excluded.vendor,model=excluded.model,channel_count=excluded.channel_count,enabled=excluded.enabled;
  INSERT INTO app_private.camera_recorder_connections(recorder_id,router_connection_id,endpoint,credential_ref)
    VALUES(p_recorder_id,p_router_connection_id,p_endpoint,p_credential_ref)
    ON CONFLICT(recorder_id) DO UPDATE SET router_connection_id=excluded.router_connection_id,endpoint=excluded.endpoint,credential_ref=excluded.credential_ref;
  RETURN jsonb_build_object('recorderId',p_recorder_id,'buildingId',p_building_id,'enabled',p_enabled);
END;
$fn$;
REVOKE ALL ON FUNCTION public.network_center_admin_enroll_camera_v1(uuid,uuid,uuid,uuid,text,text,text,integer,text,text,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.network_center_admin_enroll_camera_v1(uuid,uuid,uuid,uuid,text,text,text,integer,text,text,boolean) TO service_role;

DO $policies$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['camera_recorders','camera_recorder_current','camera_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated',t);
    IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname=t||'_view') THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ((SELECT public.can_access_building(building_id)) AND (SELECT public.can_do_on_building(''network_center'',''view'',building_id)))',t||'_view',t);
    END IF;
    IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname=t||'_hide_sandbox_admin') THEN
      EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (NOT ((SELECT public.is_super_admin()) AND COALESCE(organization_id = ANY(public.sandbox_org_ids()),false)))',t||'_hide_sandbox_admin',t);
    END IF;
  END LOOP;
END;
$policies$;

CREATE OR REPLACE FUNCTION public.camera_building_snapshot_v1(p_building_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR p_building_id IS NULL
     OR NOT coalesce(public.can_access_building(p_building_id),false)
     OR NOT coalesce(public.can_do_on_building('network_center','view',p_building_id),false) THEN
    RAISE EXCEPTION 'Camera view permission required' USING ERRCODE='42501';
  END IF;
  RETURN jsonb_build_object('recorders',coalesce((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('snapshot',to_jsonb(c)) ORDER BY r.display_name,r.id)
    FROM public.camera_recorders r LEFT JOIN public.camera_recorder_current c ON c.recorder_id=r.id
    WHERE r.building_id=p_building_id),'[]'::jsonb));
END;
$fn$;

CREATE OR REPLACE FUNCTION public.camera_building_events_v1(p_building_id uuid,p_limit integer DEFAULT 100,p_before_observed_at timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path TO 'pg_catalog'
AS $fn$
DECLARE rows jsonb;
BEGIN
  IF auth.uid() IS NULL OR p_building_id IS NULL
     OR NOT coalesce(public.can_access_building(p_building_id),false)
     OR NOT coalesce(public.can_do_on_building('network_center','view',p_building_id),false) THEN
    RAISE EXCEPTION 'Camera view permission required' USING ERRCODE='42501';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR (p_before_observed_at IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'Invalid event cursor' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY observed_at DESC,id DESC),'[]'::jsonb) INTO rows FROM (
    SELECT * FROM public.camera_events WHERE building_id=p_building_id
      AND (p_before_id IS NULL OR (observed_at,id)<(p_before_observed_at,p_before_id))
    ORDER BY observed_at DESC,id DESC LIMIT p_limit+1
  ) e;
  RETURN jsonb_build_object('items',CASE WHEN jsonb_array_length(rows)>p_limit THEN rows-p_limit ELSE rows END,'hasMore',jsonb_array_length(rows)>p_limit);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_camera_connections_v1(p_credential_digest text,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $fn$
DECLARE worker_id uuid; items jsonb;
BEGIN
  SELECT a.worker_id INTO worker_id FROM app_private.network_center_authenticate_worker_v2(p_credential_digest) a;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid limit' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_agg(q.item ORDER BY q.id),'[]'::jsonb) INTO items FROM (
    SELECT r.id,jsonb_build_object('recorderId',r.id,'connectionId',n.id,'organizationId',r.organization_id,'buildingId',r.building_id,
      'displayName',r.display_name,'endpoint',c.endpoint,'credentialRef',c.credential_ref,'channelCount',r.channel_count,
      'pollIntervalSeconds',c.poll_interval_seconds,'connectTimeoutMs',c.connect_timeout_ms) item
    FROM public.camera_recorders r JOIN app_private.camera_recorder_connections c ON c.recorder_id=r.id
    JOIN public.network_device_connections n ON n.id=c.router_connection_id AND n.organization_id=r.organization_id AND n.building_id=r.building_id
    JOIN public.network_devices d ON d.id=n.device_id AND d.is_active AND d.device_kind='MIKROTIK'
    LEFT JOIN public.network_site_settings s ON s.organization_id=r.organization_id AND s.building_id=r.building_id
    WHERE r.enabled AND n.is_enabled AND coalesce(s.monitoring_enabled,true)
      AND app_private.network_center_worker_can_access_device_v2(worker_id,r.organization_id,r.building_id,n.device_id,'POLL')
    ORDER BY r.id LIMIT p_limit
  ) q;
  RETURN jsonb_build_object('items',items);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_camera_ingest_v1(p_credential_digest text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  worker_id uuid; r public.camera_recorders%ROWTYPE; c public.camera_recorder_current%ROWTYPE;
  n public.network_device_connections%ROWTYPE; conn app_private.camera_recorder_connections%ROWTYPE;
  observed timestamptz; received timestamptz:=clock_timestamp(); channels jsonb; storage jsonb; e jsonb; old jsonb;
  status text; coverage text; issues text[]; ordinal integer; state text; previous text;
BEGIN
  SELECT a.worker_id INTO worker_id FROM app_private.network_center_authenticate_worker_v2(p_credential_digest) a;
  IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>300000
     OR (p_payload - ARRAY['recorderId','connectionId','observedAt','status','channels','storage','eventCoverage','issues','events']) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid camera payload' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('camera:'||((p_payload->>'recorderId')::uuid)::text,0));
  SELECT * INTO r FROM public.camera_recorders WHERE id=(p_payload->>'recorderId')::uuid;
  SELECT * INTO conn FROM app_private.camera_recorder_connections WHERE recorder_id=r.id;
  SELECT * INTO n FROM public.network_device_connections WHERE id=conn.router_connection_id;
  IF r.id IS NULL OR NOT r.enabled OR n.id IS DISTINCT FROM (p_payload->>'connectionId')::uuid OR NOT n.is_enabled
     OR n.organization_id IS DISTINCT FROM r.organization_id OR n.building_id IS DISTINCT FROM r.building_id
     OR NOT EXISTS(SELECT FROM public.network_devices WHERE id=n.device_id AND is_active AND device_kind='MIKROTIK')
     OR EXISTS(SELECT FROM public.network_site_settings WHERE building_id=r.building_id AND NOT monitoring_enabled)
     OR NOT app_private.network_center_worker_can_access_device_v2(worker_id,r.organization_id,r.building_id,n.device_id,'TELEMETRY') THEN
    RAISE EXCEPTION 'Unauthorized camera target' USING ERRCODE='42501';
  END IF;
  -- Serialize snapshots and transitions for this recorder; assignment lock above
  -- makes a committed scope revoke win before this write.
  PERFORM 1 FROM public.camera_recorders WHERE id=r.id AND enabled FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Disabled camera target' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app_private.camera_recorder_connections WHERE recorder_id=r.id AND router_connection_id=n.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Camera connection changed' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.network_device_connections WHERE id=n.id AND is_enabled FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Disabled router connection' USING ERRCODE='42501'; END IF;
  observed:=(p_payload->>'observedAt')::timestamptz; status:=p_payload->>'status'; coverage:=p_payload->>'eventCoverage';
  channels:=p_payload->'channels'; storage:=p_payload->'storage';
  IF observed IS NULL OR NOT isfinite(observed) OR observed>received+interval '5 minutes' OR observed<received-interval '30 days'
     OR status IS NULL OR status NOT IN ('ONLINE','OFFLINE','UNKNOWN','AUTH_DENIED')
     OR coverage IS NULL OR coverage NOT IN ('STATE_POLLING_ONLY','EVENT_STREAM')
     OR jsonb_typeof(channels) IS DISTINCT FROM 'array' OR jsonb_typeof(storage) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_payload->'issues') IS DISTINCT FROM 'array' OR jsonb_typeof(p_payload->'events') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid camera snapshot' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(channels)>r.channel_count OR jsonb_array_length(storage)>32 OR jsonb_array_length(p_payload->'events')>200 OR jsonb_array_length(p_payload->'issues')>6 THEN
    RAISE EXCEPTION 'Camera array too large' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(array_agg(x),'{}'::text[]) INTO issues FROM jsonb_array_elements_text(p_payload->'issues') x;
  IF NOT issues <@ ARRAY['NETWORK_UNREACHABLE','AUTHENTICATION_FAILED','CHANNEL_STATUS_UNAVAILABLE','STORAGE_STATUS_UNAVAILABLE','EVENT_STREAM_UNAVAILABLE','DEVICE_RESPONSE_INVALID'] THEN
    RAISE EXCEPTION 'Invalid camera issue' USING ERRCODE='22023';
  END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(channels) LOOP
    IF jsonb_typeof(e)<>'object' OR (e-ARRAY['channel','name','state'])<>'{}'::jsonb OR (e->>'channel') IS NULL
      OR (e->>'channel')!~'^[0-9]+$' OR (e->>'channel')::integer NOT BETWEEN 1 AND r.channel_count
      OR e->>'state' IS NULL OR e->>'state' NOT IN ('CONNECTED','DISCONNECTED','EMPTY','UNKNOWN')
      OR (e ? 'name' AND (jsonb_typeof(e->'name')<>'string' OR length(e->>'name')>128)) THEN
      RAISE EXCEPTION 'Invalid camera channel' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'channel') FROM jsonb_array_elements(channels))<>jsonb_array_length(channels) THEN RAISE EXCEPTION 'Duplicate camera channel' USING ERRCODE='22023'; END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(storage) LOOP
    IF jsonb_typeof(e)<>'object' OR (e-ARRAY['slot','state','totalBytes','usedBytes'])<>'{}'::jsonb OR e->>'slot' IS NULL
      OR (e->>'slot')!~'^[0-9]+$' OR (e->>'slot')::integer NOT BETWEEN 1 AND 32
      OR e->>'state' IS NULL OR e->>'state' NOT IN ('NORMAL','ERROR','MISSING','UNKNOWN') THEN RAISE EXCEPTION 'Invalid camera storage' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT FROM jsonb_each(e) x WHERE x.key IN ('totalBytes','usedBytes') AND x.value<>'null'::jsonb AND
      (jsonb_typeof(x.value)<>'number' OR x.value::text !~ '^[0-9]+$' OR (x.value::text)::numeric>9007199254740991)) THEN RAISE EXCEPTION 'Invalid storage capacity' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'slot') FROM jsonb_array_elements(storage))<>jsonb_array_length(storage) THEN RAISE EXCEPTION 'Duplicate storage slot' USING ERRCODE='22023'; END IF;
  -- Missing channels on an unavailable recorder are UNKNOWN, never evidence of
  -- individual camera failures. Normalize a full channel set on every snapshot.
  SELECT jsonb_agg(coalesce(x.value,jsonb_build_object('channel',i,'state','UNKNOWN')) ORDER BY i) INTO channels
    FROM generate_series(1,r.channel_count) i LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(channels) WHERE (value->>'channel')::integer=i) x ON true;
  IF status<>'ONLINE' THEN SELECT jsonb_agg(value||jsonb_build_object('state','UNKNOWN')) INTO channels FROM jsonb_array_elements(channels); END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(p_payload->'events') LOOP
    IF jsonb_typeof(e)<>'object' OR (e-ARRAY['eventKey','code','action','channel','observedAt'])<>'{}'::jsonb
      OR e->>'eventKey' IS NULL OR (e->>'eventKey') !~ '^[A-Za-z0-9_.:-]{1,160}$'
      OR e->>'code' IS NULL OR e->>'code' NOT IN ('VideoLoss','VideoBlind','VideoMotion','AlarmLocal','StorageFailure','StorageNotExist','StorageLowSpace','NetAbort','CameraOffline','COVERAGE_GAP')
      OR e->>'action' IS NULL OR e->>'action' NOT IN ('Start','Stop','Pulse')
      OR (e->>'channel' IS NOT NULL AND ((e->>'channel') !~ '^[0-9]+$' OR (e->>'channel')::integer NOT BETWEEN 1 AND r.channel_count))
      OR e->>'observedAt' IS NULL OR NOT isfinite((e->>'observedAt')::timestamptz)
      OR (e->>'observedAt')::timestamptz>received+interval '5 minutes' OR (e->>'observedAt')::timestamptz<received-interval '30 days' THEN
      RAISE EXCEPTION 'Invalid camera event' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.camera_events(recorder_id,organization_id,building_id,event_key,kind,channel,state,code,action,observed_at)
      VALUES(r.id,r.organization_id,r.building_id,'device:'||(e->>'eventKey'),'DEVICE',(e->>'channel')::integer,e->>'action',e->>'code',e->>'action',(e->>'observedAt')::timestamptz)
      ON CONFLICT(recorder_id,event_key) DO NOTHING;
  END LOOP;
  SELECT * INTO c FROM public.camera_recorder_current WHERE recorder_id=r.id;
  IF c.checked_at IS NOT NULL AND observed<=c.checked_at THEN RETURN jsonb_build_object('accepted',true,'snapshotApplied',false,'reason','STALE_OR_DUPLICATE'); END IF;
  -- Missing/unreadable disks are not silently forgotten or called healthy.
  SELECT storage||coalesce(jsonb_agg(jsonb_build_object('slot',(prior_disk.value->>'slot')::integer,'state','UNKNOWN')),'[]'::jsonb) INTO storage
    FROM jsonb_array_elements(coalesce(c.storage,'[]'::jsonb)) prior_disk WHERE NOT EXISTS (SELECT FROM jsonb_array_elements(storage) current_disk WHERE current_disk.value->>'slot'=prior_disk.value->>'slot');
  IF status<>'ONLINE' THEN SELECT coalesce(jsonb_agg(value||jsonb_build_object('state','UNKNOWN')),'[]'::jsonb) INTO storage FROM jsonb_array_elements(storage); END IF;
  IF c.status IS DISTINCT FROM status THEN
    INSERT INTO public.camera_events(recorder_id,organization_id,building_id,event_key,kind,previous_state,state,observed_at)
      VALUES(r.id,r.organization_id,r.building_id,'snapshot:'||observed::text||':recorder','RECORDER',c.status,status,observed);
  END IF;
  IF c.event_coverage='EVENT_STREAM' AND coverage='STATE_POLLING_ONLY' THEN
    INSERT INTO public.camera_events(recorder_id,organization_id,building_id,event_key,kind,state,code,action,observed_at)
      VALUES(r.id,r.organization_id,r.building_id,'snapshot:'||observed::text||':coverage','DEVICE','Pulse','COVERAGE_GAP','Pulse',observed);
  END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(channels) LOOP
    ordinal:=(e->>'channel')::integer; state:=e->>'state';
    SELECT value->>'state' INTO previous FROM jsonb_array_elements(coalesce(c.channels,'[]'::jsonb)) WHERE (value->>'channel')::integer=ordinal;
    -- Initial channel baseline is the snapshot; only subsequent changes are events.
    IF previous IS NOT NULL AND previous IS DISTINCT FROM state THEN
      INSERT INTO public.camera_events(recorder_id,organization_id,building_id,event_key,kind,channel,previous_state,state,observed_at)
        VALUES(r.id,r.organization_id,r.building_id,'snapshot:'||observed::text||':channel:'||ordinal,'CHANNEL',ordinal,previous,state,observed);
    END IF;
  END LOOP;
  FOR e IN SELECT value FROM jsonb_array_elements(storage) LOOP
    ordinal:=(e->>'slot')::integer; state:=e->>'state';
    SELECT value->>'state' INTO previous FROM jsonb_array_elements(coalesce(c.storage,'[]'::jsonb)) WHERE (value->>'slot')::integer=ordinal;
    IF previous IS DISTINCT FROM state THEN
      INSERT INTO public.camera_events(recorder_id,organization_id,building_id,event_key,kind,slot,previous_state,state,observed_at)
        VALUES(r.id,r.organization_id,r.building_id,'snapshot:'||observed::text||':storage:'||ordinal,'STORAGE',ordinal,previous,state,observed);
    END IF;
  END LOOP;
  INSERT INTO public.camera_recorder_current(recorder_id,organization_id,building_id,status,checked_at,received_at,channels,storage,event_coverage,issues)
    VALUES(r.id,r.organization_id,r.building_id,status,observed,received,channels,storage,coverage,issues)
    ON CONFLICT(recorder_id) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,received_at=excluded.received_at,
      channels=excluded.channels,storage=excluded.storage,event_coverage=excluded.event_coverage,issues=excluded.issues;
  RETURN jsonb_build_object('accepted',true,'snapshotApplied',true);
END;
$fn$;

REVOKE ALL ON FUNCTION public.camera_building_snapshot_v1(uuid), public.camera_building_events_v1(uuid,integer,timestamptz,uuid),
  public.network_center_worker_camera_connections_v1(text,integer), public.network_center_worker_camera_ingest_v1(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.camera_building_snapshot_v1(uuid),public.camera_building_events_v1(uuid,integer,timestamptz,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.network_center_worker_camera_connections_v1(text,integer),public.network_center_worker_camera_ingest_v1(text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
