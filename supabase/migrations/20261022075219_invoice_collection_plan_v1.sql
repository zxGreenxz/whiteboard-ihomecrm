-- Kế hoạch THU TIỀN một hoá đơn — hàm dùng chung MỚI giữa web và trợ lý (luật 17/10; docs/plans/hermes-crm/HOA-DON-THAO-TAC-GHI.md mục 6.1,
-- Mốc 3, 22/10/2026). Thay dần công thức client src/lib/collectPlan.ts + collectionSettlement.ts (+ deriveOverpayPolicy),
-- deriveInvoiceDepositDue (paymentRecordRpc.ts), duplicateCollection.ts và luật chọn sổ thối theo 2 ID viết cứng của changeAccounts.ts.
-- Web CHƯA chuyển sang (Mốc 3b nếu phiên chính duyệt, HDN3); record_invoice_collection_v5 vẫn là trọng tài cuối, hàm này chỉ đọc.
--  (1) public.invoice_collection_plan_core_v1(p_input jsonb) IMMUTABLE: phép tính THUẦN trên dữ kiện đưa vào (còn phải thu, các dòng
--      TM/TK/TT, cách xử lý phần dư, có HĐ, cọc còn thiếu, sổ nhận được, sổ ảo, các lần thu gần đây) — bộ vector đối chiếu với TS
--      (src/lib/__tests__/fixtures/invoice-collection-plan-vectors.json) chạy trên chính hàm này.
--  (2) public.invoice_collection_plan_v1(p_invoice_id, p_lines, p_options) STABLE INVOKER: đọc dữ kiện của MỘT hoá đơn dưới RLS người gọi
--      (hoá đơn, dòng cọc, nợ thực #267 trên các hoá đơn còn hiệu lực của phòng, sổ nhận get_receiving_cashbooks_v1, sổ ảo, sổ người gọi
--      giữ/biết list_cashbooks_for_income_v2, lần thu 30 phút qua) rồi gọi (1). Khoá web của trang theo toà như thu_tien_collection_v1:
--      can_do_on_building('thu_tien','view'). Vai được gọi: authenticated (web) và chủ hàm postgres — bước ghi DEFINER của trợ lý gọi lại
--      sau khi TỰ đối chiếu id trong phạm vi khoá (auth.uid() vẫn là người hỏi; quyền giữ/biết sổ và sổ nhận đọc theo auth.uid()).
-- Luật (đúng thứ tự client hiện nay):
--   remaining = max(total − paid, 0) (định nghĩa của v5); amount trống ở dòng DUY NHẤT = đúng số còn phải thu.
--   Phần dư: overpay 'keep' ⇒ CREDIT (cần HĐ); 'refund' ⇒ REFUND (tiền mặt phải đủ phần dư); 'return' ⇒ cắt về số còn phải thu (nhánh
--   cap của planCollect: phần dư KHÔNG vào CRM); 'auto' ⇒ như planCollect mặc định (không đủ TM để thối thì giữ credit); 'reject'
--   (mặc định) ⇒ chặn overpay_needs_choice — không bao giờ tự chọn thay người dùng.
--   Làm tròn: 0 < thiếu < 10.000đ, chỉ khi hoá đơn không còn cọc phải thu (deriveInvoiceDepositDue = 0) và người gọi không tắt.
--   Sổ: TM = sổ tiền mặt riêng; TK/TT = danh sách sổ nhận của toà (mặc định phần tử đầu; accountId chỉ nhận khi nằm trong danh sách);
--   thối = sổ ảo tên kết thúc "Thối" mà người gọi giữ/biết, không có thì sổ "…Thối" đầu tiên theo tên (đo production 22/10: khớp map
--   cứng của changeAccounts.ts cho cả hai người thu có thối trong 120 ngày); làm tròn = sổ ảo "Làm tròn tiền thiếu".
--   Thu trùng: lần thu ACTIVE cùng hoá đơn, cùng tổng tiền, cách "bây giờ" ≤ 30 phút (cả hai chiều) — cảnh báo, không chặn.
-- Không ghi dữ liệu, không DROP. Idempotent (CREATE OR REPLACE).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('public.invoice_effective_outstanding_v1(uuid[])') IS NULL
    OR to_regprocedure('public.is_overdue(public.invoices)') IS NULL
    OR to_regprocedure('public.org_today_v1(uuid)') IS NULL
    OR to_regprocedure('public.can_do_on_building(text,text,uuid)') IS NULL
    OR to_regprocedure('public.get_receiving_cashbooks_v1(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('public.list_cashbooks_for_income_v2()') IS NULL THEN
    RAISE EXCEPTION 'invoice_collection_plan_dependency_invalid'; END IF;
END $requires$;

-- (1) Phép tính thuần. Đầu vào (camelCase): remaining, lines[{method TM|TK|TT, amount|null, accountId|null}], overpay, actualChange,
-- hasContract, depositDue, allowRounding, roundingThreshold; tuỳ chọn: receiving{TM,TK,TT:[{id,name}]}, virtualAccounts[{id,name,possessed}]
-- (đúng thứ tự tên), collections[{id,status,grossAmount,createdAt,collectorName}] + now. Số tiền là số nguyên VND (như cleanInt của client).
CREATE OR REPLACE FUNCTION public.invoice_collection_plan_core_v1(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  v_remaining numeric; v_lines jsonb; v_line jsonb; v_method text; v_amount numeric; v_overpay_mode text; v_has_contract boolean;
  v_deposit numeric; v_allow boolean; v_th numeric; v_actual numeric; v_tm numeric:=0; v_tk numeric:=0; v_tt numeric:=0; v_total numeric;
  v_over numeric; v_can_refund boolean; v_must_keep boolean; v_can_keep boolean; v_keep boolean:=false; v_action text:='REJECT';
  v_change numeric:=0; v_credit numeric:=0; v_retained numeric; v_applied numeric; v_shortage numeric; v_rounding numeric:=0; v_returned numeric:=0;
  v_blockers text[]:='{}'; v_pick jsonb:='{}'::jsonb; v_list jsonb; v_want text; v_change_id text; v_change_name text; v_round_id text;
  v_tenders jsonb:='[]'::jsonb; v_dup jsonb; v_now timestamptz; v_m text; v_last int; i int; v_override jsonb:='{}'::jsonb;
  v_rounding_blocked text;
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' THEN RAISE EXCEPTION 'invoice_collection_plan_invalid' USING ERRCODE='22023'; END IF;
  v_remaining:=GREATEST(round(COALESCE((p_input->>'remaining')::numeric,0)),0);
  v_lines:=COALESCE(p_input->'lines','[]'::jsonb);
  IF jsonb_typeof(v_lines)<>'array' OR jsonb_array_length(v_lines) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'invoice_collection_plan_invalid' USING ERRCODE='22023'; END IF;
  v_overpay_mode:=lower(COALESCE(NULLIF(btrim(p_input->>'overpay'),''),'reject'));
  IF v_overpay_mode NOT IN ('reject','keep','refund','return','auto') THEN RAISE EXCEPTION 'invoice_collection_plan_invalid' USING ERRCODE='22023'; END IF;
  v_has_contract:=COALESCE((p_input->>'hasContract')::boolean,false);
  v_deposit:=GREATEST(COALESCE((p_input->>'depositDue')::numeric,0),0);
  v_allow:=COALESCE((p_input->>'allowRounding')::boolean,true) AND v_deposit=0;
  v_th:=COALESCE((p_input->>'roundingThreshold')::numeric,10000);
  v_actual:=CASE WHEN jsonb_typeof(p_input->'actualChange')='number' THEN (p_input->>'actualChange')::numeric END;
  -- Dòng thu (amount trống chỉ ở dòng duy nhất = số còn phải thu).
  FOR v_line IN SELECT value FROM jsonb_array_elements(v_lines) LOOP
    v_method:=upper(btrim(COALESCE(v_line->>'method','')));
    IF v_method NOT IN ('TM','TK','TT') THEN v_blockers:=array_append(v_blockers,'invalid_method'); CONTINUE; END IF;
    v_amount:=CASE WHEN jsonb_typeof(v_line->'amount') IS DISTINCT FROM 'number' THEN CASE WHEN jsonb_array_length(v_lines)=1 THEN v_remaining ELSE 0 END
      ELSE GREATEST(round((v_line->>'amount')::numeric),0) END;
    IF v_method='TM' THEN v_tm:=v_tm+v_amount; ELSIF v_method='TK' THEN v_tk:=v_tk+v_amount; ELSE v_tt:=v_tt+v_amount; END IF;
    IF NULLIF(v_line->>'accountId','') IS NOT NULL AND v_method<>'TM' THEN v_override:=v_override||jsonb_build_object(v_method,v_line->>'accountId'); END IF;
  END LOOP;
  v_total:=v_tm+v_tk+v_tt;
  IF cardinality(v_blockers)=0 AND v_total<=0 THEN
    v_blockers:=array_append(v_blockers,CASE WHEN v_remaining<=0 THEN 'nothing_to_collect' ELSE 'invalid_amount' END); END IF;
  v_over:=GREATEST(v_total-v_remaining,0);
  v_can_refund:=v_over>0 AND v_tm>=v_over; v_must_keep:=v_over>0 AND NOT v_can_refund; v_can_keep:=v_over>0 AND v_has_contract;
  IF cardinality(v_blockers)=0 AND v_overpay_mode='return' THEN
    -- Nhánh cap của planCollect: cắt tổng về số còn phải thu, không thối, không credit.
    IF v_total>v_remaining THEN
      v_returned:=v_total-v_remaining;
      IF v_tm>0 THEN v_tm:=v_remaining; v_tk:=0; v_tt:=0; ELSIF v_tk>0 THEN v_tk:=v_remaining; v_tt:=0; ELSE v_tt:=v_remaining; END IF;
      v_total:=v_remaining;
    END IF;
    v_retained:=v_total; v_applied:=LEAST(v_total,v_remaining);
    IF v_applied<=0 THEN v_blockers:=array_append(v_blockers,'nothing_to_collect'); END IF;
  ELSIF cardinality(v_blockers)=0 THEN
    IF v_over>0 THEN
      IF v_overpay_mode='reject' THEN v_blockers:=array_append(v_blockers,'overpay_needs_choice');
      ELSIF v_overpay_mode='refund' AND v_must_keep THEN v_blockers:=array_append(v_blockers,'refund_requires_cash');
      ELSIF v_overpay_mode='keep' OR (v_overpay_mode='auto' AND v_must_keep) THEN v_keep:=true;
      END IF;
    END IF;
    IF cardinality(v_blockers)=0 AND v_keep AND NOT v_has_contract THEN v_blockers:=array_append(v_blockers,'credit_requires_contract'); END IF;
    IF cardinality(v_blockers)=0 THEN
      -- collectionSettlement.
      v_action:=CASE WHEN v_keep THEN 'CREDIT' WHEN COALESCE(v_actual,v_over)>0 THEN 'REFUND' ELSE 'REJECT' END;
      IF v_actual IS NOT NULL AND ((v_action<>'REFUND' AND NOT (v_action='REJECT' AND v_actual=0)) OR v_actual<0 OR round(v_actual,2)<>v_actual) THEN
        v_blockers:=array_append(v_blockers,'invalid_change');
      ELSIF v_action='REFUND' THEN
        v_change:=COALESCE(v_actual,v_over);
        IF v_change<v_over THEN v_blockers:=array_append(v_blockers,'invalid_change');
        ELSIF v_change>v_tm THEN v_blockers:=array_append(v_blockers,'refund_requires_cash');
        ELSIF v_change<=0 THEN v_blockers:=array_append(v_blockers,'invalid_change'); END IF;
      ELSIF v_action='CREDIT' THEN v_credit:=v_over;
      END IF;
      v_retained:=v_total-v_change; v_applied:=LEAST(v_retained-v_credit,v_remaining);
      IF cardinality(v_blockers)=0 AND v_applied<=0 THEN v_blockers:=array_append(v_blockers,'nothing_to_collect'); END IF;
    END IF;
  END IF;
  IF cardinality(v_blockers)=0 THEN
    v_shortage:=GREATEST(v_remaining-v_applied,0);
    v_rounding:=CASE WHEN v_allow AND v_shortage>0 AND v_shortage<v_th THEN v_shortage ELSE 0 END;
    IF v_rounding=0 AND v_shortage>0 AND v_shortage<v_th THEN
      v_rounding_blocked:=CASE WHEN v_deposit>0 THEN 'deposit_due' ELSE 'disabled' END; END IF;
  END IF;
  -- Sổ (chỉ khi người gọi đưa danh sách sổ nhận).
  IF cardinality(v_blockers)=0 AND p_input ? 'receiving' THEN
    FOREACH v_m IN ARRAY ARRAY['TM','TK','TT'] LOOP
      CONTINUE WHEN (CASE v_m WHEN 'TM' THEN v_tm WHEN 'TK' THEN v_tk ELSE v_tt END)<=0;
      v_list:=COALESCE(p_input->'receiving'->v_m,'[]'::jsonb);
      IF jsonb_typeof(v_list)<>'array' OR jsonb_array_length(v_list)=0 THEN v_blockers:=array_append(v_blockers,'receiving_book_missing'); CONTINUE; END IF;
      v_want:=v_override->>v_m;
      v_pick:=v_pick||jsonb_build_object(v_m,COALESCE((SELECT b FROM jsonb_array_elements(v_list) b WHERE b->>'id'=v_want LIMIT 1),v_list->0));
    END LOOP;
    IF v_change>0 THEN
      SELECT a->>'id',a->>'name' INTO v_change_id,v_change_name FROM jsonb_array_elements(COALESCE(p_input->'virtualAccounts','[]'::jsonb)) WITH ORDINALITY x(a,o)
        WHERE btrim(a->>'name') LIKE '%Thối' ORDER BY COALESCE((a->>'possessed')::boolean,false) DESC,o LIMIT 1;
      IF v_change_id IS NULL THEN v_blockers:=array_append(v_blockers,'change_book_missing'); END IF;
    END IF;
    IF v_rounding>0 THEN
      SELECT a->>'id' INTO v_round_id FROM jsonb_array_elements(COALESCE(p_input->'virtualAccounts','[]'::jsonb)) WITH ORDINALITY x(a,o)
        WHERE btrim(a->>'name')='Làm tròn tiền thiếu' ORDER BY o LIMIT 1;
      IF v_round_id IS NULL THEN v_blockers:=array_append(v_blockers,'rounding_book_missing'); END IF;
    END IF;
    IF cardinality(v_blockers)=0 THEN
      -- Khuôn p_tenders của record_invoice_collection_v5: một dòng mỗi hình thức có tiền (TM, TK, TT); thối gắn dòng TM; làm tròn ở dòng cuối.
      SELECT count(*) INTO v_last FROM unnest(ARRAY[v_tm,v_tk,v_tt]) a WHERE a>0;
      i:=0;
      FOREACH v_m IN ARRAY ARRAY['TM','TK','TT'] LOOP
        CONTINUE WHEN (CASE v_m WHEN 'TM' THEN v_tm WHEN 'TK' THEN v_tk ELSE v_tt END)<=0;
        i:=i+1;
        v_tenders:=v_tenders||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('payment_method',v_m,
          'gross_amount',CASE v_m WHEN 'TM' THEN v_tm WHEN 'TK' THEN v_tk ELSE v_tt END,'account_id',v_pick->v_m->>'id',
          'change_account_id',CASE WHEN v_m='TM' AND v_change>0 THEN v_change_id END,
          'requested_change_amount',CASE WHEN v_m='TM' AND v_actual IS NOT NULL AND v_action='REFUND' THEN v_actual END,
          'rounding_account_id',CASE WHEN i=v_last AND v_rounding>0 THEN v_round_id END)));
      END LOOP;
    END IF;
  END IF;
  -- Thu trùng (duplicateCollection.ts): lần thu ACTIVE gần nhất cùng tổng tiền trong 30 phút quanh now.
  IF jsonb_typeof(p_input->'collections')='array' AND v_total>0 THEN
    v_now:=COALESCE((p_input->>'now')::timestamptz,'epoch'::timestamptz);
    SELECT c INTO v_dup FROM jsonb_array_elements(p_input->'collections') c
      WHERE c->>'status'='ACTIVE' AND round((c->>'grossAmount')::numeric)=round(v_total)
        AND abs(extract(epoch FROM (v_now-(c->>'createdAt')::timestamptz)))<=1800
      ORDER BY (c->>'createdAt')::timestamptz DESC LIMIT 1;
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('ok',cardinality(v_blockers)=0,'blockers',to_jsonb(v_blockers),'remaining',v_remaining,
    'gross',v_total,'amountTm',v_tm,'amountTk',v_tk,'amountTt',v_tt,'overpay',v_over,
    'policy',jsonb_build_object('canRefund',v_can_refund,'mustKeep',v_must_keep,'canKeep',v_can_keep),
    'overpayAction',CASE WHEN cardinality(v_blockers)=0 THEN v_action END,'change',v_change,'credit',v_credit,
    'retained',CASE WHEN cardinality(v_blockers)=0 THEN v_retained END,'applied',CASE WHEN cardinality(v_blockers)=0 THEN v_applied END,
    'shortage',CASE WHEN cardinality(v_blockers)=0 THEN v_shortage END,'rounding',v_rounding,'returned',v_returned,
    'allowRounding',v_allow,'roundingBlocked',v_rounding_blocked,
    'accounts',CASE WHEN p_input ? 'receiving' THEN v_pick||jsonb_strip_nulls(jsonb_build_object('change',v_change_id,'changeName',v_change_name,'rounding',v_round_id)) END,
    'tenders',CASE WHEN p_input ? 'receiving' AND cardinality(v_blockers)=0 THEN v_tenders END,
    'duplicate',v_dup));
