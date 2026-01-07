-- =============================================
-- Migration 029: Missing Features Implementation
-- Includes: Lead Scoring, Activity Log, SLA Tracking, Code Generation, etc.
-- =============================================

-- =============================================
-- 1. LEAD SCORING & ACTIVITY LOG
-- =============================================

-- Add lead_score column to leads table
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_score INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS budget_min DECIMAL(15,2);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS budget_max DECIMAL(15,2);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS move_in_date DATE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS num_occupants INTEGER DEFAULT 1;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS preferred_room_type VARCHAR(50);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_contact_date TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_follow_up_date DATE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS conversion_date TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS bed_id UUID REFERENCES beds(id);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- Create lead_activities table for activity log
CREATE TABLE IF NOT EXISTS lead_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  activity_type VARCHAR(50) NOT NULL, -- CALL, EMAIL, SMS, MEETING, NOTE, STATUS_CHANGE, VIEWED_ROOM, etc.
  description TEXT,
  old_value JSONB,
  new_value JSONB,
  performed_by UUID REFERENCES auth.users(id),
  scheduled_at TIMESTAMP,
  completed_at TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create index for lead activities
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_id ON lead_activities(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_activities_type ON lead_activities(activity_type);
CREATE INDEX IF NOT EXISTS idx_lead_activities_created_at ON lead_activities(created_at DESC);

-- RLS for lead_activities
ALTER TABLE lead_activities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own lead activities"
  ON lead_activities FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert their own lead activities"
  ON lead_activities FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own lead activities"
  ON lead_activities FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "Users can delete their own lead activities"
  ON lead_activities FOR DELETE
  USING (user_id = auth.uid());

-- Function to calculate lead score
CREATE OR REPLACE FUNCTION calculate_lead_score(lead_id UUID)
RETURNS INTEGER AS $$
DECLARE
  score INTEGER := 0;
  lead_record RECORD;
BEGIN
  SELECT * INTO lead_record FROM leads WHERE id = lead_id;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- Budget score (0-30 points)
  IF lead_record.budget_max IS NOT NULL THEN
    score := score + 30;
  ELSIF lead_record.budget_min IS NOT NULL THEN
    score := score + 15;
  END IF;

  -- Appointment date (0-25 points)
  IF lead_record.appointment_date IS NOT NULL THEN
    IF lead_record.appointment_date >= CURRENT_DATE THEN
      score := score + 25;
    ELSE
      score := score + 10;
    END IF;
  END IF;

  -- Source quality (0-20 points)
  CASE lead_record.source
    WHEN 'REFERRAL' THEN score := score + 20;
    WHEN 'WALK_IN' THEN score := score + 18;
    WHEN 'WEBSITE' THEN score := score + 15;
    WHEN 'FACEBOOK' THEN score := score + 12;
    WHEN 'ZALO' THEN score := score + 12;
    WHEN 'PHONE' THEN score := score + 10;
    ELSE score := score + 5;
  END CASE;

  -- Status progression (0-15 points)
  CASE lead_record.status
    WHEN 'VIEWED' THEN score := score + 15;
    WHEN 'CONTACTED' THEN score := score + 10;
    WHEN 'NEW' THEN score := score + 5;
    ELSE score := score + 0;
  END CASE;

  -- Email provided (0-5 points)
  IF lead_record.email IS NOT NULL THEN
    score := score + 5;
  END IF;

  -- Move-in date soon (0-5 points)
  IF lead_record.move_in_date IS NOT NULL AND lead_record.move_in_date <= CURRENT_DATE + INTERVAL '30 days' THEN
    score := score + 5;
  END IF;

  RETURN score;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-calculate lead score on insert/update
CREATE OR REPLACE FUNCTION update_lead_score()
RETURNS TRIGGER AS $$
BEGIN
  NEW.lead_score := calculate_lead_score(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_lead_score ON leads;
CREATE TRIGGER trigger_update_lead_score
  BEFORE INSERT OR UPDATE ON leads
  FOR EACH ROW
  EXECUTE FUNCTION update_lead_score();

-- =============================================
-- 2. SLA TRACKING FOR ISSUES
-- =============================================

-- Add SLA columns to issues table
ALTER TABLE issues ADD COLUMN IF NOT EXISTS sla_due_date TIMESTAMP;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS sla_response_time_minutes INTEGER;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS sla_resolution_time_minutes INTEGER;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMP;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN DEFAULT FALSE;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS sla_response_breached BOOLEAN DEFAULT FALSE;

-- Create SLA configuration table
CREATE TABLE IF NOT EXISTS sla_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  priority VARCHAR(20) NOT NULL, -- URGENT, HIGH, MEDIUM, LOW
  response_time_minutes INTEGER NOT NULL, -- Time to first response
  resolution_time_minutes INTEGER NOT NULL, -- Time to resolve
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, priority)
);

