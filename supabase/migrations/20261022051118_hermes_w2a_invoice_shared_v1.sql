-- Đợt 3 trang HOÁ ĐƠN — sáu hàm đọc dùng chung MỚI của miền hoá đơn / thu tiền (22/10/2026; docs/plans/hermes-crm/HOA-DON-THAO-TAC-GHI.md
-- mục 7). INVOKER + RLS của người gọi, search_path rỗng, chỉ vai authenticated, tự kiểm khoá web của trang theo toà như
-- invoice_detail_v1 / thu_tien_collection_v1 (web gọi thẳng cũng đúng quyền); p_building_ids chỉ thu hẹp. File riêng, không chứa
-- hàm của trợ lý; báo cáo đọc ở file kế tiếp dùng lại. Không DROP, không ghi dữ liệu.
--   Nợ   = nợ THỰC public.invoice_effective_outstanding_v1 (20261021183549): mỗi đồng nợ tính một lần ở hoá đơn phát sinh gốc, không
--          đếm hai lần nợ cũ đã kéo sang hoá đơn sau.
--   Quá hạn = public.is_overdue(invoices) (hạn < hôm nay giờ công ty, chưa trả đủ), không theo status OVERDUE: status đó chỉ còn ghi khi
--          CHƯA thu đồng nào (20260915074716) và chỉ được đánh dấu khi có người mở trang Hoá đơn.
--   Đã thu = payments chưa hoàn tác (như trang Thu tiền, thu_tien_collection_v1).
-- Phụ thuộc chỉ gọi lúc chạy (plpgsql không đòi lúc tạo, như file hàm dùng chung của gói D): public.invoice_effective_outstanding_v1
-- (20261021183549), public.is_overdue(invoices) (20260915074716), public.can_do_on_building, public.org_today_v1.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- (a)(b) Hoá đơn của MỘT phòng, chưa xoá, chưa huỷ (mọi kỳ, hoặc đúng p_billing_month). row_no 1 = hoá đơn chính: kỳ mới nhất, MONTHLY
-- trước quyết toán, tạo sau trước. Nợ thực tính trên tập hoá đơn của phòng.
CREATE OR REPLACE FUNCTION public.invoice_room_invoices_v1(p_organization_id uuid,p_room_id uuid,p_billing_month text DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL,p_as_of date DEFAULT NULL)
RETURNS TABLE(row_no integer,invoice_id uuid,organization_id uuid,building_id uuid,room_id uuid,contract_id uuid,invoice_number text,kind text,
  status text,billing_month text,issue_date date,due_date date,paid_date date,total_amount numeric,paid_amount numeric,remaining_amount numeric,
  effective_outstanding numeric,carried_out_amount numeric,carried_in_amount numeric,is_overdue boolean,overdue_days integer)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_b uuid[]; v_today date; v_ids uuid[];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  -- Như web: khoá của trang (RequirePermission) xét theo từng toà, trên toà RLS buildings của người gọi thấy.
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('invoices','view',b.id);
  v_today:=COALESCE(p_as_of,public.org_today_v1(p_organization_id));
  SELECT COALESCE(array_agg(i.id),'{}'::uuid[]) INTO v_ids FROM public.invoices i
    WHERE i.organization_id=p_organization_id AND i.room_id=p_room_id AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED'
      AND i.building_id=ANY(v_b) AND (p_billing_month IS NULL OR i.billing_month=p_billing_month);
  RETURN QUERY
  SELECT (row_number() OVER (ORDER BY i.billing_month DESC,(COALESCE(i.kind,'MONTHLY')='MONTHLY') DESC,i.created_at DESC,i.id))::integer,
    i.id,i.organization_id,i.building_id,i.room_id,i.contract_id,i.invoice_number,i.kind,i.status::text,i.billing_month,i.issue_date,i.due_date,
    i.paid_date,COALESCE(i.total_amount,0),COALESCE(i.paid_amount,0),COALESCE(i.remaining_amount,COALESCE(i.total_amount,0)-COALESCE(i.paid_amount,0)),
    COALESCE(e.effective_outstanding,0),COALESCE(e.carried_out_amount,0),COALESCE(e.carried_in_amount,0),
    COALESCE(public.is_overdue(i),false),CASE WHEN COALESCE(public.is_overdue(i),false) THEN (v_today-i.due_date)::integer END
  FROM public.invoices i
  LEFT JOIN public.invoice_effective_outstanding_v1(v_ids) e ON e.invoice_id=i.id
  WHERE i.id=ANY(v_ids)
  ORDER BY 1;
