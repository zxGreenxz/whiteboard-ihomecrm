-- =============================================================================
-- Chat Zalo — CANH GÁC WORKER: web đọc được nhịp tim, chủ công ty được báo khi
-- Zalo mất kết nối.
--
-- VÌ SAO (đo production 09/10/2026). Worker Zalo dừng lúc 07:56 UTC ngày 05/09 và
-- suốt hơn một tháng không ai biết. Web chỉ đọc `zalo_accounts.status`; worker
-- chết đột ngột thì cột đó vẫn là 'connected' nên chấm vẫn xanh. Nhịp tim thật
-- nằm ở `zalo_worker_lease.heartbeat_at` (worker ghi mỗi tick 2 giây), nhưng bảng
-- đó chỉ service_role đọc được (20260813110000).
--
-- Migration thêm:
--   1. public.zalo_worker_status_v1() — người có quyền xem Chat Zalo đọc nhịp tim.
--      Chỉ trả thời điểm và số giây, không lộ hostname/instance của máy chạy.
--   2. app_private.zalo_canh_gac_su_co + app_private.zalo_canh_gac_tick_v1():
--      mở/đóng sự cố, báo CHỦ CÔNG TY đúng một lần khi mở và một lần khi hết:
--        • worker_im_lang — worker im lặng 10 phút trong khi còn tài khoản cá nhân
--          cần nó (status khác 'disconnected'); hết khi nhịp tim mới hơn 2 phút.
--          Worker dừng êm (deploy, reboot) nhả lease bằng heartbeat_at = 1970
--          (lib/lease.js): khi đó không biết giờ dừng thật nên tính 10 phút từ
--          lượt canh gác đầu tiên thấy nó im — restart nhanh thì đóng im lặng.
--        • tai_khoan_loi — worker sống mà một tài khoản đứng ở 'error' 20 phút,
--          tính từ lượt canh gác đầu tiên thấy nó lỗi. 20 phút vì worker còn tự
--          thử lại khoảng 14 phút (lib/login.js) và ghi lại 'error' mỗi lần thử,
--          nên updated_at không dùng được. Chỉ đóng khi tài khoản 'connected' hoặc
--          'disconnected': 'connecting'/'waiting_scan' là đang thử, giữ đồng hồ.
--      Trạng thái tài khoản chỉ đáng tin khi worker sống, nên phần tài khoản chỉ
--      chạy lúc đó.
--   3. Lịch pg_cron 5 phút/lần, chỉ đăng ký khi nền tảng có pg_cron (DB diễn tập
--      của restore-drill không có). Chạy trong database nên VPS chết vẫn báo được.
--
-- ĐƯỜNG BÁO. Một dòng notifications IN_APP (chuông trong app; push_state để NULL
-- nên drain push hằng ngày không gửi lại) + gọi send-push NGAY qua pg_net, JWT
-- service lấy từ Vault, cùng khe bộ nhắc hợp đồng đang dùng
-- (app_private.lifecycle_reminder_service_jwt_v1). Drain push chỉ chạy 07:00 mỗi
-- ngày, quá trễ cho cảnh báo sự cố. Hàm lấy JWT từ chối trên database TEST đã
-- đánh dấu ⇒ trên TEST chỉ ghi chuông, không bắn push production. Lỗi lấy JWT
-- và request_id của pg_net được ghi lại trong sổ sự cố để soát được.
--
-- Idempotent. Không đổi bảng/hàm có sẵn.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Nhịp tim worker cho web
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_worker_status_v1()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_nhip timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.zalo_authorized_org_ids('view')) THEN
    RAISE EXCEPTION 'Bạn không có quyền xem Chat Zalo' USING ERRCODE = '42501';
  END IF;

  SELECT l.heartbeat_at INTO v_nhip FROM public.zalo_worker_lease l WHERE l.id = 'singleton';

  -- Worker dừng êm thì nhả lease bằng heartbeat_at = 1970 (lib/lease.js): vẫn là offline.
  RETURN pg_catalog.jsonb_build_object(
    'heartbeat_at', v_nhip,
    'seconds_since', CASE WHEN v_nhip IS NULL THEN NULL
                          ELSE pg_catalog.floor(EXTRACT(epoch FROM (pg_catalog.now() - v_nhip)))::bigint END,
    'online', v_nhip IS NOT NULL AND v_nhip > pg_catalog.now() - interval '2 minutes'
  );
