-- =============================================================================
-- Recurring DRAFT MODE (nghiệp vụ chốt 10/07) + pay_draft_fee_voucher
--
-- 1) income_expenses.repeat_auto_approve — cấu hình trên phiếu ĐỊNH KỲ GỐC:
--      true  (mặc định — hành vi cũ): phiếu con sinh ra APPROVED + kế thừa sổ.
--      false (Nháp chờ thanh toán):   phiếu con UNAPPROVED + account_id = NULL
--                                     (sổ trống — điền khi thanh toán thật).
-- 2) generate_recurring_vouchers: đọc cờ trên.
-- 3) Data: flip các template TIỀN NHÀ hiện có sang chế độ Nháp (quyết định user:
--    tiền nhà phải điền sổ + ảnh CK + duyệt tại trang Đóng tiền tập trung).
-- 4) pay_draft_fee_voucher(p_voucher_id, p_account_id, p_attachments):
--    "Thanh toán" 1 phiếu NHÁP — set sổ + ảnh + duyệt NGUYÊN TỬ (gọi approve_voucher
--    bên trong: giữ nguyên gate quyền duyệt + audit approved_by/approved_at;
--    lỗi ở bước nào → rollback toàn bộ).
-- =============================================================================

BEGIN;

-- ── 1) Cột cấu hình ──
ALTER TABLE public.income_expenses
  ADD COLUMN IF NOT EXISTS repeat_auto_approve boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.income_expenses.repeat_auto_approve IS
  'Chỉ có nghĩa trên phiếu định kỳ GỐC: true = phiếu con tự APPROVED + kế thừa sổ (cũ); false = phiếu con sinh NHÁP (UNAPPROVED, sổ trống) chờ thanh toán ở trang Đóng tiền tập trung.';

-- ── 2) generate_recurring_vouchers: tôn trọng repeat_auto_approve ──
CREATE OR REPLACE FUNCTION public.generate_recurring_vouchers(p_user_id uuid DEFAULT NULL)
RETURNS TABLE(parent_id uuid, child_id uuid, voucher_date date)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  parent   RECORD;
  v_child  uuid;
  v_target date;
  k        int;
  v_total  int;
BEGIN
  FOR parent IN
    SELECT *
    FROM income_expenses ie
    WHERE ie.repeat_cycle <> 'NONE'
      AND ie.deleted_at IS NULL
      AND ie.repeat_parent_id IS NULL
      AND ie.approval_status = 'APPROVED'
      AND (p_user_id IS NULL OR ie.user_id = p_user_id)
      AND (ie.repeat_infinity OR ie.repeat_count > 0)
  LOOP
    k := 1;
    LOOP
      v_target := public.add_cycle(parent.voucher_date, parent.repeat_cycle, k);

      EXIT WHEN v_target > CURRENT_DATE;
      EXIT WHEN (NOT parent.repeat_infinity) AND k > parent.repeat_count;
      EXIT WHEN k > 240;

      IF NOT EXISTS (
        SELECT 1 FROM income_expenses c
        WHERE c.repeat_parent_id = parent.id
          AND c.voucher_date = v_target
          AND c.deleted_at IS NULL
      ) THEN
        BEGIN
          INSERT INTO income_expenses (
            user_id, type, name, building_id, room_id, tenant_id,
            contract_id, account_id, payer_name,
            approval_status, approved_at, approved_by,
            business_result_accounting, counts_in_business_result,
            attachments, notes,
            receive_bank_name, receive_bank_account,
            creator_name,
            voucher_date, invoice_id, repeat_parent_id,
            repeat_cycle, repeat_infinity, repeat_count, repeat_remaining
          ) VALUES (
            parent.user_id, parent.type,
            parent.name || ' (tự động lập)',
            parent.building_id, parent.room_id, parent.tenant_id,
            NULL,
            -- DRAFT MODE: sổ trống + NHÁP, điền sổ/ảnh khi thanh toán thật
            CASE WHEN parent.repeat_auto_approve THEN parent.account_id ELSE NULL END,
            parent.payer_name,
            CASE WHEN parent.repeat_auto_approve THEN 'APPROVED' ELSE 'UNAPPROVED' END,
            CASE WHEN parent.repeat_auto_approve THEN now() ELSE NULL END,
            CASE WHEN parent.repeat_auto_approve THEN parent.user_id ELSE NULL END,
            parent.business_result_accounting, parent.counts_in_business_result,
            parent.attachments, parent.notes,
            parent.receive_bank_name, parent.receive_bank_account,
            parent.creator_name,
            v_target, NULL, parent.id,
            'NONE', false, 0, 0
          ) RETURNING id INTO v_child;

          INSERT INTO income_expense_items (
            income_expense_id, income_expense_type_id,
            description, quantity, unit_price, start_date, end_date
          )
          SELECT v_child, ii.income_expense_type_id,
                 ii.description, ii.quantity, ii.unit_price, v_target, v_target
          FROM income_expense_items ii
          WHERE ii.income_expense_id = parent.id;

          RETURN QUERY SELECT parent.id, v_child, v_target;
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'recurring child skipped parent=% date=%: %', parent.id, v_target, SQLERRM;
        END;
      END IF;

      k := k + 1;
    END LOOP;

    SELECT count(*) INTO v_total
    FROM income_expenses c
    WHERE c.repeat_parent_id = parent.id AND c.deleted_at IS NULL;

    BEGIN
      UPDATE income_expenses
      SET repeat_remaining = CASE
            WHEN parent.repeat_infinity THEN 0
            ELSE GREATEST(0, parent.repeat_count - v_total)
          END,
          repeat_next_date = CASE
            WHEN parent.repeat_infinity OR v_total < parent.repeat_count
              THEN public.add_cycle(parent.voucher_date, parent.repeat_cycle, v_total + 1)
            ELSE NULL
          END
      WHERE id = parent.id;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'recurring bookkeeping skipped parent=%: %', parent.id, SQLERRM;
    END;
  END LOOP;
