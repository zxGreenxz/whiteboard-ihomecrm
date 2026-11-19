-- Hermes Gói A (Hoá đơn) — sửa theo nghiệm thu bot trang Hoá đơn (27/10/2026; docs/plans/hermes-crm/HOA-DON-THAO-TAC-GHI.md mục "Lượt H03 + F06"):
--  H03 "nhắc nợ tháng 10 các phòng còn nợ": invoice_reminders nhận thêm month (YYYY-MM) = chỉ phòng có hoá đơn kỳ đó còn nợ thực; messageText
--      và mọi số của phòng vẫn nêu TOÀN BỘ nợ của phòng (như days: chỉ chọn phòng). Trước: connector từ chối month (invalid_request), bỏ month
--      thì báo cáo trả mọi phòng nợ mọi kỳ.
--  F06 "điều chỉnh chờ kiểm lâu nhất, số trước/sau": summary.oldestPending = {invoiceNumber, buildingName, roomName, billingMonth, adjustedDate,
--      adjustedTime, beforeTotal, afterTotal, delta, revision} của điều chỉnh PENDING bản hiện hành cũ nhất theo (adjusted_at, id) trên đúng tập
--      hàng của báo cáo (phạm vi toà, phòng, status, khoảng ngày); không có ⇒ null. Bot từng tự dò danh sách xếp mới → cũ và chọn sai.
-- Dựng từ thân ĐANG CHẠY (production = TEST, đọc 27/10): hàm đọc = file 20261024160002 (md5 9e76b687f25ce5e385b72d3a94ee52d3),
-- bảng báo cáo = file 20261022051620 (md5 9ef6e5e0948091a5ae06c1b2ad790dfb); ghim ở $requires$ (md5 bỏ CR). Mọi nhánh khác giữ
-- nguyên từng chữ. Không DROP, không đổi chữ ký, không đổi ACL (CREATE OR REPLACE giữ quyền), không ghi dữ liệu. Idempotent; khối kiểm cuối
-- chỉ đọc catalog.
-- THỨ TỰ PHÁT HÀNH: connector (month của invoice_reminders + summary.oldestPending tolerant) TRƯỚC, rồi áp ngay file này. Bộ kiểm tham số
-- của nền W2 đòi ĐÚNG tập tên trong bảng báo cáo ⇒ giữa hai bước invoice_reminders trả lỗi tham số (connector mới gửi month, SQL cũ chưa
-- nhận); các báo cáo khác không ảnh hưởng. Áp file này trước connector thì invoice_reminders hỏng (connector cũ không gửi month) VÀ
-- invoice_adjustments hỏng (connector cũ kiểm khít summary, khoá lạ oldestPending) ⇒ không làm vậy.
-- Sau khi áp: 20261024160002 (ghim md5 thân hàm đọc) chạy lại đơn lẻ ném hermes_w2a_room_detail_link_dependency_invalid đúng thiết kế ⇒
-- cần ngoại lệ pinned; 20261022051620 chạy lại vẫn qua (nhận thân có invoice_room_detail) và ghi đè im lặng — như trước.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.hermes_w2a_read_v1(text,jsonb,jsonb)') IS NULL OR to_regprocedure('app_private.hermes_w2a_catalog_v1()') IS NULL
    OR to_regprocedure('public.invoice_open_debts_v1(uuid,uuid[],uuid,date)') IS NULL
    OR to_regprocedure('public.invoice_adjustments_list_v1(uuid,uuid[],uuid,text,date,date)') IS NULL THEN
    RAISE EXCEPTION 'hermes_w2a_reminders_oldest_dependency_invalid'; END IF;
  -- Thân đang chạy (production = TEST, đọc 27/10): hàm đọc = file 20261024160002, bảng báo cáo = file 20261022051620; hoặc thân của
  -- chính file này (chạy lại). md5 bỏ CR.
  IF COALESCE((SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_w2a_read_v1(text,jsonb,jsonb)'::regprocedure),'')
      NOT IN ('9e76b687f25ce5e385b72d3a94ee52d3','79b9afa72f60fde03cfbe44b20e954c2') THEN
    RAISE EXCEPTION 'hermes_w2a_reminders_oldest_body_drift: app_private.hermes_w2a_read_v1'; END IF;
  IF COALESCE((SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_w2a_catalog_v1()'::regprocedure),'')
      NOT IN ('9ef6e5e0948091a5ae06c1b2ad790dfb','53faaf62497b169ff24f49a2abc13155') THEN
    RAISE EXCEPTION 'hermes_w2a_reminders_oldest_body_drift: app_private.hermes_w2a_catalog_v1'; END IF;
END $requires$;

-- 1. Bảng báo cáo gói A (khớp W2A_REPORTS của infra/hermes-broker/wave2-a-contract.mjs; test so khớp): invoice_reminders thêm month.
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
  "reservation_vouchers":{"permission":"deposits.view","source":"crm.deposit_reservation_vouchers_v1","scope":"rls_buildings",
    "params":["buildingId","status","query"],"required":[],"statuses":["APPROVED","UNAPPROVED","CANCELLED"],"kinds":null,
    "scopeKeys":["customers.view"]},
  "reservation_settlements":{"permission":"deposits.view","source":"crm.get_reservation_settlements_v1","scope":"rows",
    "params":["buildingId","status"],"required":[],"statuses":["PENDING","PAID","NOT_REQUIRED"],"kinds":null,"scopeKeys":["customers.view"]},
  "held_deposits":{"permission":"deposits.view","source":"crm.deposit_held_contracts_v1","scope":"rows",
    "params":["buildingId","status"],"required":[],"statuses":["FULL","SHORT","FIRST_INVOICE"],"kinds":null,"scopeKeys":["customers.view"]},
  "deposit_refunds":{"permission":"deposits.view","source":"crm.deposit_refunds_forfeits_v1","scope":"rows",
    "params":["buildingId","kind"],"required":[],"statuses":null,"kinds":["REFUND","FORFEIT"],"scopeKeys":["customers.view"]},
  "change_ledger":{"permission":"deposits.view","source":"crm.cashbook_change_ledger_v1","scope":"rows",
    "params":["cashbookId","fromDate","toDate"],"required":["cashbookId"],"statuses":null,"kinds":null,"scopeKeys":["customers.view"]},
  "invoice_room_detail":{"permission":"invoices.view","source":"crm.invoice_room_invoices_v1","scope":"rows",
    "params":["roomId","month"],"required":["roomId"],"statuses":null,"kinds":null,"scopeKeys":["customers.view"]},
  "invoice_lateness":{"permission":"invoices.view","source":"crm.invoice_lateness_v1","scope":"rows",
    "params":["buildingId","roomId","fromDate","toDate"],"required":[],"statuses":null,"kinds":null,"scopeKeys":["customers.view"]},
  "collection_by_method":{"permission":"thu_tien.view","source":"crm.invoice_collection_by_method_v1","scope":"rows",
    "params":["month","buildingId","fromDate","toDate"],"required":[],"statuses":null,"kinds":null,"scopeKeys":["customers.view"]},
  "invoice_adjustments":{"permission":"invoices.view","source":"crm.invoice_adjustments_list_v1","scope":"rows",
    "params":["buildingId","roomId","status","fromDate","toDate"],"required":[],"statuses":["PENDING","CHECKED"],"kinds":null,"scopeKeys":["customers.view"]},
  "invoice_missing":{"permission":"invoices.view","source":"crm.invoice_missing_v1","scope":"rows",
    "params":["month","buildingId"],"required":["month"],"statuses":null,"kinds":null,"scopeKeys":["customers.view"]},
  "invoice_room_debts":{"permission":"invoices.view","source":"crm.invoice_open_debts_v1","scope":"rows",
    "params":["buildingId","roomId","days"],"required":[],"statuses":null,"kinds":null,"scopeKeys":["customers.view"]},
  "invoice_reminders":{"permission":"invoices.view","source":"crm.invoice_open_debts_v1","scope":"rows",
    "params":["buildingId","roomId","days","month"],"required":[],"statuses":null,"kinds":null,"scopeKeys":["customers.view"]}
 }'::jsonb
$fn$;

-- 2. Hàm đọc gói A: thân 20261024160002 + month của invoice_reminders + summary.oldestPending của invoice_adjustments.
CREATE OR REPLACE FUNCTION app_private.hermes_w2a_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_org uuid; v_b uuid[]; v_cust uuid[]; v_today date; v_rows jsonb:='[]'::jsonb; v_total integer:=0; v_summary jsonb;
  v_status text; v_kind text; v_query text; v_from date; v_to date; v_target uuid; v_detail jsonb; v_page jsonb; v_cursor jsonb;
  v_head jsonb; v_raw jsonb; v_clean jsonb; v_inv_cust boolean; v_inv_text boolean;
  v_month text; v_list jsonb; v_pick jsonb; v_days integer;
  -- Độ dài tối đa của từng trường chữ trong kết quả (khớp longText(n) của wave2-a-contract.mjs).
  v_limits constant jsonb:='{"buildingName":200,"roomName":100,"customerName":200,"payerName":200,"invoiceNumber":100,"contractNumber":100,
    "code":100,"voucherCode":100,"label":300,"name":300,"category":40,"status":40,"person":200,"collectors":300,"notes":1000,"kind":40,
    "billingMonth":20,"reasonCode":40,"debtMode":40,"terminationType":40,"adjustmentReviewStatus":40,"invoiceStatus":40,"approvalStatus":40,
    "reason":1000,"messageText":1000,"details":600,"months":200,"publicPath":60,"adjustedBy":200,"checkedBy":200,"adjustedTime":5,
    "topLateRooms":600,"byBuilding":600,"month":7}';
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_ctx->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  v_org:=(p_ctx->>'organizationId')::uuid;
  -- Web đọc các bảng này dưới RLS theo buildings.view (invoices/rooms/income_expenses_select_rbac:
  -- has_full_building_scope() OR building_id IN accessible_building_ids()), độc lập với khoá của trang. Khoá
  -- trang có thể rộng hơn (vd. thu_tien.view toàn công ty, buildings.view vài toà) ⇒ giao thêm để không vượt web.
  -- (19/10) reservation_vouchers: web còn hiện phiếu vào sổ quỹ người dùng giữ (policy sổ quỹ của income_expenses, không theo
  -- toà) ⇒ dùng nguyên ctx.buildings, để RLS income_expenses quyết như web.
  SELECT COALESCE(array_agg(x::uuid ORDER BY x),'{}'::uuid[]) INTO v_b FROM jsonb_array_elements_text(p_ctx->'buildings') x
    WHERE p_report='reservation_vouchers' OR public.has_full_building_scope() OR x::uuid IN (SELECT public.accessible_building_ids());
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
      -- Tên khách: toà ∈ customers.view VÀ có hồ sơ khách nhìn thấy dưới RLS, cùng công ty (customerId của
      -- invoice_detail_v1: đại diện, không thấy thì khách đầu) — tên của chính hồ sơ đã qua RLS.
      v_inv_cust:=(v_head->>'buildingId')::uuid=ANY(v_cust) AND v_head->>'customerId' IS NOT NULL;
      -- (Gói Z) Chữ tự do (ghi chú hoá đơn, tên phiếu) có thể nhắc BẤT KỲ khách nào của hợp đồng: thêm điều kiện MỌI khách
      -- của hợp đồng gắn hoá đơn đều nhìn thấy dưới RLS customers (cùng công ty). contract_customers đọc theo RLS hợp đồng
      -- (thấy HĐ ⇒ thấy mọi dòng khách của HĐ) nên đếm dòng khách = đếm dòng nối được hồ sơ. Không HĐ / không dòng khách ⇒ NULL.
      SELECT count(*)>0 AND count(*)=count(cu.id) INTO v_inv_text FROM public.contract_customers cc
        LEFT JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=v_org
        WHERE cc.contract_id=(v_head->>'contractId')::uuid;
      v_inv_text:=v_inv_cust AND COALESCE(v_inv_text,false);
      v_summary:=jsonb_build_object('found',true,'invoiceId',v_head->'id','invoiceNumber',to_jsonb(v_head->>'invoiceNumber'),
        'status',v_head->'status','kind',to_jsonb(v_head->>'kind'),
        'billingMonth',to_jsonb(v_head->>'billingMonth'),'issueDate',v_head->'issueDate','dueDate',v_head->'dueDate',
        'paidDate',v_head->'paidDate','buildingId',v_head->'buildingId','buildingName',to_jsonb(v_head->>'buildingName'),
        'roomId',v_head->'roomId','roomName',to_jsonb(v_head->>'roomName'),
        'contractNumber',to_jsonb(v_head->>'contractNumber'),
        'customerName',CASE WHEN v_inv_cust THEN to_jsonb(v_head->>'customerName') ELSE 'null'::jsonb END,
        'subtotal',to_jsonb((v_head->>'subtotal')::numeric::text),'discountAmount',to_jsonb((v_head->>'discountAmount')::numeric::text),
        'previousDebt',to_jsonb((v_head->>'previousDebt')::numeric::text),'totalAmount',to_jsonb(COALESCE((v_head->>'totalAmount')::numeric,0)::text),
        'paidAmount',to_jsonb(COALESCE((v_head->>'paidAmount')::numeric,0)::text),'remainingAmount',to_jsonb(COALESCE((v_head->>'remainingAmount')::numeric,0)::text),
        'notes',CASE WHEN v_inv_text THEN to_jsonb(v_head->>'notes') ELSE 'null'::jsonb END,'adjustmentCount',v_detail->'adjustmentCount',
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
            'label',CASE WHEN v_inv_text THEN to_jsonb(e->>'name') ELSE 'null'::jsonb END,'category',to_jsonb(e->>'type'),
            'amount',to_jsonb(COALESCE((e->>'amount')::numeric,0)::text),'unitPrice',NULL,'quantity',NULL,'date',e->'voucherDate','endDate',NULL,
            'status',to_jsonb(e->>'approvalStatus'),'person',to_jsonb(e->>'creatorName'),
            'previousReading',NULL,'currentReading',NULL)
          FROM jsonb_array_elements(v_detail->'vouchers') WITH ORDINALITY a(e,n)) l;
    END IF;

  ELSIF p_report='reservation_vouchers' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.o),'[]'::jsonb),COALESCE(max(x.total),0) INTO v_rows,v_total FROM (
      SELECT row_number() OVER (ORDER BY v.voucher_date DESC,v.voucher_id) o,count(*) OVER () total,jsonb_build_object('voucherId',v.voucher_id,
          'organizationId',(SELECT src.organization_id FROM public.income_expenses src WHERE src.id=v.voucher_id),
          -- Copied voucher fields belong to the voucher RLS source, not a customer JOIN.
          -- Explicit Hermes/company customer exclusions still suppress them.
          'code',v.code,'name',CASE WHEN p_ctx->'allowCopiedCustomerText'='true'::jsonb THEN v.name END,
          'payerName',CASE WHEN p_ctx->'allowCopiedCustomerText'='true'::jsonb THEN v.payer_name END,
          'depositAmount',v.deposit_amount::text,'voucherDate',v.voucher_date,'approvalStatus',v.approval_status,'buildingId',v.building_id,
          'buildingName',v.building_name,'roomId',v.room_id,'roomName',v.room_name,
          'settled',v.settled,'holdUntil',v.hold_until,'topupDueDate',v.topup_due_date,'depositTarget',v.deposit_target::text) item
      FROM public.deposit_reservation_vouchers_v1(v_org,v_b) v
      WHERE (v_status IS NULL OR v.approval_status=v_status)
        -- Search follows exactly the copied fields returned under the same intent flag.
        AND (v_query IS NULL OR position(v_query IN lower(COALESCE(v.code,'')))>0
          OR position(v_query IN lower(COALESCE(v.room_name,'')))>0
          OR p_ctx->'allowCopiedCustomerText'='true'::jsonb AND (position(v_query IN lower(COALESCE(v.name,'')))>0 OR position(v_query IN lower(COALESCE(v.payer_name,'')))>0))
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
        -- Người nộp của phiếu cọc nguồn: không nối được hồ sơ khách dưới RLS người hỏi ⇒ NULL.
        'payerName',NULL,
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
          'payerName',CASE WHEN k.linked THEN l.payer_name END,
          'amount',l.amount::text,'totalAmount',COALESCE(l.total_amount,0)::text,
          'notes',CASE WHEN k.linked THEN l.notes END) item
      FROM public.cashbook_change_ledger_v1(v_org,v_target,v_from,v_to,v_b) l
      -- Người nộp / ghi chú: phiếu nối tới hợp đồng (contract_id, hoặc hoá đơn → contract_id), toà ∈ customers.view và
      -- (Gói Z) MỌI khách của hợp đồng đó nhìn thấy dưới RLS customers, cùng công ty (một bảng một lần trong câu: đếm dòng
      -- khách = đếm dòng nối được hồ sơ); không nối được / có khách bị ẩn ⇒ NULL.
      CROSS JOIN LATERAL (SELECT l.building_id=ANY(v_cust) AND COALESCE((
          SELECT count(*)>0 AND count(*)=count(cu.id)
          FROM public.income_expenses src LEFT JOIN public.invoices inv ON inv.id=src.invoice_id
            JOIN public.contract_customers cc ON cc.contract_id=COALESCE(src.contract_id,inv.contract_id)
            LEFT JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=v_org
          WHERE src.id=l.voucher_id),false) linked) k) x;

  ELSIF p_report='invoice_room_detail' THEN
    -- (a)(b) Hoá đơn của MỘT phòng theo kỳ (mặc định tháng của hôm nay). Hoá đơn chính = kỳ đó, MONTHLY trước quyết toán
    -- (invoice_room_invoices_v1); đầu + dòng + lần thu của đúng invoice_detail_v1 (như trang chi tiết), thêm hạn/quá hạn/nợ thực.
    v_target:=(p_params->>'roomId')::uuid;
    v_month:=COALESCE(p_params->>'month',to_char(v_today,'YYYY-MM'));
    SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.row_no),'[]'::jsonb) INTO v_list
      FROM public.invoice_room_invoices_v1(v_org,v_target,v_month,v_b,v_today) x;
    v_pick:=v_list->0;
    v_detail:=CASE WHEN v_pick IS NULL THEN NULL ELSE public.invoice_detail_v1(v_org,(v_pick->>'invoice_id')::uuid,v_b) END;
    v_head:=v_detail->'invoice';
    IF v_detail IS NULL OR NOT((v_head->>'buildingId')::uuid=ANY(v_b)) THEN
      v_summary:=jsonb_build_object('found',false,'invoiceId',NULL,'invoiceNumber',NULL,'status',NULL,'billingMonth',to_jsonb(v_month),'issueDate',NULL,
        'dueDate',NULL,'paidDate',NULL,'isOverdue',false,'overdueDays',NULL,'buildingId',NULL,'buildingName',NULL,'roomId',NULL,'roomName',NULL,
        'customerName',NULL,'totalAmount',NULL,'paidAmount',NULL,'remainingAmount',NULL,'effectiveOutstanding',NULL,'carriedOutAmount',NULL,
        'otherInvoices',0,'publicPath',NULL);
    ELSE
      -- Tên khách: như invoice_detail (toà ∈ customers.view VÀ hồ sơ khách nhìn thấy dưới RLS, cùng công ty).
      v_inv_cust:=(v_head->>'buildingId')::uuid=ANY(v_cust) AND v_head->>'customerId' IS NOT NULL;
      v_summary:=jsonb_build_object('found',true,'invoiceId',v_head->'id','invoiceNumber',to_jsonb(v_head->>'invoiceNumber'),'status',v_head->'status',
        'billingMonth',to_jsonb(v_head->>'billingMonth'),'issueDate',v_head->'issueDate','dueDate',v_head->'dueDate','paidDate',v_head->'paidDate',
        'isOverdue',COALESCE(v_pick->'is_overdue','false'::jsonb),'overdueDays',v_pick->'overdue_days',
        'buildingId',v_head->'buildingId','buildingName',to_jsonb(v_head->>'buildingName'),'roomId',v_head->'roomId','roomName',to_jsonb(v_head->>'roomName'),
        'customerName',CASE WHEN v_inv_cust THEN to_jsonb(v_head->>'customerName') ELSE 'null'::jsonb END,
        'totalAmount',to_jsonb(COALESCE((v_head->>'totalAmount')::numeric,0)::text),'paidAmount',to_jsonb(COALESCE((v_head->>'paidAmount')::numeric,0)::text),
        'remainingAmount',to_jsonb(COALESCE((v_head->>'remainingAmount')::numeric,0)::text),
        'effectiveOutstanding',to_jsonb((v_pick->>'effective_outstanding')::numeric::text),
        'carriedOutAmount',to_jsonb((v_pick->>'carried_out_amount')::numeric::text),'otherInvoices',jsonb_array_length(v_list)-1,
        -- Lượt 12 Hợp đồng (nghiệm thu C3 24/10): link tra cứu công khai gửi khách = /c/<mã> của HĐ của hoá đơn, đúng luật nút QR web (mã
        -- 6–8 chữ/số, HĐ không TERMINATED / DRAFT) và chỉ khi toà ∈ customers.view của kết nối (trang công khai hiện tên khách; như
        -- invoice_reminders). Đọc HĐ dưới RLS của người hỏi (hàm INVOKER): không thấy HĐ ⇒ null. Connector ghép origin host (publicLink).
        'publicPath',(SELECT '/c/'||k.public_code FROM public.contracts k WHERE k.id=(v_head->>'contractId')::uuid AND k.deleted_at IS NULL
          AND k.public_code ~ '^[A-Za-z0-9]{6,8}$' AND k.status::text NOT IN ('TERMINATED','DRAFT') AND (v_head->>'buildingId')::uuid=ANY(v_cust)));
      -- Dòng: khoản của hoá đơn (dòng có chỉ số kèm số tiêu thụ = cuối − đầu) rồi các lần thu (hình thức, ngày; REVERSED = đã hoàn tác).
      SELECT COALESCE(jsonb_agg(l.item ORDER BY l.k,l.n),'[]'::jsonb),count(*)::integer INTO v_rows,v_total FROM (
        SELECT 1 k,n,jsonb_build_object('kind','item','id',e->'id','organizationId',v_head->'organizationId','buildingId',v_head->'buildingId','code',NULL,
            'label',to_jsonb(e->>'description'),'category',e->'type','amount',to_jsonb(COALESCE((e->>'amount')::numeric,0)::text),
            'unitPrice',to_jsonb((e->>'unitPrice')::numeric::text),'quantity',to_jsonb((e->>'quantity')::numeric::text),
            'previousReading',to_jsonb((e->>'previousReading')::numeric::text),'currentReading',to_jsonb((e->>'currentReading')::numeric::text),
            -- Số tiêu thụ chỉ khi cuối ≥ đầu (thay công tơ / quay vòng ⇒ null, xem quantity).
            'consumption',to_jsonb(CASE WHEN (e->>'currentReading')::numeric>=(e->>'previousReading')::numeric
              THEN ((e->>'currentReading')::numeric-(e->>'previousReading')::numeric)::text END),'date',e->'fromDate','status',NULL) item
          FROM jsonb_array_elements(v_detail->'items') WITH ORDINALITY a(e,n)
        UNION ALL
        SELECT 2,n,jsonb_build_object('kind','payment','id',e->'id','organizationId',e->'organizationId','buildingId',v_head->'buildingId',
            'code',to_jsonb(e->>'receiptNumber'),'label',NULL,'category',e->'method','amount',to_jsonb(COALESCE((e->>'amount')::numeric,0)::text),
            'unitPrice',NULL,'quantity',NULL,'previousReading',NULL,'currentReading',NULL,'consumption',NULL,'date',e->'paymentDate',
            'status',to_jsonb(CASE WHEN (e->>'reversed')::boolean THEN 'REVERSED' ELSE 'ACTIVE' END))
          FROM jsonb_array_elements(v_detail->'payments') WITH ORDINALITY a(e,n)) l;
    END IF;

  ELSIF p_report='invoice_lateness' THEN
    -- (b) Ai hay đóng trễ: mỗi hoá đơn có hạn trong khoảng (mặc định 90 ngày tới hôm nay); summary gộp sẵn theo phòng (topLateRooms) để
    -- mô hình không phải tự đếm. Khoảng kẹp tối đa 366 ngày tính lùi từ toDate (cùng luật với hàm dùng chung).
    v_to:=COALESCE(v_to,v_today); v_from:=GREATEST(COALESCE(v_from,v_to-90),v_to-366);
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.days_late DESC,x.due_date,x.invoice_id),'[]'::jsonb),count(*)::integer INTO v_rows,v_total FROM (
      SELECT l.days_late,l.due_date,l.invoice_id,jsonb_build_object('invoiceId',l.invoice_id,'organizationId',l.organization_id,'invoiceNumber',l.invoice_number,
          'buildingId',l.building_id,'buildingName',bd.name,'roomId',l.room_id,'roomName',r.name,'billingMonth',l.billing_month,'dueDate',l.due_date,
          'settledDate',l.settled_date,'open',l.is_open,'late',l.days_late>0,'daysLate',l.days_late,'totalAmount',l.total_amount::text,
          'remainingAmount',l.remaining_amount::text) item
      FROM public.invoice_lateness_v1(v_org,v_b,(p_params->>'roomId')::uuid,v_from,v_to,v_today) l
      LEFT JOIN public.buildings bd ON bd.id=l.building_id LEFT JOIN public.rooms r ON r.id=l.room_id) x;
    SELECT jsonb_build_object('fromDate',v_from,'toDate',v_to,'invoiceCount',count(*)::integer,
        'lateCount',(count(*) FILTER (WHERE (e->>'late')::boolean AND NOT (e->>'open')::boolean))::integer,
        'openLateCount',(count(*) FILTER (WHERE (e->>'late')::boolean AND (e->>'open')::boolean))::integer,
        'avgDaysLate',COALESCE(round(avg((e->>'daysLate')::numeric) FILTER (WHERE (e->>'late')::boolean),1),0)::text,
        'rooms',count(DISTINCT COALESCE(e->>'roomId',e->>'invoiceId'))::integer,
        'lateRooms',(count(DISTINCT COALESCE(e->>'roomId',e->>'invoiceId')) FILTER (WHERE (e->>'late')::boolean))::integer,
        'topLateRooms',(SELECT string_agg(format('%s toà %s: %s lần trễ, trung bình %s ngày',t.room,t.building,t.n,t.avg_days),'; '
            ORDER BY t.n DESC,t.avg_days DESC,t.room)
          FROM (SELECT COALESCE(max(f->>'roomName'),'(không phòng)') room,COALESCE(max(f->>'buildingName'),'(không tên)') building,count(*) n,
              round(avg((f->>'daysLate')::numeric)) avg_days
            FROM jsonb_array_elements(v_rows) f WHERE (f->>'late')::boolean GROUP BY COALESCE(f->>'roomId',f->>'invoiceId')
            ORDER BY 3 DESC,4 DESC,1 LIMIT 10) t))
      INTO v_summary FROM jsonb_array_elements(v_rows) e;

  ELSIF p_report='collection_by_method' THEN
    -- (c) Đã thu tách theo hình thức theo NGÀY THU, như trang Thu tiền: month = cả tháng đó; không có thì fromDate/toDate; mặc định tháng
    -- của hôm nay. summary: tổng và từng hình thức.
    IF p_params->>'month' IS NOT NULL THEN
      v_from:=to_date((p_params->>'month')||'-01','YYYY-MM-DD'); v_to:=(v_from+interval '1 month - 1 day')::date;
    ELSE
      v_from:=COALESCE(v_from,date_trunc('month',COALESCE(v_to,v_today))::date);
      v_to:=COALESCE(v_to,(date_trunc('month',v_from)+interval '1 month - 1 day')::date);
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('buildingId',m.building_id,'organizationId',m.organization_id,'buildingName',bd.name,
          'method',m.payment_method,'label',CASE m.payment_method WHEN 'TM' THEN 'Tiền mặt' WHEN 'TK' THEN 'Chuyển khoản' WHEN 'TT' THEN 'Thanh toán'
            WHEN 'CT' THEN 'Cấn trừ' ELSE m.payment_method END,'paymentCount',m.payment_count,'invoiceCount',m.invoice_count,'amount',m.amount::text)
          ORDER BY bd.name,m.building_id,m.payment_method),'[]'::jsonb),count(*)::integer,
        jsonb_build_object('fromDate',v_from,'toDate',v_to,'total',COALESCE(sum(m.amount),0)::text,
          'tm',COALESCE(sum(m.amount) FILTER (WHERE m.payment_method='TM'),0)::text,'tk',COALESCE(sum(m.amount) FILTER (WHERE m.payment_method='TK'),0)::text,
          'tt',COALESCE(sum(m.amount) FILTER (WHERE m.payment_method='TT'),0)::text,'ct',COALESCE(sum(m.amount) FILTER (WHERE m.payment_method='CT'),0)::text,
          'paymentCount',COALESCE(sum(m.payment_count),0)::integer)
      INTO v_rows,v_total,v_summary
      FROM public.invoice_collection_by_method_v1(v_org,v_b,v_from,v_to) m LEFT JOIN public.buildings bd ON bd.id=m.building_id;

  ELSIF p_report='invoice_adjustments' THEN
    -- (d) Điều chỉnh hoá đơn + xác nhận kiểm tra; summary.pendingCount = điều chỉnh CHỜ KIỂM (phiên bản hiện hành, PENDING). Lý do là chữ
    -- tự do gắn hợp đồng: chỉ khi toà ∈ customers.view VÀ mọi khách của HĐ nhìn thấy dưới RLS (như ghi chú hoá đơn). Khoảng ngày mặc định
    -- và kẹp 366 ngày tới toDate (cùng luật với hàm dùng chung).
    v_to:=COALESCE(v_to,v_today); v_from:=GREATEST(COALESCE(v_from,v_to-366),v_to-366);
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.adj_at DESC,x.adj_id),'[]'::jsonb),count(*)::integer,
        jsonb_build_object('fromDate',v_from,'toDate',v_to,'count',count(*)::integer,'pendingCount',(count(*) FILTER (WHERE x.pending))::integer,
          'checkedCount',(count(*) FILTER (WHERE x.adj_status='CHECKED'))::integer,'oldestPendingDate',min(x.adj_day) FILTER (WHERE x.pending),
          'oldestPendingDays',(v_today-min(x.adj_day) FILTER (WHERE x.pending))::integer,
          -- (nghiệm thu F06) điều chỉnh CHỜ KIỂM cũ nhất theo (lúc điều chỉnh, id) trên đúng tập hàng của báo cáo (phạm vi, phòng, khoảng
          -- ngày): mô hình không tự dò danh sách xếp mới → cũ (hai mục cùng ngày 17:48 / 17:50 từng chọn sai). Chỉ các trường hàng nào cũng
          -- có (không lý do, người điều chỉnh, khách) ⇒ không thêm luật lộ dữ liệu; không có ⇒ null.
          'oldestPending',(array_agg(x.brief ORDER BY x.adj_at,x.adj_id) FILTER (WHERE x.pending))[1])
      INTO v_rows,v_total,v_summary FROM (
      SELECT a.adjusted_at adj_at,a.adjustment_id adj_id,a.review_status adj_status,COALESCE(a.review_status='PENDING' AND a.is_current,false) pending,
        (a.adjusted_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date adj_day,
        jsonb_build_object('invoiceNumber',a.invoice_number,'buildingName',bd.name,'roomName',r.name,'billingMonth',a.billing_month,
          'adjustedDate',(a.adjusted_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,'adjustedTime',to_char(a.adjusted_at AT TIME ZONE 'Asia/Ho_Chi_Minh','HH24:MI'),
          'beforeTotal',a.before_total::text,'afterTotal',a.after_total::text,'delta',a.delta::text,'revision',a.revision) brief,
        jsonb_build_object('adjustmentId',a.adjustment_id,'organizationId',a.organization_id,'invoiceId',a.invoice_id,'invoiceNumber',a.invoice_number,
          'buildingId',a.building_id,'buildingName',bd.name,'roomId',a.room_id,'roomName',r.name,'billingMonth',a.billing_month,'revision',a.revision,
          'current',COALESCE(a.is_current,false),'beforeTotal',a.before_total::text,'afterTotal',a.after_total::text,'delta',a.delta::text,
          'reason',CASE WHEN k.linked THEN a.reason END,'adjustedBy',a.adjusted_by_name,
          'adjustedDate',(a.adjusted_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,'adjustedTime',to_char(a.adjusted_at AT TIME ZONE 'Asia/Ho_Chi_Minh','HH24:MI'),
          'reviewStatus',a.review_status,'checkedBy',a.checked_by_name,'checkedDate',(a.checked_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) item
      FROM public.invoice_adjustments_list_v1(v_org,v_b,(p_params->>'roomId')::uuid,v_status,v_from,v_to) a
      LEFT JOIN public.buildings bd ON bd.id=a.building_id LEFT JOIN public.rooms r ON r.id=a.room_id
      CROSS JOIN LATERAL (SELECT a.building_id=ANY(v_cust) AND COALESCE((
          SELECT count(*)>0 AND count(*)=count(cu.id) FROM public.contract_customers cc
            LEFT JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=v_org
          WHERE cc.contract_id=a.contract_id),false) linked) k) x;
    -- Bước làm sạch cuối chỉ duyệt khoá cấp một ⇒ chữ trong đối tượng lồng oldestPending làm sạch ở đây, cùng luật và cùng độ dài.
    IF jsonb_typeof(v_summary->'oldestPending')='object' THEN
      v_summary:=jsonb_set(v_summary,'{oldestPending}',(SELECT jsonb_object_agg(e.key,CASE WHEN jsonb_typeof(e.value)='string' AND v_limits ? e.key
          THEN to_jsonb(left(btrim(regexp_replace(translate(replace(e.value#>>'{}',chr(13)||chr(10),chr(10)),chr(13)||chr(8232)||chr(8233),
            chr(10)||chr(10)||chr(10)),'[\x01-\x09\x0b-\x1f\x7f-\x9f]','','g'),' '||chr(10)),(v_limits->>e.key)::integer)) ELSE e.value END)
        FROM jsonb_each(v_summary->'oldestPending') e));
    END IF;

  ELSIF p_report='invoice_missing' THEN
    -- (e) Phòng có HĐ hiệu lực mà CHƯA có hoá đơn tháng (MONTHLY) kỳ month; summary đếm phòng theo toà.
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.bname,x.rname,x.cid),'[]'::jsonb),count(*)::integer INTO v_rows,v_total FROM (
      SELECT bd.name bname,r.name rname,m.contract_id cid,jsonb_build_object('contractId',m.contract_id,'organizationId',m.organization_id,
          'contractNumber',m.contract_number,'buildingId',m.building_id,'buildingName',bd.name,'roomId',m.room_id,'roomName',r.name,
          'customerName',CASE WHEN m.building_id=ANY(v_cust) THEN m.customer_name END,'startDate',m.start_date,'endDate',m.end_date) item
      FROM public.invoice_missing_v1(v_org,p_params->>'month',v_b) m LEFT JOIN public.buildings bd ON bd.id=m.building_id
        LEFT JOIN public.rooms r ON r.id=m.room_id) x;
    SELECT jsonb_build_object('month',p_params->>'month','rooms',count(DISTINCT e->>'roomId')::integer,
        'byBuilding',(SELECT string_agg(format('%s: %s phòng',t.b,t.n),'; ' ORDER BY t.n DESC,t.b) FROM (
          SELECT COALESCE(f->>'buildingName','(không tên)') b,count(DISTINCT f->>'roomId') n FROM jsonb_array_elements(v_rows) f GROUP BY 1) t))
      INTO v_summary FROM jsonb_array_elements(v_rows) e;

  ELSIF p_report='invoice_room_debts' THEN
    -- (f) Công nợ GỘP SẴN theo PHÒNG (nợ thực #267; số phòng phân biệt — đo nền 22/10: mô hình đếm hoá đơn thay phòng và tự cộng lệch).
    -- days = chỉ hoá đơn quá hạn ≥ N ngày ("quá hạn hơn 1 tháng" ⇒ days=31): lọc HOÁ ĐƠN trước khi gộp phòng, nên mọi số của dòng và
    -- summary (tổng nợ, số hoá đơn, tháng) chỉ cộng các hoá đơn đó — review #273: lọc theo phòng rồi cộng mọi hoá đơn mở là sai tổng.
    v_days:=(p_params->>'days')::integer;
    SELECT COALESCE(jsonb_agg(g.item ORDER BY g.debt DESC,g.bname,g.rname,g.room_key),'[]'::jsonb),count(*)::integer,
        jsonb_build_object('rooms',count(*)::integer,'invoices',COALESCE(sum(g.n),0)::integer,'debtTotal',COALESCE(sum(g.debt),0)::text,
          'overdueRooms',(count(*) FILTER (WHERE g.overdue_n>0))::integer,'overdueInvoices',COALESCE(sum(g.overdue_n),0)::integer,
          'overdueTotal',COALESCE(sum(g.overdue_debt),0)::text,'minOverdueDays',v_days)
      INTO v_rows,v_total,v_summary FROM (
      SELECT max(bd.name) bname,max(r.name) rname,COALESCE(d.room_id::text,'') room_key,count(*) n,sum(d.effective_outstanding) debt,
        count(*) FILTER (WHERE d.is_overdue) overdue_n,COALESCE(sum(d.effective_outstanding) FILTER (WHERE d.is_overdue),0) overdue_debt,
        jsonb_build_object('buildingId',d.building_id,'organizationId',(array_agg(d.organization_id))[1],'buildingName',max(bd.name),'roomId',d.room_id,
          'roomName',max(r.name),
          'customerName',CASE WHEN d.building_id=ANY(v_cust) THEN (array_agg(d.customer_name ORDER BY d.billing_month DESC,d.invoice_id))[1] END,
          'invoiceCount',count(*)::integer,'overdueInvoiceCount',(count(*) FILTER (WHERE d.is_overdue))::integer,
          'debtTotal',sum(d.effective_outstanding)::text,'overdueTotal',COALESCE(sum(d.effective_outstanding) FILTER (WHERE d.is_overdue),0)::text,
          'oldestDueDate',min(d.due_date),'maxOverdueDays',max(d.overdue_days),
          'months',string_agg(to_char(to_date(d.billing_month||'-01','YYYY-MM-DD'),'MM/YYYY'),', ' ORDER BY d.billing_month,d.invoice_id)) item
      FROM public.invoice_open_debts_v1(v_org,v_b,(p_params->>'roomId')::uuid,v_today) d
      LEFT JOIN public.buildings bd ON bd.id=d.building_id LEFT JOIN public.rooms r ON r.id=d.room_id
      WHERE v_days IS NULL OR d.overdue_days>=v_days
      GROUP BY d.building_id,d.room_id) g;

  ELSIF p_report='invoice_reminders' THEN
    -- Q18: tin nhắc nợ soạn sẵn theo PHÒNG (người dùng tự bấm gửi; không có đường tự gửi). Tổng = nợ thực gộp sẵn (đo nền 22/10: mô hình
    -- tự cộng lệch 1.000đ). publicPath = /c/<mã> của HĐ đang hiệu lực (trang công khai hiện hoá đơn MỚI NHẤT của HĐ); link tuyệt đối = địa
    -- chỉ web + publicPath (cấu hình host, D-HĐ9). Trang /c/<mã> hiện tên khách ⇒ publicPath chỉ khi toà ∈ customers.view của kết nối
    -- (hàm dùng chung đã đòi customers.view CRM ở toà; review #273). Tin không nêu tên khách; liệt kê tối đa 8 hoá đơn cũ nhất rồi "và N hoá
    -- đơn khác" để câu kết không bị cắt. days = chỉ phòng có hoá đơn quá hạn ≥ N ngày; tin vẫn nêu TOÀN BỘ nợ của phòng.
    -- (nghiệm thu H03) month (YYYY-MM, từ điển chung đã kiểm dạng) = chỉ phòng có hoá đơn KỲ ĐÓ còn nợ; như days, chỉ chọn phòng.
    v_days:=(p_params->>'days')::integer; v_month:=p_params->>'month';
    SELECT COALESCE(jsonb_agg(g.item ORDER BY g.debt DESC,g.bname,g.rname,g.room_key),'[]'::jsonb),count(*)::integer,
        jsonb_build_object('rooms',count(*)::integer,'debtTotal',COALESCE(sum(g.debt),0)::text,
          'withLink',(count(*) FILTER (WHERE g.link IS NOT NULL))::integer)
      INTO v_rows,v_total,v_summary FROM (
      SELECT h.bname,h.rname,h.room_key,h.debt,h.link,jsonb_build_object('buildingId',h.building_id,'organizationId',h.org,'buildingName',h.bname,
          'roomId',h.room_id,'roomName',h.rname,'customerName',CASE WHEN h.building_id=ANY(v_cust) THEN h.customer_name END,'debtTotal',h.debt::text,
          'invoiceCount',h.n,'oldestDueDate',h.oldest_due,'maxOverdueDays',h.max_days,'details',h.details,
          'publicPath',CASE WHEN h.link IS NOT NULL THEN '/c/'||h.link END,
          'messageText',format('Chào anh/chị, phòng %s toà %s hiện còn %sđ chưa thanh toán: %s.%s Anh/chị vui lòng thanh toán giúp. Cảm ơn anh/chị!',
            COALESCE(h.rname,'(không tên)'),COALESCE(h.bname,'(không tên)'),replace(to_char(round(h.debt),'FM999,999,999,999,990'),',','.'),h.details,
            CASE WHEN h.link IS NOT NULL THEN ' Chi tiết hoá đơn xem ở link kèm theo.' ELSE '' END)) item
      FROM (SELECT d.building_id,d.room_id,COALESCE(d.room_id::text,'') room_key,(array_agg(d.organization_id))[1] org,max(bd.name) bname,
          max(r.name) rname,count(*)::integer n,sum(d.effective_outstanding) debt,min(d.due_date) oldest_due,max(d.overdue_days) max_days,
          (array_agg(d.customer_name ORDER BY d.billing_month DESC,d.invoice_id))[1] customer_name,
          CASE WHEN d.building_id=ANY(v_cust) THEN
            (array_agg(d.public_code ORDER BY d.billing_month DESC,d.invoice_id) FILTER (WHERE d.public_code IS NOT NULL))[1] END link,
          string_agg(format('tháng %s: %sđ (hạn %s%s)',to_char(to_date(d.billing_month||'-01','YYYY-MM-DD'),'MM/YYYY'),
            replace(to_char(round(d.effective_outstanding),'FM999,999,999,999,990'),',','.'),to_char(d.due_date,'DD/MM/YYYY'),
            CASE WHEN d.is_overdue THEN ', đã quá '||d.overdue_days||' ngày' ELSE '' END),'; ' ORDER BY d.billing_month,d.invoice_id) FILTER (WHERE d.rn<=8)
            ||CASE WHEN count(*)>8 THEN format('; và %s hoá đơn khác',count(*)-8) ELSE '' END details
        FROM (SELECT o.*,row_number() OVER (PARTITION BY o.building_id,o.room_id ORDER BY o.billing_month,o.invoice_id) rn
          FROM public.invoice_open_debts_v1(v_org,v_b,(p_params->>'roomId')::uuid,v_today) o) d
        LEFT JOIN public.buildings bd ON bd.id=d.building_id LEFT JOIN public.rooms r ON r.id=d.room_id
        GROUP BY d.building_id,d.room_id
        HAVING (v_days IS NULL OR COALESCE(max(d.overdue_days),0)>=v_days)
          AND (v_month IS NULL OR COALESCE(bool_or(d.billing_month=v_month),false))) h) g;

  ELSE
    RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
  END IF;

  -- Trần 2000 hàng: cắt TOÀN BỘ phần sau 2000 (v_total đã là tổng thật ⇒ sourceCapped đúng).
  IF jsonb_array_length(v_rows)>2000 THEN
    v_rows:=(SELECT jsonb_agg(e ORDER BY n) FROM jsonb_array_elements(v_rows) WITH ORDINALITY a(e,n) WHERE n<=2000);
  END IF;
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

ALTER FUNCTION app_private.hermes_w2a_catalog_v1() OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2a_read_v1(text,jsonb,jsonb) OWNER TO postgres;

DO $check$
BEGIN
  IF (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_w2a_read_v1(text,jsonb,jsonb)'::regprocedure
        AND NOT p.prosecdef AND pg_get_userbyid(p.proowner)='postgres') IS DISTINCT FROM '79b9afa72f60fde03cfbe44b20e954c2'
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_w2a_catalog_v1()'::regprocedure
        AND p.prosecdef AND pg_get_userbyid(p.proowner)='postgres') IS DISTINCT FROM '53faaf62497b169ff24f49a2abc13155'
    OR NOT (app_private.hermes_w2a_catalog_v1()->'invoice_reminders'->'params' @> '["month"]'::jsonb) THEN
    RAISE EXCEPTION 'hermes_w2a_reminders_oldest_check_failed'; END IF;
END $check$;
COMMIT;
