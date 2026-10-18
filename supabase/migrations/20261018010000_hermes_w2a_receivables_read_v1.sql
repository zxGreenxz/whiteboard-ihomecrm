-- Hermes đọc đầy đủ — ĐỢT 2, Gói A: thu tiền, công nợ, cọc (18/10/2026). Chạy SAU nền đợt 2
-- (20261018000000 → 000500 → 000600 cổng INVOKER: public.hermes_w2_read_v1 → bước kiểm quyền DEFINER dựng ctx →
-- hàm đọc gói INVOKER dưới RLS người hỏi → bước kết thúc DEFINER rào đầu ra/phân trang → 000700 rào công ty: mọi
-- hàng mang organizationId lấy từ CỘT nguồn, bước kết thúc so với công ty kết nối rồi gỡ).
-- Chủ chốt 17/10: theo ĐÚNG quyền user trên web ∩ overlay Read ∩ toà kết nối. Công thức dùng ≥2 nơi hoặc dính
-- tiền/quyền đặt trong hàm SQL dùng chung public.<miền>_<báo cáo>_v1(..., p_building_ids):
--  (a) màn web có RPC ⇒ Hermes gọi THẲNG RPC đó;
--  (b) màn web đọc bảng thẳng ⇒ hàm dùng chung mới theo mô hình INVOKER + RLS (quyết định kiến trúc 18/10 sau hai
--      review độc lập): SECURITY INVOKER, search_path='', từ chối khi current_user <> 'authenticated' hoặc
--      auth.uid() NULL; đọc bảng gốc dưới RLS của chính người hỏi (KHÔNG chép policy: tên khách ẩn khi RLS
--      customers ẩn, phiếu có hạng mục hạn chế ẩn khi RLS income_expenses ẩn); đúng bộ lọc web; p_building_ids chỉ
--      thu hẹp (NULL = toàn phạm vi RLS, '{}' = rỗng); p_organization_id thu hẹp về một công ty (RLS web trải mọi
--      công ty của người dùng); tự kiểm khoá của trang theo từng toà (public.can_do_on_building) để web gọi thẳng
--      cũng đúng quyền. Web CHƯA chuyển sang các hàm này. ACL: chỉ REVOKE PUBLIC/anon/service_role — authenticated
--      giữ quyền EXECUTE mặc định của schema public (pg_default_acl Supabase), không GRANT riêng.
--  Hàm đọc của gói app_private.hermes_w2a_read_v1 giữ dòng đầu INVOKER của nền, không gọi app_private.* (authenticated
--  không có USAGE), không đổi ACL (nền 000600 cấp).
-- Báo cáo (mã ⇒ khoá ⇒ nguồn web, vùng hermes-parity):
--   payment_schedule        reports_finance.payment_schedule  src/hooks/reports/financeReports.ts usePaymentScheduleReport +
--                                                             PaymentScheduleReport.tsx useMemo (vùng finance-payment-schedule)
--   overpayment             reports_finance.overpayment       financeReports.ts useOverpaymentReport + RPC get_overpayment_summary (finance-overpayment)
--   collection              thu_tien.view                     useCollectionReport.ts useThuTienInvoices, ThuTien.tsx (lọc/thanh tổng),
--                                                             src/lib/collect.ts, useInvoiceCollectors.ts (thu-tien-collection)
--   invoice_detail          invoices.view                     useInvoices.ts useInvoice + InvoiceDetailView.tsx (invoice-detail)
--   reservation_vouchers    deposits.view                     useDeposits.ts useReservationDeposits + RPC get_reservation_deposit_summary,
--                                                             useReservationHoldDeadlines.ts (deposit-reservation-vouchers)
--   reservation_settlements deposits.view                     RPC get_reservation_settlements_v1 + get_reservation_settlement_summary_v1
--                                                             (useReservationSettlement.ts, deposit-reservation-settlements)
--   held_deposits           deposits.view                     useDepositDashboard.ts useHeldDeposits + RPC get_held_deposit_summary (deposit-held-rows)
--   deposit_refunds         deposits.view                     useDepositDashboard.ts useDepositRefundsForfeits + RPC get_refund_forfeit_summary
--                                                             (deposit-refunds)
--   change_ledger           deposits.view                     src/pages/payments/RefundLogPage.tsx useRefundLog (cashbook-change-ledger)
-- A3 (BC tiền cọc, bảng legacy deposits) KHÔNG làm: production 17/10 có 0 dòng (kể cả đã xoá mềm).
-- Không trả SĐT, ảnh chứng từ, snapshot điều chỉnh, tài khoản mặc định của toà; tên khách thêm điều kiện
-- customers.view ở đúng toà của hàng (ctx.scopes) ngoài RLS customers.
-- Thân hàm plpgsql (không kiểm bảng lúc tạo): RPC/bảng web được kiểm bằng lần chạy lane trên TEST + test PGlite gói A.
-- Không DROP, không đổi chữ ký hàm đã phát hành, không gọi hàm copilot nào, không ghi dữ liệu nghiệp vụ.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('public.hermes_w2_read_v1(jsonb,text,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_w2_scope_v1(jsonb,text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'hermes_w2a_requires_foundation';
  END IF;
END $requires$;

-- ── Hàm dùng chung: INVOKER + RLS (web gọi được sau này; Hermes gọi trong phiên của chính người hỏi) ─────────

-- Lịch thanh toán (usePaymentScheduleReport + PaymentScheduleReport.tsx useMemo): hoá đơn chưa xoá, khác CANCELLED,
-- due_date ≤ p_due_until (web: hôm nay+365); gộp theo phòng của hoá đơn (không phòng ⇒ từng hoá đơn); "đã lên hoá
-- đơn đến ngày" = max(billing_period_end || due_date) — bảng invoices KHÔNG có cột billing_period_end nên web luôn
-- rơi về due_date; khách = khách đại diện (không có thì khách đầu) của hợp đồng gắn hoá đơn ĐẦU TIÊN theo due_date
-- tăng (hàng đầu web gặp); RLS ẩn khách ⇒ tên NULL như web. Người gọi sắp: billed_through giảm dần,
-- first_due_date, invoice_id (thứ tự chèn ổn định của web).
CREATE OR REPLACE FUNCTION public.finance_payment_schedule_v1(p_organization_id uuid,p_due_until date,p_building_ids uuid[] DEFAULT NULL)
RETURNS TABLE(building_id uuid,building_name text,room_id uuid,room_name text,invoice_id uuid,contract_id uuid,customer_id uuid,
  customer_name text,billed_through date,first_due_date date)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_b uuid[];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  -- Như web: khoá của trang (RequirePermission) xét theo từng toà, trên toà RLS buildings của người gọi thấy.
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('reports_finance','payment_schedule',b.id);
  RETURN QUERY
  WITH src AS (
    SELECT i.id,i.building_id,i.room_id,i.contract_id,i.due_date,
      row_number() OVER (PARTITION BY i.building_id,COALESCE(i.room_id,i.id) ORDER BY i.due_date,i.id) seq,
      max(i.due_date) OVER (PARTITION BY i.building_id,COALESCE(i.room_id,i.id)) billed
    FROM public.invoices i
    WHERE i.organization_id=p_organization_id AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED'
      AND i.due_date<=p_due_until AND i.building_id=ANY(v_b))
  SELECT s.building_id,b.name,s.room_id,r.name,s.id,s.contract_id,cu.id,cu.full_name,s.billed,s.due_date
  FROM src s
  LEFT JOIN public.buildings b ON b.id=s.building_id
  LEFT JOIN public.rooms r ON r.id=s.room_id
  LEFT JOIN LATERAL (SELECT cc.customer_id FROM public.contract_customers cc WHERE cc.contract_id=s.contract_id
    ORDER BY cc.is_representative DESC,cc.created_at,cc.id LIMIT 1) rep ON true
  LEFT JOIN public.customers cu ON cu.id=rep.customer_id AND cu.organization_id=p_organization_id
  WHERE s.seq=1;
END $fn$;

-- Tiền thừa (useOverpaymentReport): hoá đơn chưa xoá, paid_amount>0 và paid_amount>total_amount (web KHÔNG bỏ
-- CANCELLED ở danh sách, cùng tập với RPC tổng get_overpayment_summary); khách đại diện như trên. Web sắp theo id.
CREATE OR REPLACE FUNCTION public.finance_overpayment_invoices_v1(p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL)
RETURNS TABLE(invoice_id uuid,invoice_number text,building_id uuid,building_name text,room_id uuid,room_name text,contract_id uuid,
  customer_id uuid,customer_name text,total_amount numeric,paid_amount numeric,overpaid_amount numeric)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_b uuid[];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  -- Như web: khoá của trang (RequirePermission) xét theo từng toà, trên toà RLS buildings của người gọi thấy.
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('reports_finance','overpayment',b.id);
  RETURN QUERY
  SELECT i.id,i.invoice_number,i.building_id,b.name,i.room_id,r.name,i.contract_id,cu.id,cu.full_name,i.total_amount,i.paid_amount,
    i.paid_amount-i.total_amount
  FROM public.invoices i
  LEFT JOIN public.buildings b ON b.id=i.building_id
  LEFT JOIN public.rooms r ON r.id=i.room_id
  LEFT JOIN LATERAL (SELECT cc.customer_id FROM public.contract_customers cc WHERE cc.contract_id=i.contract_id
    ORDER BY cc.is_representative DESC,cc.created_at,cc.id LIMIT 1) rep ON true
  LEFT JOIN public.customers cu ON cu.id=rep.customer_id AND cu.organization_id=p_organization_id
  WHERE i.organization_id=p_organization_id AND i.deleted_at IS NULL AND i.paid_amount>0 AND i.paid_amount>i.total_amount
    AND i.building_id=ANY(v_b);
END $fn$;

-- Thu tiền theo kỳ (useThuTienInvoices; ThuTien.tsx lọc/thanh tổng; collect.ts): hoá đơn chưa xoá, khác CANCELLED,
-- billing_month = kỳ. Chế độ thời gian: p_from/p_to NULL = "Cả kỳ"; p_from=p_to=p_today = "Hôm nay"; còn lại =
-- khoảng ngày [lo,hi]. Mọi cờ/khoản tiền theo ĐÚNG hàm web: collectStatus, paymentsInRange, paidUpTo, paidAsOf,
-- remainingAsOf (web cộng MỌI dòng payments nhìn thấy, kể cả dòng đã hoàn tác reversed_at — giữ nguyên để khớp số
-- web). in_scope = timeMatch; status_paid/status_unpaid = statusMatch; summary_* = phần đóng góp của hoá đơn vào
-- thanh tổng (cộng/đếm trên MỌI hoá đơn của toà, không theo tab). collectors: người thu (creator_name) của phiếu
-- thu APPROVED gắn payment, bỏ trùng không phân biệt hoa thường, thu trước → sau (useInvoiceCollectors).
CREATE OR REPLACE FUNCTION public.thu_tien_collection_v1(p_organization_id uuid,p_billing_month text,p_from date,p_to date,p_today date,
  p_building_ids uuid[] DEFAULT NULL)
RETURNS TABLE(invoice_id uuid,invoice_number text,invoice_status text,building_id uuid,building_name text,building_sort text,room_id uuid,
  room_name text,room_sort text,contract_id uuid,customer_id uuid,customer_name text,total_amount numeric,paid_amount numeric,
  remaining_amount numeric,collect_status text,time_mode text,collected_in_range numeric,in_scope boolean,status_paid boolean,
  status_unpaid boolean,summary_collected numeric,summary_paid boolean,summary_due boolean,summary_remaining numeric,collectors text[])
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_b uuid[];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  -- Như web: khoá của trang (RequirePermission) xét theo từng toà, trên toà RLS buildings của người gọi thấy.
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('thu_tien','view',b.id);
  RETURN QUERY
  WITH win AS (SELECT CASE WHEN p_from IS NULL AND p_to IS NULL THEN 'all'
      WHEN COALESCE(p_from,p_to)=p_today AND COALESCE(p_to,p_from)=p_today THEN 'today' ELSE 'date' END mode,
    LEAST(COALESCE(p_from,p_to),COALESCE(p_to,p_from)) lo,GREATEST(COALESCE(p_from,p_to),COALESCE(p_to,p_from)) hi),
  base AS (
    SELECT i.id,i.invoice_number,i.status::text status,i.building_id,i.room_id,i.contract_id,COALESCE(i.total_amount,0) total,
      COALESCE(i.paid_amount,0) paid,COALESCE(i.remaining_amount,COALESCE(i.total_amount,0)-COALESCE(i.paid_amount,0)) rem,
      w.mode,w.lo,w.hi,pay.sum_range,pay.has_range,pay.paid_upto,pay.all_before
    FROM public.invoices i CROSS JOIN win w
    CROSS JOIN LATERAL (SELECT COALESCE(sum(p.amount) FILTER (WHERE p.payment_date BETWEEN w.lo AND w.hi),0) sum_range,
        count(*) FILTER (WHERE p.payment_date BETWEEN w.lo AND w.hi)>0 has_range,
        COALESCE(sum(p.amount) FILTER (WHERE p.payment_date<=w.hi),0) paid_upto,
        COALESCE(bool_and(COALESCE(p.payment_date<=w.hi,false)),true) all_before
      FROM public.payments p WHERE p.invoice_id=i.id) pay
    WHERE i.organization_id=p_organization_id AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED' AND i.billing_month=p_billing_month
      AND i.building_id=ANY(v_b)),
  flags AS (
    SELECT b.*,(b.status='PAID' OR b.rem<=0) is_paid,
      (b.paid_upto>=b.total OR ((b.status='PAID' OR b.rem<=0) AND b.all_before)) paid_as_of
    FROM base b),
  scoped AS (
    SELECT f.*,CASE WHEN f.mode='today' THEN NOT f.is_paid ELSE NOT f.paid_as_of END owes FROM flags f)
  SELECT s.id,s.invoice_number,s.status,s.building_id,bd.name,bd.name_sort,s.room_id,r.name,r.name_sort,s.contract_id,cu.id,cu.full_name,
    s.total,s.paid,s.rem,
    CASE WHEN s.is_paid THEN 'paid' WHEN s.status='PARTIAL_PAID' OR s.paid>0 THEN 'partial' ELSE 'unpaid' END,
    s.mode,CASE WHEN s.mode='all' THEN NULL ELSE s.sum_range END,
    s.mode='all' OR s.has_range OR s.owes,
    CASE WHEN s.mode='all' THEN s.is_paid ELSE s.has_range END,
    CASE WHEN s.mode='all' THEN NOT s.is_paid ELSE s.owes AND NOT s.has_range END,
    CASE WHEN s.mode='all' THEN s.paid ELSE s.sum_range END,
    CASE WHEN s.mode='all' THEN s.is_paid ELSE s.has_range END,
    CASE WHEN s.mode='all' THEN NOT s.is_paid ELSE NOT s.has_range AND s.owes END,
    CASE WHEN s.mode='all' THEN CASE WHEN s.is_paid THEN 0 ELSE GREATEST(0,s.rem) END
      WHEN s.has_range OR NOT s.owes THEN 0
      WHEN s.mode='today' THEN GREATEST(0,s.rem)
      WHEN s.paid_as_of THEN 0 ELSE GREATEST(0,s.total-s.paid_upto) END,
    (SELECT array_agg(n.name ORDER BY n.first_at,n.name) FROM (
       SELECT DISTINCT ON (lower(btrim(ie.creator_name))) btrim(ie.creator_name) name,ie.created_at first_at
       FROM public.income_expenses ie
       WHERE ie.invoice_id=s.id AND ie.organization_id=p_organization_id AND ie.type='INCOME' AND ie.approval_status='APPROVED'
         AND ie.deleted_at IS NULL AND ie.payment_id IS NOT NULL AND btrim(COALESCE(ie.creator_name,''))<>''
       ORDER BY lower(btrim(ie.creator_name)),ie.created_at) n)
  FROM scoped s
  LEFT JOIN public.buildings bd ON bd.id=s.building_id
  LEFT JOIN public.rooms r ON r.id=s.room_id
  LEFT JOIN LATERAL (SELECT cc.customer_id FROM public.contract_customers cc WHERE cc.contract_id=s.contract_id
    ORDER BY cc.is_representative DESC,cc.created_at,cc.id LIMIT 1) rep ON true
  LEFT JOIN public.customers cu ON cu.id=rep.customer_id AND cu.organization_id=p_organization_id;
END $fn$;

-- Chi tiết hoá đơn (useInvoice + InvoiceDetailView.tsx): hoá đơn chưa xoá theo id; dòng hoá đơn; khoản thu (không ảnh
-- chứng từ); phiếu thu/chi APPROVED gắn hoá đơn, BỎ phiếu trỏ lần thu đã hoàn tác (activeVouchers), số tiền =
-- Σ đơn giá × số lượng; tổng thu/tổng chi trả khách như chân thẻ web; khách đại diện, không thấy thì khách đầu; điều
-- chỉnh chỉ đếm (không snapshot). NULL = không có / ngoài phạm vi RLS hoặc p_building_ids. organizationId của đầu
-- hoá đơn / khoản thu / phiếu lấy từ cột organization_id của chính bảng đó (rào công ty của cổng đợt 2).
CREATE OR REPLACE FUNCTION public.invoice_detail_v1(p_organization_id uuid,p_invoice_id uuid,p_building_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_b uuid[];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  -- Như web: khoá của trang (RequirePermission) xét theo từng toà, trên toà RLS buildings của người gọi thấy.
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('invoices','view',b.id);
  RETURN (
  WITH inv AS (SELECT i.* FROM public.invoices i WHERE i.id=p_invoice_id AND i.organization_id=p_organization_id AND i.deleted_at IS NULL
    AND i.building_id=ANY(v_b)),
  vouchers AS (
    SELECT v.id,v.organization_id,v.code,v.type,v.name,v.voucher_date,v.approval_status,v.creator_name,a.name account_name,
      (SELECT COALESCE(sum(COALESCE(x.unit_price,0)*COALESCE(x.quantity,0)),0) FROM public.income_expense_items x WHERE x.income_expense_id=v.id) amount
    FROM inv JOIN public.income_expenses v ON v.invoice_id=inv.id LEFT JOIN public.accounts a ON a.id=v.account_id
    WHERE v.organization_id=p_organization_id AND v.approval_status='APPROVED' AND v.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.payments rp WHERE rp.id=v.payment_id AND rp.invoice_id=inv.id AND rp.reversed_at IS NOT NULL))
  SELECT jsonb_build_object(
    'invoice',jsonb_build_object('id',i.id,'organizationId',i.organization_id,'invoiceNumber',i.invoice_number,'status',i.status::text,'kind',i.kind,'billingMonth',i.billing_month,
      'issueDate',i.issue_date,'dueDate',i.due_date,'paidDate',i.paid_date,'subtotal',i.subtotal,'discountAmount',i.discount_amount,
      'previousDebt',i.previous_debt,'totalAmount',i.total_amount,'paidAmount',i.paid_amount,
      'remainingAmount',COALESCE(i.remaining_amount,COALESCE(i.total_amount,0)-COALESCE(i.paid_amount,0)),'notes',i.notes,
      'buildingId',i.building_id,'buildingName',b.name,'roomId',i.room_id,'roomName',r.name,'contractId',i.contract_id,
      'contractNumber',ct.contract_number,'customerId',CASE WHEN rc.id IS NOT NULL THEN rc.id ELSE fc.id END,
      'customerName',COALESCE(rc.full_name,fc.full_name),'adjustmentReviewStatus',i.adjustment_review_status),
    'items',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',it.id,'type',it.type::text,'description',it.description,'unitPrice',it.unit_price,
        'quantity',it.quantity,'amount',it.amount,'fromDate',it.from_date,'toDate',it.to_date,'previousReading',it.previous_reading,
        'currentReading',it.current_reading) ORDER BY it.sort_order NULLS LAST,it.id),'[]'::jsonb)
      FROM public.invoice_items it WHERE it.invoice_id=i.id),
    'payments',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'organizationId',p.organization_id,'receiptNumber',p.receipt_number,'amount',p.amount,
        'method',p.payment_method::text,'paymentDate',p.payment_date,'reversed',p.reversed_at IS NOT NULL) ORDER BY p.payment_date,p.created_at,p.id),'[]'::jsonb)
      FROM public.payments p WHERE p.invoice_id=i.id),
    'vouchers',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',v.id,'organizationId',v.organization_id,'code',v.code,'type',v.type,'name',v.name,'voucherDate',v.voucher_date,
        'approvalStatus',v.approval_status,'creatorName',v.creator_name,'accountName',v.account_name,'amount',v.amount) ORDER BY v.voucher_date,v.id),'[]'::jsonb)
      FROM vouchers v),
    'totalReceived',(SELECT COALESCE(sum(v.amount) FILTER (WHERE v.type='INCOME'),0) FROM vouchers v),
    'totalRefunded',(SELECT COALESCE(sum(v.amount) FILTER (WHERE v.type='EXPENSE'),0) FROM vouchers v),
    'adjustmentCount',(SELECT count(*)::integer FROM public.invoice_adjustments ad WHERE ad.invoice_id=i.id AND ad.organization_id=i.organization_id))
  FROM inv i
  LEFT JOIN public.buildings b ON b.id=i.building_id
  LEFT JOIN public.rooms r ON r.id=i.room_id
  LEFT JOIN public.contracts ct ON ct.id=i.contract_id
  LEFT JOIN LATERAL (SELECT
      (SELECT cc.customer_id FROM public.contract_customers cc WHERE cc.contract_id=i.contract_id AND cc.is_representative ORDER BY cc.created_at,cc.id LIMIT 1) rep_id,
      (SELECT cc.customer_id FROM public.contract_customers cc WHERE cc.contract_id=i.contract_id ORDER BY cc.created_at,cc.id LIMIT 1) first_id) pick ON true
  LEFT JOIN public.customers rc ON rc.id=pick.rep_id AND rc.organization_id=p_organization_id
  LEFT JOIN public.customers fc ON fc.id=pick.first_id AND fc.organization_id=p_organization_id);
