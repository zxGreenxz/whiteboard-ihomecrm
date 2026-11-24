-- =============================================================================
-- Sale phòng, đợt 1 (plan «Sửa trang Sale phòng», chủ duyệt 24/11/2026): link chia sẻ và thống kê ghi rõ công ty.
-- Phần máy chủ của lỗi 1 và 7 (audit 24/11) và điều sót S1, S3 (phần link), S5; giao diện cùng PR sửa lỗi 1, 11, 13, S9.
--
-- VÌ SAO
--   Từ 2026-09-03 nick chủ là thành viên ACTIVE của hai công ty. Hai hàm dưới đây ghi vào bảng có
--   trg_autofill_org_strict mà không gửi organization_id, nên trigger phải đoán công ty từ owner_id; người thuộc hai
--   công ty ⇒ 23502 «không suy được organization_id».
--   - create_public_room_token: nick chủ bấm «Tạo link» ⇒ 23502 (màn báo nhầm thành lỗi nhập liệu).
--   - log_public_room_events: mỗi dòng ghi trong khối EXCEPTION WHEN others THEN NULL ⇒ mọi sự kiện không có phòng/toà
--     (session, error, view_mode…) của link nick chủ bị bỏ im lặng. Đo production 25/11/2026: phiên xem 298 dòng trước
--     03/09, 0 dòng sau; lỗi 185 trước, 0 sau ⇒ «Thời gian xem TB» 0:00, tab «Lỗi» trống.
--   - Quyền sale_phong.manage_tokens chỉ ẩn tab; máy chủ cho mọi người đăng nhập tạo link.
--
-- LÀM GÌ
--   1. create_public_room_token(p_label text DEFAULT NULL, p_organization_id uuid DEFAULT NULL) thay bản một tham số
--      (bỏ bản cũ để PostgREST không gặp hai bản cùng tên; bản web cũ gọi chỉ với p_label vẫn khớp bản mới). Kiểm:
--      (a) đã đăng nhập; (b) công ty nằm trong my_org_ids() — p_organization_id NULL thì lấy công ty duy nhất của người
--      gọi, thuộc nhiều công ty ⇒ 22023 bắt chọn công ty; (c) quyền sale_phong.manage_tokens qua
--      app_private.authorized_scope_v3 ở bất kỳ phạm vi nào (công ty, khu, toà — khớp cách giao diện hiện tab), quản
--      trị nền tảng (public.super_admins) giữ đường đang có như get_my_permissions. Ghi organization_id tường minh.
--      Phần sinh mã link giữ nguyên.
--   2. log_public_room_events: lấy organization_id của link cùng lúc với owner_id và ghi tường minh vào từng dòng.
--      Giữ nguyên: chữ ký, kiểu trả về (số dòng đã ghi), quyền anon, hạn mức 5.000 dòng/link/ngày theo giờ VN, trần 50
--      sự kiện/lô, 14 loại sự kiện, hạ cấp metadata. Dòng hỏng vẫn chỉ mất chính nó (trang công khai không gãy) nhưng
--      KHÔNG còn im lặng: đếm vào app_private.public_room_event_budgets (so_loi, loi_cuoi_ma = SQLSTATE cuối,
--      loi_cuoi_luc) và RAISE WARNING vào log Postgres (PostgREST không chuyển WARNING tới khách).
--   3. public_room_event_budgets: thêm ba cột trên (ADD COLUMN IF NOT EXISTS, có mặc định; bảng 53 dòng).
--
-- AN TOÀN CHẠY LẠI
--   Tiền kiểm md5(prosrc bỏ CR) của hai hàm: thân production đo 25/11/2026 (lượt đầu) hoặc thân của chính file này
--   (lượt chạy lại); khác ⇒ 55000, không ghi gì. Hậu kiểm: đúng một bản mỗi hàm, đúng thân, đúng quyền gọi.
--
-- LÙI (migration forward mới, không phá dữ liệu): DROP create_public_room_token(text, uuid) rồi CREATE lại bản (text)
--   bằng nguyên văn thân 20260607090300 (md5 a58a58892c46a5d5f6e3bfd2bc948134); CREATE OR REPLACE
--   log_public_room_events bằng nguyên văn thân 20260902092508 (md5 6793a043ee3eed5ab05e9f041eeeebdf). Ba cột mới để
--   lại (không hàm nào khác đọc). Link đã tạo giữ nguyên organization_id đã ghi.
-- =============================================================================

