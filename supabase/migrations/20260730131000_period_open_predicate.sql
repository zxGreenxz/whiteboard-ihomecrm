-- =====================================================================
-- Đợt 3 (phần 2) — Vị ngữ "kỳ còn mở" dùng chung
--
-- Đây là TRÁI TIM của quyết định #5 của chủ: "cho huỷ tại chỗ, nhưng tháng nào
-- đã chốt lợi nhuận / đã bàn giao / đã chốt sổ quỹ thì khoá, ghi rõ lý do báo
-- cho user biết khi không huỷ được".
--
-- Ba trigger ở migration trước đã CHẶN ở tầng dữ liệu, nhưng chúng chỉ biết
-- chuyện sổ quỹ và chỉ nói được một câu chung. Hàm này chạy TRƯỚC trong các
-- writer linh hoạt (Đợt 4/5) để:
--   * bắt thêm hai kỳ mà trigger sổ quỹ không nhìn thấy: THÁNG LỢI NHUẬN đã
--     chốt (đã chia cho cổ đông) và PHIÊN BÀN GIAO đang sống;
--   * trả về đúng LÝ DO để giao diện nói được người dùng nghe hiểu, thay vì
--     ném một mã lỗi Postgres.
--
-- 05/2026, 06/2026 và 07/2026 hiện đã khoá lợi nhuận và đã chia 230.624.676đ
-- cho cổ đông — đây chính là hàng rào giữ cho số đã chia không lệch sổ.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION app_private.assert_period_open_for_edit_v1(
  p_voucher uuid,
  p_action text DEFAULT 'sửa'
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_row public.income_expenses%ROWTYPE;
  v_acct uuid;
  v_lock date;
  v_name text;
  v_handover text;
  v_month date;
BEGIN
  SELECT * INTO v_row FROM public.income_expenses WHERE id = p_voucher;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;

  -- 1) SỔ QUỸ ĐÃ CHỐT & BÀN GIAO. Xét cả sổ chính, sổ thối và sổ làm tròn vì
  --    tồn quỹ cộng theo account của từng dòng bút toán.
  FOREACH v_acct IN ARRAY ARRAY[v_row.account_id, v_row.change_account_id, v_row.rounding_account_id] LOOP
    CONTINUE WHEN v_acct IS NULL;
    v_lock := app_private.cashbook_closed_through_v1(v_acct);
    IF v_lock IS NOT NULL AND v_row.voucher_date <= v_lock THEN
      SELECT a.name INTO v_name FROM public.accounts a WHERE a.id = v_acct;
      RAISE EXCEPTION
        '[CASHBOOK_CLOSED] Sổ quỹ "%" đã chốt & bàn giao tới ngày % — phiếu trong kỳ này không % được nữa. Muốn điều chỉnh, hãy lập phiếu mới ở kỳ hiện tại.',
        COALESCE(v_name, 'không rõ'), to_char(v_lock, 'DD/MM/YYYY'), p_action
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 2) PHIÊN BÀN GIAO TIỀN MẶT còn sống. Trigger ie_handover_guard cũng chặn,
  --    nhưng nó chỉ nói "[HANDOVER_LOCKED]" — ở đây nêu rõ mã phiên để người
  --    dùng biết phải huỷ phiên nào.
  IF v_row.handover_id IS NOT NULL THEN
    SELECT h.code INTO v_handover
    FROM public.cash_handovers h
    WHERE h.id = v_row.handover_id AND h.status <> 'CANCELLED';
    IF v_handover IS NOT NULL THEN
      RAISE EXCEPTION
        '[HANDOVER_LOCKED] Phiếu nằm trong phiên bàn giao % đã xác nhận — muốn % thì phải huỷ phiên đó trước (cần cả hai bên đồng ý).',
        v_handover, p_action
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 3) THÁNG LỢI NHUẬN ĐÃ CHỐT. Bỏ qua phiếu cố ý nằm ngoài KQKD (điều chỉnh
  --    số dư, chuyển nội bộ, cấn cọc…) vì chúng không góp vào con số đã chia.
  IF COALESCE(v_row.business_result_accounting, true) THEN
    v_month := date_trunc('month', v_row.voucher_date)::date;
    IF EXISTS (
      SELECT 1 FROM public.profit_monthly pm
      WHERE pm.building_id = v_row.building_id
        AND pm.period_month = v_month
        AND pm.locked_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION
        '[PROFIT_LOCKED] Lợi nhuận tháng % của toà này đã chốt và đã chia cho cổ đông — không % phiếu của tháng đó. Hãy lập phiếu điều chỉnh ở tháng hiện tại.',
        to_char(v_month, 'MM/YYYY'), p_action
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION app_private.assert_period_open_for_edit_v1(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.assert_period_open_for_edit_v1(uuid, text) IS
  'Kỳ của phiếu có còn mở để đụng vào tiền không? Ném lỗi có tiền tố [CASHBOOK_CLOSED] / [HANDOVER_LOCKED] / [PROFIT_LOCKED] để giao diện dịch sang câu người dùng hiểu được.';

-- Bản đọc cho giao diện: hỏi TRƯỚC khi bày nút, không phải bấm rồi mới báo lỗi.
--
-- CỐ Ý chỉ trả về MÃ lý do, không trả nguyên văn thông báo: hàm là SECURITY
-- DEFINER nên đi vòng qua RLS, mà thông báo đầy đủ có kèm TÊN SỔ QUỸ và ngày
-- chốt — đủ để dò thông tin sổ của người khác. Giao diện tự dịch mã sang câu
-- tiếng Việt; nguyên văn chỉ hiện khi người dùng thật sự bấm hành động và
-- writer từ chối (lúc đó họ chứng minh được là có quyền).
CREATE OR REPLACE FUNCTION public.check_voucher_period_open_v1(p_ids uuid[])
RETURNS TABLE(id uuid, is_open boolean, reason_code text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_id uuid;
  v_org uuid;
  v_msg text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  FOREACH v_id IN ARRAY COALESCE(p_ids, ARRAY[]::uuid[]) LOOP
    SELECT ie.organization_id INTO v_org FROM public.income_expenses ie WHERE ie.id = v_id;
    CONTINUE WHEN v_org IS NULL;

    -- Chỉ trả lời về phiếu trong tổ chức mà người gọi đang là thành viên.
    IF NOT public.is_super_admin() AND NOT EXISTS (
      SELECT 1 FROM public.organization_memberships m
       WHERE m.user_id = auth.uid() AND m.organization_id = v_org AND m.status = 'ACTIVE'
    ) THEN
      CONTINUE;
    END IF;

    BEGIN
      PERFORM app_private.assert_period_open_for_edit_v1(v_id, 'sửa');
      id := v_id; is_open := true; reason_code := NULL; RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      v_msg := SQLERRM;
      id := v_id;
      is_open := false;
      reason_code := CASE
        WHEN v_msg LIKE '%CASHBOOK_CLOSED%'  THEN 'CASHBOOK_CLOSED'
        WHEN v_msg LIKE '%HANDOVER_LOCKED%'  THEN 'HANDOVER_LOCKED'
        WHEN v_msg LIKE '%PROFIT_LOCKED%'    THEN 'PROFIT_LOCKED'
        ELSE 'UNKNOWN'
      END;
      RETURN NEXT;
    END;
  END LOOP;
END
$fn$;

REVOKE ALL ON FUNCTION public.check_voucher_period_open_v1(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.check_voucher_period_open_v1(uuid[]) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
