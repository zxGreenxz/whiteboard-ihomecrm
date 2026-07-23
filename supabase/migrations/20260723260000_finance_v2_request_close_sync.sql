-- Finance V2 — Hotfix 7l: đóng approval_request khi phiếu đã xử lý qua writer V2.
--
-- Browser F3 bắt được: "Duyệt và Chi…" từ inbox chạy RPC V2 thành công (phiếu
-- APPROVED+POSTED, tiền đúng) nhưng approval_requests của phiếu vẫn
-- PENDING_APPROVAL ⇒ dòng kẹt vĩnh viễn trong inbox mọi approver. Engine decide
-- legacy tự đóng request; luồng V2 không đi qua engine nên cần sync.
--
-- Trigger a87 AFTER UPDATE trên income_expenses: khi phiếu rời UNAPPROVED,
-- request PENDING_APPROVAL của nó được đóng theo ngữ nghĩa:
--   APPROVED + POSTED   → state 'POSTED'  (posted_at = now())
--   APPROVED (chưa chi) → state 'APPROVED'
--   CANCELLED           → state 'CANCELLED'
-- Chỉ đụng request còn PENDING_APPROVAL — flow decide legacy (đã tự đóng) no-op.

BEGIN;

CREATE OR REPLACE FUNCTION app_private.finance_v2_close_request_on_voucher_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_state text;
BEGIN
  IF NEW.approval_status = OLD.approval_status
     AND COALESCE(NEW.posting_status,'') = COALESCE(OLD.posting_status,'') THEN
    RETURN NEW;
  END IF;
  IF NEW.approval_status = 'UNAPPROVED' THEN
    RETURN NEW; -- quay về chờ duyệt (huỷ duyệt) — request do engine quản.
  END IF;

  v_state := CASE
    WHEN NEW.approval_status = 'CANCELLED' THEN 'CANCELLED'
    WHEN NEW.posting_status = 'POSTED' THEN 'POSTED'
    ELSE 'APPROVED'
  END;

  UPDATE public.approval_requests ar
     SET state = v_state,
         outcome_kind = COALESCE(ar.outcome_kind, 'V2_LIFECYCLE_SYNC'),
         posted_at = CASE WHEN v_state = 'POSTED' THEN now() ELSE ar.posted_at END,
         closed_at = now(),
         version = ar.version + 1
   WHERE ar.subject_type = 'FINANCIAL_VOUCHER'
     AND ar.subject_id = NEW.id
     AND ar.state = 'PENDING_APPROVAL';

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS a87_finance_v2_request_close_sync ON public.income_expenses;
CREATE TRIGGER a87_finance_v2_request_close_sync
  AFTER UPDATE OF approval_status, posting_status ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION app_private.finance_v2_close_request_on_voucher_change();

-- Backfill: request PENDING nhưng phiếu đã rời UNAPPROVED (kẹt từ trước).
UPDATE public.approval_requests ar
   SET state = CASE
         WHEN ie.approval_status = 'CANCELLED' THEN 'CANCELLED'
         WHEN ie.posting_status = 'POSTED' THEN 'POSTED'
         ELSE 'APPROVED'
       END,
       outcome_kind = COALESCE(ar.outcome_kind, 'V2_LIFECYCLE_SYNC_BACKFILL'),
       posted_at = CASE WHEN ie.posting_status = 'POSTED' THEN now() ELSE ar.posted_at END,
       closed_at = now(),
       version = ar.version + 1
  FROM public.income_expenses ie
 WHERE ar.subject_type = 'FINANCIAL_VOUCHER'
   AND ar.subject_id = ie.id
   AND ar.state = 'PENDING_APPROVAL'
   AND ie.approval_status <> 'UNAPPROVED';

COMMIT;

NOTIFY pgrst, 'reload schema';
