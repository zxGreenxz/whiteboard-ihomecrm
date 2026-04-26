-- =============================================================
-- BUNDLE 4: Cleanup all user-owned operational data so we can re-seed
-- from the Excel files. Apply once via SQL Editor.
-- Idempotent — re-running is a no-op when tables are already empty.
-- =============================================================

BEGIN;

-- 1. Junction / dependent rows first (they reference contracts/invoices)
DELETE FROM contract_customers WHERE contract_id IN (SELECT id FROM contracts);
DELETE FROM contract_services  WHERE contract_id IN (SELECT id FROM contracts);
DELETE FROM contract_extensions WHERE contract_id IN (SELECT id FROM contracts);
DELETE FROM contract_terminations WHERE contract_id IN (SELECT id FROM contracts);
DELETE FROM contract_transfers WHERE contract_id IN (SELECT id FROM contracts);

-- 2. Invoices + payments + items
DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices);
DELETE FROM payments      WHERE invoice_id IN (SELECT id FROM invoices);
DELETE FROM income_expense_items WHERE income_expense_id IN (SELECT id FROM income_expenses);
DELETE FROM income_expenses;
DELETE FROM invoices;

-- 3. Issues / jobs (FK to buildings/rooms/contracts)
DELETE FROM issues;
DELETE FROM jobs;

-- 4. Vehicles, assets
DELETE FROM vehicles;
DELETE FROM assets;

-- 5. Contracts
DELETE FROM contracts;

-- 6. Customers (and tenants if separate)
DELETE FROM customers;
-- Some installs also have a `tenants` table:
DELETE FROM tenants WHERE TRUE;

-- 7. Services & rooms & buildings
DELETE FROM services;
DELETE FROM beds;
DELETE FROM rooms;
DELETE FROM buildings;

-- 8. Cashbooks (accounts) + leads + deposits — wipe to start clean
DELETE FROM accounts;
DELETE FROM leads;
DELETE FROM deposits;

NOTIFY pgrst, 'reload schema';
COMMIT;
