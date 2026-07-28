-- =====================================================================
-- B1 — nợ đã tất toán bị "sống dậy"
--
-- BUG: settle_previous_debt_sources() tất toán hoá đơn nợ cũ bằng cách ghi
-- THẲNG invoices.paid_amount = total_amount, status='PAID' lên hoá đơn NGUỒN,
-- KHÔNG tạo dòng payments nào. Nhưng recompute_invoice_for_id() lại DẪN XUẤT
-- paid_amount thuần từ payments. Hai writer, một cột, và bên dẫn xuất luôn
-- thắng ⇒ lần recompute kế tiếp xoá sạch việc tất toán, nợ quay lại OVERDUE.
-- Đã nổ 3/3 lần trong đời database này.
--
-- HẬU QUẢ ĐANG CHỜ XẢY RA: 3 hợp đồng dưới đây đều còn ACTIVE, hoá đơn nguồn
-- đang OVERDUE, và KHÔNG được lọc khỏi phần "nợ cũ" (vì hoá đơn gánh đã PAID
-- nên nằm ngoài bộ lọc của FE). Lần chạy hoá đơn kỳ tới sẽ đòi khách LẦN HAI:
--   INV-202605-000020  HĐT-096234  2.000.600đ
--   INV-202605-574763  HĐT-094332  2.325.000đ
--   INV-202605-584357  HĐT-096847     15.500đ   → tổng 4.341.100đ
--
-- CÁCH SỬA: SUY RA thay vì vật chất hoá.
--   • recompute_invoice_for_id cộng thêm phần đã được hoá đơn PAID gánh hộ.
--   • settle_previous_debt_sources thôi ghi paid_amount/status/paid_date,
--     chỉ còn ghi CHÚ THÍCH rồi gọi recompute.
--
-- VÌ SAO KHÔNG chèn dòng payments: guard_payment_canonical_link raise 42501;
-- bỏ received_amount để né thì active_payment_receipts phơi nó thành tiền mặt
-- đã thu ⇒ 4,3tr "thu ma". Và regex của classify_termination_payment_v1 không
-- khớp ghi chú này nên dòng mới sẽ không được bảo vệ.
--
-- BA ĐIỂM BẮT BUỘC (đã bị phản biện bắt lỗi ở bản đầu):
--   1. PHẢI có CHẶN TRÊN. amount trong previous_debt_sources là ẢNH CHỤP dư nợ
--      lúc phát hành. Cộng thẳng có thể vượt total ⇒ hoàn tiền ảo.
--   2. PHẢI đặt SAU nhánh early-return CANCELLED, nếu không hoá đơn đã huỷ bị
--      đẩy paid_amount vượt total.
--   3. PHẢI GIỮ ghi chú "[Tự động tất toán qua HĐ …]" — đó là lời giải thích
--      duy nhất đọc được vì sao một hoá đơn PAID mà không có dòng payments nào,
--      và chính nó giúp truy ra 3 ca này. Ghi chú phải cập nhật TRƯỚC recompute,
--      vì điều kiện của nó là status <> 'PAID'.
--
-- CỐ Ý KHÔNG đụng frontend: sau khi sửa, hoá đơn nguồn đã gánh đủ sẽ thành PAID
-- và tự rơi khỏi bộ lọc "nợ cũ" sẵn có. Nới bộ lọc FE sang PAID sẽ biến "đòi
-- phần dư còn lại" thành "không đòi gì" — mất doanh thu thật.
--
-- LƯU Ý CHO CHỦ: sau thay đổi này SUM(invoices.paid_amount) sẽ KHÔNG còn bằng
-- tổng tiền mặt đã thu — đó là CHỦ Ý (remaining_amount mới đúng). Và Business
-- Performance của 102LVT kỳ 2026-05 sẽ hiện trống vì 3 hoá đơn này bị xếp là
-- "phân bổ chưa đủ" — đúng tín hiệu, không phải lỗi mới.
--
-- Chữ ký hai hàm GIỮ NGUYÊN ⇒ CREATE OR REPLACE thay tại chỗ, không mất GRANT.
-- =====================================================================

begin;

