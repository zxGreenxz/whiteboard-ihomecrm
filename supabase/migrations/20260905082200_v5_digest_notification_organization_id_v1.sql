-- =============================================================================
-- v5_digest_notification_organization_id_v1 — digest V5 phải ghi organization_id
-- Ngày 05/09/2026 · bịt GỐC lỗ rò biên giới tổ chức của notifications
-- =============================================================================
-- VẤN ĐỀ
--   public.v5_run_digest() (sinh ở 20260703000003_v5_jobs.sql, dòng 101-133)
--   INSERT vào public.notifications mà KHÔNG có organization_id. Trong công thức
--   biên giới tổ chức của repo này, organization_id IS NULL nghĩa là "MỌI công ty
--   đều thấy" — nên mỗi dòng digest NULL là một lỗ rò xuyên tenant, và gate
--   `node scripts/measure-org-leak.mjs` (CI Gates → security-gates) đỏ đúng vì
--   thế: "❌ N dòng organization_id NULL ở bảng CHƯA KHAI · ✗ notifications".
--
--   Cron chạy 00:00 UTC MỖI NGÀY, nên bản vá chỉ-dữ-liệu
--   20260904005929_fix_notifications_org_null_single_membership_v1.sql bị sinh lại
--   mỗi sáng — sáng nay lại có 2 dòng. Vá dữ liệu là băng dán; đây là migration
--   sửa chính HÀM GHI. Đóng known-gap `notifications-digest-org-null`.
--
-- QUYẾT ĐỊNH: DIGEST KHÔNG QUY ĐƯỢC TỔ CHỨC THÌ KHÔNG GỬI
--   Chỉ mục UNIQUE uq_notif_v5_digest (user_id, (metadata->>'date'))
--   WHERE (metadata->>'v5') = 'digest' cho phép ĐÚNG MỘT dòng digest mỗi người
--   mỗi ngày — không thể chẻ thành một dòng cho mỗi tổ chức. Nên hàm buộc phải
--   chọn MỘT org tất định: org của TOÀ CỦA VIỆC ĐẦU TIÊN trong tuyến
--   (v5_daily_missions trả building_id), dự phòng bằng membership khi người đó
--   thuộc ĐÚNG MỘT tổ chức ACTIVE.
--   Không quy được thì CONTINUE + RAISE NOTICE, TUYỆT ĐỐI không ghi dòng NULL:
--   mất bản tin của một người còn đỡ hơn để cả các công ty khác đọc được tuyến
--   làm việc của họ. Khoảng trống nhìn thấy trong log cron, không rò trong lặng lẽ.
--
-- TRIGGER AUTOFILL KHÔNG CỨU ĐƯỢC ĐƯỜNG NÀY (đã kiểm trên production)
--   public.notifications CÓ trigger BEFORE INSERT `a90_autofill_org` →
--   app_private.autofill_pre_notification_v1(). Nó suy org theo thứ tự
--   invoice_id → contract_id → app_private.single_org_of_user_v1(new.user_id).
--   Digest không có invoice/contract, còn single_org_of_user_v1 trả NULL khi
--   người đó thuộc ≥2 org (`having count(distinct organization_id) = 1`) — đúng
--   ca đang rò trên production. Trigger cũng không thể dựa vào auth.uid() vì
--   cron chạy như job KHÔNG có JWT. Vì thế phải sửa hàm ghi, không phải trigger.
--   (public._autofill_org() của 20260713121000 cũng không phủ: `notifications`
--   không nằm trong mảng `core text[]` của nó.)
--
-- GIỮ NGUYÊN
--   Cùng chữ ký, cùng RETURNS TABLE, SECURITY DEFINER, SET search_path = public,
--   nhánh EXCEPTION unique_violation, các trường RETURN NEXT, bỏ Chủ Nhật, bỏ
--   ngày phép-duyệt. Thân hàm sao từ BẢN ĐANG CHẠY TRÊN PRODUCTION
--   (md5(pg_get_functiondef) = 15c0726badcf75eb8c580a04088783ed) — bản chạy
--   KHÔNG lệch so với file 20260703000003, chỉ khác cách pg_get_functiondef
--   chuẩn hoá chữ. ACL phát lại đúng như production đang có:
--   proacl = {postgres=X/postgres,service_role=X/postgres}.
--
-- IDEMPOTENT · AN TOÀN TRÊN DB RỖNG
--   CREATE OR REPLACE; REVOKE/GRANT phát lại được; hai UPDATE vá dữ liệu chỉ
--   chạm dòng organization_id IS NULL nên lượt hai là 0 dòng; mọi thứ đọc bảng
--   đều nằm sau to_regclass/to_regrole/to_regprocedure để chạy được trên baseline
--   schema-only. Một BEGIN/COMMIT duy nhất.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- -----------------------------------------------------------------------------
-- 1) HÀM GHI: thêm quy-thuộc tổ chức trước khi INSERT
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.v5_run_digest()
RETURNS TABLE(user_id uuid, title text, body text, url text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $v5_run_digest$
DECLARE
  v_today DATE := public.vn_local_date(now());
  v_staff RECORD; v_m RECORD;
  v_lines TEXT; v_cnt INT;
  v_toa_dau UUID;   -- building_id của việc ĐẦU TIÊN trong tuyến
  v_org UUID;       -- tổ chức của bản tin — KHÔNG được NULL khi ghi
BEGIN
  IF EXTRACT(dow FROM v_today) = 0 THEN RETURN; END IF; -- CN nghỉ, không digest
  FOR v_staff IN SELECT DISTINCT sa.staff_id FROM public.staff_assignments sa WHERE sa.building_id IS NOT NULL LOOP
    -- ngày phép-duyệt: im lặng
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.salary_attendance_day d
      WHERE d.user_id = v_staff.staff_id AND d.work_date = v_today AND d.status IN ('leave_approved','pending_leave'));
    v_lines := ''; v_cnt := 0; v_toa_dau := NULL; v_org := NULL;
    FOR v_m IN SELECT * FROM public.v5_daily_missions(v_staff.staff_id) WHERE color IN ('red','yellow') LIMIT 3 LOOP
      v_cnt := v_cnt + 1;
      IF v_cnt = 1 THEN v_toa_dau := v_m.building_id; END IF;
      v_lines := v_lines || CASE WHEN v_lines = '' THEN '' ELSE E'\n' END || '• ' || v_m.building_name || ' — ' || v_m.reason;
    END LOOP;
    CONTINUE WHEN v_cnt = 0;

    -- Quy thuộc tổ chức: (a) toà của việc đầu tiên trong tuyến.
    IF v_toa_dau IS NOT NULL THEN
      SELECT b.organization_id INTO v_org FROM public.buildings b WHERE b.id = v_toa_dau;
    END IF;
    -- (b) dự phòng: người này thuộc ĐÚNG MỘT tổ chức ACTIVE thì lấy tổ chức đó.
    --     Mơ hồ (0 hoặc ≥2 tổ chức) thì để NULL — không đoán.
    IF v_org IS NULL THEN
      SELECT (array_agg(x.organization_id))[1] INTO v_org
        FROM (
          SELECT om.organization_id
            FROM public.organization_memberships om
           WHERE om.user_id = v_staff.staff_id AND om.status = 'ACTIVE'
           GROUP BY om.organization_id
          HAVING count(*) >= 1
        ) x
      HAVING count(*) = 1;
    END IF;
    -- Không quy được thì KHÔNG gửi: dòng organization_id NULL hiện với mọi tenant.
    IF v_org IS NULL THEN
      RAISE NOTICE 'v5_run_digest: bo digest cua staff % ngay % — khong quy duoc to chuc (toa dau %). Dong NULL se ro sang moi tenant nen khong ghi.',
        v_staff.staff_id, v_today, v_toa_dau;
      CONTINUE;
    END IF;

    BEGIN
      INSERT INTO public.notifications (user_id, organization_id, type, channel, status, subject, content, metadata)
      VALUES (v_staff.staff_id, v_org, 'CUSTOM', 'IN_APP', 'PENDING',
        'Tuyến hôm nay: ' || v_cnt || ' toà nên ghé', v_lines,
        jsonb_build_object('v5','digest','date', v_today, 'url', '/my-day'));
    EXCEPTION WHEN unique_violation THEN CONTINUE; -- đã digest hôm nay
    END;
    user_id := v_staff.staff_id;
    title := 'Tuyến hôm nay: ' || v_cnt || ' toà nên ghé';
    body := v_lines;
    url := '/my-day';
    RETURN NEXT;
  END LOOP;
