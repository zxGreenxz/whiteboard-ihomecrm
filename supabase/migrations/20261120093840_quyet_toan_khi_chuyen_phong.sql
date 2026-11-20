-- Chuyển phòng và tiền của kỳ bàn giao cùng một giao dịch; biên nhận của thao tác
-- báo dọn vẫn là nguồn đối chiếu khi mất kết nối sau COMMIT.
BEGIN;

-- Cả form và writer dùng cùng quy tắc làm tròn của hóa đơn. Phiếu đã thu một
-- số tiền lẻ có thể nằm giữa hai tổng hóa đơn hợp lệ.
CREATE OR REPLACE FUNCTION app_private.room_transfer_invoice_balance_v1(p_invoice uuid,p_delta numeric,p_rent_item uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $fn$
DECLARE inv public.invoices%ROWTYPE; target numeric; refund numeric:=0; after_total numeric; items jsonb; support jsonb;
BEGIN
  IF p_invoice IS NULL THEN RETURN '{}'::jsonb; END IF;
  SELECT * INTO STRICT inv FROM public.invoices WHERE id=p_invoice AND deleted_at IS NULL;
  IF p_delta=0 THEN after_total:=inv.total_amount;
  ELSE
    target:=app_private.round_invoice_total_v1(inv.subtotal+p_delta-inv.discount_amount+inv.previous_debt);
    IF target<0 THEN RAISE EXCEPTION 'Mức giảm đã ghi vượt tiền thuê mới. Cần đối chiếu hóa đơn trước khi chuyển phòng.' USING ERRCODE='55000'; END IF;
    IF target<inv.paid_amount AND p_delta<0 THEN
      refund:=ceil(inv.paid_amount/1000)*1000-target;
      -- Hóa đơn cũ có thể được lập bằng tổng chưa làm tròn. Nếu đã thu hết thì
      -- giữ chứng từ đó và xử lý phần giảm bằng một phiếu hoàn đúng số thực thu.
      IF inv.paid_amount=inv.total_amount AND inv.total_amount IS DISTINCT FROM
        app_private.round_invoice_total_v1(inv.subtotal-inv.discount_amount+inv.previous_debt) THEN
        refund:=-p_delta;
      END IF;
    END IF;
    after_total:=CASE WHEN p_delta+refund=0 THEN inv.total_amount ELSE
      app_private.round_invoice_total_v1(inv.subtotal+p_delta+refund-inv.discount_amount+inv.previous_debt) END;
    IF after_total<inv.paid_amount OR refund>inv.paid_amount THEN
      RAISE EXCEPTION 'Số đã thu trên hóa đơn cần đối chiếu trước khi điều chỉnh tiền thuê' USING ERRCODE='55000';
    END IF;
    IF refund>0 AND refund+coalesce((SELECT sum(r.amount) FROM app_private.invoice_refund_reservations r
      WHERE r.organization_id=inv.organization_id AND r.invoice_id=inv.id AND r.reservation_state IN ('HELD','CONSUMED')),0)>inv.paid_amount THEN
      RAISE EXCEPTION 'Hóa đơn đã có khoản hoàn. Cần đối chiếu số còn được hoàn trước khi chuyển phòng.' USING ERRCODE='55000';
    END IF;
  END IF;
  IF inv.status='DRAFT' AND p_delta<>0 AND inv.rent_support_plan_revision IS NULL AND EXISTS (
    SELECT 1 FROM app_private.contract_rent_support_plans plan WHERE plan.organization_id=inv.organization_id
      AND plan.contract_id=inv.contract_id AND plan.state='ACTIVE') THEN
    RAISE EXCEPTION 'Hóa đơn nháp chưa ghi nhận kế hoạch hỗ trợ đang áp dụng. Cần đối chiếu trước khi chuyển phòng.' USING ERRCODE='55000';
  END IF;
  IF inv.status='DRAFT' AND p_delta<>0 AND inv.rent_support_plan_revision IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('accounting_class',it.accounting_class,'amount',
      it.amount+CASE WHEN it.id=p_rent_item THEN p_delta+refund ELSE 0 END)),'[]'::jsonb) INTO items
      FROM public.invoice_items it WHERE it.invoice_id=inv.id;
    IF p_rent_item IS NULL THEN
      items:=items||jsonb_build_array(jsonb_build_object('accounting_class','REVENUE','amount',p_delta+refund));
    END IF;
    support:=app_private.invoice_rent_support_quote_v1(inv.organization_id,inv.contract_id,inv.billing_month,inv.kind,
      items,inv.manual_discount_amount,inv.credit_discount_amount,inv.rent_support_plan_revision);
    IF support->>'state' IS DISTINCT FROM 'READY' OR (support->>'invoice_support')::numeric IS DISTINCT FROM inv.invoice_support_amount
       OR inv.discount_amount IS DISTINCT FROM inv.manual_discount_amount+inv.credit_discount_amount+inv.invoice_support_amount THEN
      RAISE EXCEPTION 'Khoản hỗ trợ hoặc giảm trừ trên hóa đơn nháp cần đối chiếu theo giá thuê mới.' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN jsonb_build_object('invoice_total_after',after_total,'refund_pending',refund,
    'remaining_after',greatest(after_total-inv.paid_amount,0),'support_snapshot',
    md5(jsonb_build_array(inv.rent_support_plan_revision,inv.invoice_support_amount,inv.manual_discount_amount,inv.credit_discount_amount)::text));
