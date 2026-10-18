-- Hermes đọc đầy đủ — ĐỢT 2, ngoại lệ Q4 (chủ chốt 17/10; soạn ở Gói B): siết khoá lãi lỗ tháng
-- (crm_read_monthly_pnl, đợt 1) cho khớp web. Đặt ở dải Z (không phải dải Gói B): file thay hàm đợt 1 — ngoài
-- hàng rào của gói — và phải phát hành CÙNG đợt Gói Z bật khoá reports_finance.profit_distribution.
--  * Khoá: tab "BC Doanh Thu Chi Phí" của /reports/finance/profit-distribution gate
--    reports_finance.profit_distribution (src/pages/reports/finance/ProfitHubPage.tsx:44,64), không phải
--    reports_finance.analysis ⇒ hermes_report_catalog_v1 đổi khoá của monthly_pnl:by_month.
--  * Phiếu hạn chế: số lãi lỗ lấy từ fa_monthly_pnl(_accrual) (SECURITY DEFINER) nên cộng cả phiếu hạng
--    mục hạn chế mà RLS income_expenses_restricted_select của web giấu người thiếu quyền; web tab Hiệu quả
--    kinh doanh (business_performance_pnl_v1, 20260725051000) đòi income_expenses.restricted_view trên
--    mọi toà ⇒ hermes_report_read_v2 chỉ giữ toà có quyền CRM đó (không toà nào ⇒ 42501). Chặt hơn tab BC
--    Doanh Thu Chi Phí (web cộng phiếu không hạn chế cho người thiếu quyền) — ghi nhận để báo chủ.
-- Thân hai hàm chép NGUYÊN bản sống (catalog: 20261017021554; reader: 20261017033630), chỉ đổi đúng hai chỗ
-- trên (test full-read-report.test.mjs so khớp). Không DROP, không đổi chữ ký. Cần khoá
-- reports_finance.profit_distribution được Gói Z bật cùng lúc, nếu không crm_read_monthly_pnl tắt với mọi người.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.hermes_report_read_v2(text,jsonb,uuid,uuid[],boolean,boolean)') IS NULL
    OR to_regprocedure('app_private.hermes_report_catalog_v1(text,text)') IS NULL
    OR to_regprocedure('app_private.hermes_pnl_pending_v1(date,date,uuid[],boolean)') IS NULL
    OR to_regprocedure('app_private.authorized_scope_v3(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'hermes_w2_q4_requires_full_read';
  END IF;
END $requires$;

CREATE OR REPLACE FUNCTION app_private.hermes_report_catalog_v1(p_domain text,p_report text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT CASE WHEN p_report IS NULL THEN (CASE WHEN p_domain IN ('occupancy_report','invoice_report','monthly_pnl','pending_approvals',
   'zalo_conversations','contract_search') THEN '{}'::jsonb END) ELSE (CASE p_domain||':'||p_report
   WHEN 'occupancy_report:snapshot' THEN '{"permission":"reports_real_estate.occupancy","source":"crm.occupancy_snapshot_v2","scope":"rows","fromDate":true,"buildingFilter":true}'
   WHEN 'occupancy_report:upcoming' THEN '{"permission":"reports_real_estate.occupancy","source":"crm.occupancy_upcoming_vacancy_v2","scope":"rows","fromDate":true,"days":true,"buildingFilter":true}'
   WHEN 'invoice_report:search' THEN '{"permission":"invoices.view","source":"crm.invoices","scope":"rows","month":true,"statuses":["paid","partial","unpaid","cancelled"],"buildingFilter":true}'
   WHEN 'invoice_report:stats' THEN '{"permission":"invoices.view","source":"crm.invoices","scope":"buildings","month":true,"buildingFilter":true}'
   WHEN 'monthly_pnl:by_month' THEN '{"permission":"reports_finance.profit_distribution","source":"crm.fa_monthly_pnl","scope":"rows","fromDate":true,"toDate":true,"requiresDates":true,"basis":true,"buildingFilter":true}'
   WHEN 'pending_approvals:inbox' THEN '{"permission":"income_expenses.view","source":"crm.list_my_pending_approvals_v1","scope":"organization"}'
   WHEN 'zalo_conversations:list' THEN '{"permission":"chat_zalo.view","source":"crm.zalo_conversations","scope":"organization"}'
   WHEN 'contract_search:search' THEN '{"permission":"contracts.view","source":"crm.contracts","scope":"rows","statuses":["ACTIVE","TERMINATED","EXPIRING","EXPIRED"],"buildingFilter":true}'
 END)::jsonb END
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_report_read_v2(p_domain text,p_input jsonb,p_org uuid,p_buildings uuid[],p_overlay_org boolean,
  p_customers_visible boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_report text:=p_input->>'report'; v_spec jsonb; v_query text:=NULLIF(btrim(COALESCE(p_input->>'query','')),'');
  v_status text:=p_input->>'status'; v_month text:=p_input->>'month'; v_from date; v_to date; v_days integer; v_today date;
  v_limit integer; v_offset integer; v_raw jsonb; v_rows jsonb:='[]'::jsonb; v_summary jsonb; v_capped boolean:=false;
  v_page jsonb:='[]'::jsonb; v_bytes integer:=0; v_total integer; v_next integer; v_item jsonb; i integer;
  v_count bigint; v_amount numeric; v_paid numeric; v_remaining numeric; v_refunded numeric;
  v_rent numeric; v_electric numeric; v_water numeric; v_service numeric; v_basis text:=COALESCE(p_input->>'basis','accrual');
  v_owners uuid[]; v_pnl_buildings uuid[]; v_size integer; v_restricted uuid[];
BEGIN
  IF auth.uid() IS NULL OR p_org IS NULL THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  v_spec:=app_private.hermes_report_catalog_v1(p_domain,v_report);
  IF v_spec IS NULL OR v_spec='{}'::jsonb THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  v_limit:=app_private.hermes_integer_v1(p_input->'limit'); v_offset:=(p_input->>'offset')::integer;
  v_from:=app_private.hermes_domain_date_v2(p_input->'fromDate'); v_to:=app_private.hermes_domain_date_v2(p_input->'toDate');
  IF p_input->'days'<>'null'::jsonb THEN v_days:=(p_input->>'days')::integer; END IF;
  p_buildings:=COALESCE(p_buildings,'{}'::uuid[]);
  IF v_spec->>'scope'='organization' AND NOT COALESCE(p_overlay_org,false) THEN
    RETURN jsonb_build_object('report',v_report,'source',v_spec->>'source','unavailable','organization_scope_required',
      'summary',NULL,'items','[]'::jsonb,'offset',v_offset,'nextOffset',NULL,'sourceCapped',false);
  END IF;
  -- Báo cáo theo toà mà kết nối không còn toà nào: nói rõ, không trả số 0 như dữ liệu thật.
  IF v_spec->>'scope' IN ('rows','buildings') AND cardinality(p_buildings)=0 THEN
    RETURN jsonb_build_object('report',v_report,'source',v_spec->>'source','unavailable','no_building_scope',
      'summary',NULL,'items','[]'::jsonb,'offset',v_offset,'nextOffset',NULL,'sourceCapped',false);
  END IF;
  v_today:=public.org_today_v1(p_org);
  -- (P2-2) Tên/SĐT khách như RLS customers_select_rbac: chủ hồ sơ là thành viên ACTIVE của công ty.
  v_owners:=COALESCE(public.current_visible_owner_ids(),'{}'::uuid[]);
  IF p_domain='occupancy_report' AND v_report='snapshot' THEN
    -- RPC web của trang Báo cáo lấp đầy (useOccupancyDashboard.ts:83), tập toà đã giao.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('buildingId',o.building_id,'buildingName',app_private.hermes_full_text_v1(o.building_name,200),
        'total',COALESCE(o.total,0),'occupied',COALESCE(o.occupied,0),'reserved',COALESCE(o.reserved,0),'maintenance',COALESCE(o.maintenance,0),
        'unavailable',COALESCE(o.unavailable,0),'available',COALESCE(o.available,0),'occupancyPct',round(o.occupancy_pct,2)::text,
        'committedPct',round(o.committed_pct,2)::text,'missedRevenue',round(o.missed_revenue,2)::text) ORDER BY o.building_name,o.building_id),'[]'::jsonb)
      INTO v_rows FROM public.occupancy_snapshot_v2(COALESCE(v_from,v_today),p_buildings) o
      WHERE o.building_id=ANY(p_buildings) AND (v_query IS NULL OR position(lower(v_query) IN lower(COALESCE(o.building_name,'')))>0);
  ELSIF p_domain='occupancy_report' THEN
    -- RPC web phòng sắp trống (useOccupancyDashboard.ts:108), tập toà đã giao.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('contractId',u.contract_id,'contractNumber',app_private.hermes_full_text_v1(u.contract_number,100),
        'buildingId',u.building_id,'buildingName',app_private.hermes_full_text_v1(u.building_name,200),'roomId',u.room_id,
        'roomName',app_private.hermes_full_text_v1(u.room_name,100),'effectiveEndDate',u.effective_end_date,'daysRemaining',u.days_remaining,
        'rentPrice',u.rent_price::text,'extensionApplied',u.extension_applied) ORDER BY u.effective_end_date,u.building_name,u.room_name,u.contract_id),'[]'::jsonb)
      INTO v_rows FROM public.occupancy_upcoming_vacancy_v2(COALESCE(v_from,v_today),COALESCE(v_days,30),p_buildings) u
      WHERE u.building_id=ANY(p_buildings) AND (v_query IS NULL OR position(lower(v_query) IN
        lower(concat_ws(' ',u.building_name,u.room_name,u.contract_number)))>0);
  ELSIF p_domain='invoice_report' AND v_report='search' THEN
    -- (1) Như danh sách /invoices (useInvoices.ts:194-214): mặc định ẩn hoá đơn huỷ (view_status
    -- active); paid=PAID, partial=PARTIAL_PAID, unpaid = chưa thu đồng nào (không PAID/PARTIAL_PAID)
    -- và không huỷ, cancelled = chỉ hoá đơn huỷ; tìm số HĐ hoặc tên khách (useInvoices.ts:230-257;
    -- tên khách cần customers.view như RLS bảng customers của web).
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.billing_month DESC NULLS LAST,x.bname,x.rname,x.created_at DESC,x.id),'[]'::jsonb),count(*)>=2000
      INTO v_rows,v_capped FROM (
      SELECT inv.id,inv.billing_month,b.name bname,r.name rname,inv.created_at,jsonb_build_object('id',inv.id,
          'number',app_private.hermes_full_text_v1(inv.invoice_number,100),'billingMonth',app_private.hermes_full_text_v1(inv.billing_month,20),
          'dueDate',inv.due_date,'totalAmount',COALESCE(inv.total_amount,0)::text,'paidAmount',COALESCE(inv.paid_amount,0)::text,
          'remainingAmount',COALESCE(inv.remaining_amount,0)::text,'status',inv.status::text,'buildingId',inv.building_id,
          'buildingName',app_private.hermes_full_text_v1(b.name,200),'roomId',inv.room_id,'roomName',app_private.hermes_full_text_v1(r.name,100)) item
      FROM public.invoices inv
      JOIN public.buildings b ON b.id=inv.building_id AND b.organization_id=p_org
      LEFT JOIN public.rooms r ON r.id=inv.room_id AND r.organization_id=p_org
      WHERE inv.organization_id=p_org AND inv.deleted_at IS NULL AND inv.building_id=ANY(p_buildings)
        AND (v_month IS NULL OR inv.billing_month=v_month)
        AND CASE v_status WHEN 'paid' THEN inv.status::text='PAID' WHEN 'partial' THEN inv.status::text='PARTIAL_PAID'
          WHEN 'unpaid' THEN inv.status::text NOT IN ('PAID','PARTIAL_PAID','CANCELLED') WHEN 'cancelled' THEN inv.status::text='CANCELLED'
          ELSE inv.status::text<>'CANCELLED' END
        AND (v_query IS NULL OR position(lower(v_query) IN lower(COALESCE(inv.invoice_number,'')))>0
          OR COALESCE(p_customers_visible,false) AND EXISTS(SELECT 1 FROM public.contract_customers cc
            JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=p_org AND cu.deleted_at IS NULL AND cu.user_id=ANY(v_owners)
            WHERE cc.contract_id=inv.contract_id AND cc.organization_id=p_org AND position(lower(v_query) IN lower(COALESCE(cu.full_name,'')))>0))
      ORDER BY inv.billing_month DESC NULLS LAST,b.name,r.name,inv.created_at DESC,inv.id LIMIT 2000) x;
  ELSIF p_domain='invoice_report' THEN
    -- Cùng bộ lọc hai khối tổng của get_invoice_statistics_v2 (không tính hoá đơn huỷ,
    -- lọc kỳ billing_month, nhóm điện/nước/dịch vụ theo mô tả dòng), nhưng phạm vi là
    -- quyền invoices.view thật ∩ toà kết nối thay vì staff_assignments.
    SELECT COALESCE(sum(inv.total_amount),0),COALESCE(sum(inv.paid_amount),0),COALESCE(sum(GREATEST(inv.remaining_amount,0)),0),
        COALESCE(sum(GREATEST(-inv.remaining_amount,0)),0),count(*)
      INTO v_amount,v_paid,v_remaining,v_refunded,v_count
      FROM public.invoices inv WHERE inv.organization_id=p_org AND inv.deleted_at IS NULL AND inv.building_id=ANY(p_buildings)
        AND inv.status::text<>'CANCELLED' AND (v_month IS NULL OR inv.billing_month=v_month);
    SELECT COALESCE(sum(CASE WHEN ii.type::text='RENT' THEN ii.amount ELSE 0 END),0),
        COALESCE(sum(CASE WHEN ii.type::text NOT IN ('RENT','DISCOUNT') AND lower(COALESCE(ii.description,'')) LIKE '%điện%' THEN ii.amount ELSE 0 END),0),
        COALESCE(sum(CASE WHEN ii.type::text NOT IN ('RENT','DISCOUNT') AND lower(COALESCE(ii.description,'')) LIKE '%nước%' THEN ii.amount ELSE 0 END),0),
        COALESCE(sum(CASE WHEN ii.type::text NOT IN ('RENT','DISCOUNT') AND lower(COALESCE(ii.description,'')) NOT LIKE '%điện%'
          AND lower(COALESCE(ii.description,'')) NOT LIKE '%nước%' THEN ii.amount ELSE 0 END),0)
      INTO v_rent,v_electric,v_water,v_service
      FROM public.invoices inv JOIN public.invoice_items ii ON ii.invoice_id=inv.id
      WHERE inv.organization_id=p_org AND inv.deleted_at IS NULL AND inv.building_id=ANY(p_buildings)
        AND inv.status::text<>'CANCELLED' AND (v_month IS NULL OR inv.billing_month=v_month);
    v_summary:=jsonb_build_object('totalCount',v_count,'totalAmount',v_amount::text,'totalPaid',v_paid::text,'totalRemaining',v_remaining::text,
      'totalRefunded',v_refunded::text,'rentAmount',v_rent::text,'electricAmount',v_electric::text,'waterAmount',v_water::text,'serviceAmount',v_service::text);
  ELSIF p_domain='monthly_pnl' THEN
    -- (2) RPC web của "Phân tích tài chính" (useFinancialAnalysis.ts:96-98): mặc định dồn tích
    -- (fa_monthly_pnl_accrual), basis=cash ⇒ fa_monthly_pnl; tập toà đã giao. Hàng chỉ gồm phiếu
    -- ĐÃ DUYỆT; phần CHỜ DUYỆT mà BC Doanh Thu Chi Phí cộng thêm (ALL_ACTIVE) trả riêng.
    -- (P3-5) Hàng và phần chờ duyệt dùng CÙNG tập toà: toà đã giao, lọc theo query tên toà.
    SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO v_pnl_buildings FROM public.buildings b
      WHERE b.organization_id=p_org AND b.id=ANY(p_buildings) AND (v_query IS NULL OR position(lower(v_query) IN lower(COALESCE(b.name,'')))>0);
    -- Q4 (20261018090100): lãi lỗ cộng cả phiếu HẠN CHẾ (fa_monthly_pnl* là SECURITY DEFINER, bỏ qua RLS
    -- income_expenses_restricted_select) ⇒ như business_performance_pnl_v1: chỉ toà có quyền CRM
    -- income_expenses.restricted_view; còn toà mà không toà nào có quyền đó ⇒ 42501.
    IF cardinality(v_pnl_buildings)>0 THEN
      SELECT COALESCE(array_agg(rb.id ORDER BY rb.id),'{}'::uuid[]) INTO v_restricted FROM unnest(v_pnl_buildings) rb(id)
        WHERE EXISTS(SELECT 1 FROM app_private.authorized_scope_v3('income_expenses.restricted_view',p_org) rs
          WHERE rs.org_wide OR rb.id=ANY(rs.building_ids));
      IF cardinality(v_restricted)=0 THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
      v_pnl_buildings:=v_restricted;
    END IF;
    IF v_basis='accrual' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('month',pnl.month,'buildingId',pnl.building_id,
          'buildingName',app_private.hermes_full_text_v1(pnl.building_name,200),'revenue',COALESCE(pnl.revenue,0)::text,
          'expense',COALESCE(pnl.expense,0)::text,'net',COALESCE(pnl.net,0)::text) ORDER BY pnl.month,pnl.building_name,pnl.building_id),'[]'::jsonb)
        INTO v_rows FROM public.fa_monthly_pnl_accrual(v_from,v_to,v_pnl_buildings) pnl
        WHERE pnl.building_id=ANY(v_pnl_buildings);
    ELSE
      SELECT COALESCE(jsonb_agg(jsonb_build_object('month',pnl.month,'buildingId',pnl.building_id,
          'buildingName',app_private.hermes_full_text_v1(pnl.building_name,200),'revenue',COALESCE(pnl.revenue,0)::text,
          'expense',COALESCE(pnl.expense,0)::text,'net',COALESCE(pnl.net,0)::text) ORDER BY pnl.month,pnl.building_name,pnl.building_id),'[]'::jsonb)
        INTO v_rows FROM public.fa_monthly_pnl(v_from,v_to,v_pnl_buildings) pnl
        WHERE pnl.building_id=ANY(v_pnl_buildings);
    END IF;
    v_summary:=jsonb_build_object('basis',v_basis)||app_private.hermes_pnl_pending_v1(v_from,v_to,v_pnl_buildings,v_basis='accrual');
  ELSIF p_domain='pending_approvals' THEN
    -- (4) RPC web của hộp /approvals (useApprovals.ts:51): việc chờ CHÍNH người hỏi duyệt,
    -- không nhận tham số toà ⇒ chỉ kết nối Toàn tổ chức (đã chặn ở trên).
    SELECT COALESCE(jsonb_agg(jsonb_build_object('requestId',p.request_id,'submissionNo',p.submission_no,
        'submittedAt',to_char(p.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'amount',p.amount::text,
        'voucherId',p.voucher_id,'voucherCode',app_private.hermes_full_text_v1(p.voucher_code,100),
        'voucherName',app_private.hermes_full_text_v1(p.voucher_name,200),'voucherType',p.voucher_type,
        'makerName',app_private.hermes_full_text_v1(p.maker_name,200),'stepNo',p.step_no) ORDER BY p.submitted_at,p.request_id),'[]'::jsonb)
      INTO v_rows FROM public.list_my_pending_approvals_v1() p
      WHERE p.organization_id=p_org
        AND (v_query IS NULL OR position(lower(v_query) IN lower(concat_ws(' ',p.voucher_code,p.voucher_name,p.maker_name)))>0);
  ELSIF p_domain='zalo_conversations' THEN
    -- Như trang Chat Zalo (useZaloChat.ts:170-176): hội thoại của công ty, tin mới nhất trước,
    -- ghim lên đầu; cùng điều kiện RLS web (công ty trong zalo_authorized_org_ids('view')).
    -- Tìm theo tên/SĐT/nhãn người nhắn (không tìm nội dung tin); tin cuối cắt 160 ký tự.
    -- Web chỉ mở Chat Zalo khi quyền chat_zalo.view phủ toàn công ty: thiếu thì nói rõ,
    -- không trả "0 hội thoại" như số thật.
    IF NOT EXISTS(SELECT 1 FROM public.zalo_authorized_org_ids('view') allowed(org_id) WHERE allowed.org_id=p_org) THEN
      RETURN jsonb_build_object('report',v_report,'source',v_spec->>'source','unavailable','organization_scope_required',
        'summary',NULL,'items','[]'::jsonb,'offset',v_offset,'nextOffset',NULL,'sourceCapped',false);
    END IF;
    SELECT jsonb_build_object('conversations',count(*),'unreadConversations',count(*) FILTER (WHERE z.unread_count>0 OR z.marked_unread),
        'unreadMessages',COALESCE(sum(z.unread_count),0),'pinned',count(*) FILTER (WHERE z.is_pinned))
      INTO v_summary FROM public.zalo_conversations z
      WHERE z.organization_id=p_org AND p_org IN (SELECT public.zalo_authorized_org_ids('view'))
        AND (v_query IS NULL OR position(app_private.hermes_zalo_fold_v1(v_query) IN
          app_private.hermes_zalo_fold_v1(concat_ws(' ',z.peer_name,z.peer_phone,z.sub_label)))>0);
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.pinned DESC,x.last_at DESC NULLS LAST,x.id),'[]'::jsonb),count(*)>=2000 INTO v_rows,v_capped FROM (
      SELECT z.id,COALESCE(z.is_pinned,false) pinned,z.last_message_at last_at,jsonb_build_object('conversationId',z.id,
          'peerName',app_private.hermes_full_text_v1(z.peer_name,200),'phone',app_private.hermes_full_text_v1(z.peer_phone,40),
          'threadType',app_private.hermes_full_text_v1(z.thread_type,40),'kind',app_private.hermes_full_text_v1(z.kind,40),
          'unread',COALESCE(z.unread_count,0),'markedUnread',COALESCE(z.marked_unread,false),'pinned',COALESCE(z.is_pinned,false),
          'roomName',app_private.hermes_full_text_v1(r.name,100),'buildingName',app_private.hermes_full_text_v1(b.name,200),
          'label',app_private.hermes_full_text_v1(z.sub_label,200),
          'lastMessageAt',CASE WHEN z.last_message_at IS NULL THEN NULL ELSE to_char(z.last_message_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
          'lastMessageDir',app_private.hermes_full_text_v1(z.last_message_dir,20),
          'lastMessage',app_private.hermes_full_text_v1(left(COALESCE(z.last_message_text,''),160),160)) item
      FROM public.zalo_conversations z
      LEFT JOIN public.rooms r ON r.id=z.room_id AND r.organization_id=p_org
      LEFT JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_org
      WHERE z.organization_id=p_org AND p_org IN (SELECT public.zalo_authorized_org_ids('view'))
        AND (v_query IS NULL OR position(app_private.hermes_zalo_fold_v1(v_query) IN
          app_private.hermes_zalo_fold_v1(concat_ws(' ',z.peer_name,z.peer_phone,z.sub_label)))>0)
      ORDER BY COALESCE(z.is_pinned,false) DESC,z.last_message_at DESC NULLS LAST,z.id LIMIT 2000) x;
  ELSE
    -- (3) Như danh sách Hợp đồng: tìm số HĐ, tên/SĐT khách (customers.view), tên phòng
    -- (useContracts.ts:253-298); lọc ACTIVE = mọi trạng thái trừ thanh lý, TERMINATED, EXPIRING/
    -- EXPIRED như thẻ thống kê (useContracts.ts:322-344); nhãn getContractDisplayStatus
    -- (src/types/contract.ts:180-196) từ end_date + expected_move_out_date; mới tạo trước.
    v_today:=COALESCE(v_today,current_date);
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.created_at DESC NULLS LAST,x.id),'[]'::jsonb),count(*)>=2000 INTO v_rows,v_capped FROM (
      SELECT ct.id,ct.created_at,jsonb_build_object('contractId',ct.id,
          'number',app_private.hermes_full_text_v1(ct.contract_number,100),
          'customerName',CASE WHEN p_customers_visible THEN app_private.hermes_full_text_v1(rep.full_name,200) END,
          'buildingId',r.building_id,'buildingName',app_private.hermes_full_text_v1(b.name,200),'roomId',r.id,
          'roomName',app_private.hermes_full_text_v1(r.name,100),'startDate',ct.start_date,'endDate',ct.end_date,
          'actualEndDate',ct.actual_end_date,'expectedMoveOutDate',ct.expected_move_out_date,'status',ct.status::text,
          'displayStatus',d.code,'displayLabel',d.label,'rentPrice',COALESCE(ct.rent_price,0)::text,
          'totalDeposit',COALESCE(ct.total_deposit,0)::text,'depositPaid',COALESCE(ct.deposit_paid,0)::text) item
      FROM public.contracts ct
      JOIN public.rooms r ON r.id=ct.room_id AND r.organization_id=p_org AND r.deleted_at IS NULL AND r.building_id=ANY(p_buildings)
      JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_org
      LEFT JOIN LATERAL (SELECT cu.full_name FROM public.contract_customers cc
          JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=p_org AND cu.deleted_at IS NULL AND cu.user_id=ANY(v_owners)
          WHERE cc.contract_id=ct.id AND cc.organization_id=p_org
          ORDER BY COALESCE(cc.is_representative,false) DESC,cu.full_name,cu.id LIMIT 1) rep ON true
      CROSS JOIN LATERAL (SELECT CASE
          WHEN ct.status::text='TERMINATED' THEN 'TERMINATED' WHEN ct.status::text='TRANSFERRED' THEN 'TRANSFERRED'
          WHEN ct.status::text='DRAFT' THEN 'DRAFT' WHEN ct.expected_move_out_date IS NOT NULL THEN 'MOVING_OUT'
          WHEN ct.end_date<v_today THEN 'EXPIRED' WHEN ct.end_date-v_today<=30 THEN 'EXPIRING' ELSE 'ACTIVE' END AS code) d0
      CROSS JOIN LATERAL (SELECT d0.code,CASE d0.code WHEN 'ACTIVE' THEN 'Còn hạn' WHEN 'EXPIRING' THEN 'Sắp hết hạn' WHEN 'EXPIRED' THEN 'Quá hạn'
          WHEN 'MOVING_OUT' THEN 'Sắp chuyển đi' WHEN 'TERMINATED' THEN 'Đã thanh lý' WHEN 'TRANSFERRED' THEN 'Đã nhượng' ELSE 'Nháp' END AS label) d
      WHERE ct.organization_id=p_org AND ct.deleted_at IS NULL
        AND CASE v_status WHEN 'ACTIVE' THEN ct.status::text<>'TERMINATED' WHEN 'TERMINATED' THEN ct.status::text='TERMINATED'
          WHEN 'EXPIRING' THEN ct.status::text NOT IN ('TERMINATED','TRANSFERRED','DRAFT') AND ct.expected_move_out_date IS NULL
            AND ct.end_date>=v_today AND ct.end_date<=v_today+30
          WHEN 'EXPIRED' THEN ct.status::text NOT IN ('TERMINATED','TRANSFERRED','DRAFT') AND ct.expected_move_out_date IS NULL
            AND ct.end_date<v_today
          ELSE true END
        AND (v_query IS NULL OR position(lower(v_query) IN lower(COALESCE(ct.contract_number,'')))>0
          OR position(lower(v_query) IN lower(COALESCE(r.name,'')))>0
          OR COALESCE(p_customers_visible,false) AND EXISTS(SELECT 1 FROM public.contract_customers cc2
            JOIN public.customers cu2 ON cu2.id=cc2.customer_id AND cu2.organization_id=p_org AND cu2.deleted_at IS NULL AND cu2.user_id=ANY(v_owners)
            WHERE cc2.contract_id=ct.id AND cc2.organization_id=p_org
              AND (position(lower(v_query) IN lower(COALESCE(cu2.full_name,'')))>0 OR position(lower(v_query) IN lower(COALESCE(cu2.phone,'')))>0)))
      ORDER BY ct.created_at DESC NULLS LAST,ct.id LIMIT 2000) x;
  END IF;
  -- Phân trang trong ảnh chụp vừa đọc; dừng sớm khi chạm trần byte (≈40 KB, đo SAU escape JSON
  -- như khi broker bọc kết quả — P3-7) để luôn lọt trần 60 KB SQL / 64 KB broker; nextOffset báo phần còn lại.
  v_total:=jsonb_array_length(v_rows);
  i:=v_offset;
  WHILE i<v_total AND jsonb_array_length(v_page)<v_limit LOOP
    v_item:=v_rows->i;
    v_size:=octet_length(to_jsonb(v_item::text)::text);
    EXIT WHEN jsonb_array_length(v_page)>0 AND v_bytes+v_size>40000;
    v_page:=v_page||jsonb_build_array(v_item); v_bytes:=v_bytes+v_size; i:=i+1;
  END LOOP;
  IF i<v_total THEN v_next:=i; END IF;
  RETURN jsonb_build_object('report',v_report,'source',v_spec->>'source','unavailable',NULL,'summary',v_summary,'items',v_page,
    'offset',v_offset,'nextOffset',v_next,'sourceCapped',v_capped);
END $fn$;

ALTER FUNCTION app_private.hermes_report_catalog_v1(text,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_report_read_v2(text,jsonb,uuid,uuid[],boolean,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_report_catalog_v1(text,text),app_private.hermes_report_read_v2(text,jsonb,uuid,uuid[],boolean,boolean)
  FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
COMMIT;
NOTIFY pgrst,'reload schema';
