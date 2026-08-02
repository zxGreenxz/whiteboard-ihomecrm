-- =====================================================================
-- Khoá tháng đã chốt lợi nhuận: PHỦ LUÔN PHIẾU NGOÀI KQKD DO NGƯỜI DÙNG TẠO
--
-- Chủ 30/07: "Phiếu ngoài KQKD cũng bị khoá khi chốt kỳ, tránh tạo lung tung
-- không ai kiểm soát từ sổ quỹ."
--
-- Bản trước miễn trừ TOÀN BỘ phiếu ngoài KQKD. Lý lẽ hồi đó (chúng không góp
-- vào con số đã chia cho cổ đông) đúng về kế toán nhưng bỏ qua điều chủ quan
-- tâm: chúng VẪN ĐỔI TỒN QUỸ. Một phiếu chi ngoài KQKD ghi vào tháng đã chốt
-- làm số dư sổ quỹ của tháng đó khác đi mà không ai duyệt lại.
--
-- ⚠ NHƯNG KHÔNG ĐƯỢC KHOÁ TUỐT. Đo trên prod, phiếu ngoài KQKD đến từ:
--     28  (người dùng tự tạo)     ← ĐÚNG thứ cần chặn
--     20  handover.transfer       ← hai chân phiên bàn giao tiền mặt
--     11  salary.staff            ← chi lương
--      2  adjustment.close_coc · 1 contract.deposit · 1 invoice.payment
--      1  invoice.refund
--   Khoá tuốt là chặn luôn việc XÁC NHẬN BÀN GIAO: confirm_cash_handover đẩy
--   ngày hai chân về GREATEST(CURRENT_DATE, ngày chốt SỔ + 1) — đó là khoá sổ
--   quỹ, không phải khoá lợi nhuận — nên ngày rơi vào tháng hiện tại, mà
--   07/2026 đang khoá lợi nhuận. Tiền đã trao tay ngoài đời mà sổ không ghi được.
--
-- ⇒ Ranh giới đúng là NGƯỜI TẠO chứ không phải LOẠI PHIẾU:
--     ngoài KQKD + system_source IS NULL  → người dùng tự gõ → CHẶN
--     ngoài KQKD + có system_source       → một luồng có nghi thức riêng sở
--                                           hữu nó (bàn giao hai bên, lương,
--                                           chốt sổ…) → cho qua
--   Phiếu TRONG KQKD vẫn chặn bất kể nguồn, như bản trước.
-- =====================================================================

BEGIN;

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
  IF v_actor IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Cửa ANNOTATE (quyết định #8): vẫn bổ sung được ảnh chứng từ / ghi chú.
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

  IF public.is_super_admin() OR app_private.is_org_owner_v1(v_org, v_actor) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  FOR v_row IN
    SELECT bld, vdate FROM (
      SELECT CASE WHEN TG_OP <> 'INSERT' THEN OLD.building_id END AS bld,
             CASE WHEN TG_OP <> 'INSERT' THEN OLD.voucher_date END AS vdate,
             -- Chặn khi: phiếu TRONG KQKD (bất kể nguồn) HOẶC phiếu ngoài KQKD
             -- do NGƯỜI DÙNG tự tạo (không có system_source).
             CASE WHEN TG_OP <> 'INSERT' THEN
               (COALESCE(OLD.business_result_accounting, true) OR OLD.system_source IS NULL)
             END AS canh
      UNION ALL
      SELECT CASE WHEN TG_OP <> 'DELETE' THEN NEW.building_id END,
             CASE WHEN TG_OP <> 'DELETE' THEN NEW.voucher_date END,
             CASE WHEN TG_OP <> 'DELETE' THEN
               (COALESCE(NEW.business_result_accounting, true) OR NEW.system_source IS NULL)
             END
    ) s
    WHERE bld IS NOT NULL AND vdate IS NOT NULL AND canh
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
        '[PROFIT_LOCKED] Kỳ tháng % của toà này đã chốt lợi nhuận — không ghi thêm/sửa phiếu của tháng đó, kể cả phiếu ngoài kết quả kinh doanh. Hãy lập phiếu ở tháng hiện tại, hoặc nhờ chủ tổ chức mở khoá tháng.',
        to_char(v_month, 'MM/YYYY')
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END
$fn$;

-- Hạng mục: cùng ranh giới.
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
             (COALESCE(ie.business_result_accounting, true) OR ie.system_source IS NULL) AS canh
      FROM public.income_expenses ie WHERE ie.id = v_parent
    LOOP
      CONTINUE WHEN v_row.bld IS NULL OR v_row.vdate IS NULL OR NOT v_row.canh;
      IF public.is_super_admin() OR app_private.is_org_owner_v1(v_row.org, v_actor) THEN
        CONTINUE;
      END IF;
      v_month := date_trunc('month', v_row.vdate)::date;
      SELECT pm.locked_at INTO v_locked FROM public.profit_monthly pm
       WHERE pm.building_id = v_row.bld AND pm.period_month = v_month
         AND pm.locked_at IS NOT NULL LIMIT 1;
      IF v_locked IS NOT NULL THEN
        RAISE EXCEPTION
          '[PROFIT_LOCKED] Kỳ tháng % của toà này đã chốt — không sửa hạng mục của phiếu trong tháng đó.',
          to_char(v_month, 'MM/YYYY') USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END
$fn$;

COMMIT;

NOTIFY pgrst, 'reload schema';
