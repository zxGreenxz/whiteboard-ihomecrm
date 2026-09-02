-- =============================================================================
-- FR002-C01 (P1) — re-anchor bảo mật 02/09/2026: transfer_contract_impl gắn được
-- customer của TỔ CHỨC KHÁC vào hợp đồng (chỉ kiểm `EXISTS customers WHERE id`).
--
-- Vá: CREATE OR REPLACE cùng chữ ký (không overload): khoá org của hợp đồng
-- (lock_org_for_decision_v1) → đọc lại HĐ FOR UPDATE → khách mới phải chưa xoá
-- VÀ cùng organization_id với HĐ, lệch → 42501. Phần còn lại giữ nguyên bản
-- 20260728170000_b8_contract_transfer_audit_customers. Wrapper transfer_contract
-- vẫn gate quyền theo toà; guard này nằm ở _impl nên phủ mọi đường gọi.
-- Ca hợp lệ (cùng org) không đổi hành vi.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.transfer_contract_impl(p_contract_id uuid, p_new_customer_id uuid, p_new_rent_price numeric DEFAULT NULL::numeric, p_new_deposit numeric DEFAULT NULL::numeric, p_transfer_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_contract     RECORD;
  v_existing     uuid;
  v_old_customer uuid;
  v_org          uuid;
  v_customer_org uuid;
BEGIN
  SELECT organization_id INTO v_org
    FROM contracts
   WHERE id = p_contract_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;

  -- Khoá org trước khi quyết định (chống TOCTOU giữa đọc và ghi).
  PERFORM app_private.lock_org_for_decision_v1(v_org);

  SELECT * INTO v_contract
    FROM contracts
   WHERE id = p_contract_id
     AND deleted_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;

  IF v_contract.status NOT IN ('ACTIVE','EXTENDED') THEN
    RAISE EXCEPTION 'Chỉ nhượng được khi hợp đồng đang hiệu lực';
  END IF;

  IF p_new_customer_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu khách hàng mới';
  END IF;

  -- Báo lỗi tiếng Việt thay vì để FK 23503 thô nổ ở cuối hàm.
  SELECT organization_id INTO v_customer_org
    FROM customers
   WHERE id = p_new_customer_id
     AND deleted_at IS NULL
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Khách hàng mới không tồn tại';
  END IF;

  -- FR002-C01: khách mới PHẢI cùng tổ chức với hợp đồng.
  IF v_customer_org IS DISTINCT FROM v_contract.organization_id THEN
    RAISE EXCEPTION 'Khách hàng mới thuộc tổ chức khác — không nhượng được hợp đồng cho khách ngoài công ty'
      USING ERRCODE = '42501';
  END IF;

  -- (a) CHỐT bên nhượng TRƯỚC khi hạ đại diện. Đọc sau lệnh UPDATE bên dưới
  --     sẽ luôn ra NULL (không còn ai is_representative) hoặc mới->mới.
  SELECT cc.customer_id INTO v_old_customer
    FROM contract_customers cc
   WHERE cc.contract_id = p_contract_id
     AND cc.is_representative
   LIMIT 1;

  -- Demote everyone, promote/insert the new representative.
  UPDATE contract_customers
     SET is_representative = false,
         updated_at = NOW()
   WHERE contract_id = p_contract_id;

  SELECT id INTO v_existing
    FROM contract_customers
   WHERE contract_id = p_contract_id
     AND customer_id = p_new_customer_id
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    UPDATE contract_customers
       SET is_representative = true,
           updated_at = NOW()
     WHERE id = v_existing;
  ELSE
    INSERT INTO contract_customers (contract_id, customer_id, is_representative, notes)
    VALUES (p_contract_id, p_new_customer_id, true,
            CASE WHEN p_notes IS NULL OR length(btrim(p_notes))=0 THEN NULL
                 ELSE '[Nhượng HĐ] ' || p_notes
            END);
  END IF;

  -- Giá / cọc / ghi chú trên HĐ (KHÔNG đụng deposit_paid; KHÔNG nêu tên
  -- deposit_remaining vì là cột GENERATED -> 428C9).
  UPDATE contracts
     SET rent_price    = COALESCE(p_new_rent_price, rent_price),
         total_deposit = COALESCE(p_new_deposit,    total_deposit),
         notes         = CASE
                           WHEN p_notes IS NULL OR length(btrim(p_notes))=0 THEN notes
                           WHEN notes  IS NULL OR length(btrim(notes)) = 0 THEN p_notes
                           ELSE notes || E'\n[Nhượng HĐ ' || to_char(p_transfer_date,'DD/MM/YYYY') || '] ' || p_notes
                         END,
         updated_at    = NOW()
   WHERE id = p_contract_id;

  -- (b)(c)(d) Audit row — KHÔNG còn EXCEPTION WHEN OTHERS THEN NULL.
  INSERT INTO contract_transfers (
    user_id, contract_id, transfer_type, transfer_date,
    old_tenant_id, new_tenant_id,
    new_rent_price, new_deposit,
    reason, status, approved_at
  ) VALUES (
    COALESCE(auth.uid(), v_contract.user_id),
    p_contract_id, 'TENANT_CHANGE', p_transfer_date,
    v_old_customer, p_new_customer_id,
    p_new_rent_price, p_new_deposit,
    p_notes, 'COMPLETED', NOW()
  );

  RETURN p_contract_id;
END;
$$;

-- Nghiệm thu: thân hàm đang cài phải có guard org + khoá org.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'transfer_contract_impl';
  IF v_src IS NULL OR v_src NOT LIKE '%lock_org_for_decision_v1%'
     OR v_src NOT LIKE '%v_customer_org IS DISTINCT FROM v_contract.organization_id%' THEN
    RAISE EXCEPTION 'transfer_contract_impl chưa có guard org. DỪNG.';
  END IF;
END $$;
