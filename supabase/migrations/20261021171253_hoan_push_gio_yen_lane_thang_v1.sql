-- Lane push gửi thẳng (pg_net → send-push) tôn trọng giờ yên — plan 2026-10-21-realtime-thong-bao-toi-uu.md, gói B
-- mục B13 (NOTIF-SERVER-11, NOTIF-SETTINGS-5).
--
-- VÌ SAO: bốn hàm bắn push NGAY trong giao dịch sinh thông báo, không hỏi giờ yên công ty/cá nhân: Hermes task
-- (hermes_task_follow_notify_v1), lịch Hermes (hermes_schedule_notify_v1/v2), canh gác Zalo (zalo_canh_gac_bao_v1).
-- Đặt "giờ yên 21→7" không chặn được push lúc nửa đêm của các lane này.
--
-- CÁCH SỬA (thay thế an toàn, không viết lại thân): trước lúc gọi net.http_post hỏi
-- app_private.notify_push_allowed_now_v1(người nhận, công ty) (20261021171249). Đang giờ yên ⇒ KHÔNG bắn, dòng chuông
-- vừa ghi đặt push_state='QUEUED' ⇒ drain chung v2 (pha 3 của edge lifecycle-reminders, 15') gửi khi hết giờ yên,
-- qua đúng các cổng của drain (chưa đọc, cài đặt, thiết bị, giờ yên, gộp theo người×công ty). Ngoài giờ yên: y như cũ.
-- Vá bằng pg_get_functiondef + thay ĐÚNG MỘT LẦN mỗi neo (neo lệch ⇒ RAISE, không đoán); thân prod 22/10 khớp byte
-- với file nguồn (md5: hermes_task_follow_notify_v1 5398850f… = 20261015110000; hermes_schedule_notify_v1 31f72b73… =
-- 20261015100000; hermes_schedule_notify_v2 63d78ecd… = 20261015185559; zalo_canh_gac_bao_v1 76a37393… =
-- 20261009171352). Dấu nhận biết đã vá: chuỗi notify_push_allowed_now_v1 trong thân ⇒ lượt hai bỏ qua.
-- Chữ ký, kiểu trả về, owner, search_path, ACL giữ nguyên (CREATE OR REPLACE từ chính định nghĩa đang chạy).
-- $requires$ (ghim thân, bài học 22/10): neo khớp chưa đủ — thân đang chạy phải là ĐÚNG thân production đã duyệt hoặc
-- thân đã vá của chính file. md5 tính sau khi bỏ CR VÀ chuẩn hoá URL dự án 'https://<ref>.supabase.co': bản đồng bộ
-- TEST viết lại ref trong thân bốn hàm này (đo 22/10: md5 thô TEST ≠ production, md5 chuẩn hoá bằng nhau), còn mọi
-- ký tự khác vẫn bị ghim.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $tien_quyet$
BEGIN
  IF to_regprocedure('app_private.notify_push_allowed_now_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'hoan_push_gio_yen: áp 20261021171249_notify_pipeline_v2 trước' USING ERRCODE = '55000';
  END IF;
END $tien_quyet$;

DO $requires$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.sig, x.cu, x.moi,
           (SELECT md5(regexp_replace(replace(p.prosrc, chr(13), ''), 'https://[a-z0-9]{20}\.supabase\.co',
                                      'https://<ref>.supabase.co', 'g'))
              FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig)) AS hien
      FROM (VALUES
        ('app_private.hermes_task_follow_notify_v1(uuid,uuid,text,jsonb,text,uuid)', 'cc71a8bd0203f787b63eedebb5327a94', '09a1ff2dc82bf2641bdb2358c7a7d71b'),
        ('app_private.hermes_schedule_notify_v1(uuid,text)', '705d6c0cfbe83d8ddc9dab250c5caeb8', 'e2680a72ac0a73bd7185f7f7641fccd8'),
        ('app_private.hermes_schedule_notify_v2(uuid[],text)', 'da889e3c2d105144826cc0616e7bee5c', '14ff85451f6095023bece08df3a01b0d'),
        ('app_private.zalo_canh_gac_bao_v1(uuid,text,text,text,text,text)', 'c9ca0f1c0b2d9c08c5fcffe2e50a3235', '6a3317b7668f7d9e18900c1131c1c09a')
      ) AS x(sig, cu, moi)
  LOOP
    IF r.hien IS NULL THEN
      RAISE EXCEPTION 'hoan_push_gio_yen: thiếu hàm % (production 22/10 có) — dừng', r.sig USING ERRCODE = '55000';
    END IF;
    IF r.hien NOT IN (r.cu, r.moi) THEN
      RAISE EXCEPTION 'hoan_push_gio_yen: thân % đã đổi so với bản đã duyệt (md5 chuẩn hoá %, chờ % hoặc %) — có PR khác thay hàm này, gộp rồi dựng lại migration',
        r.sig, r.hien, r.cu, r.moi USING ERRCODE = '55000';
    END IF;
  END LOOP;
END $requires$;

-- 1. Hermes task: dòng chuông đã có id (v_id) trước đoạn lấy JWT.
DO $va_hermes_task$
DECLARE
  v_sig regprocedure := to_regprocedure('app_private.hermes_task_follow_notify_v1(uuid,uuid,text,jsonb,text,uuid)');
  v_src text;
  v_old text;
  v_new text;
BEGIN
  IF v_sig IS NULL THEN
    RAISE NOTICE 'hoan_push_gio_yen: chưa có hermes_task_follow_notify_v1, bỏ qua';
    RETURN;
  END IF;
  v_src := pg_get_functiondef(v_sig);
  IF position('notify_push_allowed_now_v1' IN v_src) > 0 THEN RETURN; END IF;

  v_old := $o$  BEGIN v_jwt:=app_private.lifecycle_reminder_service_jwt_v1();$o$;
  v_new := $n$  IF NOT app_private.notify_push_allowed_now_v1(p_user,p_org) THEN
    -- Giờ yên (công ty hoặc cá nhân): không bắn thẳng; drain chung gửi khi hết giờ yên.
    UPDATE public.notifications SET push_state='QUEUED',push_attempts=0,push_leased_at=NULL,
      metadata=metadata||jsonb_build_object('pushDeferred','quiet_hours') WHERE id=v_id;
    RETURN v_id;
  END IF;
  BEGIN v_jwt:=app_private.lifecycle_reminder_service_jwt_v1();$n$;
  IF length(v_src) - length(replace(v_src, v_old, '')) <> length(v_old) THEN
    RAISE EXCEPTION 'hoan_push_gio_yen: neo lệch ở hermes_task_follow_notify_v1: %', v_old USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_src, v_old, v_new);
