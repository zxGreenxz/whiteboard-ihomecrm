-- =============================================================================
-- Bỏ số điện thoại khách hàng khỏi payload của trang hoá đơn CÔNG KHAI
--
-- ĐO ĐƯỢC 08/08/2026 — đường phơi bày còn nguyên, chỉ là chưa ai vá:
--
--   public.get_public_latest_invoice_by_code(text)   anon GỌI ĐƯỢC
--     → tra public_code (6 ký tự) ra contract_id
--     → gọi public.get_public_latest_invoice_by_contract(uuid)
--
-- Việc thu hồi quyền anon của hàm thứ hai (đã làm ở GĐ0) KHÔNG chặn được đường
-- này: nó được gọi từ BÊN TRONG một hàm SECURITY DEFINER, nên chạy bằng quyền
-- chủ hàm chứ không phải quyền anon. Kết quả: chỉ cần một mã 6 ký tự đúng là
-- lấy được `customer` gồm HỌ TÊN và SỐ ĐIỆN THOẠI, cộng invoice/room/bed/building.
--
-- Không gian tìm kiếm, tính bằng chính hàm sinh mã đang chạy
-- (public.gen_contract_public_code — bảng chữ cái 57 ký tự, độ dài 6):
--   57^6 = 34.296.447.249 tổ hợp · 334 mã đang sống
--   ⇒ mật độ trúng ≈ 9,7e-9, tức trung bình ~103 triệu lần thử cho MỘT lần trúng.
-- Ở 50 req/s là ~24 ngày; ở 500 req/s là ~2,4 ngày. Và không có rate-limit ở
-- đâu cả: trình duyệt gọi thẳng supabase.co nên Vercel/Cloudflare không nhìn
-- thấy request (đã ghi ở GĐ-R mục 1).
--
-- Kế hoạch xếp rate-limit xuống hàng "phòng thủ chiều sâu" VÌ TIN RẰNG GĐ0 đã
-- xoay toàn bộ public_code lên ≥16 ký tự. Đo ra: chưa xoay dòng nào — cả 334 mã
-- vẫn 6 ký tự, không có CHECK độ dài, không có cột ân hạn. Tiền đề đó sai.
--
-- FILE NÀY LÀM ĐÚNG MỘT VIỆC, và là việc không cần ai quyết: bỏ số điện thoại
-- khỏi payload. Đó là mục 6a(iii) của GĐ0.
--
-- KHÔNG làm ở đây — vì chúng đổi thứ đã phát ra ngoài cho khách:
--   • xoay 334 mã lên ≥16 ký tự (làm chết mọi QR đã in và đã gửi, phải có cửa sổ
--     ân hạn old_public_code/old_code_expires_at) — chờ người quyết
--   • thêm expires_at + revoked và ĐƯA VÀO mệnh đề WHERE — đi cùng lần xoay mã
--   • rate-limit (GĐ-R) — còn phải chứng minh PostgREST có phơi request.headers
--     trên project này thì mới chọn được thiết kế
--
-- Bỏ số điện thoại KHÔNG làm giảm ý nghĩa của ba việc kia: họ tên khách vẫn còn
-- trong payload, và họ tên cũng là dữ liệu cá nhân. Đây là giảm thiệt hại, không
-- phải đóng lỗ.
--
-- Client chịu được — đã đọc mã chứ không tin lời kế hoạch:
-- src/pages/public/PublicContractInvoicePage.tsx:254 render `customer.phone || 'N/A'`
-- trong khối bọc bởi `customer?.full_name &&`. Nhưng để một ô ghi "Số điện thoại:
-- N/A" thì vô nghĩa, nên khối JSX đó được dọn cùng lúc trong chính commit này.
--
-- Thân hàm dưới đây là BẢN ĐANG CHẠY, chép nguyên văn, chỉ đổi HAI chỗ:
-- hai lần `jsonb_build_object('full_name', c.full_name, 'phone', c.phone)`
-- thành `jsonb_build_object('full_name', c.full_name)`, và hai lần
-- `SELECT cust.full_name, cust.phone` thành `SELECT cust.full_name`.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_public_latest_invoice_by_contract(p_contract_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract RECORD;
  v_invoice_id uuid;
  v_result jsonb;
BEGIN
  -- Hợp đồng phải tồn tại, chưa xoá, và chưa thanh lý.
  SELECT id, status, room_id, deleted_at
  INTO v_contract
  FROM public.contracts
  WHERE id = p_contract_id;

  IF v_contract.id IS NULL
     OR v_contract.deleted_at IS NOT NULL
     OR v_contract.status = 'TERMINATED' THEN
    RETURN NULL;
  END IF;

  -- Hoá đơn mới nhất của hợp đồng (bỏ DRAFT/CANCELLED).
  SELECT id INTO v_invoice_id
  FROM public.invoices
  WHERE contract_id = p_contract_id
    AND deleted_at IS NULL
    AND status <> 'CANCELLED'
    AND status <> 'DRAFT'
  ORDER BY billing_month DESC, created_at DESC
  LIMIT 1;

  IF v_invoice_id IS NULL THEN
    SELECT jsonb_build_object(
      'invoice', NULL,
      'room', CASE WHEN r.id IS NOT NULL
        THEN jsonb_build_object('id', r.id, 'name', r.name, 'code', r.code)
        ELSE NULL END,
      'building', CASE WHEN b.id IS NOT NULL
        THEN jsonb_build_object('id', b.id, 'name', b.name)
        ELSE NULL END,
      'bed', NULL,
      -- SỐ ĐIỆN THOẠI ĐÃ BỎ: bề mặt này anon gọi được bằng một mã 6 ký tự.
      'customer', CASE WHEN c.full_name IS NOT NULL
        THEN jsonb_build_object('full_name', c.full_name)
        ELSE NULL END
    )
    INTO v_result
    FROM public.contracts ct
    LEFT JOIN public.rooms r ON r.id = ct.room_id
    LEFT JOIN public.buildings b ON b.id = r.building_id
    LEFT JOIN LATERAL (
      SELECT cust.full_name
      FROM public.contract_customers cc
      JOIN public.customers cust ON cust.id = cc.customer_id
      WHERE cc.contract_id = ct.id
      ORDER BY cc.is_representative DESC NULLS LAST
      LIMIT 1
    ) c ON TRUE
    WHERE ct.id = p_contract_id;

    RETURN v_result;
  END IF;

  SELECT jsonb_build_object(
    'invoice', jsonb_build_object(
      'id', i.id,
      'invoice_number', i.invoice_number,
      'billing_month', i.billing_month,
      'issue_date', i.issue_date,
      'due_date', i.due_date,
      'status', i.status,
      'subtotal', i.subtotal,
      'discount_amount', i.discount_amount,
      'total_amount', i.total_amount,
      'paid_amount', i.paid_amount,
      'remaining_amount', i.remaining_amount,
      'previous_debt', i.previous_debt,
      'items', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', it.id,
          'type', it.type,
          'description', it.description,
          'unit_price', it.unit_price,
          'quantity', it.quantity,
          'coefficient', it.coefficient,
          'amount', it.amount,
          'previous_reading', it.previous_reading,
          'current_reading', it.current_reading,
          'from_date', it.from_date,
          'to_date', it.to_date
        ) ORDER BY it.sort_order NULLS LAST, it.created_at)
        FROM public.invoice_items it
        WHERE it.invoice_id = i.id
      ), '[]'::jsonb)
    ),
    'room', CASE WHEN r.id IS NOT NULL
      THEN jsonb_build_object('id', r.id, 'name', r.name, 'code', r.code)
      ELSE NULL END,
    'building', CASE WHEN b.id IS NOT NULL
      THEN jsonb_build_object('id', b.id, 'name', b.name)
      ELSE NULL END,
    'bed', NULL,
    -- SỐ ĐIỆN THOẠI ĐÃ BỎ — xem chú thích ở nhánh trên.
    'customer', CASE WHEN c.full_name IS NOT NULL
      THEN jsonb_build_object('full_name', c.full_name)
      ELSE NULL END
  )
  INTO v_result
  FROM public.invoices i
  LEFT JOIN public.rooms r ON r.id = i.room_id
  LEFT JOIN public.buildings b ON b.id = i.building_id
  LEFT JOIN LATERAL (
    SELECT cust.full_name
    FROM public.contract_customers cc
    JOIN public.customers cust ON cust.id = cc.customer_id
    WHERE cc.contract_id = i.contract_id
    ORDER BY cc.is_representative DESC NULLS LAST
    LIMIT 1
  ) c ON TRUE
  WHERE i.id = v_invoice_id;

  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — đo bằng DỮ LIỆU THẬT đi qua đúng cửa mà anon dùng, chứ không đọc
