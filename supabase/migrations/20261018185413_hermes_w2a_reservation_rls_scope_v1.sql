-- Hermes đọc đầy đủ — ĐỢT 2, Gói A, sau phát hành (19/10/2026): báo cáo reservation_vouchers (phiếu cọc giữ chỗ) khai phạm vi
-- 'rls_buildings' — chủ dự án chốt "Hermes đọc theo đúng quyền của người dùng trên web": route /deposits (RequirePermission
-- module="deposits" không truyền toà) + RLS income_expenses (gồm phiếu vào sổ quỹ người dùng giữ). Áp SAU
-- 20261018185339_hermes_w2_rls_buildings_scope_v1 (cổng nhận kiểu này) và 20261018182656 (hàm dùng chung + hàm đọc theo RLS).
-- app_private.hermes_w2a_catalog_v1 (thân = 20261018010000, đổi đúng scope của reservation_vouchers; tám báo cáo còn lại giữ
-- 'rows'). Không DROP, không đổi chữ ký, không GRANT/REVOKE, không ghi dữ liệu. Khớp wave2-a-contract.mjs (assertPackageParity).
-- Phát hành: connector/broker phải có wave2-registry.mjs nhận 'rls_buildings' TRƯỚC khi áp file này (broker cũ so fence với tập
-- toà của khoá ⇒ từ chối kết quả có toà ngoài tập đó).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.hermes_w2a_catalog_v1()') IS NULL
    OR strpos((SELECT prosrc FROM pg_proc WHERE oid='app_private.hermes_w2_catalog_v1(text)'::regprocedure),'rls_buildings')=0 THEN
    RAISE EXCEPTION 'hermes_w2a_reservation_rls_scope_requires_gate';
  END IF;
END $requires$;

CREATE OR REPLACE FUNCTION app_private.hermes_w2a_catalog_v1()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT '{
  "payment_schedule":{"permission":"reports_finance.payment_schedule","source":"crm.finance_payment_schedule_v1","scope":"rows",
    "params":["buildingId","fromDate","toDate"],"required":[],"statuses":null,"kinds":null,"scopeKeys":["customers.view"]},
  "overpayment":{"permission":"reports_finance.overpayment","source":"crm.finance_overpayment_invoices_v1","scope":"rows",
    "params":["buildingId"],"required":[],"statuses":null,"kinds":null,"scopeKeys":["customers.view"]},
  "collection":{"permission":"thu_tien.view","source":"crm.thu_tien_collection_v1","scope":"rows",
    "params":["month","buildingId","status","fromDate","toDate"],"required":["month"],"statuses":["paid","unpaid"],"kinds":null,
    "scopeKeys":["customers.view"]},
  "invoice_detail":{"permission":"invoices.view","source":"crm.invoice_detail_v1","scope":"rows",
    "params":["invoiceId"],"required":["invoiceId"],"statuses":null,"kinds":null,"scopeKeys":["customers.view"]},
  "reservation_vouchers":{"permission":"deposits.view","source":"crm.deposit_reservation_vouchers_v1","scope":"rls_buildings",
    "params":["buildingId","status","query"],"required":[],"statuses":["APPROVED","UNAPPROVED","CANCELLED"],"kinds":null,
    "scopeKeys":["customers.view"]},
  "reservation_settlements":{"permission":"deposits.view","source":"crm.get_reservation_settlements_v1","scope":"rows",
    "params":["buildingId","status"],"required":[],"statuses":["PENDING","PAID","NOT_REQUIRED"],"kinds":null,"scopeKeys":["customers.view"]},
  "held_deposits":{"permission":"deposits.view","source":"crm.deposit_held_contracts_v1","scope":"rows",
    "params":["buildingId","status"],"required":[],"statuses":["FULL","SHORT","FIRST_INVOICE"],"kinds":null,"scopeKeys":["customers.view"]},
  "deposit_refunds":{"permission":"deposits.view","source":"crm.deposit_refunds_forfeits_v1","scope":"rows",
    "params":["buildingId","kind"],"required":[],"statuses":null,"kinds":["REFUND","FORFEIT"],"scopeKeys":["customers.view"]},
  "change_ledger":{"permission":"deposits.view","source":"crm.cashbook_change_ledger_v1","scope":"rows",
    "params":["cashbookId","fromDate","toDate"],"required":["cashbookId"],"statuses":null,"kinds":null,"scopeKeys":["customers.view"]}
 }'::jsonb
$fn$;

ALTER FUNCTION app_private.hermes_w2a_catalog_v1() OWNER TO postgres;
COMMIT;
NOTIFY pgrst,'reload schema';
