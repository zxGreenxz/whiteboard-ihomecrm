-- =============================================================================
-- quyet_toan_link_ten_mien_pin — Link tên miền cho chủ nhà vào bằng PIN (chủ nhắn 24/10/2026):
--   · cgiang.chillhome.io.vn (950NK), agiang.chillhome.io.vn (44TL + 481NVK, có ô chọn toà) — tên link cố định ở
--     web, trang quản trị chỉ GỘP TOÀ vào link và quản lý người xem;
--   · "tên miền kèm pin 6 số xem như tài khoản mật khẩu đăng nhập rồi thì lưu lại như crm hiện tại lần sau vào
--     không cần nhập lại, mỗi mã pin định danh cho 1 user"; "PIN người xem cho thêm nhập tên để định danh user
--     luôn sau này có các thao tác trong trang sẽ ghi nhận ai thao tác theo user".
-- =============================================================================
-- VÌ SAO KHÔNG CHỈ DÙNG TÊN MIỀN
--   Tên miền phụ không bí mật (mọi chứng chỉ HTTPS đều lên nhật ký công khai) ⇒ PIN là thứ giữ số liệu. PIN 6 số
--   chỉ có 10^6 giá trị ⇒ chặn dò ở SERVER: mỗi link tối đa 10 lần sai / 15 phút và 30 lần / 24 giờ, PIN luôn do server sinh (sai thì GHI lỗi rồi RETURN, không
--   RAISE — RAISE sẽ rollback luôn bản ghi lỗi, bài học từ 20260903150311_copilot_step_up_pin_v1). PIN băm bcrypt
--   (extensions.crypt), không lưu thô; phiên đăng nhập là chuỗi ngẫu nhiên 32 byte, server chỉ giữ sha256.
--
-- LÀM GÌ
--   1. Bảng app_private: landlord_portals (link → toà), landlord_portal_users (người xem: tên + PIN băm),
--      landlord_portal_sessions (phiên, 180 ngày), landlord_portal_login_failures (đếm lần sai).
--   2. landlord_settlement_confirmations: share_token cho phép NULL + portal_user_id (xác nhận qua link tên miền ghi
--      đúng người xem); ít nhất một trong hai phải có.
--   3. RPC công khai (anon): landlord_portal_login_v1, landlord_portal_v1 (danh sách toà + gói quyết toán của toà
--      đang chọn, chỉ đọc), landlord_portal_confirm_v1, landlord_portal_logout_v1.
--   4. RPC quản trị (chủ công ty / super admin): landlord_portals_v1, landlord_portal_save_v1 (gộp toà),
--      landlord_portal_viewer_add_v1 (tên; PIN server sinh), landlord_portal_viewer_revoke_v1,
--      landlord_portal_unlock_v1 (mở khoá khi bị dò).
--   5. app_private.landlord_settlement_month_payload_v1 (DỰNG TỪ THÂN production md5 55c57c02…, file
--      20261024035114): confirmation thêm 'by' = tên người xem đã xác nhận (link /qt cũ: null).
--   Không đổi: công thức, ảnh chốt, chuỗi băm, link /qt/:token cũ.
--
-- ĐƯỜNG LÙI
--   REVOKE/DROP 8 RPC + 2 hàm phụ; CREATE OR REPLACE gói tháng bằng thân của 20261024035114; bảng mới để nguyên
--   (không ai đọc). Cột confirmations: giữ (NULL được) — không làm hỏng confirm_v1 cũ.
--
-- Chạy được hai lượt liên tiếp và trên DB rỗng của Restore Drill (không đòi dữ liệu).
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. Tiền đề + thân đang chạy phải đúng bản đã rà (hoặc đã là bản của file này — lượt hai).
DO $truoc$
DECLARE
  v_sig  text;
  v_md5  text;
  v_ghim text[];