-- 0. Tiền kiểm: đúng phụ thuộc, đúng thân đã rà.
DO $truoc$
DECLARE
  v_md5 text;
BEGIN
  IF to_regprocedure('app_private.authorized_scope_v3(text,uuid)') IS NULL
     OR to_regprocedure('public.my_org_ids()') IS NULL
     OR to_regprocedure('public.is_super_admin()') IS NULL
     OR to_regprocedure('public.gen_contract_public_code(integer)') IS NULL
     OR to_regclass('public.public_room_share_tokens') IS NULL
     OR to_regclass('public.public_room_events') IS NULL
     OR to_regclass('app_private.public_room_event_budgets') IS NULL THEN
    RAISE EXCEPTION 'link_chia_se_ghi_ro_cong_ty: thiếu phụ thuộc' USING ERRCODE = '55000';
  END IF;

  -- create_public_room_token: lượt đầu còn bản (text) với thân production; lượt chạy lại chỉ còn bản (text, uuid).
  IF to_regprocedure('public.create_public_room_token(text)') IS NOT NULL THEN
    IF to_regprocedure('public.create_public_room_token(text,uuid)') IS NOT NULL THEN
      RAISE EXCEPTION 'create_public_room_token: đang có cả hai bản (text) và (text, uuid) — DỪNG, đối chiếu catalog'
        USING ERRCODE = '55000';
    END IF;
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
      FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.create_public_room_token(text)');
    IF v_md5 IS DISTINCT FROM 'a58a58892c46a5d5f6e3bfd2bc948134' THEN
      RAISE EXCEPTION 'create_public_room_token(text) KHÁC thân đã rà (md5 %) — DỪNG, đối chiếu thân đang chạy', v_md5
        USING ERRCODE = '55000';
    END IF;
  ELSIF to_regprocedure('public.create_public_room_token(text,uuid)') IS NOT NULL THEN
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
      FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.create_public_room_token(text,uuid)');
    IF v_md5 IS DISTINCT FROM '9b182ad493533270469d384a4c6d986f' THEN
      RAISE EXCEPTION 'create_public_room_token(text, uuid) KHÁC thân của file này (md5 %) — DỪNG', v_md5
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'Thiếu public.create_public_room_token' USING ERRCODE = '55000';
  END IF;

  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.log_public_room_events(text,jsonb)');
  -- [0] thân đang chạy production (20260902092508, đo 25/11/2026) · [1] thân của chính file này (lượt chạy lại).
  IF v_md5 IS NULL OR NOT (v_md5 = ANY (ARRAY['6793a043ee3eed5ab05e9f041eeeebdf', 'e8f80d246c4fd5c85b882dfc5ae34aac'])) THEN
    RAISE EXCEPTION 'log_public_room_events KHÁC thân đã rà (md5 %) — DỪNG, đối chiếu thân đang chạy', v_md5
      USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- 1. Ngân sách ngày của link: đếm cả dòng KHÔNG ghi được để lỗi không còn mất im lặng.
ALTER TABLE app_private.public_room_event_budgets
  ADD COLUMN IF NOT EXISTS so_loi integer NOT NULL DEFAULT 0 CHECK (so_loi >= 0),
  ADD COLUMN IF NOT EXISTS loi_cuoi_ma text CHECK (loi_cuoi_ma IS NULL OR loi_cuoi_ma ~ '^[0-9A-Z]{5}$'),
  ADD COLUMN IF NOT EXISTS loi_cuoi_luc timestamptz;

COMMENT ON COLUMN app_private.public_room_event_budgets.so_loi IS
'Số sự kiện log_public_room_events nhận nhưng KHÔNG ghi được trong ngày (dòng hỏng chỉ mất chính nó). Khác 0 là có lỗi cần xem; trước 25/11/2026 lỗi này bị nuốt im lặng.';
COMMENT ON COLUMN app_private.public_room_event_budgets.loi_cuoi_ma IS
'SQLSTATE của lần ghi hỏng gần nhất trong ngày (ví dụ 23502 thiếu organization_id, 22003 số quá lớn).';
COMMENT ON COLUMN app_private.public_room_event_budgets.loi_cuoi_luc IS
'Giờ của lần ghi hỏng gần nhất trong ngày.';

-- 2. Tạo link chia sẻ: công ty tường minh + kiểm thành viên + kiểm quyền.
DROP FUNCTION IF EXISTS public.create_public_room_token(text);

