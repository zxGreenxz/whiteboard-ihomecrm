import { readFileSync } from 'node:fs';
import { sharedW2, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, USER, ORG, FOREIGN } from './wave2-sql-fixture.mjs';
import { CUSTOMER_A, CUSTOMER_B, CUSTOMER_C, CONTRACT_A, CONTRACT_B, INVOICE_A, INVOICE_B } from './full-read-sql-fixture.mjs';
import { CASHBOOK, CATEGORY } from './finance-fixture.mjs';

// Gói A đợt 2 (thu tiền, công nợ, cọc) — fixture RIÊNG của Gói A, chỉ Gói A sửa. Dựng trên sharedW2:
// fixture đọc đầy đủ đợt 1 + nền đợt 2 + migration của CHÍNH gói A (dải 2026101801xxxx). Bảng/cột web mà
// hàm dùng chung cần: tạo trong before (hàm LANGUAGE sql kiểm bảng lúc tạo). RPC web THẬT lấy từ migration
// cuối định nghĩa chúng: get_overpayment_summary (20260710170000), get_refund_forfeit_summary
// (20260822113000), get_reservation_settlement_summary_v1 + get_reservation_settlements_v1 (20260909172332);
// get_held_deposit_summary đã có từ baseline (finance-fixture). get_reservation_deposit_summary: thân SỐNG
// 17/10 (production/TEST vá bằng thay chuỗi động ở 20260909172332 + 20260928161948, không có CREATE nguyên
// văn). Cổng tổng hợp cùng chữ ký: can_view_restricted_ie, ie_visible_cashbook_ids_v1,
// reservation_settlement_can_read_v1/refunded_v1/json_v1 (không chứng minh bút toán, chặn phòng, RLS).
// Dữ liệu tổng hợp; "hôm nay" của fixture = 2026-10-16 (org_today_v1). MỘT PGlite cho cả file test,
// mỗi ca BEGIN … ROLLBACK (shared.isolated).
const u = n => `0a0a0a0a-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ROOM2 = u(1), ROOM3 = u(2), ROOM4 = u(3), ROOM5 = u(4);
export const INV_A3 = u(10), INV_A_CANCELLED = u(11), INV_A_FAR = u(12), INV_A_DELETED = u(13), INV_ROOM2 = u(14), INV_FOREIGN = u(15);
export const INV_OVER = u(20), INV_OVER_CANCELLED = u(21), INV_OVER_DELETED = u(22), INV_OVER_B = u(23);
export const INV_C_PAID = u(30), INV_C_UNPAID = u(31), INV_C_REV = u(32), INV_C_CANCELLED = u(33);
export const PAY_A = u(40), PAY_C_PAID = u(41), PAY_C_REV = u(42);
export const CONTRACT_FULL = u(50), CONTRACT_FI = u(51), CONTRACT_TERM = u(52), CONTRACT_DEL = u(53), CONTRACT_FORF = u(54);
export const HIDDEN_CUSTOMER = u(55), STRANGER = u(56);
export const DEPOSIT_TYPE = u(60), RV1 = u(61), RV2 = u(62), RV3 = u(63), RV_EXCL = u(64), RV_CONTRACT = u(65), RV_NODEP = u(66), RV_SETTLED = u(67), RV_B = u(68);
export const S1 = u(70), S2 = u(71), S3 = u(72), S_FOREIGN = u(73);
export const T1 = u(80), T2 = u(81), T3 = u(82), REF_POSTED = u(83), REF_UNAPPROVED = u(84), REF_REVERSED = u(85), REF_ORPHAN = u(86);
export const CHANGE_BOOK = u(90), ROUND_BOOK = u(91), OTHER_BOOK = u(92);
export const L1 = u(93), L2 = u(94), L3 = u(95), L4 = u(96), L5 = u(97), L6 = u(98), L7 = u(99);
export const V_COLLECT = u(100), V_COLLECT2 = u(101), V_COLLECT_RESTRICTED = u(102), V_DETAIL = u(103), V_DETAIL_UNAPPROVED = u(104), V_DETAIL_RESTRICTED = u(105);
export const PAY_A_REV = u(106), V_DETAIL_REVERSED = u(107);
export const ADJ_PENDING = u(140), ADJ_OLD = u(141);

// Định nghĩa hàm trong migration: từ CREATE … đến thẻ đóng thân đầu tiên (kể cả thẻ đóng không có ';').
function definition(path, name) {
  const src = readFileSync(path, 'utf8');
  const start = src.search(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${name.replaceAll('.', '\\.')}\\(`));
  if (start < 0) throw new Error(`missing definition ${name}`);
  const open = src.slice(start).match(/AS\s+(\$[A-Za-z_]*\$)/);
  const bodyAt = start + open.index + open[0].length;
  const end = src.indexOf(open[1], bodyAt);
  return `${src.slice(start, end + open[1].length)};`;
}
const M = name => `supabase/migrations/${name}.sql`;