BEGIN
  IF to_regprocedure('extensions.crypt(text, text)') IS NULL
     OR to_regprocedure('extensions.gen_salt(text, integer)') IS NULL
     OR to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu pgcrypto (extensions.crypt / gen_salt / gen_random_bytes) — DỪNG.' USING ERRCODE = '55000';
  END IF;
  FOR v_sig, v_ghim IN
    SELECT x.sig, x.ghim FROM (VALUES
      ('app_private.landlord_settlement_month_payload_v1(uuid,date,boolean)',
       ARRAY['55c57c02dea842cf444b16428a13634c', '77e7547f4c57ed3c8c435f23709991ab']),
      -- hàm KHÔNG thay mà RPC mới gọi; đổi thì rà lại trước khi áp
      ('app_private.landlord_settlement_overview_payload_v1(uuid,boolean)',
       ARRAY['6e24b6cf619f18b062f4779531544998', 'ba626299fe37535cd64776d0a9722944']),
      ('app_private.landlord_actor_can_manage_v1(uuid)',
       ARRAY['ee1362cb1858a7f9d4f39b31e842a5ca']),
      ('public.landlord_settlement_confirm_v1(text,date,integer,text)',
       ARRAY['f79f67bb4bc1b801e739b9e13dfdd7de'])
    ) AS x(sig, ghim)
  LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'Thiếu % — DỪNG.', v_sig USING ERRCODE = '55000';
    END IF;
    v_md5 := md5(pg_get_functiondef(v_sig::regprocedure));
    IF v_md5 <> ALL (v_ghim) THEN
      RAISE EXCEPTION '% KHÁC bản đã rà (md5 %) — DỪNG, chụp lại pg_get_functiondef rồi rà lại.', v_sig, v_md5
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  -- hàm MỚI: lượt hai phải đúng bản của file này
  FOR v_sig, v_ghim IN
    SELECT x.sig, x.ghim FROM (VALUES
      ('app_private.landlord_portal_viewer_v1(text,text)', ARRAY['dafb5efde8341322c80cc4e0106eab10']),
      ('app_private.landlord_portal_buildings_v1(text)', ARRAY['49f995c6c0b19b2f120d61f058ef1195']),
      ('public.landlord_portal_login_v1(text,text)', ARRAY['3488d3218cbd6a94efcad763c84c42ec']),
      ('public.landlord_portal_v1(text,text,text,date)', ARRAY['db9c3bf958ae49b85abad8ad5e84dc6b']),
      ('public.landlord_portal_confirm_v1(text,text,text,date,integer,text)', ARRAY['589a42ff1fa32ef44b9e9479d61c302b']),
      ('public.landlord_portal_logout_v1(text,text)', ARRAY['72d6980c61eb383b895e2affb1b9d85c']),
      ('public.landlord_portals_v1()', ARRAY['25870775add18bacc1363ba5ee306aa7']),
      ('public.landlord_portal_save_v1(text,uuid[])', ARRAY['ce8d1da2b924206e3af11b5f057cffd1']),
      ('public.landlord_portal_viewer_add_v1(text,text)', ARRAY['d5906236eba8c4b6f59d79fa61a60033']),
      ('public.landlord_portal_viewer_revoke_v1(uuid)', ARRAY['3af551f0d39235fb5d4c41684fe46059']),
      ('public.landlord_portal_unlock_v1(text)', ARRAY['ad4dc7c0e9db538c43c32d3e4532b8e1'])
    ) AS x(sig, ghim)
  LOOP
    IF to_regprocedure(v_sig) IS NOT NULL THEN
      v_md5 := md5(pg_get_functiondef(v_sig::regprocedure));
      IF v_md5 <> ALL (v_ghim) THEN
        RAISE EXCEPTION '% KHÁC bản của file này (md5 %) — DỪNG.', v_sig, v_md5 USING ERRCODE = '55000';
      END IF;
    END IF;
  END LOOP;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Bảng.
CREATE TABLE IF NOT EXISTS app_private.landlord_portals (
  -- tên link cố định ở web (agiang, cgiang…): <slug>.chillhome.io.vn hoặc /cn/<slug>
  slug            text PRIMARY KEY CHECK (slug ~ '^[a-z][a-z0-9-]{1,29}$'),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  building_ids    uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (cardinality(building_ids) <= 50),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by      uuid NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- người xem: mỗi PIN là một người (có tên) — thao tác trên trang ghi theo người này
CREATE TABLE IF NOT EXISTS app_private.landlord_portal_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_slug   text NOT NULL REFERENCES app_private.landlord_portals(slug) ON DELETE RESTRICT,
  label         text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  -- bcrypt (extensions.crypt), KHÔNG lưu PIN thô
  pin_hash      text NOT NULL,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_by    uuid,
  revoked_at    timestamptz,
  last_login_at timestamptz,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX IF NOT EXISTS landlord_portal_users_link ON app_private.landlord_portal_users (portal_slug);

-- phiên đăng nhập: server chỉ giữ sha256 của chuỗi phiên (chuỗi thật chỉ nằm ở trình duyệt người xem)
CREATE TABLE IF NOT EXISTS app_private.landlord_portal_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id    uuid NOT NULL REFERENCES app_private.landlord_portal_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS landlord_portal_sessions_nguoi ON app_private.landlord_portal_sessions (user_id);

-- lần nhập PIN sai (chống dò): đếm theo link trong 15 phút
CREATE TABLE IF NOT EXISTS app_private.landlord_portal_login_failures (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  portal_slug text NOT NULL,
  failed_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS landlord_portal_login_failures_link
  ON app_private.landlord_portal_login_failures (portal_slug, failed_at DESC);

REVOKE ALL ON app_private.landlord_portals, app_private.landlord_portal_users, app_private.landlord_portal_sessions,
  app_private.landlord_portal_login_failures FROM PUBLIC, anon, authenticated, service_role;

-- xác nhận "đã xem số liệu" qua link tên miền: ghi người xem thay cho token link /qt
ALTER TABLE app_private.landlord_settlement_confirmations ALTER COLUMN share_token DROP NOT NULL;
ALTER TABLE app_private.landlord_settlement_confirmations
  ADD COLUMN IF NOT EXISTS portal_user_id uuid REFERENCES app_private.landlord_portal_users(id) ON DELETE RESTRICT;
DO $nguon$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'landlord_settlement_confirmations_nguon_check'
                    AND conrelid = 'app_private.landlord_settlement_confirmations'::regclass) THEN
    ALTER TABLE app_private.landlord_settlement_confirmations
      ADD CONSTRAINT landlord_settlement_confirmations_nguon_check CHECK (share_token IS NOT NULL OR portal_user_id IS NOT NULL);
  END IF;
END
$nguon$;

-- ---------------------------------------------------------------------------
-- 2. Hàm phụ.
-- Người xem của phiên (NULL = phiên sai / hết hạn / đã thoát / người xem bị thu hồi / phiên của link khác).
CREATE OR REPLACE FUNCTION app_private.landlord_portal_viewer_v1(p_slug text, p_session text)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  SELECT u.id
    FROM app_private.landlord_portal_sessions s
    JOIN app_private.landlord_portal_users u ON u.id = s.user_id
   WHERE p_session ~ '^[A-Za-z0-9_-]{43}$'
     AND s.token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_session, 'UTF8')), 'hex')
     AND s.revoked_at IS NULL
     AND s.expires_at > pg_catalog.now()
     AND u.revoked_at IS NULL
     AND u.portal_slug = p_slug
