-- =============================================================================
-- va_guard_cot_luat_chi_canh_ghi_truc_tiep — vá hồi quy của G3 (26/09/2026)
-- =============================================================================
-- VÌ SAO
--   G3 (20260926113435) đặt trigger a05_ie_type_rule_columns_guard SECURITY DEFINER
--   trên income_expense_types: đổi force_approval / is_deposit / organization_id /
--   spend_mode / fee_category, hay INSERT với các cờ đó khác mặc định ⇒ phải là chủ
--   công ty hoặc super admin. Nhưng 20 hàm hệ thống SECURITY DEFINER tự ghi các cờ
--   này như một bước phụ, trong lúc QUẢN LÝ bấm nút:
--     _termination_ensure_type   INSERT force_approval=true / UPDATE false→true
--                                (gọi từ pay_utility_bill, confirm_cash_handover,
--                                 terminate_contract_*, create_opening_adjustment…)
--     ensure_income_expense_type_v1  INSERT is_deposit/force_approval, UPDATE … OR p_force
--                                (gọi từ reservation_create_leg_v1, generate_special_fees_v1…)
--     pay_period_fee, terminate_contract_*, confirm_cash_handover  UPDATE is_deposit
--   Guard DEFINER chỉ thấy auth.uid() = người bấm ⇒ chặn 42501 ngay giữa lúc thanh lý
--   hay đóng điện nước, lần đầu hệ thống cần tạo/chỉnh một hạng mục. Đo prod 26/09
--   sau G3: chưa ca nào dính (mọi hạng mục hệ thống đã có sẵn đúng cờ ở cả hai org,
--   0 hạng mục/phiếu mới từ lúc áp) — nhưng là hồi quy chờ nổ. §4.8 mục 5 của plan
--   đòi thử "helper definer"; G3 đã không thử đúng ca này.
--
-- LÀM GÌ
--   1. Guard chuyển sang SECURITY INVOKER và chỉ canh GHI TRỰC TIẾP từ client:
--      current_user IN ('authenticated','anon'). Bên trong một hàm SECURITY DEFINER,
--      current_user là CHỦ HÀM (postgres) ⇒ mã server đã tự kiểm quyền được đi như
--      trước G3. Client không đổi được current_user (PostgREST SET ROLE theo JWT).
--      ⚠ Không dùng session_user — SET ROLE không đổi session_user (bài học 17/09).
--      Phép thử giả lập người dùng bằng SET LOCAL ROLE authenticated vẫn bị guard.
--   2. Kiểm "chủ công ty đúng org" qua helper DEFINER ở public
--      ie_type_rule_editor_ok_v1(org) — vì authenticated không có USAGE app_private,
--      hàm INVOKER không gọi thẳng app_private.ie_actor_is_company_owner_v1 được.
--   3. Đổi tên trigger thành zz_… để chạy SAU trg_autofill_org: INSERT từ client
--      không gửi organization_id, guard phải thấy org đã được điền.
--
-- KHÔNG ĐỔI
--   Tập cột được canh giữ nguyên như G3. Luồng client hiện tại (màn Danh mục chỉ gửi
--   tên/nhóm/mô tả/is_default/is_restricted/hide_in_report) không chạm cột nào ⇒
--   không gãy. Không đụng a01_reservation_type_guard, RLS, phiếu, sổ.
--
-- ĐƯỜNG LÙI
--   DROP TRIGGER zz_ie_type_rule_columns_guard ON public.income_expense_types;
--   (bỏ hẳn guard — an toàn hơn bản G3 vì không chặn nhầm writer nào).
-- =============================================================================

BEGIN;

DO $truoc$
BEGIN
  IF to_regprocedure('app_private.ie_actor_is_company_owner_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.ie_actor_is_company_owner_v1' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'income_expense_types'
                    AND column_name = 'spend_mode') THEN
    RAISE EXCEPTION 'Thiếu cột spend_mode — chạy anh_xa_hang_muc_va_khoa_cot_luat trước'
      USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Helper: người đang đăng nhập có được sửa luật chi của hạng mục thuộc org này?
