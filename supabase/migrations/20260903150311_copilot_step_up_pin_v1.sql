-- G5-A — ĐIỂM NỐI #3: STEP-UP PIN 4 SỐ.
--
-- G3 (`20260903100253`) đã đặt sẵn khe cho lớp xác thực thứ hai: cột
-- `copilot_plans.step_up_confirmation_id`, tham số
-- `copilot_plan_approve_v1(..., p_step_up_token text DEFAULT NULL)`, và hai
-- nhánh chờ sẵn — thiếu token trên kế hoạch L5 thì `step_up_required`; có token
-- thì RAISE `step_up_not_implemented` (0A000), một cách nói thẳng "chưa ai xây
-- cái này". Migration này xây thân thật, KHÔNG đổi chữ ký bất cứ hàm nào.
--
-- BỐN QUYẾT ĐỊNH ĐÁNG ĐỌC TRƯỚC KHI SỬA FILE NÀY
--
--   1. PIN LÀ CỦA NGƯỜI DÙNG, KHÔNG CỦA TỔ CHỨC. `app_private.copilot_step_up_
--      pins` khoá theo `user_id`, không có cột `organization_id`. Một người
--      quản lý nhiều công ty chỉ nhớ MỘT mã PIN. Hệ quả: hai sự kiện sổ sinh ra
--      từ `copilot_step_up_set_pin_v1`/`copilot_step_up_unlock_v1` (đặt PIN, mở
--      khoá) không có tổ chức nào để gắn — `copilot_action_ledger_org_required`
--      và `copilot_ledger_append_v1` được nới thêm hai sự kiện này vào đúng
--      ngoại lệ đã dành cho `policy_changed`. Ngược lại `copilot_step_up_verify_
--      v1` NHẬN `p_organization_id` (token phát ra chỉ dùng được cho một kế
--      hoạch của MỘT tổ chức — xem quyết định 3), nên `step_up_verified` và
--      `step_up_locked` VẪN mang tổ chức bình thường, không cần ngoại lệ.
--
--   2. BĂM BẰNG BCRYPT, KHÔNG BAO GIỜ LOG PIN THÔ. `extensions.crypt(p_pin,
--      extensions.gen_salt('bf', 10))` — cùng schema `extensions` mà
--      `20260814034500` đã dùng cho `digest`/`gen_random_bytes`. Không một
--      nhánh RAISE nào trong file này được nội suy `p_pin`/`p_current_pin` vào
--      thông điệp lỗi: Postgres ghi log RAISE EXCEPTION, và một PIN lọt vào đó
--      là một PIN lọt vào log server. Test đột biến ở
--      `copilotStepUpPinMigration.test.ts` ghim đúng điều này bằng regex.
--
--   3. TOKEN STEP-UP TÁI SỬ DỤNG BẢNG NONCE SẴN CÓ, KHÔNG BẢNG MỚI.
--      `app_private.copilot_write_confirmations` (từ `20260814034500`) đã có
--      đúng hình dạng cần: digest-only, TTL, dùng-một-lần, CAS tiêu. Một hàng
--      `tool='step_up'`, `permission_key='copilot.step_up'`, `payload_hash =
--      copilot_payload_hash_v1(jsonb_build_object('org', p_organization_id))`
--      buộc token chỉ mở được cửa duyệt của ĐÚNG tổ chức đã xác thực — mang
--      token của công ty A sang duyệt kế hoạch công ty B thì `payload_hash`
--      lệch, và `copilot_plan_approve_v1` từ chối bằng đúng thông điệp
--      `step_up_required` như khi thiếu token, không tiết lộ token có tồn tại.
--
--   4. KHOÁ THEO CẤP SỐ NHÂN, GIẢM VỀ 0 KHI THÀNH CÔNG. 5 lần sai liên tiếp →
--      khoá `15 phút × 2^(lock_level cũ)` rồi tăng `lock_level`; một lần xác
--      thực ĐÚNG xoá `failed_attempts`/`locked_until` (không đụng `lock_level`
--      — lịch sử từng bị khoá không biến mất chỉ vì một lần đoán trúng). Mọi
--      nhánh SAI (kể cả nhánh vừa kích hoạt khoá) trả về CÙNG một thông điệp
--      `pin_invalid:<so_lan_con_lai>` — không có nhánh nào nói "PIN chưa từng
--      được đặt" khác với "PIN sai", vì cả hai đều chỉ chạy được sau khi hàng
--      PIN đã `FOUND`. Trường hợp hàng PIN không tồn tại là một mã KHÁC hẳn
--      (`pin_not_set`, chạy trước khi có gì để mà "sai") và trường hợp đang
--      khoá là một mã KHÁC nữa (`pin_locked:<so_giay_con_lai>`, chạy trước khi
--      so PIN) — ba tầng, ba mã, không lẫn vào nhau.
--
-- Idempotent: bảng IF NOT EXISTS, ràng buộc DO-guard, RPC CREATE OR REPLACE
-- cùng chữ ký, ACL tái cấp mỗi lượt.

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. TIỀN ĐỀ — pgcrypto phải có `crypt`/`gen_salt` trong `extensions`. Thiếu
--    thì mọi RPC dưới đây RAISE lúc gọi thay vì lúc migrate; kiểm NGAY để lỗi
--    hiện ra ở migration, không phải ở request đầu tiên của người dùng thật.
-- ---------------------------------------------------------------------------
DO $kiem_pgcrypto$
BEGIN
  IF to_regprocedure('extensions.crypt(text, text)') IS NULL
     OR to_regprocedure('extensions.gen_salt(text, integer)') IS NULL THEN
    RAISE EXCEPTION 'pgcrypto_missing: extensions.crypt/gen_salt khong ton tai — kiem lai extension pgcrypto';
  END IF;
END
$kiem_pgcrypto$;

