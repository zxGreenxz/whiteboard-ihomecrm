-- Finance V2 — Stage 7d: READ CUTOVER + AUTO-POSTING BRIDGE (plan §9.6 read-safety, §11.2).
--
-- Sau khi 4 key ON: (1) cầu auto-posting cho các definer-writer legacy còn sinh
-- APPROVED trực tiếp (handover, opening-adjust, record_invoice_payment_v3, utility,
-- salary_payout_v1, contract deposit...) — mỗi voucher APPROVED + sổ thực tự sinh
-- đúng MỘT posting event (append-only, generation guard); rời APPROVED/soft-delete
-- sinh REVERSAL. (2) Chuyển read model legacy sang posting-truth: accounts_with_balance
-- + 3 aggregate RPC delegate sang bản _v2 (posted_on/posting lines, không lọc
-- approval_status). Parity tại thời điểm swap là EXACT (đã chứng minh) nên hiển thị
-- không đổi; từ giờ "Chỉ duyệt" KHÔNG làm tồn quỹ nhảy — đúng ngữ nghĩa V2.

BEGIN;

-- ---------------------------------------------------------------------------
-- (1) Auto-posting bridge trigger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.finance_v2_auto_posting_bridge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_acc public.accounts%ROWTYPE;
  v_active public.income_expense_postings%ROWTYPE;
  v_should boolean := false;
  v_poster uuid;
  v_membership uuid;
  v_gen bigint;
  v_new uuid;
  v_main numeric(18,2);
