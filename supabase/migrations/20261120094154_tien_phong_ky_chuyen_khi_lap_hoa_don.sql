BEGIN;

CREATE OR REPLACE FUNCTION app_private.room_transfer_invoice_rent_v1(p_org uuid,p_contract uuid,p_month text,
  p_from date DEFAULT NULL,p_to date DEFAULT NULL) RETURNS numeric
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $fn$
DECLARE span record; sibling numeric;
BEGIN
  sibling:=app_private.room_transfer_sibling_rent_v1(p_org,p_contract,p_month,p_from,p_to);
  IF sibling IS NOT NULL THEN RETURN sibling; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_private.room_transfer_rent_events e WHERE e.organization_id=p_org AND e.contract_id=p_contract
    AND (CASE WHEN p_from IS NOT NULL AND p_to IS NOT NULL THEN e.move_date BETWEEN p_from AND p_to
      ELSE to_char(e.move_date,'YYYY-MM')=p_month OR EXISTS(SELECT 1 FROM public.contracts c WHERE c.id=p_contract
        AND e.move_date BETWEEN coalesce(c.start_billing_date,c.start_date) AND c.end_billing_date
        AND app_private.room_transfer_first_month_v1(coalesce(c.start_billing_date,c.start_date),c.end_billing_date)=p_month) END
      OR (p_from IS NOT NULL AND p_to IS NOT NULL AND e.rent_override<>0 AND p_from<=e.period_end AND p_to>=e.period_start)
      OR EXISTS(SELECT 1 FROM public.contracts c WHERE c.id=p_contract AND c.organization_id=p_org
        AND e.move_date>=c.start_date AND e.move_date<c.start_billing_date
        AND (p_from=c.start_billing_date OR (p_from IS NULL AND coalesce(
          app_private.room_transfer_first_month_v1(c.start_billing_date,c.end_billing_date),to_char(c.start_billing_date,'YYYY-MM'))=p_month)))))
  THEN RETURN NULL; END IF;
  SELECT * INTO STRICT span FROM app_private.room_transfer_billing_period_v1(p_org,p_contract,p_month,p_from,p_to);
  RETURN app_private.room_transfer_rent_for_period_v1(p_org,p_contract,span.period_start,span.period_end);
END $fn$;

CREATE OR REPLACE FUNCTION public.room_transfer_invoice_rents_v1(p_building_id uuid,p_billing_month text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE org uuid; result jsonb;
BEGIN
  SELECT organization_id INTO org FROM public.buildings WHERE id=p_building_id AND deleted_at IS NULL;
  IF auth.uid() IS NULL OR NOT coalesce(org=ANY(public.my_org_ids()),false)
    OR NOT coalesce(public.can_access_building(p_building_id),false)
    OR NOT(coalesce(public.can_do_on_building('invoices','create',p_building_id),false)
       OR coalesce(public.can_do_on_building('invoices','view',p_building_id),false)) THEN
    RAISE EXCEPTION 'Không có quyền lập hoặc xem hóa đơn tại tòa nhà này' USING ERRCODE='42501';
  END IF;
  IF p_billing_month IS NULL OR p_billing_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'Tháng hóa đơn không hợp lệ' USING ERRCODE='22023';
  END IF;
  WITH prices AS MATERIALIZED (
    SELECT c.id,app_private.room_transfer_invoice_rent_v1(org,c.id,p_billing_month) AS rent
      FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id
     WHERE c.organization_id=org AND r.building_id=p_building_id AND c.deleted_at IS NULL
       AND EXISTS(SELECT FROM app_private.room_transfer_rent_events e WHERE e.organization_id=org AND e.contract_id=c.id))
  SELECT coalesce(jsonb_object_agg(id,rent) FILTER(WHERE rent IS NOT NULL),'{}'::jsonb) INTO result FROM prices;
  RETURN result;
END $fn$;

-- Kể cả khi chưa từng chuyển: khóa phải đứng trước lần tạo hóa đơn trùng với
-- lần chuyển đầu tiên. Hai trình duyệt cùng lưu sẽ thấy chứng từ hoặc phải tải lại.
CREATE OR REPLACE FUNCTION app_private.lock_invoice_contract_for_room_transfer_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  PERFORM id FROM public.contracts WHERE id=NEW.contract_id AND organization_id=NEW.organization_id FOR KEY SHARE NOWAIT;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS room_transfer_lock_monthly_invoice ON public.invoices;
CREATE TRIGGER room_transfer_lock_monthly_invoice BEFORE INSERT ON public.invoices FOR EACH ROW
  WHEN (NEW.kind='MONTHLY') EXECUTE FUNCTION app_private.lock_invoice_contract_for_room_transfer_v1();

-- Tất cả đường lập hóa đơn (kể cả client cũ) phải thấy đúng số tiền như
-- preview. Kiểm sau khi writer đã lưu cả phần đầu và các dòng trong giao dịch.
CREATE OR REPLACE FUNCTION app_private.check_new_invoice_transfer_rent_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE inv record; line record; expected numeric; lines integer:=0; affected boolean:=false;
BEGIN
  SELECT * INTO inv FROM public.invoices WHERE id=NEW.id AND kind='MONTHLY' AND status<>'CANCELLED' AND deleted_at IS NULL;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM app_private.room_transfer_rent_events
    WHERE organization_id=inv.organization_id AND contract_id=inv.contract_id) THEN RETURN NULL; END IF;
  FOR line IN SELECT amount,from_date,to_date FROM public.invoice_items WHERE invoice_id=inv.id
    AND type='RENT' AND coalesce(accounting_class,'REVENUE')='REVENUE' LOOP
    lines:=lines+1;
    expected:=app_private.room_transfer_invoice_rent_v1(inv.organization_id,inv.contract_id,inv.billing_month,line.from_date,line.to_date);
    IF expected IS NOT NULL THEN
      affected:=true;
      IF line.amount IS DISTINCT FROM expected THEN
        RAISE EXCEPTION 'Tiền thuê kỳ chuyển phòng đã thay đổi. Tải lại số tiền trước khi lập hóa đơn.' USING ERRCODE='PT409';
      END IF;
    END IF;
  END LOOP;
  IF affected AND lines>1 THEN
    RAISE EXCEPTION 'Cần đối chiếu nhiều dòng tiền thuê trong kỳ chuyển phòng' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS room_transfer_check_new_invoice ON public.invoices;
