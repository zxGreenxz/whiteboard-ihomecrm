-- =============================================================================
-- Sprint 4a — Approval engine schema (ADDITIVE / INERT). (AUTHORIZATION-PLAN §12)
--
-- State model tách khỏi income_expenses.approval_status (giữ APPROVED=POSTED cho
-- ledger). Request tables giữ workflow DRAFT→PENDING_APPROVAL→POSTED/DENIED/
-- REJECTED/CANCELLED/REVERSED. Chưa wired vào app (Sprint 5). Rollback = DROP.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.approval_rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  transaction_domain text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  published_by uuid, published_at timestamptz DEFAULT now(),
  UNIQUE (organization_id, transaction_domain, version),
  UNIQUE (organization_id, id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE IF NOT EXISTS public.approval_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  rule_set_id uuid NOT NULL,
  name text NOT NULL,
  priority integer NOT NULL,
  effect text NOT NULL CHECK (effect IN ('AUTO_POST','REQUIRE_APPROVAL','DENY')),
  transaction_type text,
  category_id uuid, cashbook_id uuid, building_id uuid, area_id uuid,
  system_source text,
  amount_min numeric(18,2), amount_max numeric(18,2),
  is_fallback boolean NOT NULL DEFAULT false,
  force_match boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (organization_id, id),
  UNIQUE (rule_set_id, priority),
  FOREIGN KEY (organization_id, rule_set_id) REFERENCES public.approval_rule_sets(organization_id, id) ON DELETE CASCADE,
  CHECK (amount_min IS NULL OR amount_min >= 0),
  CHECK (amount_max IS NULL OR amount_max >= 0),
  CHECK (amount_max IS NULL OR amount_min IS NULL OR amount_max >= amount_min),
  CHECK (is_fallback OR transaction_type IS NOT NULL OR force_match OR system_source IS NOT NULL OR category_id IS NOT NULL),
  CHECK (NOT is_fallback OR (effect='REQUIRE_APPROVAL' AND transaction_type IS NULL AND category_id IS NULL
         AND cashbook_id IS NULL AND building_id IS NULL AND area_id IS NULL AND system_source IS NULL
         AND amount_min IS NULL AND amount_max IS NULL AND NOT force_match))
);

CREATE TABLE IF NOT EXISTS public.approval_rule_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  step_no integer NOT NULL,
  min_approvals integer NOT NULL DEFAULT 1,
  mode text NOT NULL DEFAULT 'ANY' CHECK (mode IN ('ANY','ALL','QUORUM')),
  UNIQUE (organization_id, id),
  UNIQUE (rule_id, step_no),
  FOREIGN KEY (organization_id, rule_id) REFERENCES public.approval_rules(organization_id, id) ON DELETE CASCADE,
  CHECK (step_no > 0 AND min_approvals > 0)
);