END $fn$;

-- (b) Đóng trễ: hoá đơn có HẠN trong [p_from, p_to] (mặc định 90 ngày tới p_to / hôm nay; kẹp tối đa 366 ngày tính lùi từ p_to — không
-- quét cả lịch sử khi chỉ có p_from), chưa xoá/huỷ/nháp, tổng > 0. Ngày trả đủ = ngày của
-- lần thu làm số đã thu cộng dồn đạt tổng tiền; hoá đơn đã PAID mà không đạt (làm tròn / cấn trừ) ⇒ paid_date, không có thì lần thu cuối.
-- Số ngày trễ = ngày trả đủ − hạn; còn nợ ⇒ hôm nay − hạn (trễ tới nay); sớm/đúng hạn = 0.
CREATE OR REPLACE FUNCTION public.invoice_lateness_v1(p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL,p_room_id uuid DEFAULT NULL,
  p_from date DEFAULT NULL,p_to date DEFAULT NULL,p_as_of date DEFAULT NULL)
RETURNS TABLE(invoice_id uuid,organization_id uuid,building_id uuid,room_id uuid,contract_id uuid,invoice_number text,billing_month text,
  due_date date,settled_date date,is_open boolean,days_late integer,total_amount numeric,remaining_amount numeric)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_b uuid[]; v_today date; v_from date; v_to date;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('invoices','view',b.id);
  v_today:=COALESCE(p_as_of,public.org_today_v1(p_organization_id));
  v_to:=COALESCE(p_to,v_today); v_from:=GREATEST(COALESCE(p_from,v_to-90),v_to-366);
  RETURN QUERY
  WITH inv AS MATERIALIZED (
    SELECT i.id,i.organization_id,i.building_id,i.room_id,i.contract_id,i.invoice_number,i.billing_month,i.due_date,i.paid_date,i.status::text AS status,
      COALESCE(i.total_amount,0) AS total,COALESCE(i.remaining_amount,COALESCE(i.total_amount,0)-COALESCE(i.paid_amount,0)) AS rem
    FROM public.invoices i
    WHERE i.organization_id=p_organization_id AND i.deleted_at IS NULL AND i.status::text NOT IN ('CANCELLED','DRAFT','PENDING_APPROVAL')
      AND i.due_date BETWEEN v_from AND v_to AND COALESCE(i.total_amount,0)>0 AND i.building_id=ANY(v_b)
      AND (p_room_id IS NULL OR i.room_id=p_room_id)),
  pay AS MATERIALIZED (
    SELECT p.invoice_id,p.payment_date,sum(p.amount) OVER (PARTITION BY p.invoice_id ORDER BY p.payment_date,p.created_at,p.id) AS cum
    FROM public.payments p WHERE p.invoice_id IN (SELECT inv.id FROM inv) AND p.reversed_at IS NULL),
  settled AS (
    SELECT inv.*,(inv.status<>'PAID' AND inv.rem>0) AS open_now,
      COALESCE((SELECT min(pay.payment_date) FROM pay WHERE pay.invoice_id=inv.id AND pay.cum>=inv.total),
        CASE WHEN inv.status='PAID' OR inv.rem<=0 THEN COALESCE(inv.paid_date,(SELECT max(pay.payment_date) FROM pay WHERE pay.invoice_id=inv.id)) END)
        AS settle_day
    FROM inv)
  SELECT s.id,s.organization_id,s.building_id,s.room_id,s.contract_id,s.invoice_number,s.billing_month,s.due_date,
    CASE WHEN s.open_now THEN NULL ELSE s.settle_day END,s.open_now,
    CASE WHEN s.open_now THEN GREATEST(v_today-s.due_date,0) WHEN s.settle_day IS NOT NULL THEN GREATEST(s.settle_day-s.due_date,0) ELSE 0 END::integer,
    s.total,s.rem
  FROM settled s
  ORDER BY s.due_date,s.id;
