BEGIN;
-- ============================================================
-- Phiếu "Doanh thu bỏ cọc": cho chủ công ty / super admin đổi cờ KQKD
--
-- TRIỆU CHỨNG (27/08/2026, ptcrm.vercel.app/income-expense): mở phiếu
--   "Doanh thu bỏ cọc — HĐ HĐT-054927/19032025" rồi bấm Lưu → toast
--     "Bút toán bỏ cọc chỉ được tạo hoặc sửa bởi writer thanh lý"
--   Người bấm là chủ công ty. Super admin bấm cũng nhận đúng câu đó.
--
-- GỐC RỄ — KHÔNG phải chuyện phân quyền. Trigger
--   a05_termination_forfeit_voucher_guard (app_private.guard_termination_forfeit_voucher_v1)
--   không nhìn user, không nhìn vai: nó chỉ hỏi transaction hiện tại đã gọi
--   app_private.begin_accounting_chain_write_v1() chưa. RPC sửa phiếu
--   public.ie_compat_update_pending_v2 không gọi hàm đó ⇒ mọi danh tính bị
--   chặn như nhau. Cột business_result_accounting còn nằm trong v_money_keys
--   của RPC đó nên phiếu đã duyệt dính thêm "Trục tiền chỉ sửa được khi phiếu
--   Chờ duyệt (V2 §12.8)".
--
-- VÌ SAO PHẢI NỚI MỘT BẤT BIẾN — không có đường vòng.
--   app_private.require_termination_forfeit_authorization_v1 bắt
--       COALESCE(revenue.kqkd_amount, 0) = v_authorization.amount
--   Đặt cờ = FALSE làm recompute_ie_business_result ghi kqkd_amount = 0 ⇒ vế đó
--   vỡ. Hai hậu quả, cái thứ hai mới là cái chết người:
--     1) trg_forfeit_settle_on_approve gọi assert này trên MỌI thay đổi
--        approval_status ⇒ cặp phiếu không huỷ được, không bỏ duyệt được nữa.
--     2) 20260721135500 có assert runtime quét TOÀN BỘ bảng authorization ⇒
--        chỉ cần prod tồn tại một phiếu kqkd = 0 là lần apply migration kế tiếp
--        ABORT, nghẽn cả lane migrate:forward.
--   Nên file này nới đúng MỘT vế, và chỉ cho chân DOANH THU. Chân đối ứng giữ
--   nguyên "= 0" tuyệt đối: nó là bút toán tiêu cọc, không bao giờ là lợi nhuận.
--
-- ĐO ĐƯỢC (prod, 27/08/2026) — 28 phiếu bỏ cọc còn sống:
--     flow_owned 0 · khoá sổ (lock_date/closed_through) 0 · đang bàn giao 0
--     có posting 0 · tháng đã chốt lợi nhuận 0 · đã override cờ 0
--     revenue lệch kqkd 0 · offset lệch kqkd 0
--   ⇒ không phiếu nào vướng rào nào, và bản vá KHÔNG hồi tố gì: cả 28 phiếu
--   đang có business_result_accounting = NULL nên nhánh CASE mới không chạm tới.
--
-- BẪY ĐÃ ĐO, KHÔNG PHẢI SUY ĐOÁN — ba cách nhận diện "chủ công ty" đều sai:
--   (a) app_private.is_org_owner_v1 → SAI. Vai "Chủ công ty" (20260811030000)
--       có system_key = NULL nên hàm đó trả FALSE cho chính chủ công ty.
--       Đo prod với nguyentam (0520169e-0860-4b4e-a603-675c8aa245aa): false.
--   (b) authorize_tenant_action_v3(actor, org, 'income_expenses.edit', NULL, NULL)
--       để lấy "quyền phạm vi tổ chức" → SAI. Quyền đó có
--       required_dimensions = {BUILDING} nên truyền building NULL luôn trả
--       allowed = false, decision_reason = 'REQUIRED_DIMENSION_MISSING'.
--   (c) Neo theo QUYỀN gắn ở scope ORGANIZATION → SAI. Trong org DEMO vai
--       "Quản Lý Tòa" cũng được gắn scope ORGANIZATION ⇒ đo được 4 tài khoản
--       demo (kế toán, kỹ thuật, sale, cổ đông) lọt cửa.
--   ⇒ Cửa này neo theo VAI CHỦ. Tập lọt cửa đo trên TOÀN prod: đúng 3 người —
--     nguyentam (Chủ công ty) · nguyentamca165 (Chủ sở hữu tổ chức + Super
--     Admin) · demo.chunha (Chủ công ty). Bảy tài khoản "Quản Lý Tòa" và một
--     "Partner": không lọt.
--
-- DÒNG TIỀN: không đụng, đã kiểm chứ không đoán. 13 hàm/view số dư & dòng tiền
--   (cashbook_balance_as_of_v1, cashflow_by_day_v2, accounts_with_balance(_v2),
--   cashbook_period_totals_v2, cashbook_settlement_report, cầu a85, …) KHÔNG
--   hàm nào đọc business_result_accounting / kqkd_amount /
--   counts_in_business_result. Bút toán tiền dựng từ total_amount, mà cặp bỏ
--   cọc nằm trên sổ ẢO nên không có income_expense_posting_lines nào. Thứ đổi
--   là báo cáo lợi nhuận, không phải số dư quỹ.
--
-- RÀO PHẢI GIỮ: nếu tháng của phiếu đã CHỐT lợi nhuận thì đổi cờ làm
--   current_profit_building_source_hash_v1 lệch ⇒ assert_profit_payout_fresh_v2
--   chặn chi trả cổ đông, distribute_shareholder_profit_v1 nuốt lỗi im lặng, và
--   "đã chia > lợi nhuận thực" mà không banner nào tự bật. RPC vì thế chặn
--   thẳng CẢ HAI CHIỀU, KHÔNG mượn quyền super admin để lách trigger.
--
-- PHẠM VI CỐ Ý HẸP — phần KHÔNG làm, nói ra để khỏi ai tưởng đã làm:
--   - KHÔNG mở sửa SỐ TIỀN bỏ cọc. Sửa tiền phải đồng bộ 7 con số của cặp cộng
--     contract_terminations đang đông cứng — việc khác, file khác.
--   - KHÔNG đụng contracts.deposit_paid, hoá đơn SETTLEMENT, payment cấn cọc.
--   - KHÔNG mở cờ trên chân termination.forfeit_offset.
--   - KHÔNG sửa app_private.is_org_owner_v1. Nới hàm đó chữa bẫy (a) cho MỌI
--     cửa đang dùng nó (khoá lợi nhuận, ie_flex_cancel, dừng lặp lại, đổi sổ
--     quỹ) — đúng hướng nhưng bán kính rộng, phải là quyết định riêng có người
--     duyệt. Ở đây dựng helper hẹp chỉ phục vụ đúng cửa này.
--
-- Idempotent: bản vá assert tự bỏ qua khi đã có nhánh CASE; helper và RPC là
-- CREATE OR REPLACE; smoke chỉ soi catalog.
-- ============================================================

