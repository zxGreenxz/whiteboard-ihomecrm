-- =====================================================================
-- SIẾT LẠI TOÀN PLAN — đợt 2: vị ngữ ĐỌC phải nói đúng sự thật của WRITER
--
-- Ma trận phân quyền bới ra một mẫu lỗi lặp lại ở cả Đợt 4 lẫn Đợt 5: hàm ĐỌC
-- (dùng để bày/ẩn nút) kiểm ÍT điều kiện hơn hàm GHI. Hệ quả không phải lỗ
-- bảo mật — writer vẫn chặn đúng — mà là giao diện NÓI DỐI: bày nút cho việc
-- server sẽ từ chối, rồi ném thông điệp thô vào mặt người dùng.
-- =====================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. [ĐỢT 5, LỖI CỦA CHÍNH BẢN VÁ] Kiểm khoá kỳ phải áp dụng cho CẢ HAI chế độ
--
-- Bản Đợt 5 đặt vòng kiểm "kỳ còn mở" BÊN TRONG nhánh `IF v_in_place`, nên tổ
-- chức ở chế độ CHUẨN KẾ TOÁN đi thẳng xuống đường sinh phiếu đối ứng mà không
-- kiểm gì. Đo thật trên prod: hoàn tác được khoản thu của tháng lợi nhuận ĐÃ
-- CHỐT và đẻ phiếu chi 2.655.000 rơi thẳng vào chính tháng đó.
--
-- Quyết định #5 của chủ nói về KỲ, không nói về chế độ: "kỳ đã chốt LN / đã bàn
-- giao / đã chốt sổ thì khoá, báo rõ lý do". Chế độ chỉ quyết định HÌNH THỨC
-- huỷ (tại chỗ hay phiếu đối ứng), không quyết định có được đụng vào kỳ đã đóng
-- hay không. Hôm nay cả hai org đều LINH HOẠT nên nhánh này chưa với tới được,
-- nhưng bật lại Chuẩn kế toán là lỗ mở ra ngay.
-- ─────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_def text;
  v_open text :=
    '  IF v_in_place THEN' || chr(10) ||
    '    SELECT m.id INTO v_membership FROM public.organization_memberships m';
  v_close text :=
    '    END LOOP;' || chr(10) ||
    '  END IF;' || chr(10) || chr(10) ||
    '  -- Đường CŨ cần hạng mục';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reverse_invoice_collection_v5';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Không có reverse_invoice_collection_v5'; END IF;

  IF position('KIỂM KỲ CHO CẢ HAI CHẾ ĐỘ' IN v_def) > 0 THEN
    RAISE NOTICE 'reverse_invoice_collection_v5 đã vá kiểm-kỳ-hai-chế-độ — bỏ qua';
    RETURN;
  END IF;
  IF position(v_open IN v_def) = 0 OR position(v_close IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo nhánh kiểm kỳ — DỪNG, không vá mù';
  END IF;

  -- Gỡ `IF v_in_place THEN` mở đầu…
  v_def := replace(v_def, v_open,
    '  -- KIỂM KỲ CHO CẢ HAI CHẾ ĐỘ: kỳ đã đóng thì KHÔNG đường nào được đụng,' || chr(10) ||
    '  -- kể cả đường sinh phiếu đối ứng của chế độ Chuẩn kế toán.' || chr(10) ||
    '  SELECT m.id INTO v_membership FROM public.organization_memberships m');
  -- …và `END IF;` đóng tương ứng.
  v_def := replace(v_def, v_close,
    '    END LOOP;' || chr(10) || chr(10) ||
    '  -- Đường CŨ cần hạng mục');

  IF position('KIỂM KỲ CHO CẢ HAI CHẾ ĐỘ' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vá kiểm-kỳ-hai-chế-độ thất bại';
  END IF;
  EXECUTE v_def;
  RAISE NOTICE 'reverse_invoice_collection_v5: kiểm khoá kỳ giờ áp dụng cho CẢ HAI chế độ';
END
$patch$;

-- ─────────────────────────────────────────────────────────────────────
-- 2. can_reverse_collection_v1 phải nói CÙNG câu chuyện với writer
--
-- Bản cũ chỉ kiểm: là thành viên · chế độ · trạng thái collection · khoá kỳ.
-- Nó BỎ QUA thu_tien.undo, LIFO và guard credit — ba thứ writer chặn thẳng. Đo
-- thật: JOEY (không có thu_tien.undo trên toà 1392QT) vẫn được bảo "hoàn tác
-- được".
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.can_reverse_collection_v1(p_collection_ids uuid[])
RETURNS TABLE(collection_id uuid, mode text, reason_code text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_id uuid;
  v_org uuid;
  v_status text;
  v_block text;
  v_worst text;
  v_inv public.invoices%ROWTYPE;
  v_coll public.invoice_payment_collections%ROWTYPE;
  v_lot public.customer_credit_lots%ROWTYPE;
  v_ok boolean;
  v_super boolean := public.is_super_admin();
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;

  FOREACH v_id IN ARRAY COALESCE(p_collection_ids, ARRAY[]::uuid[]) LOOP
    SELECT * INTO v_coll FROM public.invoice_payment_collections c WHERE c.id = v_id;
    CONTINUE WHEN v_coll.id IS NULL;
    v_org := v_coll.organization_id;
    v_status := v_coll.status;

    -- Không rò rỉ trạng thái sang tổ chức khác.
    IF NOT v_super AND NOT EXISTS (
      SELECT 1 FROM public.organization_memberships m
       WHERE m.user_id = auth.uid() AND m.organization_id = v_org AND m.status = 'ACTIVE'
    ) THEN CONTINUE; END IF;

    SELECT * INTO v_inv FROM public.invoices i WHERE i.id = v_coll.invoice_id;

    IF v_status <> 'ACTIVE' THEN
      collection_id := v_id; mode := 'BLOCKED'; reason_code := 'ALREADY_REVERSED';
      RETURN NEXT; CONTINUE;
    END IF;

    -- QUYỀN: y hệt writer — thu_tien.undo ở cấp toà, rồi ở TỪNG sổ quỹ nguồn.
    SELECT allowed INTO v_ok FROM app_private.authorize_tenant_action_v3(
      auth.uid(), v_org, 'thu_tien.undo', v_inv.building_id, NULL);
    IF NOT COALESCE(v_ok, false) THEN
      collection_id := v_id; mode := 'BLOCKED'; reason_code := 'NO_PERMISSION';
      RETURN NEXT; CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.invoice_payment_tenders t
      WHERE t.collection_id = v_id AND t.voucher_id IS NOT NULL
        AND NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
              auth.uid(), v_org, 'thu_tien.undo', v_inv.building_id, t.account_id)), false)
    ) THEN
      collection_id := v_id; mode := 'BLOCKED'; reason_code := 'NO_PERMISSION';
      RETURN NEXT; CONTINUE;
    END IF;

    -- LIFO: phải hoàn tác khoản thu MỚI NHẤT trước.
    IF abs(COALESCE(v_inv.paid_amount, 0)
           - (v_coll.expected_paid_amount + v_coll.applied_amount)) >= 0.01 THEN
      collection_id := v_id; mode := 'BLOCKED'; reason_code := 'NOT_LIFO';
      RETURN NEXT; CONTINUE;
    END IF;

    -- Credit đã tiêu một phần thì writer từ chối.
    SELECT * INTO v_lot FROM public.customer_credit_lots l WHERE l.source_collection_id = v_id;
    IF v_lot.id IS NOT NULL AND v_lot.remaining_amount <> v_lot.amount THEN
      collection_id := v_id; mode := 'BLOCKED'; reason_code := 'CREDIT_USED';
      RETURN NEXT; CONTINUE;
    END IF;

    -- KHOÁ KỲ: áp dụng cho CẢ HAI chế độ (xem mục 1).
    v_worst := NULL;
    FOR v_block IN
      SELECT app_private.period_block_code_v1(t.voucher_id)
      FROM public.invoice_payment_tenders t
      WHERE t.collection_id = v_id AND t.voucher_id IS NOT NULL
    LOOP
      IF v_block IS NOT NULL THEN v_worst := v_block; EXIT; END IF;
    END LOOP;

    collection_id := v_id;
    IF v_worst IS NOT NULL THEN
      mode := 'BLOCKED'; reason_code := v_worst;
    ELSIF app_private.ie_flex_mode_enabled_v1(v_org) THEN
      mode := 'IN_PLACE_CANCEL'; reason_code := NULL;
    ELSE
      mode := 'COUNTER_VOUCHER'; reason_code := NULL;
    END IF;
    RETURN NEXT;
  END LOOP;
