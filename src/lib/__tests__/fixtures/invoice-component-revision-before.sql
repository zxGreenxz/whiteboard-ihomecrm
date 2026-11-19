-- Read-only catalog capture of reviewed pre-fix function definitions; no business data.
CREATE OR REPLACE FUNCTION app_private.allocate_finance_collection_components_v1(p_collection_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE collection public.invoice_payment_collections%ROWTYPE; manifest uuid; component record;
  legacy_pnl numeric:=0; covered numeric; amount numeric; remaining numeric;
BEGIN
  SELECT * INTO collection FROM public.invoice_payment_collections WHERE id=p_collection_id FOR SHARE;
  IF NOT FOUND OR collection.status<>'ACTIVE' THEN RETURN; END IF;
  PERFORM 1 FROM public.invoices WHERE id=collection.invoice_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('invoice-component-allocation:'||collection.invoice_id::text,0));
  IF EXISTS(SELECT 1 FROM public.finance_invoice_component_allocations WHERE collection_id=p_collection_id) THEN RETURN; END IF;
  SELECT m.id INTO manifest FROM public.finance_invoice_component_manifests m WHERE m.invoice_id=collection.invoice_id
    AND m.organization_id=collection.organization_id AND m.component_status='COMPLETE' AND m.finalized_at IS NOT NULL
    AND ((collection.component_manifest_id IS NOT NULL AND m.id=collection.component_manifest_id)
      OR (collection.component_manifest_id IS NULL AND m.adjustment_revision=0));
  IF manifest IS NULL THEN RETURN; END IF;
  legacy_pnl:=app_private.proved_legacy_invoice_pnl_v2(collection.invoice_id,p_collection_id);
  IF legacy_pnl IS NULL THEN RETURN; END IF;
  remaining:=collection.applied_amount;
  IF remaining<=0 THEN RETURN; END IF;
  FOR component IN SELECT c.* FROM public.finance_invoice_components c WHERE c.manifest_id=manifest ORDER BY c.component_order,c.id LOOP
    SELECT coalesce(sum(a.amount),0) INTO covered FROM public.finance_invoice_component_allocations a
      JOIN public.invoice_payment_collections active_collection ON active_collection.id=a.collection_id AND active_collection.status='ACTIVE'
      JOIN public.finance_invoice_components prior_component ON prior_component.id=a.component_id
      WHERE a.invoice_id=collection.invoice_id AND a.collection_id<>p_collection_id AND prior_component.component_kind=component.component_kind;
    IF component.component_kind='CURRENT_CHARGE' THEN covered:=covered+legacy_pnl; END IF;
    amount:=least(remaining,greatest(component.amount-covered,0));
    IF amount>0 THEN
      INSERT INTO public.finance_invoice_component_allocations(organization_id,collection_id,invoice_id,component_id,amount)
        VALUES(collection.organization_id,p_collection_id,collection.invoice_id,component.id,amount);
      remaining:=remaining-amount;
    END IF;
    EXIT WHEN remaining=0;
  END LOOP;
  IF remaining<>0 THEN RAISE EXCEPTION 'Phân bổ thành phần không đủ; cần đối soát các lần thu trước' USING ERRCODE='55000'; END IF;
END $function$
;

