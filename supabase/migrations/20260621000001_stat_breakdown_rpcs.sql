-- 20260621000001_stat_breakdown_rpcs.sql
-- Chi tiết cho 2 thẻ thống kê trang Hoá đơn (mở modal khi bấm):
--   * get_change_breakdown_v2  : tiền thối theo sổ quỹ "Thối" × kỳ hoá đơn
--   * get_deposit_breakdown_v2 : cọc nhận trong kỳ theo toà→phòng (+ đủ/thiếu từ HĐ)
-- Cùng scope (can_access_building + billing_month/voucher_date) như get_invoice_statistics_v2.

CREATE OR REPLACE FUNCTION public.get_change_breakdown_v2(p_building_id uuid DEFAULT NULL::uuid, p_room_id uuid DEFAULT NULL::uuid, p_status invoice_status DEFAULT NULL::invoice_status, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_billing_month text DEFAULT NULL::text, p_payment_status text DEFAULT NULL::text, p_building_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(account_id uuid, account_name text, billing_month text, building_name text, room_name text, payer_name text, voucher_date date, change_amount numeric, code text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ie.change_account_id, COALESCE(ca.name,'(chưa gán sổ thối)'),
    i.billing_month, b.name, r.name,
    COALESCE(NULLIF(ie.payer_name,''), NULLIF(ie.creator_name,''), ''),
    ie.voucher_date, ie.change_amount, ie.code
  FROM income_expenses ie
  JOIN invoices i ON i.id = ie.invoice_id
  LEFT JOIN accounts ca ON ca.id = ie.change_account_id
  LEFT JOIN buildings b ON b.id = i.building_id
  LEFT JOIN rooms r ON r.id = i.room_id
  WHERE ie.deleted_at IS NULL AND ie.type='INCOME' AND ie.change_amount > 0
    AND i.deleted_at IS NULL AND public.can_access_building(i.building_id)
    AND (p_building_id IS NULL OR i.building_id = p_building_id)
    AND (p_building_ids IS NULL OR i.building_id = ANY(p_building_ids))
    AND (p_room_id IS NULL OR i.room_id = p_room_id)
    AND (p_status IS NULL OR i.status = p_status)
    AND (p_start_date IS NULL OR i.issue_date >= p_start_date)
    AND (p_end_date IS NULL OR i.issue_date <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (p_payment_status IS NULL
      OR (p_payment_status='paid' AND i.status='PAID')
      OR (p_payment_status='partial' AND i.status='PARTIAL_PAID')
      OR (p_payment_status='unpaid' AND i.status NOT IN ('PAID','PARTIAL_PAID')))
  ORDER BY ca.name, i.billing_month, b.name, r.name;
$function$
;
REVOKE ALL ON FUNCTION public.get_change_breakdown_v2(uuid,uuid,invoice_status,date,date,text,text,uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_change_breakdown_v2(uuid,uuid,invoice_status,date,date,text,text,uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_deposit_breakdown_v2(p_building_id uuid DEFAULT NULL::uuid, p_room_id uuid DEFAULT NULL::uuid, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_billing_month text DEFAULT NULL::text, p_building_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(building_id uuid, building_name text, room_id uuid, room_name text, contract_id uuid, contract_number text, total_deposit numeric, deposit_paid numeric, deposit_remaining numeric, deposit_debt_mode text, voucher_id uuid, code text, voucher_date date, amount numeric, account_name text, notes text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ie.building_id, b.name, ie.room_id, r.name,
    ie.contract_id, c.contract_number,
    c.total_deposit, c.deposit_paid, c.deposit_remaining, c.deposit_debt_mode,
    ie.id, ie.code, ie.voucher_date, ie.total_amount, COALESCE(a.name,''), ie.notes
  FROM income_expenses ie
  LEFT JOIN buildings b ON b.id = ie.building_id
  LEFT JOIN rooms r ON r.id = ie.room_id
  LEFT JOIN contracts c ON c.id = ie.contract_id
  LEFT JOIN accounts a ON a.id = ie.account_id
  WHERE ie.deleted_at IS NULL AND ie.type='INCOME' AND ie.approval_status='APPROVED'
    AND public.can_access_building(ie.building_id)
    AND (p_building_id IS NULL OR ie.building_id = p_building_id)
    AND (p_building_ids IS NULL OR ie.building_id = ANY(p_building_ids))
    AND (p_room_id IS NULL OR ie.room_id = p_room_id)
    AND (p_start_date IS NULL OR ie.voucher_date >= p_start_date)
    AND (p_end_date IS NULL OR ie.voucher_date <= p_end_date)
    AND (p_billing_month IS NULL OR to_char(ie.voucher_date,'YYYY-MM') = p_billing_month)
    AND EXISTS (SELECT 1 FROM income_expense_items it
      JOIN income_expense_types t ON t.id=it.income_expense_type_id
      WHERE it.income_expense_id=ie.id AND t.is_deposit=TRUE)
  ORDER BY b.name, r.name, ie.voucher_date;
$function$
;
REVOKE ALL ON FUNCTION public.get_deposit_breakdown_v2(uuid,uuid,date,date,text,uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_deposit_breakdown_v2(uuid,uuid,date,date,text,uuid[]) TO authenticated;