-- ---------------------------------------------------------------------------
-- 1. BẢNG PIN — một hàng một người dùng.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_private.copilot_step_up_pins (
  user_id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Băm bcrypt, KHÔNG BAO GIỜ lưu PIN thô.
  pin_hash        text NOT NULL,
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  lock_level      int NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON app_private.copilot_step_up_pins FROM PUBLIC;
DO $thu_hoi_pins$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_step_up_pins FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_step_up_pins FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_step_up_pins FROM service_role;
  END IF;
END
$thu_hoi_pins$;

COMMENT ON TABLE app_private.copilot_step_up_pins IS
  'PIN step-up 4 so cua tung nguoi dung (khong theo to chuc). Chi luu bam bcrypt qua '
  'extensions.crypt/gen_salt. Duong ghi/doc hop le duy nhat la 4 RPC copilot_step_up_*_v1.';

-- ---------------------------------------------------------------------------
-- 2. SỔ — thêm bốn sự kiện step-up vào CHECK của `event`, nới ngoại lệ tổ chức
--    cho hai sự kiện không thuộc tổ chức nào (xem quyết định 1 ở đầu file).
-- ---------------------------------------------------------------------------
DO $mo_rong_event_ledger$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_action_ledger_event_check'
       AND conrelid = 'app_private.copilot_action_ledger'::regclass
       AND pg_get_constraintdef(oid) NOT LIKE '%step_up_pin_set%'
  ) THEN
    ALTER TABLE app_private.copilot_action_ledger
      DROP CONSTRAINT copilot_action_ledger_event_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_action_ledger_event_check'
       AND conrelid = 'app_private.copilot_action_ledger'::regclass
  ) THEN
    ALTER TABLE app_private.copilot_action_ledger
      ADD CONSTRAINT copilot_action_ledger_event_check
      CHECK (event IN (
        'plan_created', 'plan_approved', 'step_done', 'step_failed',
        'step_blocked', 'plan_cancelled', 'plan_expired',
        'action_executed', 'action_failed', 'policy_changed',
        'capability_changed', 'step_up_pin_set', 'step_up_verified',
        'step_up_locked', 'step_up_unlocked'));
  END IF;
END
$mo_rong_event_ledger$;

DO $mo_rong_org_required$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_action_ledger_org_required'
       AND conrelid = 'app_private.copilot_action_ledger'::regclass
       AND pg_get_constraintdef(oid) NOT LIKE '%step_up_pin_set%'
  ) THEN
    ALTER TABLE app_private.copilot_action_ledger
      DROP CONSTRAINT copilot_action_ledger_org_required;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_action_ledger_org_required'
       AND conrelid = 'app_private.copilot_action_ledger'::regclass
  ) THEN
    ALTER TABLE app_private.copilot_action_ledger
      ADD CONSTRAINT copilot_action_ledger_org_required
      CHECK (organization_id IS NOT NULL
             OR event IN ('policy_changed', 'step_up_pin_set', 'step_up_unlocked'));
  END IF;
END
$mo_rong_org_required$;

