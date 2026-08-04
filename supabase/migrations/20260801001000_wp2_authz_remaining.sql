-- =====================================================================
-- WP2 — SIẾT NỐT PHẦN PHÂN QUYỀN CÒN LẠI (chủ duyệt từng mục 30/07/2026)
--
-- Tất cả bảy mục dưới đây đều do ĐO THẬT trên production bới ra, không suy
-- đoán từ đọc file migration cũ (thân hàm trên prod đã trôi khỏi file từ lâu).
-- Vì vậy mọi bản vá ở đây đi theo lối: pg_get_functiondef → assert NEO →
-- replace → EXECUTE. Chạy lần hai là no-op (mỗi khối tự nhận ra dấu đã vá).
--
--   A. thu_tien.undo phải "được nhìn sổ" mới hoàn tác được sổ đó.
--   B. Vòng authz cấp tender kiểm ĐÚNG toà của tender, không phải toà hoá đơn.
--   C. ie_compat_cancel_v2 mọc cổng quyền + ghi sổ dấu vết huỷ.
--   D. assert_period_open_for_edit_v1 phủ cả 3 cách gán phiếu vào kỳ.
--   E. reverse_invoice_collection_v5 chặn ngày hoàn tác ở TƯƠNG LAI.
--   F. Biên bản chốt sổ ghi lại việc super admin ký thay.
--   G. Xác nhận anon không còn DML trên public.invoices / public.payments.
--
-- ĐÁNH SỐ LẠI + RÀ LẠI 31/07/2026 -------------------------------------
-- File soạn 30/07 tên 20260730240000_authz_remaining.sql, CHƯA TỪNG APPLY,
-- trong khi dải 20260730* đã có 24 migration lên prod sau đó. Giữ số cũ làm
-- thứ tự replay trên clone khác thứ tự thi hành thật ⇒ đổi sang 20260801001000.
--
-- Đã chạy khan (BEGIN → từng khối → ROLLBACK) trên prod ngày 31/07:
--   $patch_v5$     ÁP ĐƯỢC     $patch_period$  ÁP ĐƯỢC
--   $patch_reader$ ÁP ĐƯỢC     $patch_confirm$ ÁP ĐƯỢC
--   $assert_anon$  ÁP ĐƯỢC
--   $patch_compat$ MẤT NEO  ⇒ đã VIẾT LẠI, xem mục C.
-- ---------------------------------------------------------------------
-- =====================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- A + B + E. public.reverse_invoice_collection_v5
--
-- A) HIỆN TRẠNG ĐO ĐƯỢC: permission_definitions của thu_tien.undo có
--    requires_cashbook_possession = false, nên truyền cashbook_id vào
--    authorize_tenant_action_v3 chỉ kiểm PHẠM VI (override cấp CASHBOOK có phủ
--    sổ này không) chứ KHÔNG kiểm QUAN HỆ (người này có giữ / có biết sổ không).
--    Quét 12 cặp (người × sổ đang có khoản thu ACTIVE) trên org thật:
--      NG TÂM   — CUSTODIAN cả 3 sổ, kiêm chủ tổ chức     → đúng
--      NATHAN   — CUSTODIAN Hiệp Thu / TKHIEP             → đúng
--      JOEY     — được chia sẻ TK939 (KNOWER)             → đúng ý chủ
--      B.Huy    — KHÔNG giữ, KHÔNG biết, KHÔNG được chia sẻ sổ nào,
--                 nhưng hoàn tác được CẢ BA sổ nhờ một override cấp
--                 ORGANIZATION phủ mọi sổ                 → LỖ
--    Chủ chốt: "với việc thu chỉ cần biết sổ là được". ⇒ thêm đúng một bậc
--    "ĐƯỢC NHÌN SỔ" vào vòng lặp tender.
--
--    Dùng app_private.ie_visible_cashbook_ids_v1() — KHÔNG dùng
--    assert_cashbook_access_v2(..., 'KNOWER', ...) vì hàm đó so possession_kind
--    CHÍNH XÁC, truyền 'KNOWER' sẽ loại luôn người đang GIỮ sổ (CUSTODIAN).
--    ie_visible_* gộp đủ 4 cửa: super admin / người tạo sổ / được chia sẻ sổ /
--    đang giữ sổ.
--
-- B) Vòng authz cấp tender đang truyền v_invoice.building_id cho MỌI tender.
--    Một collection có nhiều tender, mỗi tender là một phiếu thu riêng và phiếu
--    đó có building_id của chính nó. Hôm nay prod chưa có ca lệch (đo: 0/9
--    tender có building khác hoá đơn) nên đây là vá lỗ trước khi nó nổ, không
--    phải sửa sự cố.
--
-- E) p_reversal_date mới chỉ bị chặn cận DƯỚI (không sớm hơn ngày thu).
--    2099-12-31 vẫn được nhận và ghi thẳng vào
--    invoice_payment_collections.reversal_date. Thêm cận trên = CURRENT_DATE.
-- ─────────────────────────────────────────────────────────────────────
DO $patch_v5$
DECLARE
  v_def text;
  v_new text;
  v_anchor_decl text :=
    '  v_rev_posting uuid;' || chr(10) ||
    '  v_mode text;' || chr(10) ||
    'BEGIN';
  v_anchor_date text :=
    '  IF p_reversal_date < v_collection.collection_date THEN' || chr(10) ||
    '    RAISE EXCEPTION ''Reversal date cannot be earlier than collection date''' || chr(10) ||
    '      USING ERRCODE = ''22023'';' || chr(10) ||
    '  END IF;';
  v_anchor_authz text :=
    '    SELECT allowed INTO v_authz' || chr(10) ||
    '    FROM app_private.authorize_tenant_action_v3(' || chr(10) ||
    '      v_actor, v_collection.organization_id, ''thu_tien.undo'',' || chr(10) ||
    '      v_invoice.building_id, v_tender.account_id' || chr(10) ||
    '    );' || chr(10) ||
    '    IF NOT COALESCE(v_authz, false) THEN' || chr(10) ||
    '      RAISE EXCEPTION ''Không có quyền hoàn tác trên sổ quỹ nguồn'' USING ERRCODE = ''42501'';' || chr(10) ||
    '    END IF;';
  v_anchor_member text :=
    '  SELECT m.id INTO v_membership FROM public.organization_memberships m' || chr(10) ||
    '     WHERE m.user_id = v_actor AND m.organization_id = v_org AND m.status = ''ACTIVE''' || chr(10) ||
    '     LIMIT 1;';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reverse_invoice_collection_v5';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Không có public.reverse_invoice_collection_v5 — DỪNG';
  END IF;

  IF position('WP2_UNDO_VISIBLE_BOOK' IN v_def) > 0 THEN
    RAISE NOTICE 'reverse_invoice_collection_v5 đã vá (A/B/E) — bỏ qua';
  ELSE
    IF position(v_anchor_decl IN v_def) = 0
       OR position(v_anchor_date IN v_def) = 0
       OR position(v_anchor_member IN v_def) = 0
       OR position(v_anchor_authz IN v_def) = 0 THEN
      RAISE EXCEPTION 'reverse_invoice_collection_v5: không khớp neo — DỪNG, không vá mù';
    END IF;

    v_new := v_def;

    -- (1) Biến mới.
    v_new := replace(v_new, v_anchor_decl,
      '  v_rev_posting uuid;' || chr(10) ||
      '  v_mode text;' || chr(10) ||
      '  -- WP2_UNDO_VISIBLE_BOOK: chủ tổ chức / super admin đi thẳng, người còn' || chr(10) ||
      '  -- lại phải có ÍT NHẤT quan hệ "được nhìn sổ" với từng sổ quỹ nguồn.' || chr(10) ||
      '  v_book_bypass boolean := false;' || chr(10) ||
      '  v_tender_building uuid;' || chr(10) ||
      '  v_book_name text;' || chr(10) ||
      'BEGIN');

    -- (2) E — cận trên của ngày hoàn tác.
    v_new := replace(v_new, v_anchor_date,
      v_anchor_date || chr(10) ||
      '  -- Cận TRÊN: ngày hoàn tác nằm ở tương lai sẽ đóng băng một con số chưa' || chr(10) ||
      '  -- xảy ra vào invoice_payment_collections.reversal_date và làm mọi báo cáo' || chr(10) ||
      '  -- theo kỳ đọc sai. 2099-12-31 từng được nhận.' || chr(10) ||
      '  IF p_reversal_date > CURRENT_DATE THEN' || chr(10) ||
      '    RAISE EXCEPTION ''Ngày hoàn tác không được ở tương lai (hôm nay là %)'', ' ||
      'to_char(CURRENT_DATE, ''DD/MM/YYYY'')' || chr(10) ||
      '      USING ERRCODE = ''22023'';' || chr(10) ||
      '  END IF;');

    -- (3) A — tính cửa đi thẳng ngay sau khi biết membership.
    v_new := replace(v_new, v_anchor_member,
      v_anchor_member || chr(10) ||
      '  v_book_bypass := public.is_super_admin()' || chr(10) ||
      '                   OR app_private.is_org_owner_v1(v_org, v_actor);');

    -- (4) A + B — vòng authz cấp tender.
    v_new := replace(v_new, v_anchor_authz,
      '    -- B: toà của CHÍNH tender này (phiếu thu của tender), không phải toà' || chr(10) ||
      '    -- của hoá đơn. Một collection nhiều tender có thể bắc qua nhiều toà.' || chr(10) ||
      '    SELECT tender_voucher.building_id INTO v_tender_building' || chr(10) ||
      '    FROM public.income_expenses tender_voucher WHERE tender_voucher.id = v_tender.voucher_id;' || chr(10) ||
      '    v_tender_building := COALESCE(v_tender_building, v_invoice.building_id);' || chr(10) ||
      chr(10) ||
      '    SELECT allowed INTO v_authz' || chr(10) ||
      '    FROM app_private.authorize_tenant_action_v3(' || chr(10) ||
      '      v_actor, v_collection.organization_id, ''thu_tien.undo'',' || chr(10) ||
      '      v_tender_building, v_tender.account_id' || chr(10) ||
      '    );' || chr(10) ||
      '    IF NOT COALESCE(v_authz, false) THEN' || chr(10) ||
      '      RAISE EXCEPTION ''Không có quyền hoàn tác trên sổ quỹ nguồn'' USING ERRCODE = ''42501'';' || chr(10) ||
      '    END IF;' || chr(10) ||
      chr(10) ||
      '    -- A (WP2_UNDO_VISIBLE_BOOK): quyền thôi chưa đủ. Một override cấp' || chr(10) ||
      '    -- ORGANIZATION phủ MỌI sổ, kể cả sổ người này không giữ, không biết,' || chr(10) ||
      '    -- không được chia sẻ. Chủ chốt "với việc thu chỉ cần biết sổ là được".' || chr(10) ||
      '    IF NOT v_book_bypass AND NOT EXISTS (' || chr(10) ||
      '      SELECT 1 FROM app_private.ie_visible_cashbook_ids_v1() visible_book' || chr(10) ||
      '      WHERE visible_book.cashbook_id = v_tender.account_id' || chr(10) ||
      '    ) THEN' || chr(10) ||
      '      SELECT book_row.name INTO v_book_name FROM public.accounts book_row' || chr(10) ||
      '       WHERE book_row.id = v_tender.account_id;' || chr(10) ||
      '      RAISE EXCEPTION ''Sổ quỹ "%" không nằm trong các sổ bạn được nhìn — không hoàn tác được khoản thu của sổ này. Hãy nhờ người giữ sổ chia sẻ sổ cho bạn trước.'',' || chr(10) ||
      '        COALESCE(v_book_name, ''không rõ'')' || chr(10) ||
      '        USING ERRCODE = ''42501'';' || chr(10) ||
      '    END IF;');

    EXECUTE v_new;
    RAISE NOTICE 'ĐÃ VÁ reverse_invoice_collection_v5 (A: nhìn sổ, B: toà theo tender, E: cận trên ngày)';
  END IF;
