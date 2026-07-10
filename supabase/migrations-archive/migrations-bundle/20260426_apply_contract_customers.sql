-- =============================================================
-- BUNDLE 2: Missing contract_customers table (and friends)
-- After running 20260426_apply_all.sql, the test still showed:
--   PGRST200 "Could not find a relationship between 'contracts' and
--   'contract_customers' in the schema cache".
-- → Migration 20250710000001_lease_contract_management.sql was never
-- applied on this Supabase project. This bundle ports the essentials
-- so the relationship and helper RPCs exist.
--
-- Idempotent: safe to re-run.
-- =============================================================

BEGIN;

-- ───────────────────────────────────────────────────────────
-- contract_customers junction table
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contract_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  is_representative BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT contract_customers_unique UNIQUE (contract_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_contract_customers_contract_id ON contract_customers(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_customers_customer_id ON contract_customers(customer_id);

ALTER TABLE contract_customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own contract customers"   ON contract_customers;
DROP POLICY IF EXISTS "Users can insert own contract customers" ON contract_customers;
DROP POLICY IF EXISTS "Users can update own contract customers" ON contract_customers;
DROP POLICY IF EXISTS "Users can delete own contract customers" ON contract_customers;

CREATE POLICY "Users can view own contract customers"
  ON contract_customers FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_customers.contract_id
        AND contracts.user_id = auth.uid()
    )
  );
CREATE POLICY "Users can insert own contract customers"
  ON contract_customers FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_customers.contract_id
        AND contracts.user_id = auth.uid()
    )
  );
CREATE POLICY "Users can update own contract customers"
  ON contract_customers FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_customers.contract_id
        AND contracts.user_id = auth.uid()
    )
  );
CREATE POLICY "Users can delete own contract customers"
  ON contract_customers FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_customers.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

-- updated_at — fallback function in case it's missing
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_contract_customers_updated_at ON contract_customers;
CREATE TRIGGER update_contract_customers_updated_at
  BEFORE UPDATE ON contract_customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Ensure exactly one representative per contract
CREATE OR REPLACE FUNCTION check_contract_representative()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_representative = true THEN
    UPDATE contract_customers
    SET is_representative = false
    WHERE contract_id = NEW.contract_id AND id != NEW.id AND is_representative = true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ensure_single_representative ON contract_customers;
CREATE TRIGGER ensure_single_representative
  BEFORE INSERT OR UPDATE ON contract_customers
  FOR EACH ROW EXECUTE FUNCTION check_contract_representative();

-- ───────────────────────────────────────────────────────────
-- Backfill: copy any contracts.tenant_id → contract_customers
-- so existing data still surfaces a customer in the new join table.
-- ───────────────────────────────────────────────────────────
INSERT INTO contract_customers (contract_id, customer_id, is_representative)
SELECT c.id, c.tenant_id, true
FROM contracts c
WHERE c.tenant_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM contract_customers cc WHERE cc.contract_id = c.id
  )
  AND EXISTS (SELECT 1 FROM customers cu WHERE cu.id = c.tenant_id)
ON CONFLICT (contract_id, customer_id) DO NOTHING;

-- ───────────────────────────────────────────────────────────
-- Reload PostgREST schema cache so the new relationship is visible
-- without a project restart.
-- ───────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;
