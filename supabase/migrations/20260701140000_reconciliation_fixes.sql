-- =====================================================================
-- Vá đối soát (sau review):
--  1) system_balance tính THEO NGÀY as_of (voucher_date <= p_as_of) — trước
--     đây lấy accounts_with_balance.current_amount (số dư HÔM NAY) nên khi
--     chốt số cho 1 mốc quá khứ, số dư & lệch bị sai (mismatch nhãn ↔ cơ sở).
--  2) Siết quyền auto-CONFIRM: CHỈ chủ sổ / super admin được "chốt 1 mình".
--     Đồng đội (không phải chủ) đề xuất mà bỏ trống người xác nhận → BẮT BUỘC
--     chờ CHỦ SỔ xác nhận (không được tự chốt hộ chủ).
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.propose_reconciliation(
  p_account_id      uuid,
  p_as_of           date,
  p_counted_balance numeric,
  p_counterparty_id uuid DEFAULT NULL,
  p_note            text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_owner    uuid;
  v_sys      numeric;
  v_status   text;
  v_cp       uuid;      -- counterparty thực sự lưu
  v_id       uuid;
  v_is_boss  boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;

  SELECT user_id INTO v_owner FROM accounts WHERE id = p_account_id AND deleted_at IS NULL;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Không tìm thấy sổ quỹ'; END IF;

  -- Quyền đối soát: chủ sổ / super admin / đồng đội của chủ sổ.
  IF NOT (v_owner = auth.uid() OR public.is_super_admin() OR public.same_team(v_owner)) THEN
    RAISE EXCEPTION 'Bạn không có quyền đối soát sổ này';
  END IF;

  -- Số dư hệ thống TÍNH ĐẾN NGÀY as_of (khớp nhãn as_of_date). Bằng
  -- current_amount khi as_of = hôm nay. Bao gồm cả điều chỉnh thối/làm tròn.
  SELECT COALESCE(a.initial_amount, 0)
       + COALESCE((SELECT sum(ie.total_amount) FROM income_expenses ie
                    WHERE ie.account_id = a.id AND ie.type = 'INCOME'
                      AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
                      AND ie.voucher_date <= p_as_of), 0)
       - COALESCE((SELECT sum(ie.total_amount) FROM income_expenses ie
                    WHERE ie.account_id = a.id AND ie.type = 'EXPENSE'
                      AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
                      AND ie.voucher_date <= p_as_of), 0)
       + COALESCE((SELECT sum(ie.change_amount) FROM income_expenses ie
                    WHERE ie.change_account_id = a.id
                      AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
                      AND ie.voucher_date <= p_as_of), 0)
       + COALESCE((SELECT sum(ie.rounding_amount) FROM income_expenses ie
                    WHERE ie.rounding_account_id = a.id
                      AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
                      AND ie.voucher_date <= p_as_of), 0)
    INTO v_sys
    FROM accounts a WHERE a.id = p_account_id;
  v_sys := COALESCE(v_sys, 0);

  v_is_boss := (v_owner = auth.uid() OR public.is_super_admin());

  -- Xác định trạng thái + người xác nhận:
  IF p_counterparty_id IS NOT NULL AND p_counterparty_id <> auth.uid() THEN
    v_status := 'PENDING'; v_cp := p_counterparty_id;              -- có người đối ứng rõ ràng
  ELSIF v_is_boss THEN
    v_status := 'CONFIRMED'; v_cp := NULL;                         -- chủ/super tự chốt
  ELSE
    v_status := 'PENDING'; v_cp := v_owner;                        -- đồng đội đề xuất → CHỦ xác nhận
  END IF;

  INSERT INTO cashbook_reconciliations
    (account_id, as_of_date, system_balance, counted_balance, diff, status, note,
     proposed_by, counterparty_id, confirmed_by, confirmed_at)
  VALUES
    (p_account_id, p_as_of, v_sys, COALESCE(p_counted_balance, v_sys),
     COALESCE(p_counted_balance, v_sys) - v_sys, v_status, NULLIF(btrim(p_note), ''),
     auth.uid(), v_cp,
     CASE WHEN v_status = 'CONFIRMED' THEN auth.uid() END,
     CASE WHEN v_status = 'CONFIRMED' THEN now() END)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'status', v_status,
                            'system_balance', v_sys,
                            'diff', COALESCE(p_counted_balance, v_sys) - v_sys);
END;
$function$;
REVOKE ALL ON FUNCTION public.propose_reconciliation(uuid,date,numeric,uuid,text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.propose_reconciliation(uuid,date,numeric,uuid,text) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
