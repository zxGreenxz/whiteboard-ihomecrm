-- =============================================
-- Migration: Add new settings keys for General Settings page
-- Description: Define default settings for 4 tabs: Hợp đồng, Hóa đơn, Thu chi, Thông báo
-- Requirements: 30.1-30.5
-- =============================================

-- Since settings are per-user (UNIQUE(user_id, key)), we create a function
-- that seeds default settings for a given user. This is called when a user
-- first accesses the settings page or on user creation.

CREATE OR REPLACE FUNCTION seed_default_settings(p_user_id UUID)
RETURNS void AS $$
BEGIN
  -- === Tab: Hợp đồng (Contract) - 7 keys ===
  INSERT INTO settings (user_id, key, value) VALUES
    (p_user_id, 'contract_auto_set_service_users', 'false'::jsonb),
    (p_user_id, 'contract_asset_inspection', 'false'::jsonb),
    (p_user_id, 'contract_auto_create_on_renewal', 'false'::jsonb),
    (p_user_id, 'contract_e_signing_enabled', 'false'::jsonb),
    (p_user_id, 'contract_payment_date_setting', '"1"'::jsonb),
    (p_user_id, 'contract_show_expiring_status', 'true'::jsonb),
    (p_user_id, 'contract_overdue_notification', 'false'::jsonb)
  ON CONFLICT (user_id, key) DO NOTHING;

  -- === Tab: Hóa đơn (Invoice) - 10 keys ===
  INSERT INTO settings (user_id, key, value) VALUES
    (p_user_id, 'invoice_auto_approve_meter', 'false'::jsonb),
    (p_user_id, 'invoice_auto_approve', 'false'::jsonb),
    (p_user_id, 'invoice_use_coefficient', 'false'::jsonb),
    (p_user_id, 'invoice_auto_calc_coefficient', 'false'::jsonb),
    (p_user_id, 'invoice_service_cycle_type', '"monthly"'::jsonb),
    (p_user_id, 'invoice_prorate_method', '"actual_days"'::jsonb),
    (p_user_id, 'invoice_payment_deadline_days', '5'::jsonb),
    (p_user_id, 'invoice_auto_create_deposit', 'false'::jsonb),
    (p_user_id, 'invoice_auto_generate_next', 'false'::jsonb),
    (p_user_id, 'invoice_allow_tenant_meter', 'false'::jsonb)
  ON CONFLICT (user_id, key) DO NOTHING;

  -- === Tab: Thu chi (Payment) - 1 key ===
  INSERT INTO settings (user_id, key, value) VALUES
    (p_user_id, 'payment_auto_approve', 'false'::jsonb)
  ON CONFLICT (user_id, key) DO NOTHING;

  -- === Tab: Thông báo (Notification) - 2 keys ===
  INSERT INTO settings (user_id, key, value) VALUES
    (p_user_id, 'notification_invoice_reminder', 'false'::jsonb),
    (p_user_id, 'notification_payment_reminder', 'false'::jsonb)
  ON CONFLICT (user_id, key) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION seed_default_settings IS
'Seeds default settings for a user across all 4 settings tabs (Hợp đồng, Hóa đơn, Thu chi, Thông báo). Uses ON CONFLICT DO NOTHING to avoid duplicates.';

-- Seed defaults for all existing users
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT user_id FROM settings
  LOOP
    PERFORM seed_default_settings(r.user_id);
  END LOOP;
END $$;
