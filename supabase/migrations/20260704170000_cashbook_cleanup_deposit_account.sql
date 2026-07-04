-- =====================================================================
-- Tinh gọn sổ quỹ (audit 04/07, chủ duyệt):
--
-- 1) Sổ "CỌC (giữ hộ khách)" THỨ HAI (TK000058, của NATHAN) — sinh ra vì
--    get_or_create_deposit_account() get-or-create PER-USER: chuyển phiếu
--    cọc duy nhất (PT2606057, 1,5tr G04-1392QT) về sổ tiền mặt của Nathan
--    (Hiệp Thu) rồi soft-delete sổ thừa.
-- 2) get_or_create_deposit_account() KHÔNG BAO GIỜ tạo sổ mới nữa
--    (mô hình 04/07: tiền cọc = tiền thật vào sổ %Thu của người thu; sổ
--    CỌC ảo của chủ đã đóng). Fallback: %Thu default → %Thu bất kỳ →
--    is_default bất kỳ → sổ thật đầu tiên của user → RAISE rõ ràng.
--    3 caller FE (ContractFormDialog / CreateDepositDialog /
--    QuickDepositModal) giữ nguyên — chỉ đổi hành vi RPC.
--
-- Lưu ý: 25 sổ rác thời setup (sổ tên toà, TK1-3, TT1-3, Quỹ Test…) đã
-- soft-delete từ trước — không cần xử lý thêm.
-- =====================================================================

DO $$
DECLARE
  v_dup   uuid;  -- sổ CỌC thừa của Nathan
  v_hthu  uuid;  -- Hiệp Thu (sổ tiền mặt Nathan)
BEGIN
  SELECT id INTO v_dup  FROM accounts WHERE code = 'TK000058' AND deleted_at IS NULL;
  SELECT id INTO v_hthu FROM accounts WHERE code = 'TK000032' AND deleted_at IS NULL;

  IF v_dup IS NOT NULL AND v_hthu IS NOT NULL THEN
    UPDATE income_expenses
       SET account_id = v_hthu,
           notes = COALESCE(notes || E'\n', '') ||
             '[04/07/2026] Chuyển từ sổ "CỌC (giữ hộ khách)" (TK000058 — sổ trùng do hệ tự sinh) về Hiệp Thu theo audit tinh gọn sổ quỹ.'
     WHERE account_id = v_dup;

    UPDATE income_expenses SET change_account_id = v_hthu WHERE change_account_id = v_dup;

    -- Soft-delete (cơ chế ẩn sẵn có của accounts) — không hard-delete.
    UPDATE accounts SET deleted_at = now() WHERE id = v_dup;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- get_or_create_deposit_account v2: chỉ TÌM, không TẠO.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_or_create_deposit_account()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acc uuid;
BEGIN
  -- 1. Sổ "%Thu" mặc định của chính người gọi.
  SELECT id INTO v_acc FROM accounts
  WHERE user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual
    AND name ILIKE '%thu' AND is_default
  ORDER BY created_at LIMIT 1;
  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;

  -- 2. Sổ "%Thu" bất kỳ của người gọi.
  SELECT id INTO v_acc FROM accounts
  WHERE user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual
    AND name ILIKE '%thu'
  ORDER BY created_at LIMIT 1;
  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;

  -- 3. Sổ mặc định bất kỳ của người gọi.
  SELECT id INTO v_acc FROM accounts
  WHERE user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual
    AND is_default
  ORDER BY created_at LIMIT 1;
  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;

  -- 4. Sổ thật đầu tiên của người gọi.
  SELECT id INTO v_acc FROM accounts
  WHERE user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual
  ORDER BY created_at LIMIT 1;
  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;

  RAISE EXCEPTION 'Bạn chưa có sổ quỹ nào — tạo sổ "%% Thu" trong Tài chính → Sổ quỹ trước khi thu cọc';
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_create_deposit_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_or_create_deposit_account() TO authenticated, service_role;
