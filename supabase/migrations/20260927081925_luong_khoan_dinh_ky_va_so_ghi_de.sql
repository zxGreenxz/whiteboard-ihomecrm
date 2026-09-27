-- =============================================================================
-- luong_khoan_dinh_ky_va_so_ghi_de — Khoản định kỳ có phiên bản + số ghi đè từng
-- khoản lương (màn Lương & thu nhập). Ngày 27/09/2026 · chủ chốt trong ngày:
--   · Khoản định kỳ = quy tắc + phiên bản: "Sửa mức từ kỳ" / "Chỉ một kỳ" /
--     "Ngừng từ kỳ". Tính TRỌN kỳ: bắt đầu/ngừng giữa tháng không chia theo ngày.
--     Kỳ đã chốt không bao giờ đổi.
--   · Lương QL bổ sung của nhà không thuê-cho-thuê-lại (481NVK, 950NK, 44TL): ghi
--     MỘT lần thành khoản định kỳ gắn toà, nguồn = chủ công ty cấp. Khoản đó vừa là
--     dòng lương của người nhận, vừa là dòng "Chủ công ty cấp thêm" của Nguồn lương.
--     KHÔNG ghi vào thu chi của toà.
--   · Super admin + chủ công ty được sửa trực tiếp số tiền MỌI khoản thu nhập ở tab
--     Thu nhập & thanh toán, kể cả HH Sale và Thu nhập đồng hành (chấp nhận số trả
--     qua lương khác số ghi ở phiếu Sale / lợi nhuận toà). Lưu thành số ghi đè theo
--     (người, kỳ, khoản), bắt buộc lý do, giữ số máy tính để so; kỳ đã chốt khoá.
-- =============================================================================
-- VÌ SAO
--   Trước file này: phụ cấp cố định và "Bonus QL" phải gõ lại tay trong Thưởng mỗi
--   tháng (salary_adjustments chỉ có dòng theo kỳ, nhận loại bằng NHÃN), nguồn chủ
--   cấp không có chỗ lưu, và không có cách nào sửa một con số máy tính ra ngoài
--   bật/tắt từng việc. Màn lương hiện hai chỗ đó dưới dạng "bản xem trước".
--
-- LÀM GÌ
--   1. app_private.salary_recurring_items + _versions: quy tắc và phiên bản. Phiên
--      bản CHỈ GHI THÊM — lịch sử là bằng chứng. Mỗi bản CHANGE/STOP áp từ tháng
--      hiệu lực của nó tới bản kế tiếp; ONCE chỉ đúng tháng của nó và thắng nếu tạo
--      sau bản đang áp (xem app_private.salary_recurring_amount_v1).
--   2. app_private.salary_line_overrides: sổ ghi đè, chỉ ghi thêm; dòng MỚI NHẤT của
--      mỗi (người, kỳ, khoản) là số đang áp; amount NULL = bỏ ghi đè.
--   3. Đọc: salary_recurring_list_v1, salary_line_override_list_v1,
--      salary_can_edit_amounts_v1.
--   4. Ghi (chỉ super admin / chủ công ty của ĐÚNG tổ chức của người nhận lương, có
--      khoá idempotency): salary_recurring_create_v1, salary_recurring_version_add_v1,
--      salary_recurring_delete_v1, salary_line_override_set_v1.
--   5. Cho chủ công ty ĐỌC bảng lương có sẵn của đúng công ty (mục 8) — trước file
--      này chỉ người tạo dòng / super admin / chính nhân viên đọc được.
--
-- KỲ ĐÃ CHỐT
--   Ghi: từ chối mọi phiên bản/ghi đè chạm kỳ LOCKED của người đó.
--   Đọc: với kỳ LOCKED chỉ tính phiên bản/ghi đè tạo TRƯỚC locked_at. RPC chốt kỳ
--   dùng số client gửi (R1), nên một bản ghi lọt vào đúng khoảnh khắc chốt không
--   được phép đổi số hiển thị của kỳ đã chốt.
--
-- KHÔNG ĐỤNG
--   Không sửa salary_monthly, salary_adjustments, phiếu, sổ quỹ, hoá đơn hay RPC
--   chốt/chi lương. Số ghi đè và khoản định kỳ đi vào số client gửi cho hai RPC đó.
--
-- ĐƯỜNG LÙI
--   REVOKE EXECUTE bảy RPC public khỏi authenticated. Ba bảng để nguyên (không writer
--   nào khác đọc). Client thiếu RPC (PGRST202/42883) thì coi như chưa bật tính năng.
--   Policy đọc của chủ công ty: DROP POLICY <bảng>_company_owner_select.
--
-- Chạy được hai lượt liên tiếp và trên DB rỗng của Restore Drill.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Nền phải có.
DO $truoc$
BEGIN
  IF to_regprocedure('app_private.ie_actor_is_company_owner_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.ie_actor_is_company_owner_v1' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('app_private.v5_can_view_salary_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.v5_can_view_salary_v1' USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.salary_monthly') IS NULL OR to_regclass('public.manager_salary_config') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng lương nền (salary_monthly / manager_salary_config)' USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Khoản định kỳ — quy tắc.
CREATE TABLE IF NOT EXISTS app_private.salary_recurring_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  staff_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  label           text NOT NULL CHECK (btrim(label) <> '' AND char_length(label) <= 120),
  -- ALLOWANCE = phụ cấp, trả từ quỹ lương vận hành
  -- SUPPLEMENTARY = lương QL bổ sung, CHỦ CÔNG TY cấp, gắn một toà
  category        text NOT NULL CHECK (category IN ('ALLOWANCE','SUPPLEMENTARY')),
  building_id     uuid REFERENCES public.buildings(id) ON DELETE RESTRICT,
  note            text,
  request_key     text NOT NULL,
  request_hash    text NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at      timestamptz,
  deleted_by      uuid,
  delete_reason   text,
  CHECK (category <> 'SUPPLEMENTARY' OR building_id IS NOT NULL),
  CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS salary_recurring_items_request
  ON app_private.salary_recurring_items (created_by, request_key);
CREATE INDEX IF NOT EXISTS salary_recurring_items_org_staff
  ON app_private.salary_recurring_items (organization_id, staff_id)
  WHERE deleted_at IS NULL;

-- 2. Phiên bản — chỉ ghi thêm. seq quyết định "tạo sau cùng" một cách tất định.
CREATE TABLE IF NOT EXISTS app_private.salary_recurring_item_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  item_id         uuid NOT NULL REFERENCES app_private.salary_recurring_items(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  -- CHANGE = "Sửa mức từ kỳ" · ONCE = "Chỉ một kỳ" · STOP = "Ngừng từ kỳ"
  kind            text NOT NULL CHECK (kind IN ('CHANGE','ONCE','STOP')),
  effective_month date NOT NULL CHECK (effective_month = date_trunc('month', effective_month)::date),
  amount          numeric(14,2),
  reason          text NOT NULL CHECK (btrim(reason) <> ''),
  request_key     text NOT NULL,
  request_hash    text NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'STOP') = (amount IS NULL)),
  CHECK (amount IS NULL OR (amount > 0 AND amount = round(amount)))
);
CREATE UNIQUE INDEX IF NOT EXISTS salary_recurring_item_versions_request
  ON app_private.salary_recurring_item_versions (created_by, request_key);