$fn$;

-- Toà của link: đang áp dụng vận hành, còn sống, cùng tổ chức với link. Khoá 'ma' ổn định, không lộ id toà.
CREATE OR REPLACE FUNCTION app_private.landlord_portal_buildings_v1(p_slug text)
RETURNS TABLE (building_id uuid, ma text, building_name text, landlord_name text)
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  SELECT b.id, pg_catalog.substr(pg_catalog.md5(p.slug || ':' || b.id::text), 1, 12), b.name, o.landlord_name
    FROM app_private.landlord_portals p
   CROSS JOIN LATERAL pg_catalog.unnest(p.building_ids) AS x(id)
    JOIN public.buildings b ON b.id = x.id
    JOIN app_private.landlord_operations o ON o.building_id = b.id
   WHERE p.slug = p_slug
     AND b.organization_id = p.organization_id
     AND b.deleted_at IS NULL
     AND NOT COALESCE(b.is_virtual, false)
     AND o.is_active
   ORDER BY b.name, b.id
$fn$;

REVOKE ALL ON FUNCTION app_private.landlord_portal_viewer_v1(text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_portal_buildings_v1(text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. RPC công khai (link tên miền).

-- Đăng nhập bằng PIN. KHÔNG RAISE khi sai: ghi lần sai rồi RETURN (RAISE rollback luôn bản ghi ⇒ hết chống dò).
-- Khoá theo link: 10 lần sai / 15 phút VÀ 30 lần sai / 24 giờ (review chéo: chỉ khoá 15 phút thì người dò kiên
-- nhẫn vẫn thử ~960 lần/ngày). Người đã đăng nhập vẫn xem được trong lúc khoá; quản trị thấy số lần sai và mở khoá.
CREATE OR REPLACE FUNCTION public.landlord_portal_login_v1(p_slug text, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_slug  text := lower(btrim(COALESCE(p_slug, '')));
  v_fail  integer;
  v_first timestamptz;
  v_ngay  integer;
  v_dau   timestamptz;
  v_mo    timestamptz;
  v_user  uuid;
  v_label text;
  v_token text;
  v_exp   timestamptz := clock_timestamp() + interval '180 days';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_private.landlord_portals p WHERE p.slug = v_slug) THEN
    RETURN jsonb_build_object('status', 'NOT_FOUND');
  END IF;

  -- một lượt đăng nhập của một link tại một thời điểm: đếm lần sai không bị hai lượt song song vượt qua
  PERFORM pg_advisory_xact_lock(hashtextextended('landlord_portal_login:' || v_slug, 0));

  SELECT count(*) FILTER (WHERE f.failed_at > clock_timestamp() - interval '15 minutes')::integer,
         min(f.failed_at) FILTER (WHERE f.failed_at > clock_timestamp() - interval '15 minutes'),
         count(*)::integer, min(f.failed_at)
    INTO v_fail, v_first, v_ngay, v_dau
    FROM app_private.landlord_portal_login_failures f
   WHERE f.portal_slug = v_slug AND f.failed_at > clock_timestamp() - interval '24 hours';
  IF v_fail >= 10 OR v_ngay >= 30 THEN
    v_mo := GREATEST(CASE WHEN v_fail >= 10 THEN v_first + interval '15 minutes' END,
                     CASE WHEN v_ngay >= 30 THEN v_dau + interval '24 hours' END);
    RETURN jsonb_build_object('status', 'LOCKED',
      'retry_after_seconds', GREATEST(1, ceil(extract(epoch FROM (v_mo - clock_timestamp())))::integer));
  END IF;

  IF p_pin IS NOT NULL AND p_pin ~ '^[0-9]{6}$' THEN
    SELECT u.id, u.label INTO v_user, v_label
      FROM app_private.landlord_portal_users u
     WHERE u.portal_slug = v_slug
       AND u.revoked_at IS NULL
       AND u.pin_hash = extensions.crypt(p_pin, u.pin_hash)
     ORDER BY u.created_at
     LIMIT 1;
  END IF;

  IF v_user IS NULL THEN
    INSERT INTO app_private.landlord_portal_login_failures (portal_slug) VALUES (v_slug);
    DELETE FROM app_private.landlord_portal_login_failures f
     WHERE f.portal_slug = v_slug AND f.failed_at < clock_timestamp() - interval '2 days';
    RETURN jsonb_build_object('status', 'INVALID', 'attempts_left', GREATEST(0, LEAST(9 - v_fail, 29 - v_ngay)));
  END IF;

  v_token := rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  INSERT INTO app_private.landlord_portal_sessions (token_hash, user_id, expires_at)
  VALUES (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), v_user, v_exp);
  UPDATE app_private.landlord_portal_users u SET last_login_at = clock_timestamp() WHERE u.id = v_user;
  RETURN jsonb_build_object('status', 'OK', 'session', v_token, 'viewer', v_label, 'expires_at', v_exp);
END
$fn$;

-- Trang của link: người xem, danh sách toà, gói quyết toán (chỉ đọc, như link /qt) của toà đang chọn.
-- Phiên sai / hết hạn ⇒ NULL (web xoá phiên, hỏi lại PIN).
CREATE OR REPLACE FUNCTION public.landlord_portal_v1(
  p_slug     text,
  p_session  text,
  p_building text DEFAULT NULL,
  p_month    date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_slug  text := lower(btrim(COALESCE(p_slug, '')));
  v_user  uuid := app_private.landlord_portal_viewer_v1(lower(btrim(COALESCE(p_slug, ''))), p_session);
  v_label text;
  v_list  jsonb;
  v_bid   uuid;
  v_ma    text;
  v_from  date;
  v_now   date := app_private.landlord_current_month_v1();
  v_month date;
BEGIN
  IF v_user IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT u.label INTO v_label FROM app_private.landlord_portal_users u WHERE u.id = v_user;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('key', t.ma, 'building_name', t.building_name, 'landlord_name', t.landlord_name)
                            ORDER BY t.building_name, t.ma), '[]'::jsonb)
    INTO v_list
    FROM app_private.landlord_portal_buildings_v1(v_slug) t;
  -- toà đang chọn: đúng khoá gửi lên, không có thì toà đầu tiên
  SELECT t.building_id, t.ma INTO v_bid, v_ma
    FROM app_private.landlord_portal_buildings_v1(v_slug) t
   ORDER BY (t.ma = p_building) IS TRUE DESC, t.building_name, t.ma
   LIMIT 1;
  IF v_bid IS NULL THEN
    RETURN jsonb_build_object('viewer', v_label, 'buildings', v_list, 'selected', NULL, 'overview', NULL, 'month', NULL);
  END IF;

  SELECT o.effective_from INTO v_from FROM app_private.landlord_operations o WHERE o.building_id = v_bid;
  v_month := COALESCE(date_trunc('month', p_month)::date, v_now);
  IF v_month < v_from THEN
    v_month := v_from;
  ELSIF v_month > v_now THEN
    v_month := v_now;
  END IF;

  RETURN jsonb_build_object(
    'viewer', v_label,
    'buildings', v_list,
    'selected', v_ma,
    'overview', app_private.landlord_settlement_overview_payload_v1(v_bid, true),
    'month', app_private.landlord_settlement_month_payload_v1(v_bid, v_month, true));