CREATE OR REPLACE FUNCTION public.create_public_room_token(p_label text DEFAULT NULL, p_organization_id uuid DEFAULT NULL)
RETURNS public.public_room_share_tokens
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_owner   uuid := auth.uid();
  v_orgs    uuid[];
  v_org     uuid := p_organization_id;
  candidate text;
  tries     int := 0;
  v_row     public.public_room_share_tokens;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501', HINT = 'Đăng nhập lại để tạo link chia sẻ.';
  END IF;

  -- Công ty của link: công ty người gọi đang chọn. Bản web cũ không gửi thì chỉ nhận khi người gọi thuộc đúng một
  -- công ty; không đoán thay người thuộc nhiều công ty.
  v_orgs := COALESCE(public.my_org_ids(), '{}'::uuid[]);
  IF v_org IS NULL THEN
    IF cardinality(v_orgs) = 1 THEN
      v_org := v_orgs[1];
    ELSIF cardinality(v_orgs) = 0 THEN
      RAISE EXCEPTION 'public_room_token_not_member' USING ERRCODE = '42501',
        HINT = 'Tài khoản không còn là thành viên đang hoạt động của công ty nào.';
    ELSE
      RAISE EXCEPTION 'public_room_token_org_required' USING ERRCODE = '22023',
        HINT = 'Tài khoản thuộc nhiều công ty: gửi p_organization_id của công ty đang chọn.';
    END IF;
  ELSIF NOT (v_org = ANY (v_orgs)) THEN
    RAISE EXCEPTION 'public_room_token_not_member' USING ERRCODE = '42501',
      HINT = 'Tài khoản không phải thành viên đang hoạt động của công ty này.';
  END IF;

  -- Quyền «Quản lý link chia sẻ» ở bất kỳ phạm vi nào của công ty (giao diện hiện tab theo đúng điều này).
  IF NOT (COALESCE(public.is_super_admin(), false) OR EXISTS (
    SELECT 1 FROM app_private.authorized_scope_v3('sale_phong.manage_tokens', v_org) s
     WHERE s.org_wide OR COALESCE(cardinality(s.building_ids), 0) > 0
  )) THEN
    RAISE EXCEPTION 'public_room_token_permission' USING ERRCODE = '42501',
      HINT = 'Cần quyền sale_phong.manage_tokens (Quản lý link chia sẻ) ở công ty này.';
  END IF;

  LOOP
    candidate := public.gen_contract_public_code(6);
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.public_room_share_tokens WHERE token = candidate
    );
    tries := tries + 1;
    IF tries >= 10 THEN
      candidate := public.gen_contract_public_code(8);
      EXIT;
    END IF;
  END LOOP;

  INSERT INTO public.public_room_share_tokens (token, owner_id, label, organization_id)
  VALUES (candidate, v_owner, NULLIF(btrim(coalesce(p_label, '')), ''), v_org)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

COMMENT ON FUNCTION public.create_public_room_token(text, uuid) IS
'Tạo 1 link chia sẻ /r/:token cho người gọi ở công ty p_organization_id (NULL ⇒ công ty duy nhất của người gọi; nhiều công ty ⇒ 22023). Kiểm thành viên ACTIVE (my_org_ids) và quyền sale_phong.manage_tokens (authorized_scope_v3, mọi phạm vi; super admin giữ đường cũ). Ghi organization_id tường minh — không để trg_autofill_org_strict đoán (25/11/2026). Mã base-57 6 ký tự, trùng 10 lần thì 8 ký tự.';

