-- =====================================================================
-- NỐI TRẦN ĐIỆN/NƯỚC vào pay_utility_bill — Đợt 2 của lộ trình 28/08.
--
-- Đo trước khi viết: utility_ceiling_check_v1 (20260801040000) có 0 caller
-- trên production — chủ công bố trần thì cũng không gì đọc. Trong khi đó
-- pay_utility_bill sinh phiếu APPROVED (+ posting) trực tiếp: 91/91 phiếu
-- utility.bill không cancelled đều APPROVED+POSTED, không hàng rào số tiền
-- nào ngoài ngưỡng tự duyệt chung.
--
-- Thay đổi DUY NHẤT: vượt trần ⇒ phiếu hạ về UNAPPROVED (kể cả người có quyền
-- duyệt — họ duyệt lại một chạm nhưng phải NHÌN cảnh báo), lý do nối vào notes
-- SAU insert (khối INSERT là MẪU NEO 20260724120000, giữ verbatim). Chưa công
-- bố trần ⇒ NO_RULE ⇒ hành vi y hệt hôm nay. Mọi chốt cũ (B1 chống trùng, B2
-- bắt khai công tơ, ngưỡng, maker-can-approve) giữ nguyên và tự kiểm lại.
-- =====================================================================
BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('app_private.utility_ceiling_check_v1(uuid,uuid,text,date,numeric,numeric)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu utility_ceiling_check_v1 — chạy 20260801040000 trước. DỪNG.';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.pay_utility_bill(p_building_id uuid, p_utility_type text, p_amount numeric, p_period_month text, p_voucher_date date DEFAULT NULL::date, p_provider_code text DEFAULT NULL::text, p_account_holder text DEFAULT NULL::text, p_account_id uuid DEFAULT NULL::uuid, p_attachments jsonb DEFAULT NULL::jsonb, p_utility_account_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private'
AS $function$
DECLARE
  v_owner   uuid;
  v_acc     uuid;
  v_meter   uuid;
  v_type    uuid;
  v_caller  text;
  v_type_nm text;
  v_vdate   date;
  v_p_start date;
  v_p_end   date;
  v_voucher uuid;
  v_code    text;
  v_total   numeric;
  v_org     uuid;        -- t5_28: org của toà để đọc ngưỡng
  v_threshold numeric;   -- ngưỡng tự duyệt phiếu chi (nếu có)
  v_status  text;        -- trạng thái sinh theo ngưỡng
  v_appr_by uuid;
  v_appr_at timestamptz;
  v_kind_vn text;        -- Slice −1: "điện"/"nước" cho câu lỗi
  v_dup_code   text;     -- Slice −1 B1: phiếu đã có của đúng slot này
  v_dup_amount numeric;
  v_dup_status text;
  v_meter_code text;     -- Slice −1 B1: mã khách hàng của công tơ ĐANG chọn
  v_meter_cnt  int;      -- Slice −1 B1: số công tơ cùng loại của toà (>1 thì gợi ý chọn lại)
  v_ceiling jsonb;       -- 28/08: verdict trần điện/nước (utility_ceiling_check_v1)
  v_ceiling_verdict text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  IF p_utility_type NOT IN ('ELECTRIC','WATER') THEN RAISE EXCEPTION 'Loại tiện ích không hợp lệ'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Số tiền phải lớn hơn 0'; END IF;
  IF p_period_month !~ '^\d{4}-\d{2}$' THEN RAISE EXCEPTION 'Kỳ không hợp lệ (cần YYYY-MM)'; END IF;

  v_kind_vn := CASE WHEN p_utility_type = 'ELECTRIC' THEN 'điện' ELSE 'nước' END;

  SELECT b.user_id, b.organization_id INTO v_owner, v_org
    FROM buildings b WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà'; END IF;
  IF NOT (public.can_access_building(p_building_id) OR public.ie_all_buildings_scope(p_building_id)
          OR v_owner = auth.uid() OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên toà này' USING ERRCODE = '42501';
  END IF;

  -- ══ Slice −1 B2: KHÔNG tự tạo công tơ nữa ══════════════════════════
  -- Nhánh ELSE cũ INSERT một dòng building_utility_accounts mới mỗi lần
  -- p_utility_account_id NULL. Giao diện gửi NULL cho MỌI toà/loại chưa khai
  -- công tơ (dòng tổng hợp accountId=null), nên một cú bấm check bình thường
  -- là sinh công tơ trong im lặng; và vì map "đã đóng" khoá theo id công tơ,
  -- dòng vừa sinh không bao giờ hiện "đã đóng" ⇒ mời người dùng bấm lại.
  -- Chặn ở đây là chặn cả hai hệ quả bằng một câu.
  IF p_utility_account_id IS NULL THEN
    RAISE EXCEPTION
      '[UTILITY_METER_REQUIRED] Toà này chưa khai công tơ % — hãy khai công tơ (mã khách hàng / chủ hộ) rồi đóng tiền cho đúng công tơ. Trước đây hệ thống tự tạo công tơ mới mỗi lần bấm, nên dòng đó không bao giờ hiện "đã đóng" và tiền đóng hai lần không ai thấy.',
      v_kind_vn
      USING ERRCODE = '22023';
  END IF;

  SELECT id, NULLIF(btrim(COALESCE(provider_code, '')), '')
    INTO v_meter, v_meter_code
    FROM building_utility_accounts
   WHERE id = p_utility_account_id AND building_id = p_building_id
     AND utility_type = p_utility_type AND deleted_at IS NULL;
  IF v_meter IS NULL THEN RAISE EXCEPTION 'Không tìm thấy đồng hồ điện/nước'; END IF;

  -- Slice −1 B1: toà có MẤY công tơ cùng loại? Cần cho câu lỗi chống trùng.
  -- Ca thật 1392QT: HAI hợp đồng điện riêng (PE13000241972 và PE13000241924,
  -- cùng chủ hộ Hoàng Công Hiệp), mỗi tháng là một hoá đơn lớn + một hoá đơn nhỏ.
  -- Không nói rõ công tơ nào thì người dùng đọc "kỳ này đã có phiếu" sẽ tưởng
  -- mình bấm trùng, trong khi thực tế họ đang trả hoá đơn của công tơ CÒN LẠI.
  SELECT count(*) INTO v_meter_cnt
    FROM building_utility_accounts
   WHERE building_id = p_building_id AND utility_type = p_utility_type
     AND deleted_at IS NULL;

  v_p_start := to_date(p_period_month || '-01', 'YYYY-MM-DD');
  v_p_end   := (date_trunc('month', v_p_start) + interval '1 month - 1 day')::date;

  -- ══ Slice −1 B1: MỘT PHIẾU / MỘT CÔNG TƠ / MỘT KỲ ═════════════════
  -- Khoá tư vấn theo đúng slot TRƯỚC khi đọc: SELECT-rồi-INSERT trần bị đua
  -- (hai tab, hai lần bấm, hai transaction cùng thấy "chưa có" rồi cùng ghi).
  -- Khoá cấp transaction nên tự nhả khi commit/rollback, và chỉ xếp hàng đúng
  -- một slot — không serialize cả bảng.
  -- COALESCE quanh v_org là bắt buộc: pg_advisory_xact_lock STRICT, truyền NULL
  -- thì nó trả NULL và KHÔNG lấy khoá nào — mất chống-đua trong im lặng.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'utility.bill:' || COALESCE(v_org::text, '-') || ':' || v_meter::text || ':'
        || p_utility_type || ':' || to_char(v_p_start, 'YYYY-MM'),
      0
    )
  );

  -- Khoá nghiệp vụ = (org, công tơ, loại tiện ích, tháng tính tiền). Không cần
  -- viết org và loại vào WHERE: id công tơ QUYẾT ĐỊNH cả hai (công tơ thuộc
  -- đúng một toà, và ở trên đã kiểm building_id + utility_type khớp) — thêm
  -- `organization_id = v_org` vào đây chỉ tạo nguy cơ BỎ SÓT nếu có phiếu cũ
  -- org NULL, tức tự vô hiệu hoá chính chốt này.
  -- Tháng lấy từ ITEM (income_expenses không có cột kỳ); date_trunc để chịu
  -- được 19 phiếu lịch sử có start_date không nằm ngày 1.
  -- CỐ Ý ĐẾM CẢ 'UNAPPROVED': phiếu chờ duyệt là phiếu VÔ HÌNH trên bảng
  -- điện/nước (reader lọc APPROVED) — đó chính là lý do người dùng bấm lại.
  -- KHÔNG đếm phiếu đã huỷ: huỷ mềm (cancel_utility_bill đặt deleted_at) hoặc
  -- huỷ linh hoạt Đợt 4 (approval_status='CANCELLED') ⇒ đóng lại được.
  SELECT ie.code, ie.total_amount, ie.approval_status
    INTO v_dup_code, v_dup_amount, v_dup_status
    FROM income_expenses ie
   WHERE ie.system_source = 'utility.bill'
     AND ie.utility_account_id = v_meter
     AND ie.deleted_at IS NULL
     AND ie.approval_status <> 'CANCELLED'
     AND EXISTS (
       SELECT 1 FROM income_expense_items it
        WHERE it.income_expense_id = ie.id
          AND it.start_date IS NOT NULL
          AND date_trunc('month', it.start_date)::date = v_p_start
     )
   ORDER BY ie.created_at, ie.id
   LIMIT 1;

  IF v_dup_code IS NOT NULL THEN
    RAISE EXCEPTION
      '[UTILITY_BILL_DUPLICATE] Kỳ % của công tơ % ĐÃ CÓ phiếu chi % — %đ (%). Không tạo phiếu thứ hai. Nếu phiếu cũ đang chờ duyệt thì DUYỆT nó; nếu phiếu cũ sai thì HUỶ nó rồi đóng lại.%',
      to_char(v_p_start, 'MM/YYYY'),
      COALESCE(v_meter_code, 'này'),
      v_dup_code,
      round(COALESCE(v_dup_amount, 0))::bigint::text,
      CASE v_dup_status WHEN 'UNAPPROVED' THEN 'đang chờ duyệt' ELSE 'đã duyệt' END,
      -- Gợi ý chỉ hiện khi toà THẬT SỰ có nhiều công tơ cùng loại — nếu không thì
      -- thêm câu này chỉ làm người dùng đi tìm một công tơ không tồn tại.
      CASE WHEN COALESCE(v_meter_cnt, 1) > 1
           THEN format(' Lưu ý: toà này có %s công tơ %s. Nếu hoá đơn bạn đang trả thuộc công tơ khác thì hãy chọn đúng công tơ đó rồi đóng lại.',
                       v_meter_cnt, v_kind_vn)
           ELSE '' END
      USING ERRCODE = '55000';
  END IF;

  -- Sổ ghi chi (mặc định "…Thu" caller)
  IF p_account_id IS NOT NULL THEN
    SELECT id INTO v_acc FROM accounts
     WHERE id = p_account_id AND deleted_at IS NULL
       AND (user_id = auth.uid() OR public.is_admin() OR public.is_super_admin());
    IF v_acc IS NULL THEN RAISE EXCEPTION 'Sổ quỹ không hợp lệ hoặc bạn không có quyền ghi chi vào sổ này' USING ERRCODE = '42501'; END IF;
  ELSE
    SELECT id INTO v_acc FROM accounts
     WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'
     ORDER BY is_default DESC NULLS LAST, name LIMIT 1;
    IF v_acc IS NULL THEN RAISE EXCEPTION 'Bạn chưa có sổ quỹ "…Thu" để chi tiền'; END IF;
  END IF;

  -- Học siêu dữ liệu công tơ — dời xuống SAU chốt chống trùng để một lần bấm
  -- bị từ chối không để lại thay đổi nào.
  UPDATE building_utility_accounts SET
    provider_code  = COALESCE(NULLIF(btrim(p_provider_code), ''), provider_code),
    account_holder = COALESCE(NULLIF(btrim(p_account_holder), ''), account_holder),
    updated_at = now()
  WHERE id = v_meter;

  -- t5_28: hoá đơn điện/nước là phiếu CHI → tôn trọng NGƯỠNG tự duyệt của org.
  -- Dưới ngưỡng (hoặc chưa đặt ngưỡng) → tự duyệt như cũ; từ ngưỡng trở lên →
  -- sinh NHÁP chờ duyệt tay (khớp phương án owner + create_income_expense_v1).
  --
  -- 26/08/2026: NGƯỜI LẬP PHIẾU MÀ CÓ QUYỀN DUYỆT đi thẳng, không qua ngưỡng.
  -- Đây đúng là luật chủ đã chốt 25/07/2026 cho create_income_expense_v1 (biến
  -- v_maker_can_approve), nhưng nó chưa bao giờ được áp cho hai RPC của trang
  -- Thanh toán. Hệ quả đo được: cùng một số tiền, nhập tay ở form Thu chi thì
  -- tự duyệt, còn bấm nút đóng tiền ở /thanh-toan lại sinh phiếu CHỜ DUYỆT rồi
  -- bắt chính người có quyền duyệt sang màn hình khác bấm lần hai.
  --
  -- Ngưỡng KHÔNG bị nới: nó giữ nguyên cho người không có quyền duyệt — đó mới
  -- là đối tượng nó sinh ra để soát.
  SELECT c.threshold INTO v_threshold
    FROM app_private.ie_auto_approve_config c WHERE c.organization_id = v_org;
  IF COALESCE(app_private.ie_maker_can_approve_v1(p_building_id), false) THEN
    v_status := 'APPROVED'; v_appr_by := auth.uid(); v_appr_at := now();
  ELSIF v_threshold IS NOT NULL AND p_amount >= v_threshold THEN
    v_status := 'UNAPPROVED'; v_appr_by := NULL; v_appr_at := NULL;
  ELSE
    v_status := 'APPROVED'; v_appr_by := auth.uid(); v_appr_at := now();
  END IF;

  -- ══ 28/08 — TRẦN ĐIỆN/NƯỚC (nối động cơ 20260801040000 vào writer) ═════
  -- Động cơ utility_ceiling_check_v1 tồn tại từ 01/08 nhưng KHÔNG writer nào
  -- gọi — trần chủ công bố là hình vẽ. Từ nay: phiếu VƯỢT TRẦN thì hạ về CHỜ
  -- DUYỆT, kể cả người-có-quyền-duyệt (họ duyệt được ngay sau đó, nhưng phải
  -- NHÌN cảnh báo một lần — trần sinh ra để bắt người nhìn số bất thường, và
  -- người bấm nhanh nhất chính là người có quyền). Không có trần (NO_RULE) ⇒
  -- hành vi y như cũ. KHÔNG chặn cứng: sai trần thì tệ nhất là chờ duyệt.
  v_ceiling := app_private.utility_ceiling_check_v1(
                 v_org, p_building_id, p_utility_type, v_p_start, p_amount);
  v_ceiling_verdict := COALESCE(v_ceiling->>'verdict', 'NO_RULE');
  IF v_ceiling_verdict IN ('OVER_CEILING', 'OVER_RATIO') THEN
    v_status := 'UNAPPROVED'; v_appr_by := NULL; v_appr_at := NULL;
  END IF;

  v_type_nm := CASE WHEN p_utility_type = 'ELECTRIC' THEN 'Đóng tiền điện' ELSE 'Đóng tiền nước' END;
  v_type := public._termination_ensure_type(v_owner, 'expense', v_type_nm);
  UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type AND is_deposit IS DISTINCT FROM FALSE;

  v_vdate   := COALESCE(p_voucher_date, public.org_today_v1(NULL));
  SELECT COALESCE(full_name, '') INTO v_caller FROM profiles WHERE id = auth.uid();

  -- ⚠ HAI DÒNG DƯỚI LÀ MẪU NEO của 20260724120000 — giữ VERBATIM (mục 5 tự kiểm).
  INSERT INTO income_expenses
    (user_id, organization_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, approved_by, approved_at,
     business_result_accounting, notes, creator_name,
     attachments, system_source, utility_account_id)
  VALUES
    (auth.uid(), v_org, 'EXPENSE',
     'Đóng ' || lower(v_type_nm) || ' (NCC) — kỳ ' || to_char(v_p_start, 'MM/YYYY'),
     p_building_id, v_acc, v_vdate,
     p_amount, v_status, v_appr_by, v_appr_at, TRUE,
     'Chủ nhà đóng ' || lower(v_type_nm) || ' cho cả toà — kỳ ' || to_char(v_p_start, 'MM/YYYY')
       || COALESCE(' — mã ' || NULLIF(btrim(p_provider_code), ''), '')
       || COALESCE(' — chủ hộ ' || NULLIF(btrim(p_account_holder), ''), ''),
     v_caller,
     COALESCE(p_attachments, '[]'::jsonb), 'utility.bill', v_meter)
  RETURNING id INTO v_voucher;

  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES
    (v_voucher, v_type, 'Đóng ' || lower(v_type_nm) || ' kỳ ' || to_char(v_p_start, 'MM/YYYY'),
     1, p_amount, v_p_start, v_p_end);

  -- Vượt trần: nối lý do vào ghi chú SAU insert — khối INSERT là MẪU NEO của
  -- 20260724120000, không được sửa một ký tự nào trong đó.
  IF v_ceiling_verdict IN ('OVER_CEILING', 'OVER_RATIO') THEN
    UPDATE income_expenses
       SET notes = notes || ' — [VƯỢT TRẦN ' || v_kind_vn || '] '
                 || COALESCE(v_ceiling->>'reason', 'vượt trần đã công bố')
                 || ' — phiếu chuyển CHỜ DUYỆT.'
     WHERE id = v_voucher;
  END IF;

  SELECT code, total_amount INTO v_code, v_total FROM income_expenses WHERE id = v_voucher;
  RETURN jsonb_build_object('voucher_id', v_voucher, 'code', v_code,
    'total_amount', v_total, 'account_id', v_acc, 'utility_account_id', v_meter,
    'ceilingVerdict', v_ceiling_verdict);
END;
$function$;

-- ---------- Tự kiểm: nhánh mới có thật VÀ mọi chốt cũ còn nguyên ----------
DO $tu_kiem$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'pay_utility_bill';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'pay_utility_bill biến mất sau khi replace. DỪNG.';
  END IF;
  IF position('utility_ceiling_check_v1' IN v_src) = 0 THEN
    RAISE EXCEPTION 'pay_utility_bill: trần điện/nước KHÔNG được nối vào. DỪNG.';
  END IF;
  IF position('OVER_CEILING' IN v_src) = 0 THEN
    RAISE EXCEPTION 'pay_utility_bill: verdict vượt trần không hạ phiếu về chờ duyệt. DỪNG.';
  END IF;
  IF position('ie_maker_can_approve_v1' IN v_src) = 0 THEN
    RAISE EXCEPTION 'pay_utility_bill: nhánh người-có-quyền-duyệt bị đánh rơi. DỪNG.';
  END IF;
  IF position('ELSIF v_threshold IS NOT NULL AND p_amount >= v_threshold THEN' IN v_src) = 0 THEN
    RAISE EXCEPTION 'pay_utility_bill: nhánh NGƯỠNG bị đánh rơi. DỪNG.';
  END IF;
  IF position('UTILITY_BILL_DUPLICATE' IN v_src) = 0 THEN
    RAISE EXCEPTION 'pay_utility_bill: mất chốt chống trùng B1. DỪNG.';
  END IF;
  IF position('UTILITY_METER_REQUIRED' IN v_src) = 0 THEN
    RAISE EXCEPTION 'pay_utility_bill: mất chốt bắt khai công tơ B2. DỪNG.';
  END IF;
  IF position('MAU NEO' IN v_src) = 0 AND position('MẪU NEO' IN v_src) = 0 THEN
    RAISE EXCEPTION 'pay_utility_bill: mất MẪU NEO của 20260724120000. DỪNG.';
  END IF;
END
$tu_kiem$;

COMMIT;
