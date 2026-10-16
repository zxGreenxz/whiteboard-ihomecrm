-- Gửi phòng trống một lần — sửa sau review độc lập be94dd2a (16/10/2026). Chạy SAU
-- 20261016101450_zalo_broadcast_oneshot_v1 và 20261016102533_zalo_worker_rooms_sale_page_parity_v1.
--  (P2.1) Dừng khẩn cấp chặn hết tin của lượt một lần: job đã xếp của lượt done/failed, job đang
--       processing lúc bấm dừng, hoặc job recover_jobs xếp lại sau khi worker chết đều KHÔNG được
--       nhận ở begin_provider khi đang dừng, hoặc khi job được tạo không muộn hơn lần dừng gần nhất
--       (kể cả sau khi đã gỡ dừng: tin cũ trước lần dừng không bao giờ đi). Worker kiểm lại bằng JS.
--  (P2.2) "Đang dừng khẩn cấp" = nhật ký 'stopped' mới nhất KHÔNG cũ hơn lần lưu/bật lại cấu hình
--       gần nhất của công ty, xét CẢ HAI dòng tự động hoá (broadcast_vacant, auto_reply). Lưu cấu hình
--       (zalo_luu_tu_dong_hoa) và bật/tắt (zalo_toggle_automation: ON CONFLICT ... updated_at=now())
--       đều tính là "mở lại"; trigger set_zalo_automations_updated_at cũng đóng dấu mọi UPDATE. Dừng
--       khẩn cấp ghi nhật ký và đóng dấu dòng đang bật trong cùng giao dịch (bằng nhau ⇒ vẫn dừng).
--  (P3a) Lượt "running" của CHÍNH instance này treo (chốt lượt lỗi mạng) được chiếm lại sau 10 phút;
--       khoá yêu cầu cũ ⇒ tin đã xếp được dùng lại, giới hạn 3 lần thử giữ nguyên.
--  (P3c) Kiểm sha thân hàm trước khi thay (begin_provider, claim) và kiểm thân
--       zalo_phong_trong_cho_worker_v1 đúng bản 20261016102533 (production trước đó đã đọc khớp bản
--       20261010022101, sha b1c5c0c7…, ngày 16/10/2026).
-- Không đổi chữ ký/kiểu trả về/ACL. Không ghi dữ liệu.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $attest$
DECLARE v_sha text;
BEGIN
  SELECT encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex') INTO v_sha
    FROM pg_proc WHERE oid=to_regprocedure('public.zalo_worker_begin_provider_v1(uuid,uuid)');
  IF v_sha IS NULL OR v_sha NOT IN ('c832f76d03cbb7860dc479117975ede658d831615d7e038d73cc11f6c99a01fa','0f46fcbaea8688b759bd041b842532e0b9107cda5892bdac7710f1f3ef624fba') THEN
    RAISE EXCEPTION 'unexpected public.zalo_worker_begin_provider_v1 source %',v_sha; END IF;
  SELECT encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex') INTO v_sha
    FROM pg_proc WHERE oid=to_regprocedure('public.zalo_worker_claim_oneshot_v1(uuid,uuid[])');
  IF v_sha IS NULL OR v_sha NOT IN ('7dced5f9dfa02785179a1137e61a45459e7d79c86ef2a3c152122cf1945f6c5d','26122d214bb41004980452e9506b15970db8940656fb0501e904b95701becc83') THEN
    RAISE EXCEPTION 'unexpected public.zalo_worker_claim_oneshot_v1 source %',v_sha; END IF;
  SELECT encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex') INTO v_sha
    FROM pg_proc WHERE oid=to_regprocedure('public.zalo_phong_trong_cho_worker_v1(uuid)');
  IF v_sha IS DISTINCT FROM 'f6bb5e544e6c7acbc28e6c4bd1bf126138523c4ca7d1a651cd38144ed05c55a8' THEN
    RAISE EXCEPTION 'unexpected public.zalo_phong_trong_cho_worker_v1 source %',v_sha; END IF;