END $fn$;

-- (2) Kế hoạch cho MỘT hoá đơn. p_lines như (1); p_options: {overpay, actualChange, allowRounding, collectionDate, collectorUserId}.
-- Trả kết quả (1) + dữ kiện hoá đơn + cảnh báo/chặn của hoá đơn (not_found, not_collectible, debt_carried, overdue, future_date, old_date,
-- possible_duplicate). after = ƯỚC TÍNH (recompute của v5 mới là số thật; bản xem trước của trợ lý lấy số sau từ chạy thử v5).
CREATE OR REPLACE FUNCTION public.invoice_collection_plan_v1(p_invoice_id uuid,p_lines jsonb,p_options jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  i public.invoices; v_opt jsonb:=COALESCE(p_options,'{}'::jsonb); v_today date; v_date date; v_deposit numeric; v_remaining numeric;
  v_eff record; v_receiving jsonb; v_virtual jsonb; v_collections jsonb; v_core jsonb; v_blockers jsonb; v_warnings jsonb:='[]'::jsonb;
  v_paid_after numeric; v_left_after numeric;
BEGIN
  IF current_user NOT IN ('authenticated','postgres') OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'invoice_collection_plan_requires_authenticated' USING ERRCODE='42501'; END IF;
  IF p_invoice_id IS NULL OR jsonb_typeof(v_opt)<>'object' THEN RAISE EXCEPTION 'invoice_collection_plan_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO i FROM public.invoices x WHERE x.id=p_invoice_id AND x.deleted_at IS NULL;
  IF NOT FOUND OR NOT COALESCE(public.can_do_on_building('thu_tien','view',i.building_id),false) THEN
    RETURN jsonb_build_object('ok',false,'blockers',jsonb_build_array('not_found'),'invoiceId',p_invoice_id); END IF;
  v_today:=public.org_today_v1(i.organization_id);
  v_date:=COALESCE((v_opt->>'collectionDate')::date,v_today);
  v_remaining:=GREATEST(COALESCE(i.total_amount,0)-COALESCE(i.paid_amount,0),0);
  -- Cọc còn phải thu (deriveInvoiceDepositDue): dòng DEPOSIT hoặc dòng OTHER "tiền cọc" + nguồn nợ cũ loại cọc.
  SELECT COALESCE(sum(it.amount) FILTER (WHERE it.accounting_class='DEPOSIT' OR (it.type::text='OTHER' AND lower(btrim(it.description))='tiền cọc')),0)
    INTO v_deposit FROM public.invoice_items it WHERE it.invoice_id=i.id;
  v_deposit:=GREATEST(v_deposit+COALESCE((SELECT sum((s->>'amount')::numeric) FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(i.previous_debt_sources)='array' THEN i.previous_debt_sources ELSE '[]'::jsonb END) s WHERE s->>'type'='deposit'),0),0);
  -- Nợ thực (#267) trên các hoá đơn còn hiệu lực của phòng: nợ đã kéo sang hoá đơn sau (carried_out) ⇒ thu ở hoá đơn sau.
  SELECT e.effective_outstanding,e.carried_out_amount,e.carried_in_amount INTO v_eff
    FROM public.invoice_effective_outstanding_v1(ARRAY(SELECT x.id FROM public.invoices x WHERE x.organization_id=i.organization_id
      AND x.room_id=i.room_id AND x.deleted_at IS NULL AND x.status::text NOT IN ('CANCELLED','DRAFT'))) e WHERE e.invoice_id=i.id;
  v_receiving:=public.get_receiving_cashbooks_v1(i.organization_id,i.building_id,NULLIF(v_opt->>'collectorUserId','')::uuid);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'possessed',EXISTS(SELECT 1 FROM public.list_cashbooks_for_income_v2() h WHERE h.id=a.id))
      ORDER BY a.name,a.id),'[]'::jsonb) INTO v_virtual
    FROM public.accounts a WHERE a.organization_id=i.organization_id AND a.deleted_at IS NULL AND COALESCE(a.is_virtual,false);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'status',c.status,'grossAmount',c.gross_amount,'createdAt',c.created_at,
      'collectorName',(SELECT p.full_name FROM public.profiles p WHERE p.id=c.actor_id))),'[]'::jsonb) INTO v_collections
    FROM public.invoice_payment_collections c WHERE c.invoice_id=i.id AND c.status='ACTIVE' AND c.created_at>now()-interval '31 minutes';
  v_core:=public.invoice_collection_plan_core_v1(jsonb_build_object('remaining',v_remaining,'lines',p_lines,'overpay',v_opt->'overpay',
    'actualChange',v_opt->'actualChange','hasContract',i.contract_id IS NOT NULL,'depositDue',v_deposit,
    'allowRounding',COALESCE((v_opt->>'allowRounding')::boolean,true),
    'receiving',jsonb_build_object('TM',CASE WHEN v_receiving->'personalCashBook' IS NULL OR jsonb_typeof(v_receiving->'personalCashBook')='null' THEN '[]'::jsonb
      ELSE jsonb_build_array(v_receiving->'personalCashBook') END,'TK',COALESCE(v_receiving->'TK','[]'::jsonb),'TT',COALESCE(v_receiving->'TT','[]'::jsonb)),
    'virtualAccounts',v_virtual,'collections',v_collections,'now',now()));
  v_blockers:=COALESCE(v_core->'blockers','[]'::jsonb);
  IF i.status::text NOT IN ('APPROVED','PARTIAL_PAID','OVERDUE') THEN
    v_blockers:=jsonb_build_array(CASE WHEN i.status::text='PAID' THEN 'nothing_to_collect' ELSE 'not_collectible' END);
  ELSIF v_remaining<=0 THEN v_blockers:=jsonb_build_array('nothing_to_collect');
  END IF;
  IF v_date>v_today THEN v_blockers:=v_blockers||jsonb_build_array('future_date'); END IF;
  IF COALESCE(v_eff.carried_out_amount,0)>0 THEN
    v_warnings:=v_warnings||jsonb_build_array(jsonb_build_object('code','debt_carried','amount',v_eff.carried_out_amount)); END IF;
  IF COALESCE(public.is_overdue(i),false) THEN
    v_warnings:=v_warnings||jsonb_build_array(jsonb_build_object('code','overdue','days',v_today-i.due_date)); END IF;
  IF v_date<v_today-7 THEN v_warnings:=v_warnings||jsonb_build_array(jsonb_build_object('code','old_date','days',v_today-v_date)); END IF;
  IF v_core ? 'duplicate' THEN v_warnings:=v_warnings||jsonb_build_array(jsonb_build_object('code','possible_duplicate',
    'grossAmount',v_core->'duplicate'->'grossAmount','createdAt',v_core->'duplicate'->'createdAt','collectorName',v_core->'duplicate'->'collectorName')); END IF;
  IF v_core->>'roundingBlocked'='deposit_due' THEN v_warnings:=v_warnings||jsonb_build_array(jsonb_build_object('code','rounding_deposit_due',
    'shortage',v_core->'shortage')); END IF;
  IF jsonb_array_length(v_blockers)=0 THEN
    v_paid_after:=COALESCE(i.paid_amount,0)+(v_core->>'applied')::numeric;
    v_left_after:=GREATEST(COALESCE(i.total_amount,0)-v_paid_after-(v_core->>'rounding')::numeric,0);
  END IF;
  RETURN v_core||jsonb_strip_nulls(jsonb_build_object('ok',jsonb_array_length(v_blockers)=0,'blockers',v_blockers,'warnings',v_warnings,
    'invoiceId',i.id,'organizationId',i.organization_id,'buildingId',i.building_id,'roomId',i.room_id,'contractId',i.contract_id,
    'invoiceNumber',i.invoice_number,'billingMonth',i.billing_month,'kind',i.kind,'status',i.status::text,'dueDate',i.due_date,
    'total',COALESCE(i.total_amount,0),'paid',COALESCE(i.paid_amount,0),'depositDue',v_deposit,
    'effectiveOutstanding',COALESCE(v_eff.effective_outstanding,v_remaining),'carriedOut',COALESCE(v_eff.carried_out_amount,0),
    'carriedIn',COALESCE(v_eff.carried_in_amount,0),'isOverdue',COALESCE(public.is_overdue(i),false),
    'updatedAt',i.updated_at,'adjustmentRevision',i.adjustment_revision,'collectionDate',v_date,'today',v_today,
    'after',CASE WHEN jsonb_array_length(v_blockers)=0 THEN jsonb_build_object('paid',v_paid_after,'remaining',v_left_after,
      'status',CASE WHEN v_left_after<=0 THEN 'PAID' ELSE 'PARTIAL_PAID' END) END));