BEGIN
  -- Chỉ chạy khi posting route CANONICAL (trước đó legacy semantics giữ nguyên).
  IF app_private.evaluate_feature_route('income_expense.posting.v2', NEW.organization_id) <> 'CANONICAL' THEN
    RETURN NEW;
  END IF;

  -- V2 writer đã tự quản posting trong cùng lệnh (pointer đã set) → bridge không đụng.
  SELECT p.* INTO v_active FROM public.income_expense_postings p WHERE p.id = NEW.active_posting_id_v2;

  -- Voucher này CÓ NÊN có cash posting không (đúng công thức backfill/replay)?
  IF NEW.deleted_at IS NULL AND NEW.approval_status = 'APPROVED' AND NEW.account_id IS NOT NULL
     AND COALESCE(NEW.total_amount, 0) > 0 THEN
    SELECT * INTO v_acc FROM public.accounts WHERE id = NEW.account_id;
    IF FOUND AND COALESCE(v_acc.is_virtual, false) = false AND v_acc.deleted_at IS NULL THEN
      v_should := true;
    END IF;
  END IF;

  -- (a) Active posting nhưng không còn nên có (unapprove/cancel/delete/đổi sổ) → REVERSAL.
  IF v_active.id IS NOT NULL AND (NOT v_should OR v_active.account_id IS DISTINCT FROM NEW.account_id
      OR v_active.gross_amount IS DISTINCT FROM NEW.total_amount) THEN
    INSERT INTO public.income_expense_postings
      (organization_id, voucher_id, posting_subject_kind, posting_subject_id, direction,
       account_id, gross_amount, voucher_amount_snapshot, amount_basis, net_cash_effect,
       posted_on, posted_by_membership_id, posted_by_user_id, approval_version,
       event_kind, idempotency_key, source_kind, posting_generation, reversal_of_id, reversal_reason)
    VALUES
      (v_active.organization_id, v_active.voucher_id, 'VOUCHER', v_active.posting_subject_id,
       v_active.direction, v_active.account_id, v_active.gross_amount,
       v_active.voucher_amount_snapshot, v_active.amount_basis, -v_active.net_cash_effect,
       current_date, v_active.posted_by_membership_id, v_active.posted_by_user_id,
       COALESCE(NEW.approval_version, 1), 'REVERSAL',
       'bridge:rev:' || v_active.id::text, 'LEGACY_BRIDGE', v_active.posting_generation,
       v_active.id, 'auto-bridge: legacy writer changed cash projection')
    ON CONFLICT (organization_id, idempotency_key) DO NOTHING;
    INSERT INTO public.income_expense_posting_lines (organization_id, posting_id, account_id, line_kind, signed_amount)
    SELECT l.organization_id,
           (SELECT id FROM public.income_expense_postings
             WHERE organization_id = v_active.organization_id AND idempotency_key = 'bridge:rev:' || v_active.id::text),
           l.account_id, 'REVERSAL', -l.signed_amount
    FROM public.income_expense_posting_lines l
    WHERE l.posting_id = v_active.id
      AND NOT EXISTS (SELECT 1 FROM public.income_expense_posting_lines x
        WHERE x.posting_id = (SELECT id FROM public.income_expense_postings
          WHERE organization_id = v_active.organization_id AND idempotency_key = 'bridge:rev:' || v_active.id::text));
    NEW.active_posting_id_v2 := NULL;
    NEW.posting_status := CASE WHEN v_should THEN 'REVERSED' ELSE
      CASE WHEN NEW.approval_status = 'APPROVED' THEN 'REVERSED' ELSE 'UNPOSTED' END END;
    v_active := NULL;
  END IF;

  -- (b) Nên có mà chưa có → POSTING generation mới.
  IF v_should AND v_active.id IS NULL AND NEW.active_posting_id_v2 IS NULL THEN
    v_poster := COALESCE(NEW.approved_by, NEW.user_id, auth.uid());
    SELECT m.id INTO v_membership FROM public.organization_memberships m
    WHERE m.user_id = v_poster AND m.organization_id = NEW.organization_id AND m.status = 'ACTIVE' LIMIT 1;
    IF v_membership IS NULL THEN
      SELECT m.id, m.user_id INTO v_membership, v_poster FROM public.organization_memberships m
      WHERE m.user_id = auth.uid() AND m.organization_id = NEW.organization_id AND m.status = 'ACTIVE' LIMIT 1;
    END IF;
    IF v_membership IS NULL THEN
      -- Không chặn nghiệp vụ legacy: ghi exception, parity monitor sẽ bắt.
      INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
      VALUES (NEW.organization_id, NEW.id, 'BRIDGE_UNRESOLVED_POSTER',
              jsonb_build_object('approved_by', NEW.approved_by, 'user_id', NEW.user_id));
      RETURN NEW;
    END IF;

    SELECT COALESCE(max(posting_generation), 0) + 1 INTO v_gen
    FROM public.income_expense_postings
    WHERE organization_id = NEW.organization_id AND posting_subject_kind = 'VOUCHER'
      AND posting_subject_id = NEW.id AND event_kind = 'POSTING';
    v_main := CASE WHEN NEW.type = 'INCOME' THEN NEW.total_amount ELSE -NEW.total_amount END;

    INSERT INTO public.income_expense_postings
      (organization_id, voucher_id, posting_subject_kind, posting_subject_id, direction,
       account_id, gross_amount, voucher_amount_snapshot, amount_basis, net_cash_effect,
       posted_on, posted_by_membership_id, posted_by_user_id, approval_version,
       event_kind, idempotency_key, source_kind, posting_generation)
    VALUES
      (NEW.organization_id, NEW.id, 'VOUCHER', NEW.id, NEW.type, NEW.account_id,
       NEW.total_amount, NEW.total_amount, 'VOUCHER_TOTAL',
       v_main + COALESCE(NEW.change_amount, 0) + COALESCE(NEW.rounding_amount, 0),
       COALESCE(NEW.voucher_date, current_date), v_membership, v_poster,
       COALESCE(NEW.approval_version, 1), 'POSTING',
       'bridge:gen:' || NEW.id::text || ':' || v_gen::text, 'LEGACY_BRIDGE', v_gen)
    ON CONFLICT (organization_id, idempotency_key) DO NOTHING
    RETURNING id INTO v_new;
    IF v_new IS NULL THEN
      SELECT id INTO v_new FROM public.income_expense_postings
      WHERE organization_id = NEW.organization_id
        AND idempotency_key = 'bridge:gen:' || NEW.id::text || ':' || v_gen::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.income_expense_posting_lines WHERE posting_id = v_new) THEN
      INSERT INTO public.income_expense_posting_lines (organization_id, posting_id, account_id, line_kind, signed_amount)
      VALUES (NEW.organization_id, v_new, NEW.account_id, 'MAIN', v_main);
      IF COALESCE(NEW.change_amount, 0) <> 0 AND NEW.change_account_id IS NOT NULL THEN
        INSERT INTO public.income_expense_posting_lines (organization_id, posting_id, account_id, line_kind, signed_amount)
        VALUES (NEW.organization_id, v_new, NEW.change_account_id, 'CHANGE', NEW.change_amount);
      END IF;
      IF COALESCE(NEW.rounding_amount, 0) <> 0 AND NEW.rounding_account_id IS NOT NULL THEN
        INSERT INTO public.income_expense_posting_lines (organization_id, posting_id, account_id, line_kind, signed_amount)
        VALUES (NEW.organization_id, v_new, NEW.rounding_account_id, 'ROUNDING', NEW.rounding_amount);
      END IF;
    END IF;
    NEW.active_posting_id_v2 := v_new;
    NEW.posting_mode := COALESCE(NEW.posting_mode, 'CASHBOOK');
    NEW.posting_status := 'POSTED';
  END IF;

  RETURN NEW;
