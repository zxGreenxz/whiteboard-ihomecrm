-- Finance V2 — Hotfix 7t: allowlist freeze-guard thiếu cột lifecycle V2.
--
-- PROD (phiếu "Tesst" của NATHAN — phiếu v1-pending ĐẦU TIÊN sau fix 7s):
-- approve_income_expense_v2 / approve_and_post 500:
--   "authorized transition may only change lifecycle columns of <id>"
-- Guard a00 có token (7j cấp FINANCE_V2_LIFECYCLE) nhưng allowlist t5_08 chỉ
-- biết cột lifecycle THỜI V1 (approval_status/approved_*/posting_id/posted_at_v2/
-- verified_*). Writer V2 đụng thêm: review_state/review_version/review_reason,
-- approval_version/posting_version, posting_status/posting_mode,
-- active_posting_id_v2, cancellation_kind, deleted_at (compat cancel soft-delete),
-- approval_request_id (engine linkage) ⇒ 55000.
--
-- Tổ hợp (writer v1 × lifecycle V2) chưa từng tồn tại trước 7s — phiếu v1
-- chờ-duyệt không tạo nổi nên chưa ai duyệt V2 trên nó. Widen ALLOWLIST (vẫn
-- allowlist, không denylist): các cột thêm đều server-owned (client hết DML
-- trực tiếp từ Stage-7) — payload (name/total/account/items…) vẫn đóng băng.

BEGIN;

DO $patch$
DECLARE v_def text;
DECLARE v_old text := $$'approval_status','posting_id','posted_at_v2',
                              'reversed_by_posting_id','updated_at',
                              'birth_operation_id','birth_txid','source_payload_hash',
                              'approved_by','approved_at',
                              'verified_at','verified_by','verified_by_name',
                              'verified_note'$$;
DECLARE v_new text := $$'approval_status','posting_id','posted_at_v2',
                              'reversed_by_posting_id','updated_at',
                              'birth_operation_id','birth_txid','source_payload_hash',
                              'approved_by','approved_at',
                              'verified_at','verified_by','verified_by_name',
                              'verified_note',
                              'review_state','review_version','review_reason',
                              'approval_version','posting_version',
                              'posting_status','posting_mode','active_posting_id_v2',
                              'cancellation_kind','deleted_at','approval_request_id'$$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p WHERE p.proname='guard_income_expense_owned_payload';
  IF v_def LIKE '%active_posting_id_v2%' THEN
    RETURN; -- đã vá
  END IF;
  v_def := replace(v_def, v_old, v_new);
  IF (length(v_def) - length(replace(v_def, 'active_posting_id_v2', ''))) / length('active_posting_id_v2') <> 2 THEN
    RAISE EXCEPTION 'freeze allowlist v2: pattern phải khớp đúng 2 chỗ (old/new jsonb) — kiểm tra thủ công';
  END IF;
  EXECUTE v_def;
END
$patch$;

-- Smoke: phiếu v1-style flow-owned + token → đổi review_state/approval_version
-- phải QUA; đổi total_amount phải BỊ CHẶN.
DO $smoke$
DECLARE
  v_building uuid;
  v_id uuid;
BEGIN
  SELECT id INTO v_building FROM public.buildings
  WHERE organization_id='dddd0000-0000-4000-8000-000000000001'
    AND name ILIKE '%DEMO A%' AND deleted_at IS NULL LIMIT 1;
  INSERT INTO public.income_expenses
    (organization_id, user_id, code, type, name, building_id, voucher_date,
     total_amount, approval_status, source_payload_hash)
  VALUES
    ('dddd0000-0000-4000-8000-000000000001',
     '90450d5f-29b6-4897-bdef-cdb5fb53f339',
     'SMK7T-'||floor(extract(epoch from clock_timestamp()))::text,
     'EXPENSE', '[SMOKE 7t] allowlist', v_building, CURRENT_DATE, 1000,
     'UNAPPROVED', md5('smoke-7t'))
  RETURNING id INTO v_id;
  INSERT INTO app_private.income_expense_flow_ownership (
    income_expense_id, organization_id, writer_operation,
    payload_hash_scheme, payload_hash_value, maker_user_id, claimed_by_user_id, correlation_id)
  VALUES (v_id, 'dddd0000-0000-4000-8000-000000000001', 'income_expense.create_draft.v1',
          'PG_MD5_JSONB_TEXT_V1', md5('smoke-7t'),
          '90450d5f-29b6-4897-bdef-cdb5fb53f339', '90450d5f-29b6-4897-bdef-cdb5fb53f339', NULL);

  INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  VALUES (v_id, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE') ON CONFLICT DO NOTHING;

  -- (a) lifecycle V2 phải qua
  UPDATE public.income_expenses
     SET approval_status='APPROVED', review_state='RESOLVED',
         approval_version=COALESCE(approval_version,1)+1,
         approved_by='90450d5f-29b6-4897-bdef-cdb5fb53f339', approved_at=now()
   WHERE id=v_id;

  -- (b) payload vẫn phải đóng băng
  BEGIN
    UPDATE public.income_expenses SET total_amount=999999 WHERE id=v_id;
    RAISE EXCEPTION 'smoke 7t: payload không còn đóng băng!';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL; -- đúng kỳ vọng
  END;

  -- dọn: cancel + soft-delete (deleted_at giờ trong allowlist)
  UPDATE public.income_expenses
     SET approval_status='CANCELLED', deleted_at=now() WHERE id=v_id;
  RAISE NOTICE 'freeze allowlist v2 smoke OK';
END
$smoke$;

COMMIT;

NOTIFY pgrst, 'reload schema';
