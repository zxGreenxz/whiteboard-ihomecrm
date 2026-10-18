-- Hermes đọc đầy đủ — ĐỢT 2, Gói A, sau phát hành (19/10/2026): phiếu cọc giữ chỗ (reservation_vouchers) đọc ĐÚNG tập phiếu web
-- thấy (nguyên tắc chủ dự án: Hermes đọc theo đúng quyền của người dùng trên web). Áp SAU toàn bộ đợt 2 (Gói A 010000/010100,
-- Gói Z 080100, công tắc 090000). Không DROP, không đổi chữ ký/kiểu trả về, không GRANT/REVOKE (CREATE OR REPLACE giữ ACL:
-- hàm dùng chung theo 010000, hàm đọc gói theo nền 000600), không ghi dữ liệu.
-- Web (/deposits, useDeposits.ts useReservationDeposits + RPC get_reservation_deposit_summary, vùng hermes-parity
-- deposit-reservation-vouchers): RequirePermission module="deposits" KHÔNG truyền toà (khoá trang ở ít nhất một toà), rồi đọc
-- income_expenses dưới RLS — gồm cả policy sổ quỹ (phiếu vào sổ quỹ người dùng giữ), không giao thêm theo toà.
--  1. public.deposit_reservation_vouchers_v1: bỏ giao toà theo can_do_on_building('deposits','view') (chặt hơn web); thay bằng
--     khoá trang như route web (public.can_access_org_entity('deposits','view'): super admin hoặc deposits.view ở bất kỳ phạm vi
--     nào), tập phiếu do RLS income_expenses của người gọi quyết. Giữ: INVOKER, search_path='', từ chối vai khác authenticated /
--     auth.uid() NULL, lọc công ty tường minh, p_building_ids chỉ thu hẹp (NULL = toàn phạm vi RLS, '{}' = rỗng), đúng bộ lọc web.
--  2. app_private.hermes_w2a_read_v1 (thân = 20261018080100, đổi đúng MỘT chỗ): báo cáo reservation_vouchers dùng nguyên
--     ctx.buildings, không giao thêm toà buildings.view (accessible_building_ids) — phiếu vào sổ quỹ ở toà người hỏi không có
--     buildings.view vẫn thấy như web. Mọi báo cáo khác giữ giao toà như cũ.
-- Giữ nguyên: ctx.buildings (= toà có deposits.view của người hỏi ∩ phạm vi kết nối) chỉ thu hẹp, bước kết thúc của cổng chặn
-- mọi hàng có buildingId ngoài ctx.buildings ⇒ phiếu web hiện ở toà ngoài ctx.buildings (toà người hỏi không có deposits.view
-- hoặc ngoài phạm vi kết nối) Hermes KHÔNG trả. Tên phiếu / người nộp vẫn NULL (rào PII Gói Z: phiếu cọc giữ chỗ không nối được
-- hồ sơ khách dưới RLS người hỏi); ô tìm chỉ theo mã phiếu và tên phòng; trần 2000 hàng, tổng trên toàn nguồn (RPC web với đúng
-- danh sách toà đã giao).
-- Kiểm: infra/hermes-broker/wave2-a-coc-quy.test.mjs (sổ quỹ ở toà không có buildings.view; sổ khác; kết nối thu hẹp; toà không
-- có deposits.view; PII; tổng như web; đột biến).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('public.deposit_reservation_vouchers_v1(uuid,uuid[])') IS NULL
    OR to_regprocedure('app_private.hermes_w2a_read_v1(text,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'hermes_w2a_reservation_fund_member_requires_w2a';
  END IF;
END $requires$;

-- Phiếu cọc giữ chỗ (useReservationDeposits): phiếu thu chưa xoá, chưa gắn hợp đồng, không bị loại trừ quản lý,
-- APPROVED/UNAPPROVED/CANCELLED, có ít nhất một hạng mục cọc (is_deposit); số cọc = Σ hạng mục cọc; đã quyết toán =
-- có reservation_deposit_settlements; kỳ hạn reservation_hold_deadlines (useReservationHoldDeadlines). Web sắp
-- voucher_date giảm dần, id. Tập phiếu = RLS income_expenses của người gọi (như web), không giao toà theo khoá trang.
CREATE OR REPLACE FUNCTION public.deposit_reservation_vouchers_v1(p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL)
RETURNS TABLE(voucher_id uuid,code text,name text,payer_name text,deposit_amount numeric,voucher_date date,approval_status text,
  building_id uuid,building_name text,room_id uuid,room_name text,settled boolean,hold_until date,topup_due_date date,deposit_target numeric)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  -- Như route web (RequirePermission module="deposits", không truyền toà): khoá trang ở ít nhất một phạm vi.
  IF NOT public.can_access_org_entity('deposits','view') THEN RETURN; END IF;
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
    AND (p_building_ids IS NULL OR ie.building_id=ANY(p_building_ids));
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_w2a_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_org uuid; v_b uuid[]; v_cust uuid[]; v_today date; v_rows jsonb:='[]'::jsonb; v_total integer:=0; v_summary jsonb;
  v_status text; v_kind text; v_query text; v_from date; v_to date; v_target uuid; v_detail jsonb; v_page jsonb; v_cursor jsonb;
  v_head jsonb; v_raw jsonb; v_clean jsonb; v_inv_cust boolean; v_inv_text boolean;
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
          -- Tên phiếu / người nộp: chữ chép tên khách, không nối được hồ sơ khách dưới RLS người hỏi ⇒ NULL.
          'code',v.code,'name',NULL,
          'payerName',NULL,
          'depositAmount',v.deposit_amount::text,'voucherDate',v.voucher_date,'approvalStatus',v.approval_status,'buildingId',v.building_id,
          'buildingName',v.building_name,'roomId',v.room_id,'roomName',v.room_name,
          'settled',v.settled,'holdUntil',v.hold_until,'topupDueDate',v.topup_due_date,'depositTarget',v.deposit_target::text) item
      FROM public.deposit_reservation_vouchers_v1(v_org,v_b) v
      WHERE (v_status IS NULL OR v.approval_status=v_status)
        -- Ô tìm của web (DepositsPage.tsx:450-463) còn tìm tên phiếu/người nộp; Hermes chỉ tìm trường được trả (mã,
        -- phòng) để không dò ngược được chữ đã che.
        AND (v_query IS NULL OR position(v_query IN lower(COALESCE(v.code,'')))>0
          OR position(v_query IN lower(COALESCE(v.room_name,'')))>0)
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

ALTER FUNCTION public.deposit_reservation_vouchers_v1(uuid,uuid[]) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2a_read_v1(text,jsonb,jsonb) OWNER TO postgres;
COMMIT;
NOTIFY pgrst,'reload schema';