END
$fn$;

-- Xác nhận đã xem số liệu (như landlord_settlement_confirm_v1) — ghi người xem của phiên.
CREATE OR REPLACE FUNCTION public.landlord_portal_confirm_v1(
  p_slug     text,
  p_session  text,
  p_building text,
  p_month    date,
  p_revision integer,
  p_note     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_slug  text := lower(btrim(COALESCE(p_slug, '')));
  v_user  uuid := app_private.landlord_portal_viewer_v1(lower(btrim(COALESCE(p_slug, ''))), p_session);
  v_bid   uuid;
  v_month date := date_trunc('month', p_month)::date;
  v_note  text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_last  app_private.landlord_settlement_closes%ROWTYPE;
  v_at    timestamptz;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Phiên đăng nhập đã hết — nhập lại mã PIN' USING ERRCODE = 'P0002';
  END IF;
  SELECT t.building_id INTO v_bid FROM app_private.landlord_portal_buildings_v1(v_slug) t WHERE t.ma = p_building;
  IF v_bid IS NULL THEN
    RAISE EXCEPTION 'Toà này không còn trong link — tải lại trang' USING ERRCODE = 'P0002';
  END IF;
  IF v_month IS NULL OR p_revision IS NULL THEN
    RAISE EXCEPTION 'Thiếu tháng hoặc lần chốt cần xác nhận' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'Ghi chú tối đa 500 ký tự' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('landlord_settlement:' || v_bid::text, 0));

  SELECT * INTO v_last
    FROM app_private.landlord_settlement_closes c
   WHERE c.building_id = v_bid AND c.period_month = v_month
   ORDER BY c.revision DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tháng % chưa chốt — xác nhận sau khi bên quản lý chốt tháng', to_char(v_month, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;
  IF v_last.revision <> p_revision THEN
    RAISE EXCEPTION 'Bên quản lý vừa mở chốt hoặc chốt lại tháng % — tải lại trang để xem số mới rồi xác nhận',
      to_char(v_month, 'MM/YYYY') USING ERRCODE = '40001';
  END IF;
  IF v_last.action <> 'CLOSE' THEN
    RAISE EXCEPTION 'Tháng % chưa chốt — xác nhận sau khi bên quản lý chốt tháng', to_char(v_month, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app_private.landlord_settlement_confirmations
    (organization_id, building_id, period_month, close_revision, note, share_token, portal_user_id)
  VALUES (v_last.organization_id, v_bid, v_month, v_last.revision, v_note, NULL, v_user)
  ON CONFLICT (building_id, period_month, close_revision) DO NOTHING
  RETURNING confirmed_at INTO v_at;
  IF v_at IS NULL THEN
    SELECT k.confirmed_at INTO v_at
      FROM app_private.landlord_settlement_confirmations k
     WHERE k.building_id = v_bid AND k.period_month = v_month AND k.close_revision = v_last.revision;
    RETURN jsonb_build_object('status', 'ALREADY_CONFIRMED', 'confirmed_at', v_at);
  END IF;
  RETURN jsonb_build_object('status', 'CONFIRMED', 'confirmed_at', v_at);
END
$fn$;

-- Thoát: huỷ phiên này.
CREATE OR REPLACE FUNCTION public.landlord_portal_logout_v1(p_slug text, p_session text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  IF p_session ~ '^[A-Za-z0-9_-]{43}$' THEN
    UPDATE app_private.landlord_portal_sessions s
       SET revoked_at = clock_timestamp()
     WHERE s.token_hash = encode(sha256(convert_to(p_session, 'UTF8')), 'hex')
       AND s.revoked_at IS NULL
       AND s.user_id IN (SELECT u.id FROM app_private.landlord_portal_users u
                          WHERE u.portal_slug = lower(btrim(COALESCE(p_slug, ''))));
  END IF;
  RETURN jsonb_build_object('status', 'LOGGED_OUT');
END
$fn$;

-- ---------------------------------------------------------------------------
-- 4. RPC quản trị (chủ công ty của tổ chức sở hữu link / super admin).

-- Các link mà người gọi quản lý + người xem (không trả PIN).
CREATE OR REPLACE FUNCTION public.landlord_portals_v1()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('portals', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'slug', p.slug,
             'building_ids', to_jsonb(p.building_ids),
             'updated_at', p.updated_at,
             -- lần nhập PIN sai gần đây và link có đang khoá không (cùng ngưỡng với landlord_portal_login_v1)
             'failures_24h', sai.ngay,
             'locked', sai.phut >= 10 OR sai.ngay >= 30,
             'viewers', COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                        'id', u.id, 'label', u.label, 'created_at', u.created_at,
                        'last_login_at', u.last_login_at, 'revoked_at', u.revoked_at)
                        ORDER BY (u.revoked_at IS NOT NULL), u.created_at)
                 FROM app_private.landlord_portal_users u WHERE u.portal_slug = p.slug), '[]'::jsonb))
             ORDER BY p.slug)
      FROM app_private.landlord_portals p
     CROSS JOIN LATERAL (
       SELECT (count(*) FILTER (WHERE f.failed_at > now() - interval '15 minutes'))::integer AS phut,
              count(*)::integer AS ngay
         FROM app_private.landlord_portal_login_failures f
        WHERE f.portal_slug = p.slug AND f.failed_at > now() - interval '24 hours') sai
     WHERE public.is_super_admin() OR app_private.ie_actor_is_company_owner_v1(p.organization_id, v_actor)), '[]'::jsonb));
