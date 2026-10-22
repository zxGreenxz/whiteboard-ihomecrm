-- Forward only. Reservation terms are canonical; legacy voucher readers keep
-- their existing shape. No bulk backfill and no change to money posting.
BEGIN;

DO $guard$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
    WHERE p.oid=to_regprocedure('app_private.ie_supplement_can_read_v1(uuid)')
      AND r.rolname='ie_detail_reader' AND NOT r.rolsuper AND NOT r.rolbypassrls
      AND p.prosecdef AND 'row_security=on'=ANY(p.proconfig)
  ) THEN
    RAISE EXCEPTION 'Parent voucher RLS reader owner/configuration drift';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.upsert_room_pass_listing(
  p_id uuid, p_room_id uuid, p_contact_name text, p_contact_phone text,
  p_sale_policy text, p_pass_price numeric, p_active boolean,
  p_avail_date date DEFAULT NULL, p_contact_manager boolean DEFAULT false
)
RETURNS public.room_pass_listings
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_owner uuid; v_building uuid; v_org uuid;
  v_row public.room_pass_listings;
BEGIN
  SELECT r.building_id,b.user_id,r.organization_id INTO v_building,v_owner,v_org
  FROM public.rooms r JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=r.organization_id
  WHERE r.id=p_room_id AND r.deleted_at IS NULL AND b.deleted_at IS NULL
  FOR NO KEY UPDATE OF r;
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT COALESCE(v_org=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Không có quyền quản lý phòng khách nhờ sale này' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  IF NOT COALESCE(public.can_manage_pass_listing(v_building,v_owner),false) THEN
    RAISE EXCEPTION 'Không có quyền quản lý phòng khách nhờ sale cho tòa này' USING ERRCODE='42501';
  END IF;
  IF p_id IS NULL THEN
    SELECT id INTO p_id FROM public.room_pass_listings WHERE room_id=p_room_id AND active LIMIT 1;
  END IF;
  IF p_id IS NOT NULL THEN
    SELECT * INTO v_row FROM public.room_pass_listings WHERE id=p_id FOR UPDATE;
    -- Editing an existing listing cannot move it between rooms, even when the
    -- actor can manage the destination. Check its original scope as well.
    IF NOT FOUND OR v_row.organization_id IS DISTINCT FROM v_org
      OR v_row.room_id IS DISTINCT FROM p_room_id OR v_row.building_id IS DISTINCT FROM v_building
      OR v_row.user_id IS DISTINCT FROM v_owner
      OR NOT COALESCE(public.can_manage_pass_listing(v_row.building_id,v_row.user_id),false) THEN
      RAISE EXCEPTION 'Tin pass không thuộc phòng và phạm vi được phép' USING ERRCODE='42501';
    END IF;
    UPDATE public.room_pass_listings SET
      contact_name=p_contact_name,contact_phone=p_contact_phone,sale_policy=p_sale_policy,
      pass_price=p_pass_price,avail_date=p_avail_date,contact_manager=COALESCE(p_contact_manager,false),
      active=COALESCE(p_active,active),updated_at=now()
    WHERE id=p_id RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.room_pass_listings(organization_id,user_id,building_id,room_id,contact_name,contact_phone,
      sale_policy,pass_price,avail_date,contact_manager,active,created_by)
    VALUES(v_org,v_owner,v_building,p_room_id,p_contact_name,p_contact_phone,p_sale_policy,p_pass_price,
      p_avail_date,COALESCE(p_contact_manager,false),COALESCE(p_active,true),auth.uid())
    RETURNING * INTO v_row;
  END IF;
  RETURN v_row;
END $fn$;
REVOKE ALL ON FUNCTION public.upsert_room_pass_listing(uuid,uuid,text,text,text,numeric,boolean,date,boolean) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.upsert_room_pass_listing(uuid,uuid,text,text,text,numeric,boolean,date,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION app_private.sync_reservation_hold_terms_v1(p_reservation uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE r public.room_reservations;
BEGIN
  SELECT * INTO STRICT r FROM public.room_reservations WHERE id=p_reservation;
  IF r.hold_until IS NULL AND r.topup_due_on IS NULL AND COALESCE(r.deposit_target,0)=0 THEN
    DELETE FROM public.reservation_hold_deadlines h
    USING public.reservation_receipts rr
    WHERE rr.reservation_id=r.id AND rr.organization_id=r.organization_id
      AND h.income_expense_id=rr.source_voucher_id AND h.organization_id=r.organization_id;
  ELSE
    INSERT INTO public.reservation_hold_deadlines
      (income_expense_id,organization_id,hold_until,topup_due_date,deposit_target,created_by)
    SELECT DISTINCT rr.source_voucher_id,r.organization_id,r.hold_until,r.topup_due_on,NULLIF(r.deposit_target,0),r.created_by
    FROM public.reservation_receipts rr
    JOIN public.income_expenses v ON v.id=rr.source_voucher_id AND v.organization_id=r.organization_id
    WHERE rr.reservation_id=r.id AND rr.organization_id=r.organization_id
    ON CONFLICT(income_expense_id) DO UPDATE SET
      hold_until=EXCLUDED.hold_until,topup_due_date=EXCLUDED.topup_due_date,
      deposit_target=EXCLUDED.deposit_target,updated_at=now();
  END IF;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.sync_reservation_hold_terms_trigger_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private
AS $fn$
BEGIN
  IF TG_TABLE_NAME='reservation_receipts' THEN
    PERFORM app_private.sync_reservation_hold_terms_v1(NEW.reservation_id);
  ELSE
    PERFORM app_private.sync_reservation_hold_terms_v1(NEW.id);
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION app_private.sync_reservation_hold_terms_v1(uuid),
  app_private.sync_reservation_hold_terms_trigger_v1() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS reservation_terms_projection ON public.room_reservations;
CREATE TRIGGER reservation_terms_projection AFTER INSERT OR UPDATE OF hold_until,topup_due_on,deposit_target
  ON public.room_reservations FOR EACH ROW EXECUTE FUNCTION app_private.sync_reservation_hold_terms_trigger_v1();
DROP TRIGGER IF EXISTS reservation_receipt_terms_projection ON public.reservation_receipts;
CREATE TRIGGER reservation_receipt_terms_projection AFTER INSERT ON public.reservation_receipts
  FOR EACH ROW EXECUTE FUNCTION app_private.sync_reservation_hold_terms_trigger_v1();

CREATE OR REPLACE FUNCTION public.set_reservation_hold_terms_v1(
  p_income_expense_id uuid,p_hold_until date DEFAULT NULL::date,
  p_topup_due_date date DEFAULT NULL::date,p_deposit_target numeric DEFAULT NULL::numeric
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_ie public.income_expenses; r public.room_reservations; v_actor uuid:=auth.uid();
  v_org uuid; v_building uuid; v_room uuid;
BEGIN
  -- Acquire room -> organization -> reservation/voucher, matching reservation
  -- writers. Do not lock the voucher first and then wait on its room.
  SELECT * INTO v_ie FROM public.income_expenses WHERE id=p_income_expense_id;
  IF v_actor IS NULL OR NOT FOUND OR NOT COALESCE(v_ie.organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Không có quyền sửa kỳ hạn phiếu cọc' USING ERRCODE='42501';
  END IF;
  v_org:=v_ie.organization_id;v_building:=v_ie.building_id;v_room:=v_ie.room_id;
  IF v_ie.room_id IS NOT NULL THEN
    PERFORM 1 FROM public.rooms WHERE id=v_ie.room_id AND organization_id=v_ie.organization_id FOR NO KEY UPDATE;
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(v_ie.organization_id);
  PERFORM app_private.authorize_room_reservation_writer_v1(v_ie.organization_id,v_ie.building_id,'deposits.edit');
  SELECT * INTO v_ie FROM public.income_expenses WHERE id=p_income_expense_id FOR UPDATE;
  IF NOT FOUND OR v_ie.organization_id IS DISTINCT FROM v_org OR v_ie.building_id IS DISTINCT FROM v_building
    OR v_ie.room_id IS DISTINCT FROM v_room THEN
    RAISE EXCEPTION 'Phạm vi phiếu cọc đã thay đổi. Tải lại trước khi sửa kỳ hạn.' USING ERRCODE='PT409';
  END IF;
  IF v_ie.deleted_at IS NOT NULL OR v_ie.contract_id IS NOT NULL
    OR v_ie.approval_status='CANCELLED' OR app_private.reservation_deposit_is_settled_v1(v_ie.id) THEN
    RAISE EXCEPTION 'Phiếu cọc đã được xử lý' USING ERRCODE='55000';
  END IF;
  IF v_ie.type IS DISTINCT FROM 'INCOME' OR NOT public.ie_has_deposit_item(v_ie.id) THEN
    RAISE EXCEPTION 'Chỉ đặt kỳ hạn cho phiếu thu cọc giữ chỗ' USING ERRCODE='22023';
  END IF;
  SELECT res.* INTO r FROM public.room_reservations res
  WHERE res.organization_id=v_ie.organization_id AND EXISTS(
    SELECT 1 FROM public.reservation_receipts rr WHERE rr.reservation_id=res.id
      AND rr.organization_id=res.organization_id AND rr.source_voucher_id=v_ie.id)
  FOR UPDATE;
  -- A later topup voucher can legitimately follow an overdue canonical term.
  -- Only an unlinked legacy voucher uses its own voucher date as the lower bound.
  IF (r.id IS NULL AND p_hold_until IS NOT NULL AND p_hold_until<v_ie.voucher_date)
    OR (r.id IS NULL AND p_topup_due_date IS NOT NULL AND p_topup_due_date<v_ie.voucher_date)
    OR (p_hold_until IS NOT NULL AND p_topup_due_date>p_hold_until)
    OR (p_deposit_target IS NOT NULL AND (p_deposit_target<=0 OR p_deposit_target>9007199254740991
      OR p_deposit_target<>trunc(p_deposit_target) OR p_deposit_target::text IN ('NaN','Infinity','-Infinity'))) THEN
    RAISE EXCEPTION 'Kỳ hạn hoặc số cọc cần đủ không hợp lệ' USING ERRCODE='23514';
  END IF;
  IF r.id IS NOT NULL THEN
    PERFORM public.update_room_reservation_v1(r.organization_id,r.id,r.revision,
      'hold-terms-'||gen_random_uuid()::text,'UPDATE',
      jsonb_build_object('hold_until',p_hold_until,'topup_due_on',p_topup_due_date,'deposit_target',p_deposit_target),NULL);
  ELSIF p_hold_until IS NULL AND p_topup_due_date IS NULL AND p_deposit_target IS NULL THEN
    DELETE FROM public.reservation_hold_deadlines WHERE income_expense_id=v_ie.id AND organization_id=v_ie.organization_id;
  ELSE
    INSERT INTO public.reservation_hold_deadlines(income_expense_id,organization_id,hold_until,topup_due_date,deposit_target,created_by)
    VALUES(v_ie.id,v_ie.organization_id,p_hold_until,p_topup_due_date,p_deposit_target,v_actor)
    ON CONFLICT(income_expense_id) DO UPDATE SET hold_until=EXCLUDED.hold_until,
      topup_due_date=EXCLUDED.topup_due_date,deposit_target=EXCLUDED.deposit_target,updated_at=now();
  END IF;
  IF p_hold_until IS NULL AND p_topup_due_date IS NULL AND p_deposit_target IS NULL THEN
    RETURN jsonb_build_object('incomeExpenseId',v_ie.id,'cleared',true);
  END IF;
  RETURN jsonb_build_object('incomeExpenseId',v_ie.id,'holdUntil',p_hold_until,
    'topupDueDate',p_topup_due_date,'depositTarget',p_deposit_target);
END $fn$;
REVOKE ALL ON FUNCTION public.set_reservation_hold_terms_v1(uuid,date,date,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_reservation_hold_terms_v1(uuid,date,date,numeric) TO authenticated,service_role;

-- Old clients change only the contract deadline. Read the other two canonical
-- terms after the same lock order, so they cannot overwrite a concurrent edit.
CREATE OR REPLACE FUNCTION public.set_reservation_hold_deadline_v1(p_income_expense_id uuid,p_hold_until date DEFAULT NULL::date)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v public.income_expenses;v_topup date;v_target numeric;
BEGIN
  SELECT * INTO v FROM public.income_expenses WHERE id=p_income_expense_id;
  IF auth.uid() IS NULL OR NOT FOUND OR NOT COALESCE(v.organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Không có quyền sửa kỳ hạn phiếu cọc' USING ERRCODE='42501';
  END IF;
  IF v.room_id IS NOT NULL THEN
    PERFORM 1 FROM public.rooms WHERE id=v.room_id AND organization_id=v.organization_id FOR NO KEY UPDATE;
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(v.organization_id);
  SELECT r.topup_due_on,NULLIF(r.deposit_target,0) INTO v_topup,v_target
  FROM public.room_reservations r WHERE r.organization_id=v.organization_id AND EXISTS(
    SELECT 1 FROM public.reservation_receipts rr WHERE rr.reservation_id=r.id
      AND rr.organization_id=r.organization_id AND rr.source_voucher_id=v.id);
  IF NOT FOUND THEN
    SELECT topup_due_date,deposit_target INTO v_topup,v_target
    FROM public.reservation_hold_deadlines WHERE income_expense_id=v.id AND organization_id=v.organization_id;
  END IF;
  RETURN public.set_reservation_hold_terms_v1(p_income_expense_id,p_hold_until,v_topup,v_target);
END $fn$;
REVOKE ALL ON FUNCTION public.set_reservation_hold_deadline_v1(uuid,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_reservation_hold_deadline_v1(uuid,date) TO authenticated,service_role;

-- Additive reader: the guard runs as the existing non-BYPASSRLS reader owner,
-- so fund visibility and all parent voucher policies remain authoritative.
CREATE OR REPLACE FUNCTION public.read_reservation_deposit_received_v1(p_organization_id uuid,p_voucher_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE result jsonb;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL
    OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Chưa chọn tổ chức được phép' USING ERRCODE='42501';
  END IF;
  IF p_voucher_ids IS NULL OR cardinality(p_voucher_ids)>200 OR array_position(p_voucher_ids,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Cần danh sách tối đa 200 phiếu cọc' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('voucher_id',v.id,'reservation_id',linked.id,
    'received_amount',CASE WHEN COALESCE((basis.fact->>'received')::boolean,false)
      AND NOT COALESCE((basis.fact->>'mismatch')::boolean,true)
      AND NOT app_private.reservation_deposit_is_settled_v1(v.id)
      THEN (basis.fact->>'amount')::numeric ELSE 0 END) ORDER BY v.id),'[]'::jsonb)
  INTO result
  FROM public.income_expenses v
  CROSS JOIN LATERAL (SELECT app_private.reservation_settlement_basis_v1(v.id) fact) basis
  LEFT JOIN LATERAL (
    SELECT rr.reservation_id AS id FROM public.reservation_receipts rr
    WHERE rr.source_voucher_id=v.id AND rr.organization_id=v.organization_id
    GROUP BY rr.reservation_id
  ) linked ON true
  WHERE v.id=ANY(p_voucher_ids) AND v.organization_id=p_organization_id
    AND v.contract_id IS NULL AND v.deleted_at IS NULL AND v.type='INCOME'
    AND app_private.ie_supplement_can_read_v1(v.id)
    AND public.ie_has_deposit_item(v.id);
  RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.read_reservation_deposit_received_v1(uuid,uuid[]) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.read_reservation_deposit_received_v1(uuid,uuid[]) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