END
$patch_v5$;

-- ─────────────────────────────────────────────────────────────────────
-- A (phần đọc). public.can_reverse_collection_v1
--
-- Reader không được nói dối writer. Nếu writer chặn mà reader vẫn trả
-- IN_PLACE_CANCEL thì nút "Hoàn tác" vẫn sáng và người dùng ăn 42501 giữa
-- chừng. Vá cho khớp: cùng bậc "được nhìn sổ", cùng cách lấy toà theo tender.
-- ─────────────────────────────────────────────────────────────────────
DO $patch_reader$
DECLARE
  v_def text;
  v_new text;
  v_anchor_decl text := '  v_super boolean := public.is_super_admin();' || chr(10) || 'BEGIN';
  v_anchor_inv text :=
    '    SELECT * INTO v_inv FROM public.invoices i WHERE i.id = v_coll.invoice_id;';
  v_anchor_tender text :=
    '    IF EXISTS (' || chr(10) ||
    '      SELECT 1 FROM public.invoice_payment_tenders t' || chr(10) ||
    '      WHERE t.collection_id = v_id AND t.voucher_id IS NOT NULL' || chr(10) ||
    '        AND NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(' || chr(10) ||
    '              auth.uid(), v_org, ''thu_tien.undo'', v_inv.building_id, t.account_id)), false)' || chr(10) ||
    '    ) THEN';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'can_reverse_collection_v1';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Không có public.can_reverse_collection_v1 — DỪNG';
  END IF;

  IF position('WP2_UNDO_VISIBLE_BOOK' IN v_def) > 0 THEN
    RAISE NOTICE 'can_reverse_collection_v1 đã vá — bỏ qua';
  ELSE
    IF position(v_anchor_decl IN v_def) = 0
       OR position(v_anchor_inv IN v_def) = 0
       OR position(v_anchor_tender IN v_def) = 0 THEN
      RAISE EXCEPTION 'can_reverse_collection_v1: không khớp neo — DỪNG, không vá mù';
    END IF;

    v_new := v_def;

    v_new := replace(v_new, v_anchor_decl,
      '  v_super boolean := public.is_super_admin();' || chr(10) ||
      '  -- WP2_UNDO_VISIBLE_BOOK' || chr(10) ||
      '  v_book_bypass boolean := false;' || chr(10) ||
      'BEGIN');

    v_new := replace(v_new, v_anchor_inv,
      v_anchor_inv || chr(10) ||
      '    v_book_bypass := v_super OR app_private.is_org_owner_v1(v_org, auth.uid());');

    v_new := replace(v_new, v_anchor_tender,
      '    IF EXISTS (' || chr(10) ||
      '      SELECT 1 FROM public.invoice_payment_tenders t' || chr(10) ||
      '      LEFT JOIN public.income_expenses tender_voucher ON tender_voucher.id = t.voucher_id' || chr(10) ||
      '      WHERE t.collection_id = v_id AND t.voucher_id IS NOT NULL' || chr(10) ||
      '        AND (' || chr(10) ||
      '          NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(' || chr(10) ||
      '                auth.uid(), v_org, ''thu_tien.undo'',' || chr(10) ||
      '                COALESCE(tender_voucher.building_id, v_inv.building_id), t.account_id)), false)' || chr(10) ||
      '          OR (NOT v_book_bypass AND NOT EXISTS (' || chr(10) ||
      '                SELECT 1 FROM app_private.ie_visible_cashbook_ids_v1() visible_book' || chr(10) ||
      '                 WHERE visible_book.cashbook_id = t.account_id))' || chr(10) ||
      '        )' || chr(10) ||
      '    ) THEN');

    EXECUTE v_new;
    RAISE NOTICE 'ĐÃ VÁ can_reverse_collection_v1 (khớp writer)';
  END IF;
