-- =============================================
-- Migration: leads gain referrer / CTV / finder fields
-- Mirrors Resident's lead list which surfaces:
--   * Người giới thiệu (referrer)
--   * CTV (cộng tác viên / collaborator)
--   * Người tìm khách (finder)
-- All fields are free-text labels (the role names that show up in the
-- "Khách hẹn" column) — they are not FKs to staff; Resident lets ops
-- staff type any name there.
-- =============================================

ALTER TABLE leads ADD COLUMN IF NOT EXISTS referrer_name TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ctv_name TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS finder_name TEXT;

COMMENT ON COLUMN leads.referrer_name IS 'Người giới thiệu (khách / đối tác)';
COMMENT ON COLUMN leads.ctv_name IS 'Cộng tác viên giới thiệu hợp đồng';
COMMENT ON COLUMN leads.finder_name IS 'Người tìm khách (sale / agent)';
