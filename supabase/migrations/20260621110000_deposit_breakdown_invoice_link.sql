-- get_deposit_breakdown_v2: bổ sung thông tin HOÁ ĐƠN mà khoản cọc được thu kèm.
--
-- Khi thu 1 hoá đơn có gộp cọc (item OTHER "Tiền cọc" / nguồn nợ cũ type 'deposit'),
-- luồng thanh toán tách phiếu thu thành: phiếu DOANH THU + phiếu CỌC (is_deposit),
-- cả hai mang invoice_id (phiếu cọc có notes "[THU TACH COC ...]"). Vì vậy phiếu
-- cọc CÓ invoice_id ⇒ "cọc thu kèm trong hoá đơn". Trả thêm invoice_id /
-- invoice_number / invoice_total để modal hiển thị: Tổng HĐ, Tổng cọc, Phòng+DV.
--
-- RETURNS TABLE đổi (thêm cột) nên phải DROP rồi CREATE lại + cấp lại quyền.

DROP FUNCTION IF EXISTS public.get_deposit_breakdown_v2(uuid, uuid, date, date, text, uuid[]);

CREATE OR REPLACE FUNCTION public.get_deposit_breakdown_v2(
  p_building_id uuid DEFAULT NULL::uuid,
  p_room_id uuid DEFAULT NULL::uuid,
  p_start_date date DEFAULT NULL::date,
  p_end_date date DEFAULT NULL::date,
  p_billing_month text DEFAULT NULL::text,
  p_building_ids uuid[] DEFAULT NULL::uuid[]
)
 RETURNS TABLE(
   building_id uuid, building_name text, room_id uuid, room_name text,
   contract_id uuid, contract_number text,
   total_deposit numeric, deposit_paid numeric, deposit_remaining numeric, deposit_debt_mode text,
   voucher_id uuid, code text, voucher_date date, amount numeric, account_name text, notes text,
   invoice_id uuid, invoice_number text, invoice_total numeric
 )
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ie.building_id, b.name, ie.room_id, r.name,
    ie.contract_id, c.contract_number,
    c.total_deposit, c.deposit_paid, c.deposit_remaining, c.deposit_debt_mode,
    ie.id, ie.code, ie.voucher_date, ie.total_amount, COALESCE(a.name,''), ie.notes,
    inv.id, inv.invoice_number, inv.total_amount
  FROM income_expenses ie
  LEFT JOIN buildings b ON b.id = ie.building_id
  LEFT JOIN rooms r ON r.id = ie.room_id
  LEFT JOIN contracts c ON c.id = ie.contract_id
  LEFT JOIN accounts a ON a.id = ie.account_id
  LEFT JOIN invoices inv ON inv.id = ie.invoice_id AND inv.deleted_at IS NULL
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

NOTIFY pgrst, 'reload schema';