-- RLS for sla_configs
ALTER TABLE sla_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own SLA configs"
  ON sla_configs FOR ALL
  USING (user_id = auth.uid());

-- Insert default SLA configs
INSERT INTO sla_configs (user_id, priority, response_time_minutes, resolution_time_minutes)
SELECT
  user_id,
  priority,
  CASE priority
    WHEN 'URGENT' THEN 30
    WHEN 'HIGH' THEN 60
    WHEN 'MEDIUM' THEN 240
    WHEN 'LOW' THEN 480
  END as response_time_minutes,
  CASE priority
    WHEN 'URGENT' THEN 240
    WHEN 'HIGH' THEN 480
    WHEN 'MEDIUM' THEN 1440
    WHEN 'LOW' THEN 2880
  END as resolution_time_minutes
FROM (SELECT DISTINCT user_id FROM issues) users
CROSS JOIN (VALUES ('URGENT'), ('HIGH'), ('MEDIUM'), ('LOW')) as priorities(priority)
ON CONFLICT (user_id, priority) DO NOTHING;

-- Function to set SLA due date when issue is created
CREATE OR REPLACE FUNCTION set_issue_sla()
RETURNS TRIGGER AS $$
DECLARE
  sla_config RECORD;
BEGIN
  -- Get SLA config for this priority
  SELECT * INTO sla_config
  FROM sla_configs
  WHERE user_id = NEW.user_id
    AND priority = NEW.priority
    AND is_active = TRUE;

  IF FOUND THEN
    NEW.sla_response_time_minutes := sla_config.response_time_minutes;
    NEW.sla_resolution_time_minutes := sla_config.resolution_time_minutes;
    NEW.sla_due_date := NEW.created_at + (sla_config.resolution_time_minutes || ' minutes')::INTERVAL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_set_issue_sla ON issues;
CREATE TRIGGER trigger_set_issue_sla
  BEFORE INSERT ON issues
  FOR EACH ROW
  EXECUTE FUNCTION set_issue_sla();

-- Function to check SLA breaches
CREATE OR REPLACE FUNCTION check_sla_breach()
RETURNS TRIGGER AS $$
BEGIN
  -- Check response SLA breach
  IF NEW.first_response_at IS NOT NULL AND OLD.first_response_at IS NULL THEN
    IF NEW.first_response_at > NEW.created_at + (NEW.sla_response_time_minutes || ' minutes')::INTERVAL THEN
      NEW.sla_response_breached := TRUE;
    END IF;
  END IF;

  -- Check resolution SLA breach
  IF NEW.resolved_at IS NOT NULL AND OLD.resolved_at IS NULL THEN
    IF NEW.resolved_at > NEW.sla_due_date THEN
      NEW.sla_breached := TRUE;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_check_sla_breach ON issues;
CREATE TRIGGER trigger_check_sla_breach
  BEFORE UPDATE ON issues
  FOR EACH ROW
  EXECUTE FUNCTION check_sla_breach();

-- =============================================
-- 3. CODE GENERATION SYSTEM ENHANCEMENTS
-- =============================================

-- code_sequences table already exists, add more object types
INSERT INTO code_sequences (user_id, object_type, prefix, date_format, separator, sequence_length, reset_period)
SELECT DISTINCT
  user_id,
  object_type,
  prefix,
  'YYMM',
  '-',
  4,
  'MONTHLY'
FROM (
  SELECT user_id FROM profiles
  CROSS JOIN (VALUES
    ('CONTRACT', 'HD'),
    ('INVOICE', 'HD'),
    ('DEPOSIT', 'DC'),
    ('PAYMENT', 'PT'),
    ('ISSUE', 'IS'),
    ('ASSET', 'TS'),
    ('LEAD', 'KH'),
    ('TENANT', 'KT'),
    ('HANDOVER', 'BG')
  ) AS types(object_type, prefix)
) base
ON CONFLICT DO NOTHING;

