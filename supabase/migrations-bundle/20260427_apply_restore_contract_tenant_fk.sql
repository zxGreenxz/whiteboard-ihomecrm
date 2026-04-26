-- =============================================================
-- BUNDLE: Restore the contracts.tenant_id → tenants(id) FK so the
-- PostgREST schema cache resolves `tenant:tenants` embeds again.
--
-- Background
-- ──────────
-- Bundle 20260426_apply_contract_tenant_fk.sql dropped this FK because
-- new code paths were writing customer_id (from `customers`) into
-- contracts.tenant_id, which violated the FK to `tenants`.
--
-- That fix made writes succeed but broke the schema cache for ~30
-- existing read queries that say  `tenant:tenants!contracts_tenant_id_fkey`
-- → all of those return PGRST200.
--
-- Resolution
-- ──────────
-- Latest seed leaves contracts.tenant_id = NULL on every row (the
-- authoritative customer link is contract_customers). New writes from
-- useContracts.ts also set tenant_id = NULL. So re-adding the FK is
-- safe — there is no row with a non-null tenant_id to violate it.
--
-- We re-add it as `ON DELETE SET NULL` (matches the previous behaviour
-- and is benign). It stays nullable.
--
-- Idempotent — re-running is a no-op.
-- =============================================================

BEGIN;

-- Defensive: any leftover non-null tenant_id whose row is not in tenants
-- gets set to NULL so the FK constraint can be added without 23503.
UPDATE contracts
   SET tenant_id = NULL
 WHERE tenant_id IS NOT NULL
   AND tenant_id NOT IN (SELECT id FROM tenants);

ALTER TABLE contracts
  DROP CONSTRAINT IF EXISTS contracts_tenant_id_fkey;

ALTER TABLE contracts
  ADD CONSTRAINT contracts_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL;

COMMENT ON COLUMN contracts.tenant_id IS
  'Legacy: representative customer id (FK→tenants). New writes leave NULL — authoritative customer list is contract_customers.';

NOTIFY pgrst, 'reload schema';
COMMIT;
