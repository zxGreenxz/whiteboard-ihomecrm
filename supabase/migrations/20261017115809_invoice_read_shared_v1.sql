-- Hoá đơn: công thức danh sách + thẻ thống kê của màn /invoices thành HÀM SQL DÙNG CHUNG
-- (chủ chốt 17/10/2026). Web, Hermes và báo cáo sau này gọi cùng một hàm nên số luôn khớp.
--
-- invoice_list_v1        = danh sách hoá đơn (trước ở src/hooks/useInvoices.ts: PostgREST
--                          select + bộ lọc/sắp xếp/phân trang phía web + 2 RPC phụ).
-- invoice_statistics_v3  = thẻ thống kê (trước là get_invoice_statistics_v2). v2 GIỮ NGUYÊN
--                          cho chỗ khác còn gọi (Copilot, đối chiếu lợi nhuận).
--
-- MÔ HÌNH (quyết định chung 18/10/2026, review #196/#197): INVOKER + RLS.
--   Hai hàm trên là SECURITY INVOKER, search_path '': đọc invoices và mọi bảng lồng BẰNG RLS
--   CỦA NGƯỜI GỌI (không chép policy). Từ chối khi current_user khác `authenticated` hoặc
--   auth.uid() NULL (gọi từ thân DEFINER sẽ bỏ RLS).
--   Phần phải vượt RLS tách thành hàm DEFINER nhỏ, tự kiểm auth.uid() và TỰ giao phạm vi của
--   chính người gọi (không tin tập id bên gọi truyền vào):
--     invoice_scope_building_ids_v1   tập toà có invoices.view ∩ buildings.view (bộ giải chung
--                                     authorized_scope_all_v3, bỏ toà xoá mềm) — thay
--                                     staff_assignments của v2. Chỉ trả id.
--     invoice_receipt_methods_v1      hoá đơn theo phương thức phiếu thu còn hiệu lực (lọc được
--                                     theo một phương thức). Chỉ trả tập id.
--     invoice_statistics_money_v1     NGOẠI LỆ "DEFINER trả tổng" (docs/CODEBASE_STRUCTURE.md, mục
--                                     Công thức dùng chung): tiền đã thu theo phương thức, tiền
--                                     thối, cọc đã thu. Tính phạm vi MỘT lần, trả ĐÚNG MỘT dòng tổng,
--                                     không trả danh sách; bất biến khoá bằng test PGlite.
--   Lý do vượt RLS: policy invoice_payment_tenders/collections/income_expenses gọi
--   can_access_building/building_of_invoice TỪNG DÒNG — đo TEST 18/10: tổng thu một kỳ dưới RLS
--   ~3,0 s (joey), lọc thẻ TM ~3,0 s, khối tiền thối ~430 ms, khối cọc ~950 ms (chủ).
--   p_building_ids: phạm vi người gọi (Hermes truyền toà của kết nối) — CHỈ THU HẸP (AND thêm):
--   NULL = toàn phạm vi RLS, '{}' = không dòng nào. p_filter_building_ids (bộ lọc màn) như vậy.
--
-- THAY ĐỔI HÀNH VI (chủ ý, ghi cả trong PR #201):
--   (1) Danh sách theo invoices.view TỪNG TOÀ. Trang /invoices vốn chặn bằng RequirePermission
--       module="invoices" (financeWorkRoutes.tsx) nhưng danh sách cũ đọc PostgREST chỉ theo RLS
--       invoices: người có invoices.view ở toà A mà chỉ có buildings.view ở toà B trước thấy cả
--       hoá đơn toà B — nay KHÔNG thấy.
--   (2) Thẻ thống kê theo quyền thật thay staff_assignments: chủ công ty không phân công toà nào
--       hết ra 0; nhân viên có quyền ở toà không được phân công thì thẻ tính đủ như bảng. Người
--       quản lý lợi nhuận (profit_manager_salary_buildings — v2 cộng các toà này) nay chỉ thấy thẻ
--       của toà mình có invoices.view.
--   (3) Tìm theo tên khách không còn cắt 200 khách khớp đầu tiên.
--   (4) Lọc thẻ TM/TK/TT/CT trả tổng số đúng (web cũ: rpc().select(…, {count}) bỏ count ⇒ tổng 0).
--   (5) Thứ tự trong nhóm trùng khoá sắp xếp xác định bằng id.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Bản nháp đã áp TEST 17–18/10 (không có ở production): dọn.
DROP FUNCTION IF EXISTS app_private.invoice_read_context_v1(uuid, uuid[], uuid[]);
DROP FUNCTION IF EXISTS app_private.invoice_read_args_v1(text, text, text, integer, integer);
DROP FUNCTION IF EXISTS app_private.invoice_search_pattern_v1(text);
DROP FUNCTION IF EXISTS public.invoice_deposit_type_ids_v1();
DROP FUNCTION IF EXISTS public.invoice_receipt_methods_v1(uuid[]);
DROP FUNCTION IF EXISTS public.invoice_receipt_totals_v1(uuid[]);
DROP FUNCTION IF EXISTS public.invoice_change_voucher_ids_v1(uuid[]);
DROP FUNCTION IF EXISTS public.invoice_deposit_item_ids_v1(text, uuid[], uuid[], date, date, uuid[]);

-- Tập toà người gọi được đọc hoá đơn. Người thường: MỘT truy vấn trên buildings — bỏ toà xoá mềm
-- (như hậu kỳ app_private.buildings_for_v3; hai vế super admin/demo/sandbox của hàm đó luôn sai với
-- người thường), rồi đòi ĐỒNG THỜI buildings.view và invoices.view. Super admin: mọi toà trừ sandbox
-- và toà của tài khoản demo (như nhánh đặc quyền của v2 và RLS super_admin_all + hide_demo/sandbox),
-- kể cả toà đã xoá.
CREATE OR REPLACE FUNCTION public.invoice_scope_building_ids_v1()
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_orgs uuid[];
  v_sandbox uuid[];
  v_demo uuid[];
  v_view_org_wide boolean;
  v_view_ids uuid[];
  v_invoice_org_wide boolean;
  v_invoice_ids uuid[];
  v_result uuid[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'invoice_read_unauthenticated' USING ERRCODE = '42501';
  END IF;
  IF public.is_super_admin() THEN
    v_sandbox := public.sandbox_org_ids();
    v_demo := public.demo_user_ids();
    SELECT coalesce(array_agg(b.id ORDER BY b.id), '{}'::uuid[]) INTO v_result
      FROM public.buildings b
     WHERE NOT coalesce(b.organization_id = ANY (v_sandbox), false)
       AND NOT coalesce(b.user_id = ANY (v_demo), false);
    RETURN v_result;
  END IF;
  v_orgs := public.my_org_ids();
  SELECT s.org_wide, s.building_ids INTO v_view_org_wide, v_view_ids
    FROM app_private.authorized_scope_all_v3('buildings.view') s;
  SELECT s.org_wide, s.building_ids INTO v_invoice_org_wide, v_invoice_ids
    FROM app_private.authorized_scope_all_v3('invoices.view') s;
  SELECT coalesce(array_agg(b.id ORDER BY b.id), '{}'::uuid[]) INTO v_result
    FROM public.buildings b
   WHERE b.deleted_at IS NULL
     -- buildings.view (như RLS bảng invoices cũ)
     AND CASE WHEN coalesce(v_view_org_wide, false) THEN b.organization_id = ANY (v_orgs)
              ELSE b.id = ANY (coalesce(v_view_ids, '{}'::uuid[])) END
     -- invoices.view (quyền của màn /invoices)
     AND CASE WHEN coalesce(v_invoice_org_wide, false) THEN b.organization_id = ANY (v_orgs)
              ELSE b.id = ANY (coalesce(v_invoice_ids, '{}'::uuid[])) END;
  RETURN v_result;
END
$fn$;

-- Hoá đơn (trong phạm vi người gọi) có phiếu thu còn hiệu lực theo từng phương thức.
-- p_invoice_ids NULL = mọi hoá đơn trong phạm vi; truyền mảng thì chỉ xét các hoá đơn đó.
-- p_payment_method: chỉ gom đúng một phương thức (bấm thẻ TM/TK/TT/CT). Chỉ trả tập id.
CREATE OR REPLACE FUNCTION public.invoice_receipt_methods_v1(
  p_invoice_ids uuid[] DEFAULT NULL,
  p_payment_method public.payment_method DEFAULT NULL)
RETURNS TABLE (payment_method text, invoice_ids uuid[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_scope uuid[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'invoice_read_unauthenticated' USING ERRCODE = '42501';
  END IF;
  v_scope := public.invoice_scope_building_ids_v1();
  RETURN QUERY
  SELECT r.payment_method::text, array_agg(DISTINCT r.invoice_id ORDER BY r.invoice_id)
    FROM public.active_payment_receipts r
    JOIN public.invoices i ON i.id = r.invoice_id AND i.organization_id = r.organization_id
   WHERE r.collected_amount > 0
     AND i.building_id = ANY (v_scope)
     AND (p_invoice_ids IS NULL OR r.invoice_id = ANY (p_invoice_ids))
     AND (p_payment_method IS NULL OR r.payment_method::text = p_payment_method::text)
   GROUP BY r.payment_method;
END
$fn$;

-- Khối tiền của thẻ thống kê (cùng công thức get_invoice_statistics_v2) — NGOẠI LỆ "DEFINER trả tổng":
--   * tiền đã thu theo phương thức + tiền thối: chỉ của tập hoá đơn bên gọi đã đọc qua RLS, SAU KHI
--     giao lại với phạm vi của chính người gọi (id ngoài phạm vi, toà xoá mềm, công ty khác bị bỏ);
--   * cọc đã thu: Σ DÒNG cọc (loại thu is_deposit) của phiếu thu đã duyệt theo toà/phòng/ngày phiếu
--     trong phạm vi người gọi (không đọc income_expense_types qua RLS — đòi categories.view, thiếu
--     thì thẻ cọc về 0 dù v2 vẫn tính).
-- Phạm vi tính MỘT lần; trả ĐÚNG MỘT dòng tổng, không bao giờ trả danh sách.
CREATE OR REPLACE FUNCTION public.invoice_statistics_money_v1(
  p_invoice_ids uuid[],
  p_billing_month text DEFAULT NULL,
  p_filter_building_ids uuid[] DEFAULT NULL,
  p_room_ids uuid[] DEFAULT NULL,
  p_issue_date_from date DEFAULT NULL,
  p_issue_date_to date DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL)
RETURNS TABLE (total_collected numeric, payment_tm numeric, payment_tk numeric,
               payment_tt numeric, payment_ct numeric, change_amount numeric,
               deposit_collected numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_scope uuid[];
  v_ids uuid[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'invoice_read_unauthenticated' USING ERRCODE = '42501';
  END IF;
  v_scope := public.invoice_scope_building_ids_v1();
  -- Không tin tập id bên gọi: chỉ giữ hoá đơn thuộc toà trong phạm vi của chính người gọi.
  SELECT coalesce(array_agg(i.id), '{}'::uuid[]) INTO v_ids
    FROM public.invoices i
   WHERE i.id = ANY (coalesce(p_invoice_ids, '{}'::uuid[]))
     AND i.building_id = ANY (v_scope);

  RETURN QUERY
  WITH receipts AS (
    SELECT coalesce(sum(r.collected_amount), 0) AS total_collected,
           coalesce(sum(CASE WHEN r.payment_method::text = 'TM' THEN r.collected_amount ELSE 0 END), 0) AS payment_tm,
           coalesce(sum(CASE WHEN r.payment_method::text = 'TK' THEN r.collected_amount ELSE 0 END), 0) AS payment_tk,
           coalesce(sum(CASE WHEN r.payment_method::text = 'TT' THEN r.collected_amount ELSE 0 END), 0) AS payment_tt,
           coalesce(sum(CASE WHEN r.payment_method::text = 'CT' THEN r.collected_amount ELSE 0 END), 0) AS payment_ct
      FROM public.active_payment_receipts r
     WHERE r.invoice_id = ANY (v_ids)
  ),
  change AS (
    SELECT coalesce(sum(ie.change_amount), 0) AS change_amount
      FROM public.income_expenses ie
     WHERE ie.invoice_id = ANY (v_ids)
       AND ie.deleted_at IS NULL
       AND ie.type = 'INCOME'
       AND ie.change_amount > 0
       AND (ie.payment_collection_id IS NULL OR EXISTS (
             SELECT 1 FROM public.invoice_payment_collections active_collection
              WHERE active_collection.id = ie.payment_collection_id AND active_collection.status = 'ACTIVE'))
       AND (ie.payment_id IS NULL OR EXISTS (
             SELECT 1 FROM public.active_payments active_payment WHERE active_payment.id = ie.payment_id))
  ),
  deposit AS (
    SELECT coalesce(sum(it.amount), 0) AS deposit_collected
      FROM public.income_expenses ie
      JOIN public.income_expense_items it ON it.income_expense_id = ie.id
      JOIN public.income_expense_types t ON t.id = it.income_expense_type_id AND t.is_deposit = TRUE
     WHERE ie.deleted_at IS NULL
       AND ie.type = 'INCOME'
       AND ie.approval_status = 'APPROVED'
       AND ie.building_id = ANY (v_scope)
       AND (p_building_ids IS NULL OR ie.building_id = ANY (p_building_ids))
       AND (p_filter_building_ids IS NULL OR ie.building_id = ANY (p_filter_building_ids))
       AND (ie.payment_collection_id IS NULL OR EXISTS (
             SELECT 1 FROM public.invoice_payment_collections active_collection
              WHERE active_collection.id = ie.payment_collection_id AND active_collection.status = 'ACTIVE'))
       AND (ie.payment_id IS NULL OR EXISTS (
             SELECT 1 FROM public.active_payments active_payment WHERE active_payment.id = ie.payment_id))
       AND (p_room_ids IS NULL OR ie.room_id = ANY (p_room_ids))
       AND (p_issue_date_from IS NULL OR ie.voucher_date >= p_issue_date_from)
       AND (p_issue_date_to IS NULL OR ie.voucher_date <= p_issue_date_to)
       AND (p_billing_month IS NULL OR to_char(ie.voucher_date, 'YYYY-MM') = p_billing_month)
  )
  SELECT receipts.total_collected, receipts.payment_tm, receipts.payment_tk, receipts.payment_tt,
         receipts.payment_ct, change.change_amount, deposit.deposit_collected
    FROM receipts, change, deposit;
END
$fn$;

CREATE OR REPLACE FUNCTION public.invoice_list_v1(
  p_billing_month text DEFAULT NULL,
  p_view_status text DEFAULT 'active',
  p_status public.invoice_status DEFAULT NULL,
  p_payment_status text DEFAULT NULL,
  p_filter_building_ids uuid[] DEFAULT NULL,
  p_room_ids uuid[] DEFAULT NULL,
  p_contract_id uuid DEFAULT NULL,
  p_issue_date_from date DEFAULT NULL,
  p_issue_date_to date DEFAULT NULL,
  p_amount_target numeric DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_adjustment_review_status text DEFAULT NULL,
  p_payment_method public.payment_method DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_scope uuid[];
  v_method_ids uuid[];
  v_pattern text;
  v_q text;
  v_result jsonb;
BEGIN
  IF current_user IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'invoice_list_v1 chỉ chạy bằng JWT người dùng' USING ERRCODE = '42501';
  END IF;
  IF (p_view_status IS NOT NULL AND p_view_status NOT IN ('active', 'cancelled', 'all'))
     OR (p_payment_status IS NOT NULL AND p_payment_status NOT IN ('paid', 'partial', 'unpaid'))
     OR (p_adjustment_review_status IS NOT NULL AND p_adjustment_review_status NOT IN ('pending', 'checked'))
     OR (p_limit IS NOT NULL AND p_limit < 1) OR (p_offset IS NOT NULL AND p_offset < 0) THEN
    RAISE EXCEPTION 'Tham số danh sách hoá đơn không hợp lệ' USING ERRCODE = '22023';
  END IF;

  v_scope := public.invoice_scope_building_ids_v1();
  IF p_payment_method IS NOT NULL THEN
    -- Chỉ gom phiếu thu đúng phương thức đang bấm, không gom toàn lịch sử mọi phương thức.
    SELECT coalesce((SELECT m.invoice_ids FROM public.invoice_receipt_methods_v1(NULL, p_payment_method) m), '{}'::uuid[])
      INTO v_method_ids;
  END IF;
  -- Ô tìm kiếm như web cũ: , ( ) → khoảng trắng, gộp khoảng trắng (kể cả khoảng trắng Unicode
  -- mà \s của JavaScript nhận), cắt hai đầu; '*' là '%' như PostgREST. Rỗng ⇒ không lọc.
  v_q := btrim(regexp_replace(regexp_replace(coalesce(p_search, ''), '[,()]', ' ', 'g'),
           '[\s' || chr(160) || chr(5760) || chr(8192) || '-' || chr(8202) || chr(8232) || chr(8233)
             || chr(8239) || chr(8287) || chr(12288) || chr(65279) || ']+', ' ', 'g'));
  IF v_q <> '' THEN
    v_pattern := '%' || replace(v_q, '*', '%') || '%';
  END IF;

  WITH search_hits AS MATERIALIZED (
    -- Hợp đồng có khách khớp tên — khách và liên kết đọc qua RLS (customers.view…) như web.
    SELECT DISTINCT cc.contract_id
      FROM public.customers cu
      JOIN public.contract_customers cc ON cc.customer_id = cu.id
     WHERE v_pattern IS NOT NULL AND cu.full_name ILIKE v_pattern AND cc.contract_id IS NOT NULL
  ),
  matched AS MATERIALIZED (
    SELECT i.id, i.billing_month, i.created_at, vb.name_sort AS building_sort, vr.name_sort AS room_sort
      FROM public.invoices i
      -- Như ORDER BY building(name_sort)/room(name_sort) của PostgREST: toà/phòng đọc qua RLS.
      LEFT JOIN public.buildings vb ON vb.id = i.building_id
      LEFT JOIN public.rooms vr ON vr.id = i.room_id
     WHERE i.deleted_at IS NULL
       AND i.building_id = ANY (v_scope)
       AND (p_building_ids IS NULL OR i.building_id = ANY (p_building_ids))
       AND (p_filter_building_ids IS NULL OR i.building_id = ANY (p_filter_building_ids))
       AND (p_room_ids IS NULL OR i.room_id = ANY (p_room_ids))
       AND (p_contract_id IS NULL OR i.contract_id = p_contract_id)
       AND (p_status IS NULL OR i.status = p_status)
       AND (p_payment_status IS NULL
            OR (p_payment_status = 'paid' AND i.status = 'PAID')
            OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
            -- Chưa thu đồng nào: loại cả PAID lẫn PARTIAL_PAID.
            OR (p_payment_status = 'unpaid' AND i.status NOT IN ('PAID', 'PARTIAL_PAID')))
       -- Vòng đời: mặc định 'active' ẩn hoá đơn huỷ, trừ khi đã chọn đích danh một trạng thái.
       AND CASE coalesce(p_view_status, 'active')
             WHEN 'active' THEN p_status IS NOT NULL OR i.status <> 'CANCELLED'
             WHEN 'cancelled' THEN i.status = 'CANCELLED'
             ELSE true
           END
       AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
       AND (p_issue_date_from IS NULL OR i.issue_date >= p_issue_date_from)
       AND (p_issue_date_to IS NULL OR i.issue_date <= p_issue_date_to)
       -- Gõ số vào ô tìm: tổng tiền ± 5.000đ (AMOUNT_SEARCH_TOLERANCE của web).
       AND (p_amount_target IS NULL
            OR i.total_amount BETWEEN p_amount_target - 5000 AND p_amount_target + 5000)
       AND (p_adjustment_review_status IS NULL
            OR i.adjustment_review_status = CASE p_adjustment_review_status WHEN 'pending' THEN 'PENDING' ELSE 'CHECKED' END)
       -- Bấm thẻ TM/TK/TT/CT: hoá đơn có ít nhất một phiếu thu còn hiệu lực đúng phương thức.
       AND (p_payment_method IS NULL OR i.id = ANY (v_method_ids))
       AND (v_pattern IS NULL
            OR i.invoice_number ILIKE v_pattern
            OR i.contract_id IN (SELECT h.contract_id FROM search_hits h))
  ),
  -- Kỳ mới nhất trước; trong kỳ: toà A→Z → phòng (name_sort) → mới tạo trước; id chốt thứ tự.
  page AS MATERIALIZED (
    SELECT m.*
      FROM matched m
     ORDER BY m.billing_month DESC, m.building_sort ASC NULLS LAST, m.room_sort ASC NULLS LAST,
              m.created_at DESC, m.id
     LIMIT least(coalesce(p_limit, 20), 1000) OFFSET coalesce(p_offset, 0)
  ),
  page_methods AS MATERIALIZED (
    SELECT u.invoice_id, jsonb_agg(m.payment_method ORDER BY m.payment_method) AS methods
      -- coalesce: trang rỗng phải là '{}' (không phải NULL = mọi hoá đơn trong phạm vi).
      FROM public.invoice_receipt_methods_v1((SELECT coalesce(array_agg(p.id), '{}'::uuid[]) FROM page p), NULL) m
     CROSS JOIN LATERAL unnest(m.invoice_ids) AS u(invoice_id)
     GROUP BY u.invoice_id
  )
  SELECT jsonb_build_object(
    'total_count', (SELECT count(*) FROM matched),
    'rows', coalesce((
      SELECT jsonb_agg(
        to_jsonb(i) || jsonb_build_object(
          'contract', (
            SELECT jsonb_build_object(
              'id', c.id, 'contract_number', c.contract_number, 'status', c.status,
              'public_code', c.public_code, 'start_billing_date', c.start_billing_date,
              'contract_customers', coalesce((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', cc.id, 'is_representative', cc.is_representative,
                  'customer', (SELECT jsonb_build_object('id', cu.id, 'full_name', cu.full_name, 'phone', cu.phone)
                                 FROM public.customers cu WHERE cu.id = cc.customer_id))
                  ORDER BY cc.created_at, cc.id)
                  FROM public.contract_customers cc
                 WHERE cc.contract_id = c.id), '[]'::jsonb))
              FROM public.contracts c
             WHERE c.id = i.contract_id),
          'building', CASE WHEN vb.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', vb.id, 'name', vb.name, 'name_sort', vb.name_sort,
            'default_account_id_tt', vb.default_account_id_tt, 'default_account_id_tk', vb.default_account_id_tk) END,
          'room', CASE WHEN vr.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', vr.id, 'name', vr.name, 'name_sort', vr.name_sort) END,
          'invoice_items', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'id', ii.id, 'type', ii.type, 'accounting_class', ii.accounting_class,
              'description', ii.description, 'unit_price', ii.unit_price, 'quantity', ii.quantity,
              'coefficient', ii.coefficient, 'amount', ii.amount, 'service_id', ii.service_id,
              'previous_reading', ii.previous_reading, 'current_reading', ii.current_reading,
              'from_date', ii.from_date, 'to_date', ii.to_date, 'sort_order', ii.sort_order)
              ORDER BY ii.sort_order, ii.id)
              FROM public.invoice_items ii
             WHERE ii.invoice_id = i.id), '[]'::jsonb),
          -- Chỉ phiếu thu chưa đảo (web cũ lọc reversed_at ở trình duyệt).
          'payments', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'id', pm.id, 'amount', pm.amount, 'payment_date', pm.payment_date,
              'payment_method', pm.payment_method, 'notes', pm.notes,
              'receipt_image_url', pm.receipt_image_url, 'collection_id', pm.collection_id,
              'reversed_at', pm.reversed_at)
              ORDER BY pm.payment_date, pm.id)
              FROM public.payments pm
             WHERE pm.invoice_id = i.id AND pm.reversed_at IS NULL), '[]'::jsonb),
          'invoice_adjustments', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'id', ad.id, 'organization_id', ad.organization_id, 'invoice_id', ad.invoice_id,
              'revision', ad.revision, 'idempotency_key', ad.idempotency_key, 'reason', ad.reason,
              'before_snapshot', ad.before_snapshot, 'after_snapshot', ad.after_snapshot,
              'before_total', ad.before_total, 'after_total', ad.after_total, 'delta', ad.delta,
              'adjusted_by', ad.adjusted_by, 'adjusted_at', ad.adjusted_at,
              'review_status', ad.review_status, 'checked_by', ad.checked_by, 'checked_at', ad.checked_at)
              ORDER BY ad.revision, ad.id)
              FROM public.invoice_adjustments ad
             WHERE ad.invoice_id = i.id), '[]'::jsonb),
          -- Phương thức của các phiếu thu còn hiệu lực (tô màu thẻ TM/TK/TT/CT trên dòng).
          'active_payment_methods', coalesce(pmx.methods, '[]'::jsonb))
        ORDER BY p.billing_month DESC, p.building_sort ASC NULLS LAST, p.room_sort ASC NULLS LAST,
                 p.created_at DESC, p.id)
        FROM page p
        JOIN public.invoices i ON i.id = p.id
        LEFT JOIN public.buildings vb ON vb.id = i.building_id
        LEFT JOIN public.rooms vr ON vr.id = i.room_id
        LEFT JOIN page_methods pmx ON pmx.invoice_id = p.id), '[]'::jsonb))
  INTO v_result;

  RETURN v_result;