END
$patch_reader$;

-- ─────────────────────────────────────────────────────────────────────
-- C. public.ie_compat_cancel_v2 — VIẾT LẠI 31/07/2026, phạm vi thu hẹp
--
-- Bản 30/07 định vá ba thứ vào hàm này. Chạy khan trên prod 31/07 thì mất neo.
-- Lý do KHÔNG phải hàm bị hỏng — mà là MỘT MIGRATION SAU ĐÃ LÀM 2/3:
--
--   ĐÃ CÓ trên prod (đọc pg_get_functiondef 31/07):
--     • Cổng quyền ba cửa: super admin / chủ tổ chức / người tạo phiếu;
--       nếu không thuộc ba cửa thì authorize_tenant_action_v3
--       ('income_expenses.cancel') + assert_cashbook_access_v2 CUSTODIAN.
--     • Ghi app_private.income_expense_cancellations kèm ảnh chụp
--       created_at / approved_at / total_amount / cashbook.
--
--   CÒN THIẾU (chính là phần dưới đây bù vào):
--     • Chốt HẠNG MỤC HẠN CHẾ. Hàm không đọc has_restricted_item, nên người
--       có income_expenses.cancel trên toà nhưng KHÔNG có can_view_restricted_ie
--       vẫn huỷ được phiếu lương của người khác — phiếu mà chính họ không
--       được phép nhìn thấy nội dung. Huỷ thứ mình không được đọc là lỗ.
--
-- Vì vậy khối này KHÔNG chép lại bản 30/07 (chép lại sẽ ghi đè lên bản vá đang
-- chạy và có thể nuốt mất thứ nó thêm vào). Nó chỉ chèn đúng một chốt, neo vào
-- thân hàm ĐANG SỐNG, và tự bỏ qua nếu đã vá.
-- ─────────────────────────────────────────────────────────────────────
DO $patch_compat$
DECLARE
  v_def text;
  v_new text;
  v_mark text := 'WP2_COMPAT_RESTRICTED_GATE';
  -- Neo: khối token per-xid ngay trước UPDATE. Chèn chốt vào TRƯỚC nó để
  -- không tạo token cho một cú huỷ rồi mới phát hiện là không được phép.
  v_anchor text :=
    '    -- Token per-xid: guard freeze đòi trước khi cho transition (7u).';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'ie_compat_cancel_v2';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Không có public.ie_compat_cancel_v2 — DỪNG';
  END IF;

  IF position(v_mark IN v_def) > 0 THEN
    RAISE NOTICE 'ie_compat_cancel_v2 đã có chốt hạng mục hạn chế — bỏ qua';
    RETURN;
  END IF;

  -- Điều kiện tồn tại của bản vá thu hẹp này: cổng quyền phải ĐÃ có sẵn.
  -- Nếu một ngày nào đó nó biến mất thì đây không còn là "bù phần thiếu" nữa
  -- và im lặng chèn mỗi chốt hạn chế là để hở nguyên cái lỗ to.
  IF position('income_expenses.cancel' IN v_def) = 0
     OR position('income_expense_cancellations' IN v_def) = 0 THEN
    RAISE EXCEPTION
      'ie_compat_cancel_v2 KHÔNG còn cổng quyền/sổ dấu vết như đo được 31/07 — DỪNG, đọc lại thân hàm rồi viết bản vá đầy đủ (xem git lịch sử file này)';
  END IF;

  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'ie_compat_cancel_v2: không khớp neo token — DỪNG, không vá mù';
  END IF;

  v_new := replace(v_def, v_anchor,
    '    -- ' || v_mark || ': huỷ một thứ mình không được phép ĐỌC là lỗ.' || chr(10) ||
    '    -- Người có income_expenses.cancel trên toà nhưng không có' || chr(10) ||
    '    -- can_view_restricted_ie vẫn huỷ được phiếu lương của người khác.' || chr(10) ||
    '    -- Người TẠO phiếu thì luôn huỷ được phiếu của chính mình.' || chr(10) ||
    '    IF COALESCE(v_row.has_restricted_item, false)' || chr(10) ||
    '       AND v_row.user_id IS DISTINCT FROM auth.uid()' || chr(10) ||
    '       AND NOT public.can_view_restricted_ie()' || chr(10) ||
    '       AND NOT public.is_super_admin() THEN' || chr(10) ||
    '      RAISE EXCEPTION ''Phiếu % chứa hạng mục hạn chế — không có quyền huỷ'', v_id' || chr(10) ||
    '        USING ERRCODE = ''42501'';' || chr(10) ||
    '    END IF;' || chr(10) ||
    chr(10) ||
    v_anchor);

  EXECUTE v_new;
  RAISE NOTICE 'ĐÃ VÁ ie_compat_cancel_v2 (chốt hạng mục hạn chế)';
