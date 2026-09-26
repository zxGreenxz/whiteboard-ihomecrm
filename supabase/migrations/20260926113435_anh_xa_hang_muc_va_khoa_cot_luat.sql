-- =============================================================================
-- anh_xa_hang_muc_va_khoa_cot_luat — G3 của plan "cỗ máy chi theo cam kết"
-- Ngày 26/09/2026 · chủ chốt: luật chi khai TRÊN HẠNG MỤC (ba kiểu CAM_KET / TRAN /
-- TUNG_PHIEU); chỉ chủ công ty + super admin được sửa luật; hạng mục mới mặc định
-- TUNG_PHIEU.
-- =============================================================================
-- VÌ SAO
--   Ba khái niệm "hạng mục" đang chồng nhau: dòng income_expense_types (đã canonical
--   theo org, 0 trùng trong mỗi org — audit 26/09 xác nhận), 9 khoá chuỗi của trang
--   Thanh toán (tien_nha, dien, …) và phép khớp theo TÊN fee_type_matches. Khớp theo
--   tên vơ nhầm: khoá `rac` bắt cả "Bỏ rác", "Rửa thùng rác" (đo 180 ngày). Luật gắn
--   vào hạng mục thì phải gắn vào MỘT dòng xác định, không phải một mẫu tên.
--
-- LÀM GÌ
--   1. Thêm hai cột lên income_expense_types:
--        fee_category  — khoá của trang Thanh toán, duy nhất theo (org, khoá)
--        spend_mode    — CAM_KET | TRAN | TUNG_PHIEU, mặc định TUNG_PHIEU
--      Chưa writer nào đọc hai cột này (G2/G5 mới đọc). Thêm cột = không đổi hành vi.
--   2. Ánh xạ 9 khoá → hạng mục theo TỪNG org, bằng tên chuẩn hoá (nrm_vn), chọn đúng
--      dòng đang được dùng áp đảo (đo prod 180 ngày: Tiền nhà 88, Vệ sinh tòa nhà định
--      kỳ 84, Tiền rác 83, Quản Lý 73, Đóng tiền internet 67, Tiền công an 45, Bảo Trì
--      Thang Máy 27, Đóng tiền điện 84 + Đóng tiền nước 34 qua utility.bill).
--      ⛔ Ánh xạ theo org — không chọn dòng chung cho cặp THẬT/DEMO (C1 của audit).
--   3. spend_mode cho hạng mục đã ánh xạ: dien/nuoc → TRAN, 7 khoá còn lại → CAM_KET.
--      Hạng mục khác giữ TUNG_PHIEU.
--   4. Trigger a05_ie_type_rule_columns_guard: sửa cột luật (spend_mode, fee_category,
--      force_approval, is_deposit, organization_id) hay INSERT với luật khác mặc định
--      ⇒ phải là super admin hoặc chủ công ty của đúng org. Cột thường (tên, mô tả,
--      is_default, hide_in_report, category…) vẫn sửa như cũ ⇒ màn Danh mục hiện tại
--      không gãy. Đây là "enforcement server có kiểm quyền thật" mà audit P1 đòi, chọn
--      trigger thay ACL cột để tương thích client (P1 mục 4).
--
-- KHÔNG ĐỤNG
--   Không thu quyền cấp bảng (giữ client đang chạy). Không sửa fee_type_matches (G5
--   mới thay). Không đụng a01_reservation_type_guard — nếu backfill chạm dòng nó gác,
--   migration tự dừng chứ không disable guard. Không đụng phiếu, sổ, hoá đơn.
--
-- ĐƯỜNG LÙI
--   DROP TRIGGER a05_ie_type_rule_columns_guard. Hai cột để nguyên (chưa ai đọc);
--   xoá ánh xạ: UPDATE income_expense_types SET fee_category = NULL,
--   spend_mode = 'TUNG_PHIEU' — làm SAU khi drop trigger.
--
-- Chạy được hai lượt liên tiếp và trên DB rỗng của Restore Drill.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Nền phải có.
DO $truoc$
BEGIN
  IF to_regprocedure('public.nrm_vn(text)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.nrm_vn' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('app_private.ie_actor_is_company_owner_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.ie_actor_is_company_owner_v1' USING ERRCODE = '55000';
  END IF;
  IF to_regclass('app_private.spend_commitments') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.spend_commitments — chạy bang_cam_ket_chi trước'
      USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Hai cột luật.
ALTER TABLE public.income_expense_types
  ADD COLUMN IF NOT EXISTS fee_category text
    CHECK (fee_category IS NULL OR fee_category IN
      ('tien_nha','dien','nuoc','internet','quan_ly','ve_sinh','cong_an','rac','thang_may')),
  ADD COLUMN IF NOT EXISTS spend_mode text NOT NULL DEFAULT 'TUNG_PHIEU'
    CHECK (spend_mode IN ('CAM_KET','TRAN','TUNG_PHIEU'));

-- mỗi org, mỗi khoá đúng một hạng mục
CREATE UNIQUE INDEX IF NOT EXISTS income_expense_types_fee_category_org_uq
  ON public.income_expense_types (organization_id, fee_category)
  WHERE fee_category IS NOT NULL;

COMMENT ON COLUMN public.income_expense_types.fee_category IS
  'Khoá của trang Thanh toán (tien_nha, dien, …) ánh xạ vào hạng mục này. Duy nhất theo (org, khoá). Chỉ chủ công ty / super admin sửa.';
COMMENT ON COLUMN public.income_expense_types.spend_mode IS
  'Kiểu chi của hạng mục: CAM_KET (rút trong cam kết ⇒ tự duyệt), TRAN (dưới trần ⇒ tự duyệt), TUNG_PHIEU (xét ngưỡng từng phiếu). Chủ chốt 26/09/2026. Chỉ chủ công ty / super admin sửa.';

-- ---------------------------------------------------------------------------
-- 2. Ánh xạ 9 khoá theo từng org, bằng tên chuẩn hoá. Chỉ ghi khi (org, tên) ra
--    ĐÚNG MỘT dòng; nhiều dòng thì bỏ qua và tự kiểm ở bước 5 sẽ báo.
--    ⚠ Cần chạy TRƯỚC khi tạo trigger bước 4 (trigger không cho sửa fee_category
--    ngoài chủ; migration chạy với auth.uid() NULL).
WITH ten_chuan (khoa, ten) AS (
  VALUES
    ('tien_nha',  public.nrm_vn('Tiền nhà')),
    ('dien',      public.nrm_vn('Đóng tiền điện')),
    ('nuoc',      public.nrm_vn('Đóng tiền nước')),
    ('internet',  public.nrm_vn('Đóng tiền internet')),
    ('quan_ly',   public.nrm_vn('Quản Lý')),
    ('ve_sinh',   public.nrm_vn('Vệ sinh tòa nhà định kỳ')),
    ('cong_an',   public.nrm_vn('Tiền công an')),
    ('rac',       public.nrm_vn('Tiền rác')),
    ('thang_may', public.nrm_vn('Bảo Trì Thang Máy'))
),
ung_vien AS (
  SELECT t.organization_id, tc.khoa, t.id,
         count(*) OVER (PARTITION BY t.organization_id, tc.khoa) so_dong
    FROM public.income_expense_types t
    JOIN ten_chuan tc ON public.nrm_vn(t.name) = tc.ten
   WHERE t.type = 'expense'
     AND t.organization_id IS NOT NULL
)
UPDATE public.income_expense_types t
   SET fee_category = u.khoa,
       spend_mode   = CASE WHEN u.khoa IN ('dien','nuoc') THEN 'TRAN' ELSE 'CAM_KET' END
  FROM ung_vien u
 WHERE u.id = t.id
   AND u.so_dong = 1
   AND t.fee_category IS NULL;          -- lượt hai không ghi đè

-- ---------------------------------------------------------------------------
-- 3. Guard cột luật. Tạo SAU backfill.
-- SECURITY DEFINER là bắt buộc: trigger chạy trong phiên của người dùng, mà role
-- authenticated không có USAGE trên schema app_private ⇒ không gọi được
-- ie_actor_is_company_owner_v1 và guard sẽ chặn nhầm CẢ chủ công ty (đã dính khi thử
-- trên TEST 26/09). Không có lối vòng theo current_user: trong hàm definer,
-- current_user luôn là chủ hàm nên lối đó mở cho mọi người. Backfill của chính
-- migration này chạy TRƯỚC khi tạo trigger; sửa luật bằng SQL về sau phải qua review
-- và DISABLE TRIGGER trong đúng transaction đó.
CREATE OR REPLACE FUNCTION app_private.ie_type_rule_columns_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_doi   boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_doi := NEW.spend_mode <> 'TUNG_PHIEU'
          OR NEW.fee_category IS NOT NULL
          OR COALESCE(NEW.force_approval, false)
          OR COALESCE(NEW.is_deposit, false);
  ELSE
    v_doi := NEW.spend_mode        IS DISTINCT FROM OLD.spend_mode
          OR NEW.fee_category      IS DISTINCT FROM OLD.fee_category
          OR NEW.force_approval    IS DISTINCT FROM OLD.force_approval
          OR NEW.is_deposit        IS DISTINCT FROM OLD.is_deposit
          OR NEW.organization_id   IS DISTINCT FROM OLD.organization_id;
  END IF;

  IF NOT v_doi THEN
    RETURN NEW;
  END IF;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Sửa luật của hạng mục cần đăng nhập' USING ERRCODE = '42501';
  END IF;

  IF public.is_super_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.organization_id IS NOT NULL
     AND app_private.ie_actor_is_company_owner_v1(NEW.organization_id, v_actor)
     AND (TG_OP = 'INSERT' OR OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Chỉ chủ công ty hoặc quản trị hệ thống được đổi luật chi của hạng mục (kiểu chi, khoá phí, bắt buộc duyệt, cọc, tổ chức)'
    USING ERRCODE = '42501';
END
$fn$;

REVOKE ALL ON FUNCTION app_private.ie_type_rule_columns_guard()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS a05_ie_type_rule_columns_guard ON public.income_expense_types;
CREATE TRIGGER a05_ie_type_rule_columns_guard
  BEFORE INSERT OR UPDATE ON public.income_expense_types
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_type_rule_columns_guard();

COMMENT ON TRIGGER a05_ie_type_rule_columns_guard ON public.income_expense_types IS
  'G3: cột luật (spend_mode, fee_category, force_approval, is_deposit, organization_id) chỉ chủ công ty / super admin được đổi. Cột thường sửa như cũ.';

-- ---------------------------------------------------------------------------
-- 4. Tự kiểm — INV-4: mọi khoá đang có số liệu ở building_fee_accounts phải ánh xạ được
--    trong đúng org đó.
DO $kiem$
DECLARE
  r record;
  v_thieu text := '';
  v_map   int;
BEGIN
  FOR r IN
    SELECT DISTINCT f.organization_id, f.fee_category
      FROM public.building_fee_accounts f
     WHERE f.deleted_at IS NULL AND f.default_amount > 0 AND f.organization_id IS NOT NULL
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.income_expense_types t
                    WHERE t.organization_id = r.organization_id
                      AND t.fee_category = r.fee_category) THEN
      v_thieu := v_thieu || format(' [org %s · %s]', left(r.organization_id::text, 8), r.fee_category);
    END IF;
  END LOOP;

  IF v_thieu <> '' THEN
    RAISE EXCEPTION 'Khoá có số liệu nhưng chưa ánh xạ được hạng mục:%. DỪNG.', v_thieu
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_map FROM public.income_expense_types WHERE fee_category IS NOT NULL;
  RAISE NOTICE 'Đã ánh xạ % hạng mục (mọi org cộng lại)', v_map;
END
$kiem$;

COMMIT;
