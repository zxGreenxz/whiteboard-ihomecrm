-- CẶP PHIẾU BỎ CỌC ĐI CỬA CHUYÊN TRÁCH KHI DUYỆT QUA approve_income_expense_v2
--
-- Sự cố prod 02/09/2026 (org iHome CRM, cặp 15KV-302 ngày 27/07, 5.100.000đ):
-- bấm "Chỉ duyệt" ở /income-expense → POST approve_income_expense_v2 → HTTP 500
-- 'Bút toán bỏ cọc chỉ được tạo hoặc sửa bởi writer thanh lý'.
--
-- VÌ SAO: hai chân bỏ cọc (system_source termination.forfeit_revenue /
-- termination.forfeit_offset) bị trigger a05_termination_forfeit_voucher_guard
-- (guard_termination_forfeit_voucher_v1) khoá: mọi UPDATE phải nằm trong
-- transaction đã mở writer thanh lý VÀ có dòng ie_transition_authorization cùng
-- xid. Cửa duy nhất thoả cả hai là set_termination_forfeit_status_v1 — nó khoá
-- CẢ HAI chân theo thứ tự cố định, kiểm quyền income_expenses.approve đúng toà,
-- lật cả cặp, rồi trg_forfeit_settle_on_approve tạo payment 'CT' tất toán hoá
-- đơn thanh lý. approve_income_expense_v2 UPDATE thẳng một chân nên guard nổ.
--
-- Hook cũ useApproveVoucher thử set_termination_forfeit_status_v1 TRƯỚC rồi mới
-- rơi về duyệt thường (13 cặp đã duyệt sạch từ 26/07 đến 31/08 bằng đường đó).
-- Hook V2 (commit 77f8daf6, 23/07) gọi thẳng RPC nên bỏ mất bước rẽ. Luật rẽ
-- nằm ở client là nguồn gốc lỗi: viết hook mới thì quên, không gate nào canh.
--
-- SỬA: đặt bước rẽ vào chính approve_income_expense_v2 — chép mẫu NHÁNH 2 của
-- cancel_income_voucher_v1 (20260802160000). Điều kiện rẽ là CÓ DÒNG trong
-- app_private.termination_forfeit_authorizations (đúng bằng thứ handler chịu
-- được), KHÔNG bắt theo system_source/notes — phiếu mồ côi có nhãn mà không có
-- dòng cặp phải rơi xuống đường thường như huỷ đã làm.
--
-- Thứ tự khoá: rẽ TRƯỚC câu `SELECT … FOR UPDATE` của V2. Handler khoá hai chân
-- ORDER BY id; nếu V2 khoá một chân trước rồi mới gọi handler thì hai người duyệt
-- hai chân đối diện cùng lúc tạo thứ tự khoá ngược nhau (deadlock).
--
-- KHÔNG ghi sổ idempotency canonical_write_operations và KHÔNG tăng
-- approval_version cho cặp: 26 chân đã duyệt trên prod đều approval_version = 1,
-- 0 dòng approval_requests — cặp bỏ cọc chưa bao giờ đi sổ V2, đừng bịa lịch sử
-- cho nó. Gọi lại lần hai vô hại: handler UPDATE với `IS DISTINCT FROM` nên
-- không đổi gì, cascade cũng idempotent theo marker note.
--
-- Phần còn lại của hàm chép NGUYÊN VĂN từ 20260723050000 (định nghĩa duy nhất
-- tới nay — kiểm bằng grep 'FUNCTION public.approve_income_expense_v2').
-- CREATE OR REPLACE giữ nguyên ACL (REVOKE PUBLIC / GRANT authenticated); vẫn
-- đặt lại tường minh ở cuối để đọc file là biết, không phải suy.

BEGIN;

