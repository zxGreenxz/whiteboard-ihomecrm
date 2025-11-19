-- =============================================
-- Migration 007: Advanced Tables
-- Created: 2025-11-18
-- Description: Create leads, notifications, settings, signatures, code generation tables
-- =============================================

-- =============================================
-- LEAD MANAGEMENT TABLES
-- =============================================

-- 1. LEADS TABLE
-- =============================================

CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Customer info
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  source lead_source,

  -- Interest
  building_id UUID REFERENCES buildings(id),
  room_id UUID REFERENCES rooms(id),
  appointment_date TIMESTAMPTZ,

  -- Assignment
  assigned_staff_id UUID REFERENCES profiles(id),

  -- Status workflow
  status lead_status DEFAULT 'B1_LEAD',

  -- Conversion
  deposit_id UUID REFERENCES deposits(id),
  contract_id UUID REFERENCES contracts(id),

  -- Notes
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT leads_customer_name_not_empty CHECK (char_length(customer_name) > 0),
  CONSTRAINT leads_phone_format CHECK (phone ~ '^[0-9]{10,11}$')
);

CREATE INDEX idx_leads_user_id ON leads(user_id);
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_source ON leads(source);
CREATE INDEX idx_leads_building_id ON leads(building_id);
CREATE INDEX idx_leads_assigned_staff_id ON leads(assigned_staff_id);
CREATE INDEX idx_leads_appointment_date ON leads(appointment_date);

CREATE INDEX idx_leads_search ON leads USING GIN (
  to_tsvector('simple', coalesce(customer_name, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(email, ''))
);

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own leads"
  ON leads FOR ALL
  USING (auth.uid() = user_id);

COMMENT ON TABLE leads IS 'Lead/prospect management for sales funnel';


-- =============================================
-- SETTINGS & CONFIGURATION TABLES
-- =============================================

-- 2. SETTINGS TABLE
-- =============================================

CREATE TABLE settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Setting key-value
  key TEXT NOT NULL,
  value JSONB NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(user_id, key)
);

CREATE INDEX idx_settings_user_id ON settings(user_id);
CREATE INDEX idx_settings_key ON settings(key);

ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own settings"
  ON settings FOR ALL
  USING (auth.uid() = user_id);

COMMENT ON TABLE settings IS 'System configuration settings (key-value JSONB storage)';
COMMENT ON COLUMN settings.value IS 'JSONB value for flexible configuration storage';


-- 3. SIGNATURE_TEMPLATES TABLE
-- =============================================

CREATE TABLE signature_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Basic info
  code TEXT NOT NULL,
  name TEXT NOT NULL,

  -- Signature data
  signature_type TEXT NOT NULL CHECK (signature_type IN ('UPLOAD', 'DRAW', 'TEXT')),
  signature_url TEXT,
  signature_data JSONB,
  text_content TEXT,
  font_style TEXT,

  -- Status
  is_active BOOLEAN DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(user_id, code),
  CONSTRAINT signature_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT signature_code_not_empty CHECK (char_length(code) > 0)
);

CREATE INDEX idx_signature_templates_user_id ON signature_templates(user_id);
CREATE INDEX idx_signature_templates_code ON signature_templates(code);
CREATE INDEX idx_signature_templates_is_active ON signature_templates(is_active);

ALTER TABLE signature_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own signature templates"
  ON signature_templates FOR ALL
  USING (auth.uid() = user_id);

COMMENT ON TABLE signature_templates IS 'Digital signature templates for contracts and documents';


-- 4. CODE_SEQUENCES TABLE
-- =============================================

CREATE TABLE code_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  object_type TEXT NOT NULL, -- building, room, contract, invoice...
  prefix TEXT NOT NULL,
  separator TEXT DEFAULT '-',
  date_format TEXT, -- YYYY, YYMM, YYMMDD, null
  sequence_length INTEGER DEFAULT 4,
  current_sequence INTEGER DEFAULT 0,
  reset_period TEXT DEFAULT 'YEARLY' CHECK (reset_period IN ('DAILY', 'MONTHLY', 'YEARLY', 'NEVER')),
  last_reset_at DATE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(user_id, object_type)
);

