-- =============================================================================
-- Vá false-positive của guard phiếu bỏ cọc: chỉ đòi "authorized transition RPC"
-- khi approval_status THỰC SỰ đổi.
--
-- BUG (sự cố prod, phát hiện 2026-07-22)
--   Thanh lý hợp đồng CÓ bỏ cọc ("Lập hoá đơn & thanh lý") bắn 42501
--   "Forfeit voucher status must be changed by its authorized transition RPC"
--   NGAY ở bước tạo phiếu — dù chưa hề đổi trạng thái.
--
--   Chuỗi (tái hiện live, rollback): terminate_contract_forfeit_impl INSERT
--   income_expense_items cho phiếu offset (dòng 157-158) -> trigger
--   auto_recalc_total_amount chạy `UPDATE income_expenses SET total_amount = v_total
--   WHERE id = v_parent_id`. total_amount vốn đã = v_deposit nên UPDATE này KHÔNG
--   đổi giá trị thật, chỉ bump updated_at. Guard tính v_status_only=TRUE (mọi cột
--   trừ {approval_status, approved_by, approved_at, updated_at} không đổi) rồi tưởng
--   đây là một chuyển-status -> đòi ie_transition_authorization -> không có -> 42501.
--
-- NGUYÊN NHÂN: v_status_only quá rộng — coi cả no-op touch (chỉ đổi updated_at,
--   approval_status GIỮ NGUYÊN) là chuyển-status.
--
-- FIX: chỉ vào nhánh đòi authorization khi `NEW.approval_status IS DISTINCT FROM
--   OLD.approval_status`. Chuyển-status hợp lệ LUÔN đổi approval_status (cả
--   set_termination_forfeit_status_v1 lẫn cascade trg_forfeit_settle_on_approve đều
--   guard `approval_status IS DISTINCT FROM`), nên bảo vệ không hề bị nới lỏng; chỉ
--   loại bỏ false-positive trên no-op update.
--
-- Verify (live, rollback): sau fix, forfeit HĐ thật (NATHAN, HD-2026-00259) chạy
--   trọn vẹn — tạo settlement invoice + 2 phiếu chờ duyệt; luồng approve chuẩn
--   (set_termination_forfeit_status_v1 -> cascade) vẫn đòi & pass authorization.
--
-- Chỉ CREATE OR REPLACE hàm; trigger a05_termination_forfeit_voucher_guard đã trỏ
-- sẵn hàm này nên không cần tạo lại. Idempotent.
-- =============================================================================

begin;

CREATE OR REPLACE FUNCTION app_private.guard_termination_forfeit_voucher_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_protected boolean;
  v_writer boolean;
  v_status_only boolean;
  v_transition_authorized boolean;
BEGIN
  v_protected := COALESCE(NEW.system_source, '') IN (
    'termination.forfeit_revenue', 'termination.forfeit_offset'
  ) OR (
    TG_OP = 'UPDATE'
    AND COALESCE(OLD.system_source, '') IN (
      'termination.forfeit_revenue', 'termination.forfeit_offset'
    )
  );
  IF NOT v_protected THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.approval_status = 'CANCELLED'
     AND NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    RAISE EXCEPTION 'Cancelled forfeit vouchers are terminal'
      USING ERRCODE = '55000';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_writer;
  IF NOT v_writer THEN
    RAISE EXCEPTION 'Bút toán bỏ cọc chỉ được tạo hoặc sửa bởi writer thanh lý'
      USING ERRCODE = '55000';
  END IF;

  v_status_only := TG_OP = 'UPDATE'
    AND (
      to_jsonb(NEW) - ARRAY[
        'approval_status', 'approved_by', 'approved_at', 'updated_at'
      ]::text[]
    ) IS NOT DISTINCT FROM (
      to_jsonb(OLD) - ARRAY[
        'approval_status', 'approved_by', 'approved_at', 'updated_at'
      ]::text[]
    );

  -- FIX 20260722: chỉ đòi authorized-transition RPC khi approval_status THỰC SỰ
  -- đổi. Trước đây guard coi mọi update "chỉ khác cột status/updated_at" là chuyển
  -- trạng thái, kể cả no-op touch chỉ bump updated_at (auto_recalc_total_amount ghi
  -- total_amount = giá trị cũ khi INSERT income_expense_items lúc thanh lý) -> 42501
  -- sai ngay bước tạo phiếu. Transition thật luôn đổi approval_status nên bảo vệ vẫn
  -- đầy đủ.
  IF v_status_only
     AND NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    SELECT EXISTS (
      SELECT 1
      FROM app_private.ie_transition_authorization transition_row
      WHERE transition_row.income_expense_id = NEW.id
        AND transition_row.xid = pg_current_xact_id()
        AND transition_row.purpose = NEW.approval_status
    ) INTO v_transition_authorized;
    IF NOT v_transition_authorized THEN
      RAISE EXCEPTION 'Forfeit voucher status must be changed by its authorized transition RPC'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

commit;