END $fn$;

-- (c) Đã thu theo hình thức (TM tiền mặt / TK chuyển khoản / TT thanh toán / CT cấn trừ) trong [p_from, p_to] theo NGÀY THU (mặc định tháng
-- của hôm nay), như trang Thu tiền: payments chưa hoàn tác của hoá đơn chưa xoá, chưa huỷ; khoá web thu_tien.view theo toà.
CREATE OR REPLACE FUNCTION public.invoice_collection_by_method_v1(p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL,
  p_from date DEFAULT NULL,p_to date DEFAULT NULL)
RETURNS TABLE(building_id uuid,organization_id uuid,payment_method text,payment_count integer,invoice_count integer,amount numeric)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_b uuid[]; v_today date; v_from date; v_to date;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('thu_tien','view',b.id);
  v_today:=public.org_today_v1(p_organization_id);
  v_from:=COALESCE(p_from,date_trunc('month',v_today)::date);
  v_to:=COALESCE(p_to,(date_trunc('month',v_today)+interval '1 month - 1 day')::date);
  RETURN QUERY
  SELECT i.building_id,i.organization_id,p.payment_method::text,count(*)::integer,count(DISTINCT i.id)::integer,COALESCE(sum(p.amount),0)
  FROM public.payments p JOIN public.invoices i ON i.id=p.invoice_id
  WHERE p.reversed_at IS NULL AND p.payment_date BETWEEN v_from AND v_to AND p.organization_id=p_organization_id
    AND i.organization_id=p_organization_id AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED' AND i.building_id=ANY(v_b)
  GROUP BY i.building_id,i.organization_id,p.payment_method::text
  ORDER BY i.building_id,p.payment_method::text;
END $fn$;

-- (d) Điều chỉnh hoá đơn (bất biến, invoice_adjustments) của hoá đơn chưa xoá, chưa huỷ, kèm trạng thái kiểm tra; is_current = đúng phiên
-- bản hiện hành của hoá đơn (chỉ phiên bản đó xác nhận kiểm tra được). Tên người điều chỉnh / kiểm tra dưới RLS profiles. Ngày lọc theo giờ
-- Việt Nam, khoảng [p_from, p_to] mặc định 366 ngày tới p_to / hôm nay và kẹp tối đa 366 ngày (không đọc cả lịch sử).
CREATE OR REPLACE FUNCTION public.invoice_adjustments_list_v1(p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL,p_room_id uuid DEFAULT NULL,
  p_status text DEFAULT NULL,p_from date DEFAULT NULL,p_to date DEFAULT NULL)