CREATE OR REPLACE FUNCTION app_private.normalize_invoice_adjustment_items_v2(p_items jsonb, p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE x jsonb; result jsonb:='[]'; price numeric; qty numeric; coeff numeric; idx integer:=0;
  service uuid; item_type public.invoice_item_type; cls text; prev numeric; curr numeric;
BEGIN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)=0 OR jsonb_array_length(p_items)>500 THEN
    RAISE EXCEPTION 'Hóa đơn cần 1–500 hạng mục hợp lệ' USING ERRCODE='22023';
  END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    idx:=idx+1;
    IF jsonb_typeof(x) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Hạng mục phải là object' USING ERRCODE='22023'; END IF;
    IF jsonb_typeof(x->'description') IS DISTINCT FROM 'string' OR length(btrim(x->>'description'))=0 THEN
      RAISE EXCEPTION 'Hạng mục cần mô tả hợp lệ' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(x) k WHERE k NOT IN ('id','invoice_id','organization_id','created_at','updated_at',
      'service_id','type','description','unit_price','quantity','coefficient','amount','previous_reading','current_reading','from_date','to_date','sort_order','accounting_class')) THEN
      RAISE EXCEPTION 'Hạng mục chứa trường không được hỗ trợ; vui lòng tải lại' USING ERRCODE='22023'; END IF;
    BEGIN
      price:=coalesce((x->>'unit_price')::numeric,0); qty:=coalesce((x->>'quantity')::numeric,1); coeff:=coalesce((x->>'coefficient')::numeric,1);
      prev:=nullif(x->>'previous_reading','')::numeric; curr:=nullif(x->>'current_reading','')::numeric;
      item_type:=coalesce(nullif(x->>'type',''),'OTHER')::public.invoice_item_type;
      service:=nullif(x->>'service_id','')::uuid;
      cls:=x->>'accounting_class';
      IF cls IS NULL OR cls NOT IN ('REVENUE','DEPOSIT','NON_PNL')
        OR price<0 OR qty<0 OR coeff<0 OR price::text IN ('NaN','Infinity','-Infinity')
        OR qty::text IN ('NaN','Infinity','-Infinity') OR coeff::text IN ('NaN','Infinity','-Infinity')
        OR prev<0 OR curr<0 OR prev::text IN ('NaN','Infinity','-Infinity') OR curr::text IN ('NaN','Infinity','-Infinity')
        OR price*qty*coeff>=10000000000000 THEN
        RAISE EXCEPTION 'Giá, số lượng, hệ số hoặc phân loại hạng mục không hợp lệ' USING ERRCODE='22023';
      END IF;
      result:=result || jsonb_build_array(jsonb_build_object(
        'id',nullif(x->>'id','')::uuid,'type',item_type,'service_id',service,'description',x->>'description','unit_price',price,'quantity',qty,'coefficient',coeff,
        'amount',round(price*qty*coeff,2),'accounting_class',cls,'previous_reading',prev,'current_reading',curr,
        'from_date',nullif(x->>'from_date','')::date,'to_date',nullif(x->>'to_date','')::date,'sort_order',coalesce((x->>'sort_order')::integer,idx)));
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'Giá trị hạng mục không hợp lệ; vui lòng kiểm tra lại' USING ERRCODE='22023';
    END;
    IF service IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.services s WHERE s.id=service AND s.organization_id=p_organization_id AND s.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'Dịch vụ không thuộc tổ chức của hóa đơn' USING ERRCODE='42501';
    END IF;
  END LOOP;
  RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION app_private.pin_invoice_collection_manifest_v2()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE inv public.invoices%ROWTYPE; manifest uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.component_manifest_id IS DISTINCT FROM OLD.component_manifest_id OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      RAISE EXCEPTION 'Không được đổi phiên bản thành phần của lần thu tiền' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO inv FROM public.invoices WHERE id=NEW.invoice_id FOR UPDATE;
  IF NOT FOUND OR inv.organization_id IS DISTINCT FROM NEW.organization_id THEN RAISE EXCEPTION 'Collection không thuộc tổ chức hóa đơn' USING ERRCODE='42501'; END IF;
  manifest:=app_private.sync_finance_invoice_components_v1(inv.id);
  IF NEW.component_manifest_id IS NOT NULL AND NEW.component_manifest_id IS DISTINCT FROM manifest THEN
    RAISE EXCEPTION 'Phiên bản hóa đơn đã thay đổi; vui lòng tải lại' USING ERRCODE='PT409'; END IF;
  NEW.component_manifest_id:=manifest;
  RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION app_private.proved_legacy_invoice_pnl_v2(p_invoice_id uuid, p_exclude_collection_id uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE paid numeric; allocated numeric; allocated_pnl numeric; allocated_deposit numeric; allocated_internal numeric;
  semantic_pnl numeric; semantic_deposit numeric; semantic_internal numeric; residual numeric;
BEGIN
  SELECT coalesce(sum(p.amount),0) INTO paid FROM public.payments p
    LEFT JOIN public.invoice_payment_collections c ON c.id=p.collection_id
    WHERE p.invoice_id=p_invoice_id AND p.reversed_at IS NULL AND (p.collection_id IS NULL OR c.status='ACTIVE')
      AND (p_exclude_collection_id IS NULL OR p.collection_id IS DISTINCT FROM p_exclude_collection_id);
  SELECT coalesce(sum(a.amount),0),
    coalesce(sum(a.amount) FILTER(WHERE component.component_kind IN ('CURRENT_CHARGE','CARRIED_INVOICE_DEBT','SETTLEMENT')),0),
    coalesce(sum(a.amount) FILTER(WHERE component.component_kind IN ('CURRENT_DEPOSIT','CARRIED_DEPOSIT_DEBT')),0),
    coalesce(sum(a.amount) FILTER(WHERE component.component_kind='INTERNAL'),0)
    INTO allocated,allocated_pnl,allocated_deposit,allocated_internal
  FROM public.finance_invoice_component_allocations a
    JOIN public.invoice_payment_collections c ON c.id=a.collection_id AND c.status='ACTIVE'
    JOIN public.finance_invoice_components component ON component.id=a.component_id
    WHERE a.invoice_id=p_invoice_id AND a.collection_id IS DISTINCT FROM p_exclude_collection_id;
  residual:=paid-allocated;
  -- No missing allocation requires no legacy inference. In particular a fully
  -- allocated SETTLEMENT can itself contain several accounting semantics.
  IF abs(residual)<0.01 THEN RETURN 0; END IF;
  IF residual<0 OR residual::text IN ('NaN','Infinity','-Infinity') THEN RETURN NULL; END IF;
  SELECT coalesce(sum(coalesce(i.amount,i.unit_price*i.quantity)) FILTER(WHERE i.accounting_class='PNL'),0),
    coalesce(sum(coalesce(i.amount,i.unit_price*i.quantity)) FILTER(WHERE i.accounting_class='DEPOSIT'),0),
    coalesce(sum(coalesce(i.amount,i.unit_price*i.quantity)) FILTER(WHERE i.accounting_class='INTERNAL'),0)
    INTO semantic_pnl,semantic_deposit,semantic_internal
  FROM public.income_expenses v JOIN public.income_expense_items i ON i.income_expense_id=v.id
    LEFT JOIN public.invoice_payment_collections c ON c.id=v.payment_collection_id
    LEFT JOIN public.payments p ON p.id=v.payment_id
    WHERE v.invoice_id=p_invoice_id AND v.type='INCOME' AND v.approval_status='APPROVED' AND v.deleted_at IS NULL
      AND (v.payment_collection_id IS NULL OR c.status='ACTIVE') AND (v.payment_id IS NULL OR p.reversed_at IS NULL)
      AND (p_exclude_collection_id IS NULL OR (v.payment_collection_id IS DISTINCT FROM p_exclude_collection_id AND p.collection_id IS DISTINCT FROM p_exclude_collection_id));
  IF abs(semantic_pnl+semantic_deposit+semantic_internal-paid)>=0.01
    OR abs(semantic_deposit-allocated_deposit)>=0.01 OR abs(semantic_internal-allocated_internal)>=0.01
    OR abs((semantic_pnl-allocated_pnl)-residual)>=0.01
    OR NOT EXISTS(SELECT 1 FROM public.finance_invoice_component_manifests m JOIN public.finance_invoice_components c ON c.manifest_id=m.id
      WHERE m.invoice_id=p_invoice_id AND m.adjustment_revision=0 AND m.component_status='COMPLETE' AND m.finalized_at IS NOT NULL
      GROUP BY m.id HAVING count(*)=1 AND bool_and(c.component_kind='CURRENT_CHARGE') AND sum(c.amount)>=residual) THEN
    RETURN NULL;
  END IF;
  RETURN residual;
END $function$
;

CREATE OR REPLACE FUNCTION app_private.sync_finance_invoice_components_v1(p_invoice_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_invoice record;
  v_manifest_id uuid;
  v_manifest_finalized_at timestamptz;
  v_previous_invoice numeric := 0;
  v_previous_deposit numeric := 0;
  v_previous_source_total numeric := 0;
  v_invalid_source_count integer := 0;
  v_current_deposit numeric := 0;
  v_internal numeric := 0;
  v_current_charge numeric := 0;
  v_settlement numeric := 0;
  v_unclassified numeric := 0;
  v_component_total numeric := 0;
  v_status text := 'COMPLETE';
  v_anomaly text;
  v_should_finalize boolean;
BEGIN
  IF p_invoice_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT
    invoice_row.id,
    invoice_row.organization_id,
    invoice_row.kind,
    invoice_row.status::text AS status,
    COALESCE(invoice_row.total_amount, 0)::numeric AS total_amount,
    COALESCE(invoice_row.previous_debt, 0)::numeric AS previous_debt,
    COALESCE(invoice_row.previous_debt_sources, '[]'::jsonb) AS previous_debt_sources,
    invoice_row.updated_at,
    invoice_row.adjustment_revision
    INTO v_invoice
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id
    AND invoice_row.deleted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('invoice-components:' || p_invoice_id::text, 0));

  SELECT manifest.id, manifest.finalized_at
    INTO v_manifest_id, v_manifest_finalized_at
  FROM public.finance_invoice_component_manifests manifest
  WHERE manifest.invoice_id = p_invoice_id
    AND manifest.adjustment_revision = v_invoice.adjustment_revision
  FOR UPDATE;

  IF v_manifest_finalized_at IS NOT NULL THEN
    RETURN v_manifest_id;
  END IF;

  IF jsonb_typeof(v_invoice.previous_debt_sources) <> 'array' THEN
    v_invalid_source_count := 1;
  ELSE
    SELECT
      COALESCE(sum(
        CASE WHEN source.value->>'type' = 'invoice'
          AND COALESCE(source.value->>'amount', '') ~ '^[-+]?[0-9]+([.][0-9]+)?$'
          THEN (source.value->>'amount')::numeric ELSE 0 END
      ), 0),
      COALESCE(sum(
        CASE WHEN source.value->>'type' = 'deposit'
          AND COALESCE(source.value->>'amount', '') ~ '^[-+]?[0-9]+([.][0-9]+)?$'
          THEN (source.value->>'amount')::numeric ELSE 0 END
      ), 0),
      count(*) FILTER (
        WHERE source.value->>'type' NOT IN ('invoice', 'deposit')
          OR COALESCE(source.value->>'amount', '') !~ '^[-+]?[0-9]+([.][0-9]+)?$'
          OR CASE
            WHEN COALESCE(source.value->>'amount', '') ~ '^[-+]?[0-9]+([.][0-9]+)?$'
              THEN (source.value->>'amount')::numeric < 0
            ELSE false
          END
      )::integer
      INTO v_previous_invoice, v_previous_deposit, v_invalid_source_count
    FROM jsonb_array_elements(v_invoice.previous_debt_sources) source(value);
  END IF;

  v_previous_invoice := GREATEST(COALESCE(v_previous_invoice, 0), 0);
  v_previous_deposit := GREATEST(COALESCE(v_previous_deposit, 0), 0);
  v_previous_source_total := v_previous_invoice + v_previous_deposit;

  SELECT
    COALESCE(sum(item.amount) FILTER (WHERE item.accounting_class = 'DEPOSIT'), 0),
    COALESCE(sum(item.amount) FILTER (WHERE item.accounting_class = 'NON_PNL'), 0)
    INTO v_current_deposit, v_internal
  FROM public.invoice_items item
  WHERE item.invoice_id = p_invoice_id;

  v_current_deposit := GREATEST(COALESCE(v_current_deposit, 0), 0);
  v_internal := GREATEST(COALESCE(v_internal, 0), 0);

  IF v_invoice.kind = 'SETTLEMENT' THEN
    v_settlement := GREATEST(v_invoice.total_amount, 0);
    v_previous_invoice := 0;
    v_previous_deposit := 0;
    v_current_deposit := 0;
    v_internal := 0;
  ELSE
    IF v_invalid_source_count > 0
       OR abs(v_previous_source_total - v_invoice.previous_debt) >= 0.01 THEN
      v_unclassified := GREATEST(v_invoice.previous_debt, 0);
      v_previous_invoice := 0;
      v_previous_deposit := 0;
      v_status := 'ANOMALY';
      v_anomaly := 'PREVIOUS_DEBT_SOURCES_DO_NOT_RECONCILE';
    END IF;

    v_current_charge := v_invoice.total_amount
      - v_invoice.previous_debt
      - v_current_deposit
      - v_internal;
    IF v_current_charge < -0.01 THEN
      v_status := 'ANOMALY';
      v_anomaly := COALESCE(v_anomaly, 'CURRENT_COMPONENTS_EXCEED_INVOICE_TOTAL');
      v_unclassified := GREATEST(v_invoice.total_amount, 0);
      v_current_charge := 0;
      v_previous_invoice := 0;
      v_previous_deposit := 0;
      v_current_deposit := 0;
      v_internal := 0;
    ELSE
      v_current_charge := GREATEST(v_current_charge, 0);
    END IF;
  END IF;

  v_component_total := v_current_charge
    + v_previous_invoice
    + v_previous_deposit
    + v_current_deposit
    + v_internal
    + v_settlement
    + v_unclassified;
  IF abs(v_component_total - v_invoice.total_amount) >= 0.01 THEN
    v_status := 'ANOMALY';
    v_anomaly := COALESCE(v_anomaly, 'COMPONENT_TOTAL_DOES_NOT_RECONCILE');
  END IF;

  v_should_finalize := v_invoice.status IN (
    'APPROVED', 'PARTIAL_PAID', 'PAID', 'OVERDUE', 'CANCELLED'
  );

  IF v_manifest_id IS NULL THEN
    INSERT INTO public.finance_invoice_component_manifests (
      organization_id,
      invoice_id,
      component_status,
      invoice_total,
      component_total,
      component_version,
      anomaly_code,
      source_updated_at,
      captured_at,
      finalized_at, adjustment_revision, source_adjustment_id
    ) VALUES (
      v_invoice.organization_id,
      p_invoice_id,
      v_status,
      v_invoice.total_amount,
      v_component_total,
      1,
      v_anomaly,
      v_invoice.updated_at,
      clock_timestamp(),
      CASE WHEN v_should_finalize THEN clock_timestamp() ELSE NULL END,
      v_invoice.adjustment_revision,
      (SELECT a.id FROM public.invoice_adjustments a WHERE a.invoice_id=p_invoice_id AND a.revision=v_invoice.adjustment_revision)
    ) RETURNING id INTO v_manifest_id;
  ELSE
    DELETE FROM public.finance_invoice_components component
    WHERE component.manifest_id = v_manifest_id;
    UPDATE public.finance_invoice_component_manifests manifest
    SET
      component_status = v_status,
      invoice_total = v_invoice.total_amount,
      component_total = v_component_total,
      component_version = manifest.component_version + 1,
      anomaly_code = v_anomaly,
      source_updated_at = v_invoice.updated_at,
      captured_at = clock_timestamp(),
      finalized_at = CASE WHEN v_should_finalize THEN clock_timestamp() ELSE NULL END
    WHERE manifest.id = v_manifest_id;
  END IF;

  INSERT INTO public.finance_invoice_components (
    manifest_id, organization_id, invoice_id, component_kind, amount, component_order
  )
  SELECT v_manifest_id, v_invoice.organization_id, p_invoice_id, component.kind, component.amount, component.sort_order
  FROM (
    VALUES
      ('CARRIED_INVOICE_DEBT'::text, v_previous_invoice, 10),
      ('CURRENT_CHARGE'::text, v_current_charge, 20),
      ('CARRIED_DEPOSIT_DEBT'::text, v_previous_deposit, 30),
      ('CURRENT_DEPOSIT'::text, v_current_deposit, 40),
      ('INTERNAL'::text, v_internal, 50),
      ('SETTLEMENT'::text, v_settlement, 60),
      ('UNCLASSIFIED'::text, v_unclassified, 90)
  ) component(kind, amount, sort_order)
  WHERE component.amount > 0;

  RETURN v_manifest_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.adjust_invoice_v2(p_invoice_id uuid, p_after_items jsonb, p_discount_amount numeric, p_discount_notes text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_reason text DEFAULT NULL::text, p_expected_revision bigint DEFAULT NULL::bigint, p_expected_paid_amount numeric DEFAULT NULL::numeric, p_expected_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_idempotency_key text DEFAULT NULL::text)
 RETURNS invoice_adjustments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE inv public.invoices%ROWTYPE; result public.invoice_adjustments%ROWTYPE; actor uuid:=auth.uid();
  items jsonb; old_items jsonb; before_doc jsonb; after_doc jsonb; v_subtotal numeric; total numeric; discount numeric;
  key text:=btrim(p_idempotency_key); fingerprint text; x jsonb; manifest uuid; coverage record;
  paid_events numeric; allocated numeric; legacy_pnl numeric; allocated_current_charge numeric; revenue numeric; deposit numeric; internal_due numeric;
  revenue_covered numeric; deposit_covered numeric; internal_covered numeric;
BEGIN
  -- RENT_SUPPORT_LIFECYCLE_LOCK_V1
  PERFORM app_private.invoice_rent_support_lock_v1(p_invoice_id);
  IF actor IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
  SELECT * INTO inv FROM public.invoices WHERE id=p_invoice_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR public.can_access_building(inv.building_id) IS DISTINCT FROM true OR public.can_do_on_building('invoices','edit',inv.building_id) IS DISTINCT FROM true
    OR NOT EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=inv.building_id AND b.organization_id=inv.organization_id AND b.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Không có quyền điều chỉnh hóa đơn trong tổ chức/toà này' USING ERRCODE='42501';
  END IF;
  IF key IS NULL OR key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'Lý do phải dài 3–1000 ký tự và khóa yêu cầu phải hợp lệ' USING ERRCODE='22023';
  END IF;
  items:=app_private.normalize_invoice_adjustment_items_v2(p_after_items,inv.organization_id);
  discount:=coalesce(p_discount_amount,0);
  IF discount<0 OR discount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Giảm giá không hợp lệ' USING ERRCODE='22023'; END IF;
  fingerprint:=md5(jsonb_build_object('items',items,'discount',discount,'discount_notes',p_discount_notes,'notes',p_notes,'reason',btrim(p_reason),
    'revision',p_expected_revision,'paid',p_expected_paid_amount,'updated',p_expected_updated_at)::text);
  SELECT * INTO result FROM public.invoice_adjustments WHERE invoice_id=p_invoice_id AND idempotency_key=key;
  IF FOUND THEN
    IF result.request_fingerprint IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'Khóa yêu cầu đã dùng cho nội dung khác; vui lòng tải lại' USING ERRCODE='23505'; END IF;
  PERFORM app_private.meter_capture_assert_invoice_facts_v1(p_invoice_id);
  RETURN result;
  END IF;
  IF inv.status::text NOT IN ('APPROVED','PARTIAL_PAID','PAID','OVERDUE') THEN RAISE EXCEPTION 'Chỉ điều chỉnh hóa đơn đã phát hành' USING ERRCODE='55000'; END IF;
  IF p_expected_revision IS DISTINCT FROM inv.adjustment_revision OR p_expected_paid_amount IS DISTINCT FROM coalesce(inv.paid_amount,0)
    OR p_expected_updated_at IS DISTINCT FROM inv.updated_at THEN RAISE EXCEPTION 'Hóa đơn vừa thay đổi hoặc vừa thu tiền; vui lòng tải lại' USING ERRCODE='PT409'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(items) it WHERE it->>'id' IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM public.invoice_items old WHERE old.id=(it->>'id')::uuid AND old.invoice_id=p_invoice_id AND old.organization_id=inv.organization_id)) THEN
    RAISE EXCEPTION 'Hạng mục không thuộc hóa đơn/tổ chức' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT it->>'id' FROM jsonb_array_elements(items) it WHERE it->>'id' IS NOT NULL GROUP BY it->>'id' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Hạng mục bị lặp; vui lòng tải lại' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM public.invoice_payment_collections c WHERE c.invoice_id=p_invoice_id AND c.status='ACTIVE' AND c.rounding_amount<>0)
    OR EXISTS(SELECT 1 FROM public.payments p LEFT JOIN public.invoice_payment_collections c ON c.id=p.collection_id
      WHERE p.invoice_id=p_invoice_id AND p.reversed_at IS NULL AND p.rounding_amount<>0 AND (p.collection_id IS NULL OR c.status='ACTIVE'))
    OR EXISTS(SELECT 1 FROM public.income_expenses v WHERE v.invoice_id=p_invoice_id AND v.payment_collection_id IS NULL
      AND v.type='INCOME' AND v.approval_status='APPROVED' AND v.deleted_at IS NULL AND v.rounding_amount<>0)
    OR EXISTS(SELECT 1 FROM public.customer_credit_applications c WHERE c.invoice_id=p_invoice_id AND c.reversed_at IS NULL) THEN
    RAISE EXCEPTION 'Hóa đơn có làm tròn hoặc cấn trừ credit đang hiệu lực; đảo giao dịch trong Lịch sử thanh toán trước khi điều chỉnh' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.invoices later WHERE later.contract_id=inv.contract_id AND later.billing_month>inv.billing_month
    AND later.deleted_at IS NULL AND later.status::text<>'CANCELLED'
    AND later.previous_debt_sources @> jsonb_build_array(jsonb_build_object('type','invoice','id',p_invoice_id::text))) THEN
    RAISE EXCEPTION 'Nợ đã chuyển sang hóa đơn sau; cần tất toán hoặc xử lý hóa đơn sau trước khi điều chỉnh' USING ERRCODE='55000';
  END IF;
  SELECT sum((v->>'amount')::numeric) INTO v_subtotal FROM jsonb_array_elements(items) v;
  total:=app_private.round_invoice_total_v1(v_subtotal-discount+coalesce(inv.previous_debt,0));
  IF discount>v_subtotal OR total<0 OR total::text IN ('NaN','Infinity','-Infinity') OR total>=10000000000000 THEN
    RAISE EXCEPTION 'Giảm giá hoặc tổng tiền không hợp lệ' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.sort_order,i.id),'[]') INTO old_items FROM public.invoice_items i WHERE i.invoice_id=p_invoice_id;
  IF jsonb_array_length(old_items)>0 AND (SELECT jsonb_agg(it-'id') FROM jsonb_array_elements(items) it)
    =(SELECT jsonb_agg(it-'id') FROM jsonb_array_elements(app_private.normalize_invoice_adjustment_items_v2(old_items,inv.organization_id)) it)
    AND discount=coalesce(inv.discount_amount,0) AND p_discount_notes IS NOT DISTINCT FROM inv.discount_notes AND p_notes IS NOT DISTINCT FROM inv.notes THEN
    RAISE EXCEPTION 'Không có thay đổi nội dung hóa đơn' USING ERRCODE='22023';
  END IF;
  -- RENT_SUPPORT_ADJUSTMENT_V1: support snapshot stays fixed across the invoice revision.
  IF inv.rent_support_plan_revision IS NOT NULL THEN
    IF inv.invoice_support_amount>0 AND discount IS DISTINCT FROM inv.discount_amount THEN RAISE EXCEPTION 'Support discount changes require reconciliation' USING ERRCODE='PT409';END IF;
    IF discount<inv.invoice_support_amount+coalesce(inv.credit_discount_amount,0)
    OR inv.invoice_support_amount>greatest((SELECT coalesce(sum((support_line.value->>'amount')::numeric) FILTER(WHERE support_line.value->>'accounting_class'='REVENUE'),0) FROM jsonb_array_elements(items) support_line(value))-coalesce(inv.manual_discount_amount,0)-coalesce(inv.credit_discount_amount,0),0) THEN
    RAISE EXCEPTION 'REVENUE_CAP_REVIEW' USING ERRCODE='PT409';END IF;
  END IF;
  -- Capture the original revision before replacing its current document.
  PERFORM app_private.sync_finance_invoice_components_v1(p_invoice_id);
  before_doc:=to_jsonb(inv)||jsonb_build_object('items',old_items);
  -- Allocate new IDs only after replay and no-op checks. Existing rows keep
  -- their identity and original timestamp; the stored replay returns these IDs.
  SELECT jsonb_agg(it||jsonb_build_object('id',coalesce((it->>'id')::uuid,gen_random_uuid()),
      'created_at',coalesce((SELECT old.created_at FROM public.invoice_items old WHERE old.id=(it->>'id')::uuid),clock_timestamp())) ORDER BY ord)
    INTO items FROM jsonb_array_elements(items) WITH ORDINALITY row_item(it,ord);
  INSERT INTO public.invoice_adjustments(organization_id,invoice_id,revision,idempotency_key,request_fingerprint,reason,before_snapshot,after_snapshot,before_total,after_total,delta,adjusted_by)
    VALUES(inv.organization_id,p_invoice_id,inv.adjustment_revision+1,key,fingerprint,btrim(p_reason),before_doc,
      to_jsonb(inv)||jsonb_build_object('items',items,'subtotal',v_subtotal,'total_amount',total,'discount_amount',discount,'discount_notes',p_discount_notes,'notes',p_notes,
        'adjustment_revision',inv.adjustment_revision+1,'adjustment_review_status','PENDING'),
      inv.total_amount,total,total-inv.total_amount,actor) RETURNING * INTO result;
  -- Replace lines while the old finalized revision is still current. Even
  -- SET CONSTRAINTS ALL IMMEDIATE must never freeze an incomplete new document.
  -- RENT_SUPPORT_ITEM_CAPABILITY_V1
  PERFORM app_private.invoice_rent_support_items_open_v1(p_invoice_id);
  SET CONSTRAINTS public.meter_capture_invoice_items_consistent DEFERRED;
