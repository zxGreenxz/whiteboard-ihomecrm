-- =============================================================================
-- soft_delete_customer: CHẶN xoá khách hàng đang có hợp đồng hiệu lực.
--
-- VÌ SAO (finding C-03, docs/audits/AUDIT-DB-BANG-MO-COI-VA-PHAN-CHUA-HOAT-DONG-2026-09-02.md):
--   Đường xoá khách thật trên UI là useDeleteCustomer → RPC này, và RPC chỉ
--   UPDATE deleted_at, không nhìn hợp đồng. Xoá mềm một khách đang có HĐ ACTIVE
--   làm hoá đơn/thu tiền/thanh lý của HĐ đó mồ côi người — sổ vẫn cộng, giao diện
--   không còn ai để hiện. Guard đặt ở DB vì client có thể bị vòng qua (PostgREST
--   gọi thẳng RPC), và vì hai đường client (useDeleteCustomer, useDeleteTenant
--   legacy) không được là hàng rào duy nhất.
--
-- LUẬT "đang hiệu lực": chỉ status = 'ACTIVE' (src/types/contract.ts
--   ACTIVE_CONTRACT_STATUSES) và deleted_at IS NULL. Liên kết khách ↔ HĐ đi qua
--   contract_customers (HĐ mới) — contracts.tenant_id là đường legacy trỏ bảng
--   tenants, không phải customers, nên không xét ở đây.
--
-- Giữ nguyên chữ ký (uuid) → CREATE OR REPLACE, không sinh overload; giữ nguyên
--   SECURITY DEFINER + search_path + phần UPDATE/quyền như bản 20260514000005.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.soft_delete_customer(p_customer_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_active_contracts integer;
BEGIN
  SELECT count(*) INTO v_active_contracts
    FROM public.contract_customers cc
    JOIN public.contracts c ON c.id = cc.contract_id
   WHERE cc.customer_id = p_customer_id
     AND c.status = 'ACTIVE'
     AND c.deleted_at IS NULL;

  IF v_active_contracts > 0 THEN
    RAISE EXCEPTION 'CUSTOMER_HAS_ACTIVE_CONTRACT'
      USING ERRCODE = 'check_violation',
            DETAIL = format('Khách hàng %s đang có %s hợp đồng hiệu lực', p_customer_id, v_active_contracts),
            HINT = 'Thanh lý hoặc kết thúc hợp đồng trước khi xoá khách hàng.';
  END IF;

  UPDATE customers
  SET deleted_at = NOW()
  WHERE id = p_customer_id
    AND (user_id = auth.uid() OR public.is_super_admin())
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found or not authorized';
  END IF;
END;
$$;

-- Nghiệm thu: guard phải nằm trong thân hàm đang cài, sai là DỪNG cả file.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'soft_delete_customer'
      AND p.prosrc LIKE '%CUSTOMER_HAS_ACTIVE_CONTRACT%'
      AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'soft_delete_customer chưa có guard hợp đồng hiệu lực. DỪNG.';
  END IF;
END $$;
