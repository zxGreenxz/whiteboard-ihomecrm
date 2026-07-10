-- =============================================================
-- BUNDLE: All pending migrations for ptcrm.vercel.app (Supabase Studio)
-- Apply once via SQL Editor → Run.
-- The bundle is fully idempotent — safe to re-run.
--
-- Order matters (later sections reference earlier ones):
--   01. jobs table  (20251121000001)
--   02. cashbooks extend accounts  (20260425000001)
--   03. cashbooks balance includes unapproved  (20260426000001)
--   04. thu chi remove approval, add CANCELLED + storage bucket  (20260426000002)
--   05. income_expenses.creator_name  (20260426000003)
--   06. invoices.creator_name  (20260426000004)
--   07. leads referrer/ctv/finder  (20260426000005)
--   08. deposits code + ctv  (20260426000006)
--   09. income_expenses.invoice_id  (20260426000007)
--   10. recurring vouchers  (20260426000008)
--   11. document_templates 'other' type  (20260426000009)
-- =============================================================

BEGIN;

-- ============================================================
-- 01. JOBS TABLE  (20251121000001)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  building_id UUID REFERENCES public.buildings(id) ON DELETE SET NULL,
  room_id UUID REFERENCES public.rooms(id) ON DELETE SET NULL,
  bed_id UUID REFERENCES public.beds(id) ON DELETE SET NULL,
  job_group_id UUID REFERENCES public.job_groups(id) ON DELETE SET NULL,
  job_type_id UUID REFERENCES public.job_types(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL','LOW','URGENT')),
  assignee_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  deadline TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (status IN ('NOT_STARTED','IN_PROGRESS','PENDING_ACCEPTANCE','ACCEPTED','FAILED','OVERDUE')),
  visible_to_customer BOOLEAN DEFAULT false,
  attachments JSONB,
  completion_time TIMESTAMPTZ,
  completion_description TEXT,
  completion_attachments JSONB,
  acceptance_result TEXT,
  customer_evaluation TEXT,
  customer_comments TEXT,
  accepted_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own jobs"   ON public.jobs;
DROP POLICY IF EXISTS "Users can create own jobs" ON public.jobs;
DROP POLICY IF EXISTS "Users can update own jobs" ON public.jobs;
DROP POLICY IF EXISTS "Users can delete own jobs" ON public.jobs;
CREATE POLICY "Users can view own jobs"   ON public.jobs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own jobs" ON public.jobs FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own jobs" ON public.jobs FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own jobs" ON public.jobs FOR DELETE USING (auth.uid() = user_id);

-- Auto-generate job code  JOB-YYYYMMDD-NNNN
CREATE OR REPLACE FUNCTION public.generate_job_code()
RETURNS TRIGGER AS $$
BEGIN
  NEW.code := 'JOB-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(
    (SELECT COALESCE(MAX(CAST(SUBSTRING(code FROM 'JOB-\d{8}-(\d+)') AS INTEGER)), 0) + 1
     FROM public.jobs
     WHERE code LIKE 'JOB-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-%')::TEXT,
    4, '0'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_generate_job_code ON public.jobs;
CREATE TRIGGER trigger_generate_job_code
  BEFORE INSERT ON public.jobs
  FOR EACH ROW
  WHEN (NEW.code IS NULL OR NEW.code = '')
  EXECUTE FUNCTION public.generate_job_code();

-- updated_at — reuse existing public.update_updated_at_column() if present;
-- otherwise create a fallback so this bundle is self-contained.
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_jobs_updated_at ON public.jobs;
CREATE TRIGGER trigger_jobs_updated_at
  BEFORE UPDATE ON public.jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_jobs_user_id      ON public.jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status       ON public.jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_building_id  ON public.jobs(building_id);
CREATE INDEX IF NOT EXISTS idx_jobs_assignee_id  ON public.jobs(assignee_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at   ON public.jobs(created_at DESC);

INSERT INTO storage.buckets (id, name, public)
VALUES ('job-attachments', 'job-attachments', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "Users can upload job attachments"     ON storage.objects;
DROP POLICY IF EXISTS "Anyone can view job attachments"      ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own job attachments" ON storage.objects;
CREATE POLICY "Users can upload job attachments"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'job-attachments' AND auth.role() = 'authenticated');
CREATE POLICY "Anyone can view job attachments"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'job-attachments');
CREATE POLICY "Users can delete own job attachments"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'job-attachments' AND auth.role() = 'authenticated');