-- ---------- 1. Nhận diện chủ công ty (hẹp, chỉ cho cửa này) ----------
-- Cố ý KHÔNG tái dùng is_org_owner_v1: hàm đó neo system_key = 'TENANT_OWNER'
-- và vai "Chủ công ty" không có system_key. Sửa hàm kia là đổi hành vi của mọi
-- cửa đang gọi nó; ở đây chỉ cần đúng một cửa.
CREATE OR REPLACE FUNCTION app_private.ie_actor_is_company_owner_v1(p_org uuid, p_actor uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.role_bindings rb
    JOIN public.organization_memberships m
      ON m.id = rb.membership_id
     AND m.organization_id = rb.organization_id
     AND m.user_id = p_actor
     AND m.status = 'ACTIVE'
     AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= now()
     AND (m.valid_to IS NULL OR m.valid_to > now())
    JOIN public.organization_roles r
      ON r.id = rb.role_id
     AND r.organization_id = rb.organization_id
     AND COALESCE(r.status, 'ACTIVE') = 'ACTIVE'
     AND (
           r.system_key = 'TENANT_OWNER'
        OR (r.system_key IS NULL AND r.name IN ('Chủ sở hữu tổ chức', 'Chủ công ty'))
     )
    WHERE rb.organization_id = p_org
      AND COALESCE(rb.valid_from, '-infinity'::timestamptz) <= now()
      AND (rb.valid_to IS NULL OR rb.valid_to > now())
  );