-- `copilot_ledger_append_v1` tự kiểm ngoại lệ tổ chức Ở TẦNG HÀM, TRƯỚC khi
-- chạm INSERT — CHECK ở bảng chỉ là hàng rào thứ hai. Không sửa dòng này thì
-- `step_up_pin_set`/`step_up_unlocked` không org sẽ chết ở `copilot_ledger_
-- organization_required` (22023) trước khi CHECK trên bảng kịp chạy.
CREATE OR REPLACE FUNCTION app_private.copilot_ledger_append_v1(p jsonb)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $ledger_append$
DECLARE
  v_id    uuid;
  v_uid   uuid := auth.uid();
  v_org   uuid := NULLIF(p ->> 'organization_id', '')::uuid;
  v_event text := NULLIF(p ->> 'event', '');
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'copilot_ledger_payload_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  -- `policy_changed` là van trần rủi ro toàn hệ thống; `step_up_pin_set`/
  -- `step_up_unlocked` là quản trị PIN của MỘT người dùng, không thuộc tổ chức
  -- nào (xem quyết định 1 ở đầu file `20260903150311`). Mọi sự kiện KHÁC vẫn
  -- bắt buộc có tổ chức — CHECK trên bảng canh vế còn lại.
  IF v_org IS NULL AND v_event NOT IN ('policy_changed', 'step_up_pin_set', 'step_up_unlocked') THEN
    RAISE EXCEPTION 'copilot_ledger_organization_required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO app_private.copilot_action_ledger (
    plan_id, step_no, plan_version, event, user_id, organization_id, action_id,
    permission_key, permission_snapshot, consent_id, consent_kind, step_up_id,
    grant_id, payload_digest, before_digest, after_digest, outcome, error_code,
    sqlstate, entity_table, entity_id, audit_id
  )
  VALUES (
    NULLIF(p ->> 'plan_id', '')::uuid,
    NULLIF(p ->> 'step_no', '')::int,
    NULLIF(p ->> 'plan_version', '')::int,
    v_event,
    v_uid,
    v_org,
    NULLIF(p ->> 'action_id', ''),
    NULLIF(p ->> 'permission_key', ''),
    COALESCE(p -> 'permission_snapshot', '{}'::jsonb),
    NULLIF(p ->> 'consent_id', '')::uuid,
    NULLIF(p ->> 'consent_kind', ''),
    NULLIF(p ->> 'step_up_id', '')::uuid,
    NULLIF(p ->> 'grant_id', '')::uuid,
    -- Digest đi vào dưới dạng hex để hàm gọi không phải tự dựng bytea trong jsonb.
    decode(NULLIF(p ->> 'payload_digest', ''), 'hex'),
    decode(NULLIF(p ->> 'before_digest', ''), 'hex'),
    decode(NULLIF(p ->> 'after_digest', ''), 'hex'),
    p -> 'outcome',
    NULLIF(p ->> 'error_code', ''),
    NULLIF(p ->> 'sqlstate', ''),
    NULLIF(p ->> 'entity_table', ''),
    NULLIF(p ->> 'entity_id', '')::uuid,
    NULLIF(p ->> 'audit_id', '')::uuid
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END
$ledger_append$;

REVOKE ALL ON FUNCTION app_private.copilot_ledger_append_v1(jsonb) FROM PUBLIC;
DO $thu_hoi_append$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_ledger_append_v1(jsonb) FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_ledger_append_v1(jsonb) FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_ledger_append_v1(jsonb) FROM service_role;
  END IF;
END
$thu_hoi_append$;

-- ---------------------------------------------------------------------------
-- 3. ĐẶT/ĐỔI PIN — chỉ super admin (v1). Client BẮT BUỘC re-auth bằng
--    `supabase.auth.signInWithPassword` NGAY TRƯỚC khi gọi — server KHÔNG kiểm
--    được điều đó (không có cách nào từ trong RPC biết phiên vừa được làm mới
--    bằng mật khẩu hay không), nên đây là một ranh giới CLIENT, ghi rõ ra để
--    không ai tưởng lầm nó được RPC này gác.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_step_up_set_pin_v1(
  p_pin         text,
  p_current_pin text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $f$
DECLARE
  v_actor uuid := auth.uid();
  v_row   app_private.copilot_step_up_pins%ROWTYPE;
  v_hash  text;
  v_now   timestamptz := clock_timestamp();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'step_up_superadmin_only' USING ERRCODE = '42501';
  END IF;
  IF p_pin IS NULL OR p_pin !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'pin_format' USING ERRCODE = '22023';
  END IF;
  -- Bốn số dễ đoán — cấm ở tầng server vì đây là lớp xác thực thứ hai của
  -- những hành động rủi ro cao nhất, không phải khoá màn hình điện thoại.
  IF p_pin = ANY (ARRAY[
    '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
    '1234', '4321', '2580', '0852'
  ]) THEN
    RAISE EXCEPTION 'pin_weak' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
    FROM app_private.copilot_step_up_pins
   WHERE user_id = v_actor
   FOR UPDATE;

  IF FOUND THEN
    IF v_row.locked_until IS NOT NULL AND v_row.locked_until > v_now THEN
      RAISE EXCEPTION 'pin_locked' USING ERRCODE = '42501';
    END IF;
    -- Đổi PIN đòi PIN CŨ khớp — không nội suy p_current_pin vào thông điệp.
    IF p_current_pin IS NULL
       OR extensions.crypt(p_current_pin, v_row.pin_hash) IS DISTINCT FROM v_row.pin_hash THEN
      RAISE EXCEPTION 'pin_invalid' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_hash := extensions.crypt(p_pin, extensions.gen_salt('bf', 10));

  INSERT INTO app_private.copilot_step_up_pins
    (user_id, pin_hash, failed_attempts, locked_until, lock_level, updated_at, created_at)
  VALUES
    (v_actor, v_hash, 0, NULL, 0, v_now, v_now)
  ON CONFLICT (user_id) DO UPDATE
     SET pin_hash        = EXCLUDED.pin_hash,
         failed_attempts = 0,
         locked_until    = NULL,
         lock_level      = 0,
         updated_at      = v_now;

  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',          'step_up_pin_set',
    'permission_key', 'copilot.step_up',
    'outcome',        jsonb_build_object('da_doi', FOUND)));

  RETURN jsonb_build_object('da_dat', true, 'updated_at', v_now);
END
$f$;

COMMENT ON FUNCTION public.copilot_step_up_set_pin_v1(text, text) IS
  'Dat/doi PIN step-up 4 so cua chinh nguoi goi. Chi super admin (v1). Client PHAI re-auth bang '
  'signInWithPassword truoc khi goi — server khong kiem duoc dieu do, day la ranh gioi CLIENT.';

