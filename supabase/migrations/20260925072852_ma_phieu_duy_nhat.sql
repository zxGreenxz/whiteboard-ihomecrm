-- =============================================================================
-- ma_phieu_duy_nhat — mã phiếu thu/chi duy nhất trong tổ chức
-- Ngày 25/09/2026 · đợt 1 "sửa phiếu thu chi" · chủ chốt: "mã phiếu trùng thì
-- chỉnh lại cho các phiếu sau này là độc nhất không trùng nữa"
-- =============================================================================
-- VÌ SAO
--   auto_generate_voucher_code đếm số thứ tự theo (user_id, loại, tháng): mỗi
--   người lập có một dãy riêng ⇒ hai người lập trong cùng tháng ra cùng mã.
--   Đo production 24/09/2026 (chỉ đọc): 1.244 mã đang dùng chung cho 3.184 phiếu
--   (một mã tối đa 4 phiếu). Tối đa 615 phiếu/tháng/loại ⇒ 3 chữ số vẫn đủ.
--
-- LÀM GÌ
--   1. Bảng app_private.voucher_code_counters: (tổ chức, tiền tố, YYMM) → số cuối
--      đã cấp. Khoá dòng thay advisory lock + quét MAX của bản cũ.
--   2. Viết lại trigger function auto_generate_voucher_code (giữ tên, trigger
--      trigger_auto_generate_voucher_code giữ nguyên, ACL giữ nguyên):
--      - đếm CHUNG cả tổ chức theo loại + tháng;
--      - lần đầu mỗi (tổ chức, tiền tố, tháng) khởi tạo bằng số đuôi LỚN NHẤT đang
--        có của cả tổ chức trong tháng ⇒ không bao giờ cấp lại một mã đã tồn tại;
--      - dạng mã giữ nguyên: PT|PC + YYMM + số (lpad 3, tự dài hơn khi > 999);
--      - "hôm nay" vẫn là org_today_v1(NULL) như bản cũ.
--   3. Chỉ mục duy nhất (organization_id, code) cho phiếu tạo TỪ LÚC chạy file này
--      (mốc thời gian lấy lúc chạy, ghi cứng vào vị từ của chỉ mục).
--
-- KHÔNG ĐỤNG
--   Không sửa mã hay bất kỳ cột nào của phiếu đang có — chủ chốt 25/09: "không
--   được phép thay đổi dữ liệu đang tồn tại". Mã cũ đang trùng giữ nguyên (đã in,
--   đã gửi khách); danh sách Thu chi vốn hiện ngày + người lập để phân biệt.
--   Không writer nào tự đặt code (rà thân hàm production 25/09); trigger vẫn giữ
--   code nếu người gọi tự truyền.
--
-- ĐƯỜNG LÙI
--   CREATE OR REPLACE lại bản cũ của auto_generate_voucher_code (md5 b22bd6e3…,
--   lấy từ schema-change evidence/backup), DROP INDEX
--   public.income_expenses_org_code_duy_nhat. Bảng đếm để nguyên vô hại.
--
-- Chạy được hai lượt liên tiếp và trên DB rỗng của Restore Drill.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. Bản đang chạy phải đúng bản đã rà (hoặc đã là bản của file này).
DO $truoc$
BEGIN
  IF to_regprocedure('public.auto_generate_voucher_code()') IS NOT NULL
     AND md5(pg_get_functiondef('public.auto_generate_voucher_code()'::regprocedure))
         NOT IN ('b22bd6e3e4df416720ce14f022f123cc', 'd9bd058f6285078c86cc6c422b5351c4') THEN
    RAISE EXCEPTION 'auto_generate_voucher_code đã đổi so với bản đã rà — chụp lại pg_get_functiondef rồi rà lại'
      USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Bảng đếm.
CREATE TABLE IF NOT EXISTS app_private.voucher_code_counters (
  organization_id uuid NOT NULL,
  prefix text NOT NULL CHECK (prefix IN ('PT', 'PC')),
  yymm text NOT NULL CHECK (yymm ~ '^[0-9]{4}$'),
  last_value integer NOT NULL CHECK (last_value >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, prefix, yymm)
);
REVOKE ALL ON app_private.voucher_code_counters FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Trigger function mới.
CREATE OR REPLACE FUNCTION public.auto_generate_voucher_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_prefix text;
  v_yymm text;
  v_next integer;