CREATE OR REPLACE FUNCTION public.ie_type_rule_editor_ok_v1(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
  SELECT auth.uid() IS NOT NULL
     AND (public.is_super_admin()
          OR (p_org IS NOT NULL
              AND app_private.ie_actor_is_company_owner_v1(p_org, auth.uid())));
$fn$;

COMMENT ON FUNCTION public.ie_type_rule_editor_ok_v1(uuid) IS
  'true khi người đang đăng nhập là super admin hoặc chủ công ty của org — dùng cho guard cột luật chi của hạng mục. Chỉ trả lời về chính người gọi.';

REVOKE ALL ON FUNCTION public.ie_type_rule_editor_ok_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ie_type_rule_editor_ok_v1(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Guard: INVOKER, chỉ canh client.
CREATE OR REPLACE FUNCTION app_private.ie_type_rule_columns_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_doi boolean;
BEGIN
  -- Ghi từ bên trong hàm SECURITY DEFINER của hệ thống (current_user = chủ hàm),
  -- từ service_role, hay từ lane migration: mã server — để nguyên như trước G3.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_doi := NEW.spend_mode <> 'TUNG_PHIEU'
          OR NEW.fee_category IS NOT NULL
          OR COALESCE(NEW.force_approval, false)
          OR COALESCE(NEW.is_deposit, false);
  ELSE
    v_doi := NEW.spend_mode      IS DISTINCT FROM OLD.spend_mode
          OR NEW.fee_category    IS DISTINCT FROM OLD.fee_category
          OR NEW.force_approval  IS DISTINCT FROM OLD.force_approval
          OR NEW.is_deposit      IS DISTINCT FROM OLD.is_deposit
          OR NEW.organization_id IS DISTINCT FROM OLD.organization_id;
  END IF;

  IF NOT v_doi THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    -- chuyển hạng mục sang org khác: chỉ super admin
    IF public.ie_type_rule_editor_ok_v1(NULL) THEN
      RETURN NEW;
    END IF;
  ELSIF public.ie_type_rule_editor_ok_v1(NEW.organization_id) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được đổi luật chi của hạng mục (kiểu chi, khoá phí, bắt buộc duyệt, cọc, tổ chức)'
    USING ERRCODE = '42501';
END
$fn$;

COMMENT ON FUNCTION app_private.ie_type_rule_columns_guard() IS
  'Guard cột luật chi trên income_expense_types. SECURITY INVOKER: chỉ canh ghi trực tiếp từ client (current_user authenticated/anon); hàm hệ thống SECURITY DEFINER đi như trước. Vá hồi quy của G3, 26/09/2026.';

REVOKE ALL ON FUNCTION app_private.ie_type_rule_columns_guard() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Trigger mới chạy SAU trg_autofill_org (thứ tự theo tên).
DROP TRIGGER IF EXISTS a05_ie_type_rule_columns_guard ON public.income_expense_types;
DROP TRIGGER IF EXISTS zz_ie_type_rule_columns_guard ON public.income_expense_types;
CREATE TRIGGER zz_ie_type_rule_columns_guard
  BEFORE INSERT OR UPDATE ON public.income_expense_types
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_type_rule_columns_guard();

-- ---------------------------------------------------------------------------
-- 4. Tự kiểm.
DO $sau$
DECLARE
  v_secdef boolean;
BEGIN
  SELECT p.prosecdef INTO v_secdef
    FROM pg_proc p
   WHERE p.oid = 'app_private.ie_type_rule_columns_guard()'::regprocedure;
  IF v_secdef THEN
    RAISE EXCEPTION 'Guard vẫn là SECURITY DEFINER — current_user sẽ luôn là chủ hàm'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.income_expense_types'::regclass
                    AND tgname = 'zz_ie_type_rule_columns_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Thiếu trigger zz_ie_type_rule_columns_guard' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgrelid = 'public.income_expense_types'::regclass
                AND tgname = 'a05_ie_type_rule_columns_guard') THEN
    RAISE EXCEPTION 'Trigger cũ a05_ie_type_rule_columns_guard còn sót' USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('anon', 'public.ie_type_rule_editor_ok_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon còn EXECUTE trên ie_type_rule_editor_ok_v1' USING ERRCODE = '55000';
  END IF;
END
$sau$;

COMMIT;