REVOKE ALL ON FUNCTION public.copilot_step_up_set_pin_v1(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.copilot_step_up_set_pin_v1(text, text) TO authenticated;
DO $thu_hoi_set_pin$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_step_up_set_pin_v1(text, text) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_step_up_set_pin_v1(text, text) FROM service_role;
  END IF;
END
$thu_hoi_set_pin$;

-- ---------------------------------------------------------------------------
-- 4. XÁC THỰC PIN → PHÁT TOKEN. Token hex64, dùng-một-lần, TTL 5 phút, chỉ mở
--    cửa duyệt của ĐÚNG tổ chức đã xác thực (xem quyết định 3 ở đầu file).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_step_up_verify_v1(
  p_pin              text,
  p_organization_id  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $f$
DECLARE
  v_actor uuid := auth.uid();
  v_now   timestamptz := clock_timestamp();
  v_row   app_private.copilot_step_up_pins%ROWTYPE;
  v_token bytea;
  v_han   timestamptz;
  v_left  int;
  v_giay  int;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  -- Khuôn của `copilot_org_scope_buildings_v1` (20260829090000): tổ chức phải
  -- tồn tại và ACTIVE trước khi hỏi bất cứ điều gì khác.
  IF p_organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = p_organization_id AND o.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;
  -- Thành viên ACTIVE của tổ chức, hoặc super admin. Cùng khuôn membership mà
  -- `copilot_org_scope_buildings_v1` dùng.
  IF NOT public.is_super_admin() AND NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
     WHERE m.organization_id = p_organization_id
       AND m.user_id = v_actor
       AND m.status = 'ACTIVE'
       AND m.revoked_at IS NULL
       AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= v_now
       AND (m.valid_to IS NULL OR m.valid_to > v_now)
  ) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
    FROM app_private.copilot_step_up_pins
   WHERE user_id = v_actor
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pin_not_set' USING ERRCODE = '42501';
  END IF;

  IF v_row.locked_until IS NOT NULL AND v_row.locked_until > v_now THEN
    v_giay := GREATEST(1, ceil(extract(epoch FROM (v_row.locked_until - v_now)))::int);
    RAISE EXCEPTION 'pin_locked:%', v_giay USING ERRCODE = '42501';
  END IF;

  -- SO PIN. Không nội suy p_pin vào bất kỳ thông điệp nào — kể cả nhánh lỗi.
  IF p_pin IS NULL OR p_pin !~ '^[0-9]{4}$'
     OR extensions.crypt(p_pin, v_row.pin_hash) IS DISTINCT FROM v_row.pin_hash THEN
    IF v_row.failed_attempts + 1 >= 5 THEN
      -- Chạm trần: khoá, tăng lock_level, ghi sổ — VẪN trả cùng thông điệp
      -- pin_invalid như mọi nhánh sai khác (số lần còn lại = 0).
      UPDATE app_private.copilot_step_up_pins
         SET failed_attempts = 0,
             lock_level      = v_row.lock_level + 1,
             locked_until    = v_now + (interval '15 minutes'
                                * power(2::float8, v_row.lock_level::float8)),
             updated_at      = v_now
       WHERE user_id = v_actor;

      PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
        'event',           'step_up_locked',
        'organization_id', p_organization_id,
        'permission_key',  'copilot.step_up',
        'outcome',         jsonb_build_object('lock_level', v_row.lock_level + 1)));

      RAISE EXCEPTION 'pin_invalid:0' USING ERRCODE = '42501';
    END IF;

    UPDATE app_private.copilot_step_up_pins
       SET failed_attempts = failed_attempts + 1,
           updated_at      = v_now
     WHERE user_id = v_actor;
    v_left := GREATEST(0, 5 - (v_row.failed_attempts + 1));
    RAISE EXCEPTION 'pin_invalid:%', v_left USING ERRCODE = '42501';
  END IF;

  -- ĐÚNG. Reset bộ đếm/khoá — KHÔNG reset lock_level: lịch sử từng bị khoá
  -- không biến mất chỉ vì một lần đoán trúng sau đó.
  UPDATE app_private.copilot_step_up_pins
     SET failed_attempts = 0, locked_until = NULL, updated_at = v_now
   WHERE user_id = v_actor;

  v_token := extensions.gen_random_bytes(32);
  v_han := v_now + interval '5 minutes';

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash, permission_key, expires_at)
  VALUES (
    extensions.digest(v_token, 'sha256'),
    v_actor,
    p_organization_id,
    'step_up',
    app_private.copilot_payload_hash_v1(jsonb_build_object('org', p_organization_id)),
    'copilot.step_up',
    v_han
  );

  -- Sổ KHÔNG mang PIN/token — chỉ mang việc "đã xác thực xong".
  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',           'step_up_verified',
    'organization_id', p_organization_id,
    'permission_key',  'copilot.step_up'));

  RETURN jsonb_build_object(
    'step_up_token', encode(v_token, 'hex'),
    'expires_at',    v_han
  );
END
$f$;

COMMENT ON FUNCTION public.copilot_step_up_verify_v1(text, uuid) IS
  'Xac thuc PIN step-up, phat token hex64 dung-mot-lan TTL 5 phut rang buoc vao MOT to chuc qua '
  'payload_hash. 5 lan sai lien tiep khoa 15p x 2^(lock_level cu). Moi nhanh sai tra cung thong diep '
  'pin_invalid:<so_lan_con_lai> — khong phan biet ly do sai.';

REVOKE ALL ON FUNCTION public.copilot_step_up_verify_v1(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.copilot_step_up_verify_v1(text, uuid) TO authenticated;
DO $thu_hoi_verify$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_step_up_verify_v1(text, uuid) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_step_up_verify_v1(text, uuid) FROM service_role;
  END IF;
END
$thu_hoi_verify$;

-- ---------------------------------------------------------------------------
-- 5. ĐỌC TRẠNG THÁI — chỉ chính chủ, không tham số.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_step_up_status_v1()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $f$
DECLARE
  v_actor uuid := auth.uid();
  v_row   app_private.copilot_step_up_pins%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_row FROM app_private.copilot_step_up_pins WHERE user_id = v_actor;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('da_dat', false, 'locked_until', NULL, 'failed_attempts', 0);
  END IF;

  RETURN jsonb_build_object(
    'da_dat',          true,
    'locked_until',    v_row.locked_until,
    'failed_attempts', v_row.failed_attempts
  );
END
$f$;

COMMENT ON FUNCTION public.copilot_step_up_status_v1() IS
  'Trang thai PIN step-up cua CHINH nguoi goi — khong tham so, khong doc duoc cua nguoi khac.';

REVOKE ALL ON FUNCTION public.copilot_step_up_status_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.copilot_step_up_status_v1() TO authenticated;
DO $thu_hoi_status$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_step_up_status_v1() FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_step_up_status_v1() FROM service_role;
  END IF;
END
$thu_hoi_status$;

-- ---------------------------------------------------------------------------
-- 6. MỞ KHOÁ — super admin, cần lý do.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_step_up_unlock_v1(
  p_user_id uuid,
  p_reason  text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $f$
DECLARE
  v_actor uuid := auth.uid();
  v_now   timestamptz := clock_timestamp();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'step_up_superadmin_only' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_required' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023';
  END IF;

  UPDATE app_private.copilot_step_up_pins
     SET failed_attempts = 0, locked_until = NULL, updated_at = v_now
   WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pin_not_set' USING ERRCODE = '42501';
  END IF;

  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',          'step_up_unlocked',
    'permission_key', 'copilot.step_up',
    'outcome',        jsonb_build_object('target_user_id', p_user_id, 'reason', p_reason)));

  RETURN jsonb_build_object('da_mo_khoa', true, 'user_id', p_user_id);
END
$f$;

COMMENT ON FUNCTION public.copilot_step_up_unlock_v1(uuid, text) IS
  'Mo khoa PIN step-up cua MOT nguoi dung khac. Chi super admin, bat buoc ly do >= 3 ky tu, ghi so '
  'step_up_unlocked.';