DELETE FROM public.invoice_items WHERE invoice_id=p_invoice_id;
  FOR x IN SELECT value FROM jsonb_array_elements(items) LOOP
    INSERT INTO public.invoice_items(id,created_at,invoice_id,organization_id,service_id,type,description,unit_price,quantity,coefficient,amount,previous_reading,current_reading,from_date,to_date,sort_order,accounting_class)
    VALUES((x->>'id')::uuid,(x->>'created_at')::timestamptz,p_invoice_id,inv.organization_id,(x->>'service_id')::uuid,(x->>'type')::public.invoice_item_type,x->>'description',(x->>'unit_price')::numeric,
      (x->>'quantity')::numeric,(x->>'coefficient')::numeric,(x->>'amount')::numeric,(x->>'previous_reading')::numeric,(x->>'current_reading')::numeric,
      (x->>'from_date')::date,(x->>'to_date')::date,(x->>'sort_order')::integer,x->>'accounting_class');
  END LOOP;
  UPDATE public.invoices SET manual_discount_amount=CASE WHEN inv.rent_support_plan_revision IS NOT NULL THEN discount-inv.invoice_support_amount-coalesce(inv.credit_discount_amount,0) ELSE manual_discount_amount END,subtotal=v_subtotal, total_amount=total,discount_amount=discount,discount_notes=p_discount_notes,notes=p_notes,
    adjustment_revision=result.revision,adjustment_review_status='PENDING',updated_at=clock_timestamp() WHERE id=p_invoice_id;
  manifest:=app_private.sync_finance_invoice_components_v1(p_invoice_id);
  IF NOT EXISTS(SELECT 1 FROM public.finance_invoice_component_manifests m WHERE m.id=manifest AND m.component_status='COMPLETE') THEN
    RAISE EXCEPTION 'Cơ cấu hóa đơn chưa đối soát; cần kiểm tra kế toán trước khi điều chỉnh' USING ERRCODE='55000'; END IF;
  SELECT coalesce(sum(c.amount) FILTER(WHERE c.component_kind IN ('CURRENT_CHARGE','CARRIED_INVOICE_DEBT','SETTLEMENT')),0),
    coalesce(sum(c.amount) FILTER(WHERE c.component_kind IN ('CURRENT_DEPOSIT','CARRIED_DEPOSIT_DEBT')),0),
    coalesce(sum(c.amount) FILTER(WHERE c.component_kind='INTERNAL'),0) INTO revenue,deposit,internal_due
    FROM public.finance_invoice_components c WHERE c.manifest_id=manifest;
  SELECT coalesce(sum(coalesce(i.amount,i.unit_price*i.quantity)) FILTER(WHERE i.accounting_class='PNL'),0),
    coalesce(sum(coalesce(i.amount,i.unit_price*i.quantity)) FILTER(WHERE i.accounting_class='DEPOSIT'),0),
    coalesce(sum(coalesce(i.amount,i.unit_price*i.quantity)) FILTER(WHERE i.accounting_class='INTERNAL'),0)
    INTO revenue_covered,deposit_covered,internal_covered
  FROM public.income_expenses v JOIN public.income_expense_items i ON i.income_expense_id=v.id
  LEFT JOIN public.invoice_payment_collections c ON c.id=v.payment_collection_id LEFT JOIN public.payments p ON p.id=v.payment_id
  WHERE v.invoice_id=p_invoice_id AND v.type='INCOME' AND v.approval_status='APPROVED' AND v.deleted_at IS NULL
    AND (v.payment_collection_id IS NULL OR c.status='ACTIVE') AND (v.payment_id IS NULL OR p.reversed_at IS NULL);
  SELECT coalesce(sum(p.amount),0) INTO paid_events FROM public.payments p LEFT JOIN public.invoice_payment_collections c ON c.id=p.collection_id
    WHERE p.invoice_id=p_invoice_id AND p.reversed_at IS NULL AND (p.collection_id IS NULL OR c.status='ACTIVE');
  SELECT coalesce(sum(a.amount),0) INTO allocated FROM public.finance_invoice_component_allocations a
    JOIN public.invoice_payment_collections c ON c.id=a.collection_id AND c.status='ACTIVE' WHERE a.invoice_id=p_invoice_id;
  IF total<coalesce(inv.paid_amount,0) OR revenue<revenue_covered OR deposit<deposit_covered OR internal_due<internal_covered THEN
    RAISE EXCEPTION 'Nội dung mới thấp hơn tiền đã phân bổ; đảo giao dịch trong Lịch sử thanh toán trước khi điều chỉnh' USING ERRCODE='55000'; END IF;
  IF abs(paid_events-coalesce(inv.paid_amount,0))>=0.01 OR abs(revenue_covered+deposit_covered+internal_covered-paid_events)>=0.01 THEN
    RAISE EXCEPTION 'Tiền đã thu chưa đối soát với bút toán; cần đối soát hoặc đảo giao dịch trong Lịch sử thanh toán' USING ERRCODE='55000'; END IF;
  FOR coverage IN SELECT old_c.component_kind,sum(a.amount) AS amount FROM public.finance_invoice_component_allocations a
    JOIN public.invoice_payment_collections c ON c.id=a.collection_id AND c.status='ACTIVE'
    JOIN public.finance_invoice_components old_c ON old_c.id=a.component_id WHERE a.invoice_id=p_invoice_id GROUP BY old_c.component_kind LOOP
    IF coverage.amount>coalesce((SELECT amount FROM public.finance_invoice_components c WHERE c.manifest_id=manifest AND c.component_kind=coverage.component_kind),0) THEN
      RAISE EXCEPTION 'Thành phần % thấp hơn tiền đã phân bổ; đảo giao dịch trong Lịch sử thanh toán trước',coverage.component_kind USING ERRCODE='55000'; END IF;
  END LOOP;
  IF abs(paid_events-allocated)>=0.01 THEN
    legacy_pnl:=app_private.proved_legacy_invoice_pnl_v2(p_invoice_id);
    SELECT coalesce(sum(a.amount),0) INTO allocated_current_charge FROM public.finance_invoice_component_allocations a
      JOIN public.invoice_payment_collections c ON c.id=a.collection_id AND c.status='ACTIVE'
      JOIN public.finance_invoice_components component ON component.id=a.component_id
      WHERE a.invoice_id=p_invoice_id AND component.component_kind='CURRENT_CHARGE';
    IF legacy_pnl IS NULL
      OR coalesce((SELECT amount FROM public.finance_invoice_components WHERE manifest_id=manifest AND component_kind='CURRENT_CHARGE'),0)<allocated_current_charge+legacy_pnl THEN
      RAISE EXCEPTION 'Phân bổ lịch sử hỗn hợp chưa chứng minh được; cần đối soát hoặc đảo giao dịch trong Lịch sử thanh toán' USING ERRCODE='55000';
    END IF;
  END IF;
  PERFORM app_private.invoice_rent_support_items_close_v1(p_invoice_id);
  PERFORM public.recompute_invoice_for_id(p_invoice_id);
  IF inv.invoice_support_amount>0 THEN
    INSERT INTO app_private.rent_support_invoice_events(organization_id,contract_id,claim_id,invoice_id,actor_id,request_id,action,payload_hash,before_snapshot,after_snapshot,reason)
    SELECT c.organization_id,c.contract_id,c.id,p_invoice_id,actor,md5('support.adjust|'||p_invoice_id::text||'|'||key)::uuid,'APPLIED',fingerprint,to_jsonb(c),jsonb_build_object('invoice_revision',result.revision,'claimed_amount',c.claimed_amount),p_reason
    FROM app_private.rent_support_invoice_claims c WHERE c.invoice_id=p_invoice_id AND c.released_at IS NULL;
    UPDATE app_private.rent_support_invoice_claims SET invoice_revision=result.revision,version=version+1 WHERE invoice_id=p_invoice_id AND released_at IS NULL;
  END IF;
PERFORM app_private.meter_capture_assert_invoice_facts_v1(p_invoice_id);
  RETURN result;
END $function$
;