END
$fn$;

-- Gộp toà vào link (tạo link nếu chưa có). Mọi toà phải là toà vận hành người gọi quản lý, cùng một tổ chức.
CREATE OR REPLACE FUNCTION public.landlord_portal_save_v1(p_slug text, p_building_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_slug  text := lower(btrim(COALESCE(p_slug, '')));
  v_ids   uuid[];
  v_orgs  uuid[];
  v_org   uuid;
  v_cur   app_private.landlord_portals%ROWTYPE;
  v_id    uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành' USING ERRCODE = '42501';
  END IF;
  IF v_slug !~ '^[a-z][a-z0-9-]{1,29}$' THEN
    RAISE EXCEPTION 'Tên link không hợp lệ' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT x), '{}'::uuid[]) INTO v_ids FROM unnest(COALESCE(p_building_ids, '{}'::uuid[])) AS x WHERE x IS NOT NULL;
  IF cardinality(v_ids) > 50 THEN
    RAISE EXCEPTION 'Tối đa 50 toà trong một link' USING ERRCODE = '22023';
  END IF;
  FOREACH v_id IN ARRAY v_ids LOOP
    IF NOT app_private.landlord_actor_can_manage_v1(v_id)
       OR NOT EXISTS (SELECT 1 FROM app_private.landlord_operations o WHERE o.building_id = v_id) THEN
      RAISE EXCEPTION 'Chỉ gộp được toà vận hành cho chủ nhà mà bạn quản lý' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  SELECT COALESCE(array_agg(DISTINCT b.organization_id), '{}'::uuid[]) INTO v_orgs
    FROM public.buildings b WHERE b.id = ANY (v_ids);
  IF cardinality(v_orgs) > 1 THEN
    RAISE EXCEPTION 'Các toà trong một link phải cùng một công ty' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('landlord_portal:' || v_slug, 0));
  SELECT * INTO v_cur FROM app_private.landlord_portals p WHERE p.slug = v_slug FOR UPDATE;
  IF FOUND THEN
    IF NOT (public.is_super_admin() OR app_private.ie_actor_is_company_owner_v1(v_cur.organization_id, v_actor)) THEN
      RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành' USING ERRCODE = '42501';
    END IF;
    IF cardinality(v_orgs) = 1 AND v_orgs[1] <> v_cur.organization_id THEN
      RAISE EXCEPTION 'Link này thuộc công ty khác' USING ERRCODE = '42501';
    END IF;
    UPDATE app_private.landlord_portals p
       SET building_ids = v_ids, updated_by = v_actor, updated_at = clock_timestamp()
     WHERE p.slug = v_slug;
  ELSE
    -- tạo link MỚI chỉ quản trị hệ thống (review chéo: chủ công ty khác tạo trước thì chiếm luôn tên miền agiang/cgiang)
    IF NOT public.is_super_admin() THEN
      RAISE EXCEPTION 'Chỉ quản trị hệ thống tạo được link tên miền mới' USING ERRCODE = '42501';
    END IF;
    IF cardinality(v_orgs) = 0 THEN
      RAISE EXCEPTION 'Chọn ít nhất một toà cho link' USING ERRCODE = '22023';
    END IF;
    v_org := v_orgs[1];
    INSERT INTO app_private.landlord_portals (slug, organization_id, building_ids, created_by, updated_by)
    VALUES (v_slug, v_org, v_ids, v_actor, v_actor);
  END IF;
  RETURN jsonb_build_object('slug', v_slug, 'building_ids', to_jsonb(v_ids));