REVOKE ALL ON FUNCTION public.copilot_step_up_unlock_v1(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.copilot_step_up_unlock_v1(uuid, text) TO authenticated;
DO $thu_hoi_unlock$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_step_up_unlock_v1(uuid, text) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_step_up_unlock_v1(uuid, text) FROM service_role;
  END IF;
END
$thu_hoi_unlock$;

-- ---------------------------------------------------------------------------
-- 7. `copilot_plan_approve_v1` — thay THÂN của nhánh step-up, GIỮ NGUYÊN chữ
--    ký. Toàn bộ phần còn lại chép nguyên từ bản đang chạy trên production
--    (đọc qua Management API ngay trước khi viết file này), chỉ hai chỗ đổi:
--
--      a) Nhánh `p_step_up_token IS NOT NULL` — từ RAISE 0A000 thành xác thực
--         + tiêu token thật (mục 7a dưới).
--      b) Hai chỗ log `step_up_id` từng đọc `v_plan.step_up_confirmation_id`
--         (cột CŨ trên hàng kế hoạch, luôn NULL ở lần duyệt đầu) nay đọc
--         `v_step_up_id` (biến cục bộ — id CỦA CHÍNH lần duyệt này, nếu có).
--         Đọc cột cũ ở đây là một chỗ log-sai-âm-thầm: sổ sẽ ghi step_up_id
--         rỗng ngay cả khi request vừa tiêu một token thật.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_plan_approve_v1(p_plan_id uuid, p_consent_nonce text, p_plan_digest text, p_expected_plan_version integer, p_step_up_token text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private', 'extensions'
AS $function$
DECLARE
  v_actor      uuid := auth.uid();
  v_conf       app_private.copilot_write_confirmations%ROWTYPE;
  v_plan       app_private.copilot_plans%ROWTYPE;
  v_reg        app_private.copilot_action_registry%ROWTYPE;
  v_step       app_private.copilot_plan_steps%ROWTYPE;
  v_max_direct text;
  v_policy_rev bigint;
  v_ly_do      text := NULL;
  v_chi_tiet   text := NULL;
  v_buoc_hong  int := NULL;
  v_version    int;
  v_han        timestamptz;
  -- G5-A: hàng token step-up (nếu client trình) và id của nó sau khi tiêu.
  v_step_up    app_private.copilot_write_confirmations%ROWTYPE;
  v_step_up_id uuid := NULL;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- Hình sai thì không cần chạm bảng nonce: một lời gọi không có nonce thật
  -- không được phép soi cả bảng đó.
  IF p_consent_nonce IS NULL OR p_consent_nonce !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'confirmation_required' USING ERRCODE = '42501';
  END IF;
  IF p_plan_digest IS NULL OR p_plan_digest !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'plan_digest_mismatch' USING ERRCODE = '22023';
  END IF;

  -- Khoá hàng nonce ngay từ đầu: hai lần bấm song song phải có đúng một lần thắng.
  SELECT * INTO v_conf
    FROM app_private.copilot_write_confirmations c
   WHERE c.nonce_digest = extensions.digest(decode(p_consent_nonce, 'hex'), 'sha256')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  -- Nonce của người khác trả về cùng một câu với "không tìm thấy" — trả lời khác
  -- đi là xác nhận giúp kẻ gọi rằng nonce đó có thật.
  IF v_conf.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_conf.tool IS DISTINCT FROM 'lap_ke_hoach'
     OR v_conf.permission_key IS DISTINCT FROM 'copilot.execution_plan' THEN
    RAISE EXCEPTION 'confirmation_contract_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_conf.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;

  BEGIN
    SELECT * INTO v_plan
      FROM app_private.copilot_plans p
     WHERE p.id = p_plan_id AND p.user_id = v_actor
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    -- Hai tab. Không chờ: một trong hai đang ở giữa một chuỗi ghi tiền.
    RAISE EXCEPTION 'plan_busy' USING ERRCODE = '55P03';
  END;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_plan.organization_id IS DISTINCT FROM v_conf.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;
  -- Ba vế phải trùng nhau: vân tay lưu trong kế hoạch, `payload_hash` của hàng
  -- nonce, và chuỗi giao diện echo lại. Lệch một vế nghĩa là thứ người dùng nhìn
  -- thấy không phải thứ sắp chạy.
  IF v_plan.plan_digest IS DISTINCT FROM decode(p_plan_digest, 'hex')
     OR v_conf.payload_hash IS DISTINCT FROM v_plan.plan_digest THEN
    RAISE EXCEPTION 'plan_digest_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_plan.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'plan_not_draft: dang o %', v_plan.status USING ERRCODE = '22023';
  END IF;
  IF p_expected_plan_version IS NULL OR v_plan.version <> p_expected_plan_version THEN
    RAISE EXCEPTION 'plan_version_stale: dang o %, nguoi goi mong %',
      v_plan.version, p_expected_plan_version
      USING ERRCODE = '40001';
  END IF;

  -- QUÁ HẠN. Ghi trạng thái rồi TRẢ VỀ, không RAISE — xem quyết định 4 ở đầu file.
  IF v_plan.expires_at <= clock_timestamp() THEN
    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED', error_code = 'plan_expired'
     WHERE plan_id = v_plan.id AND status = 'PENDING';
    UPDATE app_private.copilot_plans
       SET status = 'EXPIRED', version = version + 1,
           failure_reason = 'plan_expired', updated_at = clock_timestamp()
     WHERE id = v_plan.id
    RETURNING version INTO v_version;
    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'plan_expired',
      'organization_id', v_plan.organization_id,
      'plan_id',         v_plan.id,
      'plan_version',    v_version,
      'permission_key',  'copilot.execution_plan',
      'consent_id',      v_plan.consent_confirmation_id,
      'consent_kind',    v_plan.consent_kind,
      'step_up_id',      v_plan.step_up_confirmation_id,
      'error_code',      'plan_expired',
      'outcome',         jsonb_build_object('giai_doan', 'approve')));
    RETURN jsonb_build_object(
      'ok',               false,
      'error_code',       'plan_expired',
      'plan_id',          v_plan.id,
      'plan_version',     v_version,
      'plan_status',      'EXPIRED',
      'execute_deadline', NULL);
  END IF;

  -- Đổi thứ tự: quá hạn của KẾ HOẠCH được kiểm TRƯỚC quá hạn của
  -- CONFIRMATION, để nhánh ghi-rồi-RETURN plan_expired phía trên với tới được.
  -- Trước đợt này cửa nonce (bên trên, cùng khối duyệt) luôn đứng trước cửa kế
  -- hoạch nên plan_expired là mã chết — vì thời điểm tạo gán CÙNG một hạn cho cả
  -- hai hàng. Xem G3-FIX brief mục 1 + task-G3-E2E-report.md §6.
  IF v_conf.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'confirmation_expired' USING ERRCODE = '42501';
  END IF;

  SELECT max_direct_risk, revision INTO v_max_direct, v_policy_rev
    FROM app_private.copilot_action_policy WHERE id;
  -- Thiếu hàng policy KHÔNG được rơi vào im lặng: `v_max_direct` NULL làm điều
  -- kiện step-up ngay dưới lặng lẽ sai, và phép so trần rủi ro trong vòng lặp
  -- cũng thành vô nghĩa. Van trần rủi ro mà biến mất thì đóng cửa, đừng đoán.
  IF v_max_direct IS NULL OR v_policy_rev IS NULL THEN
    RAISE EXCEPTION 'copilot_policy_missing' USING ERRCODE = 'P0002';
  END IF;

  -- ĐIỂM NỐI #3 — step-up PIN (G5-A). Kế hoạch L5 dưới trần L5 mà không có
  -- token → từ chối ngay, không chạm bảng token.
  IF v_plan.max_risk = 'L5' AND v_max_direct = 'L5' AND p_step_up_token IS NULL THEN
    RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
  END IF;
  IF p_step_up_token IS NOT NULL THEN
    -- Hình sai thì không soi bảng — cùng kỷ luật với nonce cấp kế hoạch ở trên.
    IF p_step_up_token !~ '^[0-9a-fA-F]{64}$' THEN
      RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_step_up
      FROM app_private.copilot_write_confirmations c
     WHERE c.nonce_digest = extensions.digest(decode(p_step_up_token, 'hex'), 'sha256')
     FOR UPDATE;

    -- Mọi nhánh sai của token đều trả CÙNG một mã `step_up_required` — token
    -- của người khác, sai tool/permission_key, đã tiêu, hết hạn, hay lệch tổ
    -- chức đều là "chưa xác thực hợp lệ" dưới góc nhìn của người gọi; phân biệt
    -- ra sẽ xác nhận giúp kẻ tấn công token nào "gần đúng".
    IF NOT FOUND
       OR v_step_up.user_id IS DISTINCT FROM v_actor
       OR v_step_up.tool IS DISTINCT FROM 'step_up'
       OR v_step_up.permission_key IS DISTINCT FROM 'copilot.step_up'
       OR v_step_up.consumed_at IS NOT NULL
       OR v_step_up.expires_at <= clock_timestamp()
       OR v_step_up.organization_id IS DISTINCT FROM v_plan.organization_id
       OR v_step_up.payload_hash IS DISTINCT FROM app_private.copilot_payload_hash_v1(
            jsonb_build_object('org', v_plan.organization_id)) THEN
      RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
    END IF;

    -- CAS TIÊU TOKEN. Cùng kỷ luật với nonce cấp kế hoạch: đặt điều kiện
    -- `consumed_at IS NULL` ngay trong WHERE.
    UPDATE app_private.copilot_write_confirmations
       SET consumed_at = clock_timestamp()
     WHERE id = v_step_up.id AND consumed_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
    END IF;

    v_step_up_id := v_step_up.id;
  END IF;

  -- Công tắc của cả cơ chế, hỏi LẠI. Tắt giữa lúc lập và lúc bấm là chuyện thật
  -- (đó chính là ý nghĩa của một kill switch), và ở đây chưa có gì để ghi lại
  -- nên NÉM là câu trả lời đúng: kế hoạch ở nguyên DRAFT rồi tự hết hạn.
  IF NOT app_private.copilot_action_flag_allows_v1(
           'copilot.execution_plan', v_plan.organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  -- POLICY ĐƯỢC ÉP LẠI Ở ĐÂY, KHÔNG CHỈ Ở LÚC LẬP.
  --
  --   `copilot_action_gate_v1` KHÔNG biết gì về trần rủi ro hay danh sách vai:
  --   nó đo registry + cờ + cấm khẩn cấp + phạm vi quyền. Nghĩa là nếu policy
  --   chỉ được ép ở `create`, thì một lần hạ trần L4 → L3 (hoặc bỏ `owner` khỏi
  --   `allowed_roles`) ở phút thứ 2 KHÔNG chạm được vào một kế hoạch lập ở phút
  --   0: nó vẫn duyệt được ở phút 3 và chạy tới phút 35. Van mà không có tác
  --   dụng lên thứ đang chờ chạy thì nó không phải van.
  --
  --   Ba vế, và cả ba đi cùng một mã `policy_changed` vì với người bấm chúng là
  --   một chuyện: luật đã đổi kể từ lúc kế hoạch này được lập.
  IF v_policy_rev IS DISTINCT FROM v_plan.policy_revision THEN
    v_ly_do := 'policy_changed';
  ELSIF NOT app_private.copilot_plan_role_allowed_v1(v_plan.organization_id) THEN
    v_ly_do := 'policy_changed';
  END IF;

  -- KIỂM LẠI TOÀN BỘ BƯỚC NGAY TRƯỚC KHI DUYỆT. Giữa lúc lập và lúc bấm có tới 5
  -- phút: đủ để ai đó thu quyền, tắt một action, hoặc kéo cầu dao khẩn cấp.
  FOR v_step IN
    SELECT * FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id ORDER BY step_no
  LOOP
    -- Vế policy ở trên đã chốt lý do thì bước ĐẦU TIÊN mang nó — không chạy tiếp
    -- vòng lặp để một mã lỗi khác đè lên.
    IF v_ly_do IS NOT NULL THEN
      v_buoc_hong := v_step.step_no;
      EXIT;
    END IF;
    BEGIN
      SELECT * INTO v_reg
        FROM app_private.copilot_action_registry
       WHERE action_id = v_step.action_id;
      IF NOT FOUND OR NOT v_reg.enabled OR v_reg.version <> v_step.action_version THEN
        v_ly_do := 'registry_changed';
      -- Trần rủi ro, đo LẠI theo policy của lúc BẤM. Miễn trừ vẫn theo đúng một
      -- `executor_kind` như ở `create`, không theo mức rủi ro.
      ELSIF v_reg.executor_kind <> 'maker_submit_v1'
            AND (CASE v_reg.risk WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END)
              > (CASE v_max_direct WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END) THEN
        v_ly_do := 'policy_changed';
      ELSE
        PERFORM app_private.copilot_action_gate_v1(v_step.action_id, v_plan.organization_id);
      END IF;
    EXCEPTION WHEN others THEN
      -- Giữ nguyên mã lỗi THẬT của cửa đã chặn (`copilot_action_disabled`,
      -- `tenant_emergency_denied`, `not_permitted`…). Ép tất cả về một chữ
      -- `step_not_permitted` sẽ làm người trực sự cố đi sửa phân quyền cho một
      -- lệnh cấm khẩn cấp — cùng lớp lỗi mà thứ tự bốn cửa của G2-A đã sửa.
      GET STACKED DIAGNOSTICS v_chi_tiet = MESSAGE_TEXT;
      v_ly_do := COALESCE(NULLIF(split_part(v_chi_tiet, ':', 1), ''), 'step_not_permitted');
    END;
    IF v_ly_do IS NOT NULL THEN
      v_buoc_hong := v_step.step_no;
      EXIT;
    END IF;
  END LOOP;

  IF v_ly_do IS NOT NULL THEN
    -- NONCE VẪN BỊ TIÊU. Người dùng đã bấm; phiếu đồng ý đó đã được dùng, và
    -- việc kế hoạch không chạy được là câu trả lời chứ không phải một lần bấm
    -- hỏng. Để nonce sống tiếp là mở đường thử lại tới khi lọt.
    UPDATE app_private.copilot_write_confirmations
       SET consumed_at = clock_timestamp()
     WHERE id = v_conf.id AND consumed_at IS NULL;

    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED',
           error_code = CASE WHEN step_no = v_buoc_hong THEN v_ly_do ELSE 'plan_failed' END
     WHERE plan_id = v_plan.id AND status = 'PENDING';

    UPDATE app_private.copilot_plans
       SET status = 'FAILED',
           version = version + 1,
           consent_confirmation_id = v_conf.id,
           consent_kind = CASE WHEN v_step_up_id IS NOT NULL THEN 'step_up' ELSE 'click' END,
           step_up_confirmation_id = v_step_up_id,
           -- Cùng khuôn với `execute_step`: <sự kiện sổ>:<bước>:<mã lỗi thật>.
           -- Mã lỗi thật là `policy_changed`, `registry_changed`,
           -- `copilot_action_disabled`, `tenant_emergency_denied`,
           -- `not_permitted`… — xem khối EXCEPTION ở vòng lặp trên.
           failure_reason = 'step_blocked:' || v_buoc_hong::text || ':' || v_ly_do,
           updated_at = clock_timestamp()
     WHERE id = v_plan.id
    RETURNING version INTO v_version;

    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'step_blocked',
      'organization_id', v_plan.organization_id,
      'plan_id',         v_plan.id,
      'step_no',         v_buoc_hong,
      'plan_version',    v_version,
      'action_id',       (SELECT action_id FROM app_private.copilot_plan_steps
                           WHERE plan_id = v_plan.id AND step_no = v_buoc_hong),
      'permission_key',  'copilot.execution_plan',
      'consent_id',      v_conf.id,
      'consent_kind',    CASE WHEN v_step_up_id IS NOT NULL THEN 'step_up' ELSE 'click' END,
      'step_up_id',      v_step_up_id,
      'error_code',      v_ly_do,
      'outcome',         jsonb_build_object('giai_doan', 'approve', 'plan_status', 'FAILED')));

    RETURN jsonb_build_object(
      'ok',               false,
      'error_code',       v_ly_do,
      'plan_id',          v_plan.id,
      'plan_version',     v_version,
      'plan_status',      'FAILED',
      'execute_deadline', NULL,
      'step_no',          v_buoc_hong);
  END IF;

  -- CAS TIÊU NONCE. `consumed_at IS NULL` trong WHERE là thứ biến hai lần bấm
  -- song song thành một lần duyệt.
  UPDATE app_private.copilot_write_confirmations
     SET consumed_at = clock_timestamp()
   WHERE id = v_conf.id AND consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;

  v_han := clock_timestamp() + interval '30 minutes';
  UPDATE app_private.copilot_plans
     SET status = 'APPROVED',
         approved_at = clock_timestamp(),
         execute_deadline = v_han,
         consent_confirmation_id = v_conf.id,
         consent_kind = CASE WHEN v_step_up_id IS NOT NULL THEN 'step_up' ELSE 'click' END,
         step_up_confirmation_id = v_step_up_id,
         version = version + 1,
         updated_at = clock_timestamp()
   WHERE id = v_plan.id AND version = p_expected_plan_version
  RETURNING version INTO v_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = '40001';
  END IF;

  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',           'plan_approved',
    'organization_id', v_plan.organization_id,
    'plan_id',         v_plan.id,
    'plan_version',    v_version,
    'permission_key',  'copilot.execution_plan',
    'permission_snapshot', jsonb_build_object(
      'registry_revision', v_plan.registry_revision,
      'policy_revision',   v_policy_rev,
      'max_direct_risk',   v_max_direct,
      'plan_max_risk',     v_plan.max_risk,
      'step_count',        v_plan.step_count,
      'is_super_admin',    public.is_super_admin(),
      'checked_at',        clock_timestamp()),
    'consent_id',      v_conf.id,
    'consent_kind',    CASE WHEN v_step_up_id IS NOT NULL THEN 'step_up' ELSE 'click' END,
    'step_up_id',      v_step_up_id,
    'payload_digest',  encode(v_plan.plan_digest, 'hex'),
    'outcome', jsonb_build_object('plan_status', 'APPROVED', 'execute_deadline', v_han)));

  RETURN jsonb_build_object(
    'ok',               true,
    'error_code',       NULL,
    'plan_id',          v_plan.id,
    'plan_version',     v_version,
    'plan_status',      'APPROVED',
    'execute_deadline', v_han);
