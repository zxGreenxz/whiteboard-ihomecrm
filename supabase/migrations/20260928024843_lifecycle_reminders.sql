-- P5 lifecycle only. No business-state or financial writes, no scheduler installation here.
-- Inbox uses public.notifications; push lease/dedup is private to this family so
-- the legacy generic push drain cannot send before lifecycle authorization checks.
ALTER TABLE public.notification_preferences DROP CONSTRAINT IF EXISTS notification_preferences_event_key_ck;
ALTER TABLE public.notification_preferences ADD CONSTRAINT notification_preferences_event_key_ck
  CHECK(event_key IN ('E1','E2','E3','E4','E5','E6','LIFECYCLE'));
DO $patch$
DECLARE sig text; src text; changed text;
BEGIN
  FOREACH sig IN ARRAY ARRAY['app_private.notification_events_normalize_v1(jsonb)','app_private.notification_prefs_normalize_v1(jsonb)'] LOOP
    src:=pg_get_functiondef(sig::regprocedure);
    IF position('''LIFECYCLE''' IN src)>0 THEN CONTINUE; END IF;
    changed:=replace(src,'array[''E1'',''E2'',''E3'',''E4'',''E5'',''E6'']','array[''E1'',''E2'',''E3'',''E4'',''E5'',''E6'',''LIFECYCLE'']');
    changed:=replace(changed,'Chỉ nhận E1, E2, E3, E4, E5, E6.','Chỉ nhận E1, E2, E3, E4, E5, E6, LIFECYCLE.');
    IF changed=src THEN RAISE EXCEPTION 'Lifecycle preference seam changed: %',sig; END IF;
    EXECUTE changed;
  END LOOP;
  src:=pg_get_functiondef('app_private.notification_prefs_read_v1(uuid,uuid)'::regprocedure);
  IF position('''LIFECYCLE''' IN src)=0 THEN
    changed:=replace(src,'(''E6''))','(''E6''),(''LIFECYCLE''))');
    IF changed=src THEN RAISE EXCEPTION 'Lifecycle preference reader seam changed'; END IF;
    EXECUTE changed;
  END IF;
END $patch$;

CREATE TABLE IF NOT EXISTS app_private.lifecycle_reminder_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  reminder_day date NOT NULL,
  source_family text NOT NULL CHECK(source_family IN ('NOTICE','TURNOVER','EXIT')),
  notification_id uuid REFERENCES public.notifications(id) ON DELETE SET NULL,
  inbox_recorded_at timestamptz,
  push_status text NOT NULL CHECK(push_status IN ('PENDING','SENDING','SENT','NO_DEVICE','DISABLED','SKIPPED','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  lease uuid, leased_at timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  idempotency_key text, last_error text, delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(organization_id,user_id,reminder_day,source_family)
);
CREATE INDEX IF NOT EXISTS lifecycle_reminder_push_idx ON app_private.lifecycle_reminder_deliveries(next_attempt_at,id)
  WHERE push_status IN ('PENDING','SENDING');
CREATE TABLE IF NOT EXISTS app_private.lifecycle_reminder_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid,
  finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  inserted integer NOT NULL DEFAULT 0,
  no_recipient_families jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL CHECK(status IN ('OK','NO_RECIPIENT','FAILED')),
  error_message text
);
CREATE INDEX IF NOT EXISTS lifecycle_reminder_runs_recent_idx ON app_private.lifecycle_reminder_runs(finished_at DESC);
ALTER TABLE app_private.lifecycle_reminder_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.lifecycle_reminder_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.lifecycle_reminder_deliveries,app_private.lifecycle_reminder_runs FROM PUBLIC,anon,authenticated,service_role;