END $attest$;

-- (P2.2)
CREATE OR REPLACE FUNCTION app_private.zalo_dang_dung_khan_cap_v1(p_org uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public' AS $fn$
DECLARE v_stop timestamptz; v_save timestamptz;
BEGIN
  SELECT max(r.created_at) INTO v_stop FROM public.zalo_automation_runs r
   WHERE r.organization_id=p_org AND r.kind='broadcast_vacant' AND r.mode='stopped';
  IF v_stop IS NULL THEN RETURN false; END IF;
  SELECT max(a.updated_at) INTO v_save FROM public.zalo_automations a WHERE a.organization_id=p_org;
  RETURN v_save IS NULL OR v_stop>=v_save;
END $fn$;

-- (P2.1) Tin của lượt một lần bị chặn khi đang dừng, hoặc khi job sinh ra không muộn hơn lần dừng gần nhất.
CREATE OR REPLACE FUNCTION app_private.zalo_oneshot_job_bi_dung_v1(p_org uuid,p_job_created_at timestamptz)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public' AS $fn$
BEGIN
  RETURN app_private.zalo_dang_dung_khan_cap_v1(p_org)
    OR p_job_created_at IS NULL
    OR EXISTS(SELECT 1 FROM public.zalo_automation_runs r WHERE r.organization_id=p_org AND r.kind='broadcast_vacant'
                AND r.mode='stopped' AND r.created_at>=p_job_created_at);
END $fn$;
REVOKE ALL ON FUNCTION app_private.zalo_dang_dung_khan_cap_v1(uuid),app_private.zalo_oneshot_job_bi_dung_v1(uuid,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role;

-- Thân 20261016101450; nhánh oneshot thêm app_private.zalo_oneshot_job_bi_dung_v1.
CREATE OR REPLACE FUNCTION public.zalo_worker_begin_provider_v1(p_job_id uuid,p_instance_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE q public.zalo_send_queue; c public.zalo_conversations; a public.zalo_automations; o public.zalo_automation_oneshots;
  v_kind text; v_now timestamptz:=clock_timestamp(); v_day timestamptz; v_cap int; v_count int; v_org uuid; v_oneshot uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM app_private.hermes_group_jobs WHERE job_id=p_job_id) THEN RETURN false; END IF;
  PERFORM 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id AND heartbeat_at>v_now-interval '30 seconds' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT organization_id INTO v_org FROM public.zalo_send_queue WHERE id=p_job_id;
  IF v_org IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||v_org::text,0));
  SELECT * INTO q FROM public.zalo_send_queue WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR q.status<>'processing' OR q.processing_instance_id IS DISTINCT FROM p_instance_id THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.zalo_accounts x WHERE x.id=q.account_id AND x.organization_id=q.organization_id AND x.status='connected') THEN RETURN false; END IF;
  IF q.payload ? 'tu_dong' THEN
    v_kind:=CASE WHEN q.payload->>'auto_reply'='true' THEN 'auto_reply' ELSE 'broadcast_vacant' END;
    SELECT * INTO a FROM public.zalo_automations WHERE organization_id=q.organization_id AND kind=v_kind FOR SHARE;
    SELECT * INTO c FROM public.zalo_conversations WHERE id=q.conversation_id;
    IF c.id IS NULL OR c.account_id IS DISTINCT FROM q.account_id OR c.organization_id IS DISTINCT FROM q.organization_id THEN RETURN false; END IF;
    IF v_kind='broadcast_vacant' AND q.payload ? 'oneshot_id' THEN
      -- Lượt một lần tự là căn cứ gửi: không cần công tắc lịch hay config.recipients; nhưng dừng
      -- khẩn cấp chặn mọi tin của nó (kể cả lượt đã done, job processing/được xếp lại).
      BEGIN v_oneshot:=(q.payload->>'oneshot_id')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN RETURN false; END;
      SELECT * INTO o FROM public.zalo_automation_oneshots WHERE id=v_oneshot;
      IF o.id IS NULL OR o.organization_id IS DISTINCT FROM q.organization_id OR o.status NOT IN ('running','done','failed')
        OR NOT (c.id=ANY(o.recipients)) OR c.thread_type IS DISTINCT FROM 'group' OR NOT c.is_sale_partner
        OR app_private.zalo_oneshot_job_bi_dung_v1(q.organization_id,q.created_at) THEN RETURN false; END IF;
    ELSIF a.id IS NULL OR NOT a.enabled OR (v_kind='auto_reply' AND NOT c.is_sale_partner) THEN RETURN false;
    ELSIF v_kind='broadcast_vacant' AND NOT COALESCE(a.config->'recipients' ? c.id::text,false) THEN RETURN false;
    END IF;
    v_day:=date_trunc('day',v_now AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh';
    IF v_kind='broadcast_vacant' AND (q.created_at<v_day OR q.created_at>=v_day+interval '1 day') THEN RETURN false; END IF;
    IF v_kind='broadcast_vacant' AND NOT app_private.zalo_in_allowed_hours_v1(v_now,a.config) THEN RETURN false; END IF;
    v_cap:=CASE WHEN v_kind='auto_reply' THEN app_private.zalo_config_int_v1(a.config->'dailyCap',50,1000)
      ELSE app_private.zalo_config_int_v1(a.config#>'{antiSpam,dailyCap}',120,2000) END;
    IF q.provider_started_at IS NULL THEN
      SELECT count(*) INTO v_count FROM public.zalo_send_queue x WHERE x.organization_id=q.organization_id AND x.payload ? 'tu_dong'
        AND CASE WHEN v_kind='auto_reply' THEN COALESCE(x.payload->>'auto_reply'='true',false) ELSE NOT COALESCE(x.payload->>'auto_reply'='true',false) END
        AND x.provider_started_at>=v_day AND x.provider_started_at<v_day+interval '1 day';
      IF v_count>=v_cap THEN RETURN false; END IF;
    END IF;
  END IF;
  UPDATE public.zalo_send_queue SET provider_started_at=COALESCE(provider_started_at,v_now) WHERE id=q.id;
  RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION public.zalo_worker_begin_provider_v1(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_worker_begin_provider_v1(uuid,uuid) TO service_role;

-- Thân 20261016101450; (P3a) lượt running của chính instance được chiếm lại sau 10 phút.
CREATE OR REPLACE FUNCTION public.zalo_worker_claim_oneshot_v1(p_instance_id uuid,p_organization_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'pg_catalog','public' AS $fn$
DECLARE v_now timestamptz:=clock_timestamp(); v_id uuid; v_org uuid; r public.zalo_automation_oneshots;
  a public.zalo_automations; v_cap integer; v_try integer:=0; v_code text; v_reason text;
BEGIN
  PERFORM 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id
    AND heartbeat_at>v_now-interval '30 seconds' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','lease_lost'); END IF;
  LOOP
    v_try:=v_try+1;
    IF v_try>5 THEN RETURN jsonb_build_object('status','none'); END IF;
    v_id:=NULL;
    -- "running" của instance khác = instance đã mất lease (lease là singleton); "running" của chính
    -- instance này quá 10 phút = lần chốt trước lỗi (tick chạy tuần tự nên không còn ai đang làm).
    -- Chạy lại với CÙNG khoá yêu cầu ⇒ tin đã xếp được dùng lại, không gửi trùng.
    SELECT o.id,o.organization_id INTO v_id,v_org FROM public.zalo_automation_oneshots o
     WHERE o.run_at<=v_now AND (o.status='queued' OR (o.status='running'
         AND (o.claimed_by_instance IS DISTINCT FROM p_instance_id OR o.updated_at<v_now-interval '10 minutes')))
       AND (p_organization_ids IS NULL OR cardinality(p_organization_ids)=0 OR o.organization_id=ANY(p_organization_ids))
     ORDER BY o.run_at,o.id LIMIT 1;
    IF v_id IS NULL THEN RETURN jsonb_build_object('status','none'); END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||v_org::text,0));
    SELECT * INTO r FROM public.zalo_automation_oneshots WHERE id=v_id FOR UPDATE;
    EXIT WHEN r.status='queued' OR (r.status='running'
      AND (r.claimed_by_instance IS DISTINCT FROM p_instance_id OR r.updated_at<v_now-interval '10 minutes'));
  END LOOP;

  IF (r.run_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date<>(v_now AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
     OR v_now-r.run_at>interval '180 minutes' THEN
    v_code:='qua_han'; v_reason:='Worker không chạy kịp trong ngày và trong 180 phút sau giờ hẹn; không gửi bù.';
  ELSIF r.attempts>=3 THEN
    v_code:='qua_so_lan_thu'; v_reason:='Đã thử chạy lượt này 3 lần mà chưa chốt được; dừng để không gửi lặp.';
  END IF;
  IF v_code IS NOT NULL THEN
    UPDATE public.zalo_automation_oneshots SET status='failed',finished_at=v_now,updated_at=v_now,
      result=result||jsonb_build_object('code',v_code,'reason',v_reason) WHERE id=r.id RETURNING * INTO r;
    RETURN jsonb_build_object('status','expired','code',v_code,'reason',v_reason,'oneshot',app_private.zalo_oneshot_json_v1(r));
  END IF;

  UPDATE public.zalo_automation_oneshots SET status='running',attempts=attempts+1,claimed_by_instance=p_instance_id,
    started_at=COALESCE(started_at,v_now),updated_at=v_now WHERE id=r.id RETURNING * INTO r;
  SELECT * INTO a FROM public.zalo_automations WHERE organization_id=r.organization_id AND kind='broadcast_vacant';
  v_cap:=app_private.zalo_config_int_v1(a.config#>'{antiSpam,dailyCap}',120,2000);
  RETURN jsonb_build_object('status','claimed','oneshot',app_private.zalo_oneshot_json_v1(r),
    'config',COALESCE(a.config,'{}'::jsonb),'con_lai',greatest(0,v_cap-app_private.zalo_oneshot_tin_hom_nay_v1(r.organization_id,v_now)));
END $fn$;
REVOKE ALL ON FUNCTION public.zalo_worker_claim_oneshot_v1(uuid,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_worker_claim_oneshot_v1(uuid,uuid[]) TO service_role;

DO $assert$
DECLARE f text;
BEGIN
  IF position('zalo_oneshot_job_bi_dung_v1' IN pg_get_functiondef('public.zalo_worker_begin_provider_v1(uuid,uuid)'::regprocedure))=0
    OR position('hermes_group_jobs' IN pg_get_functiondef('public.zalo_worker_begin_provider_v1(uuid,uuid)'::regprocedure))=0
    OR position($q$interval '10 minutes'$q$ IN pg_get_functiondef('public.zalo_worker_claim_oneshot_v1(uuid,uuid[])'::regprocedure))=0
    OR position('max(a.updated_at)' IN pg_get_functiondef('app_private.zalo_dang_dung_khan_cap_v1(uuid)'::regprocedure))=0
    THEN RAISE EXCEPTION 'zalo oneshot review fixes source'; END IF;
  FOREACH f IN ARRAY ARRAY['public.zalo_worker_begin_provider_v1(uuid,uuid)','public.zalo_worker_claim_oneshot_v1(uuid,uuid[])'] LOOP
    IF NOT has_function_privilege('service_role',f,'EXECUTE') OR has_function_privilege('anon',f,'EXECUTE')
      OR has_function_privilege('authenticated',f,'EXECUTE') THEN RAISE EXCEPTION 'zalo oneshot worker ACL %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['app_private.zalo_dang_dung_khan_cap_v1(uuid)','app_private.zalo_oneshot_job_bi_dung_v1(uuid,timestamptz)'] LOOP
    IF has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('anon',f,'EXECUTE')
      OR has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'zalo oneshot helper ACL %',f; END IF;
  END LOOP;
END
$assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
