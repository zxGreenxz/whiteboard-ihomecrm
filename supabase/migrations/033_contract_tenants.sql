-- =============================================
-- Migration 033: Contract Tenants Junction Table
-- Created: 2026-02-20
-- Description: Support multiple tenants per contract
-- The contracts.tenant_id remains as the "representative" tenant
-- This table stores ALL tenants (including the representative)
-- =============================================

CREATE TABLE IF NOT EXISTS contract_tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  is_representative BOOLEAN NOT NULL DEFAULT false,
  move_in_date DATE,
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(contract_id, tenant_id)
);

-- Indexes
CREATE INDEX idx_contract_tenants_contract_id ON contract_tenants(contract_id);
CREATE INDEX idx_contract_tenants_tenant_id ON contract_tenants(tenant_id);

-- RLS Policies
ALTER TABLE contract_tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view contract tenants"
  ON contract_tenants FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_tenants.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert contract tenants"
  ON contract_tenants FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_tenants.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update contract tenants"
  ON contract_tenants FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_tenants.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete contract tenants"
  ON contract_tenants FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_tenants.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

COMMENT ON TABLE contract_tenants IS 'Junction table linking multiple tenants to a contract';
COMMENT ON COLUMN contract_tenants.is_representative IS 'Whether this tenant is the representative (đại diện) for the contract';