END
$fn$;

-- Thẻ thống kê: cùng công thức get_invoice_statistics_v2 (huỷ không tính trừ khi hỏi đích danh
-- CANCELLED; điện/nước/dịch vụ theo mô tả dòng; tiền thối; cọc đã thu theo ngày phiếu) trên
-- CÙNG tập hoá đơn với invoice_list_v1 (RLS + invoice_scope_building_ids_v1 + cùng bộ lọc ngày
-- lập/kỳ). Đọc invoices MỘT lần dưới RLS; các khối tiền đi một helper DEFINER trả một dòng tổng.
CREATE OR REPLACE FUNCTION public.invoice_statistics_v3(
  p_billing_month text DEFAULT NULL,
  p_status public.invoice_status DEFAULT NULL,
  p_payment_status text DEFAULT NULL,
  p_filter_building_ids uuid[] DEFAULT NULL,
  p_room_ids uuid[] DEFAULT NULL,
  p_issue_date_from date DEFAULT NULL,
  p_issue_date_to date DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL)
RETURNS TABLE (
  total_amount numeric,
  total_paid numeric,
  total_remaining numeric,
  total_refunded numeric,
  total_count bigint,
  rent_amount numeric,
  electric_amount numeric,
  water_amount numeric,
  pdv_amount numeric,
  total_collected numeric,
  payment_tm numeric,
  payment_tk numeric,
  payment_tt numeric,
  payment_ct numeric,
  change_amount numeric,
  deposit_collected numeric)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_scope uuid[];
