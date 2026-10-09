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
--        • worker_im_lang — nhịp tim cũ hơn 10 phút trong khi còn tài khoản cần
--          worker (status khác 'disconnected'); hết khi nhịp tim mới hơn 2 phút.
--        • tai_khoan_loi — worker sống mà một tài khoản đứng ở 'error' 10 phút,
--          tính từ lượt canh gác đầu tiên thấy nó lỗi (worker ghi lại 'error' mỗi
--          lần thử nên updated_at không dùng được); hết khi tài khoản rời 'error'.
--      Trạng thái tài khoản chỉ đáng tin khi worker sống, nên phần tài khoản chỉ
--      chạy lúc đó.
--   3. Lịch pg_cron 5 phút/lần. Chạy trong database nên VPS chết hẳn vẫn báo được.
--
-- ĐƯỜNG BÁO. Một dòng notifications IN_APP (chuông trong app; push_state để NULL
-- nên drain push hằng ngày không gửi lại) + gọi send-push NGAY qua pg_net, JWT
-- service lấy từ Vault, cùng khe bộ nhắc hợp đồng đang dùng
-- (app_private.lifecycle_reminder_service_jwt_v1). Drain push chỉ chạy 07:00 mỗi
-- ngày, quá trễ cho cảnh báo sự cố. Hàm lấy JWT từ chối trên database TEST đã
-- đánh dấu ⇒ trên TEST chỉ ghi chuông, không bắn push production.
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
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loai         text NOT NULL CHECK (loai IN ('worker_im_lang', 'tai_khoan_loi')),
  account_id   uuid REFERENCES public.zalo_accounts(id) ON DELETE CASCADE,
  bat_dau_at   timestamptz NOT NULL,
  da_bao_at    timestamptz,
  dong_at      timestamptz,
  so_nguoi_bao integer NOT NULL DEFAULT 0,
  co_push      boolean NOT NULL DEFAULT false,
  CONSTRAINT zalo_canh_gac_su_co_tai_khoan_chk CHECK ((loai = 'tai_khoan_loi') = (account_id IS NOT NULL))
);

