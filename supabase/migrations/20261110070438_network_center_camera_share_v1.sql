-- =============================================================================
-- Chia sẻ MỘT kênh camera cho khách xem lại, có thời hạn (chủ nhắn 10/11/2026).
--
-- VÌ SAO KHÔNG TẠO TÀI KHOẢN TRÊN ĐẦU GHI
--   Đo trên một đầu ghi KBVision (firmware 4.005) ngày 10/11: tài khoản chỉ có quyền xem lại MỘT kênh vẫn
--   tải được bản ghi kênh khác qua loadfile.cgi và đọc được cấu hình máy. Vì vậy khách KHÔNG nhận tài
--   khoản đầu ghi.
--   Khách nhận ID + mật khẩu của một "lượt chia sẻ" nằm ở đây; video đi qua gateway camera-live, gateway
--   hỏi camera_share_authorize_v1 và chỉ phát đúng kênh, đúng khung giờ của lượt đó.
--
-- AI LÀM ĐƯỢC GÌ
--   · Tạo / xem danh sách / thu hồi: người đang xem được Trung tâm mạng của toà (network_center.view),
--     cùng hàng rào với bảng camera_recorders (kể cả ẩn org sandbox với super admin).
--   · Đăng nhập / kiểm phiên / thoát: anon (khách không có tài khoản CRM). Hàng rào là mật khẩu băm bcrypt,
--     khoá dò theo ID (5 lần sai / 15 phút) và chuỗi phiên 32 byte chỉ lưu sha256.
--
-- CHỈ XEM LẠI
--   Khung giờ chia sẻ phải nằm hẳn trong quá khứ lúc tạo (tối đa 24 giờ): khung giờ kéo sang tương lai sẽ cho
--   khách theo dõi gần như trực tiếp, trái với điều chủ đã chốt.
--
-- HẾT HẠN / THU HỒI
--   Hiệu lực tính ngay trong câu đọc (expires_at, revoked_at): hết hạn là mất quyền, không chờ job.
--   Job camera_share_cleanup_v1 (15 phút/lần) xoá mật khẩu băm + phiên của lượt đã kết thúc và xoá hẳn
--   dòng lượt chia sẻ sau 30 ngày (30 ngày đó để người quản lý còn thấy ai đã chia sẻ gì).
--
-- ĐƯỜNG LÙI
--   REVOKE/DROP 6 RPC + 4 hàm phụ, cron.unschedule('camera_share_cleanup_v1'); ba bảng để nguyên (không ai đọc).
--
-- Chạy được hai lượt liên tiếp và trên DB rỗng (không đòi dữ liệu, không đòi pg_cron).
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(20261110070438::bigint);

-- ---------------------------------------------------------------------------
-- 0. Tiền đề.
DO $truoc$
DECLARE
  v_sig text;
BEGIN
  IF to_regprocedure('extensions.crypt(text, text)') IS NULL
     OR to_regprocedure('extensions.gen_salt(text, integer)') IS NULL
     OR to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu pgcrypto (extensions.crypt / gen_salt / gen_random_bytes) — DỪNG.' USING ERRCODE = '55000';
  END IF;
  FOREACH v_sig IN ARRAY ARRAY['public.can_access_building(uuid)', 'public.can_do_on_building(text,text,uuid)',
                               'public.is_super_admin()', 'public.sandbox_org_ids()']
  LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'Thiếu % — DỪNG.', v_sig USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF to_regclass('public.camera_recorders') IS NULL OR to_regclass('public.camera_recorder_current') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng camera (20261022145352) — DỪNG.' USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Bảng (app_private: trình duyệt không đọc thẳng, chỉ qua RPC).
