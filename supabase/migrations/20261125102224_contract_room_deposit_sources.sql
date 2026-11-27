-- Both creation paths consume the room's current hold and the exact received vouchers
-- shown to the signer. The payer's original name stays on the financial record.
CREATE OR REPLACE FUNCTION app_private.contract_room_deposit_sources_v1(p_org uuid, p_room uuid, p_hold uuid)
RETURNS TABLE(id uuid, code text, name text, total_amount numeric, voucher_date date,
              approval_status text, received boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT v.id, v.code::text, v.name::text, (basis.fact->>'amount')::numeric, v.voucher_date,
         v.approval_status::text,
         COALESCE((basis.fact->>'received')::boolean,false)
         AND NOT COALESCE((basis.fact->>'mismatch')::boolean,true)
         AND NOT EXISTS (SELECT 1 FROM public.reservation_receipts rr
                         WHERE rr.source_voucher_id=v.id AND rr.reservation_id IS DISTINCT FROM p_hold)
  FROM public.income_expenses v
  JOIN public.rooms rm ON rm.id=p_room AND rm.organization_id=p_org AND rm.building_id=v.building_id
  CROSS JOIN LATERAL (SELECT app_private.reservation_settlement_basis_v1(v.id) AS fact) basis
  WHERE v.organization_id=p_org AND v.room_id=p_room AND v.contract_id IS NULL
    AND v.deleted_at IS NULL AND v.type='INCOME' AND v.approval_status IS DISTINCT FROM 'CANCELLED'
    AND public.ie_has_deposit_item(v.id)
    AND NOT app_private.reservation_deposit_is_settled_v1(v.id)
    AND NOT EXISTS (SELECT 1 FROM public.contract_deposit_links l WHERE l.income_expense_id=v.id)
$fn$;
REVOKE ALL ON FUNCTION app_private.contract_room_deposit_sources_v1(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- A bound voucher can be edited after the hold is created. Keep unresolved links
-- visible to the decision even if a voucher now belongs to another room.
CREATE OR REPLACE FUNCTION app_private.contract_hold_has_missing_deposit_v1(p_org uuid,p_room uuid,p_hold uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.reservation_receipts rr JOIN public.income_expenses v ON v.id=rr.source_voucher_id
    WHERE rr.reservation_id=p_hold AND v.deleted_at IS NULL AND v.approval_status IS DISTINCT FROM 'CANCELLED'
      AND NOT app_private.reservation_deposit_is_settled_v1(v.id)
      AND NOT EXISTS (SELECT 1 FROM app_private.contract_room_deposit_sources_v1(p_org,p_room,p_hold) s WHERE s.id=v.id)
  )
$fn$;
REVOKE ALL ON FUNCTION app_private.contract_hold_has_missing_deposit_v1(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.get_contract_room_deposits_v1(p_organization_id uuid,p_room_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE building uuid; hold public.room_reservations%ROWTYPE; vouchers jsonb; visible boolean;
BEGIN
  SELECT building_id INTO building FROM public.rooms
    WHERE id=p_room_id AND organization_id=p_organization_id AND deleted_at IS NULL;
  IF building IS NULL OR (public.is_super_admin() AND COALESCE(p_organization_id=ANY(public.sandbox_org_ids()),false)) THEN
    RAISE EXCEPTION 'Không có quyền đọc nguồn cọc của phòng' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.assert_room_reservation_scope_v1(p_organization_id,building,'contracts.create');
  SELECT r.* INTO hold FROM public.room_next_claims c JOIN public.room_reservations r ON r.id=c.reservation_id
    WHERE c.organization_id=p_organization_id AND c.room_id=p_room_id AND c.status='LIVE'
      AND r.organization_id=p_organization_id AND r.room_id=p_room_id AND r.building_id=building AND r.status='HOLD';
  IF hold.id IS NOT NULL AND app_private.contract_hold_has_missing_deposit_v1(p_organization_id,p_room_id,hold.id) THEN
    RAISE EXCEPTION 'Hồ sơ giữ chỗ còn phiếu chưa khớp với phòng. Cần đối chiếu phiếu.' USING ERRCODE='PT409';
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.voucher_date,s.id),'[]'::jsonb),
         COALESCE(bool_and(COALESCE(app_private.ie_supplement_can_read_v1(s.id),false)),true) INTO vouchers,visible
    FROM app_private.contract_room_deposit_sources_v1(p_organization_id,p_room_id,hold.id) s;
  IF NOT visible THEN RAISE EXCEPTION 'Không có quyền đọc đủ phiếu cọc của phòng' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('hold',CASE WHEN hold.id IS NOT NULL THEN
    jsonb_build_object('id',hold.id,'revision',hold.revision,'hint',hold.customer_hint) END,'vouchers',vouchers);
END $fn$;
REVOKE ALL ON FUNCTION public.get_contract_room_deposits_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_contract_room_deposits_v1(uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION app_private.assert_room_next_claim_for_signing_v1(
  p_org uuid,p_room uuid,p_reservation uuid,p_expected_revision bigint,p_customer_ids uuid[],p_voucher_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE building uuid; hold public.room_reservations%ROWTYPE; source record; expected uuid[]:='{}'; supplied uuid[];
BEGIN
  SELECT building_id INTO building FROM public.rooms WHERE id=p_room AND organization_id=p_org AND deleted_at IS NULL;
  IF building IS NULL THEN RAISE EXCEPTION 'Phòng ký không thuộc tổ chức' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_room_reservation_scope_v1(p_org,building,'contracts.create');
  PERFORM 1 FROM public.rooms WHERE id=p_room AND organization_id=p_org FOR NO KEY UPDATE;
  PERFORM app_private.lock_org_for_decision_v1(p_org);
  PERFORM app_private.authorize_room_reservation_writer_v1(p_org,building,'contracts.create');
  SELECT r.* INTO hold FROM public.room_next_claims c JOIN public.room_reservations r ON r.id=c.reservation_id
    WHERE c.organization_id=p_org AND c.room_id=p_room AND c.status='LIVE' FOR UPDATE OF c,r;
  IF hold.id IS DISTINCT FROM p_reservation OR hold.revision IS DISTINCT FROM p_expected_revision
     OR (hold.id IS NOT NULL AND (hold.status<>'HOLD' OR hold.organization_id<>p_org OR hold.building_id<>building OR hold.room_id<>p_room)) THEN
    RAISE EXCEPTION 'Hồ sơ giữ chỗ đã thay đổi. Tải lại cọc của phòng.' USING ERRCODE='PT409';
  END IF;
  -- Use the same lock order as the voucher writers. Re-read posting evidence after locking.
  PERFORM 1 FROM public.income_expenses v WHERE v.organization_id=p_org AND (
    (v.room_id=p_room AND v.contract_id IS NULL AND v.deleted_at IS NULL AND v.type='INCOME' AND public.ie_has_deposit_item(v.id))
    OR EXISTS (SELECT 1 FROM public.reservation_receipts rr WHERE rr.reservation_id=hold.id AND rr.source_voucher_id=v.id))
    ORDER BY v.id FOR UPDATE;
  IF hold.id IS NOT NULL AND app_private.contract_hold_has_missing_deposit_v1(p_org,p_room,hold.id) THEN
    RAISE EXCEPTION 'Hồ sơ giữ chỗ còn phiếu chưa khớp với phòng. Cần đối chiếu phiếu.' USING ERRCODE='PT409';
  END IF;
  FOR source IN SELECT * FROM app_private.contract_room_deposit_sources_v1(p_org,p_room,hold.id) ORDER BY id LOOP
    IF NOT COALESCE(app_private.ie_supplement_can_read_v1(source.id),false) THEN
      RAISE EXCEPTION 'Không có quyền đọc đủ phiếu cọc của phòng' USING ERRCODE='42501';
    END IF;
    IF NOT source.received THEN
      RAISE EXCEPTION 'Phiếu cọc % chưa đủ điều kiện ghi nhận tiền.',COALESCE(source.code,source.id::text) USING ERRCODE='PT409';
    END IF;
    expected:=array_append(expected,source.id);
  END LOOP;
  SELECT COALESCE(array_agg(x ORDER BY x),'{}') INTO supplied FROM unnest(p_voucher_ids) x;
  IF expected<>supplied THEN
    RAISE EXCEPTION 'Danh sách phiếu cọc của phòng đã thay đổi. Tải lại cọc của phòng.' USING ERRCODE='PT409';
  END IF;
  PERFORM app_private.assert_room_reservation_legacy_sources_v1(p_org,p_room,expected);
END $fn$;

-- Preserve the current production versions of the receipt and signing writers including
-- transfer, metering and replay. Only replace the named conditions, on either known state.
DO $patch$
DECLARE change record; body text;
BEGIN
  FOR change IN SELECT * FROM (VALUES
    ('public.create_contract_v2(jsonb,text)'::regprocedure,
     $old$IF jsonb_array_length(v_existing_deposits) <> ($old$,
     $new$IF p_payload ? 'expected_room_deposit_amount' AND (
         jsonb_typeof(p_payload->'expected_room_deposit_amount') IS DISTINCT FROM 'number'
         OR (p_payload->>'expected_room_deposit_amount')::numeric IS DISTINCT FROM
           (SELECT COALESCE(sum(i.amount),0) FROM public.income_expense_items i
            WHERE i.accounting_class='DEPOSIT' AND i.income_expense_id IN
              (SELECT (j#>>'{}')::uuid FROM jsonb_array_elements(v_existing_deposits) j))
         OR EXISTS (SELECT 1 FROM public.income_expenses v WHERE v.voucher_date>v_start_date+7 AND v.id IN
              (SELECT (j#>>'{}')::uuid FROM jsonb_array_elements(v_existing_deposits) j))
       ) THEN RAISE EXCEPTION 'Số tiền hoặc ngày phiếu cọc đã thay đổi. Tải lại cọc của phòng.' USING ERRCODE='PT409'; END IF;
  IF jsonb_array_length(v_existing_deposits) <> ($new$),
    ('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])'::regprocedure,
     $old$'invoice_template_id','transfer_support_amount')) THEN$old$,
     $new$'invoice_template_id','transfer_support_amount','expected_room_deposit_amount')) THEN$new$),
    ('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])'::regprocedure,
     $old$p_creation_options-'first_invoice'-'deposit_receipts'-'existing_deposit_voucher_ids'-'transfer_support_amount'$old$,
     $new$p_creation_options-'first_invoice'-'deposit_receipts'-'existing_deposit_voucher_ids'-'transfer_support_amount'-'expected_room_deposit_amount'$new$),
    ('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])'::regprocedure,
     $old$v_result:=public.create_contract_v2(v_payload,'draft-sign:'||d.id::text);$old$,
     $new$IF p_creation_options ? 'expected_room_deposit_amount' THEN
    v_payload:=v_payload||jsonb_build_object('expected_room_deposit_amount',p_creation_options->'expected_room_deposit_amount'); END IF;
  v_result:=public.create_contract_v2(v_payload,'draft-sign:'||d.id::text);$new$),
    ('app_private.consume_room_next_claim_v1(uuid,uuid,bigint,uuid)'::regprocedure,
     'WHERE contract_id=c.id AND customer_id=r.customer_id)',
     'WHERE contract_id=c.id AND is_representative)'),
    ('app_private.create_reservation_source_receipt_v1(uuid,jsonb,text)'::regprocedure,
     $old$||r.customer_hint||'. Hồ sơ giữ chỗ phải gắn khách trong danh bạ trước khi ký hợp đồng.'$old$,
     $new$||r.customer_hint$new$),
    ('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])'::regprocedure,
     $old$r.status::text='RESERVED' AND p_reservation_id IS NOT NULL$old$,
     $new$r.status::text='RESERVED' AND (p_reservation_id IS NOT NULL OR jsonb_array_length(COALESCE(p_creation_options->'existing_deposit_voucher_ids','[]'))>0)$new$),
    ('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])'::regprocedure,
     $old$p_reservation_id IS NULL AND public.room_has_holding_deposit(r.id)$old$,
     $new$p_reservation_id IS NULL AND public.room_has_holding_deposit(r.id) AND jsonb_array_length(COALESCE(p_creation_options->'existing_deposit_voucher_ids','[]'))=0$new$),
    ('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])'::regprocedure,
     $old$ARRAY(SELECT (j->>'id')::uuid FROM jsonb_array_elements(v_terms->'customers') j),COALESCE(p_source_voucher_ids,ARRAY[]::uuid[]));$old$,
     $new$ARRAY(SELECT (j->>'id')::uuid FROM jsonb_array_elements(v_terms->'customers') j),
      CASE WHEN p_reservation_id IS NOT NULL THEN p_source_voucher_ids ELSE ARRAY(SELECT (j#>>'{}')::uuid FROM jsonb_array_elements(COALESCE(p_creation_options->'existing_deposit_voucher_ids','[]')) j) END);$new$)
  ) seams(fn,old_text,new_text) LOOP
    body:=pg_get_functiondef(change.fn);
    IF position(change.new_text IN body)>0 AND (position(change.old_text IN change.new_text)>0 OR position(change.old_text IN body)=0) THEN CONTINUE; END IF;
    IF (length(body)-length(replace(body,change.old_text,''))) / length(change.old_text) <> 1 THEN
      RAISE EXCEPTION 'Unexpected definition of %',change.fn;
    END IF;
    EXECUTE replace(body,change.old_text,change.new_text);
  END LOOP;
END $patch$;
-- Settle the last live source of this hold (customer abandoned the room). Ordinary voucher
-- cancellation used to correct a payment still allows replacements on the same hold.
CREATE OR REPLACE FUNCTION app_private.release_settled_room_hold_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE hold public.room_reservations%ROWTYPE;
BEGIN
  SELECT r.* INTO hold FROM public.room_next_claims c JOIN public.room_reservations r ON r.id=c.reservation_id
    WHERE c.organization_id=NEW.organization_id AND c.room_id=NEW.room_id AND c.status='LIVE'
      AND r.status='HOLD' AND r.room_id=c.room_id AND r.organization_id=c.organization_id
      -- A detached replacement belongs to the signing pool for this room. For abandonment,
      -- require that the hold previously had a source and that no other hold owns this voucher.
      AND EXISTS (SELECT 1 FROM public.reservation_receipts rr WHERE rr.reservation_id=r.id)
      AND NOT EXISTS (SELECT 1 FROM public.reservation_receipts rr
                      WHERE rr.source_voucher_id=NEW.source_voucher_id AND rr.reservation_id<>r.id)
    FOR UPDATE OF c,r;
  IF NOT FOUND OR app_private.contract_hold_has_missing_deposit_v1(NEW.organization_id,NEW.room_id,hold.id)
     OR EXISTS (SELECT 1 FROM app_private.contract_room_deposit_sources_v1(NEW.organization_id,NEW.room_id,hold.id)) THEN
    RETURN NEW;
  END IF;
  UPDATE public.room_next_claims SET status='CANCELLED',updated_at=clock_timestamp()
    WHERE reservation_id=hold.id AND status='LIVE';
  UPDATE public.room_reservations SET status='CANCELLED',revision=revision+1,updated_at=clock_timestamp() WHERE id=hold.id;
  INSERT INTO app_private.room_reservation_history(reservation_id,revision,action,actor_id,idempotency_key,payload_hash,response)
    VALUES(hold.id,hold.revision+1,'CANCEL',NEW.created_by,'settle-'||NEW.id::text,md5(NEW.id::text),
           app_private.room_reservation_response_v1(hold.id));
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION app_private.release_settled_room_hold_v1() FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE TRIGGER release_settled_room_hold AFTER INSERT ON public.reservation_deposit_settlements
  FOR EACH ROW EXECUTE FUNCTION app_private.release_settled_room_hold_v1();
NOTIFY pgrst,'reload schema';
