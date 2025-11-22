
-- Add template columns to contracts table
ALTER TABLE contracts 
ADD COLUMN contract_template_id UUID REFERENCES document_templates(id) ON DELETE SET NULL,
ADD COLUMN invoice_template_id UUID REFERENCES document_templates(id) ON DELETE SET NULL;

CREATE INDEX idx_contracts_contract_template_id ON contracts(contract_template_id);
CREATE INDEX idx_contracts_invoice_template_id ON contracts(invoice_template_id);