CREATE INDEX IF NOT EXISTS salary_recurring_item_versions_item
  ON app_private.salary_recurring_item_versions (item_id, seq);

-- 3. Sổ ghi đè số tiền từng khoản — chỉ ghi thêm; dòng mới nhất mỗi khoá là số áp.
CREATE TABLE IF NOT EXISTS app_private.salary_line_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  staff_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  period_month    date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  -- base · streak · ot · contract · job:<nhãn> · rec:<khoản định kỳ>
  -- · sale:<phiếu Sale nguồn> · dh:<toà> (khớp khoá dòng ở client)
  line_key        text NOT NULL CHECK (line_key ~ '^(base|streak|ot|contract|job:.{1,200}|rec:[0-9a-f-]{36}|sale:[0-9a-f-]{36}|dh:.{1,200})$'),
  line_label      text NOT NULL CHECK (btrim(line_label) <> ''),
  computed_amount numeric(14,2) NOT NULL,
  -- NULL = bỏ ghi đè, về lại số máy tính
  amount          numeric(14,2) CHECK (amount IS NULL OR amount = round(amount)),
  reason          text NOT NULL CHECK (btrim(reason) <> ''),
  request_key     text NOT NULL,
  request_hash    text NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS salary_line_overrides_request
  ON app_private.salary_line_overrides (created_by, request_key);
CREATE INDEX IF NOT EXISTS salary_line_overrides_ky
  ON app_private.salary_line_overrides (organization_id, period_month, staff_id, line_key, seq);

REVOKE ALL ON app_private.salary_recurring_items,
              app_private.salary_recurring_item_versions,
              app_private.salary_line_overrides
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.salary_recurring_items IS
  'Khoản lương định kỳ (phụ cấp / lương QL bổ sung do chủ công ty cấp, gắn toà). Số tiền nằm ở _versions. Chủ chốt 27/09/2026.';
COMMENT ON TABLE app_private.salary_recurring_item_versions IS
  'Phiên bản khoản định kỳ, chỉ ghi thêm. Kỳ P: nền = CHANGE/STOP có effective_month lớn nhất <= P (cùng tháng lấy seq lớn); ONCE đúng tháng P thắng nếu seq lớn hơn nền. Kỳ đã chốt chỉ xét phiên bản tạo trước locked_at.';