END;
$function$;

-- ── 3) Flip template Tiền nhà hiện có → chế độ NHÁP ──
UPDATE public.income_expenses ie
   SET repeat_auto_approve = false
 WHERE ie.repeat_cycle <> 'NONE'
   AND ie.repeat_parent_id IS NULL
   AND ie.deleted_at IS NULL
   AND ie.type = 'EXPENSE'
   AND EXISTS (
     SELECT 1
       FROM income_expense_items it
       JOIN income_expense_types t ON t.id = it.income_expense_type_id
      WHERE it.income_expense_id = ie.id
        AND public.fee_type_matches('tien_nha', t.category, t.name)
   );

-- ── 4) pay_draft_fee_voucher — thanh toán phiếu NHÁP (sổ + ảnh + duyệt nguyên tử) ──
CREATE OR REPLACE FUNCTION public.pay_draft_fee_voucher(
  p_voucher_id  uuid,
  p_account_id  uuid,
  p_attachments jsonb DEFAULT NULL   -- mảng ĐẦY ĐỦ (cũ + mới); NULL = giữ nguyên
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_st   text;
  v_del  timestamptz;
  v_acc  uuid;
  v_code text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'Chọn sổ quỹ ghi chi trước khi thanh toán';
  END IF;

  SELECT ie.approval_status, ie.deleted_at INTO v_st, v_del
    FROM income_expenses ie WHERE ie.id = p_voucher_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiếu' USING ERRCODE = 'P0002'; END IF;
  IF v_del IS NOT NULL THEN RAISE EXCEPTION 'Phiếu đã bị hủy'; END IF;
  IF v_st <> 'UNAPPROVED' THEN
    RAISE EXCEPTION 'Phiếu không ở trạng thái nháp (hiện: %)', v_st;
  END IF;

  SELECT id INTO v_acc FROM accounts
   WHERE id = p_account_id AND deleted_at IS NULL
     AND (user_id = auth.uid() OR public.is_admin() OR public.is_super_admin());
  IF v_acc IS NULL THEN
    RAISE EXCEPTION 'Sổ quỹ không hợp lệ hoặc bạn không có quyền ghi chi vào sổ này' USING ERRCODE = '42501';
  END IF;

  UPDATE income_expenses
     SET account_id  = v_acc,
         attachments = COALESCE(p_attachments, attachments)
   WHERE id = p_voucher_id;

  -- Duyệt qua approve_voucher: giữ nguyên gate quyền duyệt + audit; RAISE → rollback cả sổ/ảnh.
  PERFORM public.approve_voucher(p_voucher_id);

  SELECT code INTO v_code FROM income_expenses WHERE id = p_voucher_id;
  RETURN jsonb_build_object('ok', true, 'voucher_id', p_voucher_id, 'code', v_code);
END;
$$;

REVOKE ALL ON FUNCTION public.pay_draft_fee_voucher(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_draft_fee_voucher(uuid,uuid,jsonb) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
