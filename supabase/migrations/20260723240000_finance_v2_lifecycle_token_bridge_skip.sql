-- Finance V2 — Hotfix 7j: token lifecycle V2 + bridge skip (browser-verify bắt được).
--
-- Phát hiện khi test thật: "Chỉ duyệt" (approve_income_expense_v2) thành công NHƯNG
-- cầu a85 (dành cho writer LEGACY) thấy approval→APPROVED và tự tạo posting ⇒ tiền đi,
-- sai §2.2 (duyệt không đổi tồn quỹ). Đồng lớp: freeze guard sẽ chặn approve V2 trên
-- phiếu canonical vì Stage-5 không cấp token per-xid.
--
-- Fix một điểm chèn: finance_v2_begin_canonical_op (MỌI lifecycle RPC V2 đều gọi
-- trước khi update) cấp token ie_transition_authorization (subject, xid,
-- 'FINANCE_V2_LIFECYCLE'). Cầu a85 skip khi thấy token này — V2 writer tự quản
-- posting (approve-only giữ UNPOSTED; post RPC tự tạo event). Writer legacy không
-- có token ⇒ bridge giữ nguyên semantics chuyển tiếp.

BEGIN;

-- (1) begin_canonical_op: re-emit + cấp token cho subject (nếu có).
CREATE OR REPLACE FUNCTION app_private.finance_v2_begin_canonical_op(
  p_org uuid, p_operation text, p_subject_scope text, p_actor uuid,
  p_actor_membership uuid, p_idempotency_key text, p_payload_hash text,
  p_subject_id uuid
)
RETURNS app_private.canonical_write_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $begin_op$
DECLARE
  v_op app_private.canonical_write_operations;
BEGIN
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key,
    payload_hash, subject_id, actor_membership_id, transaction_id
  ) VALUES (
    p_org, p_operation, p_subject_scope, p_actor, p_idempotency_key,
    p_payload_hash, NULL, p_actor_membership, pg_current_xact_id()
  )
  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
  DO NOTHING;

  SELECT * INTO v_op
  FROM app_private.canonical_write_operations o
  WHERE o.organization_id = p_org
    AND o.operation = p_operation
    AND o.subject_scope = p_subject_scope
    AND o.actor_id = p_actor
    AND o.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finance_v2_begin_canonical_op: failed to reserve operation %', p_operation
      USING ERRCODE = 'P0002';
  END IF;

  IF v_op.payload_hash IS DISTINCT FROM p_payload_hash THEN
    RAISE EXCEPTION 'finance_v2_begin_canonical_op: idempotency key % reused with a different payload for %',
      p_idempotency_key, p_operation
      USING ERRCODE = '23505';
  END IF;

  -- Token per-transaction cho subject: (a) qua freeze guard trên phiếu canonical,
  -- (b) marker để cầu a85 KHÔNG lấn luồng V2.
  IF p_subject_id IS NOT NULL THEN
    INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
    VALUES (p_subject_id, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN v_op;
END
$begin_op$;

-- (2) Bridge a85: skip đầu hàm khi transition thuộc lifecycle V2 (token cùng xid).
DO $patch$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='app_private' AND p.proname='finance_v2_auto_posting_bridge';
  IF v_def NOT LIKE '%FINANCE_V2_LIFECYCLE%' THEN
    v_def := replace(v_def,
      'BEGIN
  -- Chỉ chạy khi posting route CANONICAL',
      'BEGIN
  -- Lifecycle V2 tự quản posting: approve-only giữ UNPOSTED, post RPC tự tạo event.
  IF EXISTS (SELECT 1 FROM app_private.ie_transition_authorization t
             WHERE t.income_expense_id = NEW.id AND t.xid = pg_current_xact_id()
               AND t.purpose = ''FINANCE_V2_LIFECYCLE'') THEN
    RETURN NEW;
  END IF;
  -- Chỉ chạy khi posting route CANONICAL');
    IF v_def NOT LIKE '%FINANCE_V2_LIFECYCLE%' THEN
      RAISE EXCEPTION 'bridge skip patch: pattern không khớp';
    END IF;
    EXECUTE v_def;
  END IF;
END
$patch$;

COMMIT;

NOTIFY pgrst, 'reload schema';
