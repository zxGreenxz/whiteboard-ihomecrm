-- =====================================================================
-- KHOÁ THÁNG ĐÃ CHỐT LỢI NHUẬN — và MỞ KHOÁ nó
--
-- Chủ hỏi 30/07: "tháng đã chốt mà tạo phiếu chi hay thu vào tháng đó là không
-- được đúng không, đã có cơ chế nào cho việc khoá này chưa?"
-- Trả lời đo được: CHƯA. Có HAI loại khoá, mạnh yếu rất khác nhau:
--   - Chốt SỔ QUỸ (Đợt 3/6): là TRIGGER, chặn thật. Đã probe: sổ "Hiệp chi"
--     chốt tới 30/06 thì chèn phiếu ngày 15/06 bị [CASHBOOK_CLOSED].
--   - Chốt LỢI NHUẬN: `[PROFIT_LOCKED]` chỉ là một VỊ NGỮ mà vài hàm gọi khi
--     SỬA/HUỶ phiếu — KHÔNG phải trigger. Đã probe trên org thật: toà có lợi
--     nhuận 06/2026 ĐÃ KHOÁ VÀ ĐÃ CHIA cho cổ đông, sổ quỹ chưa chốt ⇒ tạo
--     phiếu chi mới 777.000đ ngày 15/06 TẠO ĐƯỢC, không gì chặn.
--     ⇒ Số đã chia lệch khỏi sổ mà không ai được báo (Rủi ro #4 của plan).
--
-- Chủ chọn phương án 2: CHẶN NHƯNG CHỪA CỬA cho chủ tổ chức / super admin,
-- và bổ sung cơ chế MỞ KHOÁ tháng (quyền chỉ chủ tổ chức + super admin).
--
-- ⚠ BA NGOẠI LỆ CÓ CHỦ Ý, không phải sơ hở:
--  1. Phiếu NGOÀI KQKD (business_result_accounting = false) đi lọt: chúng không
--     góp vào con số đã chia (điều chỉnh số dư, chuyển nội bộ, cấn cọc, và
--     chính phiếu chênh lệch của nghi thức chốt sổ Đợt 6).
--  2. Bối cảnh HỆ THỐNG (auth.uid() IS NULL — cron, migration, service_role)
--     đi lọt. Nếu chặn, cron `recurring_vouchers_daily` sẽ chết ngay: tháng
--     07/2026 đã khoá lợi nhuận từ 20/07 trong khi tháng vẫn đang chạy, nên
--     mọi phiếu định kỳ sinh trong 10 ngày cuối tháng đều rơi vào tháng khoá.
--     Đây KHÔNG phải mô hình mối đe doạ: kẻ đáng lo là người dùng lặng lẽ sửa
--     một tháng đã chốt, mà người dùng thì luôn có JWT.
--  3. Cửa ANNOTATE (quyết định #8 của chủ): vẫn bổ sung được ảnh chứng từ và
--     ghi chú, y như khoá sổ quỹ. Tiền thì khoá.
-- =====================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. TRIGGER CHẶN GHI VÀO THÁNG ĐÃ CHỐT LỢI NHUẬN
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.income_expenses_check_profit_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_row record;
  v_locked timestamptz;
  v_month date;
BEGIN
  -- Ngoại lệ 2: bối cảnh hệ thống.
  IF v_actor IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Ngoại lệ 3: cửa ANNOTATE — guard tự kiểm delta đúng ba cột, không tin lời writer.
  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM app_private.ie_flex_writer_xids w
     WHERE w.income_expense_id = OLD.id
       AND w.transaction_id = pg_current_xact_id()
       AND w.backend_pid = pg_backend_pid()
       AND w.scope = 'ANNOTATE'
  ) AND (to_jsonb(OLD) - ARRAY['attachments','notes','updated_at'])
        IS NOT DISTINCT FROM
        (to_jsonb(NEW) - ARRAY['attachments','notes','updated_at']) THEN
    RETURN NEW;
  END IF;

  v_org := COALESCE(NEW.organization_id, OLD.organization_id);

  -- CỬA CHO CHỦ: chủ tổ chức và super admin vẫn ghi được, có nhật ký
  -- (z99_ie_change_log ghi trước/sau của mọi thay đổi).
  IF public.is_super_admin() OR app_private.is_org_owner_v1(v_org, v_actor) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Xét CẢ phía cũ lẫn phía mới: đẩy phiếu RA khỏi tháng đã chốt cũng là đổi
  -- số của tháng đó, y hệt đẩy phiếu VÀO.
  FOR v_row IN
    SELECT bld, vdate FROM (
      SELECT CASE WHEN TG_OP <> 'INSERT' THEN OLD.building_id END AS bld,
             CASE WHEN TG_OP <> 'INSERT' THEN OLD.voucher_date END AS vdate,
             CASE WHEN TG_OP <> 'INSERT' THEN COALESCE(OLD.business_result_accounting, true) END AS bra
      UNION ALL
      SELECT CASE WHEN TG_OP <> 'DELETE' THEN NEW.building_id END,
             CASE WHEN TG_OP <> 'DELETE' THEN NEW.voucher_date END,
             CASE WHEN TG_OP <> 'DELETE' THEN COALESCE(NEW.business_result_accounting, true) END
    ) s
    WHERE bld IS NOT NULL AND vdate IS NOT NULL AND bra   -- ngoại lệ 1
  LOOP
    v_month := date_trunc('month', v_row.vdate)::date;
    SELECT pm.locked_at INTO v_locked
    FROM public.profit_monthly pm
    WHERE pm.building_id = v_row.bld
      AND pm.period_month = v_month
      AND pm.locked_at IS NOT NULL
    LIMIT 1;

    IF v_locked IS NOT NULL THEN
      RAISE EXCEPTION
        '[PROFIT_LOCKED] Lợi nhuận tháng % của toà này đã chốt và đã chia cho cổ đông — không ghi thêm/sửa phiếu của tháng đó. Hãy lập phiếu ở tháng hiện tại, hoặc nhờ chủ tổ chức mở khoá tháng.',
        to_char(v_month, 'MM/YYYY')
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END
$fn$;

-- a02_: sau hai guard đóng băng (a00_) để thông điệp đóng băng vẫn ưu tiên,
-- nhưng TRƯỚC cầu a85 để không đẻ bút toán rồi mới chặn.
DROP TRIGGER IF EXISTS a02_ie_profit_lock_ins ON public.income_expenses;
CREATE TRIGGER a02_ie_profit_lock_ins
  BEFORE INSERT ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION public.income_expenses_check_profit_lock();

DROP TRIGGER IF EXISTS a02_ie_profit_lock_upd ON public.income_expenses;
CREATE TRIGGER a02_ie_profit_lock_upd
  BEFORE UPDATE ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION public.income_expenses_check_profit_lock();

DROP TRIGGER IF EXISTS a02_ie_profit_lock_del ON public.income_expenses;
CREATE TRIGGER a02_ie_profit_lock_del
  BEFORE DELETE ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION public.income_expenses_check_profit_lock();

-- Hạng mục cũng phải canh: đổi chỗ hai hạng mục sao cho TỔNG KHÔNG ĐỔI thì
-- trigger tính lại total_amount không chạy, nên trigger trên phiếu không nổ —
-- đúng cái bẫy mà bộ probe Đợt 3 đã bắt được với khoá sổ quỹ.
CREATE OR REPLACE FUNCTION public.income_expense_items_check_profit_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_parent uuid;
  v_row record;
  v_locked timestamptz;
  v_month date;
BEGIN
  IF v_actor IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  FOREACH v_parent IN ARRAY ARRAY[
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.income_expense_id END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.income_expense_id END
  ] LOOP
    CONTINUE WHEN v_parent IS NULL;
    FOR v_row IN
      SELECT ie.building_id AS bld, ie.voucher_date AS vdate, ie.organization_id AS org,
             COALESCE(ie.business_result_accounting, true) AS bra
      FROM public.income_expenses ie WHERE ie.id = v_parent
    LOOP
      CONTINUE WHEN v_row.bld IS NULL OR v_row.vdate IS NULL OR NOT v_row.bra;
      IF public.is_super_admin() OR app_private.is_org_owner_v1(v_row.org, v_actor) THEN
        CONTINUE;
      END IF;
      v_month := date_trunc('month', v_row.vdate)::date;
      SELECT pm.locked_at INTO v_locked FROM public.profit_monthly pm
       WHERE pm.building_id = v_row.bld AND pm.period_month = v_month
         AND pm.locked_at IS NOT NULL LIMIT 1;
      IF v_locked IS NOT NULL THEN
        RAISE EXCEPTION
          '[PROFIT_LOCKED] Lợi nhuận tháng % của toà này đã chốt — không sửa hạng mục của phiếu trong tháng đó.',
          to_char(v_month, 'MM/YYYY') USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END
$fn$;

DROP TRIGGER IF EXISTS a02_ie_items_profit_lock ON public.income_expense_items;
CREATE TRIGGER a02_ie_items_profit_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.income_expense_items
  FOR EACH ROW EXECUTE FUNCTION public.income_expense_items_check_profit_lock();

-- ─────────────────────────────────────────────────────────────────────
-- 2. MỞ KHOÁ THÁNG — cơ chế đã có sẵn nhưng KHÔNG AI GỌI ĐƯỢC
--
-- public.unlock_profit_month_v1 tồn tại từ trước, thân hàm đã gác đúng bằng
-- authorize_tenant_action_v3(..., 'shareholder_profit.unlock', ...) và kiểm cả
-- danh sách toà cùng một tổ chức. Nhưng ACL của nó là {postgres=X/postgres} —
-- authenticated KHÔNG gọi được, và không màn hình nào gọi.
-- ⇒ Có khoá mà không có mở, đúng như chủ nói.
--
-- Chỉ cần GRANT: khoá quyền `shareholder_profit.unlock` hiện đúng HAI người có
-- (chủ tổ chức của mỗi org) — khớp yêu cầu "quyền chỉ của super admin và chủ
-- tổ chức". KHÔNG nới thêm gì.
-- ─────────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.unlock_profit_month_v1(text, uuid[]) TO authenticated;

-- Khoá tay thì cũng nên đối xứng — cùng một mô hình quyền
-- (shareholder_profit.lock), để chủ chốt lại tháng sau khi sửa xong.
GRANT EXECUTE ON FUNCTION public.lock_profit_month_v1(text, jsonb) TO authenticated;

DO $assert$
DECLARE v_n int;
BEGIN
  -- Chốt chặn: hai hàm này PHẢI tự gác bằng quyền, nếu không GRANT là mở toang.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('lock_profit_month_v1','unlock_profit_month_v1')
     AND pg_get_functiondef(p.oid) ILIKE '%authorize_tenant_action_v3%';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'lock/unlock_profit_month_v1 không tự gác quyền — KHÔNG GRANT (chỉ % / 2 hàm có)', v_n;
  END IF;
  RAISE NOTICE 'Đã GRANT lock/unlock_profit_month_v1 (cả hai tự gác bằng authorize_tenant_action_v3)';
END
$assert$;

COMMIT;

NOTIFY pgrst, 'reload schema';