COMMENT ON TABLE app_private.salary_line_overrides IS
  'Số ghi đè từng khoản lương (super admin / chủ công ty), chỉ ghi thêm. Dòng seq lớn nhất của mỗi (staff, kỳ, line_key) là số áp; amount NULL = bỏ ghi đè. Kỳ đã chốt chỉ xét dòng tạo trước locked_at.';

-- ---------------------------------------------------------------------------
-- 4. Hàm nội bộ.

-- Số tiền của một khoản định kỳ cho một kỳ P. NULL = chưa có phiên bản nào phủ P
-- (khoản bắt đầu sau). p_as_of: chỉ xét phiên bản tạo từ trước mốc này (kỳ đã chốt).
--   · Nền = bản CHANGE/STOP có tháng hiệu lực LỚN NHẤT ≤ P (cùng tháng: bản tạo sau).
--     Mỗi bản áp từ tháng của nó tới bản kế tiếp — giống giá phí công bố
--     (special_fee_price_versions), nên "Ngừng từ 12" rồi "Sửa mức từ 10" vẫn ngừng ở 12.
--   · ONCE đúng tháng P thắng nền nếu tạo SAU bản nền (quyết định mới hơn về P).
--   · Client tính y hệt ở src/lib/salaryRecurring.ts (khung "Tác động").
CREATE OR REPLACE FUNCTION app_private.salary_recurring_amount_v1(
  p_item uuid, p_period date, p_as_of timestamptz DEFAULT NULL)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  WITH v AS (
    SELECT x.kind, x.effective_month, x.amount, x.seq
      FROM app_private.salary_recurring_item_versions x
     WHERE x.item_id = p_item
       AND (p_as_of IS NULL OR x.created_at <= p_as_of)
  ), nen AS (
    SELECT v.kind, v.amount, v.seq FROM v
     WHERE v.kind IN ('CHANGE','STOP')
       AND v.effective_month <= date_trunc('month', p_period)::date
     ORDER BY v.effective_month DESC, v.seq DESC
     LIMIT 1
  ), mot_ky AS (
    SELECT v.amount, v.seq FROM v
     WHERE v.kind = 'ONCE'
       AND v.effective_month = date_trunc('month', p_period)::date
     ORDER BY v.seq DESC
     LIMIT 1
  )
  SELECT CASE
           WHEN o.seq IS NOT NULL AND (n.seq IS NULL OR o.seq > n.seq) THEN o.amount
           WHEN n.seq IS NULL THEN NULL
           WHEN n.kind = 'STOP' THEN 0
           ELSE n.amount
         END
    FROM (SELECT 1) AS mot
    LEFT JOIN nen n ON true
    LEFT JOIN mot_ky o ON true;
$fn$;

