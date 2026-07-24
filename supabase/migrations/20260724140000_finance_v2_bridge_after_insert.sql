-- Finance V2 — Hotfix 7y (GỐC RỄ, PROD): 2 lỗi chặn Thu tiền/Sửa phiếu.
--
-- (1) V5 thu tiền hoá đơn 23503 fk_ie_postings_voucher: bridge a85 chạy nhánh
--     "tạo POSTING" ngay TRONG BEFORE INSERT ⇒ row phiếu CHƯA tồn tại khi
--     insert con (FK non-deferrable) ⇒ MỌI phiếu INSERT-đã-duyệt-thẳng
--     (V5 tender, mọi writer auto-approve INSERT thẳng) vỡ. Ngủ yên tới nay vì
--     sau go-live CANONICAL chưa ai đi đường đó (tái hiện 100% bằng smoke).
--     Fix: BEFORE chỉ xử lý UPDATE; nhánh INSERT chuyển sang trigger AFTER
--     INSERT mới (row đã tồn tại) — tự cấp token rồi UPDATE header (a85
--     BEFORE-UPDATE thấy token cùng xid → skip, không double).
--
-- (2) Sửa phiếu chờ duyệt 23502 items.id NULL: ie_compat_update_pending_v2
--     cũng jsonb_populate_record (lớp 7o/7p chỉ vá hàm INSERT). Fix MỘT LẦN
--     CHO TẤT CẢ ở TẦNG BẢNG: trigger a000 defaults-fill trên income_expenses
--     + income_expense_items bù mọi cột NOT NULL có default khi writer đưa
--     NULL tường minh (generic từ information_schema) — mọi writer hiện tại
--     và tương lai hết lớp lỗi này.

BEGIN;

-- ========== (2) defaults-fill tầng bảng ==========
CREATE OR REPLACE FUNCTION app_private.ie_fill_not_null_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_j jsonb := to_jsonb(NEW);
  v_col record;
  v_defj jsonb;
  v_changed boolean := false;
BEGIN
  FOR v_col IN
    SELECT c.column_name, c.column_default
    FROM information_schema.columns c
    WHERE c.table_schema = TG_TABLE_SCHEMA AND c.table_name = TG_TABLE_NAME
      AND c.is_nullable = 'NO' AND c.column_default IS NOT NULL
  LOOP
    IF (v_j ->> v_col.column_name) IS NULL THEN
      EXECUTE format('SELECT to_jsonb(%s)', v_col.column_default) INTO v_defj;
      v_j := v_j || jsonb_build_object(v_col.column_name, v_defj);
      v_changed := true;
    END IF;
  END LOOP;
  IF v_changed THEN
    NEW := jsonb_populate_record(NEW, v_j);
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS a000_ie_defaults_fill ON public.income_expenses;
CREATE TRIGGER a000_ie_defaults_fill
  BEFORE INSERT ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_fill_not_null_defaults();

DROP TRIGGER IF EXISTS a000_ie_item_defaults_fill ON public.income_expense_items;
CREATE TRIGGER a000_ie_item_defaults_fill
  BEFORE INSERT ON public.income_expense_items
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_fill_not_null_defaults();

-- ========== (1a) BEFORE bridge: nhánh tạo-POSTING chỉ còn cho UPDATE ==========
DO $patch$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='app_private' AND p.proname='finance_v2_auto_posting_bridge';
  IF v_def NOT LIKE '%TG_OP = ''UPDATE'' AND v_should%' THEN
    v_def := replace(v_def,
      'IF v_should AND v_active.id IS NULL AND NEW.active_posting_id_v2 IS NULL THEN',
      'IF TG_OP = ''UPDATE'' AND v_should AND v_active.id IS NULL AND NEW.active_posting_id_v2 IS NULL THEN');
    IF v_def NOT LIKE '%TG_OP = ''UPDATE'' AND v_should%' THEN
      RAISE EXCEPTION 'bridge before-guard: pattern không khớp — kiểm tra thủ công';
    END IF;
    EXECUTE v_def;
  END IF;