END; $v5_run_digest$;

-- ACL phát lại y như production đang có (proacl {postgres=X,service_role=X}).
REVOKE ALL ON FUNCTION public.v5_run_digest() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v5_run_digest() TO service_role;

-- -----------------------------------------------------------------------------
-- 2) VÁ DỮ LIỆU (idempotent) — mọi dòng NULL do cron đã ghi từ 20260904005929
--    tới nay. Hai tầng, chạy đúng thứ tự quy-thuộc của hàm mới.
--
--    Vì sao cần TẦNG A, không chỉ luật của 20260904005929: 2 dòng đang rò trên
--    production đều thuộc một người có 2 membership ACTIVE, nên luật "đúng một
--    membership" quy được 0 dòng và gate vẫn đỏ. Toàn bộ toà người đó được phân
--    công lại chỉ thuộc MỘT tổ chức — đúng đường quy-thuộc (a) của hàm mới.
-- -----------------------------------------------------------------------------
DO $va_du_lieu$
DECLARE
  v_tang_a BIGINT := 0;
  v_tang_b BIGINT := 0;
BEGIN
  IF to_regclass('public.notifications') IS NULL
     OR to_regclass('public.staff_assignments') IS NULL
     OR to_regclass('public.buildings') IS NULL
     OR to_regclass('public.organization_memberships') IS NULL THEN
    RAISE NOTICE 'Bo va du lieu: baseline chua co bang can thiet (DB rong).';
    RETURN;
  END IF;

  -- TẦNG A — chỉ dòng DIGEST: org của các toà người đó được phân công, khi toàn
  -- bộ toà ấy thuộc CÙNG MỘT tổ chức. Giới hạn ở digest vì chỉ digest mới là
  -- "bản tin về tuyến của người đó"; suy org theo toà cho loại thông báo khác là đoán.
  UPDATE public.notifications n
     SET organization_id = m.organization_id
    FROM (
      SELECT sa.staff_id AS user_id,
             (array_agg(DISTINCT b.organization_id))[1] AS organization_id
        FROM public.staff_assignments sa
        JOIN public.buildings b ON b.id = sa.building_id
       WHERE b.organization_id IS NOT NULL
       GROUP BY sa.staff_id
      HAVING count(DISTINCT b.organization_id) = 1
    ) m
   WHERE n.organization_id IS NULL
     AND n.user_id = m.user_id
     AND (n.metadata->>'v5') = 'digest';
  GET DIAGNOSTICS v_tang_a = ROW_COUNT;

  -- TẦNG B — nguyên luật của 20260904005929: người có ĐÚNG MỘT membership ACTIVE.
  UPDATE public.notifications n
     SET organization_id = m.organization_id
    FROM (
      SELECT om.user_id, (array_agg(om.organization_id))[1] AS organization_id
        FROM public.organization_memberships om
       WHERE om.status = 'ACTIVE'
       GROUP BY om.user_id
      HAVING COUNT(*) = 1
    ) m
   WHERE n.organization_id IS NULL
     AND n.user_id = m.user_id;
  GET DIAGNOSTICS v_tang_b = ROW_COUNT;

  RAISE NOTICE 'Va organization_id: tang A (toa duoc phan cong) % dong · tang B (mot membership ACTIVE) % dong.',
    v_tang_a, v_tang_b;