-- ============================================================
-- 02. CASHBOOKS — extend accounts  (20260425000001)
-- ============================================================
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_type_check CHECK (type IN ('cash','bank','ewallet'));

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS bank_account_holder TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS initial_amount NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS initial_date DATE NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS lock_date DATE;

CREATE SEQUENCE IF NOT EXISTS accounts_code_seq START 1;
CREATE OR REPLACE FUNCTION accounts_set_code()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.code IS NULL OR NEW.code = '' THEN
    NEW.code := 'TK' || LPAD(nextval('accounts_code_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_accounts_set_code ON accounts;
CREATE TRIGGER trg_accounts_set_code
BEFORE INSERT ON accounts
FOR EACH ROW EXECUTE FUNCTION accounts_set_code();

UPDATE accounts
SET code = 'TK' || LPAD(nextval('accounts_code_seq')::text, 6, '0')
WHERE code IS NULL OR code = '';

ALTER TABLE accounts ALTER COLUMN code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_code_unique ON accounts(code) WHERE deleted_at IS NULL;

-- Lock-date guard
CREATE OR REPLACE FUNCTION income_expenses_check_lock()
RETURNS TRIGGER AS $$
DECLARE
  v_lock DATE;
  v_account_id UUID;
  v_voucher_date DATE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_account_id := OLD.account_id;
    v_voucher_date := OLD.voucher_date;
  ELSE
    v_account_id := NEW.account_id;
    v_voucher_date := NEW.voucher_date;
  END IF;

  IF v_account_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT lock_date INTO v_lock FROM accounts WHERE id = v_account_id;

  IF v_lock IS NOT NULL AND v_voucher_date <= v_lock THEN
    RAISE EXCEPTION 'Tài khoản đã khoá sổ đến ngày %, không thể thao tác phiếu có ngày phát sinh ≤ ngày khoá', v_lock
      USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ie_check_lock_ins ON income_expenses;
DROP TRIGGER IF EXISTS trg_ie_check_lock_upd ON income_expenses;
DROP TRIGGER IF EXISTS trg_ie_check_lock_del ON income_expenses;
CREATE TRIGGER trg_ie_check_lock_ins
BEFORE INSERT ON income_expenses
FOR EACH ROW EXECUTE FUNCTION income_expenses_check_lock();
CREATE TRIGGER trg_ie_check_lock_upd
BEFORE UPDATE ON income_expenses
FOR EACH ROW
WHEN (OLD.deleted_at IS NULL)
EXECUTE FUNCTION income_expenses_check_lock();
CREATE TRIGGER trg_ie_check_lock_del
BEFORE DELETE ON income_expenses
FOR EACH ROW EXECUTE FUNCTION income_expenses_check_lock();


-- ============================================================
-- 03 + 04. THU CHI workflow: remove APPROVED gate, add CANCELLED,
-- attachments bucket, plus the final view that ALSO sums unapproved
-- before being narrowed to APPROVED only — final shape is APPROVED only.
-- (20260426000001 + 20260426000002)
-- ============================================================

-- Loosen check
ALTER TABLE income_expenses DROP CONSTRAINT IF EXISTS income_expenses_approval_status_check;
ALTER TABLE income_expenses
  ADD CONSTRAINT income_expenses_approval_status_check
  CHECK (approval_status IN ('UNAPPROVED','APPROVED','CANCELLED'));

ALTER TABLE income_expenses ALTER COLUMN approval_status SET DEFAULT 'APPROVED';

UPDATE income_expenses
SET approval_status = 'APPROVED'
WHERE approval_status = 'UNAPPROVED';

-- Final view: count only APPROVED toward Tồn quỹ
DROP VIEW IF EXISTS accounts_with_balance;
CREATE VIEW accounts_with_balance AS
SELECT
  a.*,
  COALESCE(a.initial_amount, 0)
  + COALESCE((
      SELECT SUM(ie.total_amount)
      FROM income_expenses ie
      WHERE ie.account_id = a.id
        AND ie.type = 'INCOME'
        AND ie.approval_status = 'APPROVED'
        AND ie.deleted_at IS NULL
    ), 0)
  - COALESCE((
      SELECT SUM(ie.total_amount)
      FROM income_expenses ie
      WHERE ie.account_id = a.id
        AND ie.type = 'EXPENSE'
        AND ie.approval_status = 'APPROVED'
        AND ie.deleted_at IS NULL
    ), 0)
  AS current_amount
FROM accounts a
WHERE a.deleted_at IS NULL;

GRANT SELECT ON accounts_with_balance TO authenticated;

-- Attachments bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('income-expense-attachments', 'income-expense-attachments', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "ie_attachments_select" ON storage.objects;
DROP POLICY IF EXISTS "ie_attachments_insert" ON storage.objects;
DROP POLICY IF EXISTS "ie_attachments_update" ON storage.objects;
DROP POLICY IF EXISTS "ie_attachments_delete" ON storage.objects;

CREATE POLICY "ie_attachments_select" ON storage.objects
  FOR SELECT USING (bucket_id = 'income-expense-attachments');
CREATE POLICY "ie_attachments_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'income-expense-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
CREATE POLICY "ie_attachments_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'income-expense-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
CREATE POLICY "ie_attachments_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'income-expense-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );


-- ============================================================
-- 05. income_expenses.creator_name  (20260426000003)
-- ============================================================
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS creator_name TEXT;
COMMENT ON COLUMN income_expenses.creator_name IS
  'Display name of voucher creator (auth user_metadata.full_name or email).';


-- ============================================================
-- 06. invoices.creator_name  (20260426000004)
-- ============================================================
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS creator_name TEXT;
COMMENT ON COLUMN invoices.creator_name IS
  'Display name of invoice creator captured at insert time.';


-- ============================================================
-- 07. leads referrer / ctv / finder  (20260426000005)
-- ============================================================
ALTER TABLE leads ADD COLUMN IF NOT EXISTS referrer_name TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ctv_name TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS finder_name TEXT;
COMMENT ON COLUMN leads.referrer_name IS 'Người giới thiệu';
COMMENT ON COLUMN leads.ctv_name      IS 'Cộng tác viên';
COMMENT ON COLUMN leads.finder_name   IS 'Người tìm khách (sale)';


-- ============================================================
-- 08. deposits code + ctv  (20260426000006)
-- ============================================================
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS ctv_name TEXT;

CREATE SEQUENCE IF NOT EXISTS deposits_code_seq START 1;
CREATE OR REPLACE FUNCTION deposits_set_code()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.code IS NULL OR NEW.code = '' THEN
    NEW.code := 'DC' || LPAD(nextval('deposits_code_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_deposits_set_code ON deposits;
CREATE TRIGGER trg_deposits_set_code
BEFORE INSERT ON deposits
FOR EACH ROW EXECUTE FUNCTION deposits_set_code();

UPDATE deposits
SET code = 'DC' || LPAD(nextval('deposits_code_seq')::text, 6, '0')
WHERE code IS NULL OR code = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_code ON deposits(code);

COMMENT ON COLUMN deposits.code IS 'Auto DCxxxxxx (mirrors Resident reservation code)';
COMMENT ON COLUMN deposits.ctv_name IS 'Cộng tác viên';


-- ============================================================
-- 09. income_expenses.invoice_id  (20260426000007)
-- ============================================================
ALTER TABLE income_expenses
  ADD COLUMN IF NOT EXISTS invoice_id UUID
  REFERENCES invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_income_expenses_invoice_id
  ON income_expenses(invoice_id) WHERE invoice_id IS NOT NULL;

COMMENT ON COLUMN income_expenses.invoice_id IS
  'Linked invoice when this voucher was auto-generated from RecordPaymentDialog.';


-- ============================================================
-- 10. RECURRING VOUCHERS  (20260426000008)
-- ============================================================
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS repeat_cycle TEXT
  DEFAULT 'NONE';
-- separate ALTER for CHECK because IF NOT EXISTS doesn't apply to CHECK
ALTER TABLE income_expenses DROP CONSTRAINT IF EXISTS income_expenses_repeat_cycle_check;
ALTER TABLE income_expenses
  ADD CONSTRAINT income_expenses_repeat_cycle_check
  CHECK (repeat_cycle IN ('NONE','WEEK','MONTH','QUARTER','YEAR'));

ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS repeat_infinity BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS repeat_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS repeat_remaining INTEGER NOT NULL DEFAULT 0;
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS repeat_next_date DATE;
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS repeat_parent_id UUID
  REFERENCES income_expenses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ie_repeat_next_date
  ON income_expenses(repeat_next_date)
  WHERE repeat_cycle <> 'NONE' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ie_repeat_parent_id
  ON income_expenses(repeat_parent_id) WHERE repeat_parent_id IS NOT NULL;

CREATE OR REPLACE FUNCTION generate_recurring_vouchers(p_user_id UUID DEFAULT NULL)
RETURNS TABLE(parent_id UUID, child_id UUID, voucher_date DATE) AS $$
DECLARE
  parent RECORD;
  child_voucher_id UUID;
  next_date DATE;
  iteration INTEGER;
  step_interval INTERVAL;
BEGIN
  FOR parent IN
    SELECT *
    FROM income_expenses ie
    WHERE ie.repeat_cycle <> 'NONE'
      AND ie.deleted_at IS NULL
      AND ie.repeat_next_date IS NOT NULL
      AND ie.repeat_next_date <= CURRENT_DATE
      AND (p_user_id IS NULL OR ie.user_id = p_user_id)
      AND (ie.repeat_infinity OR ie.repeat_remaining > 0)
  LOOP
    next_date := parent.repeat_next_date;
    iteration := 0;

    step_interval := CASE parent.repeat_cycle
      WHEN 'WEEK'    THEN INTERVAL '7 days'
      WHEN 'MONTH'   THEN INTERVAL '1 month'
      WHEN 'QUARTER' THEN INTERVAL '3 months'
      WHEN 'YEAR'    THEN INTERVAL '1 year'
      ELSE INTERVAL '0 days'
    END;

    WHILE next_date <= CURRENT_DATE
          AND (parent.repeat_infinity OR parent.repeat_remaining - iteration > 0)
          AND iteration < 24
    LOOP
      INSERT INTO income_expenses (
        user_id, type, name, building_id, room_id, bed_id, tenant_id,
        contract_id, account_id, payer_name,
        approval_status, business_result_accounting,
        attachments, notes,
        receive_bank_name, receive_bank_account,
        creator_name,
        voucher_date,
        invoice_id,
        repeat_parent_id,
        repeat_cycle, repeat_infinity, repeat_count, repeat_remaining
      ) VALUES (
        parent.user_id, parent.type,
        parent.name || ' (tự động lập)',
        parent.building_id, parent.room_id, parent.bed_id, parent.tenant_id,
        parent.contract_id, parent.account_id, parent.payer_name,
        'APPROVED', parent.business_result_accounting,
        parent.attachments, parent.notes,
        parent.receive_bank_name, parent.receive_bank_account,
        parent.creator_name,
        next_date,
        NULL,
        parent.id,
        'NONE', false, 0, 0
      ) RETURNING id INTO child_voucher_id;

      INSERT INTO income_expense_items (
        income_expense_id, income_expense_type_id,
        description, quantity, unit_price,
        start_date, end_date
      )
      SELECT
        child_voucher_id, ii.income_expense_type_id,
        ii.description, ii.quantity, ii.unit_price,
        next_date, next_date
      FROM income_expense_items ii
      WHERE ii.income_expense_id = parent.id;

      RETURN QUERY SELECT parent.id, child_voucher_id, next_date;

      iteration := iteration + 1;
      next_date := (next_date + step_interval)::DATE;
    END LOOP;

    UPDATE income_expenses
    SET repeat_next_date = next_date,
        repeat_remaining = CASE
          WHEN parent.repeat_infinity THEN parent.repeat_remaining
          ELSE GREATEST(0, parent.repeat_remaining - iteration)
        END
    WHERE id = parent.id;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION generate_recurring_vouchers(UUID) TO authenticated;


-- ============================================================
-- 11. document_templates  type 'other'  (20260426000009)
-- ============================================================
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


-- ============================================================
-- POSTGREST schema cache reload
-- (so the new tables/columns/relationships become visible to the
-- Supabase REST API in the same session)
-- ============================================================
NOTIFY pgrst, 'reload schema';

COMMIT;