END
$patch$;

-- ========== (1b) AFTER INSERT bridge: posting cho phiếu sinh-ra-đã-duyệt ==========
CREATE OR REPLACE FUNCTION app_private.finance_v2_auto_posting_bridge_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_acc public.accounts%ROWTYPE;
  v_poster uuid;
  v_membership uuid;
  v_gen bigint;
  v_main numeric(18,2);
  v_new uuid;
BEGIN
  -- Lifecycle V2 tự quản posting trong cùng txn → không đụng.
  IF EXISTS (SELECT 1 FROM app_private.ie_transition_authorization t
             WHERE t.income_expense_id = NEW.id AND t.xid = pg_current_xact_id()
               AND t.purpose = 'FINANCE_V2_LIFECYCLE') THEN
    RETURN NULL;
  END IF;
  IF app_private.evaluate_feature_route('income_expense.posting.v2', NEW.organization_id) <> 'CANONICAL' THEN
    RETURN NULL;
  END IF;
  IF NEW.deleted_at IS NOT NULL OR NEW.approval_status <> 'APPROVED'
     OR NEW.account_id IS NULL OR COALESCE(NEW.total_amount, 0) <= 0
     OR NEW.active_posting_id_v2 IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_acc FROM public.accounts WHERE id = NEW.account_id;
  IF NOT FOUND OR COALESCE(v_acc.is_virtual, false) OR v_acc.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  v_poster := COALESCE(NEW.approved_by, NEW.user_id, auth.uid());
  SELECT m.id INTO v_membership FROM public.organization_memberships m
  WHERE m.user_id = v_poster AND m.organization_id = NEW.organization_id AND m.status = 'ACTIVE' LIMIT 1;
  IF v_membership IS NULL THEN
    SELECT m.id, m.user_id INTO v_membership, v_poster FROM public.organization_memberships m
    WHERE m.user_id = auth.uid() AND m.organization_id = NEW.organization_id AND m.status = 'ACTIVE' LIMIT 1;
  END IF;
  IF v_membership IS NULL THEN
    INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
    VALUES (NEW.organization_id, NEW.id, 'BRIDGE_UNRESOLVED_POSTER',
            jsonb_build_object('approved_by', NEW.approved_by, 'user_id', NEW.user_id));
    RETURN NULL;
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
    RETURN NULL; -- idempotent replay
  END IF;
  INSERT INTO public.income_expense_posting_lines
    (organization_id, posting_id, account_id, line_kind, signed_amount)
  VALUES (NEW.organization_id, v_new, NEW.account_id, 'MAIN', v_main);
  IF COALESCE(NEW.change_amount, 0) <> 0 AND NEW.change_account_id IS NOT NULL THEN
    INSERT INTO public.income_expense_posting_lines
      (organization_id, posting_id, account_id, line_kind, signed_amount)
    VALUES (NEW.organization_id, v_new, NEW.change_account_id, 'CHANGE', NEW.change_amount);
  END IF;
  IF COALESCE(NEW.rounding_amount, 0) <> 0 AND NEW.rounding_account_id IS NOT NULL THEN
    INSERT INTO public.income_expense_posting_lines
      (organization_id, posting_id, account_id, line_kind, signed_amount)
    VALUES (NEW.organization_id, v_new, NEW.rounding_account_id, 'ROUNDING', NEW.rounding_amount);
  END IF;

  -- Token per-xid để (a) qua freeze-guard phiếu flow-owned, (b) a85 BEFORE
  -- UPDATE thấy token cùng xid → skip (không double-posting).
  INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  VALUES (NEW.id, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE');

  UPDATE public.income_expenses
     SET active_posting_id_v2 = v_new, posting_status = 'POSTED',
         posting_id = v_new, posted_at_v2 = now(), updated_at = now()
   WHERE id = NEW.id;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS a85b_finance_v2_auto_posting_bridge_ins ON public.income_expenses;
CREATE TRIGGER a85b_finance_v2_auto_posting_bridge_ins
  AFTER INSERT ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION app_private.finance_v2_auto_posting_bridge_insert();

-- ========== Smoke (chính ca V5 từng vỡ + ca items id NULL) ==========
DO $smoke$
DECLARE
  v_building uuid; v_org uuid; v_acc uuid; v_id uuid; v_item uuid;
  v_row record;
  v_bal_before numeric; v_bal_after numeric;
BEGIN
  SELECT b.id, b.organization_id INTO v_building, v_org FROM public.buildings b
  WHERE b.organization_id='dddd0000-0000-4000-8000-000000000001'
    AND b.name ILIKE '%DEMO A%' AND b.deleted_at IS NULL LIMIT 1;
  SELECT id INTO v_acc FROM public.accounts WHERE name='CANARY renamed' LIMIT 1;
  SELECT COALESCE(SUM(l.signed_amount),0) INTO v_bal_before
  FROM public.income_expense_posting_lines l WHERE l.account_id=v_acc;

  -- (i) INSERT-đã-duyệt-thẳng (ca V5): phải SỐNG + POSTED + pointer.
  INSERT INTO public.income_expenses
    (organization_id, user_id, code, type, name, building_id, account_id,
     voucher_date, total_amount, approval_status, approved_by, approved_at)
  VALUES
    (v_org, '90450d5f-29b6-4897-bdef-cdb5fb53f339',
     'SMK7Y-'||floor(extract(epoch from clock_timestamp()))::text,
     'INCOME', '[SMOKE 7y] approved-at-birth', v_building, v_acc,
     CURRENT_DATE, 1234, 'APPROVED',
     '90450d5f-29b6-4897-bdef-cdb5fb53f339', now())
  RETURNING id INTO v_id;
  SELECT posting_status, active_posting_id_v2 INTO v_row
  FROM public.income_expenses WHERE id = v_id;
  IF v_row.posting_status IS DISTINCT FROM 'POSTED' OR v_row.active_posting_id_v2 IS NULL THEN
    RAISE EXCEPTION 'smoke 7y(i): approved-at-birth không POSTED (%, %)',
      v_row.posting_status, v_row.active_posting_id_v2;
  END IF;
  SELECT COALESCE(SUM(l.signed_amount),0) INTO v_bal_after
  FROM public.income_expense_posting_lines l WHERE l.account_id=v_acc;
  IF v_bal_after - v_bal_before <> 1234 THEN
    RAISE EXCEPTION 'smoke 7y(i): balance lệch (%.)', v_bal_after - v_bal_before;
  END IF;

  -- (ii) items id NULL tường minh (ca sửa-phiếu compat): defaults-fill cứu.
  INSERT INTO public.income_expense_items (id, income_expense_id, income_expense_type_id, quantity, unit_price)
  SELECT NULL, v_id, t.id, 1, 1234 FROM public.income_expense_types t
  WHERE t.organization_id=v_org LIMIT 1
  RETURNING id INTO v_item;
  IF v_item IS NULL THEN
    RAISE EXCEPTION 'smoke 7y(ii): items id NULL không được bù';
  END IF;

  -- Dọn: hoàn tác + huỷ (token đã có trong txn từ bridge-insert).
  UPDATE public.income_expenses SET approval_status='CANCELLED', deleted_at=now()
  WHERE id = v_id; -- a85 BEFORE UPDATE: token cùng xid → skip (giữ nguyên posting)
  -- rollback tiền smoke bằng reversal tay trong cùng txn:
  INSERT INTO public.income_expense_posting_lines (organization_id, posting_id, account_id, line_kind, signed_amount)
  SELECT v_org, v_row.active_posting_id_v2, v_acc, 'REVERSAL', -1234;
  RAISE NOTICE 'bridge-after-insert smoke OK';
END
$smoke$;

COMMIT;

NOTIFY pgrst, 'reload schema';
