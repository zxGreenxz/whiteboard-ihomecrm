-- Superadmin và chủ công ty đặt lại mật khẩu cho user khác (14/11/2026).
--
-- VÌ SAO. Trước bản này không có đường nào đổi mật khẩu của người khác: edge `admin-create-user`
-- chỉ TẠO user, trang Hồ sơ chỉ đổi mật khẩu của chính mình, còn "quên mật khẩu" gửi thư tới email
-- đăng nhập — mà 11/13 tài khoản production dùng email giả `@phone/@username.ihomecrm.local`
-- (đo 14/11/2026), nên nhân viên quên mật khẩu là bị khoá ngoài.
--
-- LUỒNG (cùng khuôn cửa vân tay: bắt đầu → làm việc bên ngoài → chốt). Edge
-- `admin-reset-user-password` gọi hai hàm dưới đây BẰNG JWT CỦA NGƯỜI BẤM, nên auth.uid() là người
-- bấm thật và nhật ký phân quyền ghi đúng người:
--   1. user_password_reset_begin_v1(target) — kiểm quyền, giới hạn tần suất, ghi dòng PENDING VÀ
--      sự kiện USER_PASSWORD_RESET vào nhật ký phân quyền của từng tổ chức của người bị đổi, trong
--      CÙNG transaction. Nhật ký ghi ở đây chứ không ở bước 3: bước 3 có thể không bao giờ tới (mạng,
--      JWT hết hạn giữa chừng) trong khi mật khẩu đã đổi — thà ghi một lần thử chưa thành còn hơn
--      bỏ lọt một lần đã đổi.
--   2. edge gọi Auth Admin API (khoá service role) đổi mật khẩu — mật khẩu KHÔNG BAO GIỜ xuống SQL.
--   3. user_password_reset_finish_v1(id, mã chốt, kết quả) — chốt dòng; thất bại chắc chắn thì ghi
--      thêm USER_PASSWORD_RESET_FAILED để nhật ký không nói quá.
-- MÃ CHỐT: bước 1 sinh 256 bit ngẫu nhiên, chỉ trả cho bên gọi (edge), lưu SHA-256. Bước 3 đòi đúng
-- mã. Không có nó thì chính người bấm — đọc được requestId trong nhật ký phân quyền — gọi thẳng
-- finish(FAILED) trước edge để biến một lần đổi THÀNH CÔNG thành dòng "không thành".
-- Gọi thẳng hai hàm (không qua edge) không đổi được mật khẩu ai; cùng lắm người có quyền tự ghi
-- thêm một lần thử về CHÍNH mình, và vẫn bị giới hạn tần suất ở bước 1.
--
-- AI ĐƯỢC ĐẶT LẠI CHO AI (app_private.user_password_reset_decision_v1 — nguồn duy nhất):
--   - Không ai đặt lại cho chính mình qua đường này (trang Hồ sơ đã có).
--   - Superadmin: mọi user còn tồn tại.
--   - Chủ công ty theo nghĩa CHẶT (app_private.user_password_reset_is_owner_v1): tư cách ACTIVE loại
--     OWNER kèm binding còn hiệu lực tới vai hệ thống system_key = TENANT_OWNER. Cố ý KHÔNG dùng
--     ie_actor_is_company_owner_v1 hay is_org_owner_v1: cả hai còn vế khớp TÊN vai ('Chủ công ty',
--     'Chủ sở hữu tổ chức' khi system_key NULL), mà người giữ users.edit đổi được tên vai thường qua
--     upsert_organization_role_v1 — đổi tên một vai mình đang giữ thành "Chủ công ty" là thành chủ.
--     Vai TENANT_OWNER là vai hệ thống, trigger guard_system_role_identity giữ nó. Đo production
--     14/11/2026: cả 4 tư cách chủ hiện có đều đạt vế chặt, không ai bị rơi.
--     Chủ công ty chỉ đặt lại được khi người bị đổi
--       * có ít nhất một tư cách chưa REVOKED, và MỌI tổ chức của họ đều do người bấm làm chủ —
--         một người thuộc hai công ty thì chủ một bên không chiếm được tài khoản để vào bên kia;
--       * không thuộc công ty demo (organizations.is_demo) — mật khẩu chủ demo công khai trên trang
--         Sandbox, ai cũng vào được vai chủ demo;
--       * không phải superadmin;
--       * không phải chủ, xét RỘNG: loại OWNER ở BẤT KỲ tư cách nào, hoặc BẤT KỲ binding nào (kể
--         cả đã đóng hạn, kể cả trên tư cách SUSPENDED hay REVOKED) tới vai TENANT_OWNER / vai tên
--         'Chủ sở hữu tổ chức' / 'Chủ công ty' — để chủ này không tạm dừng, thu hồi hay đóng vai của
--         đồng chủ rồi chiếm tài khoản (đã từng là chủ thì chỉ superadmin đặt lại);
--       * không phải thành viên loại SHAREHOLDER (nhà đầu tư thuần, không làm việc trong công ty):
--         chỉ superadmin. Nhân viên kiêm cổ đông (bảng shareholders) vẫn là nhân viên — production
--         14/11/2026 có 3/3 người như vậy, và tài khoản cổ đông chỉ XEM báo cáo phân bổ, không có
--         thao tác ký/xác nhận nào để giả mạo.
--   Tập đo trên production 14/11/2026 (chỉ đọc): 1 superadmin; 1 chủ công ty thật ở công ty thật
--   (đặt lại được 3 người), chủ demo không đặt lại được ai.
--
-- Idempotent: IF NOT EXISTS, CREATE OR REPLACE, ACL khẳng định lại. DROP duy nhất là chữ ký cũ
-- (uuid, text, text) của hàm chốt — bản nháp chỉ từng có trên project TEST, production chưa từng có.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.append_authz_audit_v1(uuid,text,text,uuid,jsonb,jsonb,text)') IS NULL
    OR to_regclass('public.organization_memberships') IS NULL
    OR to_regclass('public.organization_roles') IS NULL
    OR to_regclass('public.role_bindings') IS NULL
    OR to_regclass('public.organizations') IS NULL
    OR to_regclass('public.super_admins') IS NULL
    OR to_regclass('public.profiles') IS NULL
    OR to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'admin_reset_user_password_requires_missing';
  END IF;