CREATE INDEX idx_code_sequences_user_id ON code_sequences(user_id);
CREATE INDEX idx_code_sequences_object_type ON code_sequences(object_type);

ALTER TABLE code_sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own code sequences"
  ON code_sequences FOR ALL
  USING (auth.uid() = user_id);

COMMENT ON TABLE code_sequences IS 'Auto-code generation configuration for various entities';


-- =============================================
-- NOTIFICATION SYSTEM TABLES
-- =============================================

-- 5. NOTIFICATION_TEMPLATES TABLE
-- =============================================

CREATE TABLE notification_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  type notification_type NOT NULL,
  name TEXT NOT NULL,

  -- Content for each channel
  email_subject TEXT,
  email_body TEXT,
  sms_content TEXT,
  zalo_template_id TEXT,
  push_title TEXT,
  push_body TEXT,

  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT notification_templates_name_not_empty CHECK (char_length(name) > 0)
);

CREATE INDEX idx_notification_templates_user_id ON notification_templates(user_id);
CREATE INDEX idx_notification_templates_type ON notification_templates(type);
CREATE INDEX idx_notification_templates_is_active ON notification_templates(is_active);

ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own notification templates"
  ON notification_templates FOR ALL
  USING (auth.uid() = user_id);

COMMENT ON TABLE notification_templates IS 'Templates for multi-channel notifications';


-- 6. NOTIFICATIONS TABLE
-- =============================================

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  type notification_type NOT NULL,
  channel notification_channel NOT NULL,

  -- Recipients
  recipient_tenant_ids UUID[],
  recipient_emails TEXT[],
  recipient_phones TEXT[],

  -- Content
  subject TEXT,
  content TEXT NOT NULL,

  -- Related entities
  invoice_id UUID REFERENCES invoices(id),
  contract_id UUID REFERENCES contracts(id),
  issue_id UUID REFERENCES issues(id),

  -- Scheduling
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,

  -- Status
  status notification_status DEFAULT 'PENDING',
  error_message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT notifications_content_not_empty CHECK (char_length(content) > 0)
);

CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_type ON notifications(type);
CREATE INDEX idx_notifications_channel ON notifications(channel);
CREATE INDEX idx_notifications_status ON notifications(status);
CREATE INDEX idx_notifications_scheduled_at ON notifications(scheduled_at);
CREATE INDEX idx_notifications_sent_at ON notifications(sent_at);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own notifications"
  ON notifications FOR ALL
  USING (auth.uid() = user_id);

COMMENT ON TABLE notifications IS 'Notification queue for multi-channel delivery';


-- 7. NOTIFICATION_LOGS TABLE
-- =============================================

CREATE TABLE notification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,

  recipient_id UUID,
  recipient_email TEXT,
  recipient_phone TEXT,

  channel notification_channel NOT NULL,
  status notification_status NOT NULL,

  sent_at TIMESTAMPTZ,
  error_message TEXT,

  -- Provider response
  provider_response JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notification_logs_notification_id ON notification_logs(notification_id);
CREATE INDEX idx_notification_logs_channel ON notification_logs(channel);
CREATE INDEX idx_notification_logs_status ON notification_logs(status);
CREATE INDEX idx_notification_logs_recipient_id ON notification_logs(recipient_id);

ALTER TABLE notification_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view logs of own notifications"
  ON notification_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM notifications
      WHERE notifications.id = notification_logs.notification_id
        AND notifications.user_id = auth.uid()
    )
  );

COMMENT ON TABLE notification_logs IS 'Delivery status tracking for each notification recipient';


-- Migration completed
-- =============================================
-- Total: 7 tables created for advanced features
-- Next: 008_triggers_functions.sql