-- Function to generate next code
CREATE OR REPLACE FUNCTION generate_next_code(p_user_id UUID, p_object_type VARCHAR)
RETURNS VARCHAR AS $$
DECLARE
  seq_record RECORD;
  next_seq INTEGER;
  current_period VARCHAR;
  new_code VARCHAR;
BEGIN
  -- Lock and get sequence record
  SELECT * INTO seq_record
  FROM code_sequences
  WHERE user_id = p_user_id AND object_type = p_object_type
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Create default sequence if not exists
    INSERT INTO code_sequences (user_id, object_type, prefix, date_format, separator, sequence_length, reset_period, current_sequence)
    VALUES (p_user_id, p_object_type, SUBSTRING(p_object_type FROM 1 FOR 2), 'YYMM', '-', 4, 'MONTHLY', 1)
    RETURNING * INTO seq_record;
  END IF;

  -- Get current period
  current_period := TO_CHAR(CURRENT_DATE, seq_record.date_format);

  -- Check if we need to reset sequence
  IF seq_record.reset_period = 'MONTHLY' AND
     (seq_record.last_reset_at IS NULL OR
      TO_CHAR(seq_record.last_reset_at, 'YYMM') != current_period) THEN
    next_seq := 1;
    UPDATE code_sequences
    SET current_sequence = 2, last_reset_at = CURRENT_TIMESTAMP
    WHERE id = seq_record.id;
  ELSIF seq_record.reset_period = 'YEARLY' AND
        (seq_record.last_reset_at IS NULL OR
         TO_CHAR(seq_record.last_reset_at, 'YY') != TO_CHAR(CURRENT_DATE, 'YY')) THEN
    next_seq := 1;
    UPDATE code_sequences
    SET current_sequence = 2, last_reset_at = CURRENT_TIMESTAMP
    WHERE id = seq_record.id;
  ELSE
    next_seq := COALESCE(seq_record.current_sequence, 1);
    UPDATE code_sequences
    SET current_sequence = next_seq + 1
    WHERE id = seq_record.id;
  END IF;

  -- Build code
  new_code := seq_record.prefix || seq_record.separator || current_period || seq_record.separator ||
              LPAD(next_seq::TEXT, seq_record.sequence_length, '0');

  RETURN new_code;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- 4. AUTO INVOICE GENERATION SUPPORT
-- =============================================

-- Create scheduled_jobs table for cron-like jobs
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  job_type VARCHAR(50) NOT NULL, -- AUTO_INVOICE, OVERDUE_CHECK, SLA_CHECK, etc.
  schedule VARCHAR(100) NOT NULL, -- cron expression or 'DAILY', 'MONTHLY', etc.
  last_run_at TIMESTAMP,
  next_run_at TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- RLS for scheduled_jobs
ALTER TABLE scheduled_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own scheduled jobs"
  ON scheduled_jobs FOR ALL
  USING (user_id = auth.uid());

-- Create invoice_generation_settings table
CREATE TABLE IF NOT EXISTS invoice_generation_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) UNIQUE,
  auto_generate_enabled BOOLEAN DEFAULT FALSE,
  generation_day INTEGER DEFAULT 1 CHECK (generation_day BETWEEN 1 AND 28),
  due_days INTEGER DEFAULT 5,
  include_previous_debt BOOLEAN DEFAULT TRUE,
  auto_approve BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- RLS for invoice_generation_settings
ALTER TABLE invoice_generation_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own invoice settings"
  ON invoice_generation_settings FOR ALL
  USING (user_id = auth.uid());

-- =============================================
-- 5. ISSUE STATUS HISTORY
-- =============================================

-- Create issue_status_history table
CREATE TABLE IF NOT EXISTS issue_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  old_status VARCHAR(50),
  new_status VARCHAR(50) NOT NULL,
  changed_by UUID REFERENCES auth.users(id),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for status history
CREATE INDEX IF NOT EXISTS idx_issue_status_history_issue_id ON issue_status_history(issue_id);

-- RLS for issue_status_history
ALTER TABLE issue_status_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own issue status history"
  ON issue_status_history FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert issue status history"
  ON issue_status_history FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Trigger to log issue status changes