const TABLES = `
  ALTER TABLE public.buildings ADD COLUMN name_sort text GENERATED ALWAYS AS (name) STORED;
  ALTER TABLE public.rooms ADD COLUMN name_sort text GENERATED ALWAYS AS (name) STORED;
  ALTER TABLE public.invoices ADD COLUMN kind text,ADD COLUMN issue_date date,ADD COLUMN paid_date date,ADD COLUMN subtotal numeric,
    ADD COLUMN discount_amount numeric,ADD COLUMN previous_debt numeric,ADD COLUMN adjustment_review_status text;
  ALTER TABLE public.invoice_items ADD COLUMN unit_price numeric,ADD COLUMN quantity numeric,ADD COLUMN from_date date,ADD COLUMN to_date date,
    ADD COLUMN previous_reading numeric,ADD COLUMN current_reading numeric,ADD COLUMN sort_order integer;
  ALTER TABLE public.income_expenses ADD COLUMN contract_id uuid,ADD COLUMN payment_id uuid,ADD COLUMN creator_name text,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),ADD COLUMN change_account_id uuid,ADD COLUMN change_amount numeric,
    ADD COLUMN rounding_account_id uuid,ADD COLUMN rounding_amount numeric,ADD COLUMN system_source text,ADD COLUMN posting_status text,
    ADD COLUMN active_posting_id_v2 uuid;
  ALTER TABLE public.contract_customers ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
  CREATE TABLE public.payments(id uuid PRIMARY KEY,organization_id uuid,invoice_id uuid,receipt_number text,amount numeric,payment_method text,
    payment_date date,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),reversed_at timestamptz,receipt_image_url text,retained_amount numeric);
  -- Lượt 14: dòng thu đang hiệu lực tối giản (thật: lần thu ACTIVE + thanh toán cũ chưa hoàn tác); số giữ lại = retained_amount, trống thì amount.
  CREATE VIEW public.active_payment_receipts WITH (security_invoker=true) AS SELECT p.id,p.organization_id,p.invoice_id,p.payment_method,p.payment_date,
    COALESCE(p.retained_amount,p.amount) collected_amount FROM public.payments p WHERE p.reversed_at IS NULL;
  CREATE TABLE public.invoice_adjustments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,invoice_id uuid,review_status text,
    before_snapshot jsonb);
  -- Đợt 3 Hoá đơn (20261022051118): cột điều chỉnh bất biến, tên nhân viên dưới RLS profiles, cột suy is_overdue. Bản port is_overdue cùng
  -- ý nghĩa với thân thật (20260915074716), so status dạng chữ vì fixture không có enum invoice_status.
  ALTER TABLE public.invoices ADD COLUMN adjustment_revision bigint NOT NULL DEFAULT 0;
  ALTER TABLE public.invoice_adjustments ADD COLUMN revision bigint,ADD COLUMN reason text,ADD COLUMN before_total numeric,ADD COLUMN after_total numeric,
    ADD COLUMN delta numeric,ADD COLUMN adjusted_by uuid,ADD COLUMN adjusted_at timestamptz,ADD COLUMN checked_by uuid,ADD COLUMN checked_at timestamptz;
  CREATE TABLE public.profiles(id uuid PRIMARY KEY,full_name text);
  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
  CREATE POLICY f_select ON public.profiles FOR SELECT TO authenticated USING (true);
  CREATE FUNCTION public.is_overdue(public.invoices) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT $1.due_date IS NOT NULL AND $1.deleted_at IS NULL AND $1.status NOT IN ('PAID','CANCELLED')
      AND COALESCE($1.paid_amount,0)<COALESCE($1.total_amount,0) AND $1.due_date<public.org_today_v1($1.organization_id)$$;
  CREATE TABLE public.contract_terminations(id uuid PRIMARY KEY,organization_id uuid,contract_id uuid,termination_date date,termination_type text,
    total_deposit numeric,total_deductions numeric,refund_amount numeric,status text);
  CREATE TABLE public.reservation_deposit_settlements(id uuid PRIMARY KEY,organization_id uuid,source_voucher_id uuid,building_id uuid,room_id uuid,
    deposit_amount numeric,retained_amount numeric,refund_amount numeric,settlement_date date,reason_code text,reason_text text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),revenue_voucher_id uuid,offset_voucher_id uuid,refund_voucher_id uuid);
  CREATE TABLE public.reservation_hold_deadlines(income_expense_id uuid PRIMARY KEY,organization_id uuid,hold_until date,topup_due_date date,
    deposit_target numeric);
  CREATE TABLE public.deposit_management_exclusions(voucher_id uuid PRIMARY KEY,organization_id uuid);
  CREATE TABLE public.fixture_settlement_paid(settlement_id uuid PRIMARY KEY,paid numeric NOT NULL);
  CREATE TABLE public.fixture_restricted_view(user_id uuid PRIMARY KEY);
  -- Cổng tổng hợp cùng chữ ký (bản thật: has_any_scope_v3('income_expenses.restricted_view') / sổ của mình, sổ đang giữ,
  -- công ty mình làm chủ trong các công ty của mình).
  -- RLS web theo buildings.view (bản thật: is_super_admin() / buildings_for_v3('buildings.view')).
  CREATE TABLE public.fixture_super_scope(on_off boolean NOT NULL);
  CREATE FUNCTION public.has_full_building_scope() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM public.fixture_super_scope WHERE on_off)$$;
  CREATE FUNCTION public.accessible_building_ids() RETURNS SETOF uuid LANGUAGE sql STABLE AS $$SELECT building_id FROM public.fixture_building_access$$;
  -- Khoá trang theo toà (bản thật: not offboarded AND (super admin OR can_v3(bảng.hành_động, toà))).
  CREATE FUNCTION public.can_do_on_building(_table text,_action text,_building_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
    $$SELECT EXISTS(SELECT 1 FROM public.fixture_acl WHERE permission=_table||'.'||_action AND allowed AND (org_wide OR _building_id=ANY(building_ids)))$$;
  -- Khoá trang không theo toà, như route web không truyền toà (bản thật: is_super_admin() OR has_any_scope_v3(khoá)).
  CREATE FUNCTION public.can_access_org_entity(_resource text,_action text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
    $$SELECT EXISTS(SELECT 1 FROM public.fixture_acl WHERE permission=_resource||'.'||_action AND allowed)$$;
  CREATE FUNCTION public.can_view_restricted_ie() RETURNS boolean LANGUAGE sql STABLE AS
    $$SELECT EXISTS(SELECT 1 FROM public.fixture_restricted_view WHERE user_id=auth.uid())$$;
  CREATE FUNCTION app_private.ie_visible_cashbook_ids_v1() RETURNS TABLE(cashbook_id uuid) LANGUAGE sql STABLE AS
    $$SELECT a.id FROM public.accounts a WHERE a.deleted_at IS NULL AND a.organization_id=ANY(public.my_org_ids()) AND a.user_id=auth.uid()$$;
  CREATE FUNCTION app_private.reservation_settlement_can_read_v1(p_org uuid,p_building uuid) RETURNS boolean LANGUAGE sql STABLE AS
    $$SELECT auth.uid() IS NOT NULL AND p_org=ANY(public.my_org_ids()) AND public.can_access_building(p_building)$$;
  CREATE FUNCTION app_private.reservation_settlement_refunded_v1(p_settlement uuid) RETURNS numeric LANGUAGE sql STABLE AS
    $$SELECT COALESCE((SELECT paid FROM public.fixture_settlement_paid WHERE settlement_id=p_settlement),0)$$;
  CREATE FUNCTION app_private.reservation_settlement_json_v1(p_settlement uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
  DECLARE s public.reservation_deposit_settlements; v public.income_expenses; paid numeric;
  BEGIN
    SELECT * INTO s FROM public.reservation_deposit_settlements WHERE id=p_settlement;
    SELECT * INTO v FROM public.income_expenses WHERE id=s.source_voucher_id;
    paid:=app_private.reservation_settlement_refunded_v1(s.id);
    RETURN jsonb_build_object('id',s.id,'sourceVoucherId',s.source_voucher_id,'depositAmount',s.deposit_amount,'retainedAmount',s.retained_amount,
      'refundAmount',s.refund_amount,'refundedAmount',paid,'refundRemaining',s.refund_amount-paid,
      'refundState',CASE WHEN s.refund_amount=0 THEN 'NOT_REQUIRED' WHEN paid=s.refund_amount THEN 'PAID' ELSE 'PENDING' END,
      'roomReleased',EXISTS(SELECT 1 FROM public.rooms WHERE id=s.room_id AND status='AVAILABLE'),'roomBlockers','[]'::jsonb,
      'revenueVoucherId',s.revenue_voucher_id,'offsetVoucherId',s.offset_voucher_id,'refundVoucherId',s.refund_voucher_id,'createdAt',s.created_at,
      'settlementDate',s.settlement_date,'reasonCode',s.reason_code,'reasonText',s.reason_text,'buildingId',s.building_id,
      'buildingName',(SELECT name FROM public.buildings WHERE id=s.building_id),'roomId',s.room_id,
      'roomName',(SELECT name FROM public.rooms WHERE id=s.room_id),'payerName',v.payer_name,'voucherCode',v.code);
  END $$;
  -- Thân SỐNG 17/10 của get_reservation_deposit_summary (pg_get_functiondef trên TEST).
  CREATE FUNCTION public.get_reservation_deposit_summary(p_building_ids uuid[] DEFAULT NULL::uuid[]) RETURNS jsonb LANGUAGE sql STABLE
  SET search_path TO 'public' AS $function$
  WITH vouchers AS (
    SELECT ie.id, ie.approval_status, ie.total_amount,
           (SELECT COALESCE(SUM(it.amount), 0)
              FROM public.income_expense_items it
              JOIN public.income_expense_types t ON t.id = it.income_expense_type_id
             WHERE it.income_expense_id = ie.id AND t.is_deposit = true) AS dep_sum
    FROM public.income_expenses ie
    WHERE ie.contract_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.deposit_management_exclusions ex WHERE ex.voucher_id = ie.id AND ex.organization_id = ie.organization_id)
      AND NOT EXISTS(SELECT 1 FROM public.reservation_deposit_settlements s WHERE s.source_voucher_id=ie.id) AND ie.deleted_at IS NULL AND ie.type = 'INCOME'
      AND ie.approval_status IN ('APPROVED','UNAPPROVED','CANCELLED')
      AND (p_building_ids IS NULL OR ie.building_id = ANY(p_building_ids))
      AND EXISTS (SELECT 1 FROM public.income_expense_items it
                  JOIN public.income_expense_types t ON t.id = it.income_expense_type_id
                  WHERE it.income_expense_id = ie.id AND t.is_deposit = true)
  ),
  amt AS (
    SELECT id, approval_status,
           CASE WHEN dep_sum <> 0 THEN dep_sum ELSE total_amount END AS amount
    FROM vouchers
  )
  SELECT jsonb_build_object(
    'holding_amount', COALESCE(SUM(amount) FILTER (WHERE approval_status = 'APPROVED'), 0),
    'approved_count', COALESCE(COUNT(*) FILTER (WHERE approval_status = 'APPROVED'), 0),
    'unapproved_count', COALESCE(COUNT(*) FILTER (WHERE approval_status = 'UNAPPROVED'), 0),
    'cancelled_count', COALESCE(COUNT(*) FILTER (WHERE approval_status = 'CANCELLED'), 0)
  ) FROM amt;
  $function$;`;