-- A read projection matching the three existing list queues. No work item is
-- resolved by notification read/attempt/delivery. Phase/revision stay in sources.
CREATE OR REPLACE FUNCTION app_private.lifecycle_reminder_sources_v1(p_org uuid)
RETURNS TABLE(source_family text,source_id uuid,building_id uuid,revision text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT 'NOTICE',c.id,b.id,c.updated_at::text FROM public.contracts c
    JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=c.organization_id
    WHERE c.organization_id=p_org AND c.status='ACTIVE' AND c.actual_end_date IS NULL AND c.deleted_at IS NULL
      AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND c.expected_move_out_date<=public.org_today_v1(p_org)
  UNION ALL
  SELECT 'TURNOVER',t.id,b.id,t.epoch::text||':'||t.version::text FROM public.room_turnovers t
    JOIN public.rooms r ON r.id=t.room_id AND r.organization_id=t.organization_id
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=t.organization_id
    WHERE t.organization_id=p_org AND t.status='PENDING' AND r.deleted_at IS NULL AND b.deleted_at IS NULL
      AND (t.expected_ready_on IS NULL OR t.expected_ready_on<=public.org_today_v1(p_org))
  UNION ALL
  SELECT 'EXIT',e.id,e.building_id,e.version::text FROM public.contract_exit_cases e
    WHERE e.organization_id=p_org AND e.state='PENDING';
$fn$;

-- Caller takes lock_org_for_decision_v1 in a previous statement. Use the real
-- actor-aware resolver, never set JWT claims or use staff display IDs as users.
CREATE OR REPLACE FUNCTION app_private.lifecycle_recipient_allowed_v1(p_user uuid,p_org uuid,p_building uuid,p_family text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT EXISTS(SELECT 1 FROM public.organization_memberships m JOIN public.organizations o ON o.id=m.organization_id
    WHERE m.user_id=p_user AND m.organization_id=p_org AND m.status='ACTIVE' AND o.status='ACTIVE'
      AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=clock_timestamp() AND (m.valid_to IS NULL OR m.valid_to>clock_timestamp()))
    AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=p_building AND b.organization_id=p_org
      AND NOT (EXISTS(SELECT 1 FROM public.super_admins sa WHERE sa.user_id=p_user)
        AND (COALESCE(p_org=ANY(public.sandbox_org_ids()),false) OR COALESCE(b.user_id=ANY(public.demo_user_ids()),false))))
    AND COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(p_user,p_org,'buildings.view',p_building,NULL)),false)
    AND COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(p_user,p_org,
      CASE WHEN p_family='TURNOVER' THEN 'rooms.view' ELSE 'contracts.view' END,p_building,NULL)),false);
$fn$;

