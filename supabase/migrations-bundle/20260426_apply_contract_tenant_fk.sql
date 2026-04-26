-- =============================================================
-- BUNDLE 3: Drop the obsolete contracts.tenant_id → tenants(id) FK.
--
-- Production error after Bundle 2:
--   23503  Key is not present in table "tenants"
--   constraint "contracts_tenant_id_fkey"
--
-- Root cause: the legacy schema has  tenant_id UUID REFERENCES tenants(id),
-- but the new lease-management flow stores customers via
-- contract_customers (referencing customers(id), NOT tenants(id)). When
-- useCreateContract sets contracts.tenant_id = customers[0].customer_id,
-- the customer_id is a `customers` UUID, not a `tenants` UUID, so the
-- FK fails.
--
-- Fix:
--  1. Drop the contracts_tenant_id_fkey constraint (the data layer
--     authoritative for "khách hàng đại diện" is now contract_customers).
--  2. Make contracts.tenant_id nullable — older code paths still write
--     it for backwards compatibility, but if blank, contract_customers
--     is the source of truth.
--
-- Idempotent.
-- =============================================================

BEGIN;

ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_tenant_id_fkey;
ALTER TABLE contracts ALTER COLUMN tenant_id DROP NOT NULL;

COMMENT ON COLUMN contracts.tenant_id IS
  'Legacy: representative customer id (was FK→tenants). Authoritative customers now live in contract_customers.';

NOTIFY pgrst, 'reload schema';

COMMIT;