const SEED = `
  INSERT INTO public.rooms(id,organization_id,building_id,name,status) VALUES('${ROOM2}','${ORG}','${BUILDING}','P102','AVAILABLE'),
    ('${ROOM3}','${ORG}','${BUILDING}','P103','OCCUPIED'),('${ROOM4}','${ORG}','${BUILDING}','P104','OCCUPIED'),('${ROOM5}','${ORG}','${BUILDING}','P105','OCCUPIED');
  -- Khách của người ngoài công ty (chủ hồ sơ không còn là thành viên) ⇒ web không thấy tên.
  INSERT INTO public.customers(id,organization_id,user_id,full_name,phone) VALUES('${HIDDEN_CUSTOMER}','${ORG}','${STRANGER}','Khách Ẩn Chủ','0977000000');
  INSERT INTO public.contracts(id,organization_id,room_id,status,total_deposit,deposit_paid,deposit_remaining,deposit_debt_mode,deleted_at,contract_number) VALUES
    ('${CONTRACT_FULL}','${ORG}','${ROOM2}','ACTIVE',3000000,2995000,5000,null,null,'HD-FULL'),
    ('${CONTRACT_FI}','${ORG}','${ROOM3}','ACTIVE',2000000,0,2000000,'FIRST_INVOICE',null,'HD-FI'),
    ('${CONTRACT_TERM}','${ORG}','${ROOM4}','TERMINATED',3000000,3000000,0,null,null,'HD-TERM'),
    ('${CONTRACT_DEL}','${ORG}','${ROOM5}','ACTIVE',1000000,0,1000000,null,'2026-09-01','HD-DEL'),
    ('${CONTRACT_FORF}','${ORG}','${ROOM5}','TERMINATED',1000000,1000000,0,null,null,'HD-FORF');
  -- HĐ đủ cọc: khách đầu (không đại diện) thấy được, đại diện thuộc chủ hồ sơ ngoài công ty.
  INSERT INTO public.contract_customers(organization_id,contract_id,customer_id,is_representative,created_at) VALUES
    ('${ORG}','${CONTRACT_FULL}','${CUSTOMER_C}',false,'2026-01-01T00:00:00Z'),('${ORG}','${CONTRACT_FULL}','${HIDDEN_CUSTOMER}',true,'2026-01-02T00:00:00Z'),
    ('${ORG}','${CONTRACT_TERM}','${CUSTOMER_C}',true,'2026-01-01T00:00:00Z');
  -- Ghi chú hoá đơn là chữ tự do (có thể chứa thông tin khách): chỉ trả cùng điều kiện với tên khách.
  UPDATE public.invoices SET kind='MONTHLY',issue_date='2026-10-01',subtotal=3500000,discount_amount=0,previous_debt=0,adjustment_review_status='CHECKED',
    notes='Khách hẹn trả cuối tháng' WHERE id='${INVOICE_A}';
  UPDATE public.invoice_items SET unit_price=amount,quantity=1,sort_order=CASE description WHEN 'Tiền phòng' THEN 1 WHEN 'Tiền điện T10' THEN 2
    WHEN 'Tiền nước T10' THEN 3 ELSE 4 END WHERE invoice_id='${INVOICE_A}';
  UPDATE public.invoice_items SET previous_reading=100,current_reading=200,unit_price=3500,quantity=100 WHERE description='Tiền điện T10';
  INSERT INTO public.invoice_adjustments(organization_id,invoice_id,review_status,revision,reason,before_total,after_total,delta,adjusted_by,adjusted_at,
      checked_by,checked_at) VALUES('${ORG}','${INVOICE_A}','CHECKED',1,'Giảm 100k mất nước 2 ngày',3600000,3500000,-100000,'${USER}','2026-10-12T08:20:00Z',
      '${USER}','2026-10-13T02:00:00Z');
  UPDATE public.invoices SET adjustment_revision=1 WHERE id='${INVOICE_A}';
  INSERT INTO public.profiles VALUES('${USER}','Kế toán A'),('${STRANGER}','Quản lý B');
  -- Lịch thanh toán: phòng P101 (hạn 10/10 + 10/12; huỷ, quá 365 ngày, đã xoá bị bỏ), P102 (không hợp đồng), toà B, công ty khác.
  INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,paid_amount,contract_id,deleted_at) VALUES
    ('${INV_A3}','${ORG}','INV-A3','APPROVED','${BUILDING}','${ROOM}','2026-12','2026-12-10',3500000,0,'${CONTRACT_A}',null),
    ('${INV_A_CANCELLED}','${ORG}','INV-AX','CANCELLED','${BUILDING}','${ROOM}','2027-01','2027-01-10',3500000,0,'${CONTRACT_A}',null),
    ('${INV_A_FAR}','${ORG}','INV-AF','APPROVED','${BUILDING}','${ROOM}','2027-12','2027-12-10',3500000,0,'${CONTRACT_A}',null),
    ('${INV_A_DELETED}','${ORG}','INV-AD','APPROVED','${BUILDING}','${ROOM}','2027-02','2027-02-10',3500000,0,'${CONTRACT_A}','2026-10-01'),
    ('${INV_ROOM2}','${ORG}','INV-R2','APPROVED','${BUILDING}','${ROOM2}','2026-09','2026-09-01',100000,0,null,null),
    ('${INV_FOREIGN}','${FOREIGN}','INV-F','APPROVED','${u(9)}','${u(9)}','2026-10','2026-10-01',100000,0,null,null),
  -- Tiền thừa: 200k (HĐ đủ cọc: đại diện ẩn ⇒ không tên), 100k trên hoá đơn đã huỷ (web vẫn tính), đã xoá bỏ, toà B ngoài phạm vi.
    ('${INV_OVER}','${ORG}','INV-O1','PAID','${BUILDING}','${ROOM2}','2026-08','2026-08-10',1000000,1200000,'${CONTRACT_FULL}',null),
    ('${INV_OVER_CANCELLED}','${ORG}','INV-O2','CANCELLED','${BUILDING}','${ROOM3}','2026-07','2026-07-10',500000,600000,null,null),
    ('${INV_OVER_DELETED}','${ORG}','INV-O3','PAID','${BUILDING}','${ROOM3}','2026-06','2026-06-10',500000,900000,null,'2026-09-01'),
    ('${INV_OVER_B}','${ORG}','INV-O4','PAID','${OTHER_BUILDING}','${OTHER_ROOM}','2026-08','2026-08-10',500000,700000,'${CONTRACT_B}',null),
  -- Thu tiền kỳ 2026-10 (toà A): INVOICE_A (thu 1tr ngày 05/10), thu đủ hôm nay, chưa thu, khoản thu hôm nay đã hoàn tác, đã huỷ.
    ('${INV_C_PAID}','${ORG}','INV-C1','PAID','${BUILDING}','${ROOM2}','2026-10','2026-10-10',2000000,2000000,'${CONTRACT_FULL}',null),
    ('${INV_C_UNPAID}','${ORG}','INV-C2','APPROVED','${BUILDING}','${ROOM3}','2026-10','2026-10-10',1500000,0,'${CONTRACT_FI}',null),
    ('${INV_C_REV}','${ORG}','INV-C3','APPROVED','${BUILDING}','${ROOM4}','2026-10','2026-10-10',800000,0,null,null),
    ('${INV_C_CANCELLED}','${ORG}','INV-C4','CANCELLED','${BUILDING}','${ROOM5}','2026-10','2026-10-10',900000,0,null,null);
  INSERT INTO public.payments(id,organization_id,invoice_id,receipt_number,amount,payment_method,payment_date,created_at,reversed_at) VALUES
    ('${PAY_A}','${ORG}','${INVOICE_A}','PT-A1',1000000,'TM','2026-10-05','2026-10-05T03:00:00Z',null),
    ('${PAY_C_PAID}','${ORG}','${INV_C_PAID}','PT-C1',2000000,'TK','2026-10-16','2026-10-16T03:00:00Z',null),
    ('${PAY_C_REV}','${ORG}','${INV_C_REV}','PT-C3',800000,'TM','2026-10-16','2026-10-16T04:00:00Z','2026-10-16T05:00:00Z'),
    ('${PAY_A_REV}','${ORG}','${INVOICE_A}','PT-A1R',500000,'TM','2026-10-06','2026-10-06T03:00:00Z','2026-10-06T04:00:00Z');
  -- Người thu: hai phiếu cùng người (khác hoa thường) + một phiếu có hạng mục hạn chế của người khác.
  INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,room_id,voucher_date,total_amount,approval_status,
      invoice_id,payment_id,creator_name,created_at,has_restricted_item) VALUES
    ('${V_COLLECT}','${ORG}','${USER}','PT-C1','INCOME','Thu INV-C1','${BUILDING}','${ROOM2}','2026-10-16',1500000,'APPROVED','${INV_C_PAID}','${PAY_C_PAID}','Thu Ngân A','2026-10-16T03:00:00Z',false),
    ('${V_COLLECT2}','${ORG}','${USER}','PT-C1B','INCOME','Thu INV-C1','${BUILDING}','${ROOM2}','2026-10-16',500000,'APPROVED','${INV_C_PAID}','${PAY_C_PAID}','thu ngân a','2026-10-16T03:01:00Z',false),
    ('${V_COLLECT_RESTRICTED}','${ORG}','${STRANGER}','PT-C1C','INCOME','Thu INV-C1','${BUILDING}','${ROOM2}','2026-10-16',1,'APPROVED','${INV_C_PAID}','${PAY_C_PAID}','Bí Mật','2026-10-16T03:02:00Z',true),
    ('${V_DETAIL}','${ORG}','${USER}','PT-A1','INCOME','Thu INV-A','${BUILDING}','${ROOM}','2026-10-05',1000000,'APPROVED','${INVOICE_A}','${PAY_A}','Kế toán A','2026-10-05T03:00:00Z',false),
    ('${V_DETAIL_UNAPPROVED}','${ORG}','${USER}','PT-A2','INCOME','Thu INV-A chờ duyệt','${BUILDING}','${ROOM}','2026-10-06',1,'UNAPPROVED','${INVOICE_A}',null,'Kế toán A','2026-10-06T03:00:00Z',false),
    ('${V_DETAIL_RESTRICTED}','${ORG}','${STRANGER}','PT-A3','INCOME','Thu INV-A hạn chế','${BUILDING}','${ROOM}','2026-10-07',1,'APPROVED','${INVOICE_A}',null,'Bí Mật','2026-10-07T03:00:00Z',true),
    -- Phiếu thu của lần thu đã hoàn tác: web bỏ khỏi dòng phiếu và tổng thu (InvoiceDetailView.tsx activeVouchers).
    ('${V_DETAIL_REVERSED}','${ORG}','${USER}','PT-A1R','INCOME','Thu INV-A đã hoàn tác','${BUILDING}','${ROOM}','2026-10-06',500000,'APPROVED','${INVOICE_A}','${PAY_A_REV}','Kế toán A','2026-10-06T03:00:00Z',false);
  INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,amount,unit_price,quantity) VALUES
    ('${V_DETAIL}','${CATEGORY}',1000000,1000000,1),('${V_DETAIL_REVERSED}','${CATEGORY}',500000,500000,1);
  -- Cọc giữ chỗ.
  INSERT INTO public.income_expense_types(id,organization_id,type,name,is_deposit) VALUES('${DEPOSIT_TYPE}','${ORG}','income','Tiền cọc giữ chỗ',true);
  INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,room_id,voucher_date,total_amount,approval_status,payer_name,contract_id) VALUES
    ('${RV1}','${ORG}','${USER}','PT-G1','INCOME','Cọc giữ chỗ P102','${BUILDING}','${ROOM2}','2026-10-10',2100000,'APPROVED','Trần Cọc',null),
    ('${RV2}','${ORG}','${USER}','PT-G2','INCOME','Cọc giữ chỗ P103','${BUILDING}','${ROOM3}','2026-10-12',500000,'UNAPPROVED','Lê Giữ',null),
    ('${RV3}','${ORG}','${USER}','PT-G3','INCOME','Cọc huỷ','${BUILDING}','${ROOM4}','2026-10-01',300000,'CANCELLED','Phạm Huỷ',null),
    ('${RV_EXCL}','${ORG}','${USER}','PT-G4','INCOME','Cọc đã loại khỏi quản lý','${BUILDING}','${ROOM4}','2026-10-03',400000,'APPROVED','Ẩn',null),
    ('${RV_CONTRACT}','${ORG}','${USER}','PT-G5','INCOME','Cọc đã vào HĐ','${BUILDING}','${ROOM}','2026-10-04',400000,'APPROVED','Đã HĐ','${CONTRACT_A}'),
    ('${RV_NODEP}','${ORG}','${USER}','PT-G6','INCOME','Thu khác','${BUILDING}','${ROOM}','2026-10-05',400000,'APPROVED','Khác',null),
    ('${RV_SETTLED}','${ORG}','${USER}','PT-G7','INCOME','Cọc đã quyết toán','${BUILDING}','${ROOM5}','2026-10-02',700000,'APPROVED','Ngô Quyết',null),
    ('${RV_B}','${ORG}','${USER}','PT-G8','INCOME','Cọc toà B','${OTHER_BUILDING}','${OTHER_ROOM}','2026-10-11',900000,'APPROVED','Toà B',null);
  INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,amount,unit_price,quantity) VALUES
    ('${RV1}','${DEPOSIT_TYPE}',2000000,2000000,1),('${RV1}','${CATEGORY}',100000,100000,1),('${RV2}','${DEPOSIT_TYPE}',500000,500000,1),
    ('${RV3}','${DEPOSIT_TYPE}',300000,300000,1),('${RV_EXCL}','${DEPOSIT_TYPE}',400000,400000,1),('${RV_CONTRACT}','${DEPOSIT_TYPE}',400000,400000,1),
    ('${RV_NODEP}','${CATEGORY}',400000,400000,1),('${RV_SETTLED}','${DEPOSIT_TYPE}',700000,700000,1),('${RV_B}','${DEPOSIT_TYPE}',900000,900000,1);
  INSERT INTO public.deposit_management_exclusions VALUES('${RV_EXCL}','${ORG}');
  INSERT INTO public.reservation_hold_deadlines VALUES('${RV1}','${ORG}','2026-10-20','2026-10-18',2500000);
  -- Quyết toán cọc giữ chỗ: S1 đã hoàn đủ, S2 chờ hoàn (tạo sau), S3 toà B, công ty khác.
  INSERT INTO public.reservation_deposit_settlements(id,organization_id,source_voucher_id,building_id,room_id,deposit_amount,retained_amount,refund_amount,
      settlement_date,reason_code,reason_text,created_at) VALUES
    ('${S1}','${ORG}','${RV_SETTLED}','${BUILDING}','${ROOM5}',700000,200000,500000,'2026-10-08','CUSTOMER_CANCEL','khách đổi ý — riêng tư','2026-10-08T03:00:00Z'),
    ('${S2}','${ORG}','${u(110)}','${BUILDING}','${ROOM2}',400000,0,400000,'2026-10-09','ROOM_ISSUE',null,'2026-10-09T03:00:00Z'),
    ('${S3}','${ORG}','${RV_B}','${OTHER_BUILDING}','${OTHER_ROOM}',900000,900000,0,'2026-10-09','FORFEIT',null,'2026-10-09T04:00:00Z'),
    ('${S_FOREIGN}','${FOREIGN}','${u(111)}','${u(9)}','${u(9)}',1,0,1,'2026-10-09','X',null,'2026-10-09T05:00:00Z');
  INSERT INTO public.fixture_settlement_paid VALUES('${S1}',500000),('${S2}',100000);
  -- Hoàn / bỏ cọc: T1 hoàn (một phiếu đã vào sổ; phiếu chờ duyệt và phiếu đã đảo không tính), T2 bỏ cọc, T3 toà B.
  INSERT INTO public.contract_terminations VALUES
    ('${T1}','${ORG}','${CONTRACT_TERM}','2026-10-01','EARLY',3000000,1000000,2000000,'COMPLETED'),
    ('${T2}','${ORG}','${CONTRACT_FORF}','2026-09-15','FORFEIT',1000000,1000000,0,'COMPLETED'),
    ('${T3}','${ORG}','${CONTRACT_B}','2026-10-02','EARLY',1,0,1,'COMPLETED');
  INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,room_id,voucher_date,total_amount,approval_status,contract_id,
      system_source,posting_status,active_posting_id_v2) VALUES
    ('${REF_POSTED}','${ORG}','${USER}','PC-H1','EXPENSE','Hoàn cọc thanh lý','${BUILDING}','${ROOM4}','2026-10-02',1500000,'APPROVED','${CONTRACT_TERM}','termination.refund','POSTED','${u(120)}'),
    ('${REF_UNAPPROVED}','${ORG}','${USER}','PC-H2','EXPENSE','Hoàn cọc thanh lý','${BUILDING}','${ROOM4}','2026-10-03',200000,'UNAPPROVED','${CONTRACT_TERM}','termination.refund','UNPOSTED',null),
    ('${REF_REVERSED}','${ORG}','${USER}','PC-H3','EXPENSE','Hoàn cọc thanh lý','${BUILDING}','${ROOM4}','2026-10-03',300000,'APPROVED','${CONTRACT_TERM}','termination.refund','REVERSED','${u(122)}'),
    ('${REF_ORPHAN}','${ORG}','${USER}','PC-H4','EXPENSE','Hoàn cọc không hồ sơ','${BUILDING}','${ROOM}','2026-10-04',250000,'APPROVED','${CONTRACT_A}','termination.refund','POSTED','${u(121)}');
  INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,amount,unit_price,quantity,accounting_class) VALUES
    ('${REF_POSTED}','${CATEGORY}',1500000,1500000,1,'DEPOSIT'),('${REF_ORPHAN}','${CATEGORY}',250000,250000,1,'OTHER');
  -- Sổ tiền thối / làm tròn.
  INSERT INTO public.accounts VALUES('${CHANGE_BOOK}','${ORG}','${USER}','Hiển Thối',null,false,null),('${ROUND_BOOK}','${ORG}','${USER}','Làm tròn tiền thiếu',null,false,null),
    ('${OTHER_BOOK}','${ORG}','${STRANGER}','Thối người khác',null,false,null);
  INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,room_id,voucher_date,total_amount,approval_status,invoice_id,payer_name,notes,
      change_account_id,change_amount,rounding_account_id,rounding_amount,has_restricted_item) VALUES
    ('${L1}','${ORG}','${USER}','PT-T1','INCOME','Thu có thối','${BUILDING}','${ROOM}','2026-10-03',500000,'APPROVED','${INVOICE_A}','Khách Lẻ','thối 5k','${CHANGE_BOOK}',5000,null,null,false),
    ('${L2}','${ORG}','${USER}','PT-T2','INCOME','Thu có thối','${BUILDING}','${ROOM2}','2026-10-15',300000,'APPROVED',null,'Khách Hai',null,'${CHANGE_BOOK}',3000,null,null,false),
    ('${L3}','${ORG}','${USER}','PT-T3','INCOME','Thu chờ duyệt','${BUILDING}','${ROOM2}','2026-10-15',300000,'UNAPPROVED',null,null,null,'${CHANGE_BOOK}',7000,null,null,false),
    ('${L4}','${ORG}','${USER}','PT-T4','INCOME','Thu tháng trước','${BUILDING}','${ROOM2}','2026-09-20',300000,'APPROVED',null,null,null,'${CHANGE_BOOK}',4000,null,null,false),
    ('${L5}','${ORG}','${USER}','PT-T5','INCOME','Thu toà B','${OTHER_BUILDING}','${OTHER_ROOM}','2026-10-10',300000,'APPROVED',null,null,null,'${CHANGE_BOOK}',6000,null,null,false),
    ('${L6}','${ORG}','${USER}','PT-T6','INCOME','Thu làm tròn','${BUILDING}','${ROOM3}','2026-10-04',998000,'APPROVED',null,null,null,null,null,'${ROUND_BOOK}',2000,false),
    ('${L7}','${ORG}','${STRANGER}','PT-T7','INCOME','Thu hạn chế','${BUILDING}','${ROOM3}','2026-10-05',1,'APPROVED',null,null,null,'${CHANGE_BOOK}',9000,null,null,true);
  -- Đợt 3 Hoá đơn: điều chỉnh CHỜ KIỂM của người khác trên INV-C2 (phiên bản hiện hành) + bản cũ hơn đã bị thay (không kiểm được nữa).
  INSERT INTO public.invoice_adjustments(id,organization_id,invoice_id,review_status,revision,reason,before_total,after_total,delta,adjusted_by,adjusted_at) VALUES
    ('${ADJ_PENDING}','${ORG}','${INV_C_UNPAID}','PENDING',2,'Thêm 50k vệ sinh',1550000,1500000,-50000,'${STRANGER}','2026-10-14T03:00:00Z'),
    ('${ADJ_OLD}','${ORG}','${INV_C_UNPAID}','PENDING',1,'Giảm nhầm',1600000,1550000,-50000,'${STRANGER}','2026-10-13T03:00:00Z');
  UPDATE public.invoices SET adjustment_revision=2,adjustment_review_status='PENDING' WHERE id='${INV_C_UNPAID}';`;

