-- =============================================================================
-- Sprint 6a — Definer ACL hygiene (§9.3). Revoke anon/auth cho trigger/helper mới
-- của Sprint 3–4 (chạy trong trigger/RPC owner-context ⇒ revoke không phá luồng).
-- =============================================================================
BEGIN;
REVOKE ALL ON FUNCTION public._autofill_org() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._guard_ie_financial_columns() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._guard_invoice_columns() FROM PUBLIC, anon, authenticated;
COMMIT;