END
$va_du_lieu$;

-- -----------------------------------------------------------------------------
-- 3) NGHIỆM THU — chỉ đọc catalog + đếm, không đổi gì thêm.
-- -----------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_src    TEXT;
  v_ret    TEXT;
  v_args   TEXT;
  v_secdef BOOLEAN;
  v_cfg    TEXT[];
  v_con    BIGINT;
BEGIN
  SELECT p.prosrc, pg_get_function_result(p.oid), pg_get_function_identity_arguments(p.oid),
         p.prosecdef, p.proconfig
    INTO v_src, v_ret, v_args, v_secdef, v_cfg
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'v5_run_digest';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'public.v5_run_digest() khong ton tai sau CREATE OR REPLACE. DUNG.';
  END IF;

  -- Chữ ký và thuộc tính bảo mật phải y nguyên
  IF coalesce(v_args, '') <> '' THEN
    RAISE EXCEPTION 'v5_run_digest doi chu ky: tham so "%" (phai rong). DUNG.', v_args;
  END IF;
  IF v_ret IS DISTINCT FROM 'TABLE(user_id uuid, title text, body text, url text)' THEN
    RAISE EXCEPTION 'v5_run_digest doi RETURNS TABLE: %. DUNG.', v_ret;
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'v5_run_digest mat SECURITY DEFINER. DUNG.';
  END IF;
  IF v_cfg IS NULL OR NOT ('search_path=public' = ANY (v_cfg)) THEN
    RAISE EXCEPTION 'v5_run_digest mat SET search_path=public (proconfig=%). DUNG.', v_cfg;
  END IF;

  -- Thân hàm: có điền organization_id VÀ có bỏ digest khi không quy được
  IF v_src NOT LIKE '%organization_id%' THEN
    RAISE EXCEPTION 'v5_run_digest van INSERT khong co organization_id. DUNG.';
  END IF;
  IF v_src NOT LIKE '%v_org IS NULL%' OR v_src NOT LIKE '%CONTINUE%' THEN
    RAISE EXCEPTION 'v5_run_digest thieu nhanh bo digest khi khong quy duoc to chuc. DUNG.';
  END IF;

  -- ACL: anon/authenticated KHÔNG EXECUTE, service_role PHẢI EXECUTE (cron cần)
  IF to_regprocedure('public.v5_run_digest()') IS NOT NULL THEN
    IF to_regrole('anon') IS NOT NULL
       AND has_function_privilege('anon', 'public.v5_run_digest()', 'EXECUTE') THEN
      RAISE EXCEPTION 'anon van EXECUTE duoc v5_run_digest. DUNG.';
    END IF;
    IF to_regrole('authenticated') IS NOT NULL
       AND has_function_privilege('authenticated', 'public.v5_run_digest()', 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated van EXECUTE duoc v5_run_digest. DUNG.';
    END IF;
    IF to_regrole('service_role') IS NOT NULL
       AND NOT has_function_privilege('service_role', 'public.v5_run_digest()', 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role mat EXECUTE tren v5_run_digest — cron se chet. DUNG.';
    END IF;
  END IF;

  -- Không còn dòng organization_id NULL nào QUY ĐƯỢC bằng hai tầng ở trên
  IF to_regclass('public.notifications') IS NOT NULL
     AND to_regclass('public.staff_assignments') IS NOT NULL
     AND to_regclass('public.buildings') IS NOT NULL
     AND to_regclass('public.organization_memberships') IS NOT NULL THEN
    SELECT count(*) INTO v_con
      FROM public.notifications n
     WHERE n.organization_id IS NULL
       AND (
         (
           (n.metadata->>'v5') = 'digest'
           AND EXISTS (
             SELECT 1 FROM (
               SELECT sa.staff_id AS user_id
                 FROM public.staff_assignments sa
                 JOIN public.buildings b ON b.id = sa.building_id
                WHERE b.organization_id IS NOT NULL
                GROUP BY sa.staff_id
               HAVING count(DISTINCT b.organization_id) = 1
             ) a WHERE a.user_id = n.user_id
           )
         )
         OR EXISTS (
           SELECT 1 FROM (
             SELECT om.user_id
               FROM public.organization_memberships om
              WHERE om.status = 'ACTIVE'
              GROUP BY om.user_id
             HAVING COUNT(*) = 1
           ) c WHERE c.user_id = n.user_id
         )
       );
    IF v_con > 0 THEN
      RAISE EXCEPTION 'Con % dong notifications organization_id NULL van quy duoc to chuc — va du lieu chua cham het. DUNG.', v_con;
    END IF;
  END IF;
END
$nghiem_thu$;

COMMIT;