CREATE OR REPLACE FUNCTION public.recompute_invoice_for_id(p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total numeric(15,2);
  v_paid numeric(15,2);
  v_rounding numeric(15,2);
  v_legacy_rounding numeric(15,2);
  v_legacy_refunded numeric(15,2);
  v_settlement_refunded numeric(15,2);
  v_has_v5_payment boolean;
  v_existing_status public.invoice_status;
  v_status public.invoice_status;
  v_paid_date date;
  v_due_date date;
  v_carried_raw numeric(15,2);
  v_carried numeric(15,2);
BEGIN
  IF p_invoice_id IS NULL THEN
    RETURN;
  END IF;

  SELECT total_amount, status, due_date
    INTO v_total, v_existing_status, v_due_date
  FROM public.invoices
  WHERE id = p_invoice_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COALESCE(sum(amount), 0), max(payment_date),
         COALESCE(sum(rounding_amount), 0),
         COALESCE(bool_or(collection_id IS NOT NULL), false)
    INTO v_paid, v_paid_date, v_rounding, v_has_v5_payment
  FROM public.payments
  WHERE invoice_id = p_invoice_id
    AND reversed_at IS NULL;

  -- Legacy writers stored cash change as a separate expense while keeping the
  -- gross amount in payments. V5 payments already store only the applied
  -- amount, so subtract change only from pre-collection vouchers.
  SELECT COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)), 0)
    INTO v_legacy_refunded
  FROM public.income_expenses voucher
  JOIN public.income_expense_items item
    ON item.income_expense_id = voucher.id
  JOIN public.income_expense_types type_row
    ON type_row.id = item.income_expense_type_id
  WHERE voucher.invoice_id = p_invoice_id
    AND voucher.payment_collection_id IS NULL
    AND voucher.type = 'EXPENSE'
    AND voucher.approval_status = 'APPROVED'
    AND voucher.deleted_at IS NULL
    AND lower(btrim(type_row.name)) = 'tiền thối';

  v_paid := v_paid - v_legacy_refunded;

  SELECT COALESCE(sum(voucher.rounding_amount), 0)
    INTO v_legacy_rounding
  FROM public.income_expenses voucher
  WHERE voucher.invoice_id = p_invoice_id
    AND voucher.payment_collection_id IS NULL
    AND voucher.type = 'INCOME'
    AND voucher.approval_status = 'APPROVED'
    AND voucher.deleted_at IS NULL;

  SELECT COALESCE(sum(voucher.total_amount), 0)
    INTO v_settlement_refunded
  FROM public.income_expenses voucher
  WHERE voucher.invoice_id = p_invoice_id
    AND voucher.type = 'EXPENSE'
    AND voucher.approval_status = 'APPROVED'
    AND voucher.deleted_at IS NULL
    AND voucher.notes LIKE '[Hoàn trả thanh lý]%';

  v_paid := v_paid - v_settlement_refunded;
  v_rounding := v_rounding + v_legacy_rounding;

  IF v_existing_status = 'CANCELLED' THEN
    UPDATE public.invoices
       SET paid_amount = v_paid
     WHERE id = p_invoice_id;
    RETURN;
  END IF;
  -- [B1] Phan cong no da duoc hoa don SAU ganh ho (previous_debt_sources).
  -- Truoc day settle_previous_debt_sources ghi THANG paid_amount/status len hoa
  -- don nguon ma khong tao dong payments; ham nay lai DAN XUAT paid_amount tu
  -- payments, nen moi lan recompute chay lai la khoan no da tra SONG DAY.
  -- Nay suy ra tai cho: nguon su that duy nhat van la ham nay.
  --
  -- Dat SAU nhanh CANCELLED: hoa don da huy khong phai cong no; cong vao do se
  -- day paid_amount vuot total va de ra khoan "thu thua" ao.
  SELECT COALESCE(sum((src->>'amount')::numeric), 0)
    INTO v_carried_raw
  FROM public.invoices carrier
  CROSS JOIN LATERAL jsonb_array_elements(carrier.previous_debt_sources) AS src
  WHERE carrier.deleted_at IS NULL
    AND carrier.status = 'PAID'
    AND carrier.id <> p_invoice_id
    AND jsonb_typeof(carrier.previous_debt_sources) = 'array'
    AND src->>'type' = 'invoice'
    AND NULLIF(src->>'id', '') IS NOT NULL
    AND (src->>'id')::uuid = p_invoice_id;

  -- CHAN TREN bat buoc: so trong previous_debt_sources[].amount la ANH CHUP du
  -- no luc phat hanh hoa don ganh. Neu sau do khach tra them truc tiep vao hoa
  -- don nguon, cong thang se vuot total va tao hoan tien ao. Phan suy ra chi
  -- duoc LAP DAY khoang thieu, khong bao gio vuot.
  -- COALESCE la load-bearing: LEAST(NULL, gap) trong Postgres tra ve gap.
  v_carried := LEAST(COALESCE(v_carried_raw, 0), GREATEST(v_total - v_paid, 0));
  v_paid := v_paid + v_carried;

  IF v_total > 0 THEN
    IF v_paid >= v_total OR v_paid + v_rounding >= v_total
       OR (
         NOT v_has_v5_payment
         AND v_paid > 0
         AND v_total - v_paid > 0
         AND v_total - v_paid < 10000
       ) THEN
      v_status := 'PAID';
    ELSIF v_paid > 0 AND v_due_date < current_date THEN
      v_status := 'OVERDUE';
      v_paid_date := NULL;
    ELSIF v_paid > 0 THEN
      v_status := 'PARTIAL_PAID';
      v_paid_date := NULL;
    ELSIF v_due_date < current_date THEN
      v_status := 'OVERDUE';
      v_paid_date := NULL;
    ELSE
      v_status := 'APPROVED';
      v_paid_date := NULL;
    END IF;
  ELSIF v_total < 0 THEN
    IF v_paid <= v_total THEN
      v_status := 'PAID';
    ELSIF v_paid < 0 AND v_due_date < current_date THEN
      v_status := 'OVERDUE';
      v_paid_date := NULL;
    ELSIF v_paid < 0 THEN
      v_status := 'PARTIAL_PAID';
      v_paid_date := NULL;
    ELSIF v_due_date < current_date THEN
      v_status := 'OVERDUE';
      v_paid_date := NULL;
    ELSE
      v_status := 'APPROVED';
      v_paid_date := NULL;
    END IF;
  ELSE
    v_status := CASE
      WHEN v_paid <> 0 THEN 'PAID'::public.invoice_status
      ELSE 'APPROVED'::public.invoice_status
    END;
    IF v_paid = 0 THEN
      v_paid_date := NULL;
    END IF;
  END IF;

  UPDATE public.invoices
     SET paid_amount = v_paid,
         status = v_status,
         paid_date = v_paid_date,
         updated_at = now()
   WHERE id = p_invoice_id;