END $fn$;

-- Phiếu cọc giữ chỗ (useReservationDeposits): phiếu thu chưa xoá, chưa gắn hợp đồng, không bị loại trừ quản lý,
-- APPROVED/UNAPPROVED/CANCELLED, có ít nhất một hạng mục cọc (is_deposit); số cọc = Σ hạng mục cọc; đã quyết toán =
-- có reservation_deposit_settlements; kỳ hạn reservation_hold_deadlines (useReservationHoldDeadlines). Web sắp
-- voucher_date giảm dần, id.
CREATE OR REPLACE FUNCTION public.deposit_reservation_vouchers_v1(p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL)
RETURNS TABLE(voucher_id uuid,code text,name text,payer_name text,deposit_amount numeric,voucher_date date,approval_status text,
  building_id uuid,building_name text,room_id uuid,room_name text,settled boolean,hold_until date,topup_due_date date,deposit_target numeric)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_b uuid[];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  -- Như web: khoá của trang (RequirePermission) xét theo từng toà, trên toà RLS buildings của người gọi thấy.
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('deposits','view',b.id);
  RETURN QUERY
  SELECT ie.id,ie.code,ie.name,ie.payer_name,dep.amount,ie.voucher_date,ie.approval_status,ie.building_id,b.name,ie.room_id,r.name,
    EXISTS(SELECT 1 FROM public.reservation_deposit_settlements s WHERE s.source_voucher_id=ie.id),h.hold_until,h.topup_due_date,h.deposit_target
  FROM public.income_expenses ie
  CROSS JOIN LATERAL (SELECT COALESCE(sum(it.amount),0) amount,count(*) n FROM public.income_expense_items it
    JOIN public.income_expense_types t ON t.id=it.income_expense_type_id AND t.is_deposit=true WHERE it.income_expense_id=ie.id) dep
  LEFT JOIN public.buildings b ON b.id=ie.building_id
  LEFT JOIN public.rooms r ON r.id=ie.room_id
  LEFT JOIN public.reservation_hold_deadlines h ON h.income_expense_id=ie.id AND h.organization_id=ie.organization_id
  WHERE ie.organization_id=p_organization_id AND ie.contract_id IS NULL AND ie.deleted_at IS NULL AND ie.type='INCOME'
    AND ie.approval_status IN ('APPROVED','UNAPPROVED','CANCELLED') AND dep.n>0
    AND NOT EXISTS(SELECT 1 FROM public.deposit_management_exclusions ex WHERE ex.voucher_id=ie.id AND ex.organization_id=ie.organization_id)
    AND ie.building_id=ANY(v_b);
