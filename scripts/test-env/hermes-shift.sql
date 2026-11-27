-- Install through test-env:thu-sql. This pilot has no production counterpart.
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM test_env.danh_dau WHERE ref ~ '^[a-z0-9]{20}$' AND ref <> 'tryymsxyyckgbrmmvozx')
    THEN RAISE EXCEPTION 'TEST marker required'; END IF;
END $guard$;

CREATE TABLE IF NOT EXISTS test_env.shift_settings (
  org_id uuid PRIMARY KEY, office text NOT NULL, metres jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS test_env.shift_people (
  org_id uuid NOT NULL REFERENCES test_env.shift_settings, staff uuid NOT NULL,
  home text NOT NULL, PRIMARY KEY(org_id,staff)
);
CREATE TABLE IF NOT EXISTS test_env.shift_buildings (
  org_id uuid NOT NULL, staff uuid NOT NULL, building uuid NOT NULL, road_key text NOT NULL,
  weekdays smallint[] NOT NULL, PRIMARY KEY(org_id,building),
  FOREIGN KEY (org_id,staff) REFERENCES test_env.shift_people
);
CREATE TABLE IF NOT EXISTS test_env.shift_run (
  org_id uuid PRIMARY KEY REFERENCES test_env.shift_settings, workday date NOT NULL,
  generation bigint NOT NULL DEFAULT 1, built bigint NOT NULL DEFAULT 0,
  lease_until timestamptz, token uuid, reason text NOT NULL, changed_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz, plans jsonb, model_state text, model_id text, attempts int NOT NULL DEFAULT 0
);
REVOKE ALL ON test_env.shift_settings,test_env.shift_people,test_env.shift_buildings,test_env.shift_run FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION test_env.shift_dirty(p_org uuid,p_reason text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  INSERT INTO test_env.shift_run AS r(org_id,workday,reason)
  SELECT org_id,public.vn_local_date(now()),p_reason FROM test_env.shift_settings WHERE org_id=p_org
  ON CONFLICT (org_id) DO UPDATE SET
    generation=r.generation+1,workday=EXCLUDED.workday,
    plans=CASE WHEN r.workday=EXCLUDED.workday THEN r.plans END,
    token=NULL,lease_until=NULL,attempts=0,reason=EXCLUDED.reason,changed_at=clock_timestamp();
$fn$;

CREATE OR REPLACE FUNCTION test_env.shift_on_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE o uuid; u uuid; b uuid; old_dirty uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    o:=OLD.organization_id; b:=OLD.building_id;
    IF TG_TABLE_NAME='jobs' THEN u:=OLD.assignee_id; ELSE u:=OLD.user_id; END IF;
    IF EXISTS(SELECT 1 FROM test_env.shift_people WHERE org_id=o AND staff=u)
       OR EXISTS(SELECT 1 FROM test_env.shift_buildings WHERE org_id=o AND building=b) THEN
      PERFORM test_env.shift_dirty(o,CASE WHEN TG_TABLE_NAME='jobs' THEN 'job' ELSE 'inspection' END);
      old_dirty:=o;
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    o:=NEW.organization_id; b:=NEW.building_id;
    IF TG_TABLE_NAME='jobs' THEN u:=NEW.assignee_id; ELSE u:=NEW.user_id; END IF;
    IF EXISTS(SELECT 1 FROM test_env.shift_people WHERE org_id=o AND staff=u)
       OR EXISTS(SELECT 1 FROM test_env.shift_buildings WHERE org_id=o AND building=b) THEN
      IF old_dirty IS DISTINCT FROM o THEN
        PERFORM test_env.shift_dirty(o,CASE WHEN TG_TABLE_NAME='jobs' THEN 'job' ELSE 'inspection' END);
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END $fn$;
CREATE OR REPLACE TRIGGER hermes_shift_job AFTER INSERT OR DELETE OR UPDATE OF assignee_id,building_id,title,priority,status,deadline,organization_id ON public.jobs FOR EACH ROW EXECUTE FUNCTION test_env.shift_on_change();
CREATE OR REPLACE TRIGGER hermes_shift_inspection AFTER INSERT OR DELETE OR UPDATE OF building_id,status,type,organization_id ON public.inspection_sessions FOR EACH ROW EXECUTE FUNCTION test_env.shift_on_change();

CREATE OR REPLACE FUNCTION test_env.shift_on_calendar_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE v_org uuid;
BEGIN
  FOR v_org IN SELECT org_id FROM test_env.shift_settings WHERE org_id IN (
    CASE WHEN TG_OP<>'DELETE' THEN NEW.organization_id END, CASE WHEN TG_OP<>'INSERT' THEN OLD.organization_id END
  ) LOOP
    PERFORM test_env.shift_dirty(v_org,'calendar');
  END LOOP;
  RETURN NULL;
END $fn$;
CREATE OR REPLACE TRIGGER hermes_shift_room AFTER INSERT OR DELETE OR UPDATE OF status,building_id,deleted_at ON public.rooms FOR EACH ROW EXECUTE FUNCTION test_env.shift_on_calendar_change();
CREATE OR REPLACE TRIGGER hermes_shift_leave AFTER INSERT OR DELETE OR UPDATE OF status,work_date ON public.salary_attendance_day FOR EACH ROW EXECUTE FUNCTION test_env.shift_on_calendar_change();
CREATE OR REPLACE TRIGGER hermes_shift_holiday AFTER INSERT OR DELETE OR UPDATE OF holiday_date ON public.salary_holidays FOR EACH ROW EXECUTE FUNCTION test_env.shift_on_calendar_change();

-- Cron dispatch is private. The service token goes only to the verified TEST project's own Edge function.
CREATE OR REPLACE FUNCTION test_env.shift_dispatch() RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE project_ref text; jwt text; target record; lease uuid;
BEGIN
  SELECT ref INTO STRICT project_ref FROM test_env.danh_dau;
  IF project_ref !~ '^[a-z0-9]{20}$' OR project_ref='tryymsxyyckgbrmmvozx' THEN RAISE EXCEPTION 'Invalid TEST marker'; END IF;
  FOR target IN SELECT s.org_id FROM test_env.shift_settings s LEFT JOIN test_env.shift_run r USING(org_id)
    WHERE r.workday IS DISTINCT FROM public.vn_local_date(now()) LOOP
    PERFORM test_env.shift_dirty(target.org_id,'shift');
  END LOOP;
  FOR target IN SELECT org_id,generation FROM test_env.shift_run
    WHERE built<generation AND COALESCE(lease_until,'-infinity')<now() FOR UPDATE SKIP LOCKED LOOP
    SELECT decrypted_secret INTO STRICT jwt FROM vault.decrypted_secrets WHERE name='test_lifecycle_service_jwt';
    lease:=gen_random_uuid();
    UPDATE test_env.shift_run SET lease_until=now()+interval '150 seconds',token=lease,attempts=attempts+1 WHERE org_id=target.org_id;
    PERFORM net.http_post(url:='https://'||project_ref||'.supabase.co/functions/v1/hermes-shift-test',
       headers:=jsonb_build_object('Authorization','Bearer '||jwt,'Content-Type','application/json'),
       body:=jsonb_build_object('org',target.org_id,'generation',target.generation,'token',lease),timeout_milliseconds:=135000);
  END LOOP;
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_shift_input_test_v1(p_org uuid,p_generation bigint,p_token uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  WITH live AS (
    SELECT * FROM test_env.shift_run WHERE org_id=p_org AND generation=p_generation AND token=p_token AND lease_until>now()
  )
  SELECT jsonb_build_object('date',r.workday,'at',r.changed_at,'reason',r.reason,'office',s.office,'metres',s.metres,
    'people',(SELECT jsonb_agg(jsonb_build_object('id',p.staff,'home',p.home,
      'off',EXISTS(SELECT 1 FROM public.salary_attendance_day d WHERE d.organization_id=p_org AND d.user_id=p.staff AND d.work_date=r.workday AND d.status='leave_approved')
           OR EXISTS(SELECT 1 FROM public.salary_holidays h WHERE h.organization_id=p_org AND h.holiday_date=r.workday),
      'anchor',(SELECT sb.road_key FROM public.inspection_sessions x JOIN test_env.shift_buildings sb ON sb.building=x.building_id AND sb.org_id=p_org
        WHERE x.organization_id=p_org AND x.user_id=p.staff AND x.session_date=r.workday AND x.status IN ('open','passed') ORDER BY COALESCE(x.ended_at,x.started_at) DESC LIMIT 1),
      'buildings',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',b.id,'label',b.name,'key',sb.road_key,'week',sb.weekdays,
        'own',sb.staff=p.staff,'vacancies',coalesce(c.vacant_rooms,0),'lastFull',c.last_full_date,
        'active',EXISTS(SELECT 1 FROM public.inspection_sessions x WHERE x.user_id=p.staff AND x.organization_id=p_org AND x.building_id=b.id AND x.type='FULL' AND x.session_date=r.workday AND x.status='open')
        ) ORDER BY sb.road_key),'[]'::jsonb) FROM test_env.shift_buildings sb JOIN public.buildings b ON b.id=sb.building AND b.organization_id=sb.org_id
        LEFT JOIN public.building_coverage c ON c.building_id=b.id WHERE sb.org_id=p_org AND b.deleted_at IS NULL AND b.status='ACTIVE'),
      'jobs',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',j.id,'building',j.building_id,'title',j.title,'priority',j.priority,'deadline',j.deadline)
        ORDER BY j.created_at,j.id),'[]'::jsonb) FROM public.jobs j WHERE j.organization_id=p_org AND j.assignee_id=p.staff AND j.status='IN_PROGRESS')
    ) ORDER BY p.staff) FROM test_env.shift_people p WHERE p.org_id=r.org_id))
  FROM live r JOIN test_env.shift_settings s USING(org_id);