END;
$function$
;

-- ── settle_previous_debt_sources: bỏ ghi tiền, giữ ghi chú, gọi recompute ──
CREATE OR REPLACE FUNCTION public.settle_previous_debt_sources()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  src       jsonb;
  src_type  text;
  src_id    uuid;
  src_amt   numeric;
  c_id      uuid;
  v_marker  text;
BEGIN
  IF NEW.status <> 'PAID' THEN RETURN NEW; END IF;
  IF OLD.status = 'PAID' THEN RETURN NEW; END IF;
  IF NEW.previous_debt_sources IS NULL
     OR jsonb_typeof(NEW.previous_debt_sources) <> 'array'
     OR jsonb_array_length(NEW.previous_debt_sources) = 0 THEN
    RETURN NEW;
  END IF;

  v_marker := '[Tự động tất toán qua HĐ '
              || COALESCE(NEW.invoice_number, NEW.id::text) || ']';

  FOR src IN SELECT * FROM jsonb_array_elements(NEW.previous_debt_sources) LOOP
    src_type := src->>'type';
    src_amt  := COALESCE((src->>'amount')::numeric, 0);
    IF src_amt <= 0 THEN CONTINUE; END IF;

    IF src_type = 'invoice' THEN
      src_id := NULLIF(src->>'id', '')::uuid;
      IF src_id IS NULL THEN CONTINUE; END IF;

      -- [B1] CHỈ ghi chú. KHÔNG còn ghi paid_amount/status/paid_date — số tiền
      -- do recompute_invoice_for_id suy ra, nên nó bền trước mọi lần tính lại.
      -- Phải chạy TRƯỚC recompute vì điều kiện là status <> 'PAID'.
      UPDATE public.invoices
         SET notes = CASE
                       WHEN notes IS NULL OR notes = '' THEN v_marker
                       ELSE notes || E'\n' || v_marker
                     END
       WHERE id = src_id
         AND status <> 'PAID'
         AND deleted_at IS NULL
         AND COALESCE(notes, '') NOT LIKE '%' || v_marker || '%';

      PERFORM public.recompute_invoice_for_id(src_id);

    ELSIF src_type = 'deposit' THEN
      -- CỐ Ý GIỮ NGUYÊN: nhánh cọc ghi thẳng contracts.deposit_paid. Đây là
      -- vấn đề riêng (cùng lớp lỗi) và cần chủ quyết định — không gộp vào đây.
      c_id := NULLIF(src->>'contract_id', '')::uuid;
      IF c_id IS NULL THEN CONTINUE; END IF;
      UPDATE public.contracts
         SET deposit_paid = LEAST(COALESCE(total_deposit, 0),
                                  COALESCE(deposit_paid, 0) + src_amt)
       WHERE id = c_id;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;

notify pgrst, 'reload schema';

commit;
