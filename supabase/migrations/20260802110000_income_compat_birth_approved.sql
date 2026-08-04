-- ĐỢT B — PHIẾU THU: TẠO XONG LÀ TỰ DUYỆT + TỰ GHI SỔ
--
-- Chủ (01/08/2026): "sau khi tạo thì đã tự duyệt và chi luôn".
--
-- ĐO PROD TRƯỚC KHI VIẾT (01/08/2026):
--   * Thang birth-status của `create_income_expense_v1` ĐÃ cho phiếu THU ra
--     APPROVED thẳng từ 27/07 — đường tạo chính không phải sửa gì.
--   * route `income_expense.posting.v2` = CANONICAL cho CẢ BA org, nên trigger
--     a85b_finance_v2_auto_posting_bridge_ins đã tự ghi sổ ngay trong cùng
--     transaction với INSERT. Bằng chứng: 1295/1324 phiếu thu APPROVED của org
--     thật đang POSTED (29 phiếu còn lại là sổ ẢO → NOT_APPLICABLE, đúng).
--     ⇒ KHÔNG cần thêm trigger auto-post nào.
--   * Gate "≥1 chứng từ FINALIZED" chỉ nằm ở đường ghi sổ THỦ CÔNG
--     (finance_v2_post_manual_voucher); cầu a85b không đòi chứng từ. Quyết định
--     #7 của chủ ("hình ảnh chỉ cần ghi lại chi tiết chỉnh sửa là được") vì thế
--     đã đúng sẵn — không phải tắt gì.
--
-- CÒN ĐÚNG MỘT LỖ: `ie_compat_insert_v2` ép CỨNG mọi phiếu ra UNAPPROVED.
-- Client rơi xuống đường compat khi phiếu không đủ điều kiện canonical
-- (isCanonicalCreateEligible ở src/hooks/income-expenses/mutations.ts:46-54:
-- phiếu định kỳ, không có hạng mục, hạng mục thiếu ngày, ảnh không phải https).
-- Phiếu THU đi đường đó nằm im ở "Chờ duyệt" — trái hẳn quyết định #5, và vì
-- UNAPPROVED nên cầu a85b cũng bỏ qua ⇒ tiền không vào sổ quỹ.
--
-- Vá: đường compat cho phiếu THU ra APPROVED (kéo theo a85b tự ghi sổ trong
-- cùng transaction). Phiếu CHI giữ nguyên UNAPPROVED — không đụng tới, đúng
-- yêu cầu tách hai đường của chủ.

BEGIN;

DO $patch$
DECLARE
  v_def text;
  v_before text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'ie_compat_insert_v2';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ĐỢT B: ie_compat_insert_v2 không tồn tại';
  END IF;
  IF v_def LIKE '%ĐỢT B: phiếu THU tự duyệt%' THEN
    RETURN; -- đã vá
  END IF;

  -- (a) Trạng thái sinh. Phiếu THU: APPROVED + RESOLVED + dấu người duyệt (cầu
  --     a85b đọc approved_by để tìm membership ghi sổ). Phiếu CHI: y như cũ.
  v_before := v_def;
  v_def := replace(v_def,
$old$                  'approval_status', 'UNAPPROVED',
                  'review_state', 'PENDING',$old$,
$new$                  -- ĐỢT B: phiếu THU tự duyệt ngay khi tạo (quyết định #5 của
                  -- chủ 01/08/2026), kéo theo cầu a85b tự ghi sổ trong cùng
                  -- transaction. Phiếu CHI giữ nguyên hàng chờ duyệt.
                  'approval_status',
                    CASE WHEN COALESCE(p_row->>'type','') = 'INCOME'
                         THEN 'APPROVED' ELSE 'UNAPPROVED' END,
                  'review_state',
                    CASE WHEN COALESCE(p_row->>'type','') = 'INCOME'
                         THEN 'RESOLVED' ELSE 'PENDING' END,
                  'approved_by',
                    CASE WHEN COALESCE(p_row->>'type','') = 'INCOME'
                         THEN to_jsonb(auth.uid()) ELSE 'null'::jsonb END,
                  'approved_at',
                    CASE WHEN COALESCE(p_row->>'type','') = 'INCOME'
                         THEN to_jsonb(now()) ELSE 'null'::jsonb END,$new$);
  IF v_def = v_before THEN
    RAISE EXCEPTION 'ĐỢT B: mất neo (a) trạng thái sinh của ie_compat_insert_v2';
  END IF;

  -- (b) Payload trả về phải nói đúng trạng thái thật, nếu không client hiển thị
  --     "Chờ duyệt" cho một phiếu đã ghi sổ xong.
  v_before := v_def;
  v_def := replace(v_def,
    $old$RETURN jsonb_build_object('id', v_id, 'approval_status', 'UNAPPROVED');$old$,
    $new$RETURN jsonb_build_object('id', v_id, 'approval_status',
    (SELECT approval_status FROM public.income_expenses WHERE id = v_id));$new$);
  IF v_def = v_before THEN
    RAISE EXCEPTION 'ĐỢT B: mất neo (b) payload trả về của ie_compat_insert_v2';
  END IF;

  EXECUTE v_def;
END
$patch$;

COMMIT;

NOTIFY pgrst, 'reload schema';
