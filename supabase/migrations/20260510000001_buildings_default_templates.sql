-- =============================================
-- Migration: building default templates
-- Description: per-building default contract & invoice templates so the
-- "Mẫu hợp đồng" / "Mẫu in hóa đơn" selects in the Building form can
-- actually persist a choice (previously the selects were disabled stubs
-- because no column existed).
-- =============================================

ALTER TABLE buildings
  ADD COLUMN IF NOT EXISTS contract_template_id UUID
    REFERENCES document_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS invoice_template_id UUID
    REFERENCES document_templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_buildings_contract_template_id
  ON buildings(contract_template_id);
CREATE INDEX IF NOT EXISTS idx_buildings_invoice_template_id
  ON buildings(invoice_template_id);

COMMENT ON COLUMN buildings.contract_template_id IS
  'Default contract (HĐ thuê) template applied when creating a contract under this building.';
COMMENT ON COLUMN buildings.invoice_template_id IS
  'Default invoice template applied when issuing invoices under this building.';