END $fn$;

ALTER FUNCTION public.invoice_collection_plan_core_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION public.invoice_collection_plan_v1(uuid,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.invoice_collection_plan_core_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.invoice_collection_plan_v1(uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.invoice_collection_plan_core_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_collection_plan_v1(uuid,jsonb,jsonb) TO authenticated;

DO $check$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.invoice_collection_plan_core_v1(jsonb)'::regprocedure AND NOT prosecdef AND provolatile='i')
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.invoice_collection_plan_v1(uuid,jsonb,jsonb)'::regprocedure AND NOT prosecdef AND provolatile='s')
    OR has_function_privilege('anon','public.invoice_collection_plan_v1(uuid,jsonb,jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.invoice_collection_plan_core_v1(jsonb)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.invoice_collection_plan_v1(uuid,jsonb,jsonb)','EXECUTE')
    OR public.invoice_collection_plan_core_v1('{"remaining":3650000,"lines":[{"method":"TK","amount":3645000}]}')->>'rounding'<>'5000'
    OR public.invoice_collection_plan_core_v1('{"remaining":3650000,"lines":[{"method":"TK","amount":3700000}]}')->'blockers'<>'["overpay_needs_choice"]'::jsonb
    OR public.invoice_collection_plan_core_v1('{"remaining":3650000,"lines":[{"method":"TK","amount":null}],"depositDue":1}')->>'applied'<>'3650000' THEN
    RAISE EXCEPTION 'invoice_collection_plan_catalog_invalid'; END IF;
END $check$;
COMMIT;