CREATE TABLE IF NOT EXISTS public.approval_step_approvers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  step_id uuid NOT NULL,
  approver_type text NOT NULL CHECK (approver_type IN ('MEMBER','ROLE','PERMISSION','CASHBOOK_APPROVER','AREA_APPROVER','BUILDING_APPROVER')),
  membership_id uuid, role_id uuid, permission_key text, scope_id uuid,
  FOREIGN KEY (organization_id, step_id) REFERENCES public.approval_rule_steps(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  submission_no integer NOT NULL DEFAULT 1,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING_APPROVAL','POSTED','DENIED','REJECTED','CANCELLED')),
  maker_membership_id uuid NOT NULL,
  maker_user_id uuid NOT NULL,
  rule_set_id uuid NOT NULL,
  rule_set_version integer NOT NULL,
  matched_rule_id uuid NOT NULL,
  rule_effect text NOT NULL CHECK (rule_effect IN ('AUTO_POST','REQUIRE_APPROVAL','DENY')),
  payload_snapshot jsonb NOT NULL,
  payload_hash text NOT NULL,
  amount numeric(18,2) NOT NULL,
  category_id uuid, cashbook_id uuid, building_id uuid, system_source text,
  submitted_at timestamptz DEFAULT now(),
  posted_at timestamptz,
  posted_event_id uuid UNIQUE,
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, subject_type, subject_id, submission_no),
  FOREIGN KEY (organization_id, maker_membership_id, maker_user_id)
    REFERENCES public.organization_memberships(organization_id, id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_one_open_subject
  ON public.approval_requests (organization_id, subject_type, subject_id)
  WHERE state = 'PENDING_APPROVAL';

CREATE TABLE IF NOT EXISTS public.approval_request_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  request_id uuid NOT NULL,
  step_no integer NOT NULL,
  status text NOT NULL CHECK (status IN ('WAITING','PENDING','APPROVED','REJECTED','CANCELLED','BYPASSED')),
  mode text NOT NULL CHECK (mode IN ('ANY','ALL','QUORUM')),
  min_approvals integer NOT NULL,
  current_generation integer NOT NULL DEFAULT 1,
  rule_step_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidate_count integer NOT NULL DEFAULT 0,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, request_id, id),
  UNIQUE (request_id, step_no),
  FOREIGN KEY (organization_id, request_id) REFERENCES public.approval_requests(organization_id, id) ON DELETE CASCADE,
  CHECK (step_no > 0 AND min_approvals > 0 AND current_generation > 0)
);

CREATE TABLE IF NOT EXISTS public.approval_request_step_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  request_step_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  source_kind text NOT NULL,
  source_id uuid,
  eligible_at_submit boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, request_step_id, membership_id, generation),
  FOREIGN KEY (organization_id, request_step_id) REFERENCES public.approval_request_steps(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, membership_id) REFERENCES public.organization_memberships(organization_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE TABLE IF NOT EXISTS public.approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_step_id uuid NOT NULL,
  candidate_id uuid, candidate_generation integer,
  actor_membership_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVE','REJECT','EMERGENCY_APPROVE')),
  reason text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  request_version bigint NOT NULL,
  FOREIGN KEY (organization_id, request_id) REFERENCES public.approval_requests(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, request_id, request_step_id)
    REFERENCES public.approval_request_steps(organization_id, request_id, id),
  CHECK ((decision IN ('APPROVE','REJECT') AND candidate_id IS NOT NULL)
         OR (decision='EMERGENCY_APPROVE' AND candidate_id IS NULL)),
  CHECK (decision <> 'EMERGENCY_APPROVE' OR (reason IS NOT NULL AND length(btrim(reason)) >= 20))
);
CREATE UNIQUE INDEX IF NOT EXISTS approval_decisions_one_normal_per_generation
  ON public.approval_decisions (organization_id, request_step_id, actor_user_id, candidate_generation)
  WHERE decision IN ('APPROVE','REJECT');

CREATE TABLE IF NOT EXISTS public.authorization_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid, actor_membership_id uuid,
  event_type text NOT NULL,
  resource_type text, resource_id uuid,
  trace_id uuid,
  old_state jsonb, new_state jsonb, reason text,
  prev_hash text, event_hash text NOT NULL
);

-- Posting metadata trên income_expenses (additive, nullable).
ALTER TABLE public.income_expenses
  ADD COLUMN IF NOT EXISTS approval_request_id uuid,
  ADD COLUMN IF NOT EXISTS posting_id uuid,
  ADD COLUMN IF NOT EXISTS posted_at_v2 timestamptz,
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS reversed_by_posting_id uuid,
  ADD COLUMN IF NOT EXISTS source_payload_hash text;

-- RLS bảng approval: super_admin đọc + member đọc trong org của mình. Không client DML.
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['approval_rule_sets','approval_rules','approval_rule_steps',
    'approval_step_approvers','approval_requests','approval_request_steps',
    'approval_request_step_candidates','approval_decisions','authorization_audit_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select_member ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_select_member ON public.%I FOR SELECT TO authenticated USING (public.is_super_admin() OR organization_id IN (SELECT unnest(public.my_org_ids())))', t, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $rls$;

COMMIT;