END $requires$;

-- ---------- 1. Nhật ký riêng của từng lần đặt lại ----------
-- Không khoá ngoại tới auth.users: user bị xoá thì dòng nhật ký vẫn phải còn.
CREATE TABLE IF NOT EXISTS app_private.user_password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL,
  target_user_id uuid NOT NULL,
  target_name text NOT NULL,
  via text NOT NULL CHECK (via IN ('SUPER_ADMIN', 'COMPANY_OWNER')),
  organization_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'),
  requested_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  finish_token_hash bytea CHECK (finish_token_hash IS NULL OR octet_length(finish_token_hash) = 32),
  CONSTRAINT user_password_resets_finished_ck CHECK ((status = 'PENDING') = (finished_at IS NULL)),
  CONSTRAINT user_password_resets_not_self_ck CHECK (actor_user_id <> target_user_id)
);
-- Bảng đã có từ bản nháp trên TEST (chưa có cột này); production tạo mới ở câu trên.
ALTER TABLE app_private.user_password_resets
  ADD COLUMN IF NOT EXISTS finish_token_hash bytea CHECK (finish_token_hash IS NULL OR octet_length(finish_token_hash) = 32);

CREATE INDEX IF NOT EXISTS user_password_resets_actor_idx
  ON app_private.user_password_resets (actor_user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS user_password_resets_target_idx
  ON app_private.user_password_resets (target_user_id, requested_at DESC);

ALTER TABLE app_private.user_password_resets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.user_password_resets FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.user_password_resets IS
  'Mỗi lần superadmin/chủ công ty đặt lại mật khẩu cho người khác qua edge admin-reset-user-password: PENDING lúc kiểm quyền xong, SUCCEEDED/FAILED/UNKNOWN khi edge chốt (PENDING mãi = bước chốt không tới, coi như chưa rõ). Không lưu mật khẩu. Chỉ đọc/ghi qua user_password_reset_begin_v1/finish_v1.';

-- ---------- 2. Vị ngữ quyền ----------
CREATE OR REPLACE FUNCTION app_private.user_password_reset_is_owner_v1(p_org uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM public.organization_memberships m
      JOIN public.role_bindings rb
        ON rb.membership_id = m.id
       AND rb.organization_id = m.organization_id
      JOIN public.organization_roles r
        ON r.id = rb.role_id
       AND r.organization_id = rb.organization_id
     WHERE m.organization_id = p_org
       AND m.user_id = p_user
       AND m.status = 'ACTIVE'
       AND m.member_type = 'OWNER'
       AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= now()
       AND (m.valid_to IS NULL OR m.valid_to > now())
       AND r.system_key = 'TENANT_OWNER'
       AND COALESCE(r.status, 'ACTIVE') = 'ACTIVE'
       AND COALESCE(rb.valid_from, '-infinity'::timestamptz) <= now()
       AND (rb.valid_to IS NULL OR rb.valid_to > now())
  );
$fn$;

COMMENT ON FUNCTION app_private.user_password_reset_is_owner_v1(uuid, uuid) IS
  'Chủ công ty theo nghĩa CHẶT cho cửa đặt lại mật khẩu: tư cách ACTIVE loại OWNER còn hạn + binding còn hiệu lực tới vai system_key=TENANT_OWNER. Không khớp theo tên vai (tên vai thường đổi được qua upsert_organization_role_v1).';

CREATE OR REPLACE FUNCTION app_private.user_password_reset_decision_v1(p_actor uuid, p_target uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_orgs uuid[];
BEGIN
  IF p_actor IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'NO_ACTOR');
  END IF;
  IF p_target IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'NO_TARGET');
  END IF;
  IF p_target = p_actor THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'SELF');
  END IF;

  -- Mọi tổ chức người bị đổi còn dính (kể cả INVITED/SUSPENDED và tư cách hết hạn): càng nhiều
  -- tổ chức thì càng khó qua vế "mọi tổ chức đều do người bấm làm chủ" — lệch về phía chặn.
  SELECT coalesce(array_agg(DISTINCT m.organization_id ORDER BY m.organization_id), '{}'::uuid[])
    INTO v_orgs
    FROM public.organization_memberships m
   WHERE m.user_id = p_target
     AND m.status <> 'REVOKED';

  IF EXISTS (SELECT 1 FROM public.super_admins s WHERE s.user_id = p_actor) THEN
    IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_target) THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'TARGET_NOT_FOUND');
    END IF;
    RETURN jsonb_build_object('allowed', true, 'via', 'SUPER_ADMIN', 'organizationIds', to_jsonb(v_orgs));
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.organization_memberships m
     WHERE m.user_id = p_actor
       AND m.status = 'ACTIVE'
       AND app_private.user_password_reset_is_owner_v1(m.organization_id, p_actor)
  ) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'NOT_ADMIN');
  END IF;

  IF EXISTS (SELECT 1 FROM public.super_admins s WHERE s.user_id = p_target) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'TARGET_SUPER_ADMIN');
  END IF;

  IF cardinality(v_orgs) = 0
    OR EXISTS (
      SELECT 1 FROM unnest(v_orgs) AS o(id)
       WHERE NOT app_private.user_password_reset_is_owner_v1(o.id, p_actor)
    ) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'TARGET_OUTSIDE_ORG');
  END IF;

  -- Công ty demo dùng chung tài khoản: mật khẩu chủ demo được công bố trên trang Sandbox, nên
  -- khách lạ nào cũng đăng nhập được vai chủ demo. Mở đường này ở đó là cho khách khoá tài khoản
  -- demo của người khác (và làm gãy bộ E2E dùng các tài khoản ấy).
  IF EXISTS (SELECT 1 FROM public.organizations g WHERE g.id = ANY (v_orgs) AND g.is_demo) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'TARGET_DEMO_ORG');
  END IF;

  -- Chủ, xét RỘNG: không lọc trạng thái tư cách (kể cả REVOKED — một người có thể có hai tư cách
  -- trong cùng công ty) hay hạn hiệu lực của binding, để chủ này không tạm dừng / thu hồi tư cách hay
  -- đóng vai của đồng chủ rồi chiếm tài khoản người đó.
  IF EXISTS (
    SELECT 1
      FROM public.organization_memberships m
     WHERE m.user_id = p_target
       AND m.member_type = 'OWNER'
  ) OR EXISTS (
    SELECT 1
      FROM public.organization_memberships m
      JOIN public.role_bindings rb ON rb.membership_id = m.id
      JOIN public.organization_roles r ON r.id = rb.role_id
     WHERE m.user_id = p_target
       AND (r.system_key = 'TENANT_OWNER' OR r.name IN ('Chủ sở hữu tổ chức', 'Chủ công ty'))
  ) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'TARGET_OWNER');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.organization_memberships m
     WHERE m.user_id = p_target
       AND m.status <> 'REVOKED'
       AND m.member_type = 'SHAREHOLDER'
  ) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'TARGET_SHAREHOLDER');
  END IF;

  RETURN jsonb_build_object('allowed', true, 'via', 'COMPANY_OWNER', 'organizationIds', to_jsonb(v_orgs));
