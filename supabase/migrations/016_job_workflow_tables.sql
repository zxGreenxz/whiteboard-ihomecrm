-- =============================================
-- Migration 016: Job Workflow Tables
-- Created: 2025-11-21
-- Description: Create tables for job types, workflows, phases, and departments
-- =============================================

-- =============================================
-- DEPARTMENT TABLES
-- =============================================

-- 1. DEPARTMENTS TABLE
-- =============================================

CREATE TABLE departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Department info
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,

  -- Manager
  manager_id UUID REFERENCES profiles(id),

  -- Contact
  phone TEXT,
  email TEXT,

  -- Status
  is_active BOOLEAN DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(user_id, code),
  CONSTRAINT departments_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT departments_code_not_empty CHECK (char_length(code) > 0)
);

CREATE INDEX idx_departments_user_id ON departments(user_id);
CREATE INDEX idx_departments_code ON departments(code);
CREATE INDEX idx_departments_manager_id ON departments(manager_id);
CREATE INDEX idx_departments_is_active ON departments(is_active);

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own departments"
  ON departments FOR ALL
  USING (auth.uid() = user_id);

COMMENT ON TABLE departments IS 'Departments for job assignment and organization';


-- =============================================
-- JOB GROUP & TYPE TABLES
-- =============================================

-- 2. JOB_GROUPS TABLE
-- =============================================

CREATE TABLE job_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Group info
  name TEXT NOT NULL,
  description TEXT,

  -- Display
  color TEXT, -- Hex color for UI display
  icon TEXT, -- Icon name or emoji

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT job_groups_name_not_empty CHECK (char_length(name) > 0)
);

CREATE INDEX idx_job_groups_user_id ON job_groups(user_id);

ALTER TABLE job_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own job groups"
  ON job_groups FOR ALL
  USING (auth.uid() = user_id);

COMMENT ON TABLE job_groups IS 'Job groups for categorizing job types';


-- 3. JOB_TYPES TABLE
-- =============================================

CREATE TABLE job_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Basic info
  name TEXT NOT NULL,
  job_group_id UUID REFERENCES job_groups(id),
  description TEXT,

  -- Priority & deadlines
  default_priority issue_priority DEFAULT 'MEDIUM',

  -- Deadlines in minutes (0 = not applicable)
  customer_contact_deadline INTEGER DEFAULT 0,
  acceptance_deadline INTEGER DEFAULT 0,
  completion_deadline INTEGER DEFAULT 0,

  -- Business hours only (9AM-6PM) or 24/7
  business_hours_only BOOLEAN DEFAULT false,

  -- Assignment
  default_department_id UUID REFERENCES departments(id),

  -- Auto-assignment rules
  auto_assign BOOLEAN DEFAULT false,

  -- Status
  is_active BOOLEAN DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT job_types_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT job_types_customer_contact_deadline_non_negative CHECK (customer_contact_deadline >= 0),
  CONSTRAINT job_types_acceptance_deadline_non_negative CHECK (acceptance_deadline >= 0),
  CONSTRAINT job_types_completion_deadline_non_negative CHECK (completion_deadline >= 0)
);

CREATE INDEX idx_job_types_user_id ON job_types(user_id);
CREATE INDEX idx_job_types_job_group_id ON job_types(job_group_id);
CREATE INDEX idx_job_types_default_department_id ON job_types(default_department_id);
CREATE INDEX idx_job_types_is_active ON job_types(is_active);

ALTER TABLE job_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own job types"
  ON job_types FOR ALL
  USING (auth.uid() = user_id);

COMMENT ON TABLE job_types IS 'Job types with deadlines and auto-assignment rules';
COMMENT ON COLUMN job_types.customer_contact_deadline IS 'Minutes to contact customer (0 = not applicable)';
COMMENT ON COLUMN job_types.acceptance_deadline IS 'Minutes for department to accept job (0 = not applicable)';
COMMENT ON COLUMN job_types.completion_deadline IS 'Minutes to complete job (0 = not applicable)';
COMMENT ON COLUMN job_types.business_hours_only IS 'Calculate deadlines based on business hours (9AM-6PM) only';


-- =============================================
-- WORKFLOW TABLES
-- =============================================

-- 4. TASK_FLOWS TABLE
-- =============================================