CREATE OR REPLACE FUNCTION log_issue_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO issue_status_history (issue_id, user_id, old_status, new_status, changed_by)
    VALUES (NEW.id, NEW.user_id, OLD.status, NEW.status, auth.uid());

    -- Update resolved_at if status is COMPLETED
    IF NEW.status = 'COMPLETED' AND OLD.status != 'COMPLETED' THEN
      NEW.resolved_at := CURRENT_TIMESTAMP;
    END IF;

    -- Update first_response_at if moving from REPORTED to IN_PROGRESS
    IF NEW.status IN ('IN_PROGRESS', 'ASSIGNED') AND OLD.status = 'REPORTED' AND NEW.first_response_at IS NULL THEN
      NEW.first_response_at := CURRENT_TIMESTAMP;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_log_issue_status_change ON issues;
CREATE TRIGGER trigger_log_issue_status_change
  BEFORE UPDATE ON issues
  FOR EACH ROW
  EXECUTE FUNCTION log_issue_status_change();

-- =============================================
-- 6. ROLES & PERMISSIONS
-- =============================================

-- Create roles table
CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  permissions JSONB DEFAULT '[]',
  is_system BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, name)
);

-- Create user_roles junction table
CREATE TABLE IF NOT EXISTS user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, role_id)
);

-- RLS for roles
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view roles in their organization"
  ON roles FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can manage their own roles"
  ON roles FOR ALL
  USING (user_id = auth.uid());

CREATE POLICY "Users can view user_roles"
  ON user_roles FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can manage user_roles"
  ON user_roles FOR ALL
  USING (user_id = auth.uid());

-- Insert default roles
DO $$
DECLARE
  admin_user UUID;
BEGIN
  -- Get first user as admin (for demo)
  SELECT id INTO admin_user FROM auth.users LIMIT 1;

  IF admin_user IS NOT NULL THEN
    INSERT INTO roles (user_id, name, description, permissions, is_system)
    VALUES
      (admin_user, 'Admin', 'Full system access', '["*"]', TRUE),
      (admin_user, 'Manager', 'Manage buildings and contracts', '["buildings:*", "rooms:*", "contracts:*", "invoices:*", "reports:view"]', TRUE),
      (admin_user, 'Staff', 'Handle leads and issues', '["leads:*", "issues:*", "tenants:view"]', TRUE),
      (admin_user, 'Accountant', 'Manage finances', '["invoices:*", "payments:*", "cash_book:*", "reports:*"]', TRUE),
      (admin_user, 'Viewer', 'Read-only access', '["*:view"]', TRUE)
    ON CONFLICT (user_id, name) DO NOTHING;
  END IF;
END $$;

-- =============================================
-- 7. TERMINATION CALCULATION VIEWS
-- =============================================

-- Create view for termination calculation
CREATE OR REPLACE VIEW v_termination_calculation AS
SELECT
  ct.id as termination_id,
  ct.contract_id,
  c.rent_price,
  c.total_deposit,
  ct.actual_move_out_date,
  c.end_date as original_end_date,

  -- Days calculation
  CASE
    WHEN ct.actual_move_out_date < c.end_date THEN
      EXTRACT(DAY FROM (c.end_date::date - ct.actual_move_out_date::date))
    ELSE 0
  END as early_days,

  -- Prorated calculations
  ct.prorated_rent,
  ct.prorated_services,

  -- Fees
  ct.early_termination_fee,
  ct.damage_fee,
  ct.cleaning_fee,
  ct.notice_violation_fee,
  ct.other_fees,
  ct.outstanding_debt,

  -- Totals
  ct.total_deductions,
  ct.total_deposit as deposit_held,
  ct.refund_amount,

  -- Status
  ct.status,
  ct.termination_type
FROM contract_terminations ct
JOIN contracts c ON ct.contract_id = c.id;

-- =============================================
-- 8. REFRESH ALL COMPUTED SCORES
-- =============================================

-- Update existing lead scores
UPDATE leads SET lead_score = calculate_lead_score(id);

-- =============================================
-- 9. GRANT PERMISSIONS
-- =============================================

-- Grant access to new tables for authenticated users
GRANT ALL ON lead_activities TO authenticated;
GRANT ALL ON sla_configs TO authenticated;
GRANT ALL ON scheduled_jobs TO authenticated;
GRANT ALL ON invoice_generation_settings TO authenticated;
GRANT ALL ON issue_status_history TO authenticated;
GRANT ALL ON roles TO authenticated;
GRANT ALL ON user_roles TO authenticated;
