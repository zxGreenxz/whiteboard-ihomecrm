-- Công việc Mốc 6 (docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md mục 6, 23): nhắc việc qua Zalo — phần DB.
-- Hàng đợi (nhật ký gửi) + cấu hình theo công ty (TẮT) + hàm chọn việc cần nhắc + bộ sinh nhắc chạy cron 15 phút.
--  1. Chỉ nhắc NGƯỜI NHẬN việc (jobs.assignee_id) là thành viên ACTIVE của công ty VÀ có liên kết Zalo với nick bot Hermes còn hiệu lực
--     (app_private.hermes_zalo_bindings — đúng điều kiện mà provisioning của worker dùng). Không bao giờ nhắn khách / người ngoài công ty.
--  2. Hai loại, mỗi loại tối đa MỘT tin mỗi người mỗi ngày (UNIQUE ⇒ chạy lại không gửi trùng), gom mọi việc vào một tin:
--     due_today = việc đang mở hạn trong hôm nay (từ due_hour); overdue = quá hạn 1..overdue_days ngày (từ overdue_hour), rồi thôi.
--     ≤ daily_cap tin/người/ngày. Không sinh nhắc mới sau send_until_hour (không nhắn giữa ngày cho việc đã báo bằng E4).
--  3. Tôn trọng công tắc E4 (notify_gate_v1: tắt cả chuông lẫn push ⇒ không nhắc Zalo) và giờ yên: giờ yên công ty
--     (notification_org_config, mặc định 21→7) — hoặc công ty + cá nhân qua app_private.notify_in_quiet_hours_v1 nếu DB đã có helper đó
--     (production có từ đợt thông báo 21/10, chuỗi migration repo chưa có) — bằng not_before.
--  4. Nội dung chỉ có mã việc, tiêu đề (do người giao gõ), toà/phòng, hạn và link /tasks. Không SĐT, không trường khách.
--  5. Khoá để TẮT: không chèn dòng task_reminder_config nào ⇒ bộ sinh không làm gì. Phiên chính bật bằng migration riêng sau khi
--     worker có vòng claim/begin/settle (20261023063142) — SQL bật ở mục 23 tài liệu.
-- Chỉ thêm đối tượng mới; không thay thân hàm nào đã có (không ghim md5). Không khoá dòng công ty. Idempotent. Không DROP dữ liệu.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('public.jobs') IS NULL OR to_regclass('public.buildings') IS NULL OR to_regclass('public.rooms') IS NULL
    OR to_regclass('public.organizations') IS NULL OR to_regclass('public.organization_memberships') IS NULL
    OR to_regclass('app_private.hermes_zalo_bindings') IS NULL OR to_regclass('app_private.hermes_zalo_bots') IS NULL
    OR to_regclass('app_private.hermes_assistants') IS NULL OR to_regclass('app_private.notification_org_config') IS NULL
    OR to_regprocedure('app_private.notify_gate_v1(uuid,uuid,text,numeric)') IS NULL
    OR to_regprocedure('app_private.org_timezone_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'task_reminder_dependency_invalid'; END IF;
END $requires$;

CREATE TABLE IF NOT EXISTS app_private.task_reminder_config(
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  due_hour smallint NOT NULL DEFAULT 8 CHECK (due_hour BETWEEN 0 AND 22),
  overdue_hour smallint NOT NULL DEFAULT 8 CHECK (overdue_hour BETWEEN 0 AND 22),
  overdue_days smallint NOT NULL DEFAULT 3 CHECK (overdue_days BETWEEN 1 AND 14),
  daily_cap smallint NOT NULL DEFAULT 2 CHECK (daily_cap BETWEEN 1 AND 2),
  send_until_hour smallint NOT NULL DEFAULT 11 CHECK (send_until_hour BETWEEN 1 AND 23),
  app_base_url text CHECK (app_base_url IS NULL OR app_base_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (send_until_hour>due_hour AND send_until_hour>overdue_hour));

CREATE TABLE IF NOT EXISTS app_private.task_reminder_outbox(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  channel text NOT NULL DEFAULT 'zalo' CHECK (channel='zalo'),
  kind text NOT NULL CHECK (kind IN ('due_today','overdue')),
  reminder_date date NOT NULL,
  job_ids uuid[] NOT NULL CHECK (cardinality(job_ids) BETWEEN 1 AND 10),
  job_total integer NOT NULL CHECK (job_total>=cardinality(job_ids)),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','claimed','sending','sent','failed','skipped','unknown')),
  not_before timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  lease_until timestamptz,
  instance_id uuid,
  provider_started_at timestamptz,
  sent_at timestamptz,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,user_id,kind,reminder_date),
  CHECK ((state IN ('claimed','sending')) = (lease_until IS NOT NULL)),
  CHECK (state NOT IN ('claimed','sending') OR instance_id IS NOT NULL),
  CHECK (state NOT IN ('sending','sent','unknown') OR provider_started_at IS NOT NULL),
  CHECK ((state='sent') = (sent_at IS NOT NULL)));
CREATE INDEX IF NOT EXISTS task_reminder_outbox_ready ON app_private.task_reminder_outbox(not_before,created_at) WHERE state='queued';
CREATE INDEX IF NOT EXISTS task_reminder_outbox_leased ON app_private.task_reminder_outbox(lease_until) WHERE state IN ('claimed','sending');
ALTER TABLE app_private.task_reminder_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.task_reminder_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.task_reminder_config,app_private.task_reminder_outbox FROM PUBLIC,anon,authenticated,service_role;

-- Giờ yên tại p_at. Helper công ty + cá nhân của đợt thông báo khi DB có (gọi động theo tên chỉ khi tồn tại); không thì giờ yên công ty.
CREATE OR REPLACE FUNCTION app_private.task_reminder_quiet_v1(p_org uuid,p_user uuid,p_at timestamptz)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_hour integer; v_start integer; v_end integer;
BEGIN
  IF to_regprocedure('app_private.notify_in_quiet_hours_v1(uuid,uuid,timestamptz)') IS NOT NULL THEN
    RETURN COALESCE(app_private.notify_in_quiet_hours_v1(p_user,p_org,p_at),true);
  END IF;
  v_hour:=extract(hour FROM p_at AT TIME ZONE app_private.org_timezone_v1(p_org))::integer;
  SELECT c.quiet_start,c.quiet_end INTO v_start,v_end FROM app_private.notification_org_config c WHERE c.organization_id=p_org;
  IF NOT FOUND THEN v_start:=21; v_end:=7; END IF;
  RETURN CASE WHEN v_start IS NULL OR v_end IS NULL OR v_start=v_end THEN false
    WHEN v_start<v_end THEN v_hour>=v_start AND v_hour<v_end ELSE v_hour>=v_start OR v_hour<v_end END;
END $fn$;

-- Mốc được gửi sớm nhất từ p_at: chính p_at nếu ngoài giờ yên, không thì đầu giờ tròn đầu tiên hết giờ yên; NULL nếu yên cả 24 giờ.
CREATE OR REPLACE FUNCTION app_private.task_reminder_quiet_end_v1(p_org uuid,p_user uuid,p_at timestamptz)
RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_tz text:=app_private.org_timezone_v1(p_org); v_local timestamp; v_try timestamptz;
BEGIN
  IF NOT app_private.task_reminder_quiet_v1(p_org,p_user,p_at) THEN RETURN p_at; END IF;
  v_local:=date_trunc('hour',p_at AT TIME ZONE v_tz);
  FOR i IN 1..24 LOOP
    v_try:=(v_local+make_interval(hours=>i)) AT TIME ZONE v_tz;
    IF NOT app_private.task_reminder_quiet_v1(p_org,p_user,v_try) THEN RETURN v_try; END IF;
  END LOOP;
  RETURN NULL;
END $fn$;

-- Người nhận nhắc: thành viên ACTIVE (đọc thẳng organization_memberships — không dùng helper đòi JWT, cron không có) + liên kết Zalo còn
-- hiệu lực với nick bot của chính công ty (liên kết ACTIVE chưa thu hồi, nick bật đúng phiên bản, trợ lý ACTIVE).
CREATE OR REPLACE FUNCTION app_private.task_reminder_recipient_v1(p_org uuid,p_user uuid)
RETURNS TABLE(binding_id uuid,account_id uuid,peer_uid text) LANGUAGE sql STABLE SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT b.id,b.account_id,b.sender_uid
  FROM app_private.hermes_zalo_bindings b
  JOIN app_private.hermes_zalo_bots z ON z.account_id=b.account_id AND z.organization_id=b.organization_id AND z.enabled AND z.version=b.bot_version
  JOIN app_private.hermes_assistants a ON a.id=b.assistant_id AND a.organization_id=b.organization_id AND a.state='ACTIVE'
  WHERE p_org IS NOT NULL AND p_user IS NOT NULL AND b.organization_id=p_org AND b.user_id=p_user AND b.state='ACTIVE' AND b.revoked_at IS NULL
    AND EXISTS(SELECT 1 FROM public.organization_memberships m WHERE m.user_id=p_user AND m.organization_id=p_org AND m.status='ACTIVE'
      AND m.revoked_at IS NULL AND (m.valid_from IS NULL OR m.valid_from<=clock_timestamp()) AND (m.valid_to IS NULL OR m.valid_to>clock_timestamp()))
  ORDER BY b.activated_at DESC,b.id
  LIMIT 1
$fn$;

-- Hàm chọn việc cần nhắc cho một người nhận: việc đang mở (IN_PROGRESS; huỷ = xoá) giao cho p_user ở công ty p_org; due_today = hạn
-- (giờ công ty) đúng ngày p_date; overdue = hạn trong [p_date - p_overdue_days, p_date - 1]. Xếp theo hạn, mã.
CREATE OR REPLACE FUNCTION app_private.task_reminder_jobs_v1(p_org uuid,p_user uuid,p_kind text,p_date date,p_overdue_days integer)
RETURNS TABLE(job_id uuid,code text,title text,place text,deadline timestamptz,local_due date)
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app_private AS $fn$
  WITH tz AS (SELECT app_private.org_timezone_v1(p_org) z)
  SELECT j.id,j.code,j.title,NULLIF(concat_ws('/',b.name,r.name),''),j.deadline,(j.deadline AT TIME ZONE tz.z)::date
  FROM public.jobs j CROSS JOIN tz
  LEFT JOIN public.buildings b ON b.id=j.building_id
  LEFT JOIN public.rooms r ON r.id=j.room_id
  WHERE j.organization_id=p_org AND j.assignee_id=p_user AND j.status='IN_PROGRESS' AND j.deadline IS NOT NULL
    AND CASE p_kind
      WHEN 'due_today' THEN (j.deadline AT TIME ZONE tz.z)::date=p_date
      WHEN 'overdue' THEN (j.deadline AT TIME ZONE tz.z)::date BETWEEN p_date-GREATEST(p_overdue_days,1) AND p_date-1
      ELSE false END
  ORDER BY j.deadline,j.code,j.id
$fn$;

-- Nội dung một tin: ≤ 10 việc và ≤ 1000 ký tự (phần còn lại thành "… và N việc khác"). Không có việc ⇒ không trả dòng nào.
CREATE OR REPLACE FUNCTION app_private.task_reminder_body_v1(p_org uuid,p_user uuid,p_kind text,p_date date,p_overdue_days integer,p_base_url text)
RETURNS TABLE(job_ids uuid[],job_total integer,body text) LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE j record; v_tz text:=app_private.org_timezone_v1(p_org); v_lines text:=''; v_line text; v_ids uuid[]:='{}'; v_total integer:=0;
  v_full boolean:=false;
BEGIN
  FOR j IN SELECT * FROM app_private.task_reminder_jobs_v1(p_org,p_user,p_kind,p_date,p_overdue_days) LOOP
    v_total:=v_total+1;
    IF v_full OR cardinality(v_ids)>=10 THEN v_full:=true; CONTINUE; END IF;
    v_line:=E'\n• '||j.code||' · '||left(btrim(regexp_replace(j.title,'\s+',' ','g')),60)
      ||CASE WHEN j.place IS NOT NULL THEN ' · '||left(j.place,40) ELSE '' END
      ||CASE WHEN p_kind='due_today' THEN ' · hạn '||to_char(j.deadline AT TIME ZONE v_tz,'HH24:MI')
        ELSE ' · quá hạn '||(p_date-j.local_due)||' ngày (hạn '||to_char(j.local_due,'DD/MM')||')' END;
    IF char_length(v_lines)+char_length(v_line)>780 THEN v_full:=true; CONTINUE; END IF;
    v_lines:=v_lines||v_line; v_ids:=v_ids||j.job_id;
  END LOOP;
  IF v_total=0 OR cardinality(v_ids)=0 THEN RETURN; END IF;
  job_ids:=v_ids; job_total:=v_total;
  body:=CASE p_kind WHEN 'due_today' THEN 'Nhắc việc: '||v_total||' việc hạn hôm nay ('||to_char(p_date,'DD/MM')||'):'
      ELSE 'Nhắc việc: '||v_total||' việc đã quá hạn:' END
    ||v_lines
    ||CASE WHEN v_total>cardinality(v_ids) THEN E'\n… và '||(v_total-cardinality(v_ids))||' việc khác.' ELSE '' END
    ||CASE WHEN p_base_url IS NOT NULL THEN E'\nXem và cập nhật: '||p_base_url||'/tasks' ELSE E'\nXem và cập nhật ở mục Công việc trên web.' END;
  RETURN NEXT;
END $fn$;

-- Thu hồi lease quá hạn (worker chết giữa chừng): claimed ⇒ queued (chưa gọi Zalo); sending ⇒ unknown (có thể đã gửi: KHÔNG gửi lại).
CREATE OR REPLACE FUNCTION app_private.task_reminder_reap_v1(p_now timestamptz)
RETURNS integer LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_a integer; v_b integer;
BEGIN
  UPDATE app_private.task_reminder_outbox o SET state='queued',lease_until=NULL,updated_at=p_now
    WHERE o.id IN (SELECT x.id FROM app_private.task_reminder_outbox x WHERE x.state='claimed' AND x.lease_until<p_now FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS v_a=ROW_COUNT;
  UPDATE app_private.task_reminder_outbox o SET state='unknown',lease_until=NULL,error_code=COALESCE(o.error_code,'lease_expired_after_start'),
      updated_at=p_now
    WHERE o.id IN (SELECT x.id FROM app_private.task_reminder_outbox x WHERE x.state='sending' AND x.lease_until<p_now FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS v_b=ROW_COUNT;
  RETURN v_a+v_b;
END $fn$;

-- Bộ sinh nhắc (cron 15 phút). Mỗi công ty bật nhắc một khối con dưới khoá tư vấn thử (bận ⇒ bỏ lượt này); không khoá dòng công ty.
CREATE OR REPLACE FUNCTION app_private.task_reminder_enqueue_v1(p_now timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_now timestamptz:=COALESCE(p_now,clock_timestamp()); c app_private.task_reminder_config; u record; rcp record; b record; k text;
  v_tz text; v_local timestamp; v_date date; v_hour integer; v_count integer; v_not_before timestamptz; v_n integer;
  v_orgs integer:=0; v_queued integer:=0; v_quiet integer:=0; v_busy integer:=0; v_failed integer:=0; v_reaped integer; v_pruned integer;
BEGIN
  -- Lease và nhật ký theo giờ thật; p_now (thử nghiệm) chỉ định ngày / giờ nhắc.
  v_reaped:=app_private.task_reminder_reap_v1(clock_timestamp());
  DELETE FROM app_private.task_reminder_outbox o WHERE o.state IN ('sent','failed','skipped','unknown')
    AND o.created_at<clock_timestamp()-interval '30 days';
  GET DIAGNOSTICS v_pruned=ROW_COUNT;
  FOR c IN SELECT x.* FROM app_private.task_reminder_config x WHERE x.enabled ORDER BY x.organization_id LOOP
    BEGIN
      IF NOT pg_try_advisory_xact_lock(hashtextextended('task_reminder:'||c.organization_id::text,0)) THEN v_busy:=v_busy+1; CONTINUE; END IF;
      v_orgs:=v_orgs+1;
      v_tz:=app_private.org_timezone_v1(c.organization_id);
      v_local:=v_now AT TIME ZONE v_tz; v_date:=v_local::date; v_hour:=extract(hour FROM v_local)::integer;
      IF v_hour>=c.send_until_hour OR v_hour<LEAST(c.due_hour,c.overdue_hour) THEN CONTINUE; END IF;
      FOR u IN SELECT DISTINCT j.assignee_id AS user_id FROM public.jobs j
          WHERE j.organization_id=c.organization_id AND j.status='IN_PROGRESS' AND j.assignee_id IS NOT NULL AND j.deadline IS NOT NULL
            AND (j.deadline AT TIME ZONE v_tz)::date BETWEEN v_date-c.overdue_days AND v_date
          ORDER BY 1 LOOP
        SELECT x.* INTO rcp FROM app_private.task_reminder_recipient_v1(c.organization_id,u.user_id) x;
        IF NOT FOUND THEN CONTINUE; END IF;
        -- notify_gate_v1 trả (NULL, NULL) khi người dùng chưa có dòng sở thích; mọi nơi gọi coi NULL là bật (COALESCE true).
        IF NOT COALESCE((SELECT COALESCE(g.g_in_app,true) OR COALESCE(g.g_push,true)
            FROM app_private.notify_gate_v1(u.user_id,c.organization_id,'E4',NULL) g LIMIT 1),true) THEN
          CONTINUE; END IF;
        FOREACH k IN ARRAY ARRAY['due_today','overdue'] LOOP
          IF v_hour<(CASE k WHEN 'due_today' THEN c.due_hour ELSE c.overdue_hour END) THEN CONTINUE; END IF;
          SELECT count(*) INTO v_count FROM app_private.task_reminder_outbox o
            WHERE o.organization_id=c.organization_id AND o.user_id=u.user_id AND o.reminder_date=v_date;
          IF v_count>=c.daily_cap THEN EXIT; END IF;
          SELECT x.* INTO b FROM app_private.task_reminder_body_v1(c.organization_id,u.user_id,k,v_date,c.overdue_days,c.app_base_url) x;
          IF NOT FOUND THEN CONTINUE; END IF;
          v_not_before:=app_private.task_reminder_quiet_end_v1(c.organization_id,u.user_id,v_now);
          IF v_not_before IS NULL OR (v_not_before AT TIME ZONE v_tz)::date<>v_date
            OR extract(hour FROM v_not_before AT TIME ZONE v_tz)>=c.send_until_hour THEN
            v_quiet:=v_quiet+1; CONTINUE; END IF;
          INSERT INTO app_private.task_reminder_outbox(organization_id,user_id,binding_id,kind,reminder_date,job_ids,job_total,body,not_before)
            VALUES(c.organization_id,u.user_id,rcp.binding_id,k,v_date,b.job_ids,b.job_total,b.body,v_not_before)
            ON CONFLICT (organization_id,user_id,kind,reminder_date) DO NOTHING;
          GET DIAGNOSTICS v_n=ROW_COUNT;
          v_queued:=v_queued+v_n;
        END LOOP;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      v_failed:=v_failed+1;
      RAISE WARNING 'task_reminder_enqueue_v1: organization % failed (%)',c.organization_id,SQLSTATE;
    END;
  END LOOP;
  RETURN jsonb_build_object('organizations',v_orgs,'queued',v_queued,'quiet',v_quiet,'busy',v_busy,'failed',v_failed,
    'reaped',v_reaped,'pruned',v_pruned);
END $fn$;

ALTER FUNCTION app_private.task_reminder_enqueue_v1(timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.task_reminder_quiet_v1(uuid,uuid,timestamptz),app_private.task_reminder_quiet_end_v1(uuid,uuid,timestamptz),
  app_private.task_reminder_recipient_v1(uuid,uuid),app_private.task_reminder_jobs_v1(uuid,uuid,text,date,integer),
  app_private.task_reminder_body_v1(uuid,uuid,text,date,integer,text),app_private.task_reminder_reap_v1(timestamptz),
  app_private.task_reminder_enqueue_v1(timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- Lịch: pg_cron sẵn có (như hermes-task-follow-15m). DB diễn tập không có cron thì bỏ qua; cron.schedule theo tên là ghi đè.
DO $cronblock$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'Không có schema cron — bỏ qua đăng ký lịch nhắc việc Zalo.';
    RETURN;
  END IF;
  PERFORM cron.schedule('task-reminders-15m','*/15 * * * *','SELECT app_private.task_reminder_enqueue_v1();');
END
$cronblock$;

DO $check$
DECLARE f regprocedure;
BEGIN
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid='app_private.task_reminder_enqueue_v1(timestamptz)'::regprocedure) THEN
    RAISE EXCEPTION 'task_reminder_check_failed'; END IF;
  FOREACH f IN ARRAY ARRAY['app_private.task_reminder_quiet_v1(uuid,uuid,timestamptz)','app_private.task_reminder_quiet_end_v1(uuid,uuid,timestamptz)',
      'app_private.task_reminder_recipient_v1(uuid,uuid)','app_private.task_reminder_jobs_v1(uuid,uuid,text,date,integer)',
      'app_private.task_reminder_body_v1(uuid,uuid,text,date,integer,text)','app_private.task_reminder_reap_v1(timestamptz)',
      'app_private.task_reminder_enqueue_v1(timestamptz)']::regprocedure[] LOOP
    IF COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid=f),'') ~ '(^|[{,])(=|authenticated=|anon=|service_role=)' THEN
      RAISE EXCEPTION 'task_reminder_acl_open: %',f; END IF;
  END LOOP;
  IF has_table_privilege('authenticated','app_private.task_reminder_outbox','SELECT')
    OR has_table_privilege('service_role','app_private.task_reminder_outbox','SELECT') THEN
    RAISE EXCEPTION 'task_reminder_table_open'; END IF;
END $check$;
COMMIT;
