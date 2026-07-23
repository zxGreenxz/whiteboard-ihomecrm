-- Finance V2 — Stage 4b: BIRTH PROVENANCE (plan §6.1, §10.1 "LEGACY_BACKFILL_BIRTH").
--
-- assert_committed_birth_boundary_v2 (Stage-5) đòi với MỌI phiếu pending khi
-- approve/post/transition:
--   • op canonical: (org, operation='income_expense.create.v2', subject_id=voucher),
--     completed_at NOT NULL;
--   • income_expenses.source_payload_hash == op.payload_hash (32 ký tự);
--   • birth_operation_id NOT NULL và birth_txid ≠ pg_current_xact_id().
-- Thiếu mảnh: phiếu legacy/pending hiện có + phiếu mới từ writer cũ (v1/compat/hệ
-- thống) không có khai sinh ⇒ mọi lifecycle V2 fail "no birth provenance".
--
-- Fix chuẩn §10.1:
--   (1) Trigger a86 BEFORE INSERT: phiếu UNAPPROVED chưa có provenance được khai sinh
--       tự động (op completed cùng transaction tạo; birth_txid = txid tạo ⇒
--       create→approve CÙNG transaction vẫn bị chặn — đúng §6.1).
--   (2) Backfill khai sinh cho toàn bộ pending hiện có (outcome 'LEGACY_BACKFILL_BIRTH').

BEGIN;

-- ---------------------------------------------------------------------------
-- Helper khai sinh: tạo op create.v2 completed + trả (txid, hash). Owner-only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.finance_v2_register_birth_v1(
  p_org uuid, p_voucher uuid, p_actor_user uuid, p_outcome text
)
RETURNS TABLE (birth_txid xid8, payload_hash text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_membership uuid;
  v_hash text := md5('birth:' || p_voucher::text);
BEGIN
  SELECT m.id INTO v_membership FROM public.organization_memberships m
  WHERE m.user_id = p_actor_user AND m.organization_id = p_org LIMIT 1;

  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key,
    payload_hash, subject_id, actor_membership_id, transaction_id,
    response_payload, completed_at, outcome_kind
  ) VALUES (
    p_org, 'income_expense.create.v2', p_voucher::text, p_actor_user,
    'birth:' || p_voucher::text, v_hash, p_voucher, v_membership,
    pg_current_xact_id(), jsonb_build_object('birth', true, 'kind', p_outcome),
    now(), p_outcome
  )
  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
  DO NOTHING;

  RETURN QUERY
  SELECT o.transaction_id, o.payload_hash
  FROM app_private.canonical_write_operations o
  WHERE o.organization_id = p_org AND o.operation = 'income_expense.create.v2'
    AND o.subject_id = p_voucher
  LIMIT 1;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.finance_v2_register_birth_v1(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- (1) Trigger a86: khai sinh tự động cho phiếu UNAPPROVED mới từ MỌI writer cũ.
--     Writer V2 đầy đủ (create_income_expense_v2) tự set birth_* trước insert ⇒ skip.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.finance_v2_birth_provenance_bridge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_txid xid8;
  v_hash text;
BEGIN
  IF NEW.approval_status = 'UNAPPROVED' AND NEW.birth_operation_id IS NULL THEN
    SELECT b.birth_txid, b.payload_hash INTO v_txid, v_hash
    FROM app_private.finance_v2_register_birth_v1(
      NEW.organization_id, NEW.id, COALESCE(auth.uid(), NEW.user_id), 'BIRTH_BRIDGE') b;
    NEW.birth_operation_id := NEW.id;
    NEW.birth_txid := v_txid;
    NEW.source_payload_hash := v_hash;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS a86_finance_v2_birth_provenance ON public.income_expenses;
CREATE TRIGGER a86_finance_v2_birth_provenance
  BEFORE INSERT ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION app_private.finance_v2_birth_provenance_bridge();

-- ---------------------------------------------------------------------------
-- (1b) Freeze-guard allowlist: birth_operation_id/birth_txid/source_payload_hash
--      là lifecycle provenance — cho phép đổi (vẫn cần token per-xid như cũ).
-- ---------------------------------------------------------------------------
DO $widen$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p WHERE p.oid = (
    SELECT tgfoid FROM pg_trigger
    WHERE tgrelid='public.income_expenses'::regclass AND tgname='a00_ie_owned_payload_freeze');
  IF v_def NOT LIKE '%birth_operation_id%' THEN
    v_def := replace(v_def,
      $$'reversed_by_posting_id','updated_at',$$,
      $$'reversed_by_posting_id','updated_at',
                              'birth_operation_id','birth_txid','source_payload_hash',$$);
    IF v_def NOT LIKE '%birth_operation_id%' THEN
      RAISE EXCEPTION 'widen freeze allowlist: pattern không khớp — kiểm tra thủ công';
    END IF;
    EXECUTE v_def;
  END IF;
END
$widen$;

-- Token per-transaction cho các phiếu pending flow-owned sắp được stamp birth.
INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
SELECT ie.id, pg_current_xact_id(), 'FINANCE_V2_BIRTH_BACKFILL'
FROM public.income_expenses ie
WHERE ie.approval_status='UNAPPROVED' AND ie.deleted_at IS NULL
  AND ie.birth_operation_id IS NULL
  AND app_private.is_income_expense_flow_owned(ie.id)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- (2) Backfill khai sinh cho TOÀN BỘ pending hiện có (§10.1).
-- ---------------------------------------------------------------------------
DO $backfill$
DECLARE
  v_row record;
  v_txid xid8;
  v_hash text;
  v_n integer := 0;
BEGIN
  FOR v_row IN
    SELECT ie.id, ie.organization_id, ie.user_id
    FROM public.income_expenses ie
    WHERE ie.approval_status = 'UNAPPROVED' AND ie.deleted_at IS NULL
      AND ie.birth_operation_id IS NULL
  LOOP
    BEGIN
      SELECT b.birth_txid, b.payload_hash INTO v_txid, v_hash
      FROM app_private.finance_v2_register_birth_v1(
        v_row.organization_id, v_row.id, v_row.user_id, 'LEGACY_BACKFILL_BIRTH') b;
      UPDATE public.income_expenses
         SET birth_operation_id = v_row.id,
             birth_txid = v_txid,
             source_payload_hash = v_hash
       WHERE id = v_row.id;
      v_n := v_n + 1;
    EXCEPTION WHEN others THEN
      -- Lớp bị guard writer-hệ-thống chặn (forfeit pair, profit-linked, salary…):
      -- lifecycle của chúng thuộc adapter owner (§6.8/§6.10), generic RPC vốn từ
      -- chối các phiếu này — ghi nhận để adapter/pair backfill xử lý, không chặn stage.
      INSERT INTO app_private.income_expense_v2_backfill_exceptions
        (organization_id, voucher_id, reason_code, detail)
      VALUES (v_row.organization_id, v_row.id, 'BIRTH_STAMP_BLOCKED',
              jsonb_build_object('sqlstate', SQLSTATE, 'message', SQLERRM))
      ON CONFLICT DO NOTHING;
    END;
  END LOOP;
  RAISE NOTICE 'birth backfill: % voucher (blocked → exceptions)', v_n;
END
$backfill$;

COMMIT;

NOTIFY pgrst, 'reload schema';