END
$patch_compat$;

-- Tự kiểm: chốt phải NẰM TRONG thân hàm sau khi vá, không chỉ "đã chạy xong".
DO $verify_compat$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'ie_compat_cancel_v2';

  IF position('WP2_COMPAT_RESTRICTED_GATE' IN v_def) = 0
     OR position('can_view_restricted_ie' IN v_def) = 0 THEN
    RAISE EXCEPTION 'ie_compat_cancel_v2 vá xong mà không thấy chốt hạn chế — DỪNG';
  END IF;
  -- Và ba thứ cũ vẫn còn nguyên (bản vá thu hẹp không được làm mất gì).
  IF position('income_expenses.cancel' IN v_def) = 0
     OR position('income_expense_cancellations' IN v_def) = 0
     OR position('ie_flow_system_owned_v2' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Bản vá đã làm mất cổng quyền/sổ huỷ/chốt flow-owned — DỪNG';
  END IF;
END
$verify_compat$;


-- ─────────────────────────────────────────────────────────────────────
-- D. app_private.assert_period_open_for_edit_v1 — phủ CẢ BA cách gán kỳ
--
-- Plan Đợt 3f: vị ngữ này phải phủ cả 3 cách hệ thống gán phiếu vào kỳ —
-- voucher_date, billing_month của hoá đơn, và start_date/end_date của item.
-- Hiện chỉ có vế đầu.
--
-- Hai vế thiếu chỉ có nghĩa với KHOÁ LỢI NHUẬN THEO THÁNG: khoá sổ quỹ tính
-- theo NGÀY TIỀN RỜI QUỸ (đúng bằng voucher_date) nên vế 1 đã phủ trọn, còn
-- profit_monthly khoá theo THÁNG DOANH THU — mà doanh thu được gán vào tháng
-- theo billing_month của hoá đơn hoặc theo kỳ dịch vụ của hạng mục, KHÔNG theo
-- ngày lập phiếu. Đây chính là kẽ để một khoản tiền rời khỏi tháng đã chia lợi
-- nhuận mà vị ngữ vẫn báo "kỳ đang mở".
-- ─────────────────────────────────────────────────────────────────────
DO $patch_period$
DECLARE
  v_def text;
  v_new text;
  v_anchor_decl text :=
    '  v_handover text;' || chr(10) ||
    '  v_month date;' || chr(10) ||
    'BEGIN';
  v_anchor_tail text :=
    '        to_char(v_month, ''MM/YYYY''), p_action' || chr(10) ||
    '        USING ERRCODE = ''P0001'';' || chr(10) ||
    '    END IF;' || chr(10) ||
    '  END IF;' || chr(10) ||
    'END';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app_private' AND p.proname = 'assert_period_open_for_edit_v1';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Không có app_private.assert_period_open_for_edit_v1 — DỪNG';
  END IF;

  IF position('WP2_PERIOD_ALL_THREE' IN v_def) > 0 THEN
    RAISE NOTICE 'assert_period_open_for_edit_v1 đã vá — bỏ qua';
  ELSE
    IF position(v_anchor_decl IN v_def) = 0
       OR position(v_anchor_tail IN v_def) = 0 THEN
      RAISE EXCEPTION 'assert_period_open_for_edit_v1: không khớp neo — DỪNG, không vá mù';
    END IF;

    v_new := v_def;

    v_new := replace(v_new, v_anchor_decl,
      '  v_handover text;' || chr(10) ||
      '  v_month date;' || chr(10) ||
      '  -- WP2_PERIOD_ALL_THREE' || chr(10) ||
      '  v_billing text;' || chr(10) ||
      '  v_billing_building uuid;' || chr(10) ||
      '  v_billing_month date;' || chr(10) ||
      '  v_item_month date;' || chr(10) ||
      'BEGIN');

    v_new := replace(v_new, v_anchor_tail,
      '        to_char(v_month, ''MM/YYYY''), p_action' || chr(10) ||
      '        USING ERRCODE = ''P0001'';' || chr(10) ||
      '    END IF;' || chr(10) ||
      '  END IF;' || chr(10) ||
      chr(10) ||
      '  -- 4) WP2_PERIOD_ALL_THREE — THÁNG HOÁ ĐƠN đã chốt lợi nhuận.' || chr(10) ||
      '  --    Phiếu thu của hoá đơn tháng 05 hoàn toàn có thể mang voucher_date' || chr(10) ||
      '  --    tháng 07. Doanh thu nằm ở 05; chốt lợi nhuận 05 rồi thì huỷ phiếu' || chr(10) ||
      '  --    này vẫn rút tiền ra khỏi con số đã chia.' || chr(10) ||
      '  IF v_row.invoice_id IS NOT NULL AND COALESCE(v_row.business_result_accounting, true) THEN' || chr(10) ||
      '    SELECT invoice_row.billing_month, invoice_row.building_id' || chr(10) ||
      '      INTO v_billing, v_billing_building' || chr(10) ||
      '    FROM public.invoices invoice_row WHERE invoice_row.id = v_row.invoice_id;' || chr(10) ||
      chr(10) ||
      '    IF v_billing ~ ''^[0-9]{4}-[0-9]{2}$'' THEN' || chr(10) ||
      '      v_billing_month := to_date(v_billing || ''-01'', ''YYYY-MM-DD'');' || chr(10) ||
      '      IF v_billing_month IS DISTINCT FROM date_trunc(''month'', v_row.voucher_date)::date' || chr(10) ||
      '         AND EXISTS (' || chr(10) ||
      '           SELECT 1 FROM public.profit_monthly pm' || chr(10) ||
      '           WHERE pm.building_id = COALESCE(v_billing_building, v_row.building_id)' || chr(10) ||
      '             AND pm.period_month = v_billing_month' || chr(10) ||
      '             AND pm.locked_at IS NOT NULL' || chr(10) ||
      '         ) THEN' || chr(10) ||
      '        RAISE EXCEPTION' || chr(10) ||
      '          ''[PROFIT_LOCKED] Phiếu này gắn với hoá đơn kỳ % — lợi nhuận tháng đó đã chốt và đã chia cho cổ đông, nên không % được. Hãy lập phiếu điều chỉnh ở tháng hiện tại.'',' || chr(10) ||
      '          to_char(v_billing_month, ''MM/YYYY''), p_action' || chr(10) ||
      '          USING ERRCODE = ''P0001'';' || chr(10) ||
      '      END IF;' || chr(10) ||
      '    END IF;' || chr(10) ||
      '  END IF;' || chr(10) ||
      chr(10) ||
      '  -- 5) WP2_PERIOD_ALL_THREE — KỲ DỊCH VỤ CỦA HẠNG MỤC đã chốt lợi nhuận.' || chr(10) ||
      '  --    start_date/end_date của item là cách thứ ba hệ thống gán tiền vào' || chr(10) ||
      '  --    tháng (tiền thuê 15/05→14/06, điện nước theo chu kỳ…). Một item bắc' || chr(10) ||
      '  --    qua tháng đã khoá thì phiếu phải bị chặn dù ngày lập còn trong kỳ mở.' || chr(10) ||
      '  IF COALESCE(v_row.business_result_accounting, true) THEN' || chr(10) ||
      '    SELECT pm.period_month INTO v_item_month' || chr(10) ||
      '    FROM public.income_expense_items item_row' || chr(10) ||
      '    JOIN public.profit_monthly pm' || chr(10) ||
      '      ON pm.building_id = v_row.building_id' || chr(10) ||
      '     AND pm.locked_at IS NOT NULL' || chr(10) ||
      '     AND pm.period_month >= date_trunc(''month'', LEAST(' || chr(10) ||
      '           COALESCE(item_row.start_date, item_row.end_date),' || chr(10) ||
      '           COALESCE(item_row.end_date, item_row.start_date)))::date' || chr(10) ||
      '     AND pm.period_month <= date_trunc(''month'', GREATEST(' || chr(10) ||
      '           COALESCE(item_row.start_date, item_row.end_date),' || chr(10) ||
      '           COALESCE(item_row.end_date, item_row.start_date)))::date' || chr(10) ||
      '    WHERE item_row.income_expense_id = p_voucher' || chr(10) ||
      '      AND COALESCE(item_row.start_date, item_row.end_date) IS NOT NULL' || chr(10) ||
      '      AND pm.period_month IS DISTINCT FROM date_trunc(''month'', v_row.voucher_date)::date' || chr(10) ||
      '    ORDER BY pm.period_month' || chr(10) ||
      '    LIMIT 1;' || chr(10) ||
      chr(10) ||
      '    IF v_item_month IS NOT NULL THEN' || chr(10) ||
      '      RAISE EXCEPTION' || chr(10) ||
      '        ''[PROFIT_LOCKED] Phiếu có hạng mục thuộc kỳ % — lợi nhuận tháng đó đã chốt và đã chia cho cổ đông, nên không % được. Hãy lập phiếu điều chỉnh ở tháng hiện tại.'',' || chr(10) ||
      '        to_char(v_item_month, ''MM/YYYY''), p_action' || chr(10) ||
      '        USING ERRCODE = ''P0001'';' || chr(10) ||
      '    END IF;' || chr(10) ||
      '  END IF;' || chr(10) ||
      'END');

    EXECUTE v_new;
    RAISE NOTICE 'ĐÃ VÁ assert_period_open_for_edit_v1 (billing_month + kỳ item)';
  END IF;
END
$patch_period$;

-- ─────────────────────────────────────────────────────────────────────
-- F. Biên bản chốt sổ phải ghi lại việc SUPER ADMIN KÝ THAY
--
-- confirm_cashbook_closing_v1 cho super admin ký thay người được chỉ định
-- (nhánh `v_actor <> r.confirmer_user_id AND NOT is_super_admin()`), nhưng
-- app_private.cashbook_closures chỉ lưu confirmed_by — đọc lại biên bản sau này
-- KHÔNG phân biệt được "người nhận bàn giao đã đếm và ký" với "quản trị ký hộ".
-- Đúng hai bên xác nhận là toàn bộ giá trị pháp lý của Đợt 6; mất dấu vết này
-- là mất luôn ý nghĩa của nó.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE app_private.cashbook_closures
  ADD COLUMN IF NOT EXISTS signed_by_super_admin boolean NOT NULL DEFAULT false;
ALTER TABLE app_private.cashbook_closures
  ADD COLUMN IF NOT EXISTS designated_confirmer uuid;
ALTER TABLE app_private.cashbook_closures
  ADD COLUMN IF NOT EXISTS signer_note text;

COMMENT ON COLUMN app_private.cashbook_closures.signed_by_super_admin IS
  'TRUE khi người ký KHÔNG phải người được chỉ định nhận bàn giao mà là super admin ký thay.';
COMMENT ON COLUMN app_private.cashbook_closures.designated_confirmer IS
  'Người ĐÁNG LẼ phải ký (cashbook_closure_requests.confirmer_user_id) tại thời điểm chốt.';

DO $patch_confirm$
DECLARE
  v_def text;
  v_new text;
  v_anchor_decl text := '  v_adj uuid;' || chr(10) || 'BEGIN';
  v_anchor_check text :=
    '  IF v_actor <> r.confirmer_user_id AND NOT public.is_super_admin() THEN' || chr(10) ||
    '    RAISE EXCEPTION ''Đề nghị này được gửi cho người khác xác nhận'' USING ERRCODE = ''42501'';' || chr(10) ||
    '  END IF;';
  v_anchor_insert text :=
    '  INSERT INTO app_private.cashbook_closures' || chr(10) ||
    '    (organization_id, cashbook_id, closed_through, counted_balance, system_balance,' || chr(10) ||
    '     basis, proposed_by, confirmed_by)' || chr(10) ||
    '  VALUES' || chr(10) ||
    '    (r.organization_id, r.cashbook_id, r.closed_through, r.counted_balance, v_system,' || chr(10) ||
    '     r.basis, r.proposed_by, v_actor)' || chr(10) ||
    '  RETURNING id INTO v_closure;';
  v_anchor_ret text :=
    '    ''basis'', r.basis,' || chr(10) ||
    '    ''status'', ''CONFIRMED''' || chr(10) ||
    '  );';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'confirm_cashbook_closing_v1';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Không có public.confirm_cashbook_closing_v1 — DỪNG';
  END IF;

  IF position('WP2_PROXY_SIGNATURE' IN v_def) > 0 THEN
    RAISE NOTICE 'confirm_cashbook_closing_v1 đã vá — bỏ qua';
  ELSE
    IF position(v_anchor_decl IN v_def) = 0
       OR position(v_anchor_check IN v_def) = 0
       OR position(v_anchor_insert IN v_def) = 0
       OR position(v_anchor_ret IN v_def) = 0 THEN
      RAISE EXCEPTION 'confirm_cashbook_closing_v1: không khớp neo — DỪNG, không vá mù';
    END IF;

    v_new := v_def;

    v_new := replace(v_new, v_anchor_decl,
      '  v_adj uuid;' || chr(10) ||
      '  -- WP2_PROXY_SIGNATURE' || chr(10) ||
      '  v_on_behalf boolean := false;' || chr(10) ||
      'BEGIN');

    v_new := replace(v_new, v_anchor_check,
      v_anchor_check || chr(10) ||
      '  -- Tới đây, ký-khác-người-được-chỉ-định chỉ còn một khả năng: super admin.' || chr(10) ||
      '  v_on_behalf := (v_actor <> r.confirmer_user_id);');

    v_new := replace(v_new, v_anchor_insert,
      '  INSERT INTO app_private.cashbook_closures' || chr(10) ||
      '    (organization_id, cashbook_id, closed_through, counted_balance, system_balance,' || chr(10) ||
      '     basis, proposed_by, confirmed_by,' || chr(10) ||
      '     signed_by_super_admin, designated_confirmer, signer_note)' || chr(10) ||
      '  VALUES' || chr(10) ||
      '    (r.organization_id, r.cashbook_id, r.closed_through, r.counted_balance, v_system,' || chr(10) ||
      '     r.basis, r.proposed_by, v_actor,' || chr(10) ||
      '     v_on_behalf, r.confirmer_user_id,' || chr(10) ||
      '     CASE WHEN v_on_behalf THEN format(' || chr(10) ||
      '       ''KÝ THAY BỞI SUPER ADMIN — người được chỉ định nhận bàn giao (%s) KHÔNG ký biên bản này.'',' || chr(10) ||
      '       r.confirmer_user_id) END)' || chr(10) ||
      '  RETURNING id INTO v_closure;');

    v_new := replace(v_new, v_anchor_ret,
      '    ''basis'', r.basis,' || chr(10) ||
      '    ''signed_by_super_admin'', v_on_behalf,' || chr(10) ||
      '    ''designated_confirmer'', r.confirmer_user_id,' || chr(10) ||
      '    ''status'', ''CONFIRMED''' || chr(10) ||
      '  );');

    EXECUTE v_new;
    RAISE NOTICE 'ĐÃ VÁ confirm_cashbook_closing_v1 (dấu vết ký thay)';
  END IF;
END
$patch_confirm$;

-- ─────────────────────────────────────────────────────────────────────
-- G. XÁC NHẬN (không phải vá): anon không còn DML trên hai bảng tiền lõi.
--
-- Đợt vá 20260730190000 đã REVOKE INSERT/UPDATE/DELETE/TRUNCATE của anon trên
-- public.invoices và public.payments. Ở đây dựng lại thành ASSERT chạy được để
-- lần sau ai vô tình GRANT lại thì migration này (hoặc lần chạy lại) nổ ngay.
-- ─────────────────────────────────────────────────────────────────────
DO $assert_anon$
DECLARE
  t text;
  p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.invoices', 'public.payments'] LOOP
    FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF has_table_privilege('anon', t, p) THEN
        RAISE EXCEPTION 'anon vẫn còn quyền % trên % — DỪNG', p, t USING ERRCODE = '42501';
      END IF;
    END LOOP;
    IF has_table_privilege('authenticated', t, 'TRUNCATE') THEN
      RAISE EXCEPTION 'authenticated vẫn còn TRUNCATE trên % — DỪNG', t USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RAISE NOTICE 'G OK: anon không còn INSERT/UPDATE/DELETE/TRUNCATE trên invoices & payments';
END
$assert_anon$;

COMMIT;