CREATE TABLE task_flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Flow info
  name TEXT NOT NULL,
  description TEXT,

  -- Link to job type (optional)
  job_type_id UUID REFERENCES job_types(id),

  -- Status
  is_active BOOLEAN DEFAULT true,
  is_default BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT task_flows_name_not_empty CHECK (char_length(name) > 0)
);

CREATE INDEX idx_task_flows_user_id ON task_flows(user_id);
CREATE INDEX idx_task_flows_job_type_id ON task_flows(job_type_id);
CREATE INDEX idx_task_flows_is_active ON task_flows(is_active);
CREATE INDEX idx_task_flows_is_default ON task_flows(is_default);

ALTER TABLE task_flows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own task flows"
  ON task_flows FOR ALL
  USING (auth.uid() = user_id);

COMMENT ON TABLE task_flows IS 'Workflow definitions for tasks/issues';
COMMENT ON COLUMN task_flows.is_default IS 'Default flow for new issues without specific flow';


-- 5. TASK_PHASES TABLE
-- =============================================

CREATE TABLE task_phases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES task_flows(id) ON DELETE CASCADE,

  -- Phase info
  name TEXT NOT NULL,
  description TEXT,

  -- Order in the flow
  sequence_order INTEGER NOT NULL,

  -- Phase type
  phase_type TEXT NOT NULL CHECK (phase_type IN (
    'START',      -- Giai đoạn bắt đầu
    'PROCESS',    -- Giai đoạn xử lý
    'REVIEW',     -- Giai đoạn đánh giá
    'COMPLETE',   -- Giai đoạn hoàn thành
    'CANCEL'      -- Giai đoạn hủy
  )),

  -- Auto-transition rules
  auto_transition BOOLEAN DEFAULT false,
  transition_conditions JSONB, -- Conditions for auto-transition

  -- Time limits (in minutes)
  time_limit INTEGER,

  -- Required actions
  require_comment BOOLEAN DEFAULT false,
  require_attachment BOOLEAN DEFAULT false,
  require_rating BOOLEAN DEFAULT false,

  -- Permissions
  allowed_departments UUID[], -- Array of department IDs that can handle this phase

  -- Notifications
  notify_on_enter BOOLEAN DEFAULT false,
  notify_template_id UUID, -- Reference to notification template

  -- Display
  color TEXT, -- Hex color for UI
  icon TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT task_phases_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT task_phases_sequence_order_positive CHECK (sequence_order > 0),
  CONSTRAINT task_phases_time_limit_positive CHECK (time_limit IS NULL OR time_limit > 0),
  UNIQUE(flow_id, sequence_order)
);

CREATE INDEX idx_task_phases_flow_id ON task_phases(flow_id);
CREATE INDEX idx_task_phases_sequence_order ON task_phases(sequence_order);
CREATE INDEX idx_task_phases_phase_type ON task_phases(phase_type);

ALTER TABLE task_phases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view phases of own flows"
  ON task_phases FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM task_flows
      WHERE task_flows.id = task_phases.flow_id
        AND task_flows.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can manage phases of own flows"
  ON task_phases FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM task_flows
      WHERE task_flows.id = task_phases.flow_id
        AND task_flows.user_id = auth.uid()
    )
  );

COMMENT ON TABLE task_phases IS 'Phases/stages within a workflow';
COMMENT ON COLUMN task_phases.sequence_order IS 'Order of phase in the flow (1, 2, 3, ...)';
COMMENT ON COLUMN task_phases.auto_transition IS 'Automatically move to next phase when conditions are met';
COMMENT ON COLUMN task_phases.time_limit IS 'Maximum time allowed in this phase (minutes)';


-- 6. PHASE_TRANSITIONS TABLE
-- =============================================

CREATE TABLE phase_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- From -> To
  from_phase_id UUID NOT NULL REFERENCES task_phases(id) ON DELETE CASCADE,
  to_phase_id UUID NOT NULL REFERENCES task_phases(id) ON DELETE CASCADE,

  -- Transition info
  name TEXT NOT NULL, -- e.g., "Approve", "Reject", "Forward"
  description TEXT,

  -- Conditions
  require_approval BOOLEAN DEFAULT false,
  approval_roles TEXT[], -- Array of roles that can approve

  -- Actions on transition
  actions JSONB, -- Actions to perform when transitioning

  -- Display
  button_label TEXT, -- Label for UI button
  button_color TEXT, -- Color for UI button

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT phase_transitions_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT phase_transitions_different_phases CHECK (from_phase_id != to_phase_id)
);