CREATE TABLE IF NOT EXISTS app_private.camera_shares (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id     uuid NOT NULL,
  recorder_id     uuid NOT NULL,
  channel         integer NOT NULL CHECK (channel BETWEEN 1 AND 256),
  -- tên kênh chụp lúc tạo (đầu ghi đổi tên sau đó không làm đổi nội dung đã gửi khách)
  channel_name    text CHECK (length(channel_name) <= 128),
  -- khung giờ khách được xem lại, tròn giây, tối đa 24 giờ (trần của gateway)
  window_start    timestamptz NOT NULL,
  window_end      timestamptz NOT NULL,
  -- ID gửi cho khách: 8 ký tự, bỏ I O 0 1 cho dễ đọc
  code            text NOT NULL UNIQUE CHECK (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  -- bcrypt (extensions.crypt); NULL sau khi lượt kết thúc (job dọn / thu hồi)
  password_hash   text,
  note            text CHECK (length(note) <= 120),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at      timestamptz NOT NULL,
  revoked_by      uuid,
  revoked_at      timestamptz,
  last_login_at   timestamptz,
  login_count     integer NOT NULL DEFAULT 0,
  CHECK (window_end > window_start AND window_end - window_start <= interval '24 hours'),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days 1 minute'),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  FOREIGN KEY (organization_id, building_id, recorder_id)
    REFERENCES public.camera_recorders (organization_id, building_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS camera_shares_toa ON app_private.camera_shares (building_id, created_at DESC);

-- phiên của khách: server chỉ giữ sha256 của chuỗi phiên. Hiệu lực của phiên = hiệu lực của lượt chia sẻ.
CREATE TABLE IF NOT EXISTS app_private.camera_share_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  share_id   uuid NOT NULL REFERENCES app_private.camera_shares (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS camera_share_sessions_luot ON app_private.camera_share_sessions (share_id, created_at DESC);

-- lần nhập mật khẩu sai (chống dò), chỉ ghi cho ID có thật và còn hiệu lực
CREATE TABLE IF NOT EXISTS app_private.camera_share_login_failures (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code      text NOT NULL CHECK (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  failed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS camera_share_login_failures_ma
  ON app_private.camera_share_login_failures (code, failed_at DESC);

REVOKE ALL ON app_private.camera_shares, app_private.camera_share_sessions, app_private.camera_share_login_failures
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Hàm phụ.

-- Người gọi có được chia sẻ camera của toà này không: đúng hàng rào đọc của public.camera_recorders
-- (policy camera_recorders_view + camera_recorders_hide_sandbox_admin).
CREATE OR REPLACE FUNCTION app_private.camera_share_actor_can_v1(p_organization_id uuid, p_building_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  SELECT (SELECT auth.uid()) IS NOT NULL
     AND p_organization_id IS NOT NULL
     AND p_building_id IS NOT NULL
     AND COALESCE(public.can_access_building(p_building_id), false)
     AND COALESCE(public.can_do_on_building('network_center', 'view', p_building_id), false)
     AND NOT (COALESCE(public.is_super_admin(), false)
              AND COALESCE(p_organization_id = ANY (public.sandbox_org_ids()), false))
$fn$;

-- Lượt chia sẻ của một chuỗi phiên (NULL = phiên sai / lượt hết hạn / đã thu hồi / đầu ghi đã tắt).
CREATE OR REPLACE FUNCTION app_private.camera_share_of_session_v1(p_token text)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  SELECT s.id
    FROM app_private.camera_share_sessions x
    JOIN app_private.camera_shares s ON s.id = x.share_id
    JOIN public.camera_recorders r ON r.id = s.recorder_id
   WHERE p_token ~ '^cs_[A-Za-z0-9_-]{43}$'
     AND x.token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex')
     AND s.revoked_at IS NULL
     AND s.expires_at > pg_catalog.now()
     AND r.enabled
     AND r.organization_id = s.organization_id
     AND r.building_id = s.building_id
$fn$;

-- Gói mô tả lượt chia sẻ cho gateway và trang của khách. KHÔNG có ID, mật khẩu hay ghi chú nội bộ.
CREATE OR REPLACE FUNCTION app_private.camera_share_payload_v1(p_share_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  SELECT pg_catalog.jsonb_build_object(
           'share_id', s.id,
           'recorder_id', s.recorder_id,
           'organization_id', s.organization_id,
           'building_id', s.building_id,
           'channel', s.channel,
           'channel_name', s.channel_name,
           'building_name', b.name,
           'window_start', s.window_start,
           'window_end', s.window_end,
           'expires_at', s.expires_at)
    FROM app_private.camera_shares s
    JOIN public.buildings b ON b.id = s.building_id
   WHERE s.id = p_share_id
$fn$;

-- Dọn lượt đã kết thúc. Chạy bằng pg_cron (vai chủ job), không cần JWT.
CREATE OR REPLACE FUNCTION app_private.camera_share_cleanup_v1()
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path TO ''
AS $fn$
  UPDATE app_private.camera_shares s
     SET password_hash = NULL
   WHERE s.password_hash IS NOT NULL
     AND (s.revoked_at IS NOT NULL OR s.expires_at <= pg_catalog.clock_timestamp());
  DELETE FROM app_private.camera_share_sessions x
   USING app_private.camera_shares s
   WHERE s.id = x.share_id
     AND (s.revoked_at IS NOT NULL OR s.expires_at <= pg_catalog.clock_timestamp());
  DELETE FROM app_private.camera_share_login_failures f
   WHERE f.failed_at < pg_catalog.clock_timestamp() - interval '2 days';
  DELETE FROM app_private.camera_shares s
   WHERE LEAST(s.expires_at, COALESCE(s.revoked_at, s.expires_at)) < pg_catalog.clock_timestamp() - interval '30 days';
$fn$;

REVOKE ALL ON FUNCTION app_private.camera_share_actor_can_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.camera_share_of_session_v1(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.camera_share_payload_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.camera_share_cleanup_v1() FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. RPC cho người quản lý (đã đăng nhập CRM).

-- Tạo lượt chia sẻ. Mật khẩu trả về đúng MỘT lần ở đây; server chỉ giữ bản băm.
CREATE OR REPLACE FUNCTION public.camera_share_create_v1(
  p_recorder_id   uuid,
  p_channel       integer,
  p_window_start  timestamptz,
  p_window_end    timestamptz,
  p_expires_hours integer DEFAULT 24,
  p_note          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  c_code   CONSTANT text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- 32 ký tự: byte % 32 không lệch
  c_pass   CONSTANT text := 'abcdefghijkmnpqrstuvwxyz23456789';  -- 32 ký tự, bỏ l o 0 1
  v_actor  uuid := auth.uid();
  v_now    timestamptz := clock_timestamp();
  v_start  timestamptz := date_trunc('second', p_window_start);
  v_end    timestamptz := date_trunc('second', p_window_end);
  v_note   text := NULLIF(btrim(COALESCE(p_note, '')), '');
  r        public.camera_recorders%ROWTYPE;
  v_active integer;
  v_name   text;
  v_bytes  bytea;
  v_code   text;
  v_pass   text := '';
  v_exp    timestamptz;
  v_id     uuid;
  i        integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Cần đăng nhập để chia sẻ camera' USING ERRCODE = '42501';
  END IF;
  -- Chỉ XEM LẠI: khung giờ phải nằm hẳn trong quá khứ, nếu không khách bấm xem liên tục là theo dõi được gần như
  -- trực tiếp. Đồng hồ máy người tạo có thể nhanh vài phút, nên giờ kết thúc vượt "bây giờ" không quá 5 phút được
  -- kéo về "bây giờ"; xa hơn thì từ chối (không âm thầm cắt khung giờ người tạo đã chọn).
  IF v_end > v_now AND v_end <= v_now + interval '5 minutes' THEN
    v_end := date_trunc('second', v_now);
  END IF;
  IF p_recorder_id IS NULL OR p_channel IS NULL OR v_start IS NULL OR v_end IS NULL
     OR p_expires_hours IS NULL OR p_expires_hours NOT BETWEEN 1 AND 168
     OR v_end <= v_start OR v_end - v_start > interval '24 hours'
     OR v_end > v_now OR v_start < v_now - interval '60 days'
     OR length(v_note) > 120 THEN
    RAISE EXCEPTION 'Thông tin chia sẻ camera không hợp lệ' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO r FROM public.camera_recorders c WHERE c.id = p_recorder_id;
  -- không phân biệt "không có" với "không có quyền": không lộ đầu ghi của toà khác
  IF r.id IS NULL OR NOT r.enabled
     OR NOT app_private.camera_share_actor_can_v1(r.organization_id, r.building_id) THEN
    RAISE EXCEPTION 'Không có quyền chia sẻ camera này' USING ERRCODE = '42501';
  END IF;
  IF p_channel NOT BETWEEN 1 AND r.channel_count THEN
    RAISE EXCEPTION 'Kênh camera không hợp lệ' USING ERRCODE = '22023';
  END IF;

  -- trần theo toà; khoá theo toà để hai lượt tạo song song không cùng vượt trần
  PERFORM pg_advisory_xact_lock(hashtextextended('camera_share:' || r.building_id::text, 0));
  SELECT count(*)::integer INTO v_active
    FROM app_private.camera_shares s
   WHERE s.building_id = r.building_id AND s.revoked_at IS NULL AND s.expires_at > v_now;
  IF v_active >= 20 THEN
    RAISE EXCEPTION 'Toà này đang có 20 lượt chia sẻ camera còn hiệu lực. Hãy thu hồi bớt rồi tạo lại.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT NULLIF(btrim(x.value ->> 'name'), '') INTO v_name
    FROM public.camera_recorder_current c
   CROSS JOIN LATERAL jsonb_array_elements(c.channels) AS x(value)
   WHERE c.recorder_id = r.id AND x.value -> 'channel' = to_jsonb(p_channel)
   LIMIT 1;

  LOOP
    v_bytes := extensions.gen_random_bytes(8);
    v_code := '';
    FOR i IN 0..7 LOOP
      v_code := v_code || substr(c_code, 1 + (get_byte(v_bytes, i) % 32), 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM app_private.camera_shares s WHERE s.code = v_code);
  END LOOP;
  v_bytes := extensions.gen_random_bytes(8);
  FOR i IN 0..7 LOOP
    v_pass := v_pass || substr(c_pass, 1 + (get_byte(v_bytes, i) % 32), 1);
  END LOOP;

  v_exp := v_now + make_interval(hours => p_expires_hours);
  INSERT INTO app_private.camera_shares (
    organization_id, building_id, recorder_id, channel, channel_name, window_start, window_end,
    code, password_hash, note, created_by, created_at, expires_at)
  VALUES (
    r.organization_id, r.building_id, r.id, p_channel, left(v_name, 128), v_start, v_end,
    v_code, extensions.crypt(v_pass, extensions.gen_salt('bf', 8)), v_note, v_actor, v_now, v_exp)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'id', v_id, 'code', v_code, 'password', v_pass,
    'recorder_id', r.id, 'channel', p_channel, 'channel_name', left(v_name, 128),
    'window_start', v_start, 'window_end', v_end, 'expires_at', v_exp, 'note', v_note);
END
$fn$;

-- Danh sách lượt chia sẻ của toà: đang hiệu lực + đã kết thúc chưa quá 30 ngày. Không bao giờ trả mật khẩu.
CREATE OR REPLACE FUNCTION public.camera_shares_v1(p_building_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_org uuid;
BEGIN
  SELECT b.organization_id INTO v_org FROM public.buildings b WHERE b.id = p_building_id;
  IF v_org IS NULL OR NOT app_private.camera_share_actor_can_v1(v_org, p_building_id) THEN
    RAISE EXCEPTION 'Không có quyền xem lượt chia sẻ camera của toà này' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('shares', COALESCE((
    SELECT jsonb_agg(q.item ORDER BY q.created_at DESC, q.id)
      FROM (
        SELECT s.created_at, s.id, jsonb_build_object(
                 'id', s.id, 'recorder_id', s.recorder_id, 'channel', s.channel, 'channel_name', s.channel_name,
                 'window_start', s.window_start, 'window_end', s.window_end,
                 'code', s.code, 'note', s.note,
                 'created_by_name', (SELECT COALESCE(NULLIF(btrim(p.full_name), ''), p.email)
                                       FROM public.profiles p WHERE p.id = s.created_by),
                 'created_at', s.created_at, 'expires_at', s.expires_at, 'revoked_at', s.revoked_at,
                 'status', CASE WHEN s.revoked_at IS NOT NULL THEN 'REVOKED'
                                WHEN s.expires_at <= now() THEN 'EXPIRED' ELSE 'ACTIVE' END,
                 'last_login_at', s.last_login_at, 'login_count', s.login_count) AS item
          FROM app_private.camera_shares s
         WHERE s.building_id = p_building_id AND s.organization_id = v_org
         ORDER BY s.created_at DESC, s.id
         LIMIT 100
      ) q), '[]'::jsonb));
END
$fn$;

-- Thu hồi bằng tay: khoá ngay, xoá mật khẩu băm và mọi phiên của khách.
CREATE OR REPLACE FUNCTION public.camera_share_revoke_v1(p_share_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  s       app_private.camera_shares%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR p_share_id IS NULL THEN
    RAISE EXCEPTION 'Không có quyền thu hồi lượt chia sẻ này' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM app_private.camera_shares x WHERE x.id = p_share_id FOR UPDATE;
  IF s.id IS NULL OR NOT app_private.camera_share_actor_can_v1(s.organization_id, s.building_id) THEN
    RAISE EXCEPTION 'Không có quyền thu hồi lượt chia sẻ này' USING ERRCODE = '42501';
  END IF;
  DELETE FROM app_private.camera_share_sessions x WHERE x.share_id = s.id;
  IF s.revoked_at IS NOT NULL OR s.expires_at <= clock_timestamp() THEN
    UPDATE app_private.camera_shares x SET password_hash = NULL WHERE x.id = s.id AND x.password_hash IS NOT NULL;
    RETURN jsonb_build_object('status', 'ALREADY_ENDED');
  END IF;
  UPDATE app_private.camera_shares x
     SET revoked_at = clock_timestamp(), revoked_by = v_actor, password_hash = NULL
   WHERE x.id = s.id;
  RETURN jsonb_build_object('status', 'REVOKED');
END
$fn$;

-- ---------------------------------------------------------------------------
-- 4. RPC cho khách (không đăng nhập CRM).

-- Đăng nhập bằng ID + mật khẩu. KHÔNG RAISE khi sai: ghi lần sai rồi RETURN (RAISE rollback luôn bản ghi ⇒ hết
-- chống dò). Khoá theo ID: 5 lần sai / 15 phút. KHÔNG có trần theo ngày: mật khẩu 40 bit nên ~480 lần thử/ngày
-- không dò nổi, còn trần theo ngày chỉ giúp người thấy link (ID nằm trong link) khoá khách cả ngày.
-- Chỉ ghi lần sai cho ID có thật và còn hiệu lực: ID bịa không tạo được dòng nào (không phình bảng), và cũng
-- không có gì để dò.
CREATE OR REPLACE FUNCTION public.camera_share_login_v1(p_code text, p_password text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_code  text := upper(regexp_replace(COALESCE(p_code, ''), '[[:space:]-]', '', 'g'));
  v_pass  text := lower(btrim(COALESCE(p_password, '')));
  s       app_private.camera_shares%ROWTYPE;
  v_fail  integer;
  v_first timestamptz;
  v_ok    boolean := false;
  v_token text;
BEGIN
  IF v_code !~ '^[A-HJ-NP-Z2-9]{8}$' THEN
    RETURN jsonb_build_object('status', 'INVALID', 'attempts_left', 4);
  END IF;

  -- một lượt đăng nhập của một ID tại một thời điểm: đếm lần sai không bị hai lượt song song vượt qua
  PERFORM pg_advisory_xact_lock(hashtextextended('camera_share_login:' || v_code, 0));

  SELECT * INTO s FROM app_private.camera_shares x WHERE x.code = v_code;
  IF s.id IS NULL THEN
    RETURN jsonb_build_object('status', 'INVALID', 'attempts_left', 4);
  END IF;
  IF s.revoked_at IS NOT NULL OR s.expires_at <= clock_timestamp()
     OR NOT EXISTS (SELECT 1 FROM public.camera_recorders r WHERE r.id = s.recorder_id AND r.enabled) THEN
    RETURN jsonb_build_object('status', 'ENDED');
  END IF;

  SELECT count(*)::integer, min(f.failed_at)
    INTO v_fail, v_first
    FROM app_private.camera_share_login_failures f
   WHERE f.code = v_code AND f.failed_at > clock_timestamp() - interval '15 minutes';
  IF v_fail >= 5 THEN
    RETURN jsonb_build_object('status', 'LOCKED',
      'retry_after_seconds', GREATEST(1, ceil(extract(epoch FROM (v_first + interval '15 minutes' - clock_timestamp())))::integer));
  END IF;

  IF s.password_hash IS NOT NULL AND v_pass ~ '^[a-z0-9]{8}$' THEN
    v_ok := s.password_hash = extensions.crypt(v_pass, s.password_hash);
  END IF;
  IF NOT v_ok THEN
    INSERT INTO app_private.camera_share_login_failures (code) VALUES (v_code);
    RETURN jsonb_build_object('status', 'INVALID', 'attempts_left', GREATEST(0, 4 - v_fail));
  END IF;

  v_token := 'cs_' || rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  INSERT INTO app_private.camera_share_sessions (token_hash, share_id)
  VALUES (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), s.id);
  -- giữ 5 phiên mới nhất của lượt (khách đổi máy / mở lại trình duyệt), phiên cũ hơn bị loại
  DELETE FROM app_private.camera_share_sessions x
   WHERE x.share_id = s.id
     AND x.token_hash NOT IN (SELECT y.token_hash FROM app_private.camera_share_sessions y
                               WHERE y.share_id = s.id ORDER BY y.created_at DESC, y.token_hash LIMIT 5);
  UPDATE app_private.camera_shares x
     SET last_login_at = clock_timestamp(), login_count = x.login_count + 1
   WHERE x.id = s.id;
  DELETE FROM app_private.camera_share_login_failures f WHERE f.code = v_code;
  RETURN jsonb_build_object('status', 'OK', 'session', v_token, 'share', app_private.camera_share_payload_v1(s.id));
END
$fn$;

-- Kiểm chuỗi phiên: gateway camera-live gọi trước mỗi lần phát / gia hạn; trang của khách gọi khi mở lại.
-- NULL = phiên không còn dùng được (sai, hết hạn, đã thu hồi, đầu ghi đã tắt).
CREATE OR REPLACE FUNCTION public.camera_share_authorize_v1(p_token text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
  SELECT app_private.camera_share_payload_v1(app_private.camera_share_of_session_v1(p_token))
$fn$;

CREATE OR REPLACE FUNCTION public.camera_share_logout_v1(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  IF p_token IS NOT NULL AND p_token ~ '^cs_[A-Za-z0-9_-]{43}$' THEN
    DELETE FROM app_private.camera_share_sessions x
     WHERE x.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  END IF;
  RETURN jsonb_build_object('status', 'OK');
END
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Quyền gọi.
REVOKE ALL ON FUNCTION public.camera_share_create_v1(uuid, integer, timestamptz, timestamptz, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.camera_shares_v1(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.camera_share_revoke_v1(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.camera_share_login_v1(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.camera_share_authorize_v1(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.camera_share_logout_v1(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.camera_share_create_v1(uuid, integer, timestamptz, timestamptz, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.camera_shares_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.camera_share_revoke_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.camera_share_login_v1(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.camera_share_authorize_v1(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.camera_share_logout_v1(text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Job dọn (môi trường replay không có pg_cron thì bỏ qua).
DO $don$
BEGIN
  IF pg_catalog.to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'camera_share_cleanup_v1';
  PERFORM cron.schedule(
    'camera_share_cleanup_v1',
    '*/15 * * * *',
    $job$SELECT app_private.camera_share_cleanup_v1()$job$
  );
END
$don$;

-- ---------------------------------------------------------------------------
-- 7. Hậu kiểm.
DO $sau$
DECLARE
  v_sig text;
BEGIN
  IF to_regclass('app_private.camera_shares') IS NULL OR to_regclass('app_private.camera_share_sessions') IS NULL
     OR to_regclass('app_private.camera_share_login_failures') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng chia sẻ camera' USING ERRCODE = 'XX000';
  END IF;
  FOREACH v_sig IN ARRAY ARRAY['public.camera_share_create_v1(uuid,integer,timestamptz,timestamptz,integer,text)',
                               'public.camera_shares_v1(uuid)', 'public.camera_share_revoke_v1(uuid)',
                               'app_private.camera_share_actor_can_v1(uuid,uuid)',
                               'app_private.camera_share_of_session_v1(text)',
                               'app_private.camera_share_payload_v1(uuid)',
                               'app_private.camera_share_cleanup_v1()']
  LOOP
    IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon gọi được %', v_sig USING ERRCODE = 'XX000';
    END IF;
  END LOOP;
  FOREACH v_sig IN ARRAY ARRAY['public.camera_share_login_v1(text,text)', 'public.camera_share_authorize_v1(text)',
                               'public.camera_share_logout_v1(text)']
  LOOP
    IF NOT has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon KHÔNG gọi được % (khách không đăng nhập được)', v_sig USING ERRCODE = 'XX000';
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'app_private.camera_shares', 'SELECT')
     OR has_table_privilege('authenticated', 'app_private.camera_shares', 'SELECT')
     OR has_table_privilege('anon', 'app_private.camera_share_sessions', 'SELECT')
     OR has_table_privilege('authenticated', 'app_private.camera_share_sessions', 'SELECT') THEN
    RAISE EXCEPTION 'Trình duyệt đọc thẳng được bảng chia sẻ camera' USING ERRCODE = 'XX000';
  END IF;
END
$sau$;

COMMIT;
NOTIFY pgrst, 'reload schema';