BEGIN
  -- Người gọi tự truyền mã: giữ nguyên (chỉ mục duy nhất vẫn canh trùng).
  IF NEW.code IS NOT NULL AND NEW.code <> '' THEN
    RETURN NEW;
  END IF;

  -- trg_autofill_org (chạy trước theo thứ tự tên) đã điền tổ chức; thiếu là lỗi
  -- dữ liệu, không đoán.
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'Phiếu thiếu tổ chức nên không cấp được mã phiếu'
      USING ERRCODE = '23502';
  END IF;

  v_prefix := CASE WHEN NEW.type = 'INCOME' THEN 'PT' ELSE 'PC' END;
  v_yymm := to_char(public.org_today_v1(NULL), 'YYMM');

  -- Đếm CHUNG cả tổ chức. Khoá dòng đếm tuần tự hoá mọi lần cấp cùng tháng.
  UPDATE app_private.voucher_code_counters c
     SET last_value = c.last_value + 1,
         updated_at = clock_timestamp()
   WHERE c.organization_id = NEW.organization_id
     AND c.prefix = v_prefix
     AND c.yymm = v_yymm
  RETURNING c.last_value INTO v_next;

  IF v_next IS NULL THEN
    -- Lần đầu của tháng: khởi tạo bằng số đuôi lớn nhất đang có của CẢ tổ chức,
    -- để không bao giờ cấp lại một mã đã tồn tại (mã cũ đếm theo từng người).
    INSERT INTO app_private.voucher_code_counters (organization_id, prefix, yymm, last_value)
    SELECT NEW.organization_id, v_prefix, v_yymm,
           COALESCE(max(substring(ie.code FROM 7)::integer), 0)
      FROM public.income_expenses ie
     WHERE ie.organization_id = NEW.organization_id
       AND ie.code ~ ('^' || v_prefix || v_yymm || '[0-9]{1,9}$')
    ON CONFLICT (organization_id, prefix, yymm) DO NOTHING;

    UPDATE app_private.voucher_code_counters c
       SET last_value = c.last_value + 1,
           updated_at = clock_timestamp()
     WHERE c.organization_id = NEW.organization_id
       AND c.prefix = v_prefix
       AND c.yymm = v_yymm
    RETURNING c.last_value INTO v_next;
  END IF;

  NEW.code := v_prefix || v_yymm || lpad(v_next::text, 3, '0');
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Chỉ mục duy nhất cho phiếu tạo từ lúc này. Mốc = now() của CHÍNH transaction
--    migration (created_at mặc định cũng là now() của transaction ghi phiếu), nên mọi
--    phiếu ghi sau khi file này commit đều nằm trong vị từ; phiếu cũ (mã trùng) nằm
--    ngoài vị từ nên không bị đụng.
DO $chi_muc$
BEGIN
  IF to_regclass('public.income_expenses_org_code_duy_nhat') IS NULL THEN
    EXECUTE format(
      'CREATE UNIQUE INDEX income_expenses_org_code_duy_nhat ON public.income_expenses (organization_id, code) '
      || 'WHERE code IS NOT NULL AND created_at >= %L::timestamptz',
      now());
  END IF;
END
$chi_muc$;

-- ---------------------------------------------------------------------------
-- 4. Nghiệm thu.
DO $nghiem_thu$
DECLARE
  v_def text;
BEGIN
  v_def := regexp_replace(
    pg_get_functiondef('public.auto_generate_voucher_code()'::regprocedure), '--[^\n]*', '', 'g');
  IF v_def !~ 'voucher_code_counters' OR v_def ~ 'user_id' OR v_def ~ 'pg_advisory_xact_lock' THEN
    RAISE EXCEPTION 'nghiem_thu: auto_generate_voucher_code chua dem chung to chuc';
  END IF;
  IF to_regclass('public.income_expenses_org_code_duy_nhat') IS NULL THEN
    RAISE EXCEPTION 'nghiem_thu: thieu chi muc income_expenses_org_code_duy_nhat';
  END IF;
  IF to_regclass('public.income_expenses') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.income_expenses'::regclass
       AND t.tgname = 'trigger_auto_generate_voucher_code'
       AND t.tgfoid = 'public.auto_generate_voucher_code()'::regprocedure
       AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION 'nghiem_thu: trigger cap ma phieu khong con gan dung ham';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