RETURNS TABLE(adjustment_id uuid,organization_id uuid,invoice_id uuid,invoice_number text,billing_month text,building_id uuid,room_id uuid,
  contract_id uuid,revision bigint,is_current boolean,before_total numeric,after_total numeric,delta numeric,reason text,adjusted_by uuid,
  adjusted_by_name text,adjusted_at timestamptz,review_status text,checked_by_name text,checked_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_b uuid[]; v_from date; v_to date;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('invoices','view',b.id);
  v_to:=COALESCE(p_to,public.org_today_v1(p_organization_id)); v_from:=GREATEST(COALESCE(p_from,v_to-366),v_to-366);
  RETURN QUERY
  SELECT ad.id,ad.organization_id,i.id,i.invoice_number,i.billing_month,i.building_id,i.room_id,i.contract_id,ad.revision,
    ad.revision=i.adjustment_revision,ad.before_total,ad.after_total,ad.delta,ad.reason,ad.adjusted_by,
    (SELECT pr.full_name FROM public.profiles pr WHERE pr.id=ad.adjusted_by),ad.adjusted_at,ad.review_status,
    (SELECT pr.full_name FROM public.profiles pr WHERE pr.id=ad.checked_by),ad.checked_at
  FROM public.invoice_adjustments ad JOIN public.invoices i ON i.id=ad.invoice_id
  WHERE ad.organization_id=p_organization_id AND i.organization_id=p_organization_id AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED'
    AND i.building_id=ANY(v_b) AND (p_room_id IS NULL OR i.room_id=p_room_id) AND (p_status IS NULL OR ad.review_status=p_status)
    AND (ad.adjusted_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN v_from AND v_to
  ORDER BY ad.adjusted_at DESC,ad.id;
END $fn$;

-- (e) Phòng có HĐ hiệu lực (ACTIVE, chưa thanh lý, chưa xoá, bắt đầu tính tiền ≤ cuối kỳ) mà CHƯA có hoá đơn MONTHLY kỳ p_billing_month
-- (bỏ hoá đơn huỷ / xoá). Tên khách: đại diện, RLS ẩn thì khách đầu (như invoice_detail_v1).
CREATE OR REPLACE FUNCTION public.invoice_missing_v1(p_organization_id uuid,p_billing_month text,p_building_ids uuid[] DEFAULT NULL)
RETURNS TABLE(contract_id uuid,organization_id uuid,contract_number text,start_date date,end_date date,room_id uuid,building_id uuid,customer_name text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_b uuid[]; v_start date; v_end date;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  IF p_billing_month IS NULL OR p_billing_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'invoice_missing_month_invalid' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('invoices','view',b.id);
  v_start:=to_date(p_billing_month||'-01','YYYY-MM-DD');
  v_end:=(v_start+interval '1 month - 1 day')::date;
  RETURN QUERY
  SELECT c.id,c.organization_id,c.contract_number,c.start_date,c.end_date,r.id,r.building_id,COALESCE(rc.full_name,fc.full_name)
  FROM public.contracts c
  JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=p_organization_id AND r.building_id=ANY(v_b) AND r.deleted_at IS NULL
  LEFT JOIN LATERAL (SELECT
      (SELECT cc.customer_id FROM public.contract_customers cc WHERE cc.contract_id=c.id AND cc.is_representative ORDER BY cc.created_at,cc.id LIMIT 1) rep_id,
      (SELECT cc.customer_id FROM public.contract_customers cc WHERE cc.contract_id=c.id ORDER BY cc.created_at,cc.id LIMIT 1) first_id) pick ON true
  LEFT JOIN public.customers rc ON rc.id=pick.rep_id AND rc.organization_id=p_organization_id
  LEFT JOIN public.customers fc ON fc.id=pick.first_id AND fc.organization_id=p_organization_id
  WHERE c.organization_id=p_organization_id AND c.deleted_at IS NULL AND c.status::text='ACTIVE' AND c.actual_end_date IS NULL
    AND COALESCE(c.start_billing_date,c.start_date,v_start)<=v_end
    AND NOT EXISTS(SELECT 1 FROM public.invoices i WHERE i.contract_id=c.id AND i.organization_id=p_organization_id AND i.billing_month=p_billing_month
      AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED' AND COALESCE(i.kind,'MONTHLY')='MONTHLY')
  ORDER BY r.building_id,r.name,c.id;
END $fn$;

-- (f) + nhắc nợ (Q18): hoá đơn còn nợ THỰC > 0 (chưa xoá, APPROVED / PARTIAL_PAID / OVERDUE, còn lại > 0 — đúng tập của công nợ #267),
-- kèm quá hạn, mã tra cứu công khai của HĐ đang hiệu lực (trang /c/<mã> luôn hiện hoá đơn MỚI NHẤT của HĐ) và tên khách đại diện (RLS).
-- Trang /c/<mã> hiện tên khách (20260808100000) và mã chỉ 6 ký tự ⇒ mã chỉ trả khi người gọi có customers.view ở toà của hoá đơn.
CREATE OR REPLACE FUNCTION public.invoice_open_debts_v1(p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL,p_room_id uuid DEFAULT NULL,
  p_as_of date DEFAULT NULL)
RETURNS TABLE(invoice_id uuid,organization_id uuid,building_id uuid,room_id uuid,contract_id uuid,invoice_number text,billing_month text,
  due_date date,total_amount numeric,remaining_amount numeric,effective_outstanding numeric,is_overdue boolean,overdue_days integer,
  contract_active boolean,public_code text,customer_name text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_b uuid[]; v_today date; v_ids uuid[];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('invoices','view',b.id);
  v_today:=COALESCE(p_as_of,public.org_today_v1(p_organization_id));
  SELECT COALESCE(array_agg(i.id),'{}'::uuid[]) INTO v_ids FROM public.invoices i
    WHERE i.organization_id=p_organization_id AND i.deleted_at IS NULL AND i.status::text IN ('APPROVED','PARTIAL_PAID','OVERDUE')
      AND COALESCE(i.remaining_amount,0)>0 AND i.building_id=ANY(v_b) AND (p_room_id IS NULL OR i.room_id=p_room_id);
  RETURN QUERY
  SELECT i.id,i.organization_id,i.building_id,i.room_id,i.contract_id,i.invoice_number,i.billing_month,i.due_date,COALESCE(i.total_amount,0),
    COALESCE(i.remaining_amount,0),e.effective_outstanding,COALESCE(public.is_overdue(i),false),
    CASE WHEN COALESCE(public.is_overdue(i),false) THEN (v_today-i.due_date)::integer END,
    COALESCE(c.status::text='ACTIVE' AND c.actual_end_date IS NULL AND c.deleted_at IS NULL,false),
    CASE WHEN c.status::text='ACTIVE' AND c.actual_end_date IS NULL AND c.deleted_at IS NULL
      AND public.can_do_on_building('customers','view',i.building_id) THEN c.public_code END,
    COALESCE(rc.full_name,fc.full_name)
  FROM public.invoices i
  JOIN public.invoice_effective_outstanding_v1(v_ids) e ON e.invoice_id=i.id
  LEFT JOIN public.contracts c ON c.id=i.contract_id AND c.organization_id=p_organization_id
  LEFT JOIN LATERAL (SELECT
      (SELECT cc.customer_id FROM public.contract_customers cc WHERE cc.contract_id=i.contract_id AND cc.is_representative ORDER BY cc.created_at,cc.id LIMIT 1) rep_id,
      (SELECT cc.customer_id FROM public.contract_customers cc WHERE cc.contract_id=i.contract_id ORDER BY cc.created_at,cc.id LIMIT 1) first_id) pick ON true
  LEFT JOIN public.customers rc ON rc.id=pick.rep_id AND rc.organization_id=p_organization_id
  LEFT JOIN public.customers fc ON fc.id=pick.first_id AND fc.organization_id=p_organization_id
  WHERE e.effective_outstanding>0
  ORDER BY i.building_id,i.room_id,i.billing_month,i.id;
END $fn$;

ALTER FUNCTION public.invoice_room_invoices_v1(uuid,uuid,text,uuid[],date) OWNER TO postgres;
ALTER FUNCTION public.invoice_lateness_v1(uuid,uuid[],uuid,date,date,date) OWNER TO postgres;
ALTER FUNCTION public.invoice_collection_by_method_v1(uuid,uuid[],date,date) OWNER TO postgres;
ALTER FUNCTION public.invoice_adjustments_list_v1(uuid,uuid[],uuid,text,date,date) OWNER TO postgres;
ALTER FUNCTION public.invoice_missing_v1(uuid,text,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.invoice_open_debts_v1(uuid,uuid[],uuid,date) OWNER TO postgres;
-- Chỉ người đăng nhập (INVOKER ⇒ RLS của họ); không anon/PUBLIC/service_role.
REVOKE ALL ON FUNCTION public.invoice_room_invoices_v1(uuid,uuid,text,uuid[],date),public.invoice_lateness_v1(uuid,uuid[],uuid,date,date,date),
  public.invoice_collection_by_method_v1(uuid,uuid[],date,date),public.invoice_adjustments_list_v1(uuid,uuid[],uuid,text,date,date),
  public.invoice_missing_v1(uuid,text,uuid[]),public.invoice_open_debts_v1(uuid,uuid[],uuid,date) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.invoice_room_invoices_v1(uuid,uuid,text,uuid[],date),public.invoice_lateness_v1(uuid,uuid[],uuid,date,date,date),
  public.invoice_collection_by_method_v1(uuid,uuid[],date,date),public.invoice_adjustments_list_v1(uuid,uuid[],uuid,text,date,date),
  public.invoice_missing_v1(uuid,text,uuid[]),public.invoice_open_debts_v1(uuid,uuid[],uuid,date) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