END $va_hermes_task$;

-- 2–4. Ba hàm INSERT không lấy id: thêm biến v_nid + RETURNING id INTO v_nid, rồi rẽ nhánh trước net.http_post.
DO $va_lane_thang$
DECLARE
  v_sigs text[] := ARRAY[
    'app_private.hermes_schedule_notify_v1(uuid,text)',
    'app_private.hermes_schedule_notify_v2(uuid[],text)',
    'app_private.zalo_canh_gac_bao_v1(uuid,text,text,text,text,text)'];
  v_olds text[];
  v_news text[];
  v_sig  text;
  v_src  text;
  i      integer;
BEGIN
  FOREACH v_sig IN ARRAY v_sigs LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE NOTICE 'hoan_push_gio_yen: chưa có %, bỏ qua', v_sig;
      CONTINUE;
    END IF;
    v_src := pg_get_functiondef(to_regprocedure(v_sig));
    IF position('notify_push_allowed_now_v1' IN v_src) > 0 THEN CONTINUE; END IF;

    IF v_sig LIKE 'app_private.hermes_schedule_notify_v1%' THEN
      v_olds := ARRAY[
        $o$  v_jwt text; v_error text; v_req bigint;$o$,
        $o$      jsonb_build_object('v5','hermes_schedule','incidentId',i.id,'scheduleId',i.schedule_id,'reason',i.reason,'phase',p_phase,'url','/settings/hermes'));$o$,
        $o$  IF v_jwt IS NOT NULL THEN$o$];
      v_news := ARRAY[
        $n$  v_jwt text; v_error text; v_req bigint; v_nid uuid;$n$,
        $n$      jsonb_build_object('v5','hermes_schedule','incidentId',i.id,'scheduleId',i.schedule_id,'reason',i.reason,'phase',p_phase,'url','/settings/hermes'))
    RETURNING id INTO v_nid;$n$,
        $n$  IF v_jwt IS NOT NULL AND NOT app_private.notify_push_allowed_now_v1(i.user_id,i.organization_id) THEN
    -- Giờ yên: không bắn thẳng; drain chung gửi khi hết giờ yên.
    UPDATE public.notifications SET push_state='QUEUED' WHERE id=v_nid;
  ELSIF v_jwt IS NOT NULL THEN$n$];
    ELSIF v_sig LIKE 'app_private.hermes_schedule_notify_v2%' THEN
      v_olds := ARRAY[
        $o$  v_lines text; v_title text; v_body text; v_hash text; v_jwt text; v_error text; v_req bigint;$o$,
        $o$        'reasons',(SELECT jsonb_agg(DISTINCT e.value->'reason') FROM jsonb_array_elements(v_rows) AS e(value))));$o$,
        $o$  IF v_jwt IS NOT NULL THEN$o$];
      v_news := ARRAY[
        $n$  v_lines text; v_title text; v_body text; v_hash text; v_jwt text; v_error text; v_req bigint; v_nid uuid;$n$,
        $n$        'reasons',(SELECT jsonb_agg(DISTINCT e.value->'reason') FROM jsonb_array_elements(v_rows) AS e(value))))
    RETURNING id INTO v_nid;$n$,
        $n$  IF v_jwt IS NOT NULL AND NOT app_private.notify_push_allowed_now_v1(v_user,v_org) THEN
    -- Giờ yên: không bắn thẳng; drain chung gửi khi hết giờ yên.
    UPDATE public.notifications SET push_state='QUEUED' WHERE id=v_nid;
  ELSIF v_jwt IS NOT NULL THEN$n$];
    ELSE
      v_olds := ARRAY[
        $o$  v_reqs    bigint[] := '{}';$o$,
        $o$            jsonb_build_object('v5', 'zalo_canh_gac', 'loai', p_loai, 'url', '/chat-zalo'));$o$,
        $o$    IF v_jwt IS NOT NULL THEN$o$];
      v_news := ARRAY[
        $n$  v_reqs    bigint[] := '{}';
  v_nid     uuid;$n$,
        $n$            jsonb_build_object('v5', 'zalo_canh_gac', 'loai', p_loai, 'url', '/chat-zalo'))
    RETURNING id INTO v_nid;$n$,
        $n$    IF v_jwt IS NOT NULL AND NOT app_private.notify_push_allowed_now_v1(v_uid, p_org) THEN
      -- Giờ yên: không bắn thẳng; drain chung gửi khi hết giờ yên.
      UPDATE public.notifications SET push_state = 'QUEUED' WHERE id = v_nid;
    ELSIF v_jwt IS NOT NULL THEN$n$];
    END IF;

    FOR i IN 1 .. array_length(v_olds, 1) LOOP
      IF length(v_src) - length(replace(v_src, v_olds[i], '')) <> length(v_olds[i]) THEN
        RAISE EXCEPTION 'hoan_push_gio_yen: neo % lệch ở %: %', i, v_sig, v_olds[i] USING ERRCODE = '55000';
      END IF;
      v_src := replace(v_src, v_olds[i], v_news[i]);
    END LOOP;
    EXECUTE v_src;
  END LOOP;
END $va_lane_thang$;

DO $nghiem_thu$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'app_private.hermes_task_follow_notify_v1(uuid,uuid,text,jsonb,text,uuid)',
    'app_private.hermes_schedule_notify_v1(uuid,text)',
    'app_private.hermes_schedule_notify_v2(uuid[],text)',
    'app_private.zalo_canh_gac_bao_v1(uuid,text,text,text,text,text)'] LOOP
    CONTINUE WHEN to_regprocedure(v_sig) IS NULL;
    IF position('notify_push_allowed_now_v1' IN pg_get_functiondef(to_regprocedure(v_sig))) = 0 THEN
      RAISE EXCEPTION 'nghiệm thu: % chưa hỏi giờ yên', v_sig USING ERRCODE = '55000';
    END IF;
    IF has_function_privilege('anon', v_sig, 'EXECUTE') OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'nghiệm thu: % lộ EXECUTE cho anon/authenticated', v_sig USING ERRCODE = '55000';
    END IF;
  END LOOP;
END $nghiem_thu$;

COMMIT;