CREATE CONSTRAINT TRIGGER room_transfer_check_new_invoice AFTER INSERT ON public.invoices DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.kind='MONTHLY') EXECUTE FUNCTION app_private.check_new_invoice_transfer_rent_v1();

-- Cả hai RPC sinh theo tòa dùng cùng writer này, gồm cả nhánh hỗ trợ tiền thuê.
DO $batch$ DECLARE f text; anchor text:='c.room_id, c.rent_price, r.building_id';
  begin_loop text:=E'  LOOP\n    IF EXISTS (';
BEGIN
  f:=pg_get_functiondef('public.generate_invoices_for_building(uuid,uuid,text,text)'::regprocedure);
  IF strpos(f,'app_private.room_transfer_invoice_rent_v1')=0 THEN
    IF strpos(f,anchor)=0 THEN RAISE EXCEPTION 'Thiếu trường giá thuê trong luồng lập hóa đơn theo tòa'; END IF;
    IF strpos(f,begin_loop)=0 THEN RAISE EXCEPTION 'Thiếu vòng lập hóa đơn theo tòa'; END IF;
    f:=replace(f,anchor,'c.room_id, c.organization_id, coalesce(app_private.room_transfer_invoice_rent_v1(c.organization_id,c.id,p_billing_month),c.rent_price) AS rent_price, r.building_id');
    EXECUTE replace(f,begin_loop,E'  LOOP\n    IF p_invoice_type=''rent_only'' AND v_contract.rent_price=0 AND app_private.room_transfer_sibling_rent_v1(v_contract.organization_id,v_contract.contract_id,p_billing_month,NULL,NULL)=0 THEN\n      v_skipped_contracts:=array_append(v_skipped_contracts,json_build_object(''contract_id'',v_contract.contract_id,''reason'',''Tiền thuê đã thuộc kỳ hóa đơn khác'')); CONTINUE;\n    END IF;\n    IF EXISTS (');
  END IF;
END $batch$;
REVOKE ALL ON FUNCTION app_private.room_transfer_invoice_rent_v1(uuid,uuid,text,date,date),
  app_private.lock_invoice_contract_for_room_transfer_v1(),app_private.check_new_invoice_transfer_rent_v1(),
  public.room_transfer_invoice_rents_v1(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.room_transfer_invoice_rents_v1(uuid,text) TO authenticated;
COMMIT;