END
$fn$;

-- Thêm người xem: tên do quản lý nhập, PIN 6 số LUÔN do server sinh (review chéo: PIN tự chọn kiểu 123123, ngày sinh
-- bị dò hết trong vài ngày). PIN không trùng BẤT KỲ người xem nào của link, kể cả đã thu hồi (cấp lại PIN cũ thì người
-- bị thu hồi vào được dưới tên người mới); không lặp một số / dãy liên tiếp. Tối đa 10 người xem còn hiệu lực mỗi link
-- (mỗi PIN thêm làm tăng xác suất dò trúng). Trả PIN đúng MỘT lần để quản lý gửi cho người xem.
CREATE OR REPLACE FUNCTION public.landlord_portal_viewer_add_v1(p_slug text, p_label text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_slug  text := lower(btrim(COALESCE(p_slug, '')));
  v_label text := btrim(COALESCE(p_label, ''));
  v_pin   text;
  v_org   uuid;
  v_id    uuid;
  v_try   integer := 0;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành' USING ERRCODE = '42501';
  END IF;
  SELECT p.organization_id INTO v_org FROM app_private.landlord_portals p WHERE p.slug = v_slug;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Link chưa có — gộp toà vào link trước' USING ERRCODE = 'P0002';
  END IF;
  IF NOT (public.is_super_admin() OR app_private.ie_actor_is_company_owner_v1(v_org, v_actor)) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành' USING ERRCODE = '42501';
  END IF;
  IF length(v_label) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'Nhập tên người xem (tối đa 60 ký tự)' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('landlord_portal:' || v_slug, 0));

  IF (SELECT count(*) FROM app_private.landlord_portal_users u WHERE u.portal_slug = v_slug AND u.revoked_at IS NULL) >= 10 THEN
    RAISE EXCEPTION 'Mỗi link tối đa 10 người xem — thu hồi người không còn dùng trước' USING ERRCODE = '22023';
  END IF;

  LOOP
    v_try := v_try + 1;
    v_pin := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000))::text, 6, '0');
    EXIT WHEN NOT (v_pin ~ '^([0-9])\1{5}$' OR position(v_pin IN '0123456789') > 0 OR position(v_pin IN '9876543210') > 0)
      AND NOT EXISTS (SELECT 1 FROM app_private.landlord_portal_users u
                       WHERE u.portal_slug = v_slug AND u.pin_hash = extensions.crypt(v_pin, u.pin_hash));
    IF v_try >= 20 THEN
      RAISE EXCEPTION 'Chưa sinh được PIN — thử lại' USING ERRCODE = '55000';
    END IF;
  END LOOP;

  INSERT INTO app_private.landlord_portal_users (portal_slug, label, pin_hash, created_by)
  VALUES (v_slug, v_label, extensions.crypt(v_pin, extensions.gen_salt('bf', 8)), v_actor)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'label', v_label, 'pin', v_pin);
END
$fn$;

