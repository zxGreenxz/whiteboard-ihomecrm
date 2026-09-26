-- =============================================================================
-- bang_cam_ket_chi — sổ cam kết chi theo tháng (G1 của plan "cỗ máy chi theo cam kết")
-- Ngày 26/09/2026 · chủ chốt trong ngày:
--   · "phiếu chờ duyệt coi như đã có phiếu rồi, không được có phiếu thứ 2" (giữ chỗ)
--   · cam kết "ký từng tháng"; trả nhiều đợt trong tháng được; trả trước được, và
--     "phần hạng mục có kỳ thanh toán mà dựa vào đó" (kỳ lấy từ kỳ áp dụng của dòng
--     hạng mục trên phiếu, KHÔNG lấy ngày phiếu)
--   · vượt cam kết ⇒ chờ duyệt, cam kết KHÔNG tự nới
--   · sửa cam kết "không ảnh hưởng gì tháng đã chi"
--   · người sửa cam kết: chủ công ty + super admin
--   · sinh cam kết từ tháng 10/2026 trở đi
-- =============================================================================
-- VÌ SAO
--   Luật "chi bao nhiêu thì khỏi cần duyệt" hiện nằm rải trong từng hàm ghi phiếu.
--   Riêng lưới phí cố định (pay_period_fee) so số tiền với app_private.
--   special_fee_price_versions — bảng đó đang 0 dòng, nên nhánh CONFIG_REQUIRED nuốt
--   hết và mọi lần bấm "Đóng" đều tự duyệt, không ngưỡng.
--
--   Chủ ĐÃ khai số liệu, nhưng nằm ở public.building_fee_accounts.default_amount
--   (đo prod 26/09: 107 dòng có số tiền / 17 toà / 8 hạng mục; riêng tiền nhà 15 toà
--   = 681.650.000đ/tháng). Bảng đó KHÔNG dùng làm sổ cam kết được vì ba lẽ:
--     1. một số duy nhất cho mỗi (toà × hạng mục) — không ghi được "tháng 10 là 26tr,
--        tháng 11 tăng 28tr", trong khi chủ chốt ký TỪNG THÁNG;
--     2. ai vào được toà là sửa được (upsert_building_fee_account), trong khi chủ
--        chốt chỉ chủ công ty + super admin được sửa cam kết;
--     3. không có ngày hiệu lực, không lưu lịch sử — sửa là mất số cũ.
--
--   Cũng KHÔNG nhập vào special_fee_price_versions: special_fee_rule_check_v1 so
--   BẰNG tổng giá tháng, nên vừa nhập giá là trả nhiều đợt hoá AMOUNT_MISMATCH ⇒
--   CHỜ, đổi hành vi ngay lập tức trước khi có bất cứ thay đổi mã nào. Cam kết phải
--   so "≤ phần còn lại" mới cho trả nhiều đợt.
--
-- LÀM GÌ
--   1. app_private.spend_commitments: một dòng cho mỗi (toà, hạng mục, tháng).
--   2. app_private.spend_commitment_draws: sổ tiêu. MỘT dòng cho mỗi
--      (cam kết × dòng hạng mục của phiếu); cột kind đi qua ba trạng thái
--      HOLD (phiếu chờ duyệt đã xí phần) → DRAW (đã duyệt, tiêu thật)
--      → RELEASE (phiếu huỷ/đảo, nhả ra). Mốc thời gian từng bước lưu riêng.
--      Số còn lại = amount − Σ(HOLD + DRAW). Dùng một dòng-trạng-thái thay vì
--      chuỗi sự kiện để phép tính số dư không đếm trùng HOLD với DRAW của
--      cùng một dòng hạng mục.
--   3. app_private.commitment_remaining_v1 / commitment_for_v1: đọc số còn lại.
--   4. RPC cho chủ: set_spend_commitment_v1 (thêm/sửa/thu hồi),
--      list_spend_commitments_v1 (xem).
--   5. Khởi tạo: chuyển 107 dòng của building_fee_accounts thành cam kết
--      12 tháng, từ 2026-10-01 đến 2027-09-01, nguồn MIGRATED.
--
-- KHÔNG ĐỤNG
--   Không writer nào đọc hai bảng mới trong migration này — đây là điều kiện để
--   nhập liệu an toàn. Không sửa dữ liệu đang có: không UPDATE building_fee_accounts,
--   special_fee_price_versions, phiếu, sổ hay hoá đơn nào. Không đụng pay_period_fee,
--   pay_utility_bill, generate_special_fees_v1, create_income_expense_v1.
--
-- ĐƯỜNG LÙI
--   REVOKE EXECUTE hai RPC public khỏi authenticated. Hai bảng để nguyên (không ai
--   đọc). Muốn xoá sạch khởi tạo: DELETE FROM app_private.spend_commitments
--   WHERE source = 'MIGRATED' — an toàn vì chưa có draw nào trỏ vào.
--
-- Chạy được hai lượt liên tiếp và trên DB rỗng của Restore Drill.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Nền phải có.
DO $truoc$
BEGIN
  IF to_regprocedure('app_private.ie_actor_is_company_owner_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.ie_actor_is_company_owner_v1 — chạy migration so_nhan_tien trước'
      USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.building_fee_accounts') IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.building_fee_accounts' USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Sổ cam kết — ký từng tháng.
CREATE TABLE IF NOT EXISTS app_private.spend_commitments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  building_id     uuid NOT NULL REFERENCES public.buildings(id) ON DELETE RESTRICT,
  fee_category    text NOT NULL CHECK (fee_category IN
                    ('tien_nha','dien','nuoc','internet','quan_ly',
                     've_sinh','cong_an','rac','thang_may')),
  -- ngày 1 của tháng cam kết; "ký từng tháng" nên mỗi tháng một dòng
  period_month    date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  status          text NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED','RETIRED')),
  -- MIGRATED = máy chuyển từ building_fee_accounts; MANUAL = chủ nhập/sửa tay
  source          text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MIGRATED','MANUAL')),
  note            text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_by      uuid,
  retired_at      timestamptz,
  CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL))
);