END $fn$;

-- Cọc đang giữ theo hợp đồng ACTIVE (useHeldDeposits): còn thiếu = deposit_remaining (không có thì cọc − đã thu);
-- FULL khi còn thiếu < ngưỡng (web 10.000đ), FIRST_INVOICE khi nợ cọc trừ hoá đơn đầu, còn lại SHORT; tên khách:
-- đại diện, không thấy thì khách đầu (repName).
CREATE OR REPLACE FUNCTION public.deposit_held_contracts_v1(p_organization_id uuid,p_threshold numeric,p_building_ids uuid[] DEFAULT NULL)
RETURNS TABLE(contract_id uuid,contract_number text,building_id uuid,building_name text,room_id uuid,room_name text,room_sort text,
  customer_id uuid,customer_name text,total_deposit numeric,deposit_paid numeric,deposit_remaining numeric,deposit_debt_mode text,
  deposit_topup_due_date date,state text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_b uuid[];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  -- Như web: khoá của trang (RequirePermission) xét theo từng toà, trên toà RLS buildings của người gọi thấy.
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('deposits','view',b.id);
  RETURN QUERY
  SELECT c.id,c.contract_number,r.building_id,b.name,r.id,r.name,r.name_sort,
    CASE WHEN COALESCE(rc.full_name,'')<>'' THEN rc.id ELSE fc.id END,COALESCE(NULLIF(rc.full_name,''),NULLIF(fc.full_name,'')),
    COALESCE(c.total_deposit,0),COALESCE(c.deposit_paid,0),x.remaining,c.deposit_debt_mode,c.deposit_topup_due_date,
    CASE WHEN x.remaining<p_threshold THEN 'FULL' WHEN c.deposit_debt_mode='FIRST_INVOICE' THEN 'FIRST_INVOICE' ELSE 'SHORT' END
  FROM public.contracts c
  CROSS JOIN LATERAL (SELECT COALESCE(c.deposit_remaining,COALESCE(c.total_deposit,0)-COALESCE(c.deposit_paid,0)) remaining) x
  LEFT JOIN public.rooms r ON r.id=c.room_id
  LEFT JOIN public.buildings b ON b.id=r.building_id
  LEFT JOIN LATERAL (SELECT
      (SELECT cc.customer_id FROM public.contract_customers cc WHERE cc.contract_id=c.id AND cc.is_representative ORDER BY cc.created_at,cc.id LIMIT 1) rep_id,
      (SELECT cc.customer_id FROM public.contract_customers cc WHERE cc.contract_id=c.id ORDER BY cc.created_at,cc.id LIMIT 1) first_id) pick ON true
  LEFT JOIN public.customers rc ON rc.id=pick.rep_id AND rc.organization_id=p_organization_id
  LEFT JOIN public.customers fc ON fc.id=pick.first_id AND fc.organization_id=p_organization_id
  WHERE c.organization_id=p_organization_id AND c.status::text='ACTIVE' AND c.deleted_at IS NULL
    AND r.building_id=ANY(v_b);
END $fn$;

-- Hoàn cọc / bỏ cọc (useDepositRefundsForfeits): hồ sơ contract_terminations; "đã hoàn" = phiếu chi termination.refund
-- APPROVED + POSTED + còn bút toán hiệu lực, gộp theo hợp đồng; FORFEIT = bỏ cọc; refund_drift = net quyết toán − đã
-- hoàn khi net > 0. Web sắp termination_date giảm dần, id.
CREATE OR REPLACE FUNCTION public.deposit_refunds_forfeits_v1(p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL)
RETURNS TABLE(termination_id uuid,contract_id uuid,contract_number text,building_id uuid,building_name text,room_id uuid,room_name text,
  customer_id uuid,customer_name text,termination_date date,termination_type text,kind text,total_deposit numeric,total_deductions numeric,
  settlement_net numeric,status text,posted_refund numeric,posted_refund_count integer,posted_refund_codes text[],refund_done boolean,
  refund_drift numeric)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_b uuid[];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  -- Như web: khoá của trang (RequirePermission) xét theo từng toà, trên toà RLS buildings của người gọi thấy.
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('deposits','view',b.id);
  RETURN QUERY
  SELECT t.id,t.contract_id,c.contract_number,r.building_id,b.name,r.id,r.name,
    CASE WHEN COALESCE(rc.full_name,'')<>'' THEN rc.id ELSE fc.id END,COALESCE(NULLIF(rc.full_name,''),NULLIF(fc.full_name,'')),
    t.termination_date,t.termination_type,CASE WHEN t.termination_type='FORFEIT' THEN 'FORFEIT' ELSE 'REFUND' END,
    COALESCE(t.total_deposit,0),COALESCE(t.total_deductions,0),COALESCE(t.refund_amount,0),t.status,v.total,v.n,v.codes,v.n>0,
    CASE WHEN COALESCE(t.refund_amount,0)>0 THEN COALESCE(t.refund_amount,0)-v.total ELSE 0 END
  FROM public.contract_terminations t
  LEFT JOIN public.contracts c ON c.id=t.contract_id
  LEFT JOIN public.rooms r ON r.id=c.room_id
  LEFT JOIN public.buildings b ON b.id=r.building_id
  CROSS JOIN LATERAL (SELECT COALESCE(sum(ie.total_amount),0) total,count(*)::integer n,
      COALESCE(array_agg(ie.code ORDER BY ie.id) FILTER (WHERE ie.code IS NOT NULL),'{}'::text[]) codes
    FROM public.income_expenses ie
    WHERE ie.contract_id=t.contract_id AND ie.organization_id=p_organization_id AND ie.type='EXPENSE' AND ie.system_source='termination.refund'
      AND ie.approval_status='APPROVED' AND ie.posting_status='POSTED' AND ie.active_posting_id_v2 IS NOT NULL AND ie.deleted_at IS NULL) v
  LEFT JOIN LATERAL (SELECT
      (SELECT cc.customer_id FROM public.contract_customers cc WHERE cc.contract_id=t.contract_id AND cc.is_representative ORDER BY cc.created_at,cc.id LIMIT 1) rep_id,
      (SELECT cc.customer_id FROM public.contract_customers cc WHERE cc.contract_id=t.contract_id ORDER BY cc.created_at,cc.id LIMIT 1) first_id) pick ON true
  LEFT JOIN public.customers rc ON rc.id=pick.rep_id AND rc.organization_id=p_organization_id
  LEFT JOIN public.customers fc ON fc.id=pick.first_id AND fc.organization_id=p_organization_id
  WHERE t.organization_id=p_organization_id AND r.building_id=ANY(v_b);
END $fn$;

-- Sổ tiền thối / làm tròn (RefundLogPage.tsx useRefundLog): sổ (đọc dưới RLS accounts) tên "Làm tròn tiền thiếu" ⇒
-- theo rounding_account_id + rounding_amount, sổ khác ⇒ change_account_id + change_amount; phiếu APPROVED chưa xoá
-- trong [p_from,p_to]. Web sắp voucher_date giảm dần. Sổ không nhìn thấy ⇒ không hàng nào.
CREATE OR REPLACE FUNCTION public.cashbook_change_ledger_v1(p_organization_id uuid,p_account_id uuid,p_from date,p_to date,
  p_building_ids uuid[] DEFAULT NULL)
RETURNS TABLE(voucher_id uuid,voucher_date date,code text,invoice_id uuid,invoice_number text,building_id uuid,building_name text,
  room_id uuid,room_name text,payer_name text,amount numeric,total_amount numeric,notes text,ledger_mode text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_b uuid[];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  -- Như web: khoá của trang (RequirePermission) xét theo từng toà, trên toà RLS buildings của người gọi thấy.
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('deposits','view',b.id);
  RETURN QUERY
  WITH acc AS (SELECT a.id,CASE WHEN btrim(COALESCE(a.name,''))='Làm tròn tiền thiếu' THEN 'rounding' ELSE 'refund' END mode
    FROM public.accounts a WHERE a.id=p_account_id AND a.organization_id=p_organization_id)
  SELECT ie.id,ie.voucher_date,ie.code,ie.invoice_id,inv.invoice_number,ie.building_id,b.name,ie.room_id,r.name,ie.payer_name,
    COALESCE(CASE WHEN acc.mode='rounding' THEN ie.rounding_amount ELSE ie.change_amount END,0),ie.total_amount,ie.notes,acc.mode
  FROM acc JOIN public.income_expenses ie
    ON (acc.mode='rounding' AND ie.rounding_account_id=acc.id) OR (acc.mode='refund' AND ie.change_account_id=acc.id)
  LEFT JOIN public.invoices inv ON inv.id=ie.invoice_id
  LEFT JOIN public.buildings b ON b.id=ie.building_id
  LEFT JOIN public.rooms r ON r.id=ie.room_id
  WHERE ie.organization_id=p_organization_id AND ie.approval_status='APPROVED' AND ie.deleted_at IS NULL
    AND ie.voucher_date BETWEEN p_from AND p_to
    AND ie.building_id=ANY(v_b);
END $fn$;

-- ── Bảng báo cáo Gói A (khớp W2A_REPORTS trong infra/hermes-broker/wave2-a-contract.mjs) ────────────────
CREATE OR REPLACE FUNCTION app_private.hermes_w2a_catalog_v1()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT '{
  "payment_schedule":{"permission":"reports_finance.payment_schedule","source":"crm.finance_payment_schedule_v1","scope":"rows",
    "params":["buildingId","fromDate","toDate"],"required":[],"statuses":null,"kinds":null,"scopeKeys":["customers.view"]},
  "overpayment":{"permission":"reports_finance.overpayment","source":"crm.finance_overpayment_invoices_v1","scope":"rows",
    "params":["buildingId"],"required":[],"statuses":null,"kinds":null,"scopeKeys":["customers.view"]},
  "collection":{"permission":"thu_tien.view","source":"crm.thu_tien_collection_v1","scope":"rows",
    "params":["month","buildingId","status","fromDate","toDate"],"required":["month"],"statuses":["paid","unpaid"],"kinds":null,
    "scopeKeys":["customers.view"]},
  "invoice_detail":{"permission":"invoices.view","source":"crm.invoice_detail_v1","scope":"rows",
    "params":["invoiceId"],"required":["invoiceId"],"statuses":null,"kinds":null,"scopeKeys":["customers.view"]},
  "reservation_vouchers":{"permission":"deposits.view","source":"crm.deposit_reservation_vouchers_v1","scope":"rows",
    "params":["buildingId","status","query"],"required":[],"statuses":["APPROVED","UNAPPROVED","CANCELLED"],"kinds":null,
    "scopeKeys":["customers.view"]},
  "reservation_settlements":{"permission":"deposits.view","source":"crm.get_reservation_settlements_v1","scope":"rows",
    "params":["buildingId","status"],"required":[],"statuses":["PENDING","PAID","NOT_REQUIRED"],"kinds":null,"scopeKeys":["customers.view"]},
  "held_deposits":{"permission":"deposits.view","source":"crm.deposit_held_contracts_v1","scope":"rows",
    "params":["buildingId","status"],"required":[],"statuses":["FULL","SHORT","FIRST_INVOICE"],"kinds":null,"scopeKeys":["customers.view"]},
  "deposit_refunds":{"permission":"deposits.view","source":"crm.deposit_refunds_forfeits_v1","scope":"rows",
    "params":["buildingId","kind"],"required":[],"statuses":null,"kinds":["REFUND","FORFEIT"],"scopeKeys":["customers.view"]},
  "change_ledger":{"permission":"deposits.view","source":"crm.cashbook_change_ledger_v1","scope":"rows",
    "params":["cashbookId","fromDate","toDate"],"required":["cashbookId"],"statuses":null,"kinds":null,"scopeKeys":["customers.view"]}
 }'::jsonb
$fn$;

-- ── Hàm đọc Gói A: INVOKER, chạy trong phiên của chính người hỏi (cổng đợt 2 dựng ctx sau khi kiểm phạm vi).
-- ctx.buildings = grant CRM của khoá ∩ overlay (đã thu hẹp theo buildingId nếu có); mọi bảng/RPC đọc dưới RLS
-- của người hỏi nên ctx giả cũng không vượt được web. Mỗi báo cáo trả ≤2000 hàng đã sắp + sourceCapped; tên
-- khách chỉ khi RLS customers cho thấy VÀ toà của hàng ∈ ctx.scopes['customers.view']. Rào công ty (000700): mọi hàng
-- mang organizationId tra từ CỘT organization_id của bảng nguồn theo khoá hàng, trong cùng câu lệnh với hàm dùng chung
-- (không chép ctx.organizationId; hàm dùng chung giữ nguyên chữ ký) — hàm dùng chung lỡ bỏ lọc công ty thì bước kết
-- thúc thấy công ty khác ⇒ 42501; dòng hoá đơn (invoice_items.organization_id có thể NULL) mang công ty của hoá đơn. ──
CREATE OR REPLACE FUNCTION app_private.hermes_w2a_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_org uuid; v_b uuid[]; v_cust uuid[]; v_today date; v_rows jsonb:='[]'::jsonb; v_total integer:=0; v_summary jsonb;
  v_status text; v_kind text; v_query text; v_from date; v_to date; v_target uuid; v_detail jsonb; v_page jsonb; v_cursor jsonb;
  v_head jsonb; v_raw jsonb; v_clean jsonb;
  -- Độ dài tối đa của từng trường chữ trong kết quả (khớp longText(n) của wave2-a-contract.mjs).
  v_limits constant jsonb:='{"buildingName":200,"roomName":100,"customerName":200,"payerName":200,"invoiceNumber":100,"contractNumber":100,
    "code":100,"voucherCode":100,"label":300,"name":300,"category":40,"status":40,"person":200,"collectors":300,"notes":1000,"kind":40,
    "billingMonth":20,"reasonCode":40,"debtMode":40,"terminationType":40,"adjustmentReviewStatus":40,"invoiceStatus":40,"approvalStatus":40}';
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_ctx->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  v_org:=(p_ctx->>'organizationId')::uuid;
  -- Web đọc các bảng này dưới RLS theo buildings.view (invoices/rooms/income_expenses_select_rbac:
  -- has_full_building_scope() OR building_id IN accessible_building_ids()), độc lập với khoá của trang. Khoá
  -- trang có thể rộng hơn (vd. thu_tien.view toàn công ty, buildings.view vài toà) ⇒ giao thêm để không vượt web.
  SELECT COALESCE(array_agg(x::uuid ORDER BY x),'{}'::uuid[]) INTO v_b FROM jsonb_array_elements_text(p_ctx->'buildings') x
    WHERE public.has_full_building_scope() OR x::uuid IN (SELECT public.accessible_building_ids());
  IF v_org IS NULL OR cardinality(v_b)=0 THEN
    RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','no_building_scope');
  END IF;
  -- Toà mà người hỏi được xem tên khách: customers.view của kết nối ∩ toà của báo cáo.
  SELECT COALESCE(array_agg(x::uuid),'{}'::uuid[]) INTO v_cust
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_ctx->'scopes'->'customers.view')='array' THEN p_ctx->'scopes'->'customers.view' ELSE '[]'::jsonb END) x
    WHERE x::uuid=ANY(v_b);
  v_today:=(p_ctx->>'today')::date;
  v_status:=p_params->>'status'; v_kind:=p_params->>'kind'; v_query:=lower(NULLIF(btrim(p_params->>'query'),''));
  v_from:=(p_params->>'fromDate')::date; v_to:=(p_params->>'toDate')::date;

  IF p_report='payment_schedule' THEN
    -- Web: due_date ≤ hôm nay + 365 (usePaymentScheduleReport(365)); ngày lọc trên "đã lên hoá đơn đến".
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.o),'[]'::jsonb),COALESCE(max(x.total),0) INTO v_rows,v_total FROM (
      SELECT row_number() OVER w o,count(*) OVER () total,jsonb_build_object('buildingId',s.building_id,
          'organizationId',(SELECT src.organization_id FROM public.invoices src WHERE src.id=s.invoice_id),
          'buildingName',s.building_name,'roomId',s.room_id,'roomName',s.room_name,
          'customerName',CASE WHEN s.building_id=ANY(v_cust) THEN s.customer_name END,
          'billedThrough',s.billed_through) item
      FROM public.finance_payment_schedule_v1(v_org,v_today+365,v_b) s
      WHERE (v_from IS NULL OR s.billed_through>=v_from) AND (v_to IS NULL OR s.billed_through<=v_to)
      WINDOW w AS (ORDER BY s.billed_through DESC,s.first_due_date,s.invoice_id)
      ORDER BY s.billed_through DESC,s.first_due_date,s.invoice_id LIMIT 2001) x;
    v_summary:=jsonb_build_object('rooms',v_total);

  ELSIF p_report='overpayment' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.o),'[]'::jsonb),COALESCE(max(x.total),0) INTO v_rows,v_total FROM (
      SELECT row_number() OVER (ORDER BY s.invoice_id) o,count(*) OVER () total,jsonb_build_object('invoiceId',s.invoice_id,
          'organizationId',(SELECT src.organization_id FROM public.invoices src WHERE src.id=s.invoice_id),
          'invoiceNumber',s.invoice_number,'buildingId',s.building_id,
          'buildingName',s.building_name,'roomId',s.room_id,'roomName',s.room_name,
          'customerName',CASE WHEN s.building_id=ANY(v_cust) THEN s.customer_name END,
          'totalAmount',COALESCE(s.total_amount,0)::text,'paidAmount',COALESCE(s.paid_amount,0)::text,'overpaidAmount',COALESCE(s.overpaid_amount,0)::text) item
      FROM public.finance_overpayment_invoices_v1(v_org,v_b) s ORDER BY s.invoice_id LIMIT 2001) x;
    -- Tổng như web (useOverpaymentSummary): RPC INVOKER, gọi với đúng danh sách toà đã giao.
    v_raw:=public.get_overpayment_summary(v_b);
    v_summary:=jsonb_build_object('total',(v_raw->>'total')::numeric::text,'count',(v_raw->>'count')::integer);

  ELSIF p_report='collection' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.o) FILTER (WHERE x.listed),'[]'::jsonb),COALESCE(count(*) FILTER (WHERE x.listed),0)::integer,
        jsonb_build_object('mode',COALESCE(max(x.mode),CASE WHEN v_from IS NULL AND v_to IS NULL THEN 'all'
            WHEN COALESCE(v_from,v_to)=v_today AND COALESCE(v_to,v_from)=v_today THEN 'today' ELSE 'date' END),
          'invoiceCount',count(*)::integer,'collectedSum',COALESCE(sum(x.collected),0)::text,'remainingSum',COALESCE(sum(x.remaining),0)::text,
          'paidRooms',count(*) FILTER (WHERE x.paid)::integer,'dueRooms',count(*) FILTER (WHERE x.due)::integer)
      INTO v_rows,v_total,v_summary FROM (
      SELECT row_number() OVER (ORDER BY t.building_sort,t.building_id,t.room_sort,t.invoice_id) o,t.time_mode mode,t.summary_collected collected,
        t.summary_remaining remaining,t.summary_paid paid,t.summary_due due,
        t.in_scope AND (v_status IS NULL OR v_status='paid' AND t.status_paid OR v_status='unpaid' AND t.status_unpaid) listed,
        jsonb_build_object('invoiceId',t.invoice_id,'organizationId',(SELECT src.organization_id FROM public.invoices src WHERE src.id=t.invoice_id),
          'invoiceNumber',t.invoice_number,
          'buildingId',t.building_id,'buildingName',t.building_name,'roomId',t.room_id,
          'roomName',t.room_name,
          'customerName',CASE WHEN t.building_id=ANY(v_cust) THEN t.customer_name END,
          'invoiceStatus',t.invoice_status,'collectStatus',t.collect_status,'totalAmount',t.total_amount::text,'paidAmount',t.paid_amount::text,
          'remainingAmount',t.remaining_amount::text,'collectedInRange',t.collected_in_range::text,
          'collectors',array_to_string(t.collectors,', ')) item
      FROM public.thu_tien_collection_v1(v_org,p_params->>'month',v_from,v_to,v_today,v_b) t) x;
    IF v_total>2000 THEN v_rows:=(SELECT jsonb_agg(e ORDER BY n) FROM jsonb_array_elements(v_rows) WITH ORDINALITY a(e,n) WHERE n<=2001); END IF;

  ELSIF p_report='invoice_detail' THEN
    v_target:=(p_params->>'invoiceId')::uuid;
    v_detail:=public.invoice_detail_v1(v_org,v_target,v_b);
    v_head:=v_detail->'invoice';
    IF v_detail IS NULL OR NOT((v_head->>'buildingId')::uuid=ANY(v_b)) THEN
      v_summary:=jsonb_build_object('found',false,'invoiceId',NULL,'invoiceNumber',NULL,'status',NULL,'kind',NULL,'billingMonth',NULL,'issueDate',NULL,
        'dueDate',NULL,'paidDate',NULL,'buildingId',NULL,'buildingName',NULL,'roomId',NULL,'roomName',NULL,'contractNumber',NULL,'customerName',NULL,
        'subtotal',NULL,'discountAmount',NULL,'previousDebt',NULL,'totalAmount',NULL,'paidAmount',NULL,'remainingAmount',NULL,'notes',NULL,
        'adjustmentCount',NULL,'adjustmentReviewStatus',NULL,'totalReceived',NULL,'totalRefunded',NULL);
    ELSE
      v_summary:=jsonb_build_object('found',true,'invoiceId',v_head->'id','invoiceNumber',to_jsonb(v_head->>'invoiceNumber'),
        'status',v_head->'status','kind',to_jsonb(v_head->>'kind'),
        'billingMonth',to_jsonb(v_head->>'billingMonth'),'issueDate',v_head->'issueDate','dueDate',v_head->'dueDate',
        'paidDate',v_head->'paidDate','buildingId',v_head->'buildingId','buildingName',to_jsonb(v_head->>'buildingName'),
        'roomId',v_head->'roomId','roomName',to_jsonb(v_head->>'roomName'),
        'contractNumber',to_jsonb(v_head->>'contractNumber'),
        'customerName',CASE WHEN (v_head->>'buildingId')::uuid=ANY(v_cust) THEN to_jsonb(v_head->>'customerName') ELSE 'null'::jsonb END,
        'subtotal',to_jsonb((v_head->>'subtotal')::numeric::text),'discountAmount',to_jsonb((v_head->>'discountAmount')::numeric::text),
        'previousDebt',to_jsonb((v_head->>'previousDebt')::numeric::text),'totalAmount',to_jsonb(COALESCE((v_head->>'totalAmount')::numeric,0)::text),
        'paidAmount',to_jsonb(COALESCE((v_head->>'paidAmount')::numeric,0)::text),'remainingAmount',to_jsonb(COALESCE((v_head->>'remainingAmount')::numeric,0)::text),
        'notes',to_jsonb(v_head->>'notes'),'adjustmentCount',v_detail->'adjustmentCount',
        'totalReceived',to_jsonb((v_detail->>'totalReceived')::numeric::text),'totalRefunded',to_jsonb((v_detail->>'totalRefunded')::numeric::text),
        'adjustmentReviewStatus',to_jsonb(v_head->>'adjustmentReviewStatus'));
      -- Dòng chi tiết: dòng hoá đơn, khoản thu, phiếu thu/chi đã duyệt (cùng khuôn; trường không dùng = null).
      SELECT COALESCE(jsonb_agg(l.item ORDER BY l.k,l.n),'[]'::jsonb),count(*)::integer INTO v_rows,v_total FROM (
        SELECT 1 k,n,jsonb_build_object('kind','item','id',e->'id','organizationId',v_head->'organizationId','buildingId',v_head->'buildingId','code',NULL,'label',to_jsonb(e->>'description'),
            'category',e->'type','amount',to_jsonb(COALESCE((e->>'amount')::numeric,0)::text),'unitPrice',to_jsonb((e->>'unitPrice')::numeric::text),
            'quantity',to_jsonb((e->>'quantity')::numeric::text),'date',e->'fromDate','endDate',e->'toDate','status',NULL,'person',NULL,
            'previousReading',to_jsonb((e->>'previousReading')::numeric::text),'currentReading',to_jsonb((e->>'currentReading')::numeric::text)) item
          FROM jsonb_array_elements(v_detail->'items') WITH ORDINALITY a(e,n)
        UNION ALL
        SELECT 2,n,jsonb_build_object('kind','payment','id',e->'id','organizationId',e->'organizationId','buildingId',v_head->'buildingId','code',to_jsonb(e->>'receiptNumber'),'label',NULL,
            'category',e->'method','amount',to_jsonb(COALESCE((e->>'amount')::numeric,0)::text),'unitPrice',NULL,'quantity',NULL,'date',e->'paymentDate',
            'endDate',NULL,'status',to_jsonb(CASE WHEN (e->>'reversed')::boolean THEN 'REVERSED' ELSE 'ACTIVE' END),'person',NULL,
            'previousReading',NULL,'currentReading',NULL)
          FROM jsonb_array_elements(v_detail->'payments') WITH ORDINALITY a(e,n)
        UNION ALL
        SELECT 3,n,jsonb_build_object('kind','voucher','id',e->'id','organizationId',e->'organizationId','buildingId',v_head->'buildingId','code',to_jsonb(e->>'code'),
            'label',to_jsonb(e->>'name'),'category',to_jsonb(e->>'type'),
            'amount',to_jsonb(COALESCE((e->>'amount')::numeric,0)::text),'unitPrice',NULL,'quantity',NULL,'date',e->'voucherDate','endDate',NULL,
            'status',to_jsonb(e->>'approvalStatus'),'person',to_jsonb(e->>'creatorName'),
            'previousReading',NULL,'currentReading',NULL)
          FROM jsonb_array_elements(v_detail->'vouchers') WITH ORDINALITY a(e,n)) l;
    END IF;

  ELSIF p_report='reservation_vouchers' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.o),'[]'::jsonb),COALESCE(max(x.total),0) INTO v_rows,v_total FROM (
      SELECT row_number() OVER (ORDER BY v.voucher_date DESC,v.voucher_id) o,count(*) OVER () total,jsonb_build_object('voucherId',v.voucher_id,
          'organizationId',(SELECT src.organization_id FROM public.income_expenses src WHERE src.id=v.voucher_id),
          'code',v.code,'name',v.name,
          'payerName',CASE WHEN v.building_id=ANY(v_cust) THEN v.payer_name END,
          'depositAmount',v.deposit_amount::text,'voucherDate',v.voucher_date,'approvalStatus',v.approval_status,'buildingId',v.building_id,
          'buildingName',v.building_name,'roomId',v.room_id,'roomName',v.room_name,
          'settled',v.settled,'holdUntil',v.hold_until,'topupDueDate',v.topup_due_date,'depositTarget',v.deposit_target::text) item
      FROM public.deposit_reservation_vouchers_v1(v_org,v_b) v
      WHERE (v_status IS NULL OR v.approval_status=v_status)
        -- Như ô tìm của web (DepositsPage.tsx:450-463): mã, tên phiếu, người nộp, tên phòng; người nộp chỉ khi được xem tên khách.
        AND (v_query IS NULL OR position(v_query IN lower(COALESCE(v.code,'')))>0 OR position(v_query IN lower(COALESCE(v.name,'')))>0
          OR position(v_query IN lower(COALESCE(v.room_name,'')))>0
          OR v.building_id=ANY(v_cust) AND position(v_query IN lower(COALESCE(v.payer_name,'')))>0)
      ORDER BY v.voucher_date DESC,v.voucher_id LIMIT 2001) x;
    v_raw:=public.get_reservation_deposit_summary(v_b);
    v_summary:=jsonb_build_object('holdingAmount',(v_raw->>'holding_amount')::numeric::text,'approvedCount',(v_raw->>'approved_count')::integer,
      'unapprovedCount',(v_raw->>'unapproved_count')::integer,'cancelledCount',(v_raw->>'cancelled_count')::integer);

  ELSIF p_report='reservation_settlements' THEN
    -- RPC web (DEFINER, tự kiểm thành viên + can_access_building) theo trang 200 qua con trỏ, tối đa 2001 hàng.
    LOOP
      v_page:=public.get_reservation_settlements_v1(v_b,v_status,v_cursor,200,NULL);
      v_rows:=v_rows||COALESCE(v_page->'rows','[]'::jsonb);
      v_cursor:=v_page->'nextCursor';
      EXIT WHEN v_cursor IS NULL OR v_cursor='null'::jsonb OR jsonb_array_length(v_rows)>2000;
    END LOOP;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('settlementId',e->'id',
        'organizationId',(SELECT src.organization_id FROM public.reservation_deposit_settlements src WHERE src.id=(e->>'id')::uuid),
        'voucherCode',to_jsonb(e->>'voucherCode'),
        'buildingId',e->'buildingId','buildingName',to_jsonb(e->>'buildingName'),'roomId',e->'roomId',
        'roomName',to_jsonb(e->>'roomName'),
        'payerName',CASE WHEN (e->>'buildingId')::uuid=ANY(v_cust) THEN to_jsonb(e->>'payerName') ELSE 'null'::jsonb END,
        'depositAmount',to_jsonb((e->>'depositAmount')::numeric::text),'retainedAmount',to_jsonb((e->>'retainedAmount')::numeric::text),
        'refundAmount',to_jsonb((e->>'refundAmount')::numeric::text),'refundedAmount',to_jsonb((e->>'refundedAmount')::numeric::text),
        'refundRemaining',to_jsonb((e->>'refundRemaining')::numeric::text),'refundState',e->'refundState','settlementDate',e->'settlementDate',
        'reasonCode',to_jsonb(e->>'reasonCode'),'roomReleased',e->'roomReleased') ORDER BY n),'[]'::jsonb),
      count(*)::integer INTO v_rows,v_total
      FROM jsonb_array_elements(v_rows) WITH ORDINALITY a(e,n) WHERE n<=2001;
    v_raw:=public.get_reservation_settlement_summary_v1(v_b);
    v_summary:=jsonb_build_object('retainedAmount',(v_raw->>'retainedAmount')::numeric::text,'retainedCount',(v_raw->>'retainedCount')::integer,
      'refundPendingAmount',(v_raw->>'refundPendingAmount')::numeric::text,'refundPendingCount',(v_raw->>'refundPendingCount')::integer,
      'refundPaidAmount',(v_raw->>'refundPaidAmount')::numeric::text,'refundPaidCount',(v_raw->>'refundPaidCount')::integer);

  ELSIF p_report='held_deposits' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.o),'[]'::jsonb),COALESCE(max(x.total),0) INTO v_rows,v_total FROM (
      SELECT row_number() OVER (ORDER BY h.building_name,h.building_id,h.room_sort,h.contract_id) o,count(*) OVER () total,
        jsonb_build_object('contractId',h.contract_id,'organizationId',(SELECT src.organization_id FROM public.contracts src WHERE src.id=h.contract_id),
          'contractNumber',h.contract_number,'buildingId',h.building_id,
          'buildingName',h.building_name,'roomId',h.room_id,'roomName',h.room_name,
          'customerName',CASE WHEN h.building_id=ANY(v_cust) THEN h.customer_name END,
          'totalDeposit',h.total_deposit::text,'depositPaid',h.deposit_paid::text,'depositRemaining',h.deposit_remaining::text,
          'debtMode',h.deposit_debt_mode,'topupDueDate',h.deposit_topup_due_date,'state',h.state) item
      FROM public.deposit_held_contracts_v1(v_org,10000,v_b) h WHERE v_status IS NULL OR h.state=v_status
      ORDER BY h.building_name,h.building_id,h.room_sort,h.contract_id LIMIT 2001) x;
    -- KPI như web (useHeldDepositSummary + DepositsPage.tsx:438-452): cộng các toà; "thiếu" = shortfall_short.
    SELECT jsonb_build_object('contractCount',COALESCE(sum(s.contract_count),0)::integer,'expected',COALESCE(sum(s.expected),0)::text,
        'held',COALESCE(sum(s.held),0)::text,'shortfall',COALESCE(sum(s.shortfall_short),0)::text,'shortfallAll',COALESCE(sum(s.shortfall_all),0)::text,
        'fullCount',COALESCE(sum(s.full_count),0)::integer,'shortCount',COALESCE(sum(s.short_count),0)::integer,
        'firstInvoiceCount',COALESCE(sum(s.first_invoice_count),0)::integer)
      INTO v_summary FROM public.get_held_deposit_summary(v_b,10000) s;

  ELSIF p_report='deposit_refunds' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.o),'[]'::jsonb),COALESCE(max(x.total),0) INTO v_rows,v_total FROM (
      SELECT row_number() OVER (ORDER BY d.termination_date DESC NULLS LAST,d.termination_id) o,count(*) OVER () total,
        jsonb_build_object('terminationId',d.termination_id,
          'organizationId',(SELECT src.organization_id FROM public.contract_terminations src WHERE src.id=d.termination_id),
          'contractId',d.contract_id,'contractNumber',d.contract_number,
          'buildingId',d.building_id,'buildingName',d.building_name,'roomId',d.room_id,
          'roomName',d.room_name,
          'customerName',CASE WHEN d.building_id=ANY(v_cust) THEN d.customer_name END,
          'terminationDate',d.termination_date,'terminationType',d.termination_type,'kind',d.kind,
          'totalDeposit',d.total_deposit::text,'totalDeductions',d.total_deductions::text,'settlementNet',d.settlement_net::text,
          'status',d.status,'postedRefund',d.posted_refund::text,'postedRefundCount',d.posted_refund_count,
          'refundDone',d.refund_done,'refundDrift',d.refund_drift::text) item
      FROM public.deposit_refunds_forfeits_v1(v_org,v_b) d WHERE v_kind IS NULL OR d.kind=v_kind
      ORDER BY d.termination_date DESC NULLS LAST,d.termination_id LIMIT 2001) x;
    v_raw:=public.get_refund_forfeit_summary(v_b);
    v_summary:=jsonb_build_object('refundTotal',(v_raw->>'refund_total')::numeric::text,'refundCount',(v_raw->>'refund_count')::integer,
      'refundLinkedTotal',(v_raw->>'refund_linked_total')::numeric::text,'refundOrphanTotal',(v_raw->>'refund_posted_orphan_total')::numeric::text,
      'refundPendingTotal',(v_raw->>'refund_pending_total')::numeric::text,'forfeitTotal',(v_raw->>'forfeit_total')::numeric::text,
      'forfeitCount',(v_raw->>'forfeit_count')::integer,'customerDebtTotal',(v_raw->>'customer_debt_total')::numeric::text);

  ELSIF p_report='change_ledger' THEN
    v_target:=(p_params->>'cashbookId')::uuid;
    -- Như web (RefundLogPage.tsx: đọc accounts theo id dưới RLS, không thấy ⇒ báo lỗi): sổ phải nhìn thấy, đúng công ty.
    IF NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=v_target AND a.organization_id=v_org AND a.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501';
    END IF;
    -- Mặc định "Tháng này" như web (RefundLogPage.tsx:142-157).
    v_from:=COALESCE(v_from,date_trunc('month',v_today)::date);
    v_to:=COALESCE(v_to,(date_trunc('month',v_today)+interval '1 month -1 day')::date);
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.o) FILTER (WHERE x.o<=2001),'[]'::jsonb),count(*)::integer,
        jsonb_build_object('mode',COALESCE(max(x.mode),(SELECT CASE WHEN btrim(COALESCE(a.name,''))='Làm tròn tiền thiếu' THEN 'rounding' ELSE 'refund' END
            FROM public.accounts a WHERE a.id=v_target)),'fromDate',v_from,'toDate',v_to,'total',COALESCE(sum(x.amount),0)::text,'count',count(*)::integer)
      INTO v_rows,v_total,v_summary FROM (
      SELECT row_number() OVER (ORDER BY l.voucher_date DESC,l.voucher_id) o,l.amount,l.ledger_mode mode,jsonb_build_object('voucherId',l.voucher_id,
          'organizationId',(SELECT src.organization_id FROM public.income_expenses src WHERE src.id=l.voucher_id),
          'voucherDate',l.voucher_date,'code',l.code,'invoiceId',l.invoice_id,
          'invoiceNumber',l.invoice_number,'buildingId',l.building_id,
          'buildingName',l.building_name,'roomName',l.room_name,
          'payerName',CASE WHEN l.building_id=ANY(v_cust) THEN l.payer_name END,
          'amount',l.amount::text,'totalAmount',COALESCE(l.total_amount,0)::text,
          'notes',CASE WHEN l.building_id=ANY(v_cust) THEN l.notes END) item
      FROM public.cashbook_change_ledger_v1(v_org,v_target,v_from,v_to,v_b) l) x;

  ELSE
    RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
  END IF;

  IF jsonb_array_length(v_rows)>2000 THEN v_rows:=v_rows-2000; END IF;
  -- Làm sạch chữ MỘT lần cho mọi hàng + summary (cùng luật hermes_full_text_v1 của đợt 1: giữ xuống dòng,
  -- bỏ ký tự điều khiển, cắt theo ký tự); hàm đọc INVOKER không gọi được app_private.* (không USAGE).
  SELECT COALESCE(jsonb_agg(c.obj ORDER BY a.n),'[]'::jsonb) INTO v_clean
    FROM jsonb_array_elements(v_rows||jsonb_build_array(COALESCE(v_summary,'{"_":null}'::jsonb))) WITH ORDINALITY a(r,n)
    CROSS JOIN LATERAL (SELECT jsonb_object_agg(e.key,CASE WHEN jsonb_typeof(e.value)='string' AND v_limits ? e.key THEN to_jsonb(left(btrim(regexp_replace(
        translate(replace(e.value#>>'{}',chr(13)||chr(10),chr(10)),chr(13)||chr(8232)||chr(8233),chr(10)||chr(10)||chr(10)),
        '[\x01-\x09\x0b-\x1f\x7f-\x9f]','','g'),' '||chr(10)),(v_limits->>e.key)::integer)) ELSE e.value END) obj
      FROM jsonb_each(a.r) e) c;
  v_summary:=CASE WHEN v_summary IS NULL THEN NULL ELSE v_clean->-1 END;
  v_rows:=v_clean - -1;
  RETURN jsonb_build_object('rows',v_rows,'summary',v_summary,'sourceCapped',v_total>2000,'unavailable',NULL);
END $fn$;

ALTER FUNCTION public.finance_payment_schedule_v1(uuid,date,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.finance_overpayment_invoices_v1(uuid,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.thu_tien_collection_v1(uuid,text,date,date,date,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.invoice_detail_v1(uuid,uuid,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.deposit_reservation_vouchers_v1(uuid,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.deposit_held_contracts_v1(uuid,numeric,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.deposit_refunds_forfeits_v1(uuid,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.cashbook_change_ledger_v1(uuid,uuid,date,date,uuid[]) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2a_catalog_v1() OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2a_read_v1(text,jsonb,jsonb) OWNER TO postgres;
-- Hàm dùng chung: INVOKER (RLS của người gọi); anon/PUBLIC/service_role không gọi được, authenticated giữ quyền mặc
-- định của schema public (thân hàm còn tự từ chối mọi vai khác authenticated). Hàm đọc của gói: ACL do nền 000600.
REVOKE ALL ON FUNCTION public.finance_payment_schedule_v1(uuid,date,uuid[]),public.finance_overpayment_invoices_v1(uuid,uuid[]),
  public.thu_tien_collection_v1(uuid,text,date,date,date,uuid[]),public.invoice_detail_v1(uuid,uuid,uuid[]),
  public.deposit_reservation_vouchers_v1(uuid,uuid[]),public.deposit_held_contracts_v1(uuid,numeric,uuid[]),
  public.deposit_refunds_forfeits_v1(uuid,uuid[]),public.cashbook_change_ledger_v1(uuid,uuid,date,date,uuid[]) FROM PUBLIC,anon,service_role;
-- Bảng báo cáo: chỉ cổng đọc.
REVOKE ALL ON FUNCTION app_private.hermes_w2a_catalog_v1() FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
COMMIT;
NOTIFY pgrst,'reload schema';
