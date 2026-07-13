-- =============================================================================
-- Sprint 5a — Guard cột tài chính nhạy cảm khỏi ghi trực tiếp từ client.
-- (AUTHORIZATION-PLAN §8.3 invariant 1, §5 acceptance)
--
-- Cách phân biệt client-direct vs RPC: trigger SECURITY INVOKER ⇒ current_user =
-- 'authenticated' khi client ghi thẳng PostgREST; = owner (postgres) khi ghi bên
-- trong SECURITY DEFINER RPC (approve_voucher, _post_financial_voucher, …).
-- ⇒ chỉ SIẾT client, KHÔNG phá RPC hợp lệ. An toàn với flow hiện tại:
--   • Direct-APPROVED insert cũ để approved_by=NULL ⇒ vẫn pass.
--   • Posting metadata (posting_id/approval_request_id/…) là cột MỚI Sprint 4,
--     flow cũ không đụng ⇒ chặn client ghi chúng không phá gì.
-- Chống: client giả mạo approved_by người khác + tự ghi posting metadata.
-- Idempotent. Rollback = DROP trigger/function.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public._guard_ie_financial_columns()
 RETURNS trigger
 LANGUAGE plpgsql   -- SECURITY INVOKER (mặc định): current_user phản ánh client vs RPC
AS $fn$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF TG_OP='INSERT' THEN
      IF NEW.approved_by IS NOT NULL AND NEW.approved_by <> v_uid THEN
        RAISE EXCEPTION 'Không được đặt approved_by cho người khác (chống giả mạo audit)' USING ERRCODE='42501';
      END IF;
      IF NEW.posting_id IS NOT NULL OR NEW.approval_request_id IS NOT NULL
         OR NEW.posted_at_v2 IS NOT NULL OR NEW.reversed_by_posting_id IS NOT NULL THEN
        RAISE EXCEPTION 'Posting metadata chỉ được đặt bởi RPC duyệt/hạch toán' USING ERRCODE='42501';
      END IF;
    ELSIF TG_OP='UPDATE' THEN
      IF NEW.approved_by IS DISTINCT FROM OLD.approved_by
         AND NEW.approved_by IS NOT NULL AND NEW.approved_by <> v_uid THEN
        RAISE EXCEPTION 'Không được đổi approved_by sang người khác' USING ERRCODE='42501';
      END IF;
      IF NEW.posting_id IS DISTINCT FROM OLD.posting_id
         OR NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id
         OR NEW.posted_at_v2 IS DISTINCT FROM OLD.posted_at_v2
         OR NEW.reversed_by_posting_id IS DISTINCT FROM OLD.reversed_by_posting_id THEN
        RAISE EXCEPTION 'Posting metadata bất biến từ phía client' USING ERRCODE='42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_guard_ie_financial ON public.income_expenses;
CREATE TRIGGER trg_guard_ie_financial
  BEFORE INSERT OR UPDATE ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION public._guard_ie_financial_columns();

-- invoices: guard approved_by forgery từ client.
CREATE OR REPLACE FUNCTION public._guard_invoice_columns()
 RETURNS trigger LANGUAGE plpgsql
AS $fn$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF TG_OP='INSERT' AND NEW.approved_by IS NOT NULL AND NEW.approved_by <> v_uid THEN
      RAISE EXCEPTION 'Không được đặt approved_by hoá đơn cho người khác' USING ERRCODE='42501';
    ELSIF TG_OP='UPDATE' AND NEW.approved_by IS DISTINCT FROM OLD.approved_by
          AND NEW.approved_by IS NOT NULL AND NEW.approved_by <> v_uid THEN
      RAISE EXCEPTION 'Không được đổi approved_by hoá đơn sang người khác' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_guard_invoice ON public.invoices;
CREATE TRIGGER trg_guard_invoice
  BEFORE INSERT OR UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public._guard_invoice_columns();

COMMIT;