-- Mỗi loại (và mỗi tài khoản) chỉ một sự cố đang mở: lượt cron sau không mở trùng.
CREATE UNIQUE INDEX IF NOT EXISTS zalo_canh_gac_su_co_dang_mo_uq
  ON app_private.zalo_canh_gac_su_co (loai, COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE dong_at IS NULL;

ALTER TABLE app_private.zalo_canh_gac_su_co ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.zalo_canh_gac_su_co FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE app_private.zalo_canh_gac_su_co IS
  'Sự cố canh gác worker Zalo: worker_im_lang (nhịp tim cũ >10 phút) và tai_khoan_loi (phiên lỗi >10 phút). da_bao_at = đã báo chủ công ty; dong_at = đã hết.';

-- ---------------------------------------------------------------------------
-- 3. Gửi một cảnh báo cho chủ công ty của một tổ chức
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.zalo_canh_gac_bao_v1(
  p_org uuid, p_tieu_de text, p_noi_dung text, p_khoa text, p_loai text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $$
DECLARE
  v_jwt   text;
  v_uid   uuid;
  v_nguoi integer := 0;
BEGIN
  -- TEST đã đánh dấu, hoặc Vault chưa có khoá ⇒ hàm lấy JWT ném lỗi: chỉ ghi chuông.
  BEGIN
    v_jwt := app_private.lifecycle_reminder_service_jwt_v1();
  EXCEPTION WHEN OTHERS THEN
    v_jwt := NULL;
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
      PERFORM net.http_post(
        url := 'https://tryymsxyyckgbrmmvozx.supabase.co/functions/v1/send-push',
        body := jsonb_build_object(
          'userId', v_uid, 'title', p_tieu_de, 'body', p_noi_dung,
          'url', '/chat-zalo', 'tag', 'zalo-canh-gac',
          'idempotencyKey', left(p_khoa || ':' || v_uid::text, 128)),
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_jwt, 'Content-Type', 'application/json'),
        timeout_milliseconds := 30000);
    END IF;
    v_nguoi := v_nguoi + 1;
  END LOOP;

  RETURN jsonb_build_object('so_nguoi', v_nguoi, 'co_push', v_jwt IS NOT NULL AND v_nguoi > 0);
END $$;

REVOKE ALL ON FUNCTION app_private.zalo_canh_gac_bao_v1(uuid, text, text, text, text)
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
  v_nhip timestamptz;
  v_song boolean;
  v_im   boolean;
  v_sc   app_private.zalo_canh_gac_su_co%ROWTYPE;
  v_org  uuid;
  v_ten  text;
  v_kq   jsonb;
  v_nguoi integer;
  v_push  boolean;
  v_mo   integer := 0;
  v_dong integer := 0;
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
           -- nhả lease ghi mốc 1970: không biết giờ dừng thật, lấy giờ phát hiện
           CASE WHEN v_nhip IS NULL OR v_nhip < '2000-01-01'::timestamptz THEN now() ELSE v_nhip END
     WHERE EXISTS (SELECT 1 FROM public.zalo_accounts a WHERE a.kind = 'personal' AND a.status <> 'disconnected')
    ON CONFLICT DO NOTHING;

    FOR v_sc IN
      SELECT * FROM app_private.zalo_canh_gac_su_co
       WHERE loai = 'worker_im_lang' AND dong_at IS NULL AND da_bao_at IS NULL
       FOR UPDATE
    LOOP
      v_nguoi := 0; v_push := false;
      FOR v_org IN
        SELECT DISTINCT a.organization_id FROM public.zalo_accounts a
         WHERE a.kind = 'personal' AND a.status <> 'disconnected' AND a.organization_id IS NOT NULL
      LOOP
        v_kq := app_private.zalo_canh_gac_bao_v1(
          v_org, 'Zalo mất kết nối',
          'Worker Zalo im lặng từ ' || to_char(v_sc.bat_dau_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI DD/MM')
            || '. Tin mới chưa về CRM; mở Chat Zalo để xem.',
          'zalo-canh-gac:' || v_sc.id::text || ':mo', 'worker_im_lang');
        v_nguoi := v_nguoi + (v_kq->>'so_nguoi')::integer;
        v_push := v_push OR (v_kq->>'co_push')::boolean;
      END LOOP;
      UPDATE app_private.zalo_canh_gac_su_co
         SET da_bao_at = now(), so_nguoi_bao = v_nguoi, co_push = v_push
       WHERE id = v_sc.id;
      v_mo := v_mo + 1;
    END LOOP;
  ELSIF v_song THEN
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
            v_org, 'Zalo đã kết nối lại',
            'Worker Zalo đã chạy lại. Tin đến trong lúc mất kết nối có thể chưa về CRM; xem trên điện thoại.',
            'zalo-canh-gac:' || v_sc.id::text || ':dong', 'worker_im_lang');
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
         AND a.status = 'error' AND s.bat_dau_at <= now() - interval '10 minutes'
       FOR UPDATE OF s
    LOOP
      SELECT a.organization_id, a.name INTO v_org, v_ten FROM public.zalo_accounts a WHERE a.id = v_sc.account_id;
      v_kq := app_private.zalo_canh_gac_bao_v1(
        v_org, 'Phiên Zalo cần quét QR lại',
        'Tài khoản Zalo ' || COALESCE(NULLIF(btrim(v_ten), ''), 'của công ty') || ' mất phiên từ '
          || to_char(v_sc.bat_dau_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI DD/MM')
          || '. Mở Chat Zalo, bấm Kết nối lại rồi quét QR.',
        'zalo-canh-gac:' || v_sc.id::text || ':mo', 'tai_khoan_loi');
      UPDATE app_private.zalo_canh_gac_su_co
         SET da_bao_at = now(), so_nguoi_bao = (v_kq->>'so_nguoi')::integer, co_push = (v_kq->>'co_push')::boolean
       WHERE id = v_sc.id;
      v_mo := v_mo + 1;
    END LOOP;

    -- Tài khoản đã rời 'error' (đăng nhập lại, đang quét QR, bị ngắt) ⇒ đóng.
    FOR v_sc IN
      SELECT s.* FROM app_private.zalo_canh_gac_su_co s
        JOIN public.zalo_accounts a ON a.id = s.account_id
       WHERE s.loai = 'tai_khoan_loi' AND s.dong_at IS NULL AND a.status <> 'error'
       FOR UPDATE OF s
    LOOP
      UPDATE app_private.zalo_canh_gac_su_co SET dong_at = now() WHERE id = v_sc.id;
      SELECT a.organization_id, a.name INTO v_org, v_ten
        FROM public.zalo_accounts a WHERE a.id = v_sc.account_id AND a.status = 'connected';
      IF v_sc.da_bao_at IS NOT NULL AND v_org IS NOT NULL THEN
        PERFORM app_private.zalo_canh_gac_bao_v1(
          v_org, 'Zalo đã kết nối lại',
          'Tài khoản Zalo ' || COALESCE(NULLIF(btrim(v_ten), ''), 'của công ty') || ' đã đăng nhập lại.',
          'zalo-canh-gac:' || v_sc.id::text || ':dong', 'tai_khoan_loi');
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
-- 5. Lịch 5 phút — cron.schedule theo tên là ghi đè, chạy lại migration không nhân đôi job
-- ---------------------------------------------------------------------------
SELECT cron.schedule('zalo-canh-gac-5m', '*/5 * * * *', 'SELECT app_private.zalo_canh_gac_tick_v1();');

-- ---------------------------------------------------------------------------
-- 6. Tự kiểm quyền và lịch trước khi commit
-- ---------------------------------------------------------------------------
DO $kiem$
BEGIN
  IF has_function_privilege('anon', 'public.zalo_worker_status_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon vẫn gọi được zalo_worker_status_v1. DỪNG.';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.zalo_worker_status_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated chưa gọi được zalo_worker_status_v1. DỪNG.';
  END IF;
  IF has_function_privilege('authenticated', 'app_private.zalo_canh_gac_tick_v1()', 'EXECUTE')
     OR has_function_privilege('service_role', 'app_private.zalo_canh_gac_tick_v1()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.zalo_canh_gac_bao_v1(uuid, text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Hàm canh gác lộ quyền EXECUTE. DỪNG.';
  END IF;
  IF has_table_privilege('authenticated', 'app_private.zalo_canh_gac_su_co', 'SELECT')
     OR has_table_privilege('anon', 'app_private.zalo_canh_gac_su_co', 'SELECT') THEN
    RAISE EXCEPTION 'Bảng sự cố canh gác lộ quyền đọc. DỪNG.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'zalo-canh-gac-5m' AND schedule = '*/5 * * * *') THEN
    RAISE EXCEPTION 'Chưa có lịch zalo-canh-gac-5m. DỪNG.';
  END IF;
END $kiem$;

COMMIT;
