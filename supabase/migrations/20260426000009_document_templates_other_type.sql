-- =============================================
-- Add 'other' to document_templates.type so the "Biểu mẫu khác" tab
-- (last item in Resident's "Mẫu biểu" sidebar) can store rows.
-- =============================================

ALTER TABLE document_templates DROP CONSTRAINT IF EXISTS document_templates_type_check;
ALTER TABLE document_templates
  ADD CONSTRAINT document_templates_type_check
  CHECK (type IN (
    'signature',
    'deposit_contract',
    'lease_contract',
    'handover_report',
    'invoice',
    'receipt',
    'other'
  ));