$fn$;

REVOKE ALL ON FUNCTION app_private.ie_actor_is_company_owner_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.ie_actor_is_company_owner_v1(uuid, uuid) IS
  'Chủ công ty theo nghĩa NGƯỜI SỞ HỮU DOANH NGHIỆP: vai system_key=TENANT_OWNER, hoặc vai tự tạo tên "Chủ sở hữu tổ chức"/"Chủ công ty". Hẹp hơn is_org_owner_v1 ở chỗ nhận cả vai "Chủ công ty" (system_key NULL, 20260811030000) mà hàm kia bỏ sót. Chỉ dùng cho cửa đổi hạch toán KQKD của phiếu bỏ cọc — đừng mượn cho cửa khác mà không đo lại tập người lọt.';

-- ---------- 1b. Cờ HIỂN THỊ cho giao diện ----------
-- UI phải biết có nên bày công tắc KQKD hay không. Hôm nay nó hỏi
-- public.is_org_owner_self_v1(), mà hàm đó gọi is_org_owner_v1 ⇒ dính đúng bẫy
-- (a) ở header: chủ công ty nhận false và bị khoá read-only. Wrapper này mirror
-- ĐÚNG vị ngữ mà RPC ở phần 3 dùng, để nút bấm và writer không bao giờ lệch nhau.
--
-- Đây là cờ HIỂN THỊ, không phải hàng rào: nó không nhận org (giống hàm anh em)
-- nên trả true khi người dùng là chủ ở ít nhất một tổ chức. Hàng rào thật vẫn là
-- set_forfeit_voucher_kqkd_v1, và nó kiểm theo ĐÚNG org của phiếu.
CREATE OR REPLACE FUNCTION public.is_company_owner_self_v1()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.organization_memberships m
        WHERE m.user_id = auth.uid()
          AND app_private.ie_actor_is_company_owner_v1(m.organization_id, auth.uid())
     );
$fn$;

REVOKE ALL ON FUNCTION public.is_company_owner_self_v1() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.is_company_owner_self_v1() TO authenticated;

COMMENT ON FUNCTION public.is_company_owner_self_v1() IS
  'Cờ HIỂN THỊ: người đang đăng nhập có phải chủ công ty ở ít nhất một tổ chức không (kể cả vai "Chủ công ty" system_key NULL mà is_org_owner_self_v1 bỏ sót). Dùng để quyết định có bày công tắc hạch toán KQKD trên phiếu bỏ cọc; hàng rào thật là set_forfeit_voucher_kqkd_v1.';

