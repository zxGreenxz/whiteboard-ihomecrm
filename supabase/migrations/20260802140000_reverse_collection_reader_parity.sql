-- ĐỢT A (vá tiếp) — READER TRANG THU TIỀN PHẢI NÓI CÙNG LUẬT VỚI WRITER
--
-- 20260802100000 đã bỏ 3 gate khỏi writer `reverse_invoice_collection_v5`
-- (quyền thu_tien.undo cấp tổ chức, cấp từng tender, và "sổ được nhìn") và ép
-- huỷ tại chỗ, theo quyết định của chủ: huỷ khoản thu chỉ cần CHÍNH NGƯỜI ĐÃ
-- THU (∨ chủ tổ chức ∨ super admin).
--
-- Nhưng reader `can_reverse_collection_v1` — thứ trang Thu tiền dùng để bày/mờ
-- nút Hoàn tác (src/hooks/useDeletePayment.ts) — KHÔNG được vá cùng lúc. Hậu
-- quả đo được trên prod: người ĐÃ THU nhưng thiếu quyền thu_tien.undo, hoặc
-- không "nhìn được" sổ quỹ nguồn, sẽ thấy nút MỜ kèm lý do "không có quyền",
-- trong khi server hoàn toàn cho phép họ bấm. Đúng cái bệnh mà cả đợt này đi
-- chữa: người dùng bị chặn ở giao diện chứ không phải ở nghiệp vụ.
--
-- Thêm một lệch nữa: reader vẫn suy `mode` theo ie_flex_mode_enabled_v1, nên
-- với tổ chức bật Chuẩn kế toán nó báo COUNTER_VOUCHER trong khi writer nay
-- luôn huỷ tại chỗ — giao diện hứa sai việc sắp xảy ra.
--
-- Vá cả ba cho khớp writer. GIỮ NGUYÊN: luật "chỉ chính người đã thu"
-- (NOT_COLLECTOR), LIFO, credit đã tiêu, ba khoá kỳ, và việc bỏ qua im lặng
-- collection của tổ chức khác.

BEGIN;

DO $patch$
DECLARE
  v_def text;
  v_before text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'can_reverse_collection_v1';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ĐỢT A: can_reverse_collection_v1 không tồn tại';
  END IF;
  IF v_def LIKE '%ĐỢT A: reader nói cùng luật với writer%' THEN
    RETURN; -- đã vá
  END IF;

  -- (a) Gate quyền cấp toà.
  v_before := v_def;
  v_def := replace(v_def,
$old$    -- QUYỀN: y hệt writer — thu_tien.undo ở cấp toà, rồi ở TỪNG sổ quỹ nguồn.
    SELECT allowed INTO v_ok FROM app_private.authorize_tenant_action_v3(
      auth.uid(), v_org, 'thu_tien.undo', v_inv.building_id, NULL);
    IF NOT COALESCE(v_ok, false) THEN
      collection_id := v_id; mode := 'BLOCKED'; reason_code := 'NO_PERMISSION';
      RETURN NEXT; CONTINUE;
    END IF;$old$,
$new$    -- ĐỢT A: reader nói cùng luật với writer (01/08/2026). Writer đã bỏ hẳn
    -- gate thu_tien.undo; điều kiện duy nhất còn lại là CHÍNH NGƯỜI ĐÃ THU
    -- (∨ chủ tổ chức ∨ super admin), kiểm ngay dưới đây.$new$);
  IF v_def = v_before THEN
    RAISE EXCEPTION 'ĐỢT A: mất neo (a) gate quyền cấp toà trong reader';
  END IF;

  -- (b) Gate quyền theo từng tender + "sổ được nhìn".
  v_before := v_def;
  v_def := replace(v_def,
$old$    IF EXISTS (
      SELECT 1 FROM public.invoice_payment_tenders t
      LEFT JOIN public.income_expenses tender_voucher ON tender_voucher.id = t.voucher_id
      WHERE t.collection_id = v_id AND t.voucher_id IS NOT NULL
        AND (
          NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
                auth.uid(), v_org, 'thu_tien.undo',
                COALESCE(tender_voucher.building_id, v_inv.building_id), t.account_id)), false)
          OR (NOT v_book_bypass AND NOT EXISTS (
                SELECT 1 FROM app_private.ie_visible_cashbook_ids_v1() visible_book
                 WHERE visible_book.cashbook_id = t.account_id))
        )
    ) THEN
      collection_id := v_id; mode := 'BLOCKED'; reason_code := 'NO_PERMISSION';
      RETURN NEXT; CONTINUE;
    END IF;$old$,
$new$    -- ĐỢT A: bỏ gate quyền/sổ-được-nhìn theo từng tender, khớp writer.$new$);
  IF v_def = v_before THEN
    RAISE EXCEPTION 'ĐỢT A: mất neo (b) gate theo tender trong reader';
  END IF;

  -- (c) mode phải nói đúng việc sắp xảy ra: writer nay LUÔN huỷ tại chỗ.
  v_before := v_def;
  v_def := replace(v_def,
$old$    ELSIF app_private.ie_flex_mode_enabled_v1(v_org) THEN
      mode := 'IN_PLACE_CANCEL'; reason_code := NULL;
    ELSE
      mode := 'COUNTER_VOUCHER'; reason_code := NULL;
    END IF;$old$,
$new$    ELSE
      -- ĐỢT A: writer đã bỏ rẽ nhánh Chuẩn kế toán cho phiếu thu — luôn huỷ
      -- tại chỗ, không sinh phiếu đối ứng. Reader phải nói đúng như vậy.
      mode := 'IN_PLACE_CANCEL'; reason_code := NULL;
    END IF;$new$);
  IF v_def = v_before THEN
    RAISE EXCEPTION 'ĐỢT A: mất neo (c) suy mode theo chế độ kế toán trong reader';
  END IF;

  EXECUTE v_def;
END
$patch$;

COMMIT;

NOTIFY pgrst, 'reload schema';