-- Mở khoá link (xoá lần nhập PIN sai) — khi người lạ cố dò làm link khoá, chủ nhà thật không vào được.
CREATE OR REPLACE FUNCTION public.landlord_portal_unlock_v1(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_slug  text := lower(btrim(COALESCE(p_slug, '')));
  v_org   uuid;
  v_n     integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành' USING ERRCODE = '42501';
  END IF;
  SELECT p.organization_id INTO v_org FROM app_private.landlord_portals p WHERE p.slug = v_slug;
  IF v_org IS NULL OR NOT (public.is_super_admin() OR app_private.ie_actor_is_company_owner_v1(v_org, v_actor)) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('landlord_portal_login:' || v_slug, 0));
  DELETE FROM app_private.landlord_portal_login_failures f WHERE f.portal_slug = v_slug;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('status', 'UNLOCKED', 'cleared', v_n);
END
$fn$;

-- Thu hồi người xem: PIN hết hiệu lực, mọi phiên đang mở của người đó thoát.
CREATE OR REPLACE FUNCTION public.landlord_portal_viewer_revoke_v1(p_viewer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành' USING ERRCODE = '42501';
  END IF;
  SELECT p.organization_id INTO v_org
    FROM app_private.landlord_portal_users u
    JOIN app_private.landlord_portals p ON p.slug = u.portal_slug
   WHERE u.id = p_viewer_id;
  IF v_org IS NULL OR NOT (public.is_super_admin() OR app_private.ie_actor_is_company_owner_v1(v_org, v_actor)) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành' USING ERRCODE = '42501';
  END IF;
  UPDATE app_private.landlord_portal_users u
     SET revoked_at = clock_timestamp(), revoked_by = v_actor
   WHERE u.id = p_viewer_id AND u.revoked_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'ALREADY_REVOKED');
  END IF;
  UPDATE app_private.landlord_portal_sessions s SET revoked_at = clock_timestamp()
   WHERE s.user_id = p_viewer_id AND s.revoked_at IS NULL;
  RETURN jsonb_build_object('status', 'REVOKED');
END
$fn$;

