-- Phụ thuộc PR #201 / 20261017115809_invoice_read_shared_v1.sql.
-- Chi tiết hai thẻ Hoá đơn: INVOKER + RLS, cùng phạm vi và công thức invoice_statistics_v3.
-- JSONB chứa toàn bộ dòng để PostgREST max_rows không cắt tổng hộp thoại ở 1000 phiếu.
-- Tiền thối: kỳ/ngày/trạng thái HOÁ ĐƠN, mặc định bỏ huỷ (trừ hỏi CANCELLED), luôn bỏ xoá mềm.
-- Cọc: kỳ/ngày PHIẾU THU, độc lập trạng thái hoá đơn như thẻ; chỉ phiếu INCOME APPROVED còn hiệu lực.
-- Giữ policy; thay hai tổng tiền của thẻ #201 để phiếu bị RLS ẩn không còn được cộng.
-- Metadata LEFT JOIN dưới RLS không làm mất khoản tiền.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Phân loại cọc đòi đọc income_expense_types vốn bị categories.view che với nhân viên.
-- Helper DEFINER chỉ trả ID DÒNG cọc, tự giao phạm vi chính người gọi, không nhận id từ client.
-- Chi tiết và số tiền vẫn đọc bảng gốc dưới RLS trong hàm INVOKER bên dưới.
CREATE OR REPLACE FUNCTION public.invoice_breakdown_deposit_item_ids_v1()
RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE v_scope uuid[]; v_ids uuid[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'invoice_read_unauthenticated' USING ERRCODE = '42501';
  END IF;
  v_scope := public.invoice_scope_building_ids_v1();
  SELECT coalesce(array_agg(it.id), '{}'::uuid[]) INTO v_ids
    FROM public.income_expense_items it
    JOIN public.income_expenses ie ON ie.id = it.income_expense_id AND ie.organization_id = it.organization_id
    JOIN public.income_expense_types t ON t.id = it.income_expense_type_id AND t.is_deposit = TRUE
   WHERE ie.building_id = ANY (v_scope)
     AND ie.deleted_at IS NULL AND ie.type = 'INCOME' AND ie.approval_status = 'APPROVED';
  RETURN v_ids;
END
$fn$;

-- Tập dòng tiền tối thiểu dùng CHUNG cho thẻ và dialog: không materialize metadata trên thẻ.
-- RLS restrictive của income_expenses/items (phiếu hạn chế) phải áp cả vào tổng.
CREATE OR REPLACE FUNCTION public.invoice_change_entries_v1(
  p_billing_month text DEFAULT NULL,
  p_status public.invoice_status DEFAULT NULL,
  p_payment_status text DEFAULT NULL,
  p_filter_building_ids uuid[] DEFAULT NULL,
  p_room_ids uuid[] DEFAULT NULL,
  p_issue_date_from date DEFAULT NULL,
  p_issue_date_to date DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE(voucher_id uuid, change_amount numeric)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $fn$
DECLARE v_scope uuid[];
BEGIN
  IF current_user IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'invoice_breakdown chỉ chạy bằng JWT người dùng' USING ERRCODE = '42501';
  END IF;
  IF p_payment_status IS NOT NULL AND p_payment_status NOT IN ('paid', 'partial', 'unpaid') THEN
    RAISE EXCEPTION 'Tham số thống kê hoá đơn không hợp lệ' USING ERRCODE = '22023';
  END IF;
  v_scope := public.invoice_scope_building_ids_v1();
  RETURN QUERY
  WITH inv AS MATERIALIZED (
    SELECT i.id
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
  )
  SELECT ie.id, ie.change_amount
    FROM inv i JOIN public.income_expenses ie ON ie.invoice_id = i.id
    WHERE ie.deleted_at IS NULL AND ie.type = 'INCOME' AND ie.change_amount > 0
      AND (ie.payment_collection_id IS NULL OR EXISTS (
          SELECT 1 FROM public.invoice_payment_collections active_collection
           WHERE active_collection.id = ie.payment_collection_id AND active_collection.status = 'ACTIVE'))
      AND (ie.payment_id IS NULL OR EXISTS (
          SELECT 1 FROM public.active_payments active_payment WHERE active_payment.id = ie.payment_id));
END
$fn$;

CREATE OR REPLACE FUNCTION public.invoice_deposit_entries_v1(
  p_billing_month text DEFAULT NULL,
  p_status public.invoice_status DEFAULT NULL,
  p_payment_status text DEFAULT NULL,
  p_filter_building_ids uuid[] DEFAULT NULL,
  p_room_ids uuid[] DEFAULT NULL,
  p_issue_date_from date DEFAULT NULL,
  p_issue_date_to date DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE(voucher_id uuid, amount numeric)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $fn$
DECLARE v_scope uuid[]; v_item_ids uuid[];
BEGIN
  IF current_user IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'invoice_breakdown chỉ chạy bằng JWT người dùng' USING ERRCODE = '42501';
  END IF;
  IF p_payment_status IS NOT NULL AND p_payment_status NOT IN ('paid', 'partial', 'unpaid') THEN
    RAISE EXCEPTION 'Tham số thống kê hoá đơn không hợp lệ' USING ERRCODE = '22023';
  END IF;
  v_scope := public.invoice_scope_building_ids_v1();
  v_item_ids := public.invoice_breakdown_deposit_item_ids_v1();
  RETURN QUERY
  WITH deposits AS MATERIALIZED (
    SELECT it.income_expense_id, sum(it.amount) AS amount
      FROM public.income_expense_items it
     WHERE it.id = ANY (v_item_ids)
     GROUP BY it.income_expense_id
  )
  SELECT ie.id, dep.amount
    FROM public.income_expenses ie
    JOIN deposits dep ON dep.income_expense_id = ie.id
    WHERE ie.deleted_at IS NULL AND ie.type = 'INCOME' AND ie.approval_status = 'APPROVED'
      AND ie.building_id = ANY (v_scope)
      AND (p_building_ids IS NULL OR ie.building_id = ANY (p_building_ids))
      AND (p_filter_building_ids IS NULL OR ie.building_id = ANY (p_filter_building_ids))
      AND (p_room_ids IS NULL OR ie.room_id = ANY (p_room_ids))
      AND (p_issue_date_from IS NULL OR ie.voucher_date >= p_issue_date_from)
      AND (p_issue_date_to IS NULL OR ie.voucher_date <= p_issue_date_to)
      AND (p_billing_month IS NULL OR to_char(ie.voucher_date, 'YYYY-MM') = p_billing_month)
      AND (ie.payment_collection_id IS NULL OR EXISTS (
          SELECT 1 FROM public.invoice_payment_collections active_collection
           WHERE active_collection.id = ie.payment_collection_id AND active_collection.status = 'ACTIVE'))
      AND (ie.payment_id IS NULL OR EXISTS (
          SELECT 1 FROM public.active_payments active_payment WHERE active_payment.id = ie.payment_id));
END
$fn$;

CREATE OR REPLACE FUNCTION public.invoice_change_breakdown_v1(
  p_billing_month text DEFAULT NULL,
  p_status public.invoice_status DEFAULT NULL,
  p_payment_status text DEFAULT NULL,
  p_filter_building_ids uuid[] DEFAULT NULL,
  p_room_ids uuid[] DEFAULT NULL,
  p_issue_date_from date DEFAULT NULL,
  p_issue_date_to date DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $fn$
DECLARE v_result jsonb;
BEGIN
  IF current_user IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'invoice_breakdown chỉ chạy bằng JWT người dùng' USING ERRCODE = '42501';
  END IF;
  WITH rows AS (
    SELECT ie.change_account_id AS account_id, coalesce(ca.name, '(chưa gán sổ thối)') AS account_name,
      i.billing_month, b.name AS building_name, r.name AS room_name,
      coalesce(nullif(ie.payer_name, ''), nullif(ie.creator_name, ''), '') AS payer_name,
      ie.voucher_date, entry.change_amount, ie.code, ie.id AS sort_id
    FROM public.invoice_change_entries_v1(p_billing_month, p_status, p_payment_status, p_filter_building_ids, p_room_ids, p_issue_date_from, p_issue_date_to, p_building_ids) entry
    JOIN public.income_expenses ie ON ie.id = entry.voucher_id
    JOIN public.invoices i ON i.id = ie.invoice_id
    LEFT JOIN public.accounts ca ON ca.id = ie.change_account_id
    LEFT JOIN public.buildings b ON b.id = i.building_id
    LEFT JOIN public.rooms r ON r.id = i.room_id
  )
  SELECT coalesce(jsonb_agg(to_jsonb(rows) - 'sort_id' ORDER BY account_name, billing_month, building_name,
    room_name, voucher_date, sort_id), '[]'::jsonb) INTO v_result FROM rows;
  RETURN v_result;
END
$fn$;

CREATE OR REPLACE FUNCTION public.invoice_deposit_breakdown_v1(
  p_billing_month text DEFAULT NULL,
  p_status public.invoice_status DEFAULT NULL,
  p_payment_status text DEFAULT NULL,
  p_filter_building_ids uuid[] DEFAULT NULL,
  p_room_ids uuid[] DEFAULT NULL,
  p_issue_date_from date DEFAULT NULL,
  p_issue_date_to date DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $fn$
DECLARE v_result jsonb;
BEGIN
  IF current_user IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'invoice_breakdown chỉ chạy bằng JWT người dùng' USING ERRCODE = '42501';
  END IF;
  WITH rows AS (
    SELECT ie.building_id, b.name AS building_name, ie.room_id, r.name AS room_name,
      ie.contract_id, c.contract_number, c.total_deposit, c.deposit_paid, c.deposit_remaining,
      c.deposit_debt_mode, ie.id AS voucher_id, ie.code, ie.voucher_date, dep.amount,
      coalesce(a.name, '') AS account_name, ie.notes,
      inv.id AS invoice_id, inv.invoice_number, inv.total_amount AS invoice_total
    FROM public.invoice_deposit_entries_v1(p_billing_month, p_status, p_payment_status, p_filter_building_ids, p_room_ids, p_issue_date_from, p_issue_date_to, p_building_ids) dep
    JOIN public.income_expenses ie ON ie.id = dep.voucher_id
    LEFT JOIN public.buildings b ON b.id = ie.building_id
    LEFT JOIN public.rooms r ON r.id = ie.room_id
    LEFT JOIN public.contracts c ON c.id = ie.contract_id
    LEFT JOIN public.accounts a ON a.id = ie.account_id
    LEFT JOIN public.invoices inv ON inv.id = ie.invoice_id AND inv.deleted_at IS NULL
  )
  SELECT coalesce(jsonb_agg(to_jsonb(rows) ORDER BY building_name, room_name, voucher_date, voucher_id),
    '[]'::jsonb) INTO v_result FROM rows;
  RETURN v_result;
END
$fn$;

-- #201 tính change/deposit trong helper DEFINER nên bỏ qua restrictive RLS phiếu hạn chế.
-- Nay hai tổng đi cùng nguồn INVOKER của dialog; các chỉ số khác của thẻ giữ nguyên.
-- Helper money cũ vẫn giữ tương thích; EXPLAIN/đối chiếu hiệu năng cần làm trên TEST trước merge.
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
  ),
  change_total AS (
    SELECT coalesce(sum(e.change_amount), 0) AS amount
      FROM public.invoice_change_entries_v1(p_billing_month, p_status, p_payment_status, p_filter_building_ids, p_room_ids, p_issue_date_from, p_issue_date_to, p_building_ids) e
  ),
  deposit_total AS (
    SELECT coalesce(sum(e.amount), 0) AS amount
      FROM public.invoice_deposit_entries_v1(p_billing_month, p_status, p_payment_status, p_filter_building_ids, p_room_ids, p_issue_date_from, p_issue_date_to, p_building_ids) e
  )
  -- numeric(15,2) như các biến DECIMAL(15,2) của v2.
  SELECT totals.total_amount::numeric(15,2), totals.total_paid::numeric(15,2),
         totals.total_remaining::numeric(15,2), totals.total_refunded::numeric(15,2), totals.total_count,
         items.rent_amount::numeric(15,2), items.electric_amount::numeric(15,2),
         items.water_amount::numeric(15,2), items.pdv_amount::numeric(15,2),
         money.total_collected::numeric(15,2), money.payment_tm::numeric(15,2),
         money.payment_tk::numeric(15,2), money.payment_tt::numeric(15,2),
         money.payment_ct::numeric(15,2), change_total.amount::numeric(15,2),
         deposit_total.amount::numeric(15,2)
    FROM totals, items, money, change_total, deposit_total;
END
$fn$;

ALTER FUNCTION public.invoice_breakdown_deposit_item_ids_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.invoice_breakdown_deposit_item_ids_v1() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_breakdown_deposit_item_ids_v1() TO authenticated;
ALTER FUNCTION public.invoice_change_breakdown_v1(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.invoice_change_breakdown_v1(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_change_breakdown_v1(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[]) TO authenticated;
ALTER FUNCTION public.invoice_deposit_breakdown_v1(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.invoice_deposit_breakdown_v1(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_deposit_breakdown_v1(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[]) TO authenticated;

ALTER FUNCTION public.invoice_change_entries_v1(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.invoice_change_entries_v1(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_change_entries_v1(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[]) TO authenticated;
ALTER FUNCTION public.invoice_deposit_entries_v1(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.invoice_deposit_entries_v1(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_deposit_entries_v1(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[]) TO authenticated;

COMMIT;
NOTIFY pgrst, 'reload schema';