-- Tổ chức của người nhận lương — cùng cách salary_payout_v1 suy ra (theo người
-- nhận, không theo người bấm).
CREATE OR REPLACE FUNCTION app_private.salary_staff_org_v1(p_staff uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT COALESCE(
    (SELECT c.organization_id FROM public.manager_salary_config c
      WHERE c.staff_id = p_staff AND c.organization_id IS NOT NULL
      ORDER BY c.is_active DESC, c.created_at DESC LIMIT 1),
    (SELECT m.organization_id FROM public.organization_memberships m
      WHERE m.user_id = p_staff AND m.status = 'ACTIVE' LIMIT 1));
$fn$;

-- Người sửa số tiền lương: super admin hoặc chủ công ty của đúng tổ chức.
CREATE OR REPLACE FUNCTION app_private.salary_amount_editor_ok_v1(p_org uuid, p_actor uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT p_org IS NOT NULL AND p_actor IS NOT NULL
     AND (public.is_super_admin() OR app_private.ie_actor_is_company_owner_v1(p_org, p_actor));
$fn$;

-- Chuẩn hoá khoá idempotency (cùng luật với salary_payout_v1).
CREATE OR REPLACE FUNCTION app_private.salary_request_key_v1(p_key text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE v text := btrim(coalesce(p_key, ''));
BEGIN
  IF v !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Khoá idempotency phải dài 8-200 ký tự ASCII an toàn' USING ERRCODE = '22023';
  END IF;
  RETURN v;
END
$fn$;

REVOKE ALL ON FUNCTION app_private.salary_recurring_amount_v1(uuid, date, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.salary_staff_org_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.salary_amount_editor_ok_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.salary_request_key_v1(text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Đọc.

CREATE OR REPLACE FUNCTION public.salary_can_edit_amounts_v1(p_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
  SELECT app_private.salary_amount_editor_ok_v1(p_organization_id, auth.uid());
$fn$;

CREATE OR REPLACE FUNCTION public.salary_recurring_list_v1(
  p_organization_id uuid,
  p_period_month    date)
RETURNS TABLE (
  item_id           uuid,
  staff_id          uuid,
  staff_name        text,
  label             text,
  category          text,
  building_id       uuid,
  building_name     text,
  note              text,
  created_at        timestamptz,
  amount_for_period numeric,
  period_locked     boolean,
  versions          jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor  uuid := auth.uid();
  v_thang  date;
  v_editor boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL OR p_period_month IS NULL THEN
    RAISE EXCEPTION 'Thiếu tổ chức hoặc kỳ lương' USING ERRCODE = '22023';
  END IF;
  v_thang  := date_trunc('month', p_period_month)::date;
  v_editor := app_private.salary_amount_editor_ok_v1(p_organization_id, v_actor);

  RETURN QUERY
  SELECT i.id, i.staff_id, p.full_name, i.label, i.category, i.building_id, b.name, i.note,
         i.created_at,
         COALESCE(app_private.salary_recurring_amount_v1(i.id, v_thang, sm.locked_at), 0),
         (sm.id IS NOT NULL),
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'id', v.id, 'seq', v.seq, 'kind', v.kind,
                    'effective_month', v.effective_month, 'amount', v.amount,
                    'reason', v.reason, 'created_by', v.created_by,
                    'created_by_name', pv.full_name, 'created_at', v.created_at)
                  ORDER BY v.seq)
             FROM app_private.salary_recurring_item_versions v
             LEFT JOIN public.profiles pv ON pv.id = v.created_by
            WHERE v.item_id = i.id), '[]'::jsonb)
    FROM app_private.salary_recurring_items i
    LEFT JOIN public.profiles p ON p.id = i.staff_id
    LEFT JOIN public.buildings b ON b.id = i.building_id
    LEFT JOIN public.salary_monthly sm
           ON sm.staff_id = i.staff_id AND sm.period_month = v_thang AND sm.status = 'LOCKED'
   WHERE i.organization_id = p_organization_id
     AND i.deleted_at IS NULL
     AND (v_editor OR app_private.v5_can_view_salary_v1(i.staff_id))
   ORDER BY p.full_name NULLS LAST, i.created_at, i.id;
END
$fn$;

CREATE OR REPLACE FUNCTION public.salary_line_override_list_v1(
  p_organization_id uuid,
  p_period_month    date)
RETURNS TABLE (
  staff_id        uuid,
  line_key        text,
  line_label      text,
  computed_amount numeric,
  amount          numeric,
  reason          text,
  created_by      uuid,
  created_by_name text,
  created_at      timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor  uuid := auth.uid();
  v_thang  date;
  v_editor boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL OR p_period_month IS NULL THEN
    RAISE EXCEPTION 'Thiếu tổ chức hoặc kỳ lương' USING ERRCODE = '22023';
  END IF;
  v_thang  := date_trunc('month', p_period_month)::date;
  v_editor := app_private.salary_amount_editor_ok_v1(p_organization_id, v_actor);

  RETURN QUERY
  SELECT x.staff_id, x.line_key, x.line_label, x.computed_amount, x.amount,
         x.reason, x.created_by, x.created_by_name, x.created_at
    FROM (
      SELECT DISTINCT ON (o.staff_id, o.line_key)
             o.staff_id, o.line_key, o.line_label, o.computed_amount, o.amount,
             o.reason, o.created_by, pc.full_name AS created_by_name, o.created_at
        FROM app_private.salary_line_overrides o
        LEFT JOIN public.profiles pc ON pc.id = o.created_by
        LEFT JOIN public.salary_monthly sm
               ON sm.staff_id = o.staff_id AND sm.period_month = o.period_month
              AND sm.status = 'LOCKED'
       WHERE o.organization_id = p_organization_id
         AND o.period_month = v_thang
         AND (sm.locked_at IS NULL OR o.created_at <= sm.locked_at)
         AND (v_editor OR app_private.v5_can_view_salary_v1(o.staff_id))
       ORDER BY o.staff_id, o.line_key, o.seq DESC
    ) x
   WHERE x.amount IS NOT NULL
   ORDER BY x.staff_id, x.line_key;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Ghi — chỉ super admin / chủ công ty của đúng tổ chức người nhận lương.

CREATE OR REPLACE FUNCTION public.salary_recurring_create_v1(
  p_staff_id        uuid,
  p_label           text,
  p_category        text,
  p_building_id     uuid,
  p_amount          numeric,
  p_effective_month date,
  p_reason          text,
  p_note            text,
  p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_key   text;
  v_hash  text;
  v_thang date;
  v_item  uuid;
  v_ver   uuid;
  v_cu    record;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  v_key := app_private.salary_request_key_v1(p_idempotency_key);
  v_org := app_private.salary_staff_org_v1(p_staff_id);
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Không xác định được tổ chức của nhân viên' USING ERRCODE = '42501';
  END IF;
  IF NOT app_private.salary_amount_editor_ok_v1(v_org, v_actor) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được đặt khoản lương định kỳ'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.manager_salary_config c
                  WHERE c.staff_id = p_staff_id AND c.organization_id = v_org) THEN
    RAISE EXCEPTION 'Người này chưa có cấu hình hưởng lương trong công ty' USING ERRCODE = '22023';
  END IF;
  IF p_label IS NULL OR btrim(p_label) = '' OR char_length(btrim(p_label)) > 120 THEN
    RAISE EXCEPTION 'Tên khoản trống hoặc quá dài' USING ERRCODE = '22023';
  END IF;
  IF p_category NOT IN ('ALLOWANCE','SUPPLEMENTARY') THEN
    RAISE EXCEPTION 'Loại khoản không hợp lệ: %', p_category USING ERRCODE = '22023';
  END IF;
  IF p_category = 'SUPPLEMENTARY' AND p_building_id IS NULL THEN
    RAISE EXCEPTION 'Lương QL bổ sung phải gắn một toà' USING ERRCODE = '22023';
  END IF;
  IF p_building_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.buildings b
        WHERE b.id = p_building_id AND b.organization_id = v_org AND b.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Toà không thuộc công ty của người nhận lương' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount) THEN
    RAISE EXCEPTION 'Mức tiền phải là số đồng nguyên dương' USING ERRCODE = '22023';
  END IF;
  IF p_effective_month IS NULL THEN
    RAISE EXCEPTION 'Thiếu kỳ áp dụng' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Phải ghi lý do' USING ERRCODE = '22023';
  END IF;
  v_thang := date_trunc('month', p_effective_month)::date;

  v_hash := md5(jsonb_build_object('staff', p_staff_id, 'label', btrim(p_label),
    'category', p_category, 'building', p_building_id, 'amount', p_amount,
    'month', v_thang, 'reason', btrim(p_reason), 'note', NULLIF(btrim(p_note), ''))::text);
  SELECT i.id, i.request_hash INTO v_cu
    FROM app_private.salary_recurring_items i
   WHERE i.created_by = v_actor AND i.request_key = v_key;
  IF FOUND THEN
    IF v_cu.request_hash <> v_hash THEN
      RAISE EXCEPTION 'Khoá idempotency đã dùng cho một nội dung khác' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('item_id', v_cu.id, 'lap_lai', true);
  END IF;

  -- Khoản mới phủ mọi kỳ ≥ kỳ áp dụng ⇒ không được có kỳ đã chốt nào trong đó.
  IF EXISTS (SELECT 1 FROM public.salary_monthly sm
              WHERE sm.staff_id = p_staff_id AND sm.status = 'LOCKED' AND sm.period_month >= v_thang) THEN
    RAISE EXCEPTION 'Kỳ % hoặc sau đó đã chốt lương — chọn kỳ áp dụng sau kỳ đã chốt', to_char(v_thang, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app_private.salary_recurring_items
    (organization_id, staff_id, label, category, building_id, note, request_key, request_hash, created_by)
  VALUES
    (v_org, p_staff_id, btrim(p_label), p_category, p_building_id, NULLIF(btrim(p_note), ''),
     v_key, v_hash, v_actor)
  RETURNING id INTO v_item;

  INSERT INTO app_private.salary_recurring_item_versions
    (item_id, organization_id, kind, effective_month, amount, reason, request_key, request_hash, created_by)
  VALUES
    (v_item, v_org, 'CHANGE', v_thang, p_amount, btrim(p_reason), v_key, v_hash, v_actor)
  RETURNING id INTO v_ver;

  RETURN jsonb_build_object('item_id', v_item, 'version_id', v_ver, 'lap_lai', false);
END
$fn$;

CREATE OR REPLACE FUNCTION public.salary_recurring_version_add_v1(
  p_item_id         uuid,
  p_kind            text,
  p_effective_month date,
  p_amount          numeric,
  p_reason          text,
  p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_item  app_private.salary_recurring_items%ROWTYPE;
  v_key   text;
  v_hash  text;
  v_thang date;
  v_ver   uuid;
  v_cu    record;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  v_key := app_private.salary_request_key_v1(p_idempotency_key);
  SELECT * INTO v_item FROM app_private.salary_recurring_items i
   WHERE i.id = p_item_id AND i.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy khoản định kỳ' USING ERRCODE = '42501';
  END IF;
  IF NOT app_private.salary_amount_editor_ok_v1(v_item.organization_id, v_actor) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được sửa khoản lương định kỳ'
      USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('CHANGE','ONCE','STOP') THEN
    RAISE EXCEPTION 'Loại thay đổi không hợp lệ: %', p_kind USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'STOP' AND p_amount IS NOT NULL THEN
    RAISE EXCEPTION 'Ngừng từ kỳ không kèm số tiền' USING ERRCODE = '22023';
  END IF;
  IF p_kind <> 'STOP' AND (p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount)) THEN
    RAISE EXCEPTION 'Mức tiền phải là số đồng nguyên dương' USING ERRCODE = '22023';
  END IF;
  IF p_effective_month IS NULL THEN
    RAISE EXCEPTION 'Thiếu kỳ áp dụng' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Phải ghi lý do' USING ERRCODE = '22023';
  END IF;
  v_thang := date_trunc('month', p_effective_month)::date;

  v_hash := md5(jsonb_build_object('item', p_item_id, 'kind', p_kind, 'month', v_thang,
    'amount', p_amount, 'reason', btrim(p_reason))::text);
  SELECT v.id, v.request_hash INTO v_cu
    FROM app_private.salary_recurring_item_versions v
   WHERE v.created_by = v_actor AND v.request_key = v_key;
  IF FOUND THEN
    IF v_cu.request_hash <> v_hash THEN
      RAISE EXCEPTION 'Khoá idempotency đã dùng cho một nội dung khác' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('version_id', v_cu.id, 'lap_lai', true);
  END IF;

  -- CHANGE/STOP phủ mọi kỳ ≥ tháng hiệu lực; ONCE chỉ phủ đúng tháng đó.
  IF EXISTS (SELECT 1 FROM public.salary_monthly sm
              WHERE sm.staff_id = v_item.staff_id AND sm.status = 'LOCKED'
                AND (sm.period_month = v_thang OR (p_kind <> 'ONCE' AND sm.period_month > v_thang))) THEN
    RAISE EXCEPTION 'Thay đổi chạm kỳ lương đã chốt — kỳ đã chốt không bao giờ tính lại'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app_private.salary_recurring_item_versions
    (item_id, organization_id, kind, effective_month, amount, reason, request_key, request_hash, created_by)
  VALUES
    (p_item_id, v_item.organization_id, p_kind, v_thang, p_amount, btrim(p_reason), v_key, v_hash, v_actor)
  RETURNING id INTO v_ver;

  RETURN jsonb_build_object('version_id', v_ver, 'lap_lai', false);
END
$fn$;

-- Xoá (nhập nhầm): chỉ khi khoản CHƯA từng phủ kỳ đã chốt nào. Đã dùng rồi thì
-- phải "Ngừng từ kỳ" để giữ lịch sử của kỳ đã chốt.
CREATE OR REPLACE FUNCTION public.salary_recurring_delete_v1(
  p_item_id uuid,
  p_reason  text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_item  app_private.salary_recurring_items%ROWTYPE;
  v_dau   date;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_item FROM app_private.salary_recurring_items i WHERE i.id = p_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy khoản định kỳ' USING ERRCODE = '42501';
  END IF;
  IF NOT app_private.salary_amount_editor_ok_v1(v_item.organization_id, v_actor) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xoá khoản lương định kỳ'
      USING ERRCODE = '42501';
  END IF;
  IF v_item.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('item_id', v_item.id, 'lap_lai', true);
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Phải ghi lý do' USING ERRCODE = '22023';
  END IF;
  SELECT min(v.effective_month) INTO v_dau
    FROM app_private.salary_recurring_item_versions v WHERE v.item_id = v_item.id;
  IF EXISTS (SELECT 1 FROM public.salary_monthly sm
              WHERE sm.staff_id = v_item.staff_id AND sm.status = 'LOCKED'
                AND sm.period_month >= COALESCE(v_dau, DATE '1900-01-01')) THEN
    RAISE EXCEPTION 'Khoản đã áp vào kỳ lương đã chốt — dùng "Ngừng từ kỳ" thay vì xoá'
      USING ERRCODE = '55000';
  END IF;

  UPDATE app_private.salary_recurring_items
     SET deleted_at = clock_timestamp(), deleted_by = v_actor, delete_reason = btrim(p_reason)
   WHERE id = v_item.id AND deleted_at IS NULL;

  RETURN jsonb_build_object('item_id', v_item.id, 'lap_lai', false);
END
$fn$;

CREATE OR REPLACE FUNCTION public.salary_line_override_set_v1(
  p_staff_id        uuid,
  p_period_month    date,
  p_line_key        text,
  p_line_label      text,
  p_computed_amount numeric,
  p_amount          numeric,
  p_reason          text,
  p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_key   text;
  v_hash  text;
  v_thang date;
  v_id    uuid;
  v_cu    record;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  v_key := app_private.salary_request_key_v1(p_idempotency_key);
  v_org := app_private.salary_staff_org_v1(p_staff_id);
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Không xác định được tổ chức của nhân viên' USING ERRCODE = '42501';
  END IF;
  IF NOT app_private.salary_amount_editor_ok_v1(v_org, v_actor) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được sửa số tiền lương'
      USING ERRCODE = '42501';
  END IF;
  IF p_period_month IS NULL THEN
    RAISE EXCEPTION 'Thiếu kỳ lương' USING ERRCODE = '22023';
  END IF;
  IF p_line_key IS NULL
     OR p_line_key !~ '^(base|streak|ot|contract|job:.{1,200}|rec:[0-9a-f-]{36}|sale:[0-9a-f-]{36}|dh:.{1,200})$' THEN
    RAISE EXCEPTION 'Khoản lương không sửa được: %', p_line_key USING ERRCODE = '22023';
  END IF;
  IF p_line_label IS NULL OR btrim(p_line_label) = '' THEN
    RAISE EXCEPTION 'Thiếu tên khoản' USING ERRCODE = '22023';
  END IF;
  IF p_computed_amount IS NULL OR p_computed_amount <> round(p_computed_amount, 2) THEN
    RAISE EXCEPTION 'Số máy tính không hợp lệ' USING ERRCODE = '22023';
  END IF;
  -- Số âm chỉ có nghĩa ở phần phân bổ lợi nhuận (toà lỗ); khoản khác là tiền trả.
  IF p_amount IS NOT NULL AND (p_amount <> round(p_amount)
       OR (p_amount < 0 AND p_line_key !~ '^dh:')) THEN
    RAISE EXCEPTION 'Số tiền mới phải là số đồng nguyên%', CASE WHEN p_line_key ~ '^dh:' THEN '' ELSE ' không âm' END
      USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Phải ghi lý do' USING ERRCODE = '22023';
  END IF;
  v_thang := date_trunc('month', p_period_month)::date;

  v_hash := md5(jsonb_build_object('staff', p_staff_id, 'month', v_thang, 'key', p_line_key,
    'amount', p_amount, 'computed', p_computed_amount, 'reason', btrim(p_reason))::text);
  SELECT o.id, o.request_hash INTO v_cu
    FROM app_private.salary_line_overrides o
   WHERE o.created_by = v_actor AND o.request_key = v_key;
  IF FOUND THEN
    IF v_cu.request_hash <> v_hash THEN
      RAISE EXCEPTION 'Khoá idempotency đã dùng cho một nội dung khác' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('override_id', v_cu.id, 'lap_lai', true);
  END IF;

  IF EXISTS (SELECT 1 FROM public.salary_monthly sm
              WHERE sm.staff_id = p_staff_id AND sm.period_month = v_thang AND sm.status = 'LOCKED') THEN
    RAISE EXCEPTION 'Kỳ % đã chốt lương — mở khoá kỳ trước khi sửa số tiền', to_char(v_thang, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app_private.salary_line_overrides
    (organization_id, staff_id, period_month, line_key, line_label, computed_amount, amount,
     reason, request_key, request_hash, created_by)
  VALUES
    (v_org, p_staff_id, v_thang, p_line_key, btrim(p_line_label), p_computed_amount, p_amount,
     btrim(p_reason), v_key, v_hash, v_actor)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('override_id', v_id, 'lap_lai', false);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 7. Quyền gọi.
REVOKE ALL ON FUNCTION public.salary_can_edit_amounts_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salary_can_edit_amounts_v1(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.salary_recurring_list_v1(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salary_recurring_list_v1(uuid, date) TO authenticated;
REVOKE ALL ON FUNCTION public.salary_line_override_list_v1(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salary_line_override_list_v1(uuid, date) TO authenticated;
REVOKE ALL ON FUNCTION public.salary_recurring_create_v1(uuid, text, text, uuid, numeric, date, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salary_recurring_create_v1(uuid, text, text, uuid, numeric, date, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.salary_recurring_version_add_v1(uuid, text, date, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salary_recurring_version_add_v1(uuid, text, date, numeric, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.salary_recurring_delete_v1(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salary_recurring_delete_v1(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.salary_line_override_set_v1(uuid, date, text, text, numeric, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salary_line_override_set_v1(uuid, date, text, text, numeric, numeric, text, text) TO authenticated;

COMMENT ON FUNCTION public.salary_line_override_set_v1(uuid, date, text, text, numeric, numeric, text, text) IS
  'Super admin / chủ công ty ghi đè số tiền một khoản lương của (người, kỳ). p_amount NULL = bỏ ghi đè. Kỳ đã chốt từ chối. Chủ chốt 27/09/2026.';
COMMENT ON FUNCTION public.salary_recurring_create_v1(uuid, text, text, uuid, numeric, date, text, text, text) IS
  'Super admin / chủ công ty tạo khoản lương định kỳ (phụ cấp hoặc lương QL bổ sung gắn toà) kèm phiên bản đầu. Chủ chốt 27/09/2026.';

-- ---------------------------------------------------------------------------
-- 8. Chủ công ty ĐỌC bảng lương của CÔNG TY MÌNH.
--    Đo production 27/09/2026 (chỉ đọc): 2/2 dòng manager_salary_config có user_id =
--    tài khoản hệ thống; policy *_owner_all chỉ mở cho auth.uid() = user_id, is_admin()
--    (= super admin) hoặc chính nhân viên. Đo trên TEST: tài khoản "Chủ công ty" (không
--    phải super admin) đọc được 0 cấu hình / 0 kỳ / 0 khoản ⇒ /finance/salary báo "Chưa
--    có quản lý hưởng lương", nên yêu cầu "chủ công ty sửa số tiền" không dùng được.
--    Thêm MỘT policy PERMISSIVE **FOR SELECT** cho mỗi bảng lương, theo đúng tổ chức mà
--    người gọi là chủ công ty (app_private.my_company_owner_org_ids_v1 — helper dựng cho
--    RLS). CHỈ ĐỌC, theo đúng bất biến của helper này (chuCongTyDocSoQuyMigration.test:
--    "không policy ghi nào dựa vào helper"): mọi thao tác ghi của chủ công ty đi qua RPC
--    có cổng (mục 6), không ghi thẳng bảng. RESTRICTIVE *_org_boundary /
--    *_hide_sandbox_admin giữ nguyên.
--    Đường lùi: DROP POLICY <bảng>_company_owner_select.
DO $chu_cong_ty$
DECLARE
  t text;
BEGIN
  IF to_regprocedure('app_private.my_company_owner_org_ids_v1()') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.my_company_owner_org_ids_v1' USING ERRCODE = '55000';
  END IF;
  FOREACH t IN ARRAY ARRAY['manager_salary_config','salary_monthly','salary_adjustments',
                           'salary_work_ledger_snapshot','salary_bonus_rules','salary_holidays',
                           'salary_streak_state'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_company_owner_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR SELECT TO authenticated '
      'USING (organization_id IN (SELECT app_private.my_company_owner_org_ids_v1()))',
      t || '_company_owner_select', t);
  END LOOP;
END
$chu_cong_ty$;

-- ---------------------------------------------------------------------------
-- 9. Tự kiểm — hình dạng, không dữ liệu.
DO $kiem$
DECLARE
  r record;
BEGIN
  -- Mọi RPC public mới: SECURITY DEFINER + ghim search_path + không cho anon.
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.prosecdef, p.proconfig,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('salary_can_edit_amounts_v1','salary_recurring_list_v1',
                         'salary_line_override_list_v1','salary_recurring_create_v1',
                         'salary_recurring_version_add_v1','salary_recurring_delete_v1',
                         'salary_line_override_set_v1')
  LOOP
    IF NOT r.prosecdef THEN RAISE EXCEPTION '% phải SECURITY DEFINER', r.sig; END IF;
    IF NOT EXISTS (SELECT 1 FROM unnest(r.proconfig) c WHERE c LIKE 'search_path=%') THEN
      RAISE EXCEPTION '% chưa ghim search_path', r.sig;
    END IF;
    IF r.anon_exec THEN RAISE EXCEPTION '% không được cho anon gọi', r.sig; END IF;
    IF NOT r.auth_exec THEN RAISE EXCEPTION '% phải cho authenticated gọi', r.sig; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('salary_can_edit_amounts_v1','salary_recurring_list_v1',
                           'salary_line_override_list_v1','salary_recurring_create_v1',
                           'salary_recurring_version_add_v1','salary_recurring_delete_v1',
                           'salary_line_override_set_v1')) <> 7 THEN
    RAISE EXCEPTION 'Thiếu RPC hoặc có bản trùng chữ ký';
  END IF;
  -- Bảy policy chủ công ty đủ mặt và CHỈ SELECT.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND policyname LIKE '%\_company\_owner\_select' ESCAPE '\'
         AND tablename IN ('manager_salary_config','salary_monthly','salary_adjustments',
                           'salary_work_ledger_snapshot','salary_bonus_rules','salary_holidays',
                           'salary_streak_state')
         AND cmd = 'SELECT' AND permissive = 'PERMISSIVE') <> 7 THEN
    RAISE EXCEPTION 'Thiếu policy đọc của chủ công ty trên bảng lương';
  END IF;
  -- Ba bảng mới: không vai client nào đọc/ghi trực tiếp.
  IF has_table_privilege('authenticated', 'app_private.salary_recurring_items', 'SELECT')
     OR has_table_privilege('authenticated', 'app_private.salary_recurring_item_versions', 'SELECT')
     OR has_table_privilege('authenticated', 'app_private.salary_line_overrides', 'SELECT') THEN
    RAISE EXCEPTION 'Bảng lương định kỳ/ghi đè không được mở cho authenticated';
  END IF;
END
$kiem$;

COMMIT;