// RLS cổng tổng hợp cho vai authenticated (mô hình INVOKER + RLS 18/10): hàm dùng chung và hàm đọc gói A chạy
// dưới RLS của người hỏi. Policy chép ĐÚNG ý nghĩa bản sống (pg_policies TEST 17/10), cấp toà qua
// fixture_building_access (= accessible_building_ids). Không chứng minh policy thật — phần đó đo trên TEST.
// authenticated KHÔNG có USAGE trên app_private (như TEST/production): test gọi hàm đọc gói qua lối vào thật
// public.hermes_w2_read_v1 hoặc qua public.fixture_w2a_read (thân SQL chuẩn gắn OID, như lối vào thật).
const RLS = `
  CREATE FUNCTION public.fixture_can_view_customers() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
    $$SELECT EXISTS(SELECT 1 FROM public.fixture_acl WHERE permission='customers.view' AND allowed)$$;
  DO $rls$
  DECLARE t text;
  BEGIN
    FOREACH t IN ARRAY ARRAY['invoices','rooms','buildings','income_expenses','payments','invoice_items','invoice_adjustments','contracts',
        'contract_customers','customers','contract_terminations','reservation_deposit_settlements','reservation_hold_deadlines',
        'deposit_management_exclusions','accounts','income_expense_items','income_expense_types'] LOOP
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    END LOOP;
  END $rls$;
  CREATE POLICY f_select ON public.invoices FOR SELECT TO authenticated USING (public.has_full_building_scope() OR building_id IN (SELECT public.accessible_building_ids()));
  CREATE POLICY f_select ON public.rooms FOR SELECT TO authenticated USING (public.has_full_building_scope() OR building_id IN (SELECT public.accessible_building_ids()));
  CREATE POLICY f_select ON public.buildings FOR SELECT TO authenticated USING (public.has_full_building_scope() OR id IN (SELECT public.accessible_building_ids()));
  CREATE POLICY f_rbac ON public.income_expenses FOR SELECT TO authenticated USING (public.has_full_building_scope() OR building_id IN (SELECT public.accessible_building_ids()));
  CREATE POLICY f_fund ON public.income_expenses FOR SELECT TO authenticated USING (deleted_at IS NULL AND (account_id IN (SELECT a.id FROM public.accounts a)
    OR change_account_id IN (SELECT a.id FROM public.accounts a) OR rounding_account_id IN (SELECT a.id FROM public.accounts a)));
  CREATE POLICY f_restricted ON public.income_expenses AS RESTRICTIVE FOR SELECT TO authenticated
    USING (has_restricted_item=false OR user_id=auth.uid() OR public.can_view_restricted_ie());
  CREATE POLICY f_select ON public.payments FOR SELECT TO authenticated USING (invoice_id IN (SELECT i.id FROM public.invoices i));
  CREATE POLICY f_select ON public.invoice_items FOR SELECT TO authenticated USING (invoice_id IN (SELECT i.id FROM public.invoices i));
  CREATE POLICY f_select ON public.invoice_adjustments FOR SELECT TO authenticated USING (invoice_id IN (SELECT i.id FROM public.invoices i));
  CREATE POLICY f_select ON public.contracts FOR SELECT TO authenticated USING (room_id IN (SELECT r.id FROM public.rooms r));
  CREATE POLICY f_select ON public.contract_customers FOR SELECT TO authenticated USING (contract_id IN (SELECT c.id FROM public.contracts c));
  CREATE POLICY f_select ON public.customers FOR SELECT TO authenticated
    USING (public.fixture_can_view_customers() AND user_id=ANY(public.current_visible_owner_ids()));
  CREATE POLICY f_select ON public.contract_terminations FOR SELECT TO authenticated USING (contract_id IN (SELECT c.id FROM public.contracts c));
  CREATE POLICY f_select ON public.reservation_deposit_settlements FOR SELECT TO authenticated
    USING (app_private.reservation_settlement_can_read_v1(organization_id,building_id));
  CREATE POLICY f_select ON public.reservation_hold_deadlines FOR SELECT TO authenticated USING (true);
  CREATE POLICY f_select ON public.deposit_management_exclusions FOR SELECT TO authenticated
    USING (EXISTS(SELECT 1 FROM public.income_expenses ie WHERE ie.id=voucher_id AND ie.organization_id=deposit_management_exclusions.organization_id));
  CREATE POLICY f_select ON public.accounts FOR SELECT TO authenticated USING (user_id=auth.uid());
  CREATE POLICY f_select ON public.income_expense_items FOR SELECT TO authenticated
    USING (EXISTS(SELECT 1 FROM public.income_expenses v WHERE v.id=income_expense_id));
  CREATE POLICY f_select ON public.income_expense_types FOR SELECT TO authenticated USING (true);
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
  -- Gọi thẳng hàm đọc gói bằng vai authenticated với ctx tự dựng (không qua bước kiểm quyền của cổng).
  CREATE FUNCTION public.fixture_w2a_read(p_report text,p_params jsonb,p_ctx jsonb) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER
  BEGIN ATOMIC SELECT app_private.hermes_w2a_read_v1(p_report,p_params,p_ctx); END;`;

