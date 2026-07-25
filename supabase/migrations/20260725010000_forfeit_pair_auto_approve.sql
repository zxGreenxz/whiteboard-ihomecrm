-- Thanh lý BỎ CỌC (hướng A) — cặp bút toán nội bộ TỰ DUYỆT ngay khi tạo.
--
-- BỐI CẢNH (đo thật 25/07 trên PROD)
--   terminate_contract_forfeit_impl tạo 2 chân nội bộ trên sổ ẢO "Cấn trừ thanh lý"
--   ở trạng thái UNAPPROVED — cố ý từ phiên bản đầu (18/06) tới nay. Nhưng bước
--   duyệt tay đó CHƯA BAO GIỜ được dùng: 0/6 cặp từng được duyệt. Hệ quả: 4 hoá
--   đơn thanh lý treo OVERDUE (18,8 tr) dù khách đã mất cọc, doanh thu bỏ cọc
--   không vào KQKD, và phiếu nằm trong danh sách chờ duyệt của màn Thu chi nên
--   được chào nút "Duyệt và Thu" trỏ vào SỔ QUỸ THẬT (sai bản chất).
--
--   Owner chọn hướng A: bỏ bước duyệt tay. Chính hành động "thanh lý do bỏ cọc"
--   đã là quyết định mất cọc — không cần xác nhận lần hai.
--
-- FIX (migration này — CHỈ đổi writer, KHÔNG đụng dữ liệu cũ)
--   (1) Đóng dấu bản chất: posting_mode='NON_CASH', posting_status='NOT_APPLICABLE',
--       review_state='RESOLVED' — hết lọt vào luồng tiền thật của Finance V2.
--   (2) Tự duyệt: PHẢI tạo UNAPPROVED trước rồi mới UPDATE → APPROVED, vì
--       - registrar a05_register_termination_forfeit (AFTER INSERT) chỉ chấp nhận
--         hình dạng UNAPPROVED và chính nó lập termination_forfeit_authorizations;
--       - cascade trg_forfeit_settle_on_approve chạy AFTER UPDATE, là nơi duyệt
--         chân đối ứng + tạo payment tất toán hoá đơn thanh lý.
--       Tạo thẳng APPROVED sẽ vỡ registrar VÀ bỏ qua cascade → hoá đơn treo tiếp.
--   (3) Token per-xid cho CẢ HAI chân: guard a05 đòi ie_transition_authorization
--       khi approval_status đổi (chân đối ứng do cascade đổi → cần token riêng).
--
-- KHÔNG đụng sổ quỹ: cả 2 chân trên sổ ảo; bridge a85/a85b bỏ qua is_virtual.
-- Dữ liệu cũ (4 cặp đang chờ) xử lý ở migration sau, tách để soi riêng.

BEGIN;

DO $patch$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'terminate_contract_forfeit_impl';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'forfeit auto-approve: terminate_contract_forfeit_impl không tồn tại';
  END IF;
  IF v_def LIKE '%7af: cặp bút toán nội bộ TỰ DUYỆT%' THEN
    RAISE NOTICE 'forfeit auto-approve: đã vá trước đó — bỏ qua';
    RETURN;
  END IF;

  v_def := replace(v_def,
$anchor$    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_thu_id, v_type_inc, 'Doanh thu bỏ cọc (cọc khách bỏ)', 1, v_deposit, p_forfeit_date, p_forfeit_date);
  END IF;$anchor$,
$patched$    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_thu_id, v_type_inc, 'Doanh thu bỏ cọc (cọc khách bỏ)', 1, v_deposit, p_forfeit_date, p_forfeit_date);

    -- 7af: cặp bút toán nội bộ TỰ DUYỆT ngay trong writer (hướng A).
    -- Đóng dấu bản chất trước — Finance V2 hết coi đây là phiếu tiền thật.
    UPDATE public.income_expenses
       SET posting_mode   = 'NON_CASH',
           posting_status = 'NOT_APPLICABLE',
           review_state   = 'RESOLVED'
     WHERE id IN (v_chi_id, v_thu_id);

    -- Token cho CẢ HAI chân: chân doanh thu do lệnh dưới đổi, chân đối ứng do
    -- cascade trg_forfeit_settle_on_approve đổi — guard a05 đòi token từng phiếu.
    INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
    VALUES (v_thu_id, pg_current_xact_id(), 'APPROVED'),
           (v_chi_id, pg_current_xact_id(), 'APPROVED');

    -- Duyệt chân doanh thu → cascade duyệt chân đối ứng + tất toán hoá đơn.
    UPDATE public.income_expenses
       SET approval_status = 'APPROVED',
           approved_by     = COALESCE(auth.uid(), v_contract.user_id),
           approved_at     = now()
     WHERE id = v_thu_id;

    DELETE FROM app_private.ie_transition_authorization
     WHERE income_expense_id IN (v_thu_id, v_chi_id)
       AND xid = pg_current_xact_id();
  END IF;$patched$);

  IF v_def NOT LIKE '%7af: cặp bút toán nội bộ TỰ DUYỆT%' THEN
    RAISE EXCEPTION 'forfeit auto-approve: KHÔNG khớp anchor tạo phiếu — kiểm tra thủ công';
  END IF;

  -- Ghi chú trên phiếu phải nói đúng sự thật mới (hết "chờ duyệt").
  v_def := replace(v_def,
    'cọc khách bỏ chuyển thành doanh thu (chờ duyệt; không phải tiền thật).',
    'cọc khách bỏ chuyển thành doanh thu (tự duyệt; không phải tiền thật — không vào sổ quỹ).');
  v_def := replace(v_def,
    'doanh thu bỏ cọc (chờ duyệt → tất toán hoá đơn thanh lý; KQKD đếm theo hạng mục).',
    'doanh thu bỏ cọc (tự duyệt → tất toán hoá đơn thanh lý; KQKD đếm theo hạng mục).');
  v_def := replace(v_def,
    '-- Cặp bút toán nội bộ CHỜ DUYỆT — CẢ 2 CHÂN trên sổ nội bộ (net 0).',
    '-- Cặp bút toán nội bộ TỰ DUYỆT — CẢ 2 CHÂN trên sổ nội bộ (net 0).');

  EXECUTE v_def;
END
$patch$;

COMMIT;

NOTIFY pgrst, 'reload schema';
