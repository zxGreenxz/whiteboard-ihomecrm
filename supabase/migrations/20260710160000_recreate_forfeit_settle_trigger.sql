-- =============================================================
-- TÁI TẠO trigger trg_forfeit_settle_on_approve TRONG CHUỖI migration
-- (khôi phục khả năng replay — Phase 1b, 2026-07-10)
--
-- VẤN ĐỀ: Phase 4 (be1ffc0) git-mv file 20260617000001_forfeit_full_settlement.sql
-- vào migrations-archive/. Đó là file DUY NHẤT chứa `CREATE TRIGGER
-- trg_forfeit_settle_on_approve`. Một lần replay CSDL sạch từ supabase/migrations/
-- SẼ tạo được FUNCTION (bản 'CT' đúng, qua 20260619000001_payment_method_cantru.sql)
-- nhưng KHÔNG BAO GIỜ gắn TRIGGER vào income_expenses → duyệt "bỏ cọc" thầm lặng
-- KHÔNG còn tự thanh lý hoá đơn / cascade cặp phiếu.
--
-- CẢNH BÁO: TUYỆT ĐỐI KHÔNG un-archive/replay 20260617000001 — thân hàm trong đó
-- là bản CŨ dùng 'TM'::payment_method (line 295), replay sẽ REVERT hàm live về TM
-- (phồng ô TM dashboard). Migration này lấy thân hàm từ bản LIVE HIỆN HÀNH ('CT').
--
-- Idempotent + no-op trên live (hàm/trigger đã đúng); chỉ có tác dụng khi replay.
-- =============================================================

BEGIN;

-- Thân hàm = bản LIVE hiện hành (pg_get_functiondef, 'CT'::payment_method).
CREATE OR REPLACE FUNCTION public.trg_forfeit_settle_on_approve()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pay_note text;
BEGIN
  -- Chỉ xử lý phiếu thuộc nhóm "cấn cọc bỏ cọc".
  IF NEW.notes IS NULL OR NEW.notes NOT LIKE '[CẤN CỌC BỎ CỌC %' THEN
    RETURN NULL;
  END IF;

  -- DUYỆT: UNAPPROVED → APPROVED
  IF NEW.approval_status = 'APPROVED'
     AND COALESCE(OLD.approval_status,'') <> 'APPROVED'
     AND NEW.deleted_at IS NULL THEN
    -- Duyệt nốt phiếu còn lại cùng nhóm (1 cú bấm xong cả cặp).
    UPDATE income_expenses
       SET approval_status = 'APPROVED',
           approved_by     = NEW.approved_by,
           approved_at     = NEW.approved_at,
           updated_at      = NOW()
     WHERE contract_id = NEW.contract_id
       AND id <> NEW.id
       AND notes LIKE '[CẤN CỌC BỎ CỌC %'
       AND deleted_at IS NULL
       AND approval_status = 'UNAPPROVED';

    -- Phiếu THU gắn hoá đơn → INSERT payments để hoá đơn thanh lý → PAID.
    IF NEW.type = 'INCOME' AND NEW.invoice_id IS NOT NULL AND COALESCE(NEW.total_amount,0) > 0 THEN
      v_pay_note := '[CẤN CỌC BỎ CỌC PAYMENT ' || NEW.id::text || ']';
      INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes)
      SELECT NEW.user_id, NEW.invoice_id, NEW.total_amount, 'CT'::payment_method,
             COALESCE(NEW.voucher_date, CURRENT_DATE), v_pay_note
       WHERE NOT EXISTS (
         SELECT 1 FROM payments WHERE invoice_id = NEW.invoice_id AND notes = v_pay_note
       );
    END IF;
    RETURN NULL;
  END IF;

  -- ĐẢO DUYỆT: APPROVED → UNAPPROVED/CANCELLED (gỡ đối xứng)
  IF COALESCE(OLD.approval_status,'') = 'APPROVED'
     AND NEW.approval_status IN ('UNAPPROVED','CANCELLED') THEN
    IF NEW.type = 'INCOME' AND NEW.invoice_id IS NOT NULL THEN
      DELETE FROM payments
       WHERE invoice_id = NEW.invoice_id
         AND notes = '[CẤN CỌC BỎ CỌC PAYMENT ' || NEW.id::text || ']';
    END IF;
    UPDATE income_expenses
       SET approval_status = NEW.approval_status, updated_at = NOW()
     WHERE contract_id = NEW.contract_id
       AND id <> NEW.id
       AND notes LIKE '[CẤN CỌC BỎ CỌC %'
       AND deleted_at IS NULL
       AND approval_status = 'APPROVED';
    RETURN NULL;
  END IF;

  RETURN NULL;
END;
$function$;

-- Gắn lại trigger (idempotent). ĐÂY là dòng bị mất khi replay.
DROP TRIGGER IF EXISTS trg_forfeit_settle_on_approve ON public.income_expenses;
CREATE TRIGGER trg_forfeit_settle_on_approve
  AFTER UPDATE OF approval_status ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION public.trg_forfeit_settle_on_approve();

REVOKE ALL ON FUNCTION public.trg_forfeit_settle_on_approve() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- =============================================================
-- ROLLBACK: KHÔNG cần (idempotent, no-op trên live). Nếu buộc gỡ trigger:
--   DROP TRIGGER IF EXISTS trg_forfeit_settle_on_approve ON public.income_expenses;
-- (KHÔNG khôi phục file archive 20260617000001 — bản TM đã lỗi thời.)
-- =============================================================