// Mặc định gói A + dải Z (review PR #215 P3-1): test gói kiểm định nghĩa CUỐI sẽ phát hành, không phải bản gói đã bị Z thay.
export async function sharedW2a(options = {}) {
  return sharedW2({ packages: ['a', 'z'], ...options,
    before: async db => {
      // Như Supabase (pg_default_acl schema public): hàm postgres tạo trong public mặc định cấp EXECUTE cho anon,
      // authenticated, service_role; migration gói chỉ REVOKE PUBLIC/anon/service_role.
      await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role');
      await db.exec(TABLES);
      for (const [file, name] of [['20260710170000_money_aggregate_rpcs', 'public.get_overpayment_summary'],
        ['20260822113000_refund_kpi_split_deposit_vs_other', 'public.get_refund_forfeit_summary'],
        ['20260909172332_reservation_deposit_settlement_v1', 'public.get_reservation_settlement_summary_v1'],
        ['20260909172332_reservation_deposit_settlement_v1', 'public.get_reservation_settlements_v1']]) await db.exec(definition(M(file), name));
      if (options.before) await options.before(db);
    },
    seed: async db => { await db.exec(SEED); await db.exec(RLS); if (options.seed) await options.seed(db); } });
}
export { BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, USER, ORG, FOREIGN, CUSTOMER_A, CUSTOMER_B, CUSTOMER_C, CONTRACT_A, CONTRACT_B, INVOICE_A, INVOICE_B, CASHBOOK };