END
$function$;

COMMENT ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, integer, text) IS
  'Duyet ke hoach thuc thi: tieu nonce cap ke hoach, kiem lai policy/registry/quyen NGAY LUC BAM, va '
  'tu G5-A xac thuc + tieu token step-up that cho ke hoach L5 duoi tran L5. Ghi-roi-RETURN cho ba nhanh '
  'phai de lai bang chung (het han, mat quyen luc duyet, buoc hong luc chay); moi nhanh khac RAISE.';

REVOKE ALL ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, integer, text) TO authenticated;
DO $thu_hoi_approve$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, integer, text) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, integer, text) FROM service_role;
  END IF;
END
$thu_hoi_approve$;

-- ---------------------------------------------------------------------------
-- 8. NGHIỆM THU — catalog-only, không đụng bảng dữ liệu.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_can  text[] := ARRAY[
    'public.copilot_step_up_set_pin_v1(text, text)',
    'public.copilot_step_up_verify_v1(text, uuid)',
    'public.copilot_step_up_status_v1()',
    'public.copilot_step_up_unlock_v1(uuid, text)',
    'public.copilot_plan_approve_v1(uuid, text, text, integer, text)'
  ];
  v_ten  text;
  v_thieu text[];
  v_ho    text[];
BEGIN
  -- (1) pgcrypto vẫn còn.
  IF to_regprocedure('extensions.crypt(text, text)') IS NULL
     OR to_regprocedure('extensions.gen_salt(text, integer)') IS NULL THEN
    RAISE EXCEPTION 'pgcrypto_missing sau khi migrate — khong the xay ra';
  END IF;

  -- (2) CHECK event đã có đủ bốn sự kiện mới.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_action_ledger_event_check'
       AND conrelid = 'app_private.copilot_action_ledger'::regclass
       AND pg_get_constraintdef(oid) LIKE '%step_up_pin_set%'
       AND pg_get_constraintdef(oid) LIKE '%step_up_verified%'
       AND pg_get_constraintdef(oid) LIKE '%step_up_locked%'
       AND pg_get_constraintdef(oid) LIKE '%step_up_unlocked%'
  ) THEN
    RAISE EXCEPTION 'copilot_action_ledger_event_check thieu su kien step_up_*';
  END IF;

  -- (3) `authenticated` gọi được cả năm hàm.
  IF to_regrole('authenticated') IS NOT NULL THEN
    v_thieu := '{}'::text[];
    FOREACH v_ten IN ARRAY v_can
    LOOP
      IF NOT has_function_privilege('authenticated', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_thieu := v_thieu || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_thieu) > 0 THEN
      RAISE EXCEPTION 'authenticated khong goi duoc RPC step-up: %', array_to_string(v_thieu, ', ');
    END IF;
  END IF;

  -- (4) `anon` không gọi được BẤT CỨ hàm nào của file này.
  IF to_regrole('anon') IS NOT NULL THEN
    v_ho := '{}'::text[];
    FOREACH v_ten IN ARRAY v_can
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham step-up: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  -- (5) Bảng PIN KHÔNG lộ cho anon/authenticated.
  IF to_regrole('authenticated') IS NOT NULL THEN
    IF has_table_privilege('authenticated', 'app_private.copilot_step_up_pins', 'SELECT') THEN
      RAISE EXCEPTION 'authenticated doc duoc bang copilot_step_up_pins — REVOKE khong an';
    END IF;
  END IF;
  IF to_regrole('anon') IS NOT NULL THEN
    IF has_table_privilege('anon', 'app_private.copilot_step_up_pins', 'SELECT') THEN
      RAISE EXCEPTION 'anon doc duoc bang copilot_step_up_pins — REVOKE khong an';
    END IF;
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- ROLLBACK (thông tin — KHÔNG chạy tự động):
--   Trả copilot_plan_approve_v1 về bản 20260903132857 (RAISE step_up_not_implemented).
--   Trả copilot_ledger_append_v1 về bản 20260903043956 (chỉ ngoại lệ policy_changed).
--   ALTER TABLE app_private.copilot_action_ledger
--     DROP CONSTRAINT copilot_action_ledger_org_required,
--     ADD CONSTRAINT copilot_action_ledger_org_required
--       CHECK (organization_id IS NOT NULL OR event = 'policy_changed');
--   ALTER TABLE app_private.copilot_action_ledger
--     DROP CONSTRAINT copilot_action_ledger_event_check,
--     ADD CONSTRAINT copilot_action_ledger_event_check
--       CHECK (event IN ('plan_created','plan_approved','step_done','step_failed',
--         'step_blocked','plan_cancelled','plan_expired','action_executed',
--         'action_failed','policy_changed','capability_changed'));
--   DROP FUNCTION public.copilot_step_up_unlock_v1(uuid, text);
--   DROP FUNCTION public.copilot_step_up_status_v1();
--   DROP FUNCTION public.copilot_step_up_verify_v1(text, uuid);
--   DROP FUNCTION public.copilot_step_up_set_pin_v1(text, text);
--   DROP TABLE app_private.copilot_step_up_pins;
-- =============================================================================