BEGIN
  IF current_user IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'invoice_statistics_v3 chỉ chạy bằng JWT người dùng' USING ERRCODE = '42501';
  END IF;
  IF p_payment_status IS NOT NULL AND p_payment_status NOT IN ('paid', 'partial', 'unpaid') THEN
    RAISE EXCEPTION 'Tham số thống kê hoá đơn không hợp lệ' USING ERRCODE = '22023';
  END IF;
  v_scope := public.invoice_scope_building_ids_v1();

  RETURN QUERY
  -- Cùng tập hoá đơn với invoice_list_v1: RLS + phạm vi invoices.view + cùng bộ lọc kỳ/ngày lập.
  WITH inv AS MATERIALIZED (
    SELECT i.id, i.total_amount, i.paid_amount, i.remaining_amount
      FROM public.invoices i
     WHERE i.deleted_at IS NULL
       AND i.building_id = ANY (v_scope)
       AND (p_building_ids IS NULL OR i.building_id = ANY (p_building_ids))
       AND (p_filter_building_ids IS NULL OR i.building_id = ANY (p_filter_building_ids))
       AND (p_room_ids IS NULL OR i.room_id = ANY (p_room_ids))
       AND (p_status IS NULL OR i.status = p_status)
       -- [A1] Hoá đơn đã HUỶ không còn là công nợ: loại khỏi mọi tổng, TRỪ khi hỏi đích danh.
       AND (p_status IS NOT DISTINCT FROM 'CANCELLED'::public.invoice_status OR i.status <> 'CANCELLED')
       AND (p_issue_date_from IS NULL OR i.issue_date >= p_issue_date_from)
       AND (p_issue_date_to IS NULL OR i.issue_date <= p_issue_date_to)
       AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
       AND (p_payment_status IS NULL
            OR (p_payment_status = 'paid' AND i.status = 'PAID')
            OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
            OR (p_payment_status = 'unpaid' AND i.status NOT IN ('PAID', 'PARTIAL_PAID')))
  ),
  totals AS (
    SELECT coalesce(sum(inv.total_amount), 0) AS total_amount,
           coalesce(sum(inv.paid_amount), 0) AS total_paid,
           coalesce(sum(greatest(inv.remaining_amount, 0)), 0) AS total_remaining,
           coalesce(sum(greatest(-inv.remaining_amount, 0)), 0) AS total_refunded,
           count(*) AS total_count,
           coalesce(array_agg(inv.id), '{}'::uuid[]) AS ids
      FROM inv
  ),
  items AS (
    SELECT coalesce(sum(CASE WHEN ii.type = 'RENT' THEN ii.amount ELSE 0 END), 0) AS rent_amount,
           coalesce(sum(CASE WHEN ii.type NOT IN ('RENT', 'DISCOUNT')
                              AND lower(coalesce(ii.description, '')) LIKE '%điện%'
                             THEN ii.amount ELSE 0 END), 0) AS electric_amount,
           coalesce(sum(CASE WHEN ii.type NOT IN ('RENT', 'DISCOUNT')
                              AND lower(coalesce(ii.description, '')) LIKE '%nước%'
                             THEN ii.amount ELSE 0 END), 0) AS water_amount,
           coalesce(sum(CASE WHEN ii.type NOT IN ('RENT', 'DISCOUNT')
                              AND lower(coalesce(ii.description, '')) NOT LIKE '%điện%'
                              AND lower(coalesce(ii.description, '')) NOT LIKE '%nước%'
                             THEN ii.amount ELSE 0 END), 0) AS pdv_amount
      FROM inv JOIN public.invoice_items ii ON ii.invoice_id = inv.id
  ),
  money AS (
    SELECT m.*
      FROM totals
     CROSS JOIN LATERAL public.invoice_statistics_money_v1(totals.ids, p_billing_month, p_filter_building_ids,
       p_room_ids, p_issue_date_from, p_issue_date_to, p_building_ids) m
  )
  -- numeric(15,2) như các biến DECIMAL(15,2) của v2.
  SELECT totals.total_amount::numeric(15,2), totals.total_paid::numeric(15,2),
         totals.total_remaining::numeric(15,2), totals.total_refunded::numeric(15,2), totals.total_count,
         items.rent_amount::numeric(15,2), items.electric_amount::numeric(15,2),
         items.water_amount::numeric(15,2), items.pdv_amount::numeric(15,2),
         money.total_collected::numeric(15,2), money.payment_tm::numeric(15,2),
         money.payment_tk::numeric(15,2), money.payment_tt::numeric(15,2),
         money.payment_ct::numeric(15,2), money.change_amount::numeric(15,2),
         money.deposit_collected::numeric(15,2)
    FROM totals, items, money;
