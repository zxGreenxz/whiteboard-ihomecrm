BEGIN;

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS adjustment_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS adjustment_review_status text NOT NULL DEFAULT 'NONE';
ALTER TABLE public.invoice_adjustments ADD COLUMN IF NOT EXISTS request_fingerprint text;
ALTER TABLE public.finance_invoice_component_manifests ADD COLUMN IF NOT EXISTS adjustment_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE public.finance_invoice_component_manifests ADD COLUMN IF NOT EXISTS source_adjustment_id uuid;
ALTER TABLE public.invoice_payment_collections ADD COLUMN IF NOT EXISTS component_manifest_id uuid;
ALTER TABLE public.finance_invoice_component_manifests DROP CONSTRAINT IF EXISTS finance_invoice_component_manifests_invoice_uq;
CREATE UNIQUE INDEX IF NOT EXISTS finance_component_manifest_revision_uq ON public.finance_invoice_component_manifests(invoice_id,adjustment_revision);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_adjustments_identity_org_uq ON public.invoice_adjustments(id,invoice_id,organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS finance_manifest_identity_org_uq ON public.finance_invoice_component_manifests(id,invoice_id,organization_id);
DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.invoices'::regclass AND conname='invoices_adjustment_summary_check') THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_adjustment_summary_check CHECK (adjustment_revision>=0 AND adjustment_review_status IN ('NONE','PENDING','CHECKED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.finance_invoice_component_manifests'::regclass AND conname='finance_manifest_adjustment_identity_fkey') THEN
    ALTER TABLE public.finance_invoice_component_manifests ADD CONSTRAINT finance_manifest_adjustment_identity_fkey
      FOREIGN KEY(source_adjustment_id,invoice_id,organization_id) REFERENCES public.invoice_adjustments(id,invoice_id,organization_id) ON DELETE RESTRICT;
    ALTER TABLE public.finance_invoice_component_manifests ADD CONSTRAINT finance_manifest_revision_check
      CHECK ((adjustment_revision=0 AND source_adjustment_id IS NULL) OR (adjustment_revision>0 AND source_adjustment_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.invoice_payment_collections'::regclass AND conname='collection_component_manifest_identity_fkey') THEN
    ALTER TABLE public.invoice_payment_collections ADD CONSTRAINT collection_component_manifest_identity_fkey
      FOREIGN KEY(component_manifest_id,invoice_id,organization_id) REFERENCES public.finance_invoice_component_manifests(id,invoice_id,organization_id) ON DELETE RESTRICT;
  END IF;
END $constraints$;

-- Populate only missing summaries. Historical financial manifests stay revision zero.
UPDATE public.invoices i SET adjustment_revision=a.revision, adjustment_review_status=a.review_status
FROM (SELECT DISTINCT ON(invoice_id) invoice_id,revision,review_status FROM public.invoice_adjustments ORDER BY invoice_id,revision DESC) a
WHERE i.id=a.invoice_id AND i.adjustment_revision<a.revision;

CREATE OR REPLACE FUNCTION app_private.normalize_invoice_adjustment_items_v2(p_items jsonb,p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
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
END $$;
REVOKE ALL ON FUNCTION app_private.normalize_invoice_adjustment_items_v2(jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- NULL means the missing financial allocation cannot be proved. Known newer
-- allocations are subtracted by semantic class before examining the legacy
-- residual; the shape of the latest obligation never supplies that evidence.
CREATE OR REPLACE FUNCTION app_private.proved_legacy_invoice_pnl_v2(p_invoice_id uuid,p_exclude_collection_id uuid DEFAULT NULL)
RETURNS numeric LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
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
END $$;
REVOKE ALL ON FUNCTION app_private.proved_legacy_invoice_pnl_v2(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.guard_paid_invoice_direct_adjustment()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE parents uuid[]:='{}'; parent record;
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF TG_TABLE_NAME='invoices' THEN
      IF TG_OP='UPDATE' THEN
        IF OLD.status::text NOT IN ('DRAFT','PENDING_APPROVAL') AND NEW.status::text IN ('DRAFT','PENDING_APPROVAL') THEN
          RAISE EXCEPTION 'Không được mở lại bản nháp để bỏ qua lịch sử điều chỉnh' USING ERRCODE='42501'; END IF;
        IF (coalesce(OLD.paid_amount,0)>0 OR OLD.adjustment_revision>0 OR OLD.status::text NOT IN ('DRAFT','PENDING_APPROVAL'))
          AND (to_jsonb(NEW)-'paid_amount'-'status'-'updated_at' IS DISTINCT FROM to_jsonb(OLD)-'paid_amount'-'status'-'updated_at') THEN
          RAISE EXCEPTION 'Hóa đơn đã phát hành cần điều chỉnh qua RPC; vui lòng tải lại' USING ERRCODE='42501';
        END IF;
        IF NEW.adjustment_revision IS DISTINCT FROM OLD.adjustment_revision OR NEW.adjustment_review_status IS DISTINCT FROM OLD.adjustment_review_status THEN
          RAISE EXCEPTION 'Không được sửa trực tiếp lịch sử điều chỉnh' USING ERRCODE='42501';
        END IF;
      END IF;
    ELSIF TG_TABLE_NAME='invoice_items' THEN
      IF TG_OP IN ('UPDATE','DELETE') THEN parents:=array_append(parents,OLD.invoice_id); END IF;
      IF TG_OP IN ('INSERT','UPDATE') THEN parents:=array_append(parents,NEW.invoice_id); END IF;
      FOR parent IN SELECT i.* FROM public.invoices i WHERE i.id=ANY(parents) ORDER BY i.id FOR UPDATE LOOP
        IF coalesce(parent.paid_amount,0)>0 OR parent.adjustment_revision>0 OR parent.status::text NOT IN ('DRAFT','PENDING_APPROVAL') THEN
          RAISE EXCEPTION 'Hạng mục đã phát hành cần điều chỉnh qua RPC; vui lòng tải lại' USING ERRCODE='42501';
        END IF;
      END LOOP;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS guard_paid_invoice_direct_adjustment ON public.invoices;
CREATE TRIGGER guard_paid_invoice_direct_adjustment BEFORE UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.guard_paid_invoice_direct_adjustment();
DROP TRIGGER IF EXISTS guard_paid_invoice_item_direct_adjustment ON public.invoice_items;
CREATE TRIGGER guard_paid_invoice_item_direct_adjustment BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_items FOR EACH ROW EXECUTE FUNCTION public.guard_paid_invoice_direct_adjustment();

CREATE OR REPLACE FUNCTION public.guard_invoice_adjustment_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Lịch sử điều chỉnh là bất biến' USING ERRCODE='42501'; END IF;
  IF current_user IN ('authenticated','anon','service_role') OR OLD.review_status<>'PENDING' OR NEW.review_status<>'CHECKED'
    OR NEW.checked_by IS NULL OR NEW.checked_at IS NULL
    OR (to_jsonb(NEW)-'review_status'-'checked_by'-'checked_at') IS DISTINCT FROM (to_jsonb(OLD)-'review_status'-'checked_by'-'checked_at') THEN
    RAISE EXCEPTION 'Chỉ được xác nhận kiểm tra; snapshot điều chỉnh là bất biến' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS invoice_adjustments_immutable ON public.invoice_adjustments;
CREATE TRIGGER invoice_adjustments_immutable BEFORE UPDATE OR DELETE ON public.invoice_adjustments FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_adjustment_immutable();
ALTER TABLE public.invoice_adjustments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_adjustments_select_scope ON public.invoice_adjustments;
CREATE POLICY invoice_adjustments_select_scope ON public.invoice_adjustments FOR SELECT TO authenticated
  USING (EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=invoice_id AND i.organization_id=invoice_adjustments.organization_id
    AND public.can_access_building(i.building_id) AND public.can_do_on_building('invoices','view',i.building_id)));
DROP POLICY IF EXISTS invoice_adjustments_hide_sandbox_admin ON public.invoice_adjustments;
CREATE POLICY invoice_adjustments_hide_sandbox_admin ON public.invoice_adjustments AS RESTRICTIVE FOR ALL TO authenticated
  USING(NOT((SELECT public.is_super_admin()) AND coalesce(organization_id=ANY(public.sandbox_org_ids()),false)));
REVOKE ALL ON public.invoice_adjustments FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.invoice_adjustments TO authenticated;

CREATE OR REPLACE FUNCTION public.adjust_invoice_v2(
  p_invoice_id uuid,p_after_items jsonb,p_discount_amount numeric,p_discount_notes text,p_notes text,p_reason text,
  p_expected_revision bigint,p_expected_paid_amount numeric,p_expected_updated_at timestamptz,p_idempotency_key text
) RETURNS public.invoice_adjustments LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE inv public.invoices%ROWTYPE; result public.invoice_adjustments%ROWTYPE; actor uuid:=auth.uid();
  items jsonb; old_items jsonb; before_doc jsonb; after_doc jsonb; v_subtotal numeric; total numeric; discount numeric;
  key text:=btrim(p_idempotency_key); fingerprint text; x jsonb; manifest uuid; coverage record;
  paid_events numeric; allocated numeric; legacy_pnl numeric; allocated_current_charge numeric; revenue numeric; deposit numeric; internal_due numeric;
  revenue_covered numeric; deposit_covered numeric; internal_covered numeric;
BEGIN
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
    RETURN result;
  END IF;
  IF inv.status::text NOT IN ('APPROVED','PARTIAL_PAID','PAID','OVERDUE') THEN RAISE EXCEPTION 'Chỉ điều chỉnh hóa đơn đã phát hành' USING ERRCODE='55000'; END IF;
  IF p_expected_revision IS DISTINCT FROM inv.adjustment_revision OR p_expected_paid_amount IS DISTINCT FROM coalesce(inv.paid_amount,0)
    OR p_expected_updated_at IS DISTINCT FROM inv.updated_at THEN RAISE EXCEPTION 'Hóa đơn vừa thay đổi hoặc vừa thu tiền; vui lòng tải lại' USING ERRCODE='40001'; END IF;
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
  DELETE FROM public.invoice_items WHERE invoice_id=p_invoice_id;
  FOR x IN SELECT value FROM jsonb_array_elements(items) LOOP
    INSERT INTO public.invoice_items(id,created_at,invoice_id,organization_id,service_id,type,description,unit_price,quantity,coefficient,amount,previous_reading,current_reading,from_date,to_date,sort_order,accounting_class)
    VALUES((x->>'id')::uuid,(x->>'created_at')::timestamptz,p_invoice_id,inv.organization_id,(x->>'service_id')::uuid,(x->>'type')::public.invoice_item_type,x->>'description',(x->>'unit_price')::numeric,
      (x->>'quantity')::numeric,(x->>'coefficient')::numeric,(x->>'amount')::numeric,(x->>'previous_reading')::numeric,(x->>'current_reading')::numeric,
      (x->>'from_date')::date,(x->>'to_date')::date,(x->>'sort_order')::integer,x->>'accounting_class');
  END LOOP;
  UPDATE public.invoices SET subtotal=v_subtotal, total_amount=total,discount_amount=discount,discount_notes=p_discount_notes,notes=p_notes,
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
  PERFORM public.recompute_invoice_for_id(p_invoice_id);
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.review_invoice_adjustment_v2(p_adjustment_id uuid,p_expected_revision bigint)
RETURNS public.invoice_adjustments LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE result public.invoice_adjustments%ROWTYPE; inv public.invoices%ROWTYPE; invoice_id uuid;
BEGIN
  SELECT a.invoice_id INTO invoice_id FROM public.invoice_adjustments a WHERE a.id=p_adjustment_id;
  SELECT * INTO inv FROM public.invoices i WHERE i.id=invoice_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR public.can_access_building(inv.building_id) IS DISTINCT FROM true OR public.can_do_on_building('invoices','approve',inv.building_id) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Không có quyền xác nhận kiểm tra' USING ERRCODE='42501'; END IF;
  SELECT * INTO result FROM public.invoice_adjustments WHERE id=p_adjustment_id FOR UPDATE;
  IF result.organization_id IS DISTINCT FROM inv.organization_id THEN RAISE EXCEPTION 'Điều chỉnh không thuộc tổ chức' USING ERRCODE='42501'; END IF;
  IF p_expected_revision IS DISTINCT FROM inv.adjustment_revision OR result.revision IS DISTINCT FROM inv.adjustment_revision THEN
    RAISE EXCEPTION 'Hóa đơn đã có phiên bản mới; vui lòng tải lại trước khi kiểm tra' USING ERRCODE='40001'; END IF;
  IF result.review_status='CHECKED' THEN RETURN result; END IF;
  UPDATE public.invoice_adjustments SET review_status='CHECKED',checked_by=auth.uid(),checked_at=clock_timestamp() WHERE id=p_adjustment_id RETURNING * INTO result;
  UPDATE public.invoices SET adjustment_review_status='CHECKED',updated_at=clock_timestamp() WHERE id=inv.id;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.adjust_invoice_v1(p_invoice_id uuid,p_after_items jsonb,p_reason text,p_idempotency_key text)
RETURNS public.invoice_adjustments LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Phiên bản điều chỉnh đã thay đổi; vui lòng tải lại ứng dụng' USING ERRCODE='55000'; END $$;
CREATE OR REPLACE FUNCTION public.review_invoice_adjustment_v1(p_adjustment_id uuid)
RETURNS public.invoice_adjustments LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Phiên bản kiểm tra đã thay đổi; vui lòng tải lại ứng dụng' USING ERRCODE='55000'; END $$;
REVOKE ALL ON FUNCTION public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamptz,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamptz,text) TO authenticated;
REVOKE ALL ON FUNCTION public.review_invoice_adjustment_v2(uuid,bigint) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.review_invoice_adjustment_v2(uuid,bigint) TO authenticated;
REVOKE ALL ON FUNCTION public.adjust_invoice_v1(uuid,jsonb,text,text),public.review_invoice_adjustment_v1(uuid) FROM PUBLIC,anon,service_role;

CREATE OR REPLACE FUNCTION app_private.pin_invoice_collection_manifest_v2()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
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
    RAISE EXCEPTION 'Phiên bản hóa đơn đã thay đổi; vui lòng tải lại' USING ERRCODE='40001'; END IF;
  NEW.component_manifest_id:=manifest;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.pin_invoice_collection_manifest_v2() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS pin_invoice_collection_manifest_v2 ON public.invoice_payment_collections;
CREATE TRIGGER pin_invoice_collection_manifest_v2 BEFORE INSERT OR UPDATE ON public.invoice_payment_collections FOR EACH ROW EXECUTE FUNCTION app_private.pin_invoice_collection_manifest_v2();

CREATE OR REPLACE FUNCTION app_private.allocate_finance_collection_components_v1(p_collection_id uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,app_private,public AS $$
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
END $$;
REVOKE ALL ON FUNCTION app_private.allocate_finance_collection_components_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.sync_finance_invoice_components_v1(
  p_invoice_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $sync_finance_invoice_components$
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
$sync_finance_invoice_components$;

REVOKE ALL ON FUNCTION app_private.sync_finance_invoice_components_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;


CREATE OR REPLACE FUNCTION public.business_performance_invoice_cohort_v1(
  p_organization_id uuid,
  p_cohort_month date,
  p_building_ids uuid[]
)
RETURNS TABLE(
  building_id uuid,
  building_name text,
  cohort_month date,
  cohort_available boolean,
  billed_current_charge numeric,
  collected_current_charge numeric,
  remaining_current_charge numeric,
  collection_rate_pct numeric,
  invoice_count integer,
  allocation_unknown_count integer,
  allocation_unknown_amount numeric,
  component_anomaly_count integer,
  carried_invoice_debt numeric,
  carried_deposit_debt numeric,
  current_deposit numeric,
  draft_pending_count integer,
  draft_pending_amount numeric,
  settlement_count integer,
  settlement_amount numeric,
  generated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $business_performance_invoice_cohort$
DECLARE
  v_building_ids uuid[];
BEGIN
  SELECT scope.building_ids
    INTO v_building_ids
  FROM app_private.business_performance_exact_scope_v1(
    p_organization_id => p_organization_id,
    p_building_ids => p_building_ids,
    p_require_restricted => true
  ) AS scope;

  IF p_cohort_month IS NULL
     OR p_cohort_month <> date_trunc('month', p_cohort_month)::date THEN
    RAISE EXCEPTION 'Invoice cohort month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH requested_buildings AS MATERIALIZED (
    SELECT building_row.id,
           COALESCE(NULLIF(btrim(building_row.name), ''), 'Unnamed building') AS name
    FROM public.buildings building_row
    WHERE building_row.organization_id = p_organization_id
      AND building_row.deleted_at IS NULL
      AND building_row.is_virtual = false
      AND building_row.id = ANY(v_building_ids)
  ),
  issued AS MATERIALIZED (
    SELECT invoice_row.*
    FROM public.invoices invoice_row
    WHERE invoice_row.organization_id = p_organization_id
      AND invoice_row.building_id = ANY(v_building_ids)
      AND invoice_row.deleted_at IS NULL
      AND invoice_row.kind = 'MONTHLY'
      AND invoice_row.billing_month = to_char(p_cohort_month, 'YYYY-MM')
      AND invoice_row.status::text IN ('APPROVED', 'PARTIAL_PAID', 'PAID', 'OVERDUE')
  ),
  component_pivot AS MATERIALIZED (
    SELECT
      invoice_row.id AS invoice_id,
      manifest.component_status,
      manifest.finalized_at,
      count(component.id) FILTER (WHERE component.amount > 0)::integer AS positive_component_count,
      COALESCE(sum(component.amount) FILTER (WHERE component.component_kind = 'CURRENT_CHARGE'), 0)::numeric AS current_charge,
      COALESCE(sum(component.amount) FILTER (WHERE component.component_kind = 'CARRIED_INVOICE_DEBT'), 0)::numeric AS carried_invoice_debt,
      COALESCE(sum(component.amount) FILTER (WHERE component.component_kind = 'CARRIED_DEPOSIT_DEBT'), 0)::numeric AS carried_deposit_debt,
      COALESCE(sum(component.amount) FILTER (WHERE component.component_kind = 'CURRENT_DEPOSIT'), 0)::numeric AS current_deposit
    FROM issued invoice_row
    LEFT JOIN public.finance_invoice_component_manifests manifest
      ON manifest.invoice_id = invoice_row.id
     AND manifest.adjustment_revision = invoice_row.adjustment_revision
    LEFT JOIN public.finance_invoice_components component
      ON component.manifest_id = manifest.id
    GROUP BY invoice_row.id, manifest.component_status, manifest.finalized_at
  ),
  payment_events AS MATERIALIZED (
    SELECT
      invoice_row.id AS invoice_id,
      COALESCE(sum(payment_row.amount) FILTER (
        WHERE payment_row.reversed_at IS NULL
          AND (payment_row.collection_id IS NULL OR collection_row.status = 'ACTIVE')
      ), 0)::numeric AS paid_event_amount
    FROM issued invoice_row
    LEFT JOIN public.payments payment_row
      ON payment_row.invoice_id = invoice_row.id
    LEFT JOIN public.invoice_payment_collections collection_row
      ON collection_row.id = payment_row.collection_id
    GROUP BY invoice_row.id
  ),
  allocation_facts AS MATERIALIZED (
    SELECT
      invoice_row.id AS invoice_id,
      COALESCE(sum(allocation.amount) FILTER (
        WHERE allocation_collection.status = 'ACTIVE'
      ), 0)::numeric AS allocated_amount,
      COALESCE(sum(allocation.amount) FILTER (
        WHERE allocation_collection.status = 'ACTIVE'
          AND component.component_kind = 'CURRENT_CHARGE'
      ), 0)::numeric AS allocated_current_charge
    FROM issued invoice_row
    LEFT JOIN public.finance_invoice_component_allocations allocation
      ON allocation.invoice_id = invoice_row.id
    LEFT JOIN public.invoice_payment_collections allocation_collection
      ON allocation_collection.id = allocation.collection_id
    LEFT JOIN public.finance_invoice_components component
      ON component.id = allocation.component_id
    GROUP BY invoice_row.id
  ),
  legacy_coverage AS MATERIALIZED (
    SELECT invoice_row.id AS invoice_id,
      app_private.proved_legacy_invoice_pnl_v2(invoice_row.id) AS legacy_pnl
    FROM issued invoice_row
  ),
  payment_facts AS MATERIALIZED (
    SELECT
      invoice_row.id AS invoice_id,
      COALESCE(payment_row.paid_event_amount, 0)::numeric AS paid_event_amount,
      COALESCE(allocation_row.allocated_amount, 0)::numeric AS allocated_amount,
      COALESCE(allocation_row.allocated_current_charge, 0)::numeric AS allocated_current_charge,
      legacy_row.legacy_pnl
    FROM issued invoice_row
    LEFT JOIN payment_events payment_row ON payment_row.invoice_id = invoice_row.id
    LEFT JOIN allocation_facts allocation_row ON allocation_row.invoice_id = invoice_row.id
    LEFT JOIN legacy_coverage legacy_row ON legacy_row.invoice_id = invoice_row.id
  ),
  per_invoice AS MATERIALIZED (
    SELECT
      invoice_row.id,
      invoice_row.building_id,
      invoice_row.total_amount,
      invoice_row.paid_amount,
      component_row.component_status,
      component_row.current_charge,
      component_row.carried_invoice_debt,
      component_row.carried_deposit_debt,
      component_row.current_deposit,
      payment_row.paid_event_amount,
      payment_row.allocated_amount,
      CASE
        WHEN component_row.component_status = 'COMPLETE'
         AND component_row.finalized_at IS NOT NULL
         AND abs(payment_row.paid_event_amount - invoice_row.paid_amount) < 0.01
         AND payment_row.legacy_pnl IS NOT NULL
         AND abs(payment_row.allocated_amount + payment_row.legacy_pnl - payment_row.paid_event_amount) < 0.01
         AND payment_row.allocated_current_charge + payment_row.legacy_pnl <= component_row.current_charge
          THEN payment_row.allocated_current_charge + payment_row.legacy_pnl
        ELSE NULL
      END::numeric AS collected_current_charge,
      component_row.component_status = 'COMPLETE'
        AND component_row.finalized_at IS NOT NULL AS component_complete,
      CASE
        WHEN payment_row.paid_event_amount = 0
          THEN component_row.component_status = 'COMPLETE'
            AND component_row.finalized_at IS NOT NULL
        ELSE payment_row.legacy_pnl IS NOT NULL
          AND abs(payment_row.allocated_amount + payment_row.legacy_pnl - payment_row.paid_event_amount) < 0.01
          AND payment_row.allocated_current_charge + payment_row.legacy_pnl <= component_row.current_charge
          AND abs(payment_row.paid_event_amount - invoice_row.paid_amount) < 0.01
      END AS allocation_complete
    FROM issued invoice_row
    LEFT JOIN component_pivot component_row ON component_row.invoice_id = invoice_row.id
    LEFT JOIN payment_facts payment_row ON payment_row.invoice_id = invoice_row.id
  ),
  issued_aggregate AS MATERIALIZED (
    SELECT
      building_row.id AS building_id,
      count(invoice_row.id)::integer AS invoice_count,
      count(invoice_row.id) FILTER (
        WHERE NOT COALESCE(invoice_row.component_complete AND invoice_row.allocation_complete, false)
      )::integer AS allocation_unknown_count,
      COALESCE(sum(COALESCE(invoice_row.current_charge, invoice_row.total_amount)) FILTER (
        WHERE NOT COALESCE(invoice_row.component_complete AND invoice_row.allocation_complete, false)
      ), 0)::numeric AS allocation_unknown_amount,
      count(invoice_row.id) FILTER (
        WHERE invoice_row.component_status IS DISTINCT FROM 'COMPLETE'
      )::integer AS component_anomaly_count,
      bool_and(COALESCE(invoice_row.component_complete AND invoice_row.allocation_complete, false))
        FILTER (WHERE invoice_row.id IS NOT NULL) AS cohort_available,
      sum(invoice_row.current_charge)::numeric AS billed_current_charge,
      sum(invoice_row.collected_current_charge)::numeric AS collected_current_charge,
      sum(invoice_row.carried_invoice_debt)::numeric AS carried_invoice_debt,
      sum(invoice_row.carried_deposit_debt)::numeric AS carried_deposit_debt,
      sum(invoice_row.current_deposit)::numeric AS current_deposit
    FROM requested_buildings building_row
    LEFT JOIN per_invoice invoice_row ON invoice_row.building_id = building_row.id
    GROUP BY building_row.id
  ),
  pending_aggregate AS MATERIALIZED (
    SELECT
      building_row.id AS building_id,
      count(invoice_row.id)::integer AS pending_count,
      COALESCE(sum(invoice_row.total_amount), 0)::numeric AS pending_amount
    FROM requested_buildings building_row
    LEFT JOIN public.invoices invoice_row
      ON invoice_row.building_id = building_row.id
     AND invoice_row.organization_id = p_organization_id
     AND invoice_row.deleted_at IS NULL
     AND invoice_row.kind = 'MONTHLY'
     AND invoice_row.billing_month = to_char(p_cohort_month, 'YYYY-MM')
     AND invoice_row.status::text IN ('DRAFT', 'PENDING_APPROVAL')
    GROUP BY building_row.id
  ),
  settlement_aggregate AS MATERIALIZED (
    SELECT
      building_row.id AS building_id,
      count(invoice_row.id)::integer AS settlement_count,
      COALESCE(sum(invoice_row.total_amount), 0)::numeric AS settlement_amount
    FROM requested_buildings building_row
    LEFT JOIN public.invoices invoice_row
      ON invoice_row.building_id = building_row.id
     AND invoice_row.organization_id = p_organization_id
     AND invoice_row.deleted_at IS NULL
     AND invoice_row.kind = 'SETTLEMENT'
     AND invoice_row.billing_month = to_char(p_cohort_month, 'YYYY-MM')
    GROUP BY building_row.id
  )
  SELECT
    building_row.id,
    building_row.name,
    p_cohort_month,
    COALESCE(issued_row.cohort_available, true),
    CASE WHEN COALESCE(issued_row.cohort_available, true)
      THEN COALESCE(issued_row.billed_current_charge, 0) ELSE NULL END,
    CASE WHEN COALESCE(issued_row.cohort_available, true)
      THEN COALESCE(issued_row.collected_current_charge, 0) ELSE NULL END,
    CASE WHEN COALESCE(issued_row.cohort_available, true)
      THEN COALESCE(issued_row.billed_current_charge, 0)
        - COALESCE(issued_row.collected_current_charge, 0)
      ELSE NULL END,
    CASE
      WHEN NOT COALESCE(issued_row.cohort_available, true) THEN NULL
      WHEN COALESCE(issued_row.billed_current_charge, 0) = 0 THEN NULL
      ELSE round(
        COALESCE(issued_row.collected_current_charge, 0) * 100.0
          / issued_row.billed_current_charge,
        2
      )
    END,
    issued_row.invoice_count,
    issued_row.allocation_unknown_count,
    issued_row.allocation_unknown_amount,
    issued_row.component_anomaly_count,
    COALESCE(issued_row.carried_invoice_debt, 0),
    COALESCE(issued_row.carried_deposit_debt, 0),
    COALESCE(issued_row.current_deposit, 0),
    pending_row.pending_count,
    pending_row.pending_amount,
    settlement_row.settlement_count,
    settlement_row.settlement_amount,
    clock_timestamp()
  FROM requested_buildings building_row
  JOIN issued_aggregate issued_row ON issued_row.building_id = building_row.id
  JOIN pending_aggregate pending_row ON pending_row.building_id = building_row.id
  JOIN settlement_aggregate settlement_row ON settlement_row.building_id = building_row.id
  ORDER BY lower(building_row.name) COLLATE "C", building_row.id;
END;
$business_performance_invoice_cohort$;

REVOKE ALL ON FUNCTION public.business_performance_invoice_cohort_v1(uuid, date, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_performance_invoice_cohort_v1(uuid, date, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.business_performance_invoice_cohort_v1(uuid, date, uuid[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.business_performance_invoice_cohort_v1(uuid, date, uuid[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.business_performance_invoice_cohort_v1(uuid, date, uuid[]) TO authenticated;


CREATE OR REPLACE FUNCTION public.update_invoice_v1(p_invoice_id uuid, p_contract_id uuid, p_building_id uuid, p_room_id uuid, p_billing_month text, p_issue_date date, p_due_date date, p_subtotal numeric, p_discount_amount numeric, p_total_amount numeric, p_previous_debt numeric, p_items jsonb, p_prepaid_amount numeric DEFAULT 0, p_discount_notes text DEFAULT NULL::text, p_electricity_prev_overridden boolean DEFAULT false, p_previous_debt_sources jsonb DEFAULT '[]'::jsonb, p_template_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_row public.invoices%rowtype;
  v_org uuid;
  it jsonb; v_idx int := 0;
  v_total_calc numeric(15,2);
  v_normalized_items jsonb := '[]'::jsonb;
  v_class text;
  v_match uuid;
  v_matches integer;
  v_matched uuid[] := '{}'::uuid[];
  v_has_legacy boolean;
  v_has_deposit boolean;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items phải là JSON array'; end if;

  select * into v_row from public.invoices
   where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'Không tìm thấy hoá đơn hoặc bạn không có quyền' using errcode='42501'; end if;
  v_org := v_row.organization_id;

  -- SERVER mirror canEditInvoice: (DRAFT|APPROVED) AND paid_amount=0. Dùng errcode
  -- mặc định (P0001, KHÔNG fallback) → lỗi hiện thẳng như legacy hook, không rơi
  -- xuống đường legacy để lách guard.
  if v_row.status <> 'DRAFT'::invoice_status or v_row.adjustment_revision<>0
     or coalesce(v_row.paid_amount,0) <> 0 then
    raise exception 'Hóa đơn đã phát hành cần điều chỉnh qua phiên bản mới; vui lòng tải lại' using errcode='55000';
  end if;

  -- quyền edit theo toà HIỆN TẠI của hoá đơn.
  if not app_private.can_edit_invoice_building_v1(v_row.building_id) then
    raise exception 'Không có quyền chỉnh sửa hoá đơn này' using errcode='42501'; end if;

  -- Nếu ĐỔI toà → chặn cross-org + đòi quyền edit trên toà đích. (Đổi phòng cũng
  -- verify thuộc toà đích/cùng org, mirror ràng buộc create.)
  if p_building_id is distinct from v_row.building_id then
    perform 1 from public.buildings b
     where b.id=p_building_id and b.deleted_at is null and b.organization_id=v_org;
    if not found then
      raise exception 'Toà đích không thuộc tổ chức của hoá đơn' using errcode='42501'; end if;
    if not app_private.can_edit_invoice_building_v1(p_building_id) then
      raise exception 'Không có quyền chỉnh sửa sang toà này' using errcode='42501'; end if;
  end if;
  if p_room_id is not null then
    perform 1 from public.rooms r
     where r.id=p_room_id and r.deleted_at is null
       and r.building_id=p_building_id and r.organization_id=v_org;
    if not found then
      raise exception 'Phòng không thuộc toà/tổ chức' using errcode='42501'; end if;
  end if;

  -- Validate classification BEFORE replacing rows. Item IDs identify only rows
  -- on this invoice; legacy clients can preserve a unique structural identity.
  SELECT EXISTS (SELECT 1 FROM public.invoice_items old
    WHERE old.invoice_id=p_invoice_id AND old.accounting_class='DEPOSIT') INTO v_has_deposit;
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) x
    WHERE NOT (x ? 'accounting_class')) INTO v_has_legacy;
  FOR it IN SELECT value FROM jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) LOOP
    IF jsonb_typeof(it) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Hạng mục phải là JSON object' USING ERRCODE='22023';
    END IF;
    v_match := NULL;
    IF nullif(it->>'id','') IS NOT NULL THEN
      SELECT old.id INTO v_match FROM public.invoice_items old
       WHERE old.id=(it->>'id')::uuid AND old.invoice_id=p_invoice_id;
      IF v_match IS NULL THEN
        RAISE EXCEPTION 'Hạng mục không thuộc hoá đơn' USING ERRCODE='42501';
      END IF;
    ELSE
      SELECT count(*), (array_agg(old.id))[1] INTO v_matches,v_match
        FROM public.invoice_items old
       WHERE old.invoice_id=p_invoice_id
         AND old.type=coalesce(nullif(it->>'type','')::invoice_item_type,'OTHER'::invoice_item_type)
         AND old.service_id IS NOT DISTINCT FROM nullif(it->>'service_id','')::uuid
         AND old.description IS NOT DISTINCT FROM it->>'description';
      IF v_matches <> 1 THEN v_match := NULL; END IF;
    END IF;
    IF it ? 'accounting_class' THEN
      v_class := it->>'accounting_class';
      IF v_class IS NULL OR v_class NOT IN ('REVENUE','DEPOSIT','NON_PNL') THEN
        RAISE EXCEPTION 'accounting_class không hợp lệ' USING ERRCODE='22023';
      END IF;
    ELSIF v_match IS NOT NULL AND NOT (v_match=ANY(v_matched)) THEN
      SELECT old.accounting_class INTO v_class FROM public.invoice_items old WHERE old.id=v_match;
    ELSIF v_has_deposit THEN
      RAISE EXCEPTION 'Không xác định duy nhất hạng mục cọc; vui lòng tải lại hoá đơn' USING ERRCODE='22023';
    ELSE
      v_class := 'REVENUE';
    END IF;
    IF v_match IS NOT NULL THEN v_matched := array_append(v_matched,v_match); END IF;
    v_normalized_items := v_normalized_items || jsonb_build_array(it || jsonb_build_object('accounting_class',v_class));
  END LOOP;
  IF (v_has_legacy OR p_items IS NULL OR p_items='[]'::jsonb) AND v_has_deposit
     AND EXISTS (SELECT 1 FROM public.invoice_items old WHERE old.invoice_id=p_invoice_id
       AND old.accounting_class='DEPOSIT' AND NOT (old.id=ANY(v_matched))) THEN
    RAISE EXCEPTION 'Thiếu phân loại hạng mục cọc; vui lòng tải lại hoá đơn' USING ERRCODE='22023';
  END IF;

  -- recalc total + assert (làm tròn trên p_subtotal, giống create).
  v_total_calc := app_private.round_invoice_total_v1(
    coalesce(p_subtotal,0) - coalesce(p_discount_amount,0) + coalesce(p_previous_debt,0));

  if v_total_calc is distinct from p_total_amount then
    raise exception
      'Tổng tiền client (%) khác tổng server làm tròn (%) [subtotal=%, discount=%, nợ cũ=%]',
      p_total_amount, v_total_calc, coalesce(p_subtotal,0),
      coalesce(p_discount_amount,0), coalesce(p_previous_debt,0)
      using errcode='22000';
  end if;

  update public.invoices
     set contract_id                 = p_contract_id,
         building_id                 = p_building_id,
         room_id                     = p_room_id,
         billing_month               = p_billing_month,
         issue_date                  = p_issue_date,
         due_date                    = p_due_date,
         subtotal                    = coalesce(p_subtotal,0),
         discount_amount             = coalesce(p_discount_amount,0),
         discount_notes              = p_discount_notes,
         electricity_prev_overridden = coalesce(p_electricity_prev_overridden,false),
         total_amount                = p_total_amount,
         prepaid_amount              = coalesce(p_prepaid_amount,0),
         previous_debt               = coalesce(p_previous_debt,0),
         previous_debt_sources       = coalesce(p_previous_debt_sources,'[]'::jsonb),
         notes                       = p_notes,
         template_id                 = p_template_id
   where id = p_invoice_id
   returning * into v_row;

  -- replace items (delete-all rồi insert lại, mirror legacy).
  delete from public.invoice_items where invoice_id = p_invoice_id;
  if p_items is not null then
    for it in select value from jsonb_array_elements(v_normalized_items) loop
      v_idx := v_idx + 1;
      insert into public.invoice_items
        (invoice_id, organization_id, service_id, type, description, unit_price,
         quantity, coefficient, amount, previous_reading, current_reading,
         from_date, to_date, sort_order, accounting_class)
      values (
        p_invoice_id, v_org,
        nullif(it->>'service_id','')::uuid,
        coalesce(nullif(it->>'type','')::invoice_item_type, 'OTHER'::invoice_item_type),
        it->>'description',
        coalesce((it->>'unit_price')::numeric,0),
        coalesce((it->>'quantity')::numeric,1),
        coalesce((it->>'coefficient')::numeric,1),
        coalesce((it->>'amount')::numeric,
          coalesce((it->>'unit_price')::numeric,0)
          * coalesce((it->>'quantity')::numeric,1)
          * coalesce((it->>'coefficient')::numeric,1)),
        nullif(it->>'previous_reading','')::numeric,
        nullif(it->>'current_reading','')::numeric,
        nullif(it->>'from_date','')::date,
        nullif(it->>'to_date','')::date,
        coalesce((it->>'sort_order')::int, v_idx),
        coalesce(it->>'accounting_class','REVENUE')
      );
    end loop;
  end if;

  return v_row;
end;
$function$
;
COMMIT;