$fn$;

CREATE OR REPLACE FUNCTION public.hermes_shift_publish_test_v1(p_org uuid,p_generation bigint,p_token uuid,p_plans jsonb,p_state text,p_model text,p_final boolean)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  UPDATE test_env.shift_run SET plans=p_plans,published_at=clock_timestamp(),model_state=p_state,model_id=p_model,
    built=CASE WHEN p_final AND (p_state IN ('checked','empty') OR attempts>=3) THEN p_generation ELSE built END,
    lease_until=CASE WHEN NOT p_final THEN lease_until WHEN p_state NOT IN ('checked','empty') AND attempts<3 THEN now()+interval '3 minutes'*attempts END,
    token=CASE WHEN NOT p_final THEN token END
  WHERE org_id=p_org AND generation=p_generation AND token=p_token AND lease_until>now() AND workday=public.vn_local_date(now());
  RETURN FOUND;
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_shift_read_test_v1(p_org uuid,p_staff uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE r test_env.shift_run; plan jsonb; allowed uuid[]; visible_stops jsonb; choices jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_org=ANY(public.my_org_ids()),false)
    OR NOT app_private.staff_day_can_view_v1(p_staff) OR NOT EXISTS(
       SELECT 1 FROM public.organization_memberships m WHERE m.organization_id=p_org AND m.user_id=p_staff AND m.status='ACTIVE')
    OR (p_staff<>auth.uid() AND p_org IS DISTINCT FROM app_private.v5_salary_org_of_user_v1(p_staff))
    THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM test_env.shift_people WHERE org_id=p_org AND staff=p_staff) THEN RETURN NULL; END IF;
  allowed:=ARRAY(SELECT public.accessible_building_ids());
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',b.id,'name',b.name) ORDER BY b.name),'[]'::jsonb)
    INTO choices FROM test_env.shift_buildings sb JOIN public.buildings b ON b.id=sb.building AND b.organization_id=sb.org_id
    WHERE sb.org_id=p_org AND sb.staff=p_staff AND b.id=ANY(allowed) AND b.deleted_at IS NULL;
  SELECT * INTO r FROM test_env.shift_run WHERE org_id=p_org AND workday=public.vn_local_date(now());
  plan:=r.plans->p_staff::text;
  SELECT coalesce(jsonb_agg((item-'taskIds') || jsonb_build_object('tasks',live.titles,'urgent',live.urgent,
    'active',(item->>'active')::boolean AND coalesce((item->>'building')::uuid=ANY(allowed),false),
    'daysLeft',CASE WHEN (item->>'building')::uuid=ANY(allowed) THEN item->'daysLeft' END,
    'full',(item->>'full')::boolean AND coalesce((item->>'building')::uuid=ANY(allowed),false)) ORDER BY ord),'[]'::jsonb) INTO visible_stops
    FROM jsonb_array_elements(plan->'stops') WITH ORDINALITY t(item,ord)
    CROSS JOIN LATERAL (SELECT coalesce(jsonb_agg(j.title ORDER BY k.pos),'[]'::jsonb) titles,
      coalesce(bool_or(j.priority='URGENT'),false) urgent
      FROM jsonb_array_elements_text(item->'taskIds') WITH ORDINALITY k(id,pos)
      JOIN public.jobs j ON j.id=k.id::uuid AND j.organization_id=p_org AND j.assignee_id=p_staff AND j.status='IN_PROGRESS'
        AND j.building_id IS NOT DISTINCT FROM (item->>'building')::uuid
      WHERE p_staff=auth.uid() OR j.building_id=ANY(allowed)) live
    WHERE ((item->>'full')::boolean AND (item->>'building')::uuid=ANY(allowed)) OR jsonb_array_length(live.titles)>0;
  RETURN jsonb_build_object('ready',plan IS NOT NULL,'updating',coalesce((plan->>'revision')::bigint,0)<coalesce(r.generation,1),'date',public.vn_local_date(now()),'revision',(plan->>'revision')::bigint,
    'updated',r.published_at,'reason',plan->>'reason','state',r.model_state,'model',r.model_id,'off',COALESCE((plan->>'off')::boolean,false),
    'stops',visible_stops,'buildings',choices);
END $fn$;
REVOKE ALL ON FUNCTION test_env.shift_dirty(uuid,text),test_env.shift_on_change(),test_env.shift_on_calendar_change(),test_env.shift_dispatch() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.hermes_shift_input_test_v1(uuid,bigint,uuid),public.hermes_shift_publish_test_v1(uuid,bigint,uuid,jsonb,text,text,boolean),public.hermes_shift_read_test_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.hermes_shift_input_test_v1(uuid,bigint,uuid),public.hermes_shift_publish_test_v1(uuid,bigint,uuid,jsonb,text,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.hermes_shift_read_test_v1(uuid,uuid) TO authenticated;
SELECT cron.schedule('hermes-shift-test','10 seconds','SELECT test_env.shift_dispatch()');
NOTIFY pgrst,'reload schema';