-- thân hàm. Đọc thân hàm chỉ chứng minh chuỗi ký tự đã đổi, không chứng minh
-- payload đã đổi.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_ma      text;
  v_payload jsonb;
  v_n       bigint;
  v_co_ten  bigint := 0;
BEGIN
  -- Quét mọi hợp đồng đang sống: không dòng nào được còn khoá 'phone'.
  v_n := 0;
  FOR v_ma IN
    SELECT public_code FROM public.contracts
     WHERE deleted_at IS NULL AND public_code IS NOT NULL
  LOOP
    v_payload := public.get_public_latest_invoice_by_code(v_ma);
    CONTINUE WHEN v_payload IS NULL;
    IF v_payload -> 'customer' ? 'phone' THEN
      v_n := v_n + 1;
    END IF;
    IF v_payload -> 'customer' ? 'full_name' THEN
      v_co_ten := v_co_ten + 1;
    END IF;
  END LOOP;

  IF v_n > 0 THEN
    RAISE EXCEPTION '% payload công khai vẫn còn khoá phone. DỪNG.', v_n;
  END IF;

  -- Chốt chống-mù: nếu KHÔNG payload nào có full_name thì phép quét trên không
  -- chứng minh được gì — có thể nó chỉ đang duyệt qua toàn NULL.
  IF v_co_ten = 0 THEN
    RAISE EXCEPTION 'Không payload nào có full_name — phép nghiệm thu đang MÙ chứ không phải sạch. DỪNG.';
  END IF;

  RAISE NOTICE 'Đã quét payload công khai của mọi hợp đồng sống: 0 khoá phone, % payload có full_name.', v_co_ten;
END
$nghiem_thu$;

COMMIT;

-- =============================================================================
-- ROLLBACK: file này chỉ đổi thân hàm. Muốn lùi thì CREATE OR REPLACE lại bản cũ
-- — bản cũ nằm trong git tại commit trước file này, và trong bản dump mà lane tự
-- chụp ngay trước lúc apply.
-- =============================================================================