CREATE OR REPLACE FUNCTION app_private.lifecycle_reminder_payload_v1(p_user uuid,p_org uuid,p_family text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE n integer; ids jsonb; title text; route text;
BEGIN
  SELECT count(*),COALESCE(jsonb_agg(jsonb_build_object('id',s.source_id,'revision',s.revision) ORDER BY s.source_id),'[]') INTO n,ids
    FROM app_private.lifecycle_reminder_sources_v1(p_org) s
    WHERE s.source_family=p_family AND app_private.lifecycle_recipient_allowed_v1(p_user,p_org,s.building_id,s.source_family);
  IF n=0 THEN RETURN NULL; END IF;
  title:=CASE p_family WHEN 'NOTICE' THEN 'Báo trả phòng đã đến hẹn' WHEN 'TURNOVER' THEN 'Phòng cần dọn/sửa' ELSE 'Hồ sơ trả phòng chờ hoàn tất' END;
  route:=CASE WHEN p_family='TURNOVER' THEN '/rooms' ELSE '/contracts' END;
  RETURN jsonb_build_object('title',title,'body',n::text||' việc cần kiểm tra trong danh sách.','count',n,'sources',ids,'url',route);
END $fn$;

CREATE OR REPLACE FUNCTION app_private.lifecycle_gate_v1(p_user uuid,p_org uuid)
RETURNS TABLE(in_app boolean,push boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  -- Same org/personal gate semantics as notify_gate_v1, including DIGEST/OFF.
  -- Read directly so configuration errors abort this lifecycle sweep rather than
  -- the legacy trigger's fail-open catch hiding a broken background run.
  SELECT COALESCE((c.events->'LIFECYCLE'->>'enabled')::boolean,true) AND COALESCE(p.in_app,true) AND COALESCE(p.cadence,'IMMEDIATE')<>'OFF',
    COALESCE((c.events->'LIFECYCLE'->>'enabled')::boolean,true) AND COALESCE(p.push,true) AND COALESCE(p.cadence,'IMMEDIATE')='IMMEDIATE'
  FROM (SELECT 1) seed LEFT JOIN app_private.notification_org_config c ON c.organization_id=p_org
    LEFT JOIN public.notification_preferences p ON p.organization_id=p_org AND p.user_id=p_user AND p.event_key='LIFECYCLE';
$fn$;

CREATE OR REPLACE FUNCTION public.lifecycle_reminder_sweep_v1(p_organization_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_org record; u record; family text; payload jsonb; gate record; delivery uuid; notif uuid; today date;
  inserted integer:=0; org_inserted integer; missing jsonb; recipient_count integer; local_now timestamp;
  existing_delivery record; has_sources boolean;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('lifecycle_reminder_sweep_v1')::bigint) THEN RETURN jsonb_build_object('inserted',0,'busy',true); END IF;
  FOR v_org IN SELECT id FROM public.organizations WHERE status='ACTIVE' AND (p_organization_id IS NULL OR id=p_organization_id) ORDER BY id LOOP
    local_now:=clock_timestamp() AT TIME ZONE app_private.org_timezone_v1(v_org.id);
    IF extract(hour FROM local_now)<8 THEN CONTINUE; END IF;
    PERFORM app_private.lock_org_for_decision_v1(v_org.id);
    today:=public.org_today_v1(v_org.id); org_inserted:=0; missing:='[]';
    FOREACH family IN ARRAY ARRAY['NOTICE','TURNOVER','EXIT'] LOOP
      has_sources:=EXISTS(SELECT 1 FROM app_private.lifecycle_reminder_sources_v1(v_org.id) s WHERE s.source_family=family);
      recipient_count:=0;
      FOR u IN SELECT DISTINCT user_id FROM public.organization_memberships WHERE organization_id=v_org.id AND status='ACTIVE' ORDER BY user_id LOOP
        payload:=app_private.lifecycle_reminder_payload_v1(u.user_id,v_org.id,family);
        IF payload IS NULL THEN
          -- Existing daily inbox follows the current source even when all work
          -- resolves or the recipient loses its building scope. Never erase the
          -- user's read flag or manufacture another push delivery.
          UPDATE public.notifications n SET content='Không còn việc cần kiểm tra trong danh sách.',
            metadata=COALESCE(n.metadata,'{}')||jsonb_build_object('count',0,'sources','[]'::jsonb)
            FROM app_private.lifecycle_reminder_deliveries d
            WHERE d.organization_id=v_org.id AND d.user_id=u.user_id AND d.reminder_day=today
              AND d.source_family=family AND n.id=d.notification_id;
          CONTINUE;
        END IF;
        recipient_count:=recipient_count+1;
        SELECT * INTO gate FROM app_private.lifecycle_gate_v1(u.user_id,v_org.id);
        INSERT INTO app_private.lifecycle_reminder_deliveries(organization_id,user_id,reminder_day,source_family,push_status,last_error)
          VALUES(v_org.id,u.user_id,today,family,CASE WHEN gate.push THEN 'PENDING' ELSE 'DISABLED' END,
            CASE WHEN gate.push THEN NULL ELSE 'Organization/personal push preference disabled or cadence DIGEST/OFF' END)
          ON CONFLICT(organization_id,user_id,reminder_day,source_family) DO NOTHING RETURNING id INTO delivery;
        IF delivery IS NULL THEN
          SELECT id,notification_id INTO existing_delivery FROM app_private.lifecycle_reminder_deliveries
            WHERE organization_id=v_org.id AND user_id=u.user_id AND reminder_day=today AND source_family=family FOR UPDATE;
          IF gate.in_app AND existing_delivery.notification_id IS NOT NULL THEN
            UPDATE public.notifications SET organization_id=v_org.id,type='ACTION_REQUIRED',channel='IN_APP',
              subject=payload->>'title',content=payload->>'body',
              metadata=COALESCE(metadata,'{}')||jsonb_build_object('event','LIFECYCLE','source_family',family,'day',today,
                'url',payload->>'url','count',payload->'count','sources',payload->'sources','delivery_id',existing_delivery.id)
              WHERE id=existing_delivery.notification_id;
          END IF;
          CONTINUE;
        END IF;
        IF gate.in_app THEN
          INSERT INTO public.notifications(user_id,organization_id,type,channel,subject,content,metadata,status,push_state)
            VALUES(u.user_id,v_org.id,'ACTION_REQUIRED','IN_APP',payload->>'title',payload->>'body',
              jsonb_build_object('event','LIFECYCLE','source_family',family,'day',today,'url',payload->>'url','count',payload->'count','sources',payload->'sources','delivery_id',delivery),'PENDING',NULL)
            RETURNING id INTO notif;
          UPDATE app_private.lifecycle_reminder_deliveries SET notification_id=notif,inbox_recorded_at=clock_timestamp() WHERE id=delivery;
        END IF;
        org_inserted:=org_inserted+1;
      END LOOP;
      IF has_sources AND recipient_count=0 THEN missing:=missing||jsonb_build_array(family); END IF;
    END LOOP;
    INSERT INTO app_private.lifecycle_reminder_runs(organization_id,inserted,no_recipient_families,status)
      VALUES(v_org.id,org_inserted,missing,CASE WHEN missing='[]'::jsonb THEN 'OK' ELSE 'NO_RECIPIENT' END);
    inserted:=inserted+org_inserted;
  END LOOP;
  RETURN jsonb_build_object('inserted',inserted);
END $fn$;

CREATE OR REPLACE FUNCTION public.lifecycle_reminder_validate_v1(p_id uuid,p_lease uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE d app_private.lifecycle_reminder_deliveries%rowtype; payload jsonb; gate record;
BEGIN
  SELECT * INTO d FROM app_private.lifecycle_reminder_deliveries WHERE id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown lifecycle delivery' USING ERRCODE='22023'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(d.organization_id);
  SELECT * INTO d FROM app_private.lifecycle_reminder_deliveries WHERE id=p_id FOR UPDATE;
  IF d.push_status<>'SENDING' OR d.lease IS DISTINCT FROM p_lease THEN RAISE EXCEPTION 'Stale lifecycle delivery lease' USING ERRCODE='PT409'; END IF;
  payload:=app_private.lifecycle_reminder_payload_v1(d.user_id,d.organization_id,d.source_family);
  SELECT * INTO gate FROM app_private.lifecycle_gate_v1(d.user_id,d.organization_id);
  IF payload IS NULL OR NOT gate.push OR d.reminder_day<>public.org_today_v1(d.organization_id) THEN
    UPDATE app_private.lifecycle_reminder_deliveries SET push_status=CASE WHEN NOT gate.push THEN 'DISABLED' ELSE 'SKIPPED' END,
      last_error='Source resolved, read scope changed, day expired, or push disabled',lease=NULL,leased_at=NULL WHERE id=p_id;
    RETURN NULL;
  END IF;
  RETURN payload||jsonb_build_object('id',d.id,'lease',d.lease,'user_id',d.user_id,'organization_id',d.organization_id,
    'notification_ids',CASE WHEN d.notification_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(d.notification_id) END,'idempotency_key',d.idempotency_key);
END $fn$;

CREATE OR REPLACE FUNCTION public.lifecycle_reminder_claim_v1(p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE d record; payload jsonb; gate record; quiet record; hour integer; v_lease uuid; out jsonb:='[]'; receipt record;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION 'Invalid lifecycle batch size' USING ERRCODE='22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('lifecycle_reminder_claim_v1')::bigint) THEN RETURN out; END IF;
  FOR d IN SELECT * FROM app_private.lifecycle_reminder_deliveries
    WHERE (push_status='PENDING' AND next_attempt_at<=clock_timestamp()) OR (push_status='SENDING' AND leased_at<clock_timestamp()-interval '10 minutes')
    ORDER BY organization_id,created_at,id LIMIT p_limit LOOP
    PERFORM app_private.lock_org_for_decision_v1(d.organization_id);
    SELECT * INTO d FROM app_private.lifecycle_reminder_deliveries WHERE id=d.id FOR UPDATE;
    SELECT outcome,sent INTO receipt FROM public.push_send_log WHERE idempotency_key=d.idempotency_key;
    IF receipt.sent>0 AND receipt.outcome IN ('SENT','PARTIAL') THEN
      UPDATE app_private.lifecycle_reminder_deliveries SET push_status='SENT',delivered_at=clock_timestamp(),lease=NULL,leased_at=NULL WHERE id=d.id;
      CONTINUE;
    END IF;
    payload:=app_private.lifecycle_reminder_payload_v1(d.user_id,d.organization_id,d.source_family);
    SELECT * INTO gate FROM app_private.lifecycle_gate_v1(d.user_id,d.organization_id);
    IF payload IS NULL OR d.reminder_day<>public.org_today_v1(d.organization_id) OR NOT gate.push THEN
      UPDATE app_private.lifecycle_reminder_deliveries SET push_status=CASE WHEN NOT gate.push THEN 'DISABLED' ELSE 'SKIPPED' END,
        last_error='Source resolved, read scope changed, day expired, or push disabled',lease=NULL,leased_at=NULL WHERE id=d.id;
      CONTINUE;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.push_subscriptions WHERE user_id=d.user_id AND is_active) THEN
      UPDATE app_private.lifecycle_reminder_deliveries SET push_status='NO_DEVICE',last_error='No active push device',lease=NULL,leased_at=NULL WHERE id=d.id;
      CONTINUE;
    END IF;
    IF d.attempts>=3 THEN
      UPDATE app_private.lifecycle_reminder_deliveries SET push_status='FAILED',last_error=COALESCE(last_error,'Push lease expired after 3 attempts'),lease=NULL,leased_at=NULL WHERE id=d.id;
      CONTINUE;
    END IF;
    hour:=extract(hour FROM (clock_timestamp() AT TIME ZONE app_private.org_timezone_v1(d.organization_id)));
    SELECT COALESCE(c.quiet_start,21) start_hour,COALESCE(c.quiet_end,7) end_hour INTO quiet
      FROM (SELECT 1) seed LEFT JOIN app_private.notification_org_config c ON c.organization_id=d.organization_id;
    IF (CASE WHEN quiet.start_hour=quiet.end_hour THEN false WHEN quiet.start_hour<quiet.end_hour THEN hour>=quiet.start_hour AND hour<quiet.end_hour ELSE hour>=quiet.start_hour OR hour<quiet.end_hour END) THEN CONTINUE; END IF;
    v_lease:=gen_random_uuid();
    UPDATE app_private.lifecycle_reminder_deliveries SET push_status='SENDING',attempts=attempts+1,lease=v_lease,leased_at=clock_timestamp(),
      idempotency_key='lifecycle:'||id::text||':'||(attempts+1)::text WHERE id=d.id;
    payload:=public.lifecycle_reminder_validate_v1(d.id,v_lease);
    IF payload IS NOT NULL THEN out:=out||jsonb_build_array(payload); END IF;
  END LOOP;
  RETURN out;
END $fn$;

CREATE OR REPLACE FUNCTION public.lifecycle_reminder_settle_v1(p_id uuid,p_lease uuid,p_outcome text,p_sent integer DEFAULT 0,p_error text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE d app_private.lifecycle_reminder_deliveries%rowtype; state text; receipt record;
BEGIN
  SELECT * INTO d FROM app_private.lifecycle_reminder_deliveries WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR d.push_status<>'SENDING' OR d.lease IS DISTINCT FROM p_lease THEN RAISE EXCEPTION 'Stale lifecycle delivery lease' USING ERRCODE='PT409'; END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('SENT','PARTIAL','DUPLICATE','NO_DEVICE','CONFIG_ERROR','ALL_FAILED','PROVIDER_ERROR','BAD_REQUEST','UNAUTHORIZED') OR p_sent IS NULL OR p_sent<0 THEN
    RAISE EXCEPTION 'Invalid lifecycle push outcome' USING ERRCODE='22023'; END IF;
  SELECT outcome,sent INTO receipt FROM public.push_send_log WHERE idempotency_key=d.idempotency_key;
  state:=CASE WHEN receipt.sent>0 AND receipt.outcome IN ('SENT','PARTIAL') THEN 'SENT'
    WHEN p_outcome IN ('SENT','PARTIAL') AND p_sent>0 THEN 'SENT'
    WHEN p_outcome='NO_DEVICE' THEN 'NO_DEVICE'
    WHEN p_outcome='CONFIG_ERROR' THEN 'DISABLED'
    WHEN p_outcome IN ('BAD_REQUEST','UNAUTHORIZED') OR d.attempts>=3 THEN 'FAILED'
    ELSE 'PENDING' END;
  UPDATE app_private.lifecycle_reminder_deliveries SET push_status=state,lease=NULL,leased_at=NULL,
    delivered_at=CASE WHEN state='SENT' THEN clock_timestamp() ELSE delivered_at END,
    next_attempt_at=clock_timestamp()+interval '5 minutes',last_error=CASE WHEN state='SENT' THEN NULL ELSE left(COALESCE(p_error,p_outcome),2000) END WHERE id=p_id;
END $fn$;

CREATE OR REPLACE FUNCTION public.lifecycle_reminder_record_failure_v1(p_error text)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  INSERT INTO app_private.lifecycle_reminder_runs(status,error_message) VALUES('FAILED',left(p_error,2000));
$fn$;
CREATE OR REPLACE FUNCTION public.lifecycle_reminder_health_v1()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT jsonb_build_object('server_now',clock_timestamp(),
    'latest_run',(SELECT to_jsonb(r) FROM app_private.lifecycle_reminder_runs r ORDER BY finished_at DESC,id DESC LIMIT 1),
    'last_success_at',(SELECT max(finished_at) FROM app_private.lifecycle_reminder_runs WHERE status IN ('OK','NO_RECIPIENT')),
    'push_states',COALESCE((SELECT jsonb_object_agg(push_status,n) FROM (SELECT push_status,count(*) n FROM app_private.lifecycle_reminder_deliveries GROUP BY push_status) q),'{}'),
    'oldest_pending_at',(SELECT min(created_at) FROM app_private.lifecycle_reminder_deliveries WHERE push_status IN ('PENDING','SENDING')));
$fn$;
REVOKE ALL ON FUNCTION app_private.notification_events_normalize_v1(jsonb),app_private.notification_prefs_normalize_v1(jsonb),app_private.notification_prefs_read_v1(uuid,uuid),
  app_private.lifecycle_reminder_sources_v1(uuid),app_private.lifecycle_recipient_allowed_v1(uuid,uuid,uuid,text),app_private.lifecycle_reminder_payload_v1(uuid,uuid,text),app_private.lifecycle_gate_v1(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.lifecycle_reminder_sweep_v1(uuid),public.lifecycle_reminder_claim_v1(integer),public.lifecycle_reminder_validate_v1(uuid,uuid),
  public.lifecycle_reminder_settle_v1(uuid,uuid,text,integer,text),public.lifecycle_reminder_record_failure_v1(text),public.lifecycle_reminder_health_v1() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.lifecycle_reminder_sweep_v1(uuid),public.lifecycle_reminder_claim_v1(integer),public.lifecycle_reminder_validate_v1(uuid,uuid),
  public.lifecycle_reminder_settle_v1(uuid,uuid,text,integer,text),public.lifecycle_reminder_record_failure_v1(text),public.lifecycle_reminder_health_v1() TO service_role;
NOTIFY pgrst,'reload schema';