END $$;

REVOKE ALL ON FUNCTION public.zalo_worker_status_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.zalo_worker_status_v1() TO authenticated;

COMMENT ON FUNCTION public.zalo_worker_status_v1() IS
  'Nhịp tim worker Zalo cho người có quyền chat_zalo.view: heartbeat_at, seconds_since, online (nhịp tim mới hơn 2 phút). Không trả hostname/instance.';

-- ---------------------------------------------------------------------------
-- 2. Sổ sự cố canh gác
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_private.zalo_canh_gac_su_co (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loai             text NOT NULL CHECK (loai IN ('worker_im_lang', 'tai_khoan_loi')),
  account_id       uuid REFERENCES public.zalo_accounts(id) ON DELETE CASCADE,
  bat_dau_at       timestamptz NOT NULL,
  da_bao_at        timestamptz,
  dong_at          timestamptz,
  so_nguoi_bao     integer NOT NULL DEFAULT 0,
  push_request_ids bigint[] NOT NULL DEFAULT '{}',
  loi_push         text,
  CONSTRAINT zalo_canh_gac_su_co_tai_khoan_chk CHECK ((loai = 'tai_khoan_loi') = (account_id IS NOT NULL))
);

-- Mỗi loại (và mỗi tài khoản) chỉ một sự cố đang mở: lượt cron sau không mở trùng.
CREATE UNIQUE INDEX IF NOT EXISTS zalo_canh_gac_su_co_dang_mo_uq
  ON app_private.zalo_canh_gac_su_co (loai, COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE dong_at IS NULL;

ALTER TABLE app_private.zalo_canh_gac_su_co ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.zalo_canh_gac_su_co FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE app_private.zalo_canh_gac_su_co IS
  'Sự cố canh gác worker Zalo: worker_im_lang và tai_khoan_loi. da_bao_at = đã báo chủ công ty; dong_at = đã hết; push_request_ids = id hàng đợi pg_net (đối chiếu net._http_response); loi_push = vì sao không gọi được send-push.';

-- ---------------------------------------------------------------------------
-- 3. Gửi một cảnh báo cho chủ công ty của một tổ chức
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.zalo_canh_gac_bao_v1(
  p_org uuid, p_tieu_de text, p_noi_dung text, p_khoa text, p_loai text, p_tag text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $$
DECLARE
  v_jwt     text;
  v_loi_jwt text;
  v_uid     uuid;
  v_nguoi   integer := 0;
  v_req     bigint;
  v_reqs    bigint[] := '{}';
BEGIN
  -- TEST đã đánh dấu, hoặc khe Vault bị đổi/xoá ⇒ hàm lấy JWT ném lỗi. Vẫn ghi chuông,
  -- và trả lý do để sổ sự cố ghi lại, không nuốt im lặng.
  BEGIN
    v_jwt := app_private.lifecycle_reminder_service_jwt_v1();
  EXCEPTION WHEN OTHERS THEN
    v_jwt := NULL;
    v_loi_jwt := left(SQLSTATE || ': ' || SQLERRM, 300);
  END;

  FOR v_uid IN
    SELECT DISTINCT m.user_id
      FROM public.organization_memberships m
     WHERE m.organization_id = p_org
       AND m.status = 'ACTIVE'
       AND app_private.ie_actor_is_company_owner_v1(p_org, m.user_id)
  LOOP
    INSERT INTO public.notifications (organization_id, user_id, type, channel, status, subject, content, metadata)
    VALUES (p_org, v_uid, 'CUSTOM', 'IN_APP', 'PENDING', p_tieu_de, p_noi_dung,
            jsonb_build_object('v5', 'zalo_canh_gac', 'loai', p_loai, 'url', '/chat-zalo'));

    IF v_jwt IS NOT NULL THEN
      -- pg_net xếp yêu cầu, gửi sau khi giao dịch commit; khoá idempotency chặn gửi lặp.
      v_req := net.http_post(
        url := 'https://tryymsxyyckgbrmmvozx.supabase.co/functions/v1/send-push',
        body := jsonb_build_object(
          'userId', v_uid, 'title', p_tieu_de, 'body', p_noi_dung,
          'url', '/chat-zalo', 'tag', p_tag,
          'idempotencyKey', left(p_khoa || ':' || v_uid::text, 128)),
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_jwt, 'Content-Type', 'application/json'),
        timeout_milliseconds := 30000);
      v_reqs := v_reqs || v_req;
    END IF;
    v_nguoi := v_nguoi + 1;
  END LOOP;

  RETURN jsonb_build_object('so_nguoi', v_nguoi, 'request_ids', to_jsonb(v_reqs), 'loi_jwt', v_loi_jwt);
END $$;

REVOKE ALL ON FUNCTION app_private.zalo_canh_gac_bao_v1(uuid, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Một lượt canh gác
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.zalo_canh_gac_tick_v1()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $$
DECLARE
  v_nhip  timestamptz;
  v_song  boolean;
  v_im    boolean;
  v_sc    app_private.zalo_canh_gac_su_co%ROWTYPE;
  v_org   uuid;
  v_ten   text;
  v_loi   text;
  v_kq    jsonb;
  v_nguoi integer;
  v_reqs  bigint[];
  v_loi_push text;
  v_mo    integer := 0;
  v_dong  integer := 0;
BEGIN
  -- Lượt cron trước còn chạy thì lượt này bỏ qua.
  IF NOT pg_try_advisory_xact_lock(hashtext('app_private.zalo_canh_gac_tick_v1')) THEN
    RETURN jsonb_build_object('bo_qua', 'luot_khac_dang_chay');
  END IF;

  SELECT l.heartbeat_at INTO v_nhip FROM public.zalo_worker_lease l WHERE l.id = 'singleton';
  v_song := v_nhip IS NOT NULL AND v_nhip > now() - interval '2 minutes';
  v_im   := v_nhip IS NULL OR v_nhip < now() - interval '10 minutes';

  -- (A) Worker im lặng ------------------------------------------------------
  IF v_im THEN
    INSERT INTO app_private.zalo_canh_gac_su_co (loai, bat_dau_at)
    SELECT 'worker_im_lang',
           -- lease đã nhả (mốc 1970) hoặc chưa từng có: giờ dừng thật không biết,
           -- tính từ lượt phát hiện — báo sau 10 phút nữa nếu vẫn im.
           CASE WHEN v_nhip IS NULL OR v_nhip < '2000-01-01'::timestamptz THEN now() ELSE v_nhip END
     WHERE EXISTS (SELECT 1 FROM public.zalo_accounts a WHERE a.kind = 'personal' AND a.status <> 'disconnected')
    ON CONFLICT DO NOTHING;

    FOR v_sc IN
      SELECT * FROM app_private.zalo_canh_gac_su_co
       WHERE loai = 'worker_im_lang' AND dong_at IS NULL AND da_bao_at IS NULL
         AND bat_dau_at <= now() - interval '10 minutes'
       FOR UPDATE
    LOOP
      v_nguoi := 0; v_reqs := '{}'; v_loi_push := NULL;
      FOR v_org IN
        SELECT DISTINCT a.organization_id FROM public.zalo_accounts a
         WHERE a.kind = 'personal' AND a.status <> 'disconnected' AND a.organization_id IS NOT NULL
      LOOP
        v_kq := app_private.zalo_canh_gac_bao_v1(
          v_org, 'Zalo mất kết nối',
          'Worker Zalo im lặng từ ' || to_char(v_sc.bat_dau_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI DD/MM')
            || '. Tin mới chưa về CRM; mở Chat Zalo để xem.',
          'zalo-canh-gac:' || v_sc.id::text || ':mo', 'worker_im_lang', 'zalo-canh-gac:worker');
        v_nguoi := v_nguoi + (v_kq->>'so_nguoi')::integer;
        v_reqs := v_reqs || ARRAY(SELECT jsonb_array_elements_text(v_kq->'request_ids')::bigint);
        v_loi_push := COALESCE(v_loi_push, v_kq->>'loi_jwt');
      END LOOP;
      UPDATE app_private.zalo_canh_gac_su_co
         SET da_bao_at = now(), so_nguoi_bao = v_nguoi, push_request_ids = v_reqs, loi_push = v_loi_push
       WHERE id = v_sc.id;
      v_mo := v_mo + 1;
    END LOOP;
  ELSIF v_song THEN
    -- Đóng; đã báo thì báo "chạy lại", chưa báo (restart nhanh) thì đóng im lặng.
    FOR v_sc IN
      SELECT * FROM app_private.zalo_canh_gac_su_co
       WHERE loai = 'worker_im_lang' AND dong_at IS NULL
       FOR UPDATE
    LOOP
      UPDATE app_private.zalo_canh_gac_su_co SET dong_at = now() WHERE id = v_sc.id;
      IF v_sc.da_bao_at IS NOT NULL THEN
        FOR v_org IN
          SELECT DISTINCT a.organization_id FROM public.zalo_accounts a
           WHERE a.kind = 'personal' AND a.status <> 'disconnected' AND a.organization_id IS NOT NULL
        LOOP
          PERFORM app_private.zalo_canh_gac_bao_v1(
            v_org, 'Worker Zalo đã chạy lại',
            'Worker Zalo chạy lại. Tin đến trong lúc mất kết nối có thể chưa về CRM; xem trên điện thoại.',
            'zalo-canh-gac:' || v_sc.id::text || ':dong', 'worker_im_lang', 'zalo-canh-gac:worker');
        END LOOP;
      END IF;
      v_dong := v_dong + 1;
    END LOOP;
  END IF;

  -- (B) Phiên tài khoản lỗi — chỉ khi worker sống ---------------------------
  IF v_song THEN
    INSERT INTO app_private.zalo_canh_gac_su_co (loai, account_id, bat_dau_at)
    SELECT 'tai_khoan_loi', a.id, now()
      FROM public.zalo_accounts a
     WHERE a.kind = 'personal' AND a.status = 'error'
    ON CONFLICT DO NOTHING;

    FOR v_sc IN
      SELECT s.* FROM app_private.zalo_canh_gac_su_co s
        JOIN public.zalo_accounts a ON a.id = s.account_id
       WHERE s.loai = 'tai_khoan_loi' AND s.dong_at IS NULL AND s.da_bao_at IS NULL
         AND a.status = 'error' AND s.bat_dau_at <= now() - interval '20 minutes'
       FOR UPDATE OF s
    LOOP
      SELECT a.organization_id, a.name, a.last_error INTO v_org, v_ten, v_loi
        FROM public.zalo_accounts a WHERE a.id = v_sc.account_id;
      v_kq := app_private.zalo_canh_gac_bao_v1(
        v_org, 'Phiên Zalo bị lỗi',
        'Tài khoản Zalo ' || COALESCE(NULLIF(btrim(v_ten), ''), 'của công ty') || ' lỗi kết nối từ '
          || to_char(v_sc.bat_dau_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI DD/MM')
          || COALESCE(': ' || left(NULLIF(btrim(v_loi), ''), 160), '')
          || '. Mở Chat Zalo xem; thường cần bấm Kết nối lại và quét QR.',
        'zalo-canh-gac:' || v_sc.id::text || ':mo', 'tai_khoan_loi', 'zalo-canh-gac:tk:' || v_sc.account_id::text);
      UPDATE app_private.zalo_canh_gac_su_co
         SET da_bao_at = now(), so_nguoi_bao = (v_kq->>'so_nguoi')::integer,
             push_request_ids = ARRAY(SELECT jsonb_array_elements_text(v_kq->'request_ids')::bigint),
             loi_push = v_kq->>'loi_jwt'
       WHERE id = v_sc.id;
      v_mo := v_mo + 1;
    END LOOP;

    -- Tài khoản đã đăng nhập lại hoặc đã bị ngắt ⇒ đóng. 'connecting'/'waiting_scan' là
    -- đang thử lại: giữ sự cố mở để tài khoản chập chờn không bị báo lặp.
    FOR v_sc IN
      SELECT s.* FROM app_private.zalo_canh_gac_su_co s
        JOIN public.zalo_accounts a ON a.id = s.account_id
       WHERE s.loai = 'tai_khoan_loi' AND s.dong_at IS NULL AND a.status IN ('connected', 'disconnected')
       FOR UPDATE OF s
    LOOP
      UPDATE app_private.zalo_canh_gac_su_co SET dong_at = now() WHERE id = v_sc.id;
      SELECT a.organization_id, a.name INTO v_org, v_ten
        FROM public.zalo_accounts a WHERE a.id = v_sc.account_id AND a.status = 'connected';
      IF v_sc.da_bao_at IS NOT NULL AND v_org IS NOT NULL THEN
        PERFORM app_private.zalo_canh_gac_bao_v1(
          v_org, 'Zalo đã kết nối lại',
          'Tài khoản Zalo ' || COALESCE(NULLIF(btrim(v_ten), ''), 'của công ty') || ' đã đăng nhập lại.',
          'zalo-canh-gac:' || v_sc.id::text || ':dong', 'tai_khoan_loi', 'zalo-canh-gac:tk:' || v_sc.account_id::text);
      END IF;
      v_dong := v_dong + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('nhip_tim', v_nhip, 'song', v_song, 'mo', v_mo, 'dong', v_dong);
END $$;

REVOKE ALL ON FUNCTION app_private.zalo_canh_gac_tick_v1() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.zalo_canh_gac_tick_v1() IS
  'Một lượt canh gác worker Zalo (pg_cron zalo-canh-gac-5m): mở/đóng sự cố trong app_private.zalo_canh_gac_su_co và báo chủ công ty qua notifications + send-push.';

-- ---------------------------------------------------------------------------
-- 5. Lịch 5 phút — chỉ khi nền tảng có pg_cron. cron.schedule theo tên là ghi đè,
--    chạy lại migration không nhân đôi job.
-- ---------------------------------------------------------------------------
DO $cronblock$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'Không có schema cron (môi trường diễn tập) — bỏ qua đăng ký lịch canh gác Zalo.';
    RETURN;
  END IF;
  PERFORM cron.schedule('zalo-canh-gac-5m', '*/5 * * * *', 'SELECT app_private.zalo_canh_gac_tick_v1();');
END
$cronblock$;

-- ---------------------------------------------------------------------------
-- 6. Tự kiểm quyền và lịch trước khi commit
-- ---------------------------------------------------------------------------
DO $kiem$
DECLARE v_n integer;
BEGIN
  IF has_function_privilege('anon', 'public.zalo_worker_status_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon vẫn gọi được zalo_worker_status_v1. DỪNG.';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.zalo_worker_status_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated chưa gọi được zalo_worker_status_v1. DỪNG.';
  END IF;
  IF has_function_privilege('authenticated', 'app_private.zalo_canh_gac_tick_v1()', 'EXECUTE')
     OR has_function_privilege('service_role', 'app_private.zalo_canh_gac_tick_v1()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.zalo_canh_gac_bao_v1(uuid, text, text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Hàm canh gác lộ quyền EXECUTE. DỪNG.';
  END IF;
  IF has_table_privilege('authenticated', 'app_private.zalo_canh_gac_su_co', 'SELECT')
     OR has_table_privilege('anon', 'app_private.zalo_canh_gac_su_co', 'SELECT') THEN
    RAISE EXCEPTION 'Bảng sự cố canh gác lộ quyền đọc. DỪNG.';
  END IF;
  IF to_regnamespace('cron') IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'zalo-canh-gac-5m' AND schedule = '*/5 * * * *' AND active;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'Lịch zalo-canh-gac-5m chưa đăng ký đúng (thấy % job). DỪNG.', v_n;
    END IF;
  END IF;
END $kiem$;

COMMIT;
