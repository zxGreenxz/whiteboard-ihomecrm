-- ĐỢT A/B/C — VÁ 6 LỖI DO AUDIT ĐA CHIỀU TÌM RA
--
-- Audit 41 agent (5 lăng kính × find → phản biện độc lập): 36 phát hiện, 18 bị
-- bác bỏ, 18 sống sót. Sáu lỗi dưới đây là phần nặng nhất, mỗi lỗi đều có repro
-- thật trên prod kèm số phơi nhiễm trước khi sửa.
--
-- 1. [NẶNG] reverse_invoice_collection_v5 mất cửa kiểm THÀNH VIÊN. Bỏ gate
--    'thu_tien.undo' ở 20260802100000 kéo theo mất luôn điều kiện "còn là người
--    của tổ chức" (authorize_tenant_action_v3 vốn từ chối bằng
--    MEMBERSHIP_INACTIVE_OR_MISSING). Nhân viên đã bị gỡ khỏi tổ chức vẫn khớp
--    nhánh "chính người đã thu" (user_id trên phiếu cũ không đổi) và hoàn tác
--    được khoản thu cũ — JWT Supabase không bị thu hồi khi gỡ membership.
--    → khôi phục ĐÚNG cửa membership, KHÔNG khôi phục gate quyền (giữ #8).
--
-- 2. [NẶNG] Huỷ phiếu THU đã có phiếu ĐỐI ỨNG còn sống → đảo bút toán LẦN HAI.
--    Cặp thu/chi đối ứng có net = 0 (tiền đã ra khỏi két bằng đường cũ); huỷ
--    tiếp rút thêm một khoản chưa từng vào. Hậu điều kiện sum=0 của lõi mù với
--    ca này vì chỉ cộng bút toán mang posting_subject_id của CHÍNH phiếu.
--    Đo prod: 10 phiếu / 5.235.000đ. → chặn kèm mã phiếu đối ứng; reader trả
--    COUNTER_ALIVE + blocking_voucher_code.
--
-- 3. [NẶNG] Huỷ phiếu THU gắn hoá đơn mà payment_id NULL → tiền rời két, hoá
--    đơn vẫn PAID. recompute_invoice_for_id dẫn xuất paid_amount TỪ payments
--    nên không có gì để tính lại. Đo prod: 9 phiếu / 8.933.839đ ở org THẬT.
--    → từ chối, chỉ sang màn hình hoá đơn/thanh lý; reader INVOICE_NO_PAYMENT.
--
-- 4. [NẶNG] Đổi sổ quỹ phiếu CHƯA ghi sổ (điển hình: phiếu trên SỔ ẢO) SINH
--    TIỀN. Nhánh (a) của cầu a85 không chạy vì không có bút toán để đảo, nhánh
--    (b) vẫn ghi POSTING mới trên sổ thật ⇒ sổ quỹ tăng đúng total_amount mà
--    không đồng nào vào két. Đo prod: 109 phiếu / 374.499.232đ đủ điều kiện.
--    → bắt buộc POSTED + active_posting_id_v2, chặn sổ ĐI là sổ ảo, thêm hậu
--    điều kiện đối xứng (sổ ĐẾN phải nhận đủ).
--
-- 5. [NẶNG] Phiếu THU ĐỊNH KỲ ra đời APPROVED → cron 18:00 hằng ngày
--    (generate_recurring_vouchers) lấy nó làm phiếu mẹ và in phiếu con APPROVED
--    + auto-post cho MỌI kỳ đã trôi qua. Phiếu định kỳ là lớp DUY NHẤT buộc đi
--    đường compat nên Đợt B chạm đúng nó. → phiếu định kỳ vẫn chờ duyệt.
--
-- 6. [VỪA] Nhánh FORFEIT_PAIR bắt theo system_source/notes trong khi handler
--    set_termination_forfeit_status_v1 đòi dòng termination_forfeit_authorizations;
--    8 phiếu "forfeit mồ côi" trên org TEST kẹt vĩnh viễn ở 55000 → HTTP 500 —
--    đúng căn bệnh Đợt A đi chữa. → thu hẹp điều kiện xuống đúng thứ handler
--    chịu được (cả writer lẫn reader); phiếu mồ côi rơi xuống nhánh thủ công.
--
-- ⚠ KHÔNG bọc BEGIN/COMMIT và LUÔN kết thúc bằng SELECT xác nhận: Management
-- API im lặng KHÔNG ghi khi câu lệnh cuối không trả về dòng nào (đã cắn 3 lần
-- trong đợt này, cả replace() lẫn CREATE OR REPLACE nguyên khối). Kiểm catalog
-- sau mỗi lần apply, đừng tin mã trạng thái.

-- ── 1. reverse_invoice_collection_v5: khôi phục cửa kiểm THÀNH VIÊN ──
DO $patch$
DECLARE v_def text; v_before text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='reverse_invoice_collection_v5';
  IF v_def LIKE '%còn là người của tổ chức%' THEN RETURN; END IF;

  v_before := v_def;
  v_def := replace(v_def,
$old$  PERFORM app_private.lock_org_for_decision_v1(v_org);
  -- ĐỢT A: luật huỷ thống nhất (quyết định #8 của chủ 01/08/2026) — huỷ$old$,
$new$  PERFORM app_private.lock_org_for_decision_v1(v_org);

  -- ĐỢT A (vá sau audit): gate 'thu_tien.undo' bị bỏ kéo theo việc mất luôn
  -- cửa kiểm THÀNH VIÊN, vì authorize_tenant_action_v3 vốn từ chối bằng
  -- MEMBERSHIP_INACTIVE_OR_MISSING. Hệ quả: nhân viên đã bị gỡ khỏi tổ chức
  -- vẫn khớp nhánh "chính người đã thu" (user_id trên phiếu cũ không đổi) và
  -- hoàn tác được khoản thu cũ — JWT Supabase không bị thu hồi khi gỡ
  -- membership. Khôi phục ĐÚNG điều kiện "còn là người của tổ chức", không
  -- khôi phục gate quyền (giữ quyết định #8).
  IF NOT public.is_super_admin() AND NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m0
     WHERE m0.user_id = v_actor AND m0.organization_id = v_org
       AND m0.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Bạn không còn thuộc tổ chức này nên không hoàn tác được khoản thu.'
      USING ERRCODE = '42501';
  END IF;
  -- ĐỢT A: luật huỷ thống nhất (quyết định #8 của chủ 01/08/2026) — huỷ$new$);
  IF v_def = v_before THEN RAISE EXCEPTION 'mat neo membership reverse_v5'; END IF;
  EXECUTE v_def;
END $patch$;


-- ── 5. ie_compat_insert_v2: phiếu ĐỊNH KỲ vẫn phải chờ duyệt ─────────
DO $patch$
DECLARE v_def text; v_before text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='ie_compat_insert_v2';
  IF v_def LIKE '%phiếu ĐỊNH KỲ vẫn phải chờ duyệt%' THEN RETURN; END IF;

  v_before := v_def;
  v_def := replace(v_def,
$old$                  'approval_status',
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
                         THEN to_jsonb(now()) ELSE 'null'::jsonb END,$old$,
$new$                  -- ĐỢT B (siết sau audit): phiếu ĐỊNH KỲ vẫn phải chờ duyệt.
                  -- Phiếu định kỳ là lớp DUY NHẤT buộc đi đường compat, và
                  -- generate_recurring_vouchers (cron 18:00 hằng ngày) lấy
                  -- phiếu mẹ theo approval_status='APPROVED' rồi sinh phiếu con
                  -- APPROVED + auto-post cho MỌI kỳ đã trôi qua. Cho phiếu mẹ
                  -- ra APPROVED ngay = mở vòi in tiền qua đêm cho các kỳ quá
                  -- khứ. Người lập phải xác nhận trước khi bật vòi.
                  'approval_status',
                    CASE WHEN COALESCE(p_row->>'type','') = 'INCOME'
                          AND COALESCE(p_row->>'repeat_cycle','NONE') = 'NONE'
                         THEN 'APPROVED' ELSE 'UNAPPROVED' END,
                  'review_state',
                    CASE WHEN COALESCE(p_row->>'type','') = 'INCOME'
                          AND COALESCE(p_row->>'repeat_cycle','NONE') = 'NONE'
                         THEN 'RESOLVED' ELSE 'PENDING' END,
                  'approved_by',
                    CASE WHEN COALESCE(p_row->>'type','') = 'INCOME'
                          AND COALESCE(p_row->>'repeat_cycle','NONE') = 'NONE'
                         THEN to_jsonb(auth.uid()) ELSE 'null'::jsonb END,
                  'approved_at',
                    CASE WHEN COALESCE(p_row->>'type','') = 'INCOME'
                          AND COALESCE(p_row->>'repeat_cycle','NONE') = 'NONE'
                         THEN to_jsonb(now()) ELSE 'null'::jsonb END,$new$);
  IF v_def = v_before THEN RAISE EXCEPTION 'mat neo CASE trang thai sinh'; END IF;
  EXECUTE v_def;
END $patch$;


-- ── 2/3/4/6. Ba hàm của đợt này — viết lại NGUYÊN KHỐI đúng bản đang chạy ──
CREATE OR REPLACE FUNCTION public.cancel_income_voucher_v1(p_voucher uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v public.income_expenses%ROWTYPE;
  v_actor uuid := auth.uid();
  v_is_super boolean;
  v_membership uuid;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_flow text;
  v_coll public.invoice_payment_collections%ROWTYPE;
  v_inv public.invoices%ROWTYPE;
  v_lot public.customer_credit_lots%ROWTYPE;
  v_blocker record;
  v_core jsonb;
  v_counter_code text;
  v_paid numeric;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < 8 THEN
    RAISE EXCEPTION 'Phải ghi lý do huỷ (ít nhất 8 ký tự) để còn đối soát về sau.'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v FROM public.income_expenses
   WHERE id = p_voucher AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;

  -- Kiểm THÀNH VIÊN ngay sau khi tìm thấy phiếu: mọi thông điệp phía dưới (tên
  -- sổ quỹ, mã phiên bàn giao, mã phiếu chặn) đều là thông tin của tổ chức sở
  -- hữu phiếu — người ngoài không được nghe. Đọc thẳng bảng membership, KHÔNG
  -- join qua bảng có RLS (nếu không phép đo rò chéo tổ chức sẽ báo sạch nhầm).
  v_is_super := public.is_super_admin();
  SELECT m.id INTO v_membership FROM public.organization_memberships m
   WHERE m.user_id = v_actor AND m.organization_id = v.organization_id
     AND m.status = 'ACTIVE' LIMIT 1;
  IF v_membership IS NULL AND NOT v_is_super THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
  END IF;

  IF v.type <> 'INCOME' THEN
    RAISE EXCEPTION 'Đây là phiếu CHI — huỷ ở luồng phiếu chi, cửa này chỉ dành cho phiếu thu.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Luật #8 (chủ chốt 01/08/2026, áp cho CẢ trang Thu chi lẫn trang Thu tiền):
  -- chỉ chính người đã thu/lập phiếu, chủ tổ chức, hoặc super admin.
  IF NOT v_is_super
     AND NOT app_private.is_org_owner_v1(v.organization_id, v_actor)
     AND v.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Chỉ người đã thu khoản này (hoặc chủ tổ chức) mới huỷ được. Nhờ người thu hoặc chủ tổ chức thực hiện.'
      USING ERRCODE = '42501';
  END IF;

  -- Đã huỷ rồi thì không còn gì để làm. Nhánh này đứng SAU khối quyền: ma trận
  -- quyền 02/08/2026 cho thấy đặt trước sẽ trả HTTP 200 cho người KHÔNG có
  -- quyền, lệch với reader (reader nói ALREADY_CANCELLED cho mọi người, nhưng
  -- mã 200 của writer thì nói sai về quyền).
  IF v.approval_status = 'CANCELLED' THEN
    RETURN jsonb_build_object('id', p_voucher, 'changed', false, 'reason', 'đã huỷ trước đó');
  END IF;

  -- Ba khoá thời gian — GIỮ NGUYÊN theo quyết định #2 của chủ.
  PERFORM app_private.assert_period_open_for_edit_v1(p_voucher, 'huỷ');

  SELECT o.flow_kind INTO v_flow
  FROM app_private.income_expense_flow_ownership o
  WHERE o.income_expense_id = p_voucher;

  -- ══ NHÁNH 1: khoản thu hoá đơn V5 (đi theo cả ĐỢT THU) ═════════════
  -- Bộ đếm toàn vẹn count_invalid_payment_reversals_in_place_v1 định nghĩa
  -- bất biến ở mức COLLECTION (collection phải REVERSED, payment phải trỏ về
  -- đúng collection…). Huỷ lẻ MỘT phiếu của đợt thu nhiều phiếu sẽ làm bộ đếm
  -- khác 0 và kẹt vĩnh viễn assert_accounting_feature_activation_v1.
  -- ⇒ luôn đi qua reverse_invoice_collection_v5 nguyên đợt.
  IF v.payment_collection_id IS NOT NULL OR v_flow = 'INVOICE_COLLECTION_V5' THEN
    SELECT * INTO v_coll FROM public.invoice_payment_collections
     WHERE id = v.payment_collection_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Phiếu thu gắn đợt thu hoá đơn nhưng không tìm thấy đợt thu — báo quản trị.'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_coll.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'Đợt thu của phiếu này đã được hoàn tác trước đó.' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_inv FROM public.invoices WHERE id = v_coll.invoice_id;

    -- LIFO — GIỮ theo quyết định #9. reverse_v5 cũng chặn ở trong, nhưng câu
    -- của nó không nói phải huỷ phiếu NÀO trước; ở đây nêu đích danh.
    IF abs(COALESCE(v_inv.paid_amount, 0)
           - (v_coll.expected_paid_amount + v_coll.applied_amount)) >= 0.01 THEN
      SELECT ie.code, ie.voucher_date INTO v_blocker
      FROM public.invoice_payment_collections c2
      JOIN public.invoice_payment_tenders t2 ON t2.collection_id = c2.id
      JOIN public.income_expenses ie ON ie.id = t2.voucher_id
      WHERE c2.invoice_id = v_coll.invoice_id
        AND c2.status = 'ACTIVE'
        AND c2.id <> v_coll.id
      ORDER BY c2.collection_date DESC, c2.created_at DESC, ie.code DESC
      LIMIT 1;

      IF v_blocker.code IS NOT NULL THEN
        RAISE EXCEPTION 'Phải huỷ khoản thu mới hơn trước: phiếu % ngày %. Hệ thống gỡ khoản thu theo thứ tự ngược thời gian để công nợ của hoá đơn không bị lệch.',
          v_blocker.code, to_char(v_blocker.voucher_date, 'DD/MM/YYYY')
          USING ERRCODE = 'P0001';
      END IF;
      RAISE EXCEPTION 'Hoá đơn còn khoản thu mới hơn phải huỷ trước (thứ tự ngược thời gian).'
        USING ERRCODE = 'P0001';
    END IF;

    -- Tiền thừa đã đem cấn sang hoá đơn khác thì máy không tự gỡ được.
    SELECT * INTO v_lot FROM public.customer_credit_lots
     WHERE source_collection_id = v_coll.id;
    IF FOUND AND v_lot.remaining_amount <> v_lot.amount THEN
      RAISE EXCEPTION 'Tiền thừa của lần thu này đã được cấn vào hoá đơn khác — phải gỡ khoản đã cấn trước rồi mới huỷ được.'
        USING ERRCODE = 'P0001';
    END IF;

    -- Ngày hoàn tác: reverse_v5 chặn cả hai đầu (không sớm hơn ngày thu, không
    -- ở tương lai). Kẹp vào khoảng hợp lệ thay vì để nó ném 22023.
    PERFORM public.reverse_invoice_collection_v5(
      v_coll.id,
      GREATEST(LEAST(public.org_today_v1(v.organization_id), CURRENT_DATE),
               v_coll.collection_date),
      v_reason,
      'inccancel-' || replace(p_voucher::text, '-', '') || '-' || substr(md5(v_reason), 1, 8));

    RETURN jsonb_build_object(
      'id', p_voucher, 'changed', true, 'mode', 'COLLECTION',
      'collection_id', v_coll.id);
  END IF;

  -- ══ NHÁNH 2: cặp phiếu bỏ cọc (thu + chi cấn nhau) ═════════════════
  -- Huỷ một chân mà để chân kia sống thì hai sổ lệch nhau vĩnh viễn; hàm
  -- chuyên trách khoá và lật CẢ CẶP theo đúng thứ tự.
  -- Điều kiện phải HẸP ĐÚNG bằng thứ handler chịu được: set_termination_forfeit_status_v1
  -- mở đầu bằng SELECT … FROM termination_forfeit_authorizations và ném 55000
  -- 'Voucher is not a termination forfeit pair' nếu không có dòng. Bắt theo
  -- system_source/notes như trước làm phiếu forfeit MỒ CÔI (có nhãn nhưng không
  -- có dòng cặp — 8 phiếu như vậy trên org TEST) kẹt vĩnh viễn ở HTTP 500.
  -- Phiếu mồ côi nay rơi xuống nhánh 3 và huỷ được bình thường.
  IF EXISTS (SELECT 1 FROM app_private.termination_forfeit_authorizations f
              WHERE f.revenue_voucher_id = p_voucher OR f.offset_voucher_id = p_voucher) THEN
    PERFORM public.set_termination_forfeit_status_v1(p_voucher, 'CANCELLED');
    RETURN jsonb_build_object('id', p_voucher, 'changed', true, 'mode', 'FORFEIT_PAIR');
  END IF;

  -- ══ NHÁNH 3: mọi phiếu thu còn lại ═════════════════════════════════
  -- Thủ công, thu cọc hợp đồng, thu hoá đơn LEGACY (system_source
  -- 'invoice.payment' — 1542 phiếu, nhóm lớn nhất), thu thanh lý…
  -- Không còn hỏi luồng nào sở hữu phiếu: "huỷ ở đâu cũng là huỷ".
  IF v.reversal_of_income_expense_id IS NOT NULL THEN
    RAISE EXCEPTION 'Đây là bút toán đối ứng của một phiếu khác — huỷ phiếu gốc chứ không huỷ riêng phiếu này.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Đã có phiếu ĐỐI ỨNG còn sống ⇒ tiền đã ra khỏi két bằng đường cũ rồi. Huỷ
  -- tiếp ở đây sẽ đảo bút toán LẦN HAI và rút khỏi sổ quỹ một khoản chưa từng
  -- vào. Hậu điều kiện sum=0 của lõi không thấy được vì nó chỉ cộng bút toán
  -- mang posting_subject_id của CHÍNH phiếu này, còn phiếu đối ứng mang id khác.
  SELECT c.code INTO v_counter_code
  FROM public.income_expenses c
  WHERE c.reversal_of_income_expense_id = p_voucher
    AND c.deleted_at IS NULL
    AND c.approval_status <> 'CANCELLED'
  LIMIT 1;
  IF v_counter_code IS NOT NULL THEN
    RAISE EXCEPTION 'Khoản thu này đã được hoàn tác bằng phiếu chi đối ứng % — huỷ phiếu đối ứng đó thay vì huỷ lại ở đây.',
      v_counter_code USING ERRCODE = 'P0001';
  END IF;

  -- Gắn hoá đơn nhưng KHÔNG có khoản thanh toán liên kết: đảo bút toán được
  -- (tiền rời két) nhưng recompute_invoice_for_id dẫn xuất paid_amount TỪ
  -- payments nên hoá đơn vẫn PAID — sổ quỹ nói "không thu", công nợ nói "đã
  -- thu đủ". Từ chối thay vì để lệch âm thầm.
  IF v.invoice_id IS NOT NULL AND v.payment_id IS NULL THEN
    RAISE EXCEPTION 'Khoản thu này gắn hoá đơn nhưng không có khoản thanh toán liên kết — huỷ ở màn hình hoá đơn/thanh lý để công nợ được tính lại đúng.'
      USING ERRCODE = 'P0001';
  END IF;

  -- begin/end_accounting_chain_write_v1: guard_payment_canonical_link chỉ cho
  -- core-writer đổi payments.reversed_at.
  PERFORM app_private.begin_accounting_chain_write_v1();

  v_core := app_private.cancel_income_voucher_core_v1(p_voucher, v_reason, v_actor, v_membership);

  -- Hoá đơn mở lại nợ (quyết định #4). recompute_invoice_for_id dẫn xuất
  -- paid_amount TỪ payments chứ không đọc trạng thái phiếu, nên phải đánh dấu
  -- khoản thanh toán. Đánh dấu `reversed_at` thay vì xoá — giữ dấu vết, đúng
  -- cách đường thu tiền V5 đang làm (client cũ xoá thẳng payments).
  IF v.payment_id IS NOT NULL THEN
    UPDATE public.payments
       SET reversed_at = COALESCE(reversed_at, clock_timestamp()),
           updated_at = now()
     WHERE id = v.payment_id;
  END IF;

  PERFORM app_private.end_accounting_chain_write_v1();

  -- Trigger trg_payments_recompute_invoice / trg_voucher_recompute_invoice /
  -- trg_ie_recompute_contract_deposit đã tự chạy, nhưng gọi lại tường minh cho
  -- ca phiếu gắn hoá đơn mà KHÔNG có payment (thu cọc ghi thẳng vào hợp đồng).
  IF v.invoice_id IS NOT NULL THEN
    PERFORM public.recompute_invoice_for_id(v.invoice_id);
  END IF;
  IF v.contract_id IS NOT NULL THEN
    PERFORM public.recompute_contract_deposit_paid(v.contract_id);
  END IF;

  RETURN v_core || jsonb_build_object('mode', 'MANUAL');
END
$function$
;

CREATE OR REPLACE FUNCTION public.can_cancel_income_voucher_v1(p_ids uuid[])
 RETURNS TABLE(id uuid, eligible boolean, mode text, reason_code text, blocking_voucher_code text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v public.income_expenses%ROWTYPE;
  v_actor uuid := auth.uid();
  v_is_super boolean := public.is_super_admin();
  v_flow text;
  v_coll public.invoice_payment_collections%ROWTYPE;
  v_inv public.invoices%ROWTYPE;
  v_lot public.customer_credit_lots%ROWTYPE;
  v_id uuid;
  v_code text;
  v_mode text;
  v_block text;
BEGIN
  IF v_actor IS NULL OR p_ids IS NULL THEN RETURN; END IF;

  FOREACH v_id IN ARRAY p_ids LOOP
    id := v_id;
    eligible := false; mode := NULL; reason_code := NULL; blocking_voucher_code := NULL;

    SELECT * INTO v FROM public.income_expenses WHERE income_expenses.id = v_id;
    -- Bỏ qua IM LẶNG phiếu của tổ chức khác: trả về dòng "không đủ điều kiện"
    -- cũng đã là xác nhận phiếu đó tồn tại.
    CONTINUE WHEN NOT FOUND;
    CONTINUE WHEN NOT v_is_super AND NOT EXISTS (
      SELECT 1 FROM public.organization_memberships m
       WHERE m.user_id = v_actor AND m.organization_id = v.organization_id
         AND m.status = 'ACTIVE');

    IF v.deleted_at IS NOT NULL THEN reason_code := 'DELETED';
    ELSIF v.type <> 'INCOME' THEN reason_code := 'NOT_INCOME';
    ELSIF v.approval_status = 'CANCELLED' THEN reason_code := 'ALREADY_CANCELLED';
    ELSIF NOT v_is_super
          AND NOT app_private.is_org_owner_v1(v.organization_id, v_actor)
          AND v.user_id IS DISTINCT FROM v_actor THEN
      reason_code := 'NOT_OWNER';
    ELSE
      v_block := app_private.period_block_code_v1(v_id);
      IF v_block IS NOT NULL THEN
        reason_code := v_block;   -- CASHBOOK_CLOSED / HANDOVER_LOCKED / PROFIT_LOCKED
      ELSE
        SELECT o.flow_kind INTO v_flow FROM app_private.income_expense_flow_ownership o
         WHERE o.income_expense_id = v_id;

        IF v.payment_collection_id IS NOT NULL OR v_flow = 'INVOICE_COLLECTION_V5' THEN
          v_mode := 'COLLECTION';
          SELECT * INTO v_coll FROM public.invoice_payment_collections
           WHERE invoice_payment_collections.id = v.payment_collection_id;
          IF NOT FOUND OR v_coll.status <> 'ACTIVE' THEN
            reason_code := 'ALREADY_CANCELLED';
          ELSE
            SELECT * INTO v_inv FROM public.invoices WHERE invoices.id = v_coll.invoice_id;
            IF abs(COALESCE(v_inv.paid_amount, 0)
                   - (v_coll.expected_paid_amount + v_coll.applied_amount)) >= 0.01 THEN
              reason_code := 'LIFO_ORDER';
              SELECT ie.code INTO v_code
              FROM public.invoice_payment_collections c2
              JOIN public.invoice_payment_tenders t2 ON t2.collection_id = c2.id
              JOIN public.income_expenses ie ON ie.id = t2.voucher_id
              WHERE c2.invoice_id = v_coll.invoice_id AND c2.status = 'ACTIVE'
                AND c2.id <> v_coll.id
              ORDER BY c2.collection_date DESC, c2.created_at DESC, ie.code DESC
              LIMIT 1;
              blocking_voucher_code := v_code;
            ELSE
              SELECT * INTO v_lot FROM public.customer_credit_lots
               WHERE source_collection_id = v_coll.id;
              IF FOUND AND v_lot.remaining_amount <> v_lot.amount THEN
                reason_code := 'CREDIT_SPENT';
              ELSE
                eligible := true;
              END IF;
            END IF;
          END IF;
        ELSIF EXISTS (SELECT 1 FROM app_private.termination_forfeit_authorizations f
                       WHERE f.revenue_voucher_id = v_id OR f.offset_voucher_id = v_id) THEN
          -- HẸP ĐÚNG bằng writer: bắt theo system_source/notes như trước làm
          -- nút sáng cho phiếu forfeit MỒ CÔI (có nhãn nhưng không có dòng cặp)
          -- rồi writer ném 55000 → HTTP 500. Phiếu mồ côi nay là MANUAL.
          v_mode := 'FORFEIT_PAIR';
          eligible := true;
        ELSIF v.reversal_of_income_expense_id IS NOT NULL THEN
          v_mode := 'MANUAL';
          reason_code := 'IS_REVERSAL';
        ELSIF EXISTS (SELECT 1 FROM public.income_expenses c
                       WHERE c.reversal_of_income_expense_id = v_id
                         AND c.deleted_at IS NULL
                         AND c.approval_status <> 'CANCELLED') THEN
          -- Đã hoàn tác bằng phiếu chi đối ứng: huỷ tiếp là đảo bút toán lần hai.
          v_mode := 'MANUAL';
          reason_code := 'COUNTER_ALIVE';
          SELECT c.code INTO blocking_voucher_code
          FROM public.income_expenses c
          WHERE c.reversal_of_income_expense_id = v_id
            AND c.deleted_at IS NULL AND c.approval_status <> 'CANCELLED'
          LIMIT 1;
        ELSIF v.invoice_id IS NOT NULL AND v.payment_id IS NULL THEN
          -- Đảo được bút toán nhưng hoá đơn không đổi (paid_amount dẫn xuất từ
          -- payments) ⇒ két lệch công nợ. Writer từ chối, reader nói trước.
          v_mode := 'MANUAL';
          reason_code := 'INVOICE_NO_PAYMENT';
        ELSE
          v_mode := 'MANUAL';
          eligible := true;
        END IF;
      END IF;
    END IF;

    mode := v_mode;
    v_mode := NULL; v_code := NULL; v_flow := NULL;
    RETURN NEXT;
  END LOOP;
END
$function$
;

CREATE OR REPLACE FUNCTION public.move_income_voucher_cashbook_v1(p_voucher uuid, p_new_account uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v public.income_expenses%ROWTYPE;
  v_actor uuid := auth.uid();
  v_is_super boolean;
  v_bypass boolean;
  v_membership uuid;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_flow text;
  v_old_acc public.accounts%ROWTYPE;
  v_new_acc public.accounts%ROWTYPE;
  v_to_kind text;
  v_after public.income_expenses%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < 8 THEN
    RAISE EXCEPTION 'Phải ghi lý do đổi sổ quỹ (ít nhất 8 ký tự) để còn đối soát về sau.'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v FROM public.income_expenses
   WHERE id = p_voucher AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;

  v_is_super := public.is_super_admin();
  SELECT m.id INTO v_membership FROM public.organization_memberships m
   WHERE m.user_id = v_actor AND m.organization_id = v.organization_id
     AND m.status = 'ACTIVE' LIMIT 1;
  IF v_membership IS NULL AND NOT v_is_super THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
  END IF;

  IF v.type <> 'INCOME' THEN
    RAISE EXCEPTION 'Cửa này chỉ đổi sổ quỹ cho phiếu THU.' USING ERRCODE = 'P0001';
  END IF;
  IF v.approval_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Phiếu đã huỷ — không đổi sổ quỹ được nữa.' USING ERRCODE = 'P0001';
  END IF;
  IF v.account_id IS NULL THEN
    RAISE EXCEPTION 'Phiếu chưa có sổ quỹ — dùng chức năng duyệt để chọn sổ lần đầu.'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_new_account IS NULL OR p_new_account = v.account_id THEN
    RAISE EXCEPTION 'Hãy chọn một sổ quỹ khác sổ hiện tại.' USING ERRCODE = '22023';
  END IF;

  -- Phiếu do luồng NGHIỆP VỤ khác sở hữu: sổ quỹ đi theo nghiệp vụ nguồn.
  -- CANONICAL_INCOME_EXPENSE (phiếu thủ công tạo qua writer canonical) KHÔNG
  -- thuộc nhóm này — nó chính là phiếu mà chức năng này phục vụ.
  SELECT o.flow_kind INTO v_flow
  FROM app_private.income_expense_flow_ownership o
  WHERE o.income_expense_id = p_voucher;
  IF v_flow IS NOT NULL AND v_flow <> 'CANONICAL_INCOME_EXPENSE' THEN
    RAISE EXCEPTION 'Phiếu thu này gắn với nghiệp vụ % nên sổ quỹ đi theo nghiệp vụ đó. Muốn đổi sổ thì huỷ khoản thu rồi thu lại vào đúng sổ.',
      v_flow USING ERRCODE = 'P0001';
  END IF;
  IF v.payment_collection_id IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu thu này thuộc một đợt thu hoá đơn — sổ quỹ đi theo đợt thu. Muốn đổi sổ thì huỷ khoản thu rồi thu lại vào đúng sổ.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Phải ĐANG ghi sổ thì mới có gì để chuyển. Không có hai chặn dưới đây thì
  -- phiếu UNPOSTED/NOT_APPLICABLE (điển hình: phiếu nằm trên SỔ ẢO) đi qua cửa
  -- này sẽ SINH TIỀN: nhánh (a) của cầu a85 không chạy vì không có bút toán để
  -- đảo, còn nhánh (b) thấy phiếu APPROVED + sổ mới là sổ thật nên ghi một
  -- POSTING mới ⇒ sổ quỹ thật tăng đúng total_amount mà không đồng nào vào két.
  -- Đo trên prod: 109 phiếu THU đang nằm sổ ảo đủ điều kiện đi cửa này.
  IF COALESCE(v.posting_status, 'UNPOSTED') <> 'POSTED' OR v.active_posting_id_v2 IS NULL THEN
    RAISE EXCEPTION 'Phiếu chưa ghi sổ nên không có bút toán nào để chuyển. Muốn ghi nhận tiền vào sổ quỹ thì lập phiếu thu thật.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_old_acc FROM public.accounts WHERE id = v.account_id;
  IF COALESCE(v_old_acc.is_virtual, false) THEN
    RAISE EXCEPTION 'Phiếu đang ghi trên sổ nội bộ (sổ ảo) — chuyển sang sổ quỹ thật ở đây là ghi nhận tiền mới, không phải đổi sổ. Hãy lập phiếu thu thật.'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_new_acc FROM public.accounts WHERE id = p_new_account;
  IF v_new_acc.id IS NULL
     OR v_new_acc.organization_id IS DISTINCT FROM v.organization_id
     OR v_new_acc.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Sổ quỹ đích không tồn tại trong tổ chức này.' USING ERRCODE = '22023';
  END IF;
  -- Sổ ẢO không có bút toán tiền mặt: cầu a85 sẽ đảo sổ cũ rồi KHÔNG ghi lại,
  -- phiếu rơi vào trạng thái lửng. Chặn thẳng thay vì để lệch âm thầm.
  IF COALESCE(v_new_acc.is_virtual, false) THEN
    RAISE EXCEPTION 'Không chuyển phiếu đã ghi sổ sang sổ ảo được — chọn một sổ quỹ thật.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Quyền (quyết định #10): rút tiền KHỎI sổ nào thì phải đang GIỮ sổ đó;
  -- sổ nhận chỉ cần GIỮ hoặc BIẾT. Chủ tổ chức / super admin đi thẳng.
  -- Hai lớp, cố ý KHÔNG bọc BEGIN...EXCEPTION quanh assert (bọc sẽ nuốt cả lỗi
  -- hệ thống — deadlock, 25006 — rồi báo nhầm thành "thiếu quyền"):
  --   lớp 1  đọc thẳng possession để có câu tiếng Việt nêu đích danh tên sổ;
  --   lớp 2  assert_cashbook_access_v2 để lớp DENY phủ (thu hồi quyền tường
  --          minh) vẫn có tiếng nói — kind truyền vào là kind mình THỰC SỰ có
  --          nên hàm không bao giờ ném vì lý do "sai kind".
  v_bypass := v_is_super OR app_private.is_org_owner_v1(v.organization_id, v_actor);
  IF NOT v_bypass THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.cashbook_possession_bindings b
      WHERE b.organization_id = v.organization_id
        AND b.cashbook_id = v.account_id
        AND b.membership_id = v_membership
        AND b.valid_to IS NULL
        AND b.possession_kind = 'CUSTODIAN'
    ) THEN
      RAISE EXCEPTION 'Bạn không phải người giữ sổ "%" nên không chuyển tiền ra khỏi sổ đó được.',
        COALESCE(v_old_acc.name, 'không rõ') USING ERRCODE = '42501';
    END IF;
    PERFORM app_private.assert_cashbook_access_v2(
      v.organization_id, v.account_id, 'CUSTODIAN', v_membership);

    SELECT b.possession_kind INTO v_to_kind
    FROM public.cashbook_possession_bindings b
    WHERE b.organization_id = v.organization_id
      AND b.cashbook_id = p_new_account
      AND b.membership_id = v_membership
      AND b.valid_to IS NULL
      AND b.possession_kind IN ('CUSTODIAN', 'KNOWER')
    ORDER BY (b.possession_kind = 'CUSTODIAN') DESC
    LIMIT 1;
    IF v_to_kind IS NULL THEN
      RAISE EXCEPTION 'Sổ quỹ "%" không nằm trong các sổ bạn giữ hoặc biết — nhờ người giữ sổ chia sẻ sổ cho bạn trước.',
        COALESCE(v_new_acc.name, 'không rõ') USING ERRCODE = '42501';
    END IF;
    PERFORM app_private.assert_cashbook_access_v2(
      v.organization_id, p_new_account, v_to_kind, v_membership);
  END IF;

  -- Ba khoá thời gian, xét trên trạng thái HIỆN TẠI (sổ đi). Trigger
  -- income_expenses_check_lock sẽ xét lại cả sổ ĐẾN khi UPDATE chạy.
  PERFORM app_private.assert_period_open_for_edit_v1(p_voucher, 'đổi sổ quỹ');

  -- Năng lực hẹp: qua được trigger đóng băng nhưng KHÔNG tắt cầu a85, để
  -- chính a85 đảo bút toán sổ cũ rồi ghi generation mới ở sổ mới (kèm đủ dòng
  -- MAIN/CHANGE/ROUNDING). Xem migration này phần (2).
  PERFORM app_private.begin_ie_flex_write_v1(p_voucher, 'CASHBOOK_MOVE');

  UPDATE public.income_expenses
     SET account_id = p_new_account,
         updated_at = now()
   WHERE id = p_voucher;

  PERFORM app_private.end_ie_flex_write_v1(p_voucher);

  SELECT * INTO v_after FROM public.income_expenses WHERE id = p_voucher;

  -- Hậu điều kiện: tiền phải rời hẳn sổ cũ và có mặt đủ ở sổ mới.
  IF COALESCE(v.posting_status, 'UNPOSTED') = 'POSTED'
     AND COALESCE(v_after.posting_status, '') <> 'POSTED' THEN
    RAISE EXCEPTION 'Đổi sổ nhưng phiếu không ghi sổ lại được (trạng thái %) — dừng lại, báo quản trị.',
      COALESCE(v_after.posting_status, 'không rõ') USING ERRCODE = '55000';
  END IF;
  IF COALESCE((
       SELECT sum(l.signed_amount) FROM public.income_expense_posting_lines l
       JOIN public.income_expense_postings p ON p.id = l.posting_id
       WHERE p.posting_subject_kind = 'VOUCHER' AND p.posting_subject_id = p_voucher
         AND l.account_id = v.account_id), 0) <> 0 THEN
    RAISE EXCEPTION 'Đổi sổ nhưng sổ quỹ cũ vẫn còn số dư của phiếu này — dừng lại, báo quản trị.'
      USING ERRCODE = '55000';
  END IF;
  IF COALESCE((
       SELECT sum(l.signed_amount) FROM public.income_expense_posting_lines l
       JOIN public.income_expense_postings p ON p.id = l.posting_id
       WHERE p.posting_subject_kind = 'VOUCHER' AND p.posting_subject_id = p_voucher
         AND l.account_id = p_new_account), 0) = 0 THEN
    RAISE EXCEPTION 'Đổi sổ nhưng sổ quỹ mới không nhận được khoản nào — dừng lại, báo quản trị.'
      USING ERRCODE = '55000';
  END IF;

  PERFORM app_private.append_income_expense_event_v1(
    v.organization_id, p_voucher, 'CASHBOOK_MOVED', v_actor, NULL,
    COALESCE(v_old_acc.name, v.account_id::text),
    COALESCE(v_new_acc.name, p_new_account::text),
    v_reason);

  RETURN jsonb_build_object(
    'id', p_voucher, 'changed', true,
    'from_account_id', v.account_id, 'from_account_name', v_old_acc.name,
    'to_account_id', p_new_account, 'to_account_name', v_new_acc.name,
    'posting_status', v_after.posting_status);
END
$function$
;


REVOKE ALL ON FUNCTION public.cancel_income_voucher_v1(uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_income_voucher_v1(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.can_cancel_income_voucher_v1(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.can_cancel_income_voucher_v1(uuid[]) TO authenticated;
REVOKE ALL ON FUNCTION public.move_income_voucher_cashbook_v1(uuid, uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.move_income_voucher_cashbook_v1(uuid, uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- Cửa xác nhận (BẮT BUỘC — xem cảnh báo đầu file). Cả 6 cột phải là true.
SELECT
  (SELECT (pg_get_functiondef(p.oid) LIKE '%còn là người của tổ chức%')
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='reverse_invoice_collection_v5')::text AS va1_membership,
  (SELECT (pg_get_functiondef(p.oid) LIKE '%phiếu chi đối ứng%')
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='cancel_income_voucher_v1')::text AS va2_counter,
  (SELECT (pg_get_functiondef(p.oid) LIKE '%không có khoản thanh toán liên kết%')
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='cancel_income_voucher_v1')::text AS va3_invoice,
  (SELECT (pg_get_functiondef(p.oid) LIKE '%không có bút toán nào để chuyển%')
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='move_income_voucher_cashbook_v1')::text AS va4_sinh_tien,
  (SELECT (pg_get_functiondef(p.oid) LIKE '%phiếu ĐỊNH KỲ vẫn phải chờ duyệt%')
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='ie_compat_insert_v2')::text AS va5_dinh_ky,
  (SELECT (pg_get_functiondef(p.oid) LIKE '%HẸP ĐÚNG bằng writer%')
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='can_cancel_income_voucher_v1')::text AS va6_forfeit;