END $fn$;

CREATE OR REPLACE FUNCTION public.preview_room_transfer_v1(
  p_org uuid,p_contract_id uuid,p_new_room_id uuid,p_transfer_date date,
  p_new_rent_price numeric DEFAULT NULL,p_new_deposit numeric DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE source_building uuid; destination_building uuid; quote jsonb; allowed boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(p_org=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Không có quyền xem chuyển phòng tại tổ chức này' USING ERRCODE='42501';
  END IF;
  SELECT r.building_id INTO source_building FROM public.contracts c JOIN public.rooms r
    ON r.id=c.room_id AND r.organization_id=c.organization_id
    WHERE c.id=p_contract_id AND c.organization_id=p_org AND c.deleted_at IS NULL;
  SELECT a.allowed INTO allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_org,'contracts.edit',source_building,NULL) a;
  IF source_building IS NULL OR NOT coalesce(allowed,false) OR NOT coalesce(public.can_access_building(source_building),false)
     OR NOT coalesce(public.can_do_on_building('contracts','edit',source_building),false) THEN
    RAISE EXCEPTION 'Không có quyền thao tác hợp đồng tại tòa nhà này' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.require_building_perm_v1(source_building,'chuyển phòng','contracts.transfer');
  SELECT building_id INTO destination_building FROM public.rooms
    WHERE id=p_new_room_id AND organization_id=p_org AND deleted_at IS NULL;
  IF destination_building IS NULL THEN RAISE EXCEPTION 'Phòng mới không tồn tại' USING ERRCODE='22023'; END IF;
  IF destination_building<>source_building THEN
    RAISE EXCEPTION 'Phòng mới thuộc toà khác. Hãy trả phòng rồi tạo hợp đồng ở tòa mới.' USING ERRCODE='42501';
  END IF;
  quote:=app_private.quote_room_transfer_deposit_v1(p_contract_id,p_new_room_id,p_new_deposit)
       ||app_private.quote_room_transfer_rent_v1(p_org,p_contract_id,p_transfer_date,p_new_rent_price);
  IF quote->>'invoice_id' IS NOT NULL AND NOT coalesce(public.can_do_on_building('invoices','view',source_building),false) THEN
    RAISE EXCEPTION 'Cần quyền xem hóa đơn tại tòa nhà này để đối chiếu kỳ chuyển phòng.' USING ERRCODE='42501';
  END IF;
  quote:=quote||app_private.room_transfer_invoice_balance_v1((quote->>'invoice_id')::uuid,(quote->>'rent_delta')::numeric,
    (quote->>'rent_item_id')::uuid);
  RETURN quote||jsonb_build_object('quote_key',md5(jsonb_build_array(p_org,p_contract_id,p_new_room_id,p_transfer_date,quote)::text));
END $fn$;

CREATE OR REPLACE FUNCTION app_private.settle_room_transfer_invoice_v1(p_quote jsonb,p_contract_id uuid,p_date date)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  inv public.invoices%ROWTYPE; target_line uuid:=(p_quote->>'rent_item_id')::uuid;
  delta numeric:=(p_quote->>'rent_delta')::numeric; reduction_refund numeric:=0;
  line_amount numeric; document jsonb; items jsonb; subtotal_new numeric; reservation jsonb;
  request_key text:='room-transfer:'||p_contract_id::text||':'||to_char(p_date,'YYYY-MM-DD');
  reason text:='Chênh lệch tiền thuê khi chuyển phòng ngày '||to_char(p_date,'DD/MM/YYYY');
BEGIN
  IF p_quote->>'invoice_id' IS NULL OR delta=0 THEN RETURN; END IF;
  SELECT * INTO STRICT inv FROM public.invoices WHERE id=(p_quote->>'invoice_id')::uuid
    AND contract_id=p_contract_id AND deleted_at IS NULL FOR UPDATE;
  -- Chỉ giảm phần còn phải thu. Phần tiền khách đã nộp vượt được lưu bằng
  -- phiếu hoàn chờ duyệt có nguồn hóa đơn, không đảo một phiếu thu đã ghi sổ.
  reduction_refund:=(p_quote->>'refund_pending')::numeric;
  IF delta+reduction_refund<>0 THEN
    line_amount:=delta+reduction_refund;
    IF target_line IS NOT NULL THEN
      SELECT amount+delta+reduction_refund INTO STRICT line_amount FROM public.invoice_items
        WHERE id=target_line AND invoice_id=inv.id AND type='RENT';
    END IF;
    IF inv.status='DRAFT' THEN
      SELECT jsonb_agg(CASE WHEN i.id=target_line THEN to_jsonb(i)||jsonb_build_object(
        'amount',line_amount,'unit_price',line_amount,'quantity',1,'coefficient',1) ELSE to_jsonb(i) END ORDER BY i.sort_order,i.id)
        INTO items FROM public.invoice_items i WHERE i.invoice_id=inv.id;
      IF target_line IS NULL THEN
        items:=coalesce(items,'[]'::jsonb)||jsonb_build_array(jsonb_build_object('type','RENT','description',reason,
          'unit_price',line_amount,'quantity',1,'coefficient',1,'amount',line_amount,'accounting_class','REVENUE'));
      END IF;
      subtotal_new:=inv.subtotal+delta+reduction_refund;
      PERFORM public.update_invoice_v1(p_invoice_id=>inv.id,p_contract_id=>inv.contract_id,p_building_id=>inv.building_id,
        p_room_id=>inv.room_id,p_billing_month=>inv.billing_month,p_issue_date=>inv.issue_date,p_due_date=>inv.due_date,
        p_subtotal=>subtotal_new,p_discount_amount=>inv.discount_amount,
        p_total_amount=>app_private.round_invoice_total_v1(subtotal_new-inv.discount_amount+inv.previous_debt),
        p_previous_debt=>inv.previous_debt,p_items=>items,p_prepaid_amount=>inv.prepaid_amount,p_discount_notes=>inv.discount_notes,
        p_electricity_prev_overridden=>inv.electricity_prev_overridden,p_previous_debt_sources=>inv.previous_debt_sources,
        p_template_id=>inv.template_id,p_notes=>inv.notes,p_rent_support_context=>CASE WHEN inv.rent_support_plan_revision IS NOT NULL THEN
          jsonb_build_object('version',1,'expected_plan_revision',inv.rent_support_plan_revision,
            'manual_discount_amount',trim_scale(inv.manual_discount_amount)::text,
            'request_id',md5('room-transfer.draft-support|'||inv.id::text||'|'||request_key)::uuid) END);
    ELSE
      document:=public.invoice_adjustment_build_v1(inv.id,
        CASE WHEN target_line IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('setItems',
          jsonb_build_array(jsonb_build_object('id',target_line,'amount',line_amount))) END);
      IF jsonb_array_length(document->'blockers')>0 THEN
        RAISE EXCEPTION 'Cần đối chiếu nguồn nợ và dòng tiền thuê của hóa đơn trước khi chuyển phòng' USING ERRCODE='55000';
      END IF;
      items:=document#>'{after,items}';
      IF target_line IS NULL THEN
        items:=items||jsonb_build_array(jsonb_build_object('type','RENT','description',reason,'unit_price',line_amount,
          'quantity',1,'coefficient',1,'accounting_class','REVENUE','sort_order',jsonb_array_length(items)+1));
      END IF;
      PERFORM public.adjust_invoice_v2(inv.id,items,inv.discount_amount,inv.discount_notes,inv.notes,
        reason,inv.adjustment_revision,inv.paid_amount,inv.updated_at,request_key);
    END IF;
  END IF;
  IF reduction_refund>0 THEN
    reservation:=public.create_invoice_refund_obligation_v2(inv.id,reduction_refund,reason,'REFUND_CONTRA_REVENUE',
      'room-transfer:'||gen_random_uuid()::text);
    UPDATE app_private.room_transfer_rent_events e SET refund_reservation_id=r.id
      FROM app_private.invoice_refund_reservations r
      WHERE e.organization_id=inv.organization_id AND e.contract_id=p_contract_id AND e.move_date=p_date
        AND r.id=(reservation->>'reservationId')::uuid AND r.organization_id=inv.organization_id
        AND r.invoice_id=inv.id AND r.amount=reduction_refund AND r.reservation_state='HELD';
    IF NOT FOUND THEN RAISE EXCEPTION 'Chưa xác nhận được phiếu hoàn tiền thuê' USING ERRCODE='55000'; END IF;
  END IF;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.transfer_room_finance_v1(p_contract uuid,p_room uuid,p_rent numeric,p_day date,
  p_notes text,p_deposit numeric,p_quote_key text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE c public.contracts%ROWTYPE; prior_room uuid; org uuid; q jsonb; ctx uuid; result uuid; bill uuid;
BEGIN
  SELECT organization_id,room_id INTO org,prior_room FROM public.contracts WHERE id=p_contract AND deleted_at IS NULL;
  IF auth.uid() IS NULL OR NOT coalesce(org=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(org);
  PERFORM pg_advisory_xact_lock(hashtextextended('room:'||least(prior_room,p_room)::text,0));
  IF prior_room IS DISTINCT FROM p_room THEN PERFORM pg_advisory_xact_lock(hashtextextended('room:'||greatest(prior_room,p_room)::text,0)); END IF;
  SELECT * INTO STRICT c FROM public.contracts WHERE id=p_contract AND deleted_at IS NULL AND organization_id=org FOR UPDATE;
  IF c.room_id IS DISTINCT FROM prior_room THEN RAISE EXCEPTION 'Phòng đã thay đổi, vui lòng tải lại' USING ERRCODE='PT409'; END IF;
  PERFORM r.id FROM public.rooms r WHERE r.organization_id=org AND r.id IN (prior_room,p_room) ORDER BY r.id FOR NO KEY UPDATE NOWAIT;
  q:=public.preview_room_transfer_v1(org,p_contract,p_room,p_day,p_rent,p_deposit);
  bill:=(q->>'invoice_id')::uuid;
  IF bill IS NOT NULL THEN
    PERFORM i.id FROM public.invoices i WHERE i.id=bill FOR UPDATE NOWAIT;
    q:=public.preview_room_transfer_v1(org,p_contract,p_room,p_day,p_rent,p_deposit);
  END IF;
  IF p_quote_key IS NOT NULL AND p_quote_key IS DISTINCT FROM q->>'quote_key' THEN
    RAISE EXCEPTION 'Số cọc hoặc hóa đơn đã thay đổi. Vui lòng kiểm tra lại số tiền trước khi chuyển.' USING ERRCODE='PT409';
  END IF;
  ctx:=app_private.begin_commission_reason_v1(NULL,p_contract,NULL,'CONTRACT_CHANGED',p_notes);
  result:=app_private.commission_reason_transfer_room_before_v1(p_contract,p_room,p_rent,p_day,p_notes);
  PERFORM app_private.apply_room_transfer_deposit_v1(p_contract,p_room,p_deposit);
  PERFORM app_private.record_room_transfer_rent_v1(org,p_contract,p_day,prior_room,p_room,c.rent_price,coalesce(p_rent,c.rent_price),q);
  PERFORM app_private.settle_room_transfer_invoice_v1(q,p_contract,p_day);
  DELETE FROM app_private.commission_reason_contexts WHERE context_id=ctx;
  RETURN result;
END $fn$;

-- Các client cũ cùng dùng phép tính trên máy chủ.
CREATE OR REPLACE FUNCTION public.transfer_room(p_contract_id uuid,p_new_room_id uuid,p_new_rent_price numeric DEFAULT NULL,
  p_transfer_date date DEFAULT CURRENT_DATE,p_notes text DEFAULT NULL)
RETURNS uuid LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  SELECT app_private.transfer_room_finance_v1(p_contract_id,p_new_room_id,p_new_rent_price,p_transfer_date,p_notes,NULL,NULL)
$fn$;

-- Dùng lại snapshot, kiểm quyền trước replay và intent_hash của adapter. Đặt mức
-- cọc và quote_key vào cùng payload để replay không thể đổi ý định cũ.
DO $adapter$
DECLARE f text; anchor text:='v_result:=public.transfer_room(c.id,(p_core_args->>''new_room_id'')::uuid,(p_core_args->>''new_rent_price'')::numeric,(p_core_args->>''transfer_date'')::date,p_core_args->>''notes'');';
BEGIN
  f:=pg_get_functiondef('app_private.apply_contract_notice_transition_v1(uuid,uuid,timestamptz,text,text,uuid,text,jsonb)'::regprocedure);
  IF strpos(f,'app_private.transfer_room_finance_v1')=0 THEN
    IF strpos(f,anchor)=0 THEN RAISE EXCEPTION 'Thiếu điểm tích hợp adapter chuyển phòng'; END IF;
    EXECUTE replace(f,anchor,'v_result:=app_private.transfer_room_finance_v1(c.id,(p_core_args->>''new_room_id'')::uuid,(p_core_args->>''new_rent_price'')::numeric,(p_core_args->>''transfer_date'')::date,p_core_args->>''notes'',(p_core_args->>''new_deposit'')::numeric,p_core_args->>''quote_key'');');
  END IF;
END $adapter$;

CREATE OR REPLACE FUNCTION public.transfer_room_with_notice_v2(p_organization_id uuid,p_contract_id uuid,p_expected_updated_at timestamptz,
  p_new_room_id uuid,p_transfer_date date,p_request_id uuid,p_new_rent_price numeric DEFAULT NULL,p_notes text DEFAULT NULL,
  p_notice_reason text DEFAULT NULL,p_new_deposit numeric DEFAULT NULL,p_quote_key text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF p_quote_key IS NULL OR p_quote_key !~ '^[0-9a-f]{32}$' THEN RAISE EXCEPTION 'Cần kiểm tra số tiền trước khi chuyển phòng' USING ERRCODE='22023'; END IF;
  RETURN app_private.apply_contract_notice_transition_v1(p_organization_id,p_contract_id,p_expected_updated_at,'TRANSFER_ROOM','CANCEL',
    p_request_id,p_notice_reason,jsonb_build_object('new_room_id',p_new_room_id,'new_rent_price',p_new_rent_price,
    'transfer_date',p_transfer_date,'notes',p_notes,'new_deposit',p_new_deposit,'quote_key',p_quote_key));
END $fn$;

REVOKE ALL ON FUNCTION app_private.settle_room_transfer_invoice_v1(jsonb,uuid,date),
  app_private.room_transfer_invoice_balance_v1(uuid,numeric,uuid),
  app_private.transfer_room_finance_v1(uuid,uuid,numeric,date,text,numeric,text),
  public.preview_room_transfer_v1(uuid,uuid,uuid,date,numeric,numeric),
  public.transfer_room_with_notice_v2(uuid,uuid,timestamptz,uuid,date,uuid,numeric,text,text,numeric,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_room_transfer_v1(uuid,uuid,uuid,date,numeric,numeric),
  public.transfer_room_with_notice_v2(uuid,uuid,timestamptz,uuid,date,uuid,numeric,text,text,numeric,text) TO authenticated;
COMMIT;