END
$fn$;

-- BEFORE trigger để sửa NEW trực tiếp (không tự kích hoạt lại; cột posting không nằm
-- trong UPDATE OF list).
DROP TRIGGER IF EXISTS a85_finance_v2_auto_posting_bridge ON public.income_expenses;
CREATE TRIGGER a85_finance_v2_auto_posting_bridge
  BEFORE INSERT OR UPDATE OF approval_status, account_id, total_amount, deleted_at
  ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION app_private.finance_v2_auto_posting_bridge();

-- ---------------------------------------------------------------------------
-- (2) Read cutover: view + 3 RPC legacy delegate sang posting-truth.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.accounts_with_balance AS
SELECT a.id, a.user_id, a.name, a.bank_name, a.account_number, a.is_default,
       a.created_at, a.updated_at, a.deleted_at, a.code, a.description,
       a.bank_account_holder, a.initial_amount, a.initial_date, a.lock_date,
       a.branch, a.is_virtual,
       (a.initial_amount + COALESCE((
          SELECT sum(l.signed_amount)
          FROM public.income_expense_posting_lines l
          JOIN public.income_expense_postings p ON p.id = l.posting_id
          WHERE l.account_id = a.id
            AND l.organization_id = a.organization_id
            AND p.event_kind IN ('POSTING','REVERSAL')
        ), 0::numeric))::numeric AS current_amount
FROM public.accounts a
WHERE a.deleted_at IS NULL;
-- GOTCHA án lệ: CREATE OR REPLACE VIEW làm RỚT security_invoker — set lại NGAY.
ALTER VIEW public.accounts_with_balance SET (security_invoker = true);

CREATE OR REPLACE FUNCTION public.cashbook_period_totals(
  p_start date DEFAULT NULL, p_end date DEFAULT NULL,
  p_building_id uuid DEFAULT NULL, p_account_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$ SELECT public.cashbook_period_totals_v2(p_start, p_end, p_building_id, p_account_id); $fn$;

CREATE OR REPLACE FUNCTION public.cashbook_opening_balance(
  p_before_date date, p_building_id uuid DEFAULT NULL, p_account_id uuid DEFAULT NULL)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$ SELECT public.cashbook_opening_balance_v2(p_before_date, p_building_id, p_account_id); $fn$;

CREATE OR REPLACE FUNCTION public.cashflow_by_day(
  p_start date, p_end date, p_building_id uuid DEFAULT NULL, p_account_id uuid DEFAULT NULL)
RETURNS TABLE(day date, income numeric, expense numeric) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$ SELECT * FROM public.cashflow_by_day_v2(p_start, p_end, p_building_id, p_account_id); $fn$;

COMMIT;

NOTIFY pgrst, 'reload schema';