-- ---------- 2. Nới bất biến cặp bỏ cọc: đúng một vế, đúng chân doanh thu ----------
-- VÁ TẠI CHỖ thay vì CREATE OR REPLACE từ file: hàm này đã qua nhiều đợt vá
-- (20260721135500 → 20260722150000) và viết đè từ một bản có thể lạc hậu là
-- cách chắc chắn nhất để đánh rơi một vế của bất biến.
DO $va_assert$
DECLARE
  v_def text;
  v_neo text := '      AND COALESCE(revenue.kqkd_amount, 0) = v_authorization.amount';
  v_moi text := '      AND COALESCE(revenue.kqkd_amount, 0) = CASE
            WHEN revenue.business_result_accounting IS FALSE THEN 0
            ELSE v_authorization.amount
          END';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p
  WHERE p.proname = 'require_termination_forfeit_authorization_v1'
    AND p.pronamespace = 'app_private'::regnamespace;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy app_private.require_termination_forfeit_authorization_v1 — kiểm tra 20260721135500 đã chạy chưa.';
  END IF;

  IF position('revenue.business_result_accounting IS FALSE' IN v_def) > 0 THEN
    RETURN; -- đã vá
  END IF;

  IF position(v_neo IN v_def) = 0 THEN
    RAISE EXCEPTION 'require_termination_forfeit_authorization_v1 không còn vế kqkd mà bản vá này neo vào — đối chiếu pg_get_functiondef trước khi sửa.';
  END IF;

  -- Chân đối ứng phải còn nguyên vế "= 0" TRƯỚC khi vá; nếu nó đã biến mất thì
  -- bất biến đã bị ai đó nới ở chỗ khác và file này không được chồng thêm.
  IF position('COALESCE(offset_voucher.kqkd_amount, 0) = 0' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vế kqkd của chân đối ứng đã khác bản đã đối chiếu — dừng lại, đối chiếu tay.';
  END IF;

  v_def := replace(v_def, v_neo, v_moi);
  EXECUTE v_def;
END
$va_assert$;

-- ---------- 3. RPC đổi cờ KQKD ----------
CREATE OR REPLACE FUNCTION public.set_forfeit_voucher_kqkd_v1(
  p_voucher uuid,
  p_kqkd boolean,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v public.income_expenses%ROWTYPE;
  v_after public.income_expenses%ROWTYPE;
  v_actor uuid := auth.uid();
  v_membership uuid;
  v_is_super boolean;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_locked timestamptz;
  v_core_writer boolean;
  v_opened_writer boolean := false;
  v_ky_vong numeric;
  v_cu text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  IF p_kqkd IS NULL THEN
    RAISE EXCEPTION 'Phải nói rõ có tính vào kết quả kinh doanh hay không'
      USING ERRCODE = '22023';
  END IF;

  IF char_length(v_reason) < 8 THEN
    RAISE EXCEPTION 'Phải ghi lý do đổi hạch toán KQKD (ít nhất 8 ký tự) để còn đối soát về sau.'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v FROM public.income_expenses
   WHERE id = p_voucher AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;

  -- Chỉ chân DOANH THU. Chân đối ứng là bút toán tiêu cọc: kqkd của nó phải
  -- bằng 0 vĩnh viễn và bất biến của cặp vẫn giữ nguyên vế đó.
  IF COALESCE(v.system_source, '') <> 'termination.forfeit_revenue' THEN
    RAISE EXCEPTION 'Cửa này chỉ đổi được hạch toán KQKD của phiếu "Doanh thu bỏ cọc"'
      USING ERRCODE = 'P0001';
  END IF;

  IF v.approval_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Phiếu đã huỷ — không sửa' USING ERRCODE = '55000';
  END IF;

  v_is_super := public.is_super_admin();

  SELECT m.id INTO v_membership
  FROM public.organization_memberships m
  WHERE m.user_id = v_actor AND m.organization_id = v.organization_id
    AND m.status = 'ACTIVE'
  LIMIT 1;

  IF v_membership IS NULL AND NOT v_is_super THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
  END IF;

  -- Đây là quyết định CHÍNH SÁCH KẾ TOÁN cấp công ty (nó đổi lợi nhuận đem chia
  -- cho cổ đông), không phải sửa một phiếu trên một toà. Nên cửa hẹp: chủ công
  -- ty hoặc super admin. Quản lý toà có income_expenses.edit KHÔNG đủ.
  IF NOT (v_is_super OR app_private.ie_actor_is_company_owner_v1(v.organization_id, v_actor)) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc super admin mới đổi được hạch toán KQKD của phiếu bỏ cọc'
      USING ERRCODE = '42501';
  END IF;

  -- RPC là SECURITY DEFINER nên KHÔNG hưởng policy RESTRICTIVE hạng mục hạn chế.
  IF COALESCE(v.has_restricted_item, false)
     AND v.user_id IS DISTINCT FROM v_actor
     AND NOT public.can_view_restricted_ie()
     AND NOT v_is_super THEN
    RAISE EXCEPTION 'Phiếu chứa hạng mục hạn chế — không có quyền' USING ERRCODE = '42501';
  END IF;

  -- No-op: không mở writer, không ghi nhật ký, không đánh thức trigger nào.
  IF v.business_result_accounting IS NOT DISTINCT FROM p_kqkd THEN
    RETURN jsonb_build_object(
      'id', p_voucher, 'changed', false,
      'business_result_accounting', v.business_result_accounting,
      'kqkd_amount', v.kqkd_amount);
  END IF;

  -- Đo prod 27/08: 28/28 phiếu bỏ cọc đều flow_owned = false ⇒
  -- guard_income_expense_owned_payload early-return. Không dựa vào giả định:
  -- gặp phiếu canonical thì báo thẳng thay vì chết bằng 55000 khó đọc.
  IF app_private.is_income_expense_flow_owned(p_voucher) THEN
    RAISE EXCEPTION 'Phiếu canonical chưa hỗ trợ đổi hạch toán KQKD — báo kỹ thuật'
      USING ERRCODE = '0A000';
  END IF;

  -- RÀO 1a — ba khoá thời gian (chốt sổ / bàn giao / chốt lợi nhuận). Hàm này
  -- đọc GIÁ TRỊ CŨ của cờ (COALESCE(business_result_accounting, true)) nên nó
  -- canh đúng chiều "đang trong KQKD → bỏ ra".
  PERFORM app_private.assert_period_open_for_edit_v1(p_voucher, 'đổi hạch toán KQKD của');

  -- RÀO 1b — chiều ngược lại LỌT rào trên, vì phiếu đang ở ngoài KQKD thì hàm
  -- kia bỏ qua khoá lợi nhuận. Tự canh: kéo một phiếu TRỞ LẠI vào KQKD của một
  -- tháng đã chốt cũng làm source_hash lệch y hệt chiều kia.
  IF v.business_result_accounting IS FALSE AND p_kqkd IS TRUE THEN
    SELECT pm.locked_at INTO v_locked
    FROM public.profit_monthly pm
    WHERE pm.building_id = v.building_id
      AND pm.period_month = date_trunc('month', v.voucher_date)::date;
    IF v_locked IS NOT NULL THEN
      RAISE EXCEPTION '[PROFIT_LOCKED] Lợi nhuận tháng % của toà này đã chốt — không kéo thêm phiếu vào KQKD của tháng đó. Hãy mở khoá tháng rồi chốt lại.',
        to_char(v.voucher_date, 'MM/YYYY') USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Năng lực writer thanh lý — khuôn của set_termination_forfeit_status_v1:
  -- chỉ mở khi transaction chưa giữ, và chỉ đóng đúng thứ mình đã mở.
  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_core_writer;
  IF NOT v_core_writer THEN
    PERFORM app_private.begin_accounting_chain_write_v1();
    v_opened_writer := true;
  END IF;

  UPDATE public.income_expenses
     SET business_result_accounting = p_kqkd,
         updated_at = now()
   WHERE id = p_voucher;

  SELECT * INTO v_after FROM public.income_expenses WHERE id = p_voucher;

  -- Hậu điều kiện: trigger ie_business_result đã chạy trong UPDATE trên. Nếu nó
  -- không ra đúng số thì dừng lại, đừng để cặp phiếu lệch âm thầm.
  v_ky_vong := CASE WHEN p_kqkd THEN v_after.total_amount ELSE 0 END;
  IF COALESCE(v_after.kqkd_amount, 0) <> v_ky_vong THEN
    RAISE EXCEPTION 'kqkd_amount sau khi đổi là % nhưng phải là % — dừng lại, báo quản trị.',
      COALESCE(v_after.kqkd_amount, 0), v_ky_vong
      USING ERRCODE = '55000';
  END IF;

  -- Phép thử SỐNG cho bản vá ở phần 2: cặp phải còn hợp lệ NGAY trong
  -- transaction này. Vế kqkd chưa được nới thì dòng này nổ 55000 và cả thao tác
  -- cuộn lại — đúng thứ ta muốn, thay vì để cặp kẹt tới lần huỷ sau.
  PERFORM app_private.require_termination_forfeit_authorization_v1(p_voucher, false, false);

  IF v_opened_writer THEN
    PERFORM app_private.end_accounting_chain_write_v1();
  END IF;

  v_cu := CASE
            WHEN v.business_result_accounting IS NULL THEN 'KQKD: tự động'
            WHEN v.business_result_accounting THEN 'KQKD: có'
            ELSE 'KQKD: không'
          END;

  PERFORM app_private.append_income_expense_event_v1(
    v.organization_id,
    p_voucher,
    'KQKD_OVERRIDE',
    v_actor,
    NULL,
    v_cu,
    CASE WHEN p_kqkd THEN 'KQKD: có' ELSE 'KQKD: không' END,
    v_reason
  );

  RETURN jsonb_build_object(
    'id', p_voucher,
    'changed', true,
    'business_result_accounting', v_after.business_result_accounting,
    'kqkd_amount', v_after.kqkd_amount,
    'total_amount', v_after.total_amount);
END
$fn$;

REVOKE ALL ON FUNCTION public.set_forfeit_voucher_kqkd_v1(uuid, boolean, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.set_forfeit_voucher_kqkd_v1(uuid, boolean, text)
  TO authenticated;

COMMENT ON FUNCTION public.set_forfeit_voucher_kqkd_v1(uuid, boolean, text) IS
  'Đổi cờ "tính vào kết quả kinh doanh" của phiếu Doanh thu bỏ cọc (termination.forfeit_revenue). Chỉ chủ công ty / super admin, bắt buộc ghi lý do, chặn khi tháng đã chốt lợi nhuận theo CẢ HAI chiều. Không đụng số tiền, không đụng chân đối ứng, không đụng dòng tiền (cặp bỏ cọc chạy trên sổ ảo, không có bút toán tiền).';

-- ---------- 4. Smoke (chỉ soi catalog — chạy được trên database rỗng) ----------
DO $smoke$
DECLARE
  v_def text;
BEGIN
  IF to_regprocedure('app_private.ie_actor_is_company_owner_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'ie_actor_is_company_owner_v1 chưa tồn tại';
  END IF;

  IF to_regprocedure('public.is_company_owner_self_v1()') IS NULL THEN
    RAISE EXCEPTION 'is_company_owner_self_v1 chưa tồn tại';
  END IF;

  IF to_regprocedure('public.set_forfeit_voucher_kqkd_v1(uuid,boolean,text)') IS NULL THEN
    RAISE EXCEPTION 'set_forfeit_voucher_kqkd_v1 chưa tồn tại';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p
  WHERE p.proname = 'require_termination_forfeit_authorization_v1'
    AND p.pronamespace = 'app_private'::regnamespace;

  IF position('revenue.business_result_accounting IS FALSE' IN COALESCE(v_def, '')) = 0 THEN
    RAISE EXCEPTION 'Bản vá vế kqkd chân doanh thu chưa vào';
  END IF;

  -- Chân đối ứng KHÔNG được nới. Đây là vế giữ cho "tiền tiêu cọc" không bao
  -- giờ đếm thành lợi nhuận.
  IF position('COALESCE(offset_voucher.kqkd_amount, 0) = 0' IN COALESCE(v_def, '')) = 0 THEN
    RAISE EXCEPTION 'Vế kqkd của chân đối ứng đã biến mất sau khi vá — dừng lại.';
  END IF;

  -- Helper phải là cửa HẸP: không cấp cho authenticated.
  IF has_function_privilege('authenticated',
       'app_private.ie_actor_is_company_owner_v1(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ie_actor_is_company_owner_v1 không được cấp cho authenticated';
  END IF;

  IF NOT has_function_privilege('authenticated',
       'public.set_forfeit_voucher_kqkd_v1(uuid,boolean,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'set_forfeit_voucher_kqkd_v1 phải cấp EXECUTE cho authenticated';
  END IF;

  IF NOT has_function_privilege('authenticated',
       'public.is_company_owner_self_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'is_company_owner_self_v1 phải cấp EXECUTE cho authenticated';
  END IF;
END
$smoke$;

COMMIT;

NOTIFY pgrst, 'reload schema';