REVOKE ALL ON FUNCTION public.create_public_room_token(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_public_room_token(text, uuid) TO authenticated, service_role;

-- 3. Ghi sự kiện trang công khai: công ty lấy từ link, lỗi từng dòng được đếm.
CREATE OR REPLACE FUNCTION public.log_public_room_events(p_token text, p_events jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner   uuid;
  v_org     uuid;
  v_count   int := 0;
  v_loi     int := 0;
  v_loi_ma  text;
  v_meta    jsonb;
  r         record;
  v_ngay    date;
  v_da_ghi  int;
  v_con_lai int;
  c_tran    CONSTANT int := 5000;   -- dòng/token/ngày (PANALYTICS-C02)
  v_allowed CONSTANT text[] := ARRAY[
    'session','impression','building_select','view_mode','room_open','image_view',
    'floorplan_view','contact_click','share','download','directions','favorite',
    'deposit_dialog','error'
  ];
BEGIN
  IF p_token IS NULL OR p_token = '' THEN
    RETURN 0;
  END IF;

  -- Token phải tồn tại & chưa thu hồi → resolve owner_id VÀ công ty phía server.
  SELECT owner_id, organization_id INTO v_owner, v_org
  FROM public.public_room_share_tokens
  WHERE token = p_token AND revoked = false;
  IF v_owner IS NULL THEN
    RETURN 0;  -- token sai/thu hồi: no-op im lặng
  END IF;

  IF p_events IS NULL
     OR jsonb_typeof(p_events) <> 'array'
     OR jsonb_array_length(p_events) = 0 THEN
    RETURN 0;
  END IF;

  -- NGÂN SÁCH: đã dùng hết hạn mức ngày của token này thì dừng, im lặng.
  v_ngay := (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  INSERT INTO app_private.public_room_event_budgets (token, ngay, so_dong)
  VALUES (p_token, v_ngay, 0)
  ON CONFLICT (token, ngay) DO NOTHING;

  SELECT b.so_dong INTO v_da_ghi
    FROM app_private.public_room_event_budgets b
   WHERE b.token = p_token AND b.ngay = v_ngay;
  v_con_lai := c_tran - COALESCE(v_da_ghi, 0);
  IF v_con_lai <= 0 THEN
    RETURN 0;
  END IF;

  FOR r IN
    SELECT t.e
    FROM jsonb_array_elements(p_events) WITH ORDINALITY AS t(e, ord)
    WHERE t.ord <= LEAST(50, v_con_lai)            -- trần batch VÀ trần ngày còn lại
      AND jsonb_typeof(t.e) = 'object'
      AND NULLIF(t.e->>'session_id','') IS NOT NULL
      AND t.e->>'event_type' = ANY(v_allowed)      -- lọc event_type lạ (tránh CHECK abort)
  LOOP
    BEGIN
      v_meta := CASE
        WHEN r.e->'metadata' IS NULL OR jsonb_typeof(r.e->'metadata') <> 'object'
          THEN '{}'::jsonb
        WHEN length((r.e->'metadata')::text) > 8192
          -- Hạ cấp có chọn lọc: giữ đúng những khóa mà báo cáo cần để gộp nhóm.
          THEN jsonb_strip_nulls(jsonb_build_object(
                 'kind',      r.e->'metadata'->>'kind',
                 'msg',       left(r.e->'metadata'->>'msg', 500),
                 'fp',        r.e->'metadata'->>'fp',
                 'source',    r.e->'metadata'->>'source',
                 'n',         r.e->'metadata'->'n',
                 'is_staff',  r.e->'metadata'->'is_staff',
                 '_truncated', to_jsonb(true)
               ))
        ELSE r.e->'metadata'
      END;

      INSERT INTO public.public_room_events (
        token, owner_id, organization_id, session_id, event_type,
        room_id, room_name, room_code, building_id, building_name,
        duration_ms, dwell_ms, metadata, created_at
      )
      VALUES (
        p_token,
        v_owner,                                   -- server-resolved; bỏ qua client owner_id
        v_org,                                     -- công ty của LINK, không để trigger đoán từ owner_id
        left(NULLIF(r.e->>'session_id',''), 64),
        r.e->>'event_type',
        CASE WHEN (r.e->>'room_id')     ~ '^[0-9a-fA-F-]{36}$' THEN (r.e->>'room_id')::uuid     END,
        left(r.e->>'room_name', 200),
        left(r.e->>'room_code', 64),
        CASE WHEN (r.e->>'building_id') ~ '^[0-9a-fA-F-]{36}$' THEN (r.e->>'building_id')::uuid END,
        left(r.e->>'building_name', 200),
        CASE WHEN jsonb_typeof(r.e->'duration_ms')='number'
             THEN LEAST(GREATEST((r.e->>'duration_ms')::numeric::int, 0), 86400000) END,
        CASE WHEN jsonb_typeof(r.e->'dwell_ms')='number'
             THEN LEAST(GREATEST((r.e->>'dwell_ms')::numeric::int, 0), 86400000) END,
        v_meta,
        now()                                      -- tin đồng hồ server; bỏ qua client created_at
      );
      v_count := v_count + 1;
    EXCEPTION
      WHEN others THEN
        -- Dòng hỏng chỉ mất chính nó (không kéo theo cả batch), nhưng KHÔNG im lặng: đếm vào ngân sách ngày.
        v_loi := v_loi + 1;
        v_loi_ma := SQLSTATE;
    END;
  END LOOP;

  IF v_count > 0 OR v_loi > 0 THEN
    UPDATE app_private.public_room_event_budgets b
       SET so_dong = b.so_dong + v_count,
           so_loi = b.so_loi + v_loi,
           loi_cuoi_ma = COALESCE(v_loi_ma, b.loi_cuoi_ma),
           loi_cuoi_luc = CASE WHEN v_loi > 0 THEN now() ELSE b.loi_cuoi_luc END,
           updated_at = now()
     WHERE b.token = p_token AND b.ngay = v_ngay;
  END IF;

  IF v_loi > 0 THEN
    RAISE WARNING 'log_public_room_events: % sự kiện không ghi được (link %, SQLSTATE cuối %)', v_loi, p_token, v_loi_ma;
  END IF;

  RETURN v_count;
EXCEPTION
  WHEN others THEN
    RAISE WARNING 'log_public_room_events: bỏ cả lô (link %, SQLSTATE %)', p_token, SQLSTATE;
    RETURN 0;  -- không bao giờ lộ nội bộ cho anon
END;
$function$;

COMMENT ON FUNCTION public.log_public_room_events(text, jsonb) IS
'Anon batch logger cho /r/:token. Validate token (chưa revoke), resolve owner_id VÀ organization_id của link
server-side (ghi tường minh, 25/11/2026), cắt batch <=50, NGÂN SÁCH 5.000 dòng/token/ngày (VN) qua
app_private.public_room_event_budgets, clamp string/duration, lọc event_type lạ. Ghi TỪNG DÒNG trong
sub-transaction: dòng hỏng chỉ mất chính nó, batch vẫn sống, và được đếm vào budgets.so_loi + RAISE WARNING.
Metadata > 8192 ký tự bị hạ cấp còn kind/msg/fp/source/n để báo cáo vẫn gộp nhóm được. Trả số dòng ghi.
KHÔNG tin owner_id/organization_id/created_at từ client.';

REVOKE ALL ON FUNCTION public.log_public_room_events(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_public_room_events(text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_public_room_events(text, jsonb) TO service_role;

-- 4. Hậu kiểm: đúng một bản mỗi hàm, đúng thân của file này, đúng quyền gọi, đủ cột mới.
DO $sau$
DECLARE
  v_tao regprocedure := to_regprocedure('public.create_public_room_token(text,uuid)');
  v_log regprocedure := to_regprocedure('public.log_public_room_events(text,jsonb)');
BEGIN
  IF v_tao IS NULL OR (SELECT count(*) FROM pg_catalog.pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'create_public_room_token') <> 1 THEN
    RAISE EXCEPTION 'Hậu kiểm: public.create_public_room_token phải còn đúng một bản (text, uuid)' USING ERRCODE = '55000';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_catalog.pg_proc p WHERE p.oid = v_tao)
       IS DISTINCT FROM '9b182ad493533270469d384a4c6d986f'
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_catalog.pg_proc p WHERE p.oid = v_log)
       IS DISTINCT FROM 'e8f80d246c4fd5c85b882dfc5ae34aac' THEN
    RAISE EXCEPTION 'Hậu kiểm: thân hàm không phải bản của file này' USING ERRCODE = '55000';
  END IF;
  IF NOT has_function_privilege('authenticated', v_tao, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_tao, 'EXECUTE')
     OR has_function_privilege('anon', v_tao, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(p.proacl) AS g WHERE p.oid = v_tao AND g.grantee = 0) THEN
    RAISE EXCEPTION 'Hậu kiểm: quyền gọi create_public_room_token sai (authenticated, service_role; không anon/PUBLIC)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT has_function_privilege('anon', v_log, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_log, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(p.proacl) AS g WHERE p.oid = v_log AND g.grantee = 0) THEN
    RAISE EXCEPTION 'Hậu kiểm: quyền gọi log_public_room_events sai (anon, authenticated; không PUBLIC)'
      USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'app_private' AND table_name = 'public_room_event_budgets'
         AND column_name IN ('so_loi', 'loi_cuoi_ma', 'loi_cuoi_luc')) <> 3 THEN
    RAISE EXCEPTION 'Hậu kiểm: public_room_event_budgets thiếu cột đếm lỗi' USING ERRCODE = '55000';
  END IF;
END
$sau$;

NOTIFY pgrst, 'reload schema';
