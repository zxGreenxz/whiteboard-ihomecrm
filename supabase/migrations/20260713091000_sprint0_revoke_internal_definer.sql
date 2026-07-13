-- =============================================================================
-- Sprint 0.3/0.4 — Thu hồi EXECUTE trực tiếp cho các SECURITY DEFINER nội bộ còn
-- hở. (AUTHORIZATION-PLAN.md §9.1–9.2, §17 Sprint 0 deliverable 3–4)
--
-- Đã kiểm live: MỌI caller của 8 helper dưới đây đều SECURITY DEFINER (trigger fn
-- + RPC impl chạy dưới owner) ⇒ REVOKE cả anon+authenticated KHÔNG phá luồng hợp
-- lệ (nested call kiểm quyền theo owner, không theo caller role). Tiếp nối đúng
-- pattern migration 20260710130500 (kiểu "internal-only": revoke cả authenticated).
--
--   P0 (mục 9.2, migration 20260710130500 BỎ SÓT đúng 2 hàm này):
--     _internal_settlement_account(uuid)          — nhận UUID tuỳ ý, insert/update accounts
--     _termination_ensure_type(uuid,text,text)    — nhận UUID tuỳ ý, insert income_expense_types
--
--   Recompute helpers (mục 9.1, callable write không guard, chỉ gọi trong trigger/RPC):
--     recompute_invoice_for_id(uuid)
--     recompute_ie_business_result(uuid)
--     recompute_contract_deposit_paid(uuid)
--     recompute_material_stock(uuid)
--     recompute_room_reservation(uuid)
--     ie_recompute_commission_kind(uuid)
--
-- approve_voucher/unapprove_voucher: FE (authenticated) có gọi trực tiếp ⇒ CHỈ
-- revoke anon (giữ authenticated). Maker-checker/creator-bypass là P1 (Sprint 4).
--
-- CẢNH BÁO CREATE OR REPLACE: nếu các hàm này bị recreate sau này, ACL reset về
-- PUBLIC execute — phải re-REVOKE (CI gate §9.3 điểm 9 sẽ bắt regress).
-- Idempotent.
-- =============================================================================

BEGIN;

-- P0: 2 internal helper bị bỏ sót ở 20260710130500 — internal-only, revoke cả authenticated.
REVOKE ALL ON FUNCTION public._internal_settlement_account(uuid)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._termination_ensure_type(uuid,text,text) FROM PUBLIC, anon, authenticated;

-- Recompute helpers — chỉ gọi trong trigger/RPC SECURITY DEFINER ⇒ internal-only.
REVOKE ALL ON FUNCTION public.recompute_invoice_for_id(uuid)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recompute_ie_business_result(uuid)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recompute_contract_deposit_paid(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recompute_material_stock(uuid)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recompute_room_reservation(uuid)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ie_recompute_commission_kind(uuid)    FROM PUBLIC, anon, authenticated;

-- approve/unapprove_voucher: giữ authenticated (FE dùng), chỉ chặn anon.
REVOKE ALL   ON FUNCTION public.approve_voucher(uuid)   FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.approve_voucher(uuid) TO authenticated;
REVOKE ALL   ON FUNCTION public.unapprove_voucher(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.unapprove_voucher(uuid) TO authenticated;

COMMIT;

-- =============================================================================
-- ROLLBACK (KHÔNG khuyến nghị):
--   GRANT EXECUTE ON FUNCTION public._internal_settlement_account(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public._termination_ensure_type(uuid,text,text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.recompute_invoice_for_id(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.recompute_ie_business_result(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.recompute_contract_deposit_paid(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.recompute_material_stock(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.recompute_room_reservation(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.ie_recompute_commission_kind(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.approve_voucher(uuid) TO anon;
--   GRANT EXECUTE ON FUNCTION public.unapprove_voucher(uuid) TO anon;
-- =============================================================================