CREATE INDEX idx_phase_transitions_from_phase_id ON phase_transitions(from_phase_id);
CREATE INDEX idx_phase_transitions_to_phase_id ON phase_transitions(to_phase_id);

ALTER TABLE phase_transitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view transitions of own flows"
  ON phase_transitions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM task_phases tp
      JOIN task_flows tf ON tf.id = tp.flow_id
      WHERE tp.id = phase_transitions.from_phase_id
        AND tf.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can manage transitions of own flows"
  ON phase_transitions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM task_phases tp
      JOIN task_flows tf ON tf.id = tp.flow_id
      WHERE tp.id = phase_transitions.from_phase_id
        AND tf.user_id = auth.uid()
    )
  );

COMMENT ON TABLE phase_transitions IS 'Allowed transitions between workflow phases';


-- 7. ISSUE_PHASE_HISTORY TABLE
-- =============================================

CREATE TABLE issue_phase_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,

  -- Phase tracking
  from_phase_id UUID REFERENCES task_phases(id),
  to_phase_id UUID NOT NULL REFERENCES task_phases(id),

  -- Transition info
  transition_id UUID REFERENCES phase_transitions(id),

  -- User who made the transition
  user_id UUID NOT NULL REFERENCES auth.users(id),

  -- Timing
  entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exited_at TIMESTAMPTZ,
  duration_minutes INTEGER, -- Calculated when exited

  -- Additional data
  comment TEXT,
  attachments JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_issue_phase_history_issue_id ON issue_phase_history(issue_id);
CREATE INDEX idx_issue_phase_history_from_phase_id ON issue_phase_history(from_phase_id);
CREATE INDEX idx_issue_phase_history_to_phase_id ON issue_phase_history(to_phase_id);
CREATE INDEX idx_issue_phase_history_user_id ON issue_phase_history(user_id);
CREATE INDEX idx_issue_phase_history_entered_at ON issue_phase_history(entered_at);

ALTER TABLE issue_phase_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view phase history of own issues"
  ON issue_phase_history FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM issues
      WHERE issues.id = issue_phase_history.issue_id
        AND issues.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create phase history for own issues"
  ON issue_phase_history FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM issues
      WHERE issues.id = issue_phase_history.issue_id
        AND issues.user_id = auth.uid()
    )
    AND auth.uid() = user_id
  );

COMMENT ON TABLE issue_phase_history IS 'Track phase transitions for each issue';


-- =============================================
-- UPDATE EXISTING TABLES
-- =============================================

-- Add new columns to issues table
ALTER TABLE issues ADD COLUMN job_type_id UUID REFERENCES job_types(id);
ALTER TABLE issues ADD COLUMN flow_id UUID REFERENCES task_flows(id);
ALTER TABLE issues ADD COLUMN current_phase_id UUID REFERENCES task_phases(id);
ALTER TABLE issues ADD COLUMN department_id UUID REFERENCES departments(id);

CREATE INDEX idx_issues_job_type_id ON issues(job_type_id);
CREATE INDEX idx_issues_flow_id ON issues(flow_id);
CREATE INDEX idx_issues_current_phase_id ON issues(current_phase_id);
CREATE INDEX idx_issues_department_id ON issues(department_id);

COMMENT ON COLUMN issues.job_type_id IS 'Job type classification for this issue';
COMMENT ON COLUMN issues.flow_id IS 'Workflow applied to this issue';
COMMENT ON COLUMN issues.current_phase_id IS 'Current phase in the workflow';
COMMENT ON COLUMN issues.department_id IS 'Department assigned to handle this issue';


-- Add new columns to issue_categories table (make it compatible with job_groups)
ALTER TABLE issue_categories ADD COLUMN color TEXT;
ALTER TABLE issue_categories ADD COLUMN icon TEXT;
ALTER TABLE issue_categories ADD COLUMN is_active BOOLEAN DEFAULT true;

CREATE INDEX idx_issue_categories_is_active ON issue_categories(is_active);

COMMENT ON COLUMN issue_categories.color IS 'Hex color for UI display';
COMMENT ON COLUMN issue_categories.icon IS 'Icon name or emoji';


-- Migration completed
-- =============================================
-- Total: 7 new tables created + 2 tables updated for job workflow management
-- Tables: departments, job_groups, job_types, task_flows, task_phases,
--         phase_transitions, issue_phase_history
-- Next: Seed data for common workflows