-- đúng MỘT cam kết đang hiệu lực cho mỗi (toà, hạng mục, tháng)
CREATE UNIQUE INDEX IF NOT EXISTS spend_commitments_hieu_luc
  ON app_private.spend_commitments (building_id, fee_category, period_month)
  WHERE status = 'PUBLISHED';
CREATE INDEX IF NOT EXISTS spend_commitments_org_ky
  ON app_private.spend_commitments (organization_id, period_month);

-- ---------------------------------------------------------------------------
-- 2. Sổ tiêu — một dòng trạng thái cho mỗi (cam kết × dòng hạng mục).
--    Vì sao một-dòng-trạng-thái chứ không phải chuỗi sự kiện: số còn lại phải trừ
--    HOLD hoặc DRAW của cùng một dòng hạng mục ĐÚNG MỘT LẦN. Ghi hai sự kiện rồi
--    trừ cả hai là đếm trùng; ghi hai sự kiện rồi phải lọc "cái nào đã bị thay"
--    là mở đường cho lỗi đếm. Ba mốc thời gian giữ đủ lịch sử.
CREATE TABLE IF NOT EXISTS app_private.spend_commitment_draws (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  commitment_id          uuid NOT NULL REFERENCES app_private.spend_commitments(id) ON DELETE RESTRICT,
  income_expense_id      uuid NOT NULL REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  income_expense_item_id uuid NOT NULL REFERENCES public.income_expense_items(id) ON DELETE RESTRICT,
  amount                 numeric(14,2) NOT NULL CHECK (amount > 0),
  kind                   text NOT NULL CHECK (kind IN ('HOLD','DRAW','RELEASE')),
  -- true khi người duyệt cố ý duyệt phần vượt cam kết (chủ chốt: cam kết không tự nới)
  over_commitment        boolean NOT NULL DEFAULT false,
  reason                 text,
  held_at                timestamptz,
  drawn_at               timestamptz,
  released_at            timestamptz,
  actor_id               uuid,
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'DRAW')    = (drawn_at    IS NOT NULL) OR kind = 'RELEASE'),
  CHECK ((kind = 'RELEASE') = (released_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS spend_commitment_draws_mot_dong
  ON app_private.spend_commitment_draws (commitment_id, income_expense_item_id);
CREATE INDEX IF NOT EXISTS spend_commitment_draws_phieu
  ON app_private.spend_commitment_draws (income_expense_id);
-- chỉ HOLD và DRAW mới trừ vào số còn lại
CREATE INDEX IF NOT EXISTS spend_commitment_draws_dang_tieu
  ON app_private.spend_commitment_draws (commitment_id)
  WHERE kind IN ('HOLD','DRAW');

REVOKE ALL ON app_private.spend_commitments, app_private.spend_commitment_draws
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.spend_commitments IS
  'Sổ cam kết chi: chủ ký trước số tiền cho mỗi (toà, hạng mục, tháng). Phiếu chi rút trong cam kết thì khỏi duyệt; vượt thì chờ duyệt và cam kết KHÔNG tự nới. Chủ chốt 26/09/2026.';
COMMENT ON TABLE app_private.spend_commitment_draws IS
  'Sổ tiêu cam kết. Một dòng cho mỗi (cam kết × dòng hạng mục); kind đi HOLD (phiếu chờ duyệt đã xí phần) → DRAW (đã duyệt) → RELEASE (huỷ/đảo, nhả ra). Số còn lại = amount − tổng amount của các dòng kind IN (HOLD, DRAW).';

-- ---------------------------------------------------------------------------
-- 3. Đọc số còn lại.
CREATE OR REPLACE FUNCTION app_private.commitment_remaining_v1(p_commitment uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT c.amount
       - COALESCE((SELECT sum(d.amount)
                     FROM app_private.spend_commitment_draws d
                    WHERE d.commitment_id = c.id
                      AND d.kind IN ('HOLD','DRAW')), 0)
    FROM app_private.spend_commitments c
   WHERE c.id = p_commitment AND c.status = 'PUBLISHED';
$fn$;

-- Cam kết đang hiệu lực của một khe, kèm số còn lại. NULL nếu chưa ký.
CREATE OR REPLACE FUNCTION app_private.commitment_for_v1(
  p_building uuid, p_fee_category text, p_period date)
RETURNS TABLE (commitment_id uuid, amount numeric, remaining numeric)
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT c.id, c.amount, app_private.commitment_remaining_v1(c.id)
    FROM app_private.spend_commitments c
   WHERE c.building_id = p_building
     AND c.fee_category = p_fee_category
     AND c.period_month = date_trunc('month', p_period)::date
     AND c.status = 'PUBLISHED';
$fn$;

REVOKE ALL ON FUNCTION app_private.commitment_remaining_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.commitment_for_v1(uuid, text, date)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Khởi tạo — chuyển số chủ đã khai thành cam kết 12 tháng từ 10/2026.
--    Chỉ ghi vào bảng MỚI. Không đụng building_fee_accounts.
--    ON CONFLICT DO NOTHING ⇒ chạy lượt hai không nhân đôi.
INSERT INTO app_private.spend_commitments
  (organization_id, building_id, fee_category, period_month, amount, status, source, note)
SELECT f.organization_id,
       f.building_id,
       f.fee_category,
       thang::date,
       f.default_amount,
       'PUBLISHED',
       'MIGRATED',
       'Chuyển từ mức phí mặc định của toà, mốc 26/09/2026'
  FROM public.building_fee_accounts f
  CROSS JOIN generate_series(DATE '2026-10-01', DATE '2027-09-01', INTERVAL '1 month') AS thang
 WHERE f.deleted_at IS NULL
   AND f.default_amount IS NOT NULL
   AND f.default_amount > 0
   AND f.organization_id IS NOT NULL
   AND COALESCE(f.not_applicable, false) = false
   AND f.fee_category IN ('tien_nha','dien','nuoc','internet','quan_ly',
                          've_sinh','cong_an','rac','thang_may')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. RPC cho chủ công ty / super admin.
--    Chủ chốt 26/09: chỉ hai vai này được sửa cam kết.
CREATE OR REPLACE FUNCTION public.set_spend_commitment_v1(
  p_building_id  uuid,
  p_fee_category text,
  p_period_month date,
  p_amount       numeric,
  p_note         text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_thang date;
  v_cu    app_private.spend_commitments%ROWTYPE;
  v_moi   uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT b.organization_id INTO v_org
    FROM public.buildings b
   WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy toà nhà' USING ERRCODE = '42501';
  END IF;

  IF NOT (public.is_super_admin()
          OR app_private.ie_actor_is_company_owner_v1(v_org, v_actor)) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được sửa cam kết chi'
      USING ERRCODE = '42501';
  END IF;

  IF p_fee_category NOT IN ('tien_nha','dien','nuoc','internet','quan_ly',
                            've_sinh','cong_an','rac','thang_may') THEN
    RAISE EXCEPTION 'Hạng mục phí không hợp lệ: %', p_fee_category USING ERRCODE = '22023';
  END IF;
  IF p_period_month IS NULL THEN
    RAISE EXCEPTION 'Thiếu tháng cam kết' USING ERRCODE = '22023';
  END IF;
  v_thang := date_trunc('month', p_period_month)::date;

  -- Chủ chốt: "không ảnh hưởng gì tháng đã chi". Tháng đã có khoản tiêu thì
  -- không cho sửa cam kết — muốn điều chỉnh thì lập phiếu riêng.
  SELECT * INTO v_cu
    FROM app_private.spend_commitments c
   WHERE c.building_id = p_building_id
     AND c.fee_category = p_fee_category
     AND c.period_month = v_thang
     AND c.status = 'PUBLISHED';

  IF FOUND AND EXISTS (SELECT 1 FROM app_private.spend_commitment_draws d
                        WHERE d.commitment_id = v_cu.id AND d.kind IN ('HOLD','DRAW')) THEN
    RAISE EXCEPTION
      'Tháng % của khe này đã có khoản chi hoặc phiếu đang chờ — không sửa cam kết được. Muốn điều chỉnh thì lập phiếu riêng.',
      to_char(v_thang, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;

  -- Thu hồi bản cũ rồi ghi bản mới ⇒ giữ được lịch sử đã ký bao nhiêu.
  IF FOUND THEN
    UPDATE app_private.spend_commitments
       SET status = 'RETIRED', retired_at = clock_timestamp(), retired_by = v_actor
     WHERE id = v_cu.id;
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    -- Không truyền số tiền = thu hồi cam kết, không ký lại.
    RETURN jsonb_build_object('da_thu_hoi', FOUND, 'commitment_id', NULL);
  END IF;

  INSERT INTO app_private.spend_commitments
    (organization_id, building_id, fee_category, period_month, amount,
     status, source, note, created_by)
  VALUES
    (v_org, p_building_id, p_fee_category, v_thang, p_amount,
     'PUBLISHED', 'MANUAL', NULLIF(btrim(p_note), ''), v_actor)
  RETURNING id INTO v_moi;

  RETURN jsonb_build_object('commitment_id', v_moi, 'thang', v_thang,
                            'so_tien', p_amount, 'da_thu_hoi_ban_cu', v_cu.id IS NOT NULL);
END
$fn$;

CREATE OR REPLACE FUNCTION public.list_spend_commitments_v1(
  p_organization_id uuid,
  p_from_month      date DEFAULT NULL,
  p_to_month        date DEFAULT NULL)
RETURNS TABLE (
  commitment_id uuid, building_id uuid, building_name text, fee_category text,
  period_month date, amount numeric, remaining numeric, source text, note text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.is_super_admin()
          OR app_private.ie_actor_is_company_owner_v1(p_organization_id, v_actor)) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem cam kết chi'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT c.id, c.building_id, b.name, c.fee_category, c.period_month, c.amount,
         app_private.commitment_remaining_v1(c.id), c.source, c.note
    FROM app_private.spend_commitments c
    JOIN public.buildings b ON b.id = c.building_id
   WHERE c.organization_id = p_organization_id
     AND c.status = 'PUBLISHED'
     AND (p_from_month IS NULL OR c.period_month >= date_trunc('month', p_from_month)::date)
     AND (p_to_month   IS NULL OR c.period_month <= date_trunc('month', p_to_month)::date)
   ORDER BY b.name, c.fee_category, c.period_month;
END
$fn$;

REVOKE ALL ON FUNCTION public.set_spend_commitment_v1(uuid, text, date, numeric, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_spend_commitment_v1(uuid, text, date, numeric, text)
  TO authenticated;
REVOKE ALL ON FUNCTION public.list_spend_commitments_v1(uuid, date, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_spend_commitments_v1(uuid, date, date)
  TO authenticated;

COMMENT ON FUNCTION public.set_spend_commitment_v1(uuid, text, date, numeric, text) IS
  'Chủ công ty / super admin ký hoặc sửa cam kết chi cho một (toà, hạng mục, tháng). Tháng đã có khoản tiêu thì từ chối (chủ chốt: không ảnh hưởng tháng đã chi). Bỏ trống số tiền = thu hồi cam kết.';

-- ---------------------------------------------------------------------------
-- 6. Tự kiểm — migration tự dừng nếu khởi tạo không ra kết quả mong đợi.
DO $kiem$
DECLARE
  v_nguon int;
  v_cam_ket int;
BEGIN
  SELECT count(*) INTO v_nguon
    FROM public.building_fee_accounts f
   WHERE f.deleted_at IS NULL AND f.default_amount > 0 AND f.organization_id IS NOT NULL
     AND COALESCE(f.not_applicable, false) = false
     AND f.fee_category IN ('tien_nha','dien','nuoc','internet','quan_ly',
                            've_sinh','cong_an','rac','thang_may');

  SELECT count(DISTINCT (building_id, fee_category)) INTO v_cam_ket
    FROM app_private.spend_commitments
   WHERE source = 'MIGRATED' AND status = 'PUBLISHED';

  IF v_nguon <> v_cam_ket THEN
    RAISE EXCEPTION
      'Khởi tạo lệch: % khe nguồn nhưng % khe cam kết. DỪNG.', v_nguon, v_cam_ket
      USING ERRCODE = '55000';
  END IF;

  RAISE NOTICE 'Cam kết đã sinh: % khe × 12 tháng', v_cam_ket;
END
$kiem$;

COMMIT;