END
$fn$;

COMMENT ON FUNCTION public.invoice_list_v1(text, text, public.invoice_status, text, uuid[], uuid[], uuid, date, date, numeric, text, text, public.payment_method, uuid[], integer, integer) IS
  'Danh sách hoá đơn dùng chung (web /invoices, Hermes). INVOKER: RLS của người gọi, chỉ chạy bằng JWT (current_user authenticated). Trả {total_count, rows}; dòng = cột invoices + contract/building/room/invoice_items/payments(chưa đảo)/invoice_adjustments/active_payment_methods. Phạm vi: RLS ∩ invoice_scope_building_ids_v1 (invoices.view ∩ buildings.view). p_building_ids và p_filter_building_ids CHỈ THU HẸP: NULL = toàn phạm vi RLS, ''{}'' = không dòng nào.';
COMMENT ON FUNCTION public.invoice_statistics_v3(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[]) IS
  'Thẻ thống kê hoá đơn dùng chung — công thức get_invoice_statistics_v2 trên cùng tập hoá đơn với invoice_list_v1 (INVOKER + RLS + invoices.view thật, không theo staff_assignments). p_building_ids chỉ thu hẹp: NULL = toàn phạm vi, ''{}'' = rỗng.';
COMMENT ON FUNCTION public.invoice_scope_building_ids_v1() IS
  'DEFINER nhỏ: tập toà người gọi đọc được hoá đơn (invoices.view ∩ buildings.view qua authorized_scope_all_v3, bỏ toà xoá mềm; super admin: mọi toà trừ sandbox/demo). Chỉ trả id.';
