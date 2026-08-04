-- =====================================================================
-- Hai mục cuối của đợt siết quyền, theo yêu cầu của chủ 30/07:
--
--   a) "người nào thu thì người đó huỷ — biết sổ mới thu được, và hoàn tác thì
--      phải chính người thu phiếu đó mới hoàn tác được"
--      ⇒ Hoàn tác thu tiền: đòi ĐÚNG NGƯỜI ĐÃ THU. Chặt hơn hẳn mức "biết sổ"
--        bàn lúc đầu.
--
--   b) ie_compat_cancel_v2 (nút "huỷ cả đợt", có ở CẢ desktop lẫn mobile) hiện
--      KHÔNG kiểm một quyền nào: đo bằng pg_get_functiondef — không gọi
--      authorize_tenant_action_v3, không gọi assert_cashbook_access. Bất kỳ
--      thành viên nào cũng huỷ hàng loạt phiếu chưa ghi sổ của người khác.
--      Nó cũng KHÔNG ghi app_private.income_expense_cancellations, nên huỷ theo
--      đợt không để lại mốc huỷ và lý do — đúng thứ Đợt 4 hứa sẽ luôn có.
-- =====================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. HOÀN TÁC THU TIỀN: chỉ CHÍNH NGƯỜI ĐÃ THU
--
-- Trước: chỉ cần thu_tien.undo ở cấp toà. Đo trên 15 cặp (người × sổ đang có
-- khoản thu mở): B.Huy hoàn tác được Hiệp Thu / TK939 / TKHIEP mà không giữ,
-- không biết, không được chia sẻ — anh qua nhờ override cấp ORGANIZATION.
--
-- Nay thêm: người gọi phải là NGƯỜI TẠO phiếu thu gốc. Giữ cửa cho chủ tổ chức
-- / super admin để không kẹt khi người thu đã nghỉ việc — nếu bỏ cửa này thì
-- mọi khoản thu của nhân viên cũ thành bất khả hoàn tác vĩnh viễn.
-- ─────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_def text;
  v_anchor text :=
    '    IF NOT COALESCE(v_authz, false) THEN' || chr(10) ||
    '      RAISE EXCEPTION ''Không có quyền hoàn tác trên sổ quỹ nguồn'' USING ERRCODE = ''42501'';' || chr(10) ||
    '    END IF;';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reverse_invoice_collection_v5';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Không có reverse_invoice_collection_v5'; END IF;

  IF position('CHÍNH NGƯỜI ĐÃ THU' IN v_def) > 0 THEN
    RAISE NOTICE 'reverse_invoice_collection_v5 đã đòi đúng người thu — bỏ qua'; RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo authz cấp tender — DỪNG, không vá mù';
  END IF;

  v_def := replace(v_def, v_anchor, v_anchor || chr(10) || chr(10) ||
    '    -- Chỉ CHÍNH NGƯỜI ĐÃ THU được hoàn tác khoản thu đó (yêu cầu của chủ' || chr(10) ||
    '    -- 30/07). Chủ tổ chức / super admin giữ cửa phụ, nếu không thì khoản' || chr(10) ||
    '    -- thu của nhân viên đã nghỉ là bất khả hoàn tác vĩnh viễn.' || chr(10) ||
    '    IF NOT public.is_super_admin()' || chr(10) ||
    '       AND NOT app_private.is_org_owner_v1(v_collection.organization_id, v_actor)' || chr(10) ||
    '       AND NOT EXISTS (SELECT 1 FROM public.income_expenses src' || chr(10) ||
    '                        WHERE src.id = v_tender.voucher_id AND src.user_id = v_actor) THEN' || chr(10) ||
    '      RAISE EXCEPTION ''Chỉ người đã thu khoản này mới hoàn tác được. Nhờ người thu hoặc chủ tổ chức thực hiện.''' || chr(10) ||
    '        USING ERRCODE = ''42501'';' || chr(10) ||
    '    END IF;');

  IF position('CHÍNH NGƯỜI ĐÃ THU' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vá "đúng người thu" thất bại';
  END IF;
  EXECUTE v_def;
  RAISE NOTICE 'reverse_invoice_collection_v5: hoàn tác đòi đúng người đã thu';
END
$patch$;

-- Reader phải nói CÙNG câu chuyện, nếu không nút lại nói dối.
DO $patch$
DECLARE
  v_def text;
  v_anchor text :=
    '    IF EXISTS (' || chr(10) ||
    '      SELECT 1 FROM public.invoice_payment_tenders t' || chr(10) ||
    '      WHERE t.collection_id = v_id AND t.voucher_id IS NOT NULL';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'can_reverse_collection_v1';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Không có can_reverse_collection_v1'; END IF;
  IF position('NOT_COLLECTOR' IN v_def) > 0 THEN
    RAISE NOTICE 'can_reverse_collection_v1 đã khớp — bỏ qua'; RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo trong can_reverse_collection_v1 — DỪNG';
  END IF;

  v_def := replace(v_def, v_anchor,
    '    -- Chỉ chính người đã thu (hoặc chủ tổ chức / super admin).' || chr(10) ||
    '    IF NOT v_super' || chr(10) ||
    '       AND NOT app_private.is_org_owner_v1(v_org, auth.uid())' || chr(10) ||
    '       AND EXISTS (SELECT 1 FROM public.invoice_payment_tenders t2' || chr(10) ||
    '                    JOIN public.income_expenses src ON src.id = t2.voucher_id' || chr(10) ||
    '                    WHERE t2.collection_id = v_id AND src.user_id IS DISTINCT FROM auth.uid()) THEN' || chr(10) ||
    '      collection_id := v_id; mode := ''BLOCKED''; reason_code := ''NOT_COLLECTOR'';' || chr(10) ||
    '      RETURN NEXT; CONTINUE;' || chr(10) ||
    '    END IF;' || chr(10) || chr(10) ||
    v_anchor);
  EXECUTE v_def;
  RAISE NOTICE 'can_reverse_collection_v1: đã khớp "đúng người thu"';
END
$patch$;

-- ─────────────────────────────────────────────────────────────────────
-- 2. HUỶ CẢ ĐỢT: gác quyền + để lại dấu vết
-- Cùng mô hình chủ đã chốt cho cancel_income_expense_flex_v1:
-- người TẠO phiếu HOẶC người GIỮ SỔ HOẶC chủ tổ chức / super admin.
-- ─────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_def text;
  v_anchor text :=
    '    IF app_private.ie_flow_system_owned_v2(v_id) THEN' || chr(10) ||
    '      RAISE EXCEPTION ''Phiếu % thuộc writer hệ thống'', v_id USING ERRCODE=''42501'';' || chr(10) ||
    '    END IF;';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'ie_compat_cancel_v2';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Không có ie_compat_cancel_v2'; END IF;

  IF position('income_expenses.cancel' IN v_def) > 0 THEN
    RAISE NOTICE 'ie_compat_cancel_v2 đã gác quyền — bỏ qua'; RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo trong ie_compat_cancel_v2 — DỪNG';
  END IF;

  v_def := replace(v_def, v_anchor, v_anchor || chr(10) || chr(10) ||
    '    -- Cổng quyền: người TẠO phiếu, hoặc người GIỮ SỔ (kèm quyền huỷ), hoặc' || chr(10) ||
    '    -- chủ tổ chức / super admin. Trước đây hàm này chỉ kiểm membership nên' || chr(10) ||
    '    -- bất kỳ ai cũng huỷ hàng loạt phiếu chưa ghi sổ của người khác.' || chr(10) ||
    '    IF NOT public.is_super_admin()' || chr(10) ||
    '       AND NOT app_private.is_org_owner_v1(v_row.organization_id, auth.uid())' || chr(10) ||
    '       AND v_row.user_id IS DISTINCT FROM auth.uid() THEN' || chr(10) ||
    '      DECLARE v_ok boolean;' || chr(10) ||
    '      BEGIN' || chr(10) ||
    '        SELECT allowed INTO v_ok FROM app_private.authorize_tenant_action_v3(' || chr(10) ||
    '          auth.uid(), v_row.organization_id, ''income_expenses.cancel'',' || chr(10) ||
    '          v_row.building_id, v_row.account_id);' || chr(10) ||
    '        IF NOT COALESCE(v_ok, false) THEN' || chr(10) ||
    '          RAISE EXCEPTION ''Không có quyền huỷ phiếu % '', v_id USING ERRCODE=''42501'';' || chr(10) ||
    '        END IF;' || chr(10) ||
    '        IF v_row.account_id IS NOT NULL THEN' || chr(10) ||
    '          PERFORM app_private.assert_cashbook_access_v2(' || chr(10) ||
    '            v_row.organization_id, v_row.account_id, ''CUSTODIAN'', v_actor.membership_id);' || chr(10) ||
    '        END IF;' || chr(10) ||
    '      END;' || chr(10) ||
    '    END IF;');

  -- Dấu vết huỷ: Đợt 4 hứa "luôn có mốc lập/duyệt/huỷ + lý do", nhưng đường
  -- huỷ cả đợt lại không ghi gì.
  v_def := replace(v_def,
    '    v_done := v_done + 1;',
    '    INSERT INTO app_private.income_expense_cancellations' || chr(10) ||
    '      (income_expense_id, organization_id, cancelled_by, cancel_reason,' || chr(10) ||
    '       cancellation_kind, created_at_snap, approved_at_snap, amount_snap, cashbook_snap)' || chr(10) ||
    '    VALUES (v_id, v_row.organization_id, auth.uid(),' || chr(10) ||
    '            COALESCE(NULLIF(btrim(COALESCE(p_reason, '''')), ''''), ''(huỷ cả đợt, không ghi lý do)''),' || chr(10) ||
    '            ''COMPAT_BATCH_CANCEL'', v_row.created_at, v_row.approved_at,' || chr(10) ||
    '            v_row.total_amount, v_row.account_id)' || chr(10) ||
    '    ON CONFLICT (income_expense_id) DO NOTHING;' || chr(10) || chr(10) ||
    '    v_done := v_done + 1;');

  IF position('income_expenses.cancel' IN v_def) = 0
     OR position('income_expense_cancellations' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vá ie_compat_cancel_v2 thất bại';
  END IF;
  EXECUTE v_def;
  RAISE NOTICE 'ie_compat_cancel_v2: đã gác quyền + ghi dấu vết huỷ';
END
$patch$;

COMMIT;

NOTIFY pgrst, 'reload schema';
