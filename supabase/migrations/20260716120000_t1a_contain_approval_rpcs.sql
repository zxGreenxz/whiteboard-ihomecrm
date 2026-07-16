-- T1a — Containment: revoke exposed prototype approval RPCs khỏi client roles.
-- Audit 2026-07-15 (docs/Kết luận kiểm tra.md §2): submit/decide callable bởi
-- authenticated với contract không đủ (không exact permission, idempotency chết,
-- client chọn được classification). Caller inventory 2026-07-16: 0 caller trong
-- src/ + supabase/functions/ + infra/ (chỉ xuất hiện trong types generated).
-- Helpers _eval_approval_rule/_post_financial_voucher đã non-callable từ trước
-- (chỉ postgres + service_role — verify live catalog 2026-07-16).
-- Approval workflow v2 (T3) sẽ thay thế bằng contract đầy đủ, non-callable
-- cho tới khi wire ở T5/T7.
BEGIN;

REVOKE EXECUTE ON FUNCTION public.submit_financial_voucher(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.decide_financial_voucher(uuid, text, text, bigint)
  FROM PUBLIC, anon, authenticated;

COMMIT;