COMMENT ON FUNCTION public.invoice_receipt_methods_v1(uuid[], public.payment_method) IS
  'DEFINER nhỏ: hoá đơn trong phạm vi người gọi có phiếu thu còn hiệu lực theo từng phương thức (vượt RLS phiếu thu vốn kiểm từng dòng). Chỉ trả tập id.';
COMMENT ON FUNCTION public.invoice_statistics_money_v1(uuid[], text, uuid[], uuid[], date, date, uuid[]) IS
  'DEFINER trả TỔNG (ngoại lệ có điều kiện, docs/CODEBASE_STRUCTURE.md#công-thức-dùng-chung): tiền đã thu theo phương thức + tiền thối của tập hoá đơn đã đọc qua RLS, cọc đã thu theo toà/phòng/ngày phiếu. Tự giao phạm vi của chính người gọi một lần; trả đúng một dòng tổng, không trả danh sách.';

ALTER FUNCTION public.invoice_scope_building_ids_v1() OWNER TO postgres;
ALTER FUNCTION public.invoice_receipt_methods_v1(uuid[], public.payment_method) OWNER TO postgres;
ALTER FUNCTION public.invoice_statistics_money_v1(uuid[], text, uuid[], uuid[], date, date, uuid[]) OWNER TO postgres;
ALTER FUNCTION public.invoice_list_v1(text, text, public.invoice_status, text, uuid[], uuid[], uuid, date, date, numeric, text, text, public.payment_method, uuid[], integer, integer) OWNER TO postgres;
ALTER FUNCTION public.invoice_statistics_v3(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[]) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.invoice_scope_building_ids_v1(),
  public.invoice_receipt_methods_v1(uuid[], public.payment_method),
  public.invoice_statistics_money_v1(uuid[], text, uuid[], uuid[], date, date, uuid[]),
  public.invoice_list_v1(text, text, public.invoice_status, text, uuid[], uuid[], uuid, date, date, numeric, text, text, public.payment_method, uuid[], integer, integer),
  public.invoice_statistics_v3(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_scope_building_ids_v1(),
  public.invoice_receipt_methods_v1(uuid[], public.payment_method),
  public.invoice_statistics_money_v1(uuid[], text, uuid[], uuid[], date, date, uuid[]),
  public.invoice_list_v1(text, text, public.invoice_status, text, uuid[], uuid[], uuid, date, date, numeric, text, text, public.payment_method, uuid[], integer, integer),
  public.invoice_statistics_v3(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[])
  TO authenticated;
COMMIT;
NOTIFY pgrst, 'reload schema';