END
$fn$;

REVOKE ALL ON FUNCTION public.can_reverse_collection_v1(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.can_reverse_collection_v1(uuid[]) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 3. can_flex_cancel_v1 (Đợt 4) cũng phải nói đúng
-- Bản cũ chỉ kiểm membership + chế độ + assert_manual + assert_period. Đo thật:
-- 8 ca writer từ chối mà reader vẫn trả eligible=true (thiếu quyền cancel, không
-- giữ sổ, hạng mục hạn chế, phiếu xoá mềm, phiếu đã huỷ…).
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.can_flex_cancel_v1(p_ids uuid[])
RETURNS TABLE(id uuid, eligible boolean, reason_code text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_id uuid;
  v public.income_expenses%ROWTYPE;
  v_msg text;
  v_membership uuid;
  v_super boolean := public.is_super_admin();
  v_allowed boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;

  FOREACH v_id IN ARRAY COALESCE(p_ids, ARRAY[]::uuid[]) LOOP
    SELECT * INTO v FROM public.income_expenses ie WHERE ie.id = v_id;
    CONTINUE WHEN v.id IS NULL;

    SELECT m.id INTO v_membership FROM public.organization_memberships m
     WHERE m.user_id = auth.uid() AND m.organization_id = v.organization_id
       AND m.status = 'ACTIVE' LIMIT 1;
    IF v_membership IS NULL AND NOT v_super THEN CONTINUE; END IF;

    -- Trạng thái phiếu: writer từ chối/no-op những ca này.
    IF v.deleted_at IS NOT NULL THEN
      id := v_id; eligible := false; reason_code := 'DELETED'; RETURN NEXT; CONTINUE;
    END IF;
    IF v.approval_status = 'CANCELLED' THEN
      id := v_id; eligible := false; reason_code := 'ALREADY_CANCELLED'; RETURN NEXT; CONTINUE;
    END IF;

    IF NOT app_private.ie_flex_mode_enabled_v1(v.organization_id) THEN
      id := v_id; eligible := false; reason_code := 'STRICT_MODE'; RETURN NEXT; CONTINUE;
    END IF;

    -- Hạng mục hạn chế.
    IF COALESCE(v.has_restricted_item, false)
       AND v.user_id IS DISTINCT FROM auth.uid()
       AND NOT public.can_view_restricted_ie() AND NOT v_super THEN
      id := v_id; eligible := false; reason_code := 'RESTRICTED'; RETURN NEXT; CONTINUE;
    END IF;

    -- Phiếu POSTED mà con trỏ bút toán rỗng: writer RAISE, reader phải nói trước.
    IF COALESCE(v.posting_status, 'UNPOSTED') = 'POSTED' AND v.active_posting_id_v2 IS NULL THEN
      id := v_id; eligible := false; reason_code := 'NO_ACTIVE_POSTING'; RETURN NEXT; CONTINUE;
    END IF;

    -- QUYỀN: y hệt writer (chủ tổ chức / super admin vào thẳng theo quyết định #4).
    IF NOT v_super AND NOT app_private.is_org_owner_v1(v.organization_id, auth.uid()) THEN
      SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(
        auth.uid(), v.organization_id, 'income_expenses.cancel', v.building_id, v.account_id);
      IF NOT COALESCE(v_allowed, false) THEN
        id := v_id; eligible := false; reason_code := 'NO_PERMISSION'; RETURN NEXT; CONTINUE;
      END IF;
      IF v.account_id IS NOT NULL THEN
        BEGIN
          PERFORM app_private.assert_cashbook_access_v2(
            v.organization_id, v.account_id, 'CUSTODIAN', v_membership);
        EXCEPTION WHEN OTHERS THEN
          id := v_id; eligible := false; reason_code := 'NOT_CUSTODIAN'; RETURN NEXT; CONTINUE;
        END;
      END IF;
    END IF;

    BEGIN
      PERFORM app_private.assert_manual_voucher_v1(v_id, 'huỷ');
      PERFORM app_private.assert_period_open_for_edit_v1(v_id, 'huỷ');
      id := v_id; eligible := true; reason_code := NULL; RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      v_msg := SQLERRM;
      id := v_id; eligible := false;
      reason_code := CASE
        WHEN v_msg LIKE '%NOT_MANUAL%'       THEN 'NOT_MANUAL'
        WHEN v_msg LIKE '%CASHBOOK_CLOSED%'  THEN 'CASHBOOK_CLOSED'
        WHEN v_msg LIKE '%HANDOVER_LOCKED%'  THEN 'HANDOVER_LOCKED'
        WHEN v_msg LIKE '%PROFIT_LOCKED%'    THEN 'PROFIT_LOCKED'
        ELSE 'UNKNOWN' END;
      RETURN NEXT;
    END;
  END LOOP;
END
$fn$;

REVOKE ALL ON FUNCTION public.can_flex_cancel_v1(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.can_flex_cancel_v1(uuid[]) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 4. cancel_income_expense_flex_v1 không được rò rỉ sang tổ chức khác
-- Thứ tự cũ: đọc phiếu bất kể org → no-op nếu đã CANCELLED → [STRICT_MODE] →
-- assert_manual → assert_period → RỒI MỚI kiểm membership. Người ở tổ chức khác
-- chỉ cần biết UUID phiếu là đọc được: phiếu có tồn tại không, system_source là
-- gì, và cả TÊN SỔ QUỸ + ngày chốt của tổ chức khác qua [CASHBOOK_CLOSED].
-- Đưa kiểm membership lên NGAY SAU khi tìm thấy phiếu.
-- ─────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_def text;
  v_anchor text :=
    '  IF v.approval_status = ''CANCELLED'' THEN';
  v_guard text :=
    '  -- Kiểm THÀNH VIÊN ngay sau khi tìm thấy phiếu: mọi thông điệp phía dưới' || chr(10) ||
    '  -- (đã huỷ chưa, system_source gì, tên sổ quỹ, ngày chốt) đều là thông tin' || chr(10) ||
    '  -- của tổ chức sở hữu phiếu — người ngoài không được nghe.' || chr(10) ||
    '  IF NOT public.is_super_admin() AND NOT EXISTS (' || chr(10) ||
    '    SELECT 1 FROM public.organization_memberships m0' || chr(10) ||
    '     WHERE m0.user_id = v_actor AND m0.organization_id = v.organization_id' || chr(10) ||
    '       AND m0.status = ''ACTIVE''' || chr(10) ||
    '  ) THEN' || chr(10) ||
    '    RAISE EXCEPTION ''Không thuộc tổ chức của phiếu'' USING ERRCODE = ''42501'';' || chr(10) ||
    '  END IF;' || chr(10) || chr(10);
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'cancel_income_expense_flex_v1';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Không có cancel_income_expense_flex_v1'; END IF;

  IF position('người ngoài không được nghe' IN v_def) > 0 THEN
    RAISE NOTICE 'cancel_income_expense_flex_v1 đã vá rò rỉ xuyên tổ chức — bỏ qua'; RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo trong cancel_income_expense_flex_v1 — DỪNG';
  END IF;

  v_def := replace(v_def, v_anchor, v_guard || v_anchor);
  EXECUTE v_def;
  RAISE NOTICE 'cancel_income_expense_flex_v1: kiểm thành viên đã lên trước';
END
$patch$;

COMMIT;

NOTIFY pgrst, 'reload schema';