REVOKE ALL ON FUNCTION public.landlord_portal_login_v1(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.landlord_portal_v1(text, text, text, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.landlord_portal_confirm_v1(text, text, text, date, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.landlord_portal_logout_v1(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.landlord_portals_v1() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_portal_save_v1(text, uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_portal_viewer_add_v1(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_portal_unlock_v1(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_portal_viewer_revoke_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_portal_login_v1(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_portal_v1(text, text, text, date) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_portal_confirm_v1(text, text, text, date, integer, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_portal_logout_v1(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_portals_v1() TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_portal_save_v1(text, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_portal_viewer_add_v1(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_portal_unlock_v1(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_portal_viewer_revoke_v1(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Gói một tháng: thân production (20261024035114) + tên người xem đã xác nhận.
CREATE OR REPLACE FUNCTION app_private.landlord_settlement_month_payload_v1(
  p_building_id uuid,
  p_month       date,
  p_public      boolean
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO ''
AS $fn$
DECLARE
  v_cfg      app_private.landlord_operations%ROWTYPE;
  v_month    date := pg_catalog.date_trunc('month', p_month)::date;
  v_now      date := app_private.landlord_current_month_v1();
  v_name     text;
  v_live     jsonb;
  v_last     app_private.landlord_settlement_closes%ROWTYPE;
  v_has_last boolean;
  v_status   text;
  v_stmt     jsonb;
  v_blockers jsonb := '[]'::jsonb;
  v_closed   jsonb;
  v_note     text;
  v_note_at  timestamptz;
  v_confirm  jsonb;
BEGIN
  SELECT * INTO v_cfg FROM app_private.landlord_operations o WHERE o.building_id = p_building_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT b.name INTO v_name FROM public.buildings b WHERE b.id = p_building_id;

  IF v_month IS NULL OR v_month < v_cfg.effective_from OR v_month > v_now THEN
    RETURN pg_catalog.jsonb_build_object(
      'building_name', v_name,
      'landlord_name', v_cfg.landlord_name,
      'period_month', v_month,
      'status', 'NOT_APPLICABLE',
      'effective_from', v_cfg.effective_from,
      'is_current_month', false,
      'statement', NULL,
      'is_stale', false,
      'closed', NULL,
      'confirmation', NULL,
      'can_close', false,
      'close_blockers', '[]'::jsonb,
      'warnings', NULL,
      'kqkd_bridge', NULL,
      'room_data', NULL);
  END IF;

  v_live := app_private.landlord_settlement_compute_v1(p_building_id, v_month);
  SELECT * INTO v_last
    FROM app_private.landlord_settlement_closes c
   WHERE c.building_id = p_building_id AND c.period_month = v_month
   ORDER BY c.revision DESC
   LIMIT 1;
  v_has_last := FOUND;

  IF v_has_last AND v_last.action = 'CLOSE' THEN
    v_status := 'CLOSED';
    v_stmt := v_last.snapshot;
    -- ghi chú bàn giao hiện hành: bản sửa mới nhất của lần chốt này, chưa sửa thì ghi chú lúc chốt
    SELECT h.note, h.created_at INTO v_note, v_note_at
      FROM app_private.landlord_settlement_handovers h
     WHERE h.building_id = p_building_id AND h.period_month = v_month AND h.close_revision = v_last.revision
     ORDER BY h.created_at DESC, h.id DESC
     LIMIT 1;
    IF NOT FOUND THEN
      v_note := v_last.reason;
      v_note_at := NULL;
    END IF;
    v_closed := pg_catalog.jsonb_build_object(
      'revision', v_last.revision,
      'closed_at', v_last.created_at,
      'note', v_note,
      'note_updated_at', v_note_at,
      'closed_by_name', CASE WHEN p_public THEN NULL ELSE (
         SELECT COALESCE(NULLIF(pg_catalog.btrim(p.full_name), ''), p.email)
           FROM public.profiles p WHERE p.id = v_last.actor) END);
    -- 'by' = tên người xem đã xác nhận qua link tên miền (link /qt cũ: null)
    SELECT pg_catalog.jsonb_build_object('confirmed_at', k.confirmed_at, 'note', k.note, 'by', u.label) INTO v_confirm
      FROM app_private.landlord_settlement_confirmations k
      LEFT JOIN app_private.landlord_portal_users u ON u.id = k.portal_user_id
     WHERE k.building_id = p_building_id AND k.period_month = v_month AND k.close_revision = v_last.revision;
  ELSE
    v_status := 'OPEN';
    v_stmt := v_live;
    v_closed := NULL;
    v_confirm := NULL;
  END IF;

  IF v_status = 'OPEN' THEN
    v_blockers := app_private.landlord_close_blockers_v1(p_building_id, v_month, v_live);
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'building_name', v_name,
    'landlord_name', v_cfg.landlord_name,
    'period_month', v_month,
    'status', v_status,
    'effective_from', v_cfg.effective_from,
    'is_current_month', v_month = v_now,
    'statement', CASE WHEN p_public THEN app_private.landlord_strip_public_v1(v_stmt) ELSE v_stmt END,
    'live_hash', CASE WHEN p_public THEN NULL ELSE v_live->>'source_hash' END,
    -- điều khoản tháng đã chốt không sửa được (landlord_operation_upsert_v1 chặn) ⇒ lệch hash
    -- chỉ có thể do phiếu đổi sau khi chốt
    'is_stale', v_status = 'CLOSED' AND v_last.source_hash IS DISTINCT FROM (v_live->>'source_hash'),
    'closed', v_closed,
    'confirmation', v_confirm,
    -- dữ liệu thô cho ghi chú phòng (phòng chưa đóng / trống) — sống, không vào ảnh chốt
    'room_data', app_private.landlord_room_data_v1(p_building_id, v_month, p_public),
    'can_close', NOT p_public AND v_status = 'OPEN' AND pg_catalog.jsonb_array_length(v_blockers) = 0,
    'close_blockers', CASE WHEN p_public THEN '[]'::jsonb ELSE v_blockers END,
    'warnings', CASE WHEN p_public THEN NULL ELSE pg_catalog.jsonb_build_object(
       'missing_fixed_expenses', app_private.landlord_missing_fixed_v1(p_building_id, v_month),
       'related_elsewhere', app_private.landlord_related_elsewhere_v1(p_building_id, v_month),
       'landlord_account_elsewhere', app_private.landlord_account_elsewhere_v1(p_building_id, v_month),
       'pre_start_pending', CASE WHEN v_month = v_cfg.effective_from
                                 THEN app_private.landlord_pre_start_pending_v1(p_building_id) END,
       'pre_start_period', CASE WHEN v_month = v_cfg.effective_from
                                THEN app_private.landlord_pre_start_period_v1(p_building_id) END) END,
    'kqkd_bridge', CASE WHEN p_public THEN NULL
                        ELSE app_private.landlord_kqkd_bridge_v1(p_building_id, v_month, v_stmt,
                               v_status = 'CLOSED' AND v_last.source_hash IS DISTINCT FROM (v_live->>'source_hash')) END);
END
$fn$;

REVOKE ALL ON FUNCTION app_private.landlord_settlement_month_payload_v1(uuid, date, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Hậu kiểm.
DO $sau$
DECLARE
  v_sig text;
BEGIN
  IF to_regclass('app_private.landlord_portals') IS NULL OR to_regclass('app_private.landlord_portal_users') IS NULL
     OR to_regclass('app_private.landlord_portal_sessions') IS NULL
     OR to_regclass('app_private.landlord_portal_login_failures') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng link tên miền' USING ERRCODE = 'XX000';
  END IF;
  FOREACH v_sig IN ARRAY ARRAY['public.landlord_portals_v1()', 'public.landlord_portal_save_v1(text,uuid[])',
                               'public.landlord_portal_viewer_add_v1(text,text)', 'public.landlord_portal_viewer_revoke_v1(uuid)',
                               'public.landlord_portal_unlock_v1(text)']
  LOOP
    IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon gọi được %', v_sig USING ERRCODE = 'XX000';
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'app_private.landlord_portal_users', 'SELECT') THEN
    RAISE EXCEPTION 'anon đọc được bảng người xem' USING ERRCODE = 'XX000';
  END IF;
END
$sau$;

COMMIT;
NOTIFY pgrst, 'reload schema';