END
$fn$;

COMMENT ON FUNCTION app_private.user_password_reset_decision_v1(uuid, uuid) IS
  'Nguồn duy nhất của luật "ai được đặt lại mật khẩu cho ai": superadmin cho mọi user trừ chính mình; chủ công ty theo nghĩa chặt (user_password_reset_is_owner_v1) chỉ khi MỌI tổ chức của người bị đổi đều do mình làm chủ, không tổ chức nào là demo, và người đó không phải superadmin, chủ (xét rộng) hay thành viên loại SHAREHOLDER. Trả {allowed, reason|via, organizationIds}.';

-- ---------- 3. Bắt đầu: kiểm quyền + giới hạn tần suất + dòng PENDING + nhật ký phân quyền ----------
CREATE OR REPLACE FUNCTION public.user_password_reset_begin_v1(p_target_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_decision jsonb;
  v_via text;
  v_orgs uuid[];
  v_org uuid;
  v_key text;
  v_name text;
  v_id uuid;
  v_token text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Phiên đăng nhập không hợp lệ — đăng nhập lại.' USING ERRCODE = '42501';
  END IF;
  IF p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu tài khoản cần đặt lại mật khẩu.' USING ERRCODE = '22023';
  END IF;
  IF p_target_user_id = v_actor THEN
    RAISE EXCEPTION 'Đổi mật khẩu của chính bạn ở trang Hồ sơ.' USING ERRCODE = '22023';
  END IF;

  v_decision := app_private.user_password_reset_decision_v1(v_actor, p_target_user_id);
  IF NOT coalesce((v_decision ->> 'allowed')::boolean, false) THEN
    -- TARGET_NOT_FOUND chỉ tới được khi người bấm là superadmin; người khác luôn nhận 42501 nên
    -- không dò được tài khoản nào tồn tại.
    IF v_decision ->> 'reason' = 'TARGET_NOT_FOUND' THEN
      RAISE EXCEPTION 'Không tìm thấy tài khoản cần đặt lại mật khẩu.' USING ERRCODE = '22023';
    END IF;
    RAISE EXCEPTION 'Bạn không có quyền đặt lại mật khẩu cho tài khoản này.' USING ERRCODE = '42501';
  END IF;
  v_via := v_decision ->> 'via';

  -- Tuần tự hoá theo người bấm VÀ người bị đổi (lấy khoá theo thứ tự cố định để không khoá chéo),
  -- để các lời gọi song song không cùng lọt giới hạn.
  FOR v_key IN
    SELECT k FROM unnest(ARRAY[
      'user_password_reset:actor:' || v_actor::text,
      'user_password_reset:target:' || p_target_user_id::text
    ]) AS t(k) ORDER BY k
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));
  END LOOP;

  IF (SELECT count(*) FROM app_private.user_password_resets r
       WHERE r.actor_user_id = v_actor AND r.requested_at > now() - interval '10 minutes') >= 10 THEN
    RAISE EXCEPTION 'Đặt lại mật khẩu quá nhiều lần — thử lại sau ít phút.' USING ERRCODE = '54000';
  END IF;
  -- Giới hạn theo người bị đổi chỉ áp cho chủ công ty: không để ai đốt hạn mức của một tài khoản
  -- (gọi thẳng begin nhiều lần) mà chặn luôn superadmin cứu tài khoản đó.
  IF v_via = 'COMPANY_OWNER'
    AND (SELECT count(*) FROM app_private.user_password_resets r
          WHERE r.target_user_id = p_target_user_id AND r.requested_at > now() - interval '10 minutes') >= 5 THEN
    RAISE EXCEPTION 'Đặt lại mật khẩu quá nhiều lần — thử lại sau ít phút.' USING ERRCODE = '54000';
  END IF;

  SELECT coalesce(array_agg(x::uuid), '{}'::uuid[])
    INTO v_orgs
    FROM jsonb_array_elements_text(coalesce(v_decision -> 'organizationIds', '[]'::jsonb)) AS t(x);

  SELECT coalesce(nullif(btrim(p.full_name), ''), 'Không tên')
    INTO v_name
    FROM public.profiles p
   WHERE p.id = p_target_user_id;
  v_name := coalesce(v_name, 'Không tên');

  -- Mã chốt: hai UUID v4 (nguồn ngẫu nhiên mạnh của Postgres) = 64 ký tự hex, ~244 bit. Chỉ trả
  -- cho bên gọi; bảng giữ SHA-256.
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

  INSERT INTO app_private.user_password_resets (actor_user_id, target_user_id, target_name, via, organization_ids, finish_token_hash)
  VALUES (v_actor, p_target_user_id, v_name, v_via, v_orgs, sha256(convert_to(v_token, 'UTF8')))
  RETURNING id INTO v_id;

  FOREACH v_org IN ARRAY v_orgs LOOP
    PERFORM app_private.append_authz_audit_v1(
      v_org,
      'USER_PASSWORD_RESET',
      'USER',
      p_target_user_id,
      NULL,
      jsonb_build_object('via', v_via, 'targetName', v_name, 'requestId', v_id),
      NULL
    );
  END LOOP;

  RETURN jsonb_build_object('requestId', v_id, 'via', v_via, 'finishToken', v_token);
