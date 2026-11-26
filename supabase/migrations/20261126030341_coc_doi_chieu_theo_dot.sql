-- A payment is posted once. Ownership at signing comes only from the receipt-to-hold link.
-- Keep genuine old room claims effective; a voucher alone does not identify a tenancy.
CREATE OR REPLACE FUNCTION app_private.assert_room_reservation_legacy_sources_v1(
  p_org uuid, p_room uuid, p_allowed_vouchers uuid[] DEFAULT '{}'::uuid[]
) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM public.room_sale_locks WHERE organization_id=p_org AND room_id=p_room
      AND released_at IS NULL AND expires_at>clock_timestamp() AND locked_by IS DISTINCT FROM auth.uid()) THEN
    RAISE EXCEPTION 'Phòng đang được nhân viên khác khóa tạm. Kiểm tra khóa phòng trước khi tiếp tục.' USING ERRCODE='PT409';
  END IF;
  IF EXISTS (SELECT 1 FROM public.deposits WHERE organization_id=p_org AND room_id=p_room
      AND contract_id IS NULL AND deleted_at IS NULL AND status IN ('PENDING','CONFIRMED'))
    OR EXISTS (SELECT 1 FROM public.room_reservation_holds WHERE room_id=p_room AND contract_id IS NULL
      AND status IN ('PENDING_APPROVAL','APPROVED') AND expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'Phòng còn lượt giữ chỗ cũ đang hiệu lực. Kiểm tra lượt giữ chỗ của phòng.' USING ERRCODE='PT409';
  END IF;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.contract_room_deposit_sources_v1(p_org uuid,p_room uuid,p_hold uuid)
RETURNS TABLE(id uuid,code text,name text,total_amount numeric,voucher_date date,approval_status text,received boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
  SELECT v.id,v.code::text,v.name::text,(fact.basis->>'amount')::numeric,v.voucher_date,v.approval_status::text,
    coalesce((fact.basis->>'received')::boolean,false) AND NOT coalesce((fact.basis->>'mismatch')::boolean,true)
  FROM public.income_expenses v
  JOIN public.rooms r ON r.id=p_room AND r.organization_id=p_org AND r.building_id=v.building_id
  CROSS JOIN LATERAL (SELECT app_private.reservation_settlement_basis_v1(v.id) AS basis) fact
  WHERE v.room_id=p_room AND v.organization_id=p_org AND v.contract_id IS NULL AND v.type='INCOME'
    AND v.deleted_at IS NULL AND v.approval_status IS DISTINCT FROM 'CANCELLED' AND public.ie_has_deposit_item(v.id)
    AND NOT app_private.reservation_deposit_is_settled_v1(v.id)
    AND EXISTS (SELECT 1 FROM public.reservation_receipts rr WHERE rr.reservation_id=p_hold AND rr.source_voucher_id=v.id)
    AND NOT EXISTS (SELECT 1 FROM public.reservation_receipts rr WHERE rr.reservation_id<>p_hold AND rr.source_voucher_id=v.id)
    AND NOT EXISTS (SELECT 1 FROM public.contract_deposit_links l WHERE l.income_expense_id=v.id)
$fn$;

-- The canonical writer binds new money inside its transaction. Editing an old line,
-- posting an import or approving a legacy voucher never chooses a tenancy on its behalf.
DROP TRIGGER IF EXISTS bind_unlinked_deposit_income ON public.income_expense_items;

CREATE OR REPLACE FUNCTION public.trg_contract_link_orphan_deposits() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
  IF current_setting('app.contract_create_v2',true)='on' OR NEW.room_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.status IN ('ACTIVE','EXTENDED') THEN
    PERFORM 1 FROM public.rooms WHERE organization_id=NEW.organization_id AND id=NEW.room_id FOR NO KEY UPDATE;
    IF EXISTS (SELECT 1 FROM public.room_next_claims WHERE organization_id=NEW.organization_id
      AND room_id=NEW.room_id AND status='LIVE') THEN
      RAISE EXCEPTION 'Phòng có lượt giữ chỗ đang mở. Ký từ form Hợp đồng để nhận đúng nguồn cọc.' USING ERRCODE='PT409';
    END IF;
  END IF;
  PERFORM public.recompute_contract_deposit_paid(NEW.id);
  RETURN NEW;
END $fn$;

-- Retire the historical action for old clients and the Hermes delegate. The receipt
-- payer and the identity of the tenant signing a contract have separate lifecycles.
CREATE OR REPLACE FUNCTION public.assign_room_reservation_customer_v1(p_organization_id uuid,p_reservation_id uuid,
 p_expected_revision bigint,p_customer_id uuid,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  RAISE EXCEPTION 'Chọn khách đứng tên ở form Hợp đồng. Phiếu cọc chỉ ghi người gửi.' USING ERRCODE='PT409';
END $fn$;
REVOKE ALL ON FUNCTION public.assign_room_reservation_customer_v1(uuid,uuid,bigint,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

-- A RESERVED room can have only an unallocated legacy receipt. Draft check-in must
-- still reject a manual reservation, active tenancy, temporary lock or next claim.
CREATE OR REPLACE FUNCTION app_private.room_has_unallocated_deposit_v1(p_org uuid,p_room uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
 SELECT EXISTS (SELECT 1 FROM public.income_expenses v WHERE v.organization_id=p_org AND v.room_id=p_room
   AND v.contract_id IS NULL AND v.type='INCOME' AND v.deleted_at IS NULL AND v.approval_status IS DISTINCT FROM 'CANCELLED'
   AND public.ie_has_deposit_item(v.id) AND NOT app_private.reservation_deposit_is_settled_v1(v.id)
   AND NOT EXISTS (SELECT 1 FROM public.reservation_receipts rr WHERE rr.source_voucher_id=v.id)
   AND NOT EXISTS (SELECT 1 FROM public.contract_deposit_links l WHERE l.income_expense_id=v.id))
$fn$;
REVOKE ALL ON FUNCTION app_private.room_has_unallocated_deposit_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Require the original voucher and the exact destination displayed to the manager.
-- Reconciliation changes only ownership and its audit trail; never creates a second cash posting.
CREATE OR REPLACE FUNCTION public.reconcile_deposit_income_hold_v1(
 p_organization_id uuid,p_voucher_id uuid,p_hold_id uuid,p_revision bigint,p_voucher_amount numeric,p_hold_paid numeric)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE
  actor uuid:=auth.uid(); h public.room_reservations%ROWTYPE; v public.income_expenses%ROWTYPE;
  rm public.rooms%ROWTYPE; ct public.contracts%ROWTYPE; basis jsonb; paid numeric; owned uuid;
BEGIN
  IF actor IS NULL OR NOT coalesce(p_organization_id=ANY(public.my_org_ids()),false)
    OR (public.is_super_admin() AND coalesce(p_organization_id=ANY(public.sandbox_org_ids()),false)) THEN
    RAISE EXCEPTION 'Không có quyền đối chiếu cọc tại tòa này.' USING ERRCODE='42501';
  END IF;
  SELECT r.* INTO rm FROM public.rooms r JOIN public.room_reservations h0 ON h0.room_id=r.id
    AND h0.organization_id=r.organization_id AND h0.building_id=r.building_id
    WHERE h0.id=p_hold_id AND r.organization_id=p_organization_id AND r.deleted_at IS NULL FOR NO KEY UPDATE OF r;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lượt giữ chỗ không thuộc phòng được chọn.' USING ERRCODE='PT409'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  PERFORM app_private.authorize_room_reservation_writer_v1(p_organization_id,rm.building_id,'deposits.edit');
  IF NOT coalesce(public.can_do_on_building('deposits','view',rm.building_id),false)
    OR NOT coalesce(app_private.ie_supplement_can_read_v1(p_voucher_id),false) THEN
    RAISE EXCEPTION 'Không có quyền đối chiếu cọc tại tòa này.' USING ERRCODE='42501'; END IF;
  SELECT * INTO h FROM public.room_reservations WHERE id=p_hold_id AND organization_id=p_organization_id FOR UPDATE;
  IF h.status='CONVERTED' THEN
    PERFORM app_private.assert_room_reservation_scope_v1(p_organization_id,rm.building_id,'contracts.edit');
    IF NOT coalesce((SELECT allowed FROM app_private.authorize_tenant_action_v3(actor,p_organization_id,'contracts.edit',rm.building_id,NULL)),false) THEN
      RAISE EXCEPTION 'Không có quyền đối chiếu cọc tại tòa này.' USING ERRCODE='42501';
    END IF;
    SELECT * INTO ct FROM public.contracts WHERE id=h.converted_contract_id AND room_id=rm.id
      AND organization_id=p_organization_id AND deleted_at IS NULL AND status IN ('ACTIVE','EXTENDED') FOR UPDATE;
    IF ct.id IS NULL THEN RAISE EXCEPTION 'Hợp đồng của lượt đã đóng. Kiểm tra hồ sơ quyết toán.' USING ERRCODE='PT409'; END IF;
  ELSIF h.status IS DISTINCT FROM 'HOLD' OR NOT EXISTS (SELECT 1 FROM public.room_next_claims WHERE reservation_id=h.id
      AND room_id=rm.id AND organization_id=p_organization_id AND status='LIVE') THEN
    RAISE EXCEPTION 'Lượt giữ chỗ đã đóng. Tải lại trước khi đối chiếu.' USING ERRCODE='PT409';
  END IF;
  SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher_id AND organization_id=p_organization_id
    AND building_id=rm.building_id AND room_id=rm.id FOR UPDATE;
  SELECT reservation_id INTO owned FROM public.reservation_receipts WHERE source_voucher_id=p_voucher_id LIMIT 1;
  IF owned=h.id AND v.id IS NOT NULL AND v.contract_id IS NOT DISTINCT FROM ct.id THEN RETURN h.id; END IF;
  IF h.id IS NULL OR v.id IS NULL OR v.deleted_at IS NOT NULL OR v.contract_id IS NOT NULL OR v.type<>'INCOME'
    OR v.approval_status IS DISTINCT FROM 'APPROVED' OR NOT public.ie_has_deposit_item(v.id)
    OR app_private.reservation_deposit_is_settled_v1(v.id)
    OR EXISTS(SELECT 1 FROM public.contract_deposit_links WHERE income_expense_id=v.id)
    OR EXISTS(SELECT 1 FROM public.deposit_management_exclusions WHERE voucher_id=v.id) THEN
    RAISE EXCEPTION 'Phiếu hoặc lượt giữ chỗ đã đổi. Tải lại trước khi đối chiếu.' USING ERRCODE='PT409'; END IF;
  basis:=app_private.reservation_settlement_basis_v1(v.id);
  SELECT coalesce(sum(p.amount),0) INTO paid FROM app_private.reservation_receipt_projection_v1(h.id) p WHERE p.received AND NOT p.released;
  IF ct.id IS NOT NULL THEN paid:=ct.deposit_paid; END IF;
  IF owned IS NOT NULL OR h.revision IS DISTINCT FROM p_revision OR paid IS DISTINCT FROM p_hold_paid
    OR (basis->>'amount')::numeric IS DISTINCT FROM p_voucher_amount OR coalesce(p_voucher_amount,0)<=0
    OR NOT coalesce((basis->>'received')::boolean,false) OR coalesce((basis->>'mismatch')::boolean,true) THEN
    RAISE EXCEPTION 'Phiếu hoặc lượt giữ chỗ đã đổi. Tải lại trước khi đối chiếu.' USING ERRCODE='PT409'; END IF;
  IF ct.id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM app_private.contract_exit_settlement_drafts d JOIN public.contract_exit_cases e ON e.id=d.case_id WHERE e.contract_id=ct.id) THEN
      RAISE EXCEPTION 'Hợp đồng đang có hồ sơ quyết toán. Kiểm tra hồ sơ trước khi nối phiếu.' USING ERRCODE='PT409';
    END IF;
    IF coalesce((app_private.quote_room_transfer_deposit_v1(ct.id,rm.id,ct.total_deposit)->>'deposit_unbilled_shortfall')::numeric,0)<p_voucher_amount THEN
      RAISE EXCEPTION 'Số tiền phiếu vượt phần cọc còn thiếu chưa lên hóa đơn của hợp đồng.' USING ERRCODE='PT409';
    END IF;
    PERFORM app_private.bind_reservation_source_voucher_v1(h.id,v.id);
    INSERT INTO public.contract_deposit_links (organization_id,contract_id,income_expense_id,link_source,linked_by)
      VALUES(p_organization_id,ct.id,v.id,'EXPLICIT_V2',actor);
    PERFORM app_private.begin_ie_flex_write_v1(v.id,'LINK_CONTRACT');
    UPDATE public.income_expenses SET contract_id=ct.id,updated_at=clock_timestamp() WHERE id=v.id;
    PERFORM app_private.end_ie_flex_write_v1(v.id);
    PERFORM public.recompute_contract_deposit_paid(ct.id);
    UPDATE public.room_reservations SET revision=revision+1,updated_at=clock_timestamp() WHERE id=h.id;
    INSERT INTO app_private.room_reservation_history(reservation_id,revision,action,actor_id,idempotency_key,payload_hash,response)
      VALUES(h.id,h.revision+1,'RECONCILE',actor,'reconcile-'||v.id,md5(v.id::text),app_private.room_reservation_response_v1(h.id));
    RETURN h.id;
  END IF;
  RETURN app_private.attach_deposit_income_v1(v.id,jsonb_build_object('expected_hold',h.id,'expected_revision',h.revision,'reconcile',true),actor);
END $fn$;
REVOKE ALL ON FUNCTION public.reconcile_deposit_income_hold_v1(uuid,uuid,uuid,bigint,numeric,numeric) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_deposit_income_hold_v1(uuid,uuid,uuid,bigint,numeric,numeric) TO authenticated;

DO $patch$
DECLARE x record; body text; newbody text;
BEGIN
  FOR x IN SELECT * FROM (VALUES
    ('public.get_my_available_rooms(uuid)'::regprocedure,
      $a$OR exit_hold IS NOT NULL OR has_deposit_hold
  ),$a$,
      $b$OR exit_hold IS NOT NULL OR has_deposit_hold
      OR (deposit_hold->>'source'='voucher' AND deposit_hold->>'room_occupied'='false')
  ),$b$),
    ('public.create_room_reservation_v1(uuid,text,jsonb)'::regprocedure,
      $a$IF cardinality(ids)<>(SELECT count(DISTINCT x)$a$,
      $b$IF cardinality(ids)>0 THEN RAISE EXCEPTION 'Mở lượt giữ chỗ rồi đối chiếu phiếu đã thu.' USING ERRCODE='PT409'; END IF;
 IF cardinality(ids)<>(SELECT count(DISTINCT x)$b$),
    ('app_private.attach_deposit_income_v1(uuid,jsonb,uuid,uuid[])'::regprocedure,
      $a$CASE WHEN existing IS NULL THEN 'CREATE' ELSE 'TOPUP' END$a$,
      $b$CASE WHEN existing IS NULL THEN 'CREATE' WHEN p_terms->>'reconcile'='true' THEN 'RECONCILE' ELSE 'TOPUP' END$b$),
    -- Routes without a selected destination (including older clients) may start a new hold,
    -- but cannot append to a different person's existing hold because the room matches.
    ('app_private.write_deposit_income_v1(uuid,text,jsonb,jsonb,jsonb,uuid,uuid)'::regprocedure,
      $a$hold:=app_private.attach_deposit_income_v1(ie.id,terms,actor);$a$,
      $b$hold:=app_private.attach_deposit_income_v1(ie.id,jsonb_build_object('expected_hold',NULL)||terms,actor);$b$),
    ('app_private.release_settled_room_hold_v1()'::regprocedure,
      $a$AND NOT EXISTS (SELECT 1 FROM public.reservation_receipts rr
                      WHERE rr.source_voucher_id=NEW.source_voucher_id AND rr.reservation_id<>r.id)$a$,
      $b$AND EXISTS (SELECT 1 FROM public.reservation_receipts rr
                      WHERE rr.source_voucher_id=NEW.source_voucher_id AND rr.reservation_id=r.id)$b$),
    ('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])'::regprocedure,
      $a$r.status::text='RESERVED' AND (p_reservation_id IS NOT NULL OR jsonb_array_length(COALESCE(p_creation_options->'existing_deposit_voucher_ids','[]'))>0)$a$,
      $b$r.status::text='RESERVED' AND (p_reservation_id IS NOT NULL OR app_private.room_has_unallocated_deposit_v1(p_organization_id,r.id))$b$),
    ('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])'::regprocedure,
      $a$p_reservation_id IS NULL AND public.room_has_holding_deposit(r.id) AND jsonb_array_length(COALESCE(p_creation_options->'existing_deposit_voucher_ids','[]'))=0$a$,
      $b$p_reservation_id IS NULL AND public.room_has_holding_deposit(r.id) AND NOT app_private.room_has_unallocated_deposit_v1(p_organization_id,r.id)$b$),
    ('public.hermes_sale_actions_v1(jsonb,text,jsonb)'::regprocedure,
      $a$'reservation_update','reservation_topup','reservation_assign','status')$a$,
      $b$'reservation_update','reservation_topup','status')$b$)
  ) seams(fn,oldpart,newpart) LOOP
    body:=pg_get_functiondef(x.fn);
    IF strpos(body,x.newpart)>0 THEN CONTINUE; END IF;
    newbody:=replace(body,x.oldpart,x.newpart);
    IF newbody=body THEN RAISE EXCEPTION 'Unexpected definition for %',x.fn; END IF;
    EXECUTE newbody;
  END LOOP;
END $patch$;