CREATE OR REPLACE FUNCTION public.approve_income_expense_v2(
  p_voucher uuid, p_expected_approval_version bigint, p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $approve_ie$
DECLARE
  v_uid uuid;
  v_mid uuid;
  v_ie public.income_expenses;
  v_hash text := md5(jsonb_build_object('voucher', p_voucher, 'eav', p_expected_approval_version)::text);
  v_op app_private.canonical_write_operations;
  v_new_appr bigint;
  v_resp jsonb;
  v_pair_revenue uuid;
  v_pair_offset uuid;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'approve_income_expense_v2: idempotency key is required' USING ERRCODE = '22023';
  END IF;

  -- ══ Cặp phiếu bỏ cọc (thu + chi cấn nhau): rẽ sang cửa chuyên trách ══════
  -- Duyệt một chân là duyệt CẢ CẶP; handler tự khoá hai chân, tự kiểm quyền
  -- income_expenses.approve đúng toà, tự mở writer thanh lý. Rẽ trước FOR UPDATE
  -- để không tạo thứ tự khoá ngược với handler (xem đầu file).
  SELECT f.revenue_voucher_id, f.offset_voucher_id
    INTO v_pair_revenue, v_pair_offset
  FROM app_private.termination_forfeit_authorizations f
  WHERE f.revenue_voucher_id = p_voucher OR f.offset_voucher_id = p_voucher;
  IF FOUND THEN
    PERFORM public.set_termination_forfeit_status_v1(p_voucher, 'APPROVED');
    SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher;
    RETURN jsonb_build_object(
      'voucherId', p_voucher,
      'approvalStatus', v_ie.approval_status,
      'reviewState', v_ie.review_state,
      'approvalVersion', v_ie.approval_version,
      'mode', 'FORFEIT_PAIR',
      'pairVoucherId', CASE WHEN v_pair_revenue = p_voucher THEN v_pair_offset ELSE v_pair_revenue END);
  END IF;

  -- Fixed lock order: voucher first.
  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND OR v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'approve_income_expense_v2: voucher % not found', p_voucher USING ERRCODE = 'P0002';
  END IF;

  SELECT r.user_id, r.membership_id INTO v_uid, v_mid
  FROM app_private.resolve_finance_actor_v2(v_ie.organization_id) r;

  v_op := app_private.finance_v2_begin_canonical_op(
    v_ie.organization_id, 'income_expense.approve.v2', p_voucher::text, v_uid, v_mid,
    p_idempotency_key, v_hash, p_voucher);
  IF v_op.completed_at IS NOT NULL THEN
    RETURN COALESCE(v_op.response_payload, '{}'::jsonb);
  END IF;

  PERFORM app_private.assert_income_expense_flow_owner_v2(p_voucher, 'CANONICAL_INCOME_EXPENSE');

  -- Approver capability in the voucher's building scope.
  IF NOT (SELECT allowed FROM app_private.authorize_tenant_action_v3(
            v_uid, v_ie.organization_id, 'income_expenses.approve', v_ie.building_id, NULL)) THEN
    RAISE EXCEPTION 'approve_income_expense_v2: income_expenses.approve required in scope' USING ERRCODE = '42501';
  END IF;

  -- Committed birth boundary: create must have committed in a prior transaction.
  PERFORM app_private.assert_committed_birth_boundary_v2(v_ie.birth_operation_id, p_voucher);

  IF v_ie.approval_status <> 'UNAPPROVED'
     OR v_ie.review_state NOT IN ('PENDING','CHANGES_REQUESTED') THEN
    RAISE EXCEPTION 'approve_income_expense_v2: voucher not in an approvable state (%, %)',
      v_ie.approval_status, v_ie.review_state USING ERRCODE = '55000';
  END IF;
  IF v_ie.approval_version <> p_expected_approval_version THEN
    RAISE EXCEPTION 'approve_income_expense_v2: approval_version mismatch (expected %, found %)',
      p_expected_approval_version, v_ie.approval_version USING ERRCODE = '55000';
  END IF;

  v_new_appr := v_ie.approval_version + 1;
  UPDATE public.income_expenses ie
     SET approval_status = 'APPROVED', approved_by = v_uid, approved_at = now(),
         review_state = 'RESOLVED', approval_version = v_new_appr, updated_at = now()
   WHERE ie.id = p_voucher;

  -- Close the open PENDING_APPROVAL request (one-open lives only on PENDING_APPROVAL).
  UPDATE public.approval_requests ar
     SET state = 'APPROVED', outcome_kind = 'APPROVED', outcome_reason = NULL,
         closed_by_membership_id = v_mid, closed_at = now()
   WHERE ar.organization_id = v_ie.organization_id
     AND ar.subject_type = 'INCOME_EXPENSE' AND ar.subject_id = p_voucher
     AND ar.state = 'PENDING_APPROVAL';

  v_resp := jsonb_build_object('voucherId', p_voucher, 'approvalStatus', 'APPROVED',
                               'reviewState', 'RESOLVED', 'approvalVersion', v_new_appr);
  PERFORM app_private.finance_v2_finish_canonical_op(
    v_ie.organization_id, 'income_expense.approve.v2', p_voucher::text, v_uid, p_idempotency_key,
    p_voucher, v_resp, 'APPROVED', v_ie.review_version, v_new_appr, v_ie.posting_version);
  PERFORM app_private.finance_v2_log_event(v_ie.organization_id, 'income_expense.approve.v2', p_voucher, v_uid, p_idempotency_key);
  RETURN v_resp;
END
$approve_ie$;

REVOKE ALL ON FUNCTION public.approve_income_expense_v2(uuid, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_income_expense_v2(uuid, bigint, text) TO authenticated;
COMMENT ON FUNCTION public.approve_income_expense_v2(uuid, bigint, text) IS
  'Plan §7.2/§7.3: approve-only UNAPPROVED->APPROVED (balance unchanged); requires committed birth boundary. '
  'Cặp bỏ cọc (có dòng termination_forfeit_authorizations) rẽ sang set_termination_forfeit_status_v1 — 20260902092845.';

-- Selfcheck (chạy được trên DB rỗng — chỉ soi catalog, không cần dữ liệu):
DO $selfcheck$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef('public.approve_income_expense_v2(uuid, bigint, text)'::regprocedure)
    INTO v_src;
  IF position('termination_forfeit_authorizations' IN v_src) = 0
     OR position('set_termination_forfeit_status_v1' IN v_src) = 0 THEN
    RAISE EXCEPTION 'approve_income_expense_v2 chưa có nhánh rẽ cặp bỏ cọc';
  END IF;
  -- Nhánh rẽ phải đứng TRƯỚC câu khoá FOR UPDATE (thứ tự khoá — xem đầu file).
  IF position('set_termination_forfeit_status_v1' IN v_src) > position('p_voucher FOR UPDATE;' IN v_src) THEN
    RAISE EXCEPTION 'nhánh rẽ cặp bỏ cọc phải đứng trước FOR UPDATE';
  END IF;
  IF to_regprocedure('public.set_termination_forfeit_status_v1(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'thiếu set_termination_forfeit_status_v1(uuid, text)';
  END IF;
END
$selfcheck$;

COMMIT;