END
$fn$;

COMMENT ON FUNCTION public.user_password_reset_begin_v1(uuid) IS
  'Bước 1 của edge admin-reset-user-password, gọi bằng JWT người bấm: kiểm quyền theo app_private.user_password_reset_decision_v1 (42501 nếu không được), giới hạn 10 lần/10 phút mỗi người bấm và (với chủ công ty) 5 lần/10 phút mỗi người bị đổi (54000), ghi dòng PENDING và sự kiện USER_PASSWORD_RESET vào nhật ký phân quyền của từng tổ chức của người bị đổi. Trả {requestId, via, finishToken}; finishToken chỉ dành cho bên gọi để chốt. Không đổi mật khẩu.';

-- ---------- 4. Chốt kết quả ----------
-- Chữ ký nháp (uuid, text, text) không có mã chốt — chỉ từng tồn tại trên project TEST.
DROP FUNCTION IF EXISTS public.user_password_reset_finish_v1(uuid, text, text);

CREATE OR REPLACE FUNCTION public.user_password_reset_finish_v1(p_request_id uuid, p_finish_token text, p_outcome text, p_error_code text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_row app_private.user_password_resets%ROWTYPE;
  v_org uuid;
  v_events integer := 0;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Phiên đăng nhập không hợp lệ — đăng nhập lại.' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('SUCCEEDED', 'FAILED', 'UNKNOWN') THEN
    RAISE EXCEPTION 'Kết quả đặt lại mật khẩu không hợp lệ.' USING ERRCODE = '22023';
  END IF;
  IF p_error_code IS NOT NULL AND p_error_code !~ '^[a-z0-9_]{1,64}$' THEN
    RAISE EXCEPTION 'Mã lỗi không hợp lệ.' USING ERRCODE = '22023';
  END IF;

  -- Sai mã chốt cũng trả đúng câu "không tìm thấy": không cho dò yêu cầu nào tồn tại.
  SELECT * INTO v_row
    FROM app_private.user_password_resets r
   WHERE r.id = p_request_id
     AND r.actor_user_id = v_actor
     AND p_finish_token IS NOT NULL
     AND r.finish_token_hash = sha256(convert_to(p_finish_token, 'UTF8'))
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy yêu cầu đặt lại mật khẩu.' USING ERRCODE = '42501';
  END IF;

  IF v_row.status <> 'PENDING' THEN
    IF v_row.status = p_outcome THEN
      RETURN jsonb_build_object('requestId', v_row.id, 'status', v_row.status, 'auditEvents', 0);
    END IF;
    RAISE EXCEPTION 'Yêu cầu đặt lại mật khẩu đã chốt.' USING ERRCODE = '55000';
  END IF;

  UPDATE app_private.user_password_resets
     SET status = p_outcome,
         error_code = p_error_code,
         finished_at = now()
   WHERE id = v_row.id;

  -- Sự kiện USER_PASSWORD_RESET đã ghi ở bước bắt đầu. Chỉ khi CHẮC CHẮN chưa đổi mới ghi thêm
  -- một dòng đính chính; SUCCEEDED/UNKNOWN để nguyên dòng đã có.
  IF p_outcome = 'FAILED' THEN
    FOREACH v_org IN ARRAY v_row.organization_ids LOOP
      PERFORM app_private.append_authz_audit_v1(
        v_org,
        'USER_PASSWORD_RESET_FAILED',
        'USER',
        v_row.target_user_id,
        NULL,
        jsonb_build_object('via', v_row.via, 'targetName', v_row.target_name, 'requestId', v_row.id, 'errorCode', p_error_code),
        NULL
      );
      v_events := v_events + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('requestId', v_row.id, 'status', p_outcome, 'auditEvents', v_events);
END
$fn$;

COMMENT ON FUNCTION public.user_password_reset_finish_v1(uuid, text, text, text) IS
  'Bước 3 của edge admin-reset-user-password, gọi bằng JWT người bấm KÈM mã chốt do bước 1 trả cho edge: chốt dòng PENDING của chính người đó thành SUCCEEDED/FAILED/UNKNOWN (lặp lại cùng kết quả thì trả nguyên, khác thì 55000; sai mã = không tìm thấy, 42501). FAILED ghi thêm USER_PASSWORD_RESET_FAILED vào nhật ký phân quyền để đính chính dòng USER_PASSWORD_RESET đã ghi ở bước bắt đầu.';

-- ---------- 5. ACL ----------
REVOKE ALL ON FUNCTION app_private.user_password_reset_is_owner_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.user_password_reset_decision_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.user_password_reset_begin_v1(uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.user_password_reset_finish_v1(uuid, text, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.user_password_reset_begin_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_password_reset_finish_v1(uuid, text, text, text) TO authenticated;

DO $check$
DECLARE
  v_sig text;
  v_role text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.user_password_reset_begin_v1(uuid)',
    'public.user_password_reset_finish_v1(uuid,text,text,text)'
  ] LOOP
    IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE')
      OR has_function_privilege('anon', v_sig, 'EXECUTE')
      OR has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'admin_reset_user_password_acl_public_failed: %', v_sig;
    END IF;
  END LOOP;

  FOREACH v_sig IN ARRAY ARRAY[
    'app_private.user_password_reset_is_owner_v1(uuid,uuid)',
    'app_private.user_password_reset_decision_v1(uuid,uuid)'
  ] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_function_privilege(v_role, v_sig, 'EXECUTE') THEN
        RAISE EXCEPTION 'admin_reset_user_password_acl_private_failed: % %', v_role, v_sig;
      END IF;
    END LOOP;
  END LOOP;

  IF has_table_privilege('authenticated', 'app_private.user_password_resets', 'SELECT')
    OR has_table_privilege('anon', 'app_private.user_password_resets', 'SELECT')
    OR has_table_privilege('service_role', 'app_private.user_password_resets', 'SELECT') THEN
    RAISE EXCEPTION 'admin_reset_user_password_acl_table_failed';
  END IF;
END $check$;

COMMIT;
NOTIFY pgrst, 'reload schema';
