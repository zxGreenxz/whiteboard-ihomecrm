-- =============================================
-- Migration: viết lại generate_recurring_vouchers cho ĐÚNG + AN TOÀN
-- Sửa các lỗi:
--   F1  : phiếu con đầu tiên trùng ngày phiếu cha (double-count 1 kỳ)
--   drift: ngày 29/30/31 tụt vĩnh viễn về 28 sau tháng 2 (cộng dồn interval)
--   F4  : phiếu cha đã huỷ/nháp vẫn đẻ con (RPC không lọc approval_status)
--   F5  : 1 phiếu dính khoá sổ (lock_date) làm hỏng cả lượt sinh (không EXCEPTION)
--   idempotency: chạy lại / cron + nút thủ công chồng nhau sinh trùng phiếu
-- Ngữ nghĩa: phiếu gốc = kỳ #1 (đã ghi nhận). repeat_count = số phiếu CON sinh thêm.
-- Phiếu con là phiếu thu/chi ĐỘC LẬP: contract_id = NULL, invoice_id = NULL
--   (tránh trigger recompute_contract_deposit_paid thổi phồng tiền cọc HĐ).
-- =============================================

-- 1. Helper add_cycle: kỳ thứ k tính TỪ anchor (neo ngày-trong-tháng) → KHÔNG drift.
--    MONTH/QUARTER/YEAR: clamp ngày về số ngày của tháng đích nhưng vẫn neo theo
--    ngày gốc (vd 31/01 → 28/02 → 31/03 → 30/04, không tụt vĩnh viễn về 28).
CREATE OR REPLACE FUNCTION public.add_cycle(anchor date, cycle text, k integer)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_months_step int;
  v_target_first date;
  v_days_in_target int;
  v_dom int;
BEGIN
  IF cycle = 'WEEK' THEN
    RETURN anchor + (7 * k);
  END IF;

  v_months_step := CASE cycle
    WHEN 'MONTH'   THEN 1
    WHEN 'QUARTER' THEN 3
    WHEN 'YEAR'    THEN 12
    ELSE 0
  END;

  IF v_months_step = 0 THEN
    RETURN anchor;  -- NONE hoặc không xác định
  END IF;

  v_target_first   := (date_trunc('month', anchor) + make_interval(months => v_months_step * k))::date;
  v_days_in_target := extract(day FROM (v_target_first + interval '1 month' - interval '1 day'))::int;
  v_dom            := LEAST(extract(day FROM anchor)::int, v_days_in_target);

  RETURN v_target_first + (v_dom - 1);
END;
$$;

COMMENT ON FUNCTION public.add_cycle(date, text, integer) IS
  'Ngày kỳ thứ k tính từ anchor, neo ngày-trong-tháng (chống drift cuối tháng). WEEK/MONTH/QUARTER/YEAR.';

-- 2. Unique index chống trùng phiếu con cùng (cha, ngày) — bảo chứng idempotent
--    kể cả khi cron + nút thủ công chạy đồng thời (race).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ie_repeat_child_date
  ON income_expenses(repeat_parent_id, voucher_date)
  WHERE repeat_parent_id IS NOT NULL AND deleted_at IS NULL;

-- 3. RPC viết lại.
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
      AND ie.repeat_parent_id IS NULL                 -- chỉ phiếu GỐC mới sinh con
      AND ie.approval_status = 'APPROVED'              -- FIX F4: gốc huỷ/nháp ⇒ dừng sinh
      AND (p_user_id IS NULL OR ie.user_id = p_user_id)
      AND (ie.repeat_infinity OR ie.repeat_count > 0)  -- bỏ qua cấu hình "chết"
  LOOP
    k := 1;
    LOOP
      -- FIX F1: k bắt đầu từ 1 ⇒ ngày con LUÔN sau ngày phiếu gốc (gốc là kỳ #1).
      -- chống drift: add_cycle neo theo parent.voucher_date.
      v_target := public.add_cycle(parent.voucher_date, parent.repeat_cycle, k);

      EXIT WHEN v_target > CURRENT_DATE;
      EXIT WHEN (NOT parent.repeat_infinity) AND k > parent.repeat_count;
      EXIT WHEN k > 240;                               -- chặn an toàn (thay cap 24 cũ)

      IF NOT EXISTS (
        SELECT 1 FROM income_expenses c
        WHERE c.repeat_parent_id = parent.id
          AND c.voucher_date = v_target
          AND c.deleted_at IS NULL
      ) THEN
        BEGIN                                          -- FIX F5: cô lập lỗi từng phiếu con
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
            NULL,                                       -- phiếu con đứng độc lập
            parent.account_id, parent.payer_name,
            'APPROVED', now(), parent.user_id,
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

    -- Bookkeeping DERIVE từ số con thực tế (không cộng dồn ⇒ luôn nhất quán).
    SELECT count(*) INTO v_total
    FROM income_expenses c
    WHERE c.repeat_parent_id = parent.id AND c.deleted_at IS NULL;

    -- Bọc EXCEPTION: nếu phiếu cha nằm trong kỳ đã KHOÁ SỔ (lock_date), trigger
    -- chặn UPDATE — không được để việc đó làm hỏng cả lượt sinh (chỉ là bookkeeping
    -- hiển thị; lần sinh sau RPC tự suy lại từ số con thực tế).
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

GRANT EXECUTE ON FUNCTION public.generate_recurring_vouchers(uuid) TO authenticated;

COMMENT ON FUNCTION public.generate_recurring_vouchers(uuid) IS
  'Sinh phiếu con cho các phiếu GỐC (repeat_parent_id NULL, APPROVED, repeat_cycle<>NONE). '
  'Phiếu gốc = kỳ #1; con sinh từ kỳ kế tiếp (add_cycle neo ngày, chống drift). '
  'Idempotent (dedup theo (repeat_parent_id, voucher_date)); cô lập lỗi từng con. '
  'p_user_id NULL = mọi owner (dùng cho job nền pg_cron).';
