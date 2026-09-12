BEGIN;
-- Business stale-state conflicts must return HTTP 409 without PostgREST transaction retries.
-- PostgREST 14 retries custom SQLSTATE 40001 indefinitely. PT409 is a domain response;
-- native PostgreSQL serialization failures, locks, permissions and money writes are unchanged.
-- https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b
-- Captured reviewed live definitions; each body changes exactly one error-code literal.
DO $precondition$
BEGIN
  IF md5(pg_get_functiondef('public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamptz,text)'::regprocedure)) NOT IN ('bf7609f684a7d6d707d2c7b4343415d7','917ac30d46140759044c67f8b43c6a03') THEN
    RAISE EXCEPTION 'Invoice conflict function changed; recapture and review: public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamptz,text)' USING ERRCODE='55000';
  END IF;
  IF md5(pg_get_functiondef('public.review_invoice_adjustment_v2(uuid,bigint)'::regprocedure)) NOT IN ('3a2010a86935d2cf2675912c21834318','55bd3bbd10193c27172e317fd78cb7c5') THEN
    RAISE EXCEPTION 'Invoice conflict function changed; recapture and review: public.review_invoice_adjustment_v2(uuid,bigint)' USING ERRCODE='55000';
  END IF;
  IF md5(pg_get_functiondef('app_private.pin_invoice_collection_manifest_v2()'::regprocedure)) NOT IN ('e3cdcae5efb846c69aeffd8ce2daab05','859f3840032db77dd04833a0ec39601a') THEN
    RAISE EXCEPTION 'Invoice conflict function changed; recapture and review: app_private.pin_invoice_collection_manifest_v2()' USING ERRCODE='55000';
  END IF;
  IF md5(pg_get_functiondef('public.record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text)'::regprocedure)) NOT IN ('2e1a40ef39d7a373dcdba3e83a0e60f5','8aecfbec6195d8813cf6b359d888e6a1') THEN
    RAISE EXCEPTION 'Invoice conflict function changed; recapture and review: public.record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text)' USING ERRCODE='55000';
  END IF;
END $precondition$;

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
END $function$;

CREATE OR REPLACE FUNCTION public.review_invoice_adjustment_v2(p_adjustment_id uuid, p_expected_revision bigint)
 RETURNS invoice_adjustments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE result public.invoice_adjustments%ROWTYPE; inv public.invoices%ROWTYPE; invoice_id uuid;
BEGIN
  SELECT a.invoice_id INTO invoice_id FROM public.invoice_adjustments a WHERE a.id=p_adjustment_id;
  SELECT * INTO inv FROM public.invoices i WHERE i.id=invoice_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR public.can_access_building(inv.building_id) IS DISTINCT FROM true OR public.can_do_on_building('invoices','approve',inv.building_id) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Không có quyền xác nhận kiểm tra' USING ERRCODE='42501'; END IF;
  SELECT * INTO result FROM public.invoice_adjustments WHERE id=p_adjustment_id FOR UPDATE;
  IF result.organization_id IS DISTINCT FROM inv.organization_id THEN RAISE EXCEPTION 'Điều chỉnh không thuộc tổ chức' USING ERRCODE='42501'; END IF;
  IF p_expected_revision IS DISTINCT FROM inv.adjustment_revision OR result.revision IS DISTINCT FROM inv.adjustment_revision THEN
    RAISE EXCEPTION 'Hóa đơn đã có phiên bản mới; vui lòng tải lại trước khi kiểm tra' USING ERRCODE='PT409'; END IF;
  IF result.review_status='CHECKED' THEN RETURN result; END IF;
  UPDATE public.invoice_adjustments SET review_status='CHECKED',checked_by=auth.uid(),checked_at=clock_timestamp() WHERE id=p_adjustment_id RETURNING * INTO result;
  UPDATE public.invoices SET adjustment_review_status='CHECKED',updated_at=clock_timestamp() WHERE id=inv.id;
  RETURN result;
END $function$;

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
END $function$;

CREATE OR REPLACE FUNCTION public.record_invoice_collection_v5(p_invoice_id uuid, p_collection_date date, p_tenders jsonb, p_overpay_action text, p_allow_rounding boolean, p_notes text, p_receipt_image_url text, p_expected_paid_amount numeric, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_collector_membership uuid;
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_invoice public.invoices%ROWTYPE;
  v_org uuid;
  v_owner uuid;
  v_authz boolean;
  v_route text;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_collection_id uuid;
  v_tender jsonb;
  v_tender_id uuid;
  v_payment_id uuid;
  v_voucher_id uuid;
  v_item_id uuid;
  v_credit_lot_id uuid;
  v_credit_tender_count integer;
  v_excess_id uuid;
  v_account_id uuid;
  v_change_account_id uuid;
  v_rounding_account_id uuid;
  v_method public.payment_method;
  v_gross numeric;
  v_gross_total numeric := 0;
  v_tm_total numeric := 0;
  v_explicit_change boolean;
  v_requested_change numeric;
  v_requested_change_total numeric := 0;
  v_rounding_line_idx integer;
  v_fallback_rounding_account uuid;
  v_refund_audit_posting uuid;
  v_refund_audit_evidence uuid;
  v_remaining numeric;
  v_applied_total numeric;
  v_change_total numeric := 0;
  v_credit_total numeric := 0;
  v_rounding_total numeric := 0;
  v_retained_total numeric;
  v_remaining_apply numeric;
  v_change_left numeric;
  v_credit_left numeric;
  v_line_left numeric;
  v_line_change numeric;
  v_line_credit numeric;
  v_line_retained numeric;
  v_line_applied numeric;
  v_line_revenue numeric;
  v_line_internal numeric;
  v_line_deposit numeric;
  v_later_tm_total numeric;
  v_later_gross_total numeric;
  v_revenue_due numeric;
  v_internal_due numeric := 0;
  v_deposit_due numeric := 0;
  v_revenue_covered numeric := 0;
  v_internal_covered numeric := 0;
  v_deposit_covered numeric := 0;
  v_projected_revenue numeric;
  v_projected_internal numeric;
  v_projected_deposit numeric;
  v_projection_left numeric;
  v_idx integer := 0;
  v_last_tm_idx integer := -1;
  v_last_line_idx integer;
  v_revenue_type_id uuid;
  v_deposit_type_id uuid;
  v_credit_type_id uuid;
  v_response jsonb;
  v_tender_results jsonb := '[]'::jsonb;
  v_creator_name text;
  v_rounding_target_account uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'
      USING ERRCODE = '22023';
  END IF;
  IF p_collection_date IS NULL OR jsonb_typeof(p_tenders) <> 'array'
     OR jsonb_array_length(p_tenders) = 0 THEN
    RAISE EXCEPTION 'Ngày thu hoặc danh sách phương thức không hợp lệ'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy hóa đơn' USING ERRCODE = '42501';
  END IF;

  SELECT building_row.organization_id, v_invoice.user_id
    INTO v_org, v_owner
  FROM public.buildings building_row
  JOIN public.organizations org_row
    ON org_row.id = building_row.organization_id AND org_row.status = 'ACTIVE'
  WHERE building_row.id = v_invoice.building_id
    AND building_row.deleted_at IS NULL
  FOR SHARE OF building_row, org_row;
  IF v_org IS NULL OR v_invoice.organization_id <> v_org THEN
    RAISE EXCEPTION 'Hóa đơn không thuộc tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;

  -- Membership của người thu — dùng cho chốt possession trên sổ nhận tiền.
  SELECT m.id INTO v_collector_membership
  FROM public.organization_memberships m
  WHERE m.user_id = v_actor AND m.organization_id = v_org AND m.status = 'ACTIVE'
  LIMIT 1;

  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'thu_tien.collect', v_invoice.building_id, NULL
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Không có quyền thu tiền hóa đơn' USING ERRCODE = '42501';
  END IF;

  v_hash := md5(jsonb_build_object(
    'invoice_id', p_invoice_id,
    'collection_date', p_collection_date,
    'tenders', p_tenders,
    'overpay_action', upper(COALESCE(p_overpay_action, 'REJECT')),
    'allow_rounding', COALESCE(p_allow_rounding, false),
    'notes', p_notes,
    'receipt_image_url', p_receipt_image_url
  )::text);

  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash
  ) VALUES (
    v_org, 'invoice.collection.v5', p_invoice_id::text, v_actor, v_key, v_hash
  ) ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
    DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'invoice.collection.v5'
    AND operation_row.subject_scope = p_invoice_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;

  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác' USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM app_private.canonical_write_operations compat_operation
    WHERE compat_operation.organization_id = v_org
      AND compat_operation.operation = 'invoice.collection.compat.v4'
      AND compat_operation.subject_scope = p_invoice_id::text
      AND compat_operation.actor_id = v_actor
      AND compat_operation.idempotency_key = v_key
      AND compat_operation.completed_at IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.income_expenses legacy_voucher
    WHERE legacy_voucher.organization_id = v_org
      AND legacy_voucher.idempotency_key = v_key
      AND legacy_voucher.payment_collection_id IS NULL
      AND legacy_voucher.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'idempotency_key đã hoàn tất ở đường payment tương thích'
      USING ERRCODE = '23505';
  END IF;

  v_route := app_private.evaluate_feature_route('invoice.collection.v5', v_org);
  IF v_route = 'FROZEN' THEN
    RAISE EXCEPTION 'Writer invoice.collection.v5 đang bị đóng băng'
      USING ERRCODE = '55000';
  ELSIF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION 'Writer invoice.collection.v5 chưa bật' USING ERRCODE = '55000';
  END IF;

  IF v_invoice.status NOT IN ('APPROVED', 'PARTIAL_PAID', 'OVERDUE') THEN
    RAISE EXCEPTION 'Trạng thái hóa đơn không cho phép thu tiền: %', v_invoice.status
      USING ERRCODE = '55000';
  END IF;
  IF p_expected_paid_amount IS NULL
     OR p_expected_paid_amount = 'NaN'::numeric
     OR abs(COALESCE(v_invoice.paid_amount, 0) - p_expected_paid_amount) >= 0.01 THEN
    RAISE EXCEPTION 'Số đã thu vừa thay đổi; vui lòng tải lại hóa đơn'
      USING ERRCODE = 'PT409';
  END IF;

  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(p_tenders) t
    WHERE t ? 'requested_change_amount') INTO v_explicit_change;
  IF v_explicit_change AND upper(COALESCE(p_overpay_action, 'REJECT')) <> 'REFUND' THEN
    RAISE EXCEPTION 'Tiền thối tùy chỉnh chỉ dùng khi chọn thối lại'
      USING ERRCODE = '22023';
  END IF;

  FOR v_tender IN SELECT value FROM jsonb_array_elements(p_tenders) LOOP
    v_gross := COALESCE((v_tender->>'gross_amount')::numeric, 0);
    IF v_gross IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
       OR v_gross <= 0 OR round(v_gross, 2) <> v_gross THEN
      RAISE EXCEPTION 'Mỗi dòng thanh toán phải lớn hơn 0 và tối đa 2 số lẻ'
        USING ERRCODE = '22023';
    END IF;
    v_method := (v_tender->>'payment_method')::public.payment_method;
    IF v_explicit_change THEN
      IF v_method = 'TM' THEN
        IF jsonb_typeof(v_tender->'requested_change_amount') IS DISTINCT FROM 'number' THEN
          RAISE EXCEPTION 'Phải nhập tiền thối bằng số cho tất cả dòng tiền mặt'
            USING ERRCODE = '22023';
        END IF;
        v_requested_change := (v_tender->>'requested_change_amount')::numeric;
        IF v_requested_change IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
           OR v_requested_change < 0 OR v_requested_change > v_gross
           OR round(v_requested_change, 2) <> v_requested_change THEN
          RAISE EXCEPTION 'Tiền thối phải không âm, tối đa 2 số lẻ và không vượt tiền mặt của dòng'
            USING ERRCODE = '22023';
        END IF;
        v_requested_change_total := v_requested_change_total + v_requested_change;
      ELSIF v_tender ? 'requested_change_amount' THEN
        RAISE EXCEPTION 'Chỉ được thối từ dòng tiền mặt TM' USING ERRCODE = '22023';
      END IF;
    END IF;
    v_account_id := NULLIF(v_tender->>'account_id', '')::uuid;
    IF v_account_id IS NULL THEN
      RAISE EXCEPTION 'Mỗi dòng thanh toán phải có sổ quỹ' USING ERRCODE = '22023';
    END IF;

    PERFORM 1 FROM public.accounts account_row
    WHERE account_row.id = v_account_id
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ nhận tiền phải là sổ tiền thật của tổ chức'
        USING ERRCODE = '42501';
    END IF;
    SELECT allowed INTO v_authz
    FROM app_private.authorize_tenant_action_v3(
      v_actor, v_org, 'thu_tien.collect', v_invoice.building_id, v_account_id
    );
    IF NOT COALESCE(v_authz, false) THEN
      RAISE EXCEPTION 'Không có quyền ghi vào một sổ quỹ đã chọn' USING ERRCODE = '42501';
    END IF;

    -- CHỐT POSSESSION TRÊN SỔ NHẬN TIỀN (02/08/2026).
    -- 'thu_tien.collect' khai requires_cashbook_possession = false và
    -- required_dimensions = [], nên tham số p_cashbook_id ở trên bị BỎ QUA: đo
    -- trên prod, một người thu được ở toà là server cho ghi vào CẢ 16/16 sổ của
    -- tổ chức, kể cả sổ chưa từng được cấp quyền gì. Trước đây chỉ có danh sách
    -- trên giao diện vô tình gác cổng; gọi thẳng API thì không còn gì chặn.
    --
    -- KHÔNG bật requires_cashbook_possession cho 'thu_tien.collect' để vá:
    -- authorize_tenant_action_v3 khi đó đòi cạnh ALLOW phải là scope CASHBOOK,
    -- mà vai trò "Quản Lý Tòa" chỉ có binding scope BUILDING (18 binding/org)
    -- ⇒ bật lên là chặn sạch mọi người thu. Vì vậy kiểm possession TRỰC TIẾP.
    --
    -- CUSTODIAN hoặc KNOWER đều hợp lệ (helper đã khai đúng vậy): người thu chỉ
    -- đạo tiền vào tài khoản ngân hàng của chủ thì là "người biết sổ", không
    -- phải người giữ tiền. Đo lịch sử 120 ngày: 0/31 lần thu bị chốt này chặn.
    IF v_collector_membership IS NULL
       OR NOT app_private.ie_has_cashbook_possession_v1(v_org, v_account_id, v_collector_membership) THEN
      RAISE EXCEPTION 'Bạn không được giao sổ quỹ này (cần là Người giữ sổ hoặc Người biết sổ). Chọn sổ khác.'
        USING ERRCODE = '42501';
    END IF;

    v_gross_total := v_gross_total + v_gross;
    IF v_method = 'TM' THEN
      v_tm_total := v_tm_total + v_gross;
      v_last_tm_idx := v_idx;
    END IF;
    v_idx := v_idx + 1;
  END LOOP;

  v_last_line_idx := v_idx - 1;
  v_remaining := GREATEST(v_invoice.total_amount - COALESCE(v_invoice.paid_amount, 0), 0);
  v_applied_total := LEAST(v_gross_total, v_remaining);

  IF v_gross_total > v_remaining THEN
    CASE upper(COALESCE(p_overpay_action, 'REJECT'))
      WHEN 'REFUND' THEN v_change_total := v_gross_total - v_remaining;
      WHEN 'CREDIT' THEN
        IF v_invoice.contract_id IS NULL THEN
          RAISE EXCEPTION 'Không thể giữ credit cho hóa đơn không có hợp đồng'
            USING ERRCODE = '22023';
        END IF;
        v_credit_total := v_gross_total - v_remaining;
      ELSE
        RAISE EXCEPTION 'Số thu vượt còn phải thu; chọn thối lại hoặc giữ credit'
          USING ERRCODE = '22023';
    END CASE;
    IF v_change_total > 0
       AND (v_last_tm_idx < 0 OR v_tm_total < v_change_total) THEN
      RAISE EXCEPTION 'Phần hoàn tiền phải nằm trong dòng tiền mặt TM của lần thu hiện tại'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_explicit_change THEN
    IF v_requested_change_total < GREATEST(v_gross_total - v_remaining, 0) THEN
      RAISE EXCEPTION 'Tiền thối không được nhỏ hơn phần dư; chọn giữ credit nếu cần giữ tiền'
        USING ERRCODE = '22023';
    END IF;
    IF v_gross_total - v_requested_change_total <= 0 THEN
      RAISE EXCEPTION 'Số tiền thực thu sau khi thối phải lớn hơn 0' USING ERRCODE = '22023';
    END IF;
    v_change_total := v_requested_change_total;
    v_applied_total := LEAST(v_gross_total - v_change_total, v_remaining);
  END IF;

  IF v_applied_total <= 0 THEN
    RAISE EXCEPTION 'Hóa đơn không còn số tiền có thể thu' USING ERRCODE = '55000';
  END IF;

  IF COALESCE(p_allow_rounding, false)
     AND v_remaining - v_applied_total > 0
     AND v_remaining - v_applied_total < 10000 THEN
    v_rounding_total := v_remaining - v_applied_total;
  END IF;

  v_retained_total := v_gross_total - v_change_total;

  SELECT COALESCE(sum(item.amount), 0)
    INTO v_deposit_due
  FROM public.invoice_items item
  WHERE item.invoice_id = p_invoice_id
    AND item.accounting_class = 'DEPOSIT';

  SELECT v_deposit_due + COALESCE(sum((source_row->>'amount')::numeric), 0)
    INTO v_deposit_due
  FROM jsonb_array_elements(COALESCE(v_invoice.previous_debt_sources, '[]'::jsonb)) source_row
  WHERE source_row->>'type' = 'deposit';
  v_deposit_due := COALESCE(v_deposit_due, 0);
  SELECT COALESCE(sum(item.amount), 0)
    INTO v_internal_due
  FROM public.invoice_items item
  WHERE item.invoice_id = p_invoice_id
    AND item.accounting_class = 'NON_PNL';

  v_internal_due := COALESCE(v_internal_due, 0);
  v_revenue_due := GREATEST(
    v_invoice.total_amount - v_deposit_due - v_internal_due,
    0
  );
  IF v_deposit_due = 'NaN'::numeric
     OR v_internal_due = 'NaN'::numeric
     OR v_invoice.total_amount = 'NaN'::numeric
     OR v_deposit_due + v_internal_due - v_invoice.total_amount >= 0.01 THEN
    RAISE EXCEPTION 'Dữ liệu cọc/NON_PNL vượt tổng phải thu; cần review kế toán'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class = 'PNL'), 0),
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class = 'DEPOSIT'), 0),
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class = 'INTERNAL'), 0)
  INTO v_revenue_covered, v_deposit_covered, v_internal_covered
  FROM public.income_expenses voucher
  JOIN public.income_expense_items item
    ON item.income_expense_id = voucher.id
  LEFT JOIN public.invoice_payment_collections source_collection
    ON source_collection.id = voucher.payment_collection_id
  LEFT JOIN public.payments source_payment
    ON source_payment.id = voucher.payment_id
  WHERE voucher.invoice_id = p_invoice_id
    AND voucher.type = 'INCOME'
    AND voucher.approval_status = 'APPROVED'
    AND voucher.deleted_at IS NULL
    AND (
      voucher.payment_collection_id IS NULL
      OR source_collection.status = 'ACTIVE'
    )
    AND (voucher.payment_id IS NULL OR source_payment.reversed_at IS NULL);

  IF v_revenue_covered - v_revenue_due >= 0.01
     OR v_deposit_covered - v_deposit_due >= 0.01
     OR v_internal_covered - v_internal_due >= 0.01 THEN
    RAISE EXCEPTION 'Bút toán đã ghi vượt semantic của hóa đơn; cần review kế toán'
      USING ERRCODE = '55000';
  END IF;
  IF abs(
    v_revenue_covered + v_deposit_covered + v_internal_covered
    - COALESCE(v_invoice.paid_amount, 0)
  ) >= 0.01 THEN
    RAISE EXCEPTION 'Số đã thu không khớp bút toán semantic; cần đối soát trước'
      USING ERRCODE = '55000';
  END IF;
  v_revenue_covered := GREATEST(LEAST(v_revenue_covered, v_revenue_due), 0);
  v_deposit_covered := GREATEST(LEAST(v_deposit_covered, v_deposit_due), 0);
  v_internal_covered := GREATEST(LEAST(v_internal_covered, v_internal_due), 0);

  v_projection_left := v_applied_total;
  v_projected_revenue := v_revenue_covered + LEAST(
    v_projection_left,
    GREATEST(v_revenue_due - v_revenue_covered, 0)
  );
  v_projection_left := v_projection_left - (v_projected_revenue - v_revenue_covered);
  v_projected_deposit := v_deposit_covered + LEAST(
    v_projection_left,
    GREATEST(v_deposit_due - v_deposit_covered, 0)
  );
  v_projection_left := v_projection_left - (v_projected_deposit - v_deposit_covered);
  v_projected_internal := v_internal_covered + LEAST(
    v_projection_left,
    GREATEST(v_internal_due - v_internal_covered, 0)
  );
  v_projection_left := v_projection_left - (v_projected_internal - v_internal_covered);
  IF abs(v_projection_left) >= 0.01 THEN
    RAISE EXCEPTION 'Không thể phân bổ số thu vào semantic hóa đơn'
      USING ERRCODE = '55000';
  END IF;

  IF v_rounding_total > 0 AND (
    v_deposit_due - v_projected_deposit >= 0.01
    OR v_internal_due - v_projected_internal >= 0.01
  ) THEN
    RAISE EXCEPTION 'Không được làm tròn bỏ qua cọc hoặc khoản NON_PNL còn thiếu'
      USING ERRCODE = '22023';
  END IF;

  SELECT type_row.id INTO v_revenue_type_id
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'income'
    AND NOT type_row.is_deposit
  ORDER BY type_row.is_default DESC,
           CASE WHEN lower(btrim(type_row.name)) IN ('thu tiền hoá đơn', 'thu tiền hóa đơn') THEN 0 ELSE 1 END,
           type_row.created_at
  LIMIT 1 FOR SHARE;

  SELECT type_row.id INTO v_deposit_type_id
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'income'
    AND type_row.is_deposit
  ORDER BY CASE WHEN lower(btrim(type_row.name)) = 'tiền cọc' THEN 0 ELSE 1 END,
           type_row.created_at
  LIMIT 1 FOR SHARE;

  SELECT type_row.id INTO v_credit_type_id
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'income'
    AND lower(btrim(type_row.name)) = 'tiền khách trả thừa'
  LIMIT 1 FOR SHARE;

  IF v_revenue_type_id IS NULL THEN
    RAISE EXCEPTION 'Tổ chức chưa có loại thu hóa đơn' USING ERRCODE = '55000';
  END IF;
  IF v_deposit_due > 0 AND v_deposit_type_id IS NULL THEN
    RAISE EXCEPTION 'Tổ chức chưa có loại thu cọc' USING ERRCODE = '55000';
  END IF;
  IF v_credit_total > 0 AND v_credit_type_id IS NULL THEN
    INSERT INTO public.income_expense_types (
      organization_id, user_id, name, type, description, is_default, is_deposit
    ) VALUES (
      v_org, v_owner, 'Tiền khách trả thừa', 'income',
      'Khoản khách trả dư giữ lại để cấn kỳ sau; ngoài KQKD', false, false
    ) RETURNING id INTO v_credit_type_id;
  END IF;

  v_creator_name := COALESCE(
    auth.jwt()->'user_metadata'->>'full_name',
    auth.jwt()->'user_metadata'->>'name',
    auth.jwt()->>'email',
    'Người dùng'
  );

  PERFORM app_private.claim_feature_operation_v1(
    'invoice.collection.v5',
    v_org,
    p_invoice_id::text,
    v_actor,
    v_key,
    v_retained_total
  );

  PERFORM app_private.begin_accounting_chain_write_v1();

  INSERT INTO public.invoice_payment_collections (
    organization_id, invoice_id, contract_id, status, collection_date,
    actor_id, idempotency_key, payload_hash, expected_paid_amount,
    gross_amount, retained_amount, applied_amount, change_amount,
    credit_amount, rounding_amount, notes, receipt_image_url
  ) VALUES (
    v_org, p_invoice_id, v_invoice.contract_id, 'ACTIVE', p_collection_date,
    v_actor, v_key, v_hash, p_expected_paid_amount,
    v_gross_total, v_retained_total, v_applied_total, v_change_total,
    v_credit_total, v_rounding_total, NULLIF(btrim(p_notes), ''), p_receipt_image_url
  ) RETURNING id INTO v_collection_id;

  -- A fully refunded final TM tender has no payment. Keep rounding on the
  -- last tender with real applied money so recompute/reversal see it exactly once.
  v_rounding_line_idx := v_last_line_idx;
  IF v_explicit_change AND v_rounding_total > 0 THEN
    SELECT max(ord - 1)::integer INTO v_rounding_line_idx
    FROM jsonb_array_elements(p_tenders) WITH ORDINALITY t(value, ord)
    WHERE (value->>'gross_amount')::numeric
      - COALESCE((value->>'requested_change_amount')::numeric, 0) > 0;
  END IF;
  v_fallback_rounding_account := NULLIF(p_tenders->v_last_line_idx->>'rounding_account_id', '')::uuid;

  v_remaining_apply := v_applied_total;
  v_change_left := v_change_total;
  v_credit_left := v_credit_total;
  v_idx := 0;

  FOR v_tender IN SELECT value FROM jsonb_array_elements(p_tenders) LOOP
    v_payment_id := NULL;
    v_voucher_id := NULL;
    v_gross := (v_tender->>'gross_amount')::numeric;
    v_method := (v_tender->>'payment_method')::public.payment_method;
    v_account_id := (v_tender->>'account_id')::uuid;
    v_change_account_id := NULLIF(v_tender->>'change_account_id', '')::uuid;
    v_rounding_account_id := NULLIF(v_tender->>'rounding_account_id', '')::uuid;
    IF v_explicit_change AND v_idx = v_rounding_line_idx AND v_rounding_total > 0 THEN
      -- The original final line owns the rounding account, matching old payloads.
      v_rounding_account_id := v_fallback_rounding_account;
    END IF;
    v_line_change := 0;
    v_line_credit := 0;
    v_line_revenue := 0;
    v_line_deposit := 0;
    v_line_internal := 0;

    IF v_explicit_change AND v_method = 'TM' THEN
      v_line_change := (v_tender->>'requested_change_amount')::numeric;
      v_change_left := v_change_left - v_line_change;
    ELSIF v_method = 'TM' AND v_change_left > 0 THEN
      SELECT COALESCE(sum((later.value->>'gross_amount')::numeric), 0)
        INTO v_later_tm_total
      FROM jsonb_array_elements(p_tenders) WITH ORDINALITY later(value, ord)
      WHERE later.ord - 1 > v_idx
        AND later.value->>'payment_method' = 'TM';

      v_line_change := LEAST(
        v_gross,
        GREATEST(v_change_total - v_later_tm_total, 0)
      );
      v_change_left := v_change_left - v_line_change;
    END IF;

    IF v_credit_left > 0 THEN
      SELECT COALESCE(sum((later.value->>'gross_amount')::numeric), 0)
        INTO v_later_gross_total
      FROM jsonb_array_elements(p_tenders) WITH ORDINALITY later(value, ord)
      WHERE later.ord - 1 > v_idx;

      v_line_credit := LEAST(
        v_gross - v_line_change,
        GREATEST(v_credit_total - v_later_gross_total, 0)
      );
      v_credit_left := v_credit_left - v_line_credit;
    END IF;

    IF v_line_change > 0 THEN
      IF v_change_account_id IS NULL THEN
        RAISE EXCEPTION 'Thiếu sổ quỹ tiền thối' USING ERRCODE = '22023';
      END IF;
      PERFORM 1 FROM public.accounts account_row
      WHERE account_row.id = v_change_account_id
        AND account_row.organization_id = v_org
        AND account_row.deleted_at IS NULL
        AND account_row.is_virtual
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Sổ tiền thối phải là sổ ảo của tổ chức'
          USING ERRCODE = '42501';
      END IF;
      SELECT allowed INTO v_authz
      FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', v_invoice.building_id, v_change_account_id
      );
      IF NOT COALESCE(v_authz, false) THEN
        RAISE EXCEPTION 'Không có quyền ghi tiền thối vào sổ đã chọn'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    v_line_retained := v_gross - v_line_change;
    v_line_applied := LEAST(v_line_retained - v_line_credit, v_remaining_apply);
    v_remaining_apply := v_remaining_apply - v_line_applied;

    v_line_left := v_line_applied;
    v_line_revenue := LEAST(
      v_line_left,
      GREATEST(v_revenue_due - v_revenue_covered, 0)
    );
    v_revenue_covered := v_revenue_covered + v_line_revenue;
    v_line_left := v_line_left - v_line_revenue;

    v_line_deposit := LEAST(
      v_line_left,
      GREATEST(v_deposit_due - v_deposit_covered, 0)
    );
    v_deposit_covered := v_deposit_covered + v_line_deposit;
    v_line_left := v_line_left - v_line_deposit;

    v_line_internal := LEAST(
      v_line_left,
      GREATEST(v_internal_due - v_internal_covered, 0)
    );
    v_internal_covered := v_internal_covered + v_line_internal;
    v_line_left := v_line_left - v_line_internal;
    IF abs(v_line_left) >= 0.01 THEN
      RAISE EXCEPTION 'Dòng thanh toán không phân bổ hết vào semantic hóa đơn'
        USING ERRCODE = '55000';
    END IF;

    IF v_idx = v_rounding_line_idx AND v_rounding_total > 0 THEN
      IF v_rounding_account_id IS NULL THEN
        RAISE EXCEPTION 'Thiếu sổ quỹ làm tròn' USING ERRCODE = '22023';
      END IF;
      PERFORM 1 FROM public.accounts account_row
      WHERE account_row.id = v_rounding_account_id
        AND account_row.organization_id = v_org
        AND account_row.deleted_at IS NULL
        AND account_row.is_virtual
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Sổ làm tròn phải là sổ ảo của tổ chức'
          USING ERRCODE = '42501';
      END IF;
      SELECT allowed INTO v_authz
      FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', v_invoice.building_id, v_rounding_account_id
      );
      IF NOT COALESCE(v_authz, false) THEN
        RAISE EXCEPTION 'Không có quyền dùng sổ làm tròn đã chọn'
          USING ERRCODE = '42501';
      END IF;
      v_rounding_target_account := v_rounding_account_id;
    END IF;

    INSERT INTO public.invoice_payment_tenders (
      organization_id, collection_id, line_index, payment_method, account_id,
      change_account_id, rounding_account_id, gross_amount, retained_amount,
      applied_amount, change_amount, credit_amount, rounding_amount, receipt_number
    ) VALUES (
      v_org, v_collection_id, v_idx, v_method, v_account_id,
      v_change_account_id, v_rounding_account_id, v_gross, v_line_retained,
      v_line_applied, v_line_change, v_line_credit,
      CASE WHEN v_idx = v_rounding_line_idx THEN v_rounding_total ELSE 0 END,
      NULLIF(v_tender->>'receipt_number', '')
    ) RETURNING id INTO v_tender_id;

    IF v_line_applied > 0 THEN
      INSERT INTO public.payments (
        organization_id, user_id, invoice_id, receipt_number, amount,
        received_amount, credit_amount, change_amount, rounding_amount,
        payment_method, payment_date, notes, receipt_image_url,
        collection_id, tender_id
      ) VALUES (
        v_org, v_owner, p_invoice_id, NULLIF(v_tender->>'receipt_number', ''),
        v_line_applied, v_line_retained, v_line_credit, v_line_change,
        CASE WHEN v_idx = v_rounding_line_idx THEN v_rounding_total ELSE 0 END,
        v_method, p_collection_date, NULLIF(btrim(p_notes), ''),
        CASE WHEN v_idx = 0 THEN p_receipt_image_url END,
        v_collection_id, v_tender_id
      ) RETURNING id INTO v_payment_id;
    ELSE
      v_payment_id := NULL;
    END IF;

    IF v_line_retained > 0
       OR v_line_change > 0
       OR (v_idx = v_rounding_line_idx AND v_rounding_total > 0) THEN
      INSERT INTO public.income_expenses (
        user_id, organization_id, type, name, building_id, room_id, contract_id,
        account_id, invoice_id, payment_id, payment_collection_id, voucher_date,
        payer_name, notes, attachments, total_amount, approval_status,
        approved_by, approved_at, business_result_accounting, creator_name,
        change_amount, change_account_id, rounding_amount, rounding_account_id,
        system_source, idempotency_key
      ) VALUES (
        v_owner, v_org, 'INCOME', 'Thu tiền theo HĐ ' || COALESCE(v_invoice.invoice_number, ''),
        v_invoice.building_id, v_invoice.room_id, v_invoice.contract_id,
        v_account_id, p_invoice_id, v_payment_id, v_collection_id, p_collection_date,
        NULL, NULLIF(btrim(p_notes), ''),
        CASE WHEN v_idx = 0 AND p_receipt_image_url IS NOT NULL
          THEN jsonb_build_array(p_receipt_image_url) ELSE '[]'::jsonb END,
        v_line_retained, 'APPROVED', v_actor, clock_timestamp(), NULL,
        v_creator_name, v_line_change, v_change_account_id,
        CASE WHEN v_idx = v_rounding_line_idx THEN v_rounding_total ELSE 0 END,
        CASE WHEN v_idx = v_rounding_line_idx THEN v_rounding_account_id END,
        'invoice.collection.v5', v_key || ':tender:' || v_idx
      ) RETURNING id INTO v_voucher_id;

      IF v_line_revenue > 0 THEN
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_voucher_id, v_org, v_revenue_type_id,
          'Thanh toán HĐ ' || COALESCE(v_invoice.invoice_number, ''),
          1, v_line_revenue, v_line_revenue, p_collection_date, p_collection_date, 'PNL'
        ) RETURNING id INTO v_item_id;
        INSERT INTO public.invoice_payment_allocations (
          organization_id, collection_id, tender_id, voucher_id,
          income_expense_item_id, accounting_class, amount
        ) VALUES (
          v_org, v_collection_id, v_tender_id, v_voucher_id,
          v_item_id, 'PNL', v_line_revenue
        );
      END IF;

      IF v_line_deposit > 0 THEN
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_voucher_id, v_org, v_deposit_type_id,
          'Tiền cọc theo HĐ ' || COALESCE(v_invoice.invoice_number, ''),
          1, v_line_deposit, v_line_deposit, p_collection_date, p_collection_date, 'DEPOSIT'
        ) RETURNING id INTO v_item_id;
        INSERT INTO public.invoice_payment_allocations (
          organization_id, collection_id, tender_id, voucher_id,
          income_expense_item_id, accounting_class, amount
        ) VALUES (
          v_org, v_collection_id, v_tender_id, v_voucher_id,
          v_item_id, 'DEPOSIT', v_line_deposit
        );
      END IF;

      IF v_line_internal > 0 THEN
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_voucher_id, v_org, v_revenue_type_id,
          'Khoản ngoài KQKD theo HĐ ' || COALESCE(v_invoice.invoice_number, ''),
          1, v_line_internal, v_line_internal,
          p_collection_date, p_collection_date, 'INTERNAL'
        ) RETURNING id INTO v_item_id;
        INSERT INTO public.invoice_payment_allocations (
          organization_id, collection_id, tender_id, voucher_id,
          income_expense_item_id, accounting_class, amount
        ) VALUES (
          v_org, v_collection_id, v_tender_id, v_voucher_id,
          v_item_id, 'INTERNAL', v_line_internal
        );
      END IF;

      IF v_line_credit > 0 THEN
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_voucher_id, v_org, v_credit_type_id,
          'Tiền khách trả thừa từ HĐ ' || COALESCE(v_invoice.invoice_number, ''),
          1, v_line_credit, v_line_credit, p_collection_date, p_collection_date,
          'CUSTOMER_CREDIT'
        ) RETURNING id INTO v_item_id;
        INSERT INTO public.invoice_payment_allocations (
          organization_id, collection_id, tender_id, voucher_id,
          income_expense_item_id, accounting_class, amount
        ) VALUES (
          v_org, v_collection_id, v_tender_id, v_voucher_id,
          v_item_id, 'CUSTOMER_CREDIT', v_line_credit
        );
      END IF;

      INSERT INTO app_private.income_expense_flow_ownership (
        income_expense_id, organization_id, flow_kind, flow_version,
        lifecycle_owner, lifecycle_state, writer_operation,
        payload_hash_scheme, payload_hash_value, maker_user_id,
        claimed_by_user_id, correlation_id
      ) VALUES (
        v_voucher_id, v_org, 'INVOICE_COLLECTION_V5', 5,
        'INVOICE_COLLECTION_V5', 'APPROVED', 'invoice.collection.v5',
        'PG_MD5_JSONB_TEXT_V1', v_hash, v_actor, v_actor, v_collection_id
      ) ON CONFLICT (income_expense_id) DO NOTHING;
    END IF;

    UPDATE public.invoice_payment_tenders
       SET payment_id = v_payment_id, voucher_id = v_voucher_id
     WHERE id = v_tender_id;

    -- A fully returned tender has no real cash movement. The generic bridge
    -- skips zero-value vouchers, so emit ONLY its virtual change audit line.
    -- A real MAIN line here would fabricate income. Keep a posting lineage so
    -- the existing collection reversal can mirror/cancel this audit as usual.
    IF v_explicit_change AND v_line_retained = 0 AND v_line_change > 0 THEN
      IF app_private.evaluate_feature_route('income_expense.posting.v2', v_org) <> 'CANONICAL' THEN
        RAISE EXCEPTION 'Ghi sổ tiền thối chưa bật hoặc đang bị đóng băng' USING ERRCODE = '55000';
      END IF;
      INSERT INTO public.income_expense_postings (
        organization_id, voucher_id, posting_subject_kind, posting_subject_id,
        direction, account_id, gross_amount, voucher_amount_snapshot, amount_basis,
        net_cash_effect, posted_on, posted_by_membership_id, posted_by_user_id,
        approval_version, event_kind, idempotency_key, source_kind,
        external_source_kind, external_source_id, external_source_line_id, posting_generation
      ) VALUES (
        v_org, v_voucher_id, 'VOUCHER', v_voucher_id,
        'INCOME', v_account_id, v_gross, 0, 'EXTERNAL_TENDER_GROSS',
        v_line_change, p_collection_date, v_collector_membership, v_actor,
        1, 'POSTING', 'v5:refund-audit:' || v_tender_id::text, 'COLLECTION_V5_ADAPTER',
        'COLLECTION_V5', v_collection_id, v_tender_id, 1
      ) RETURNING id INTO v_refund_audit_posting;
      INSERT INTO public.income_expense_posting_lines
        (organization_id, posting_id, account_id, line_kind, signed_amount)
      VALUES (v_org, v_refund_audit_posting, v_change_account_id, 'CHANGE', v_line_change);
      v_refund_audit_evidence := app_private.register_system_evidence_v2(
        v_org, 'INVOICE_COLLECTION_V5', v_collection_id, v_tender_id, NULL,
        md5(v_gross::text || ':0:' || v_tender_id::text));
      INSERT INTO public.income_expense_posting_evidence
        (organization_id, posting_id, evidence_id, relation_kind)
      VALUES (v_org, v_refund_audit_posting, v_refund_audit_evidence, 'ORIGINAL');
      INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
      VALUES (v_voucher_id, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
      ON CONFLICT (income_expense_id) DO UPDATE SET xid=excluded.xid, purpose=excluded.purpose;
      UPDATE public.income_expenses
        SET active_posting_id_v2 = v_refund_audit_posting, posting_status = 'POSTED',
            posting_id = v_refund_audit_posting, posted_at_v2 = now()
      WHERE id = v_voucher_id;
      DELETE FROM app_private.ie_transition_authorization
      WHERE income_expense_id = v_voucher_id AND xid = pg_current_xact_id();
    END IF;

    v_tender_results := v_tender_results || jsonb_build_array(jsonb_build_object(
      'tender_id', v_tender_id,
      'payment_id', v_payment_id,
      'voucher_id', v_voucher_id,
      'applied_amount', v_line_applied,
      'revenue_amount', v_line_revenue,
      'internal_amount', v_line_internal,
      'deposit_amount', v_line_deposit,
      'credit_amount', v_line_credit,
      'change_amount', v_line_change
    ));
    v_idx := v_idx + 1;
  END LOOP;

  IF v_remaining_apply <> 0 OR v_change_left <> 0 OR v_credit_left <> 0 THEN
    RAISE EXCEPTION 'Phân bổ collection không cân bằng' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_payment_tenders tender
    LEFT JOIN public.invoice_payment_allocations allocation
      ON allocation.tender_id = tender.id
    WHERE tender.collection_id = v_collection_id
    GROUP BY tender.id, tender.retained_amount
    HAVING abs(
      tender.retained_amount - COALESCE(sum(allocation.amount), 0)
    ) >= 0.01
  ) THEN
    RAISE EXCEPTION 'Tổng allocation không khớp số tiền giữ lại của tender'
      USING ERRCODE = '55000';
  END IF;

  IF v_credit_total > 0 THEN
    SELECT count(*) INTO v_credit_tender_count
    FROM public.invoice_payment_tenders
    WHERE collection_id = v_collection_id AND credit_amount > 0;
    IF v_credit_tender_count = 1 THEN
      SELECT id, payment_id INTO v_tender_id, v_payment_id
      FROM public.invoice_payment_tenders
      WHERE collection_id = v_collection_id AND credit_amount > 0;
    ELSE
      v_tender_id := NULL;
      v_payment_id := NULL;
    END IF;

    INSERT INTO public.customer_credit_lots (
      organization_id, contract_id, source_collection_id, source_tender_id,
      source_payment_id, amount, remaining_amount, status
    ) VALUES (
      v_org, v_invoice.contract_id, v_collection_id, v_tender_id,
      v_payment_id, v_credit_total, v_credit_total, 'ACTIVE'
    ) RETURNING id INTO v_credit_lot_id;

    INSERT INTO public.excess_amounts (
      organization_id, user_id, contract_id, amount, description,
      source_invoice_id, source_payment_id, credit_lot_id
    ) VALUES (
      v_org, v_owner, v_invoice.contract_id, v_credit_total,
      'Tiền thừa từ hóa đơn ' || COALESCE(v_invoice.invoice_number, ''),
      p_invoice_id, v_payment_id, v_credit_lot_id
    ) RETURNING id INTO v_excess_id;

    UPDATE public.customer_credit_lots
       SET source_excess_amount_id = v_excess_id
     WHERE id = v_credit_lot_id;
  END IF;

  PERFORM public.recompute_invoice_for_id(p_invoice_id);
  PERFORM public.recompute_contract_deposit_paid(v_invoice.contract_id);

  SELECT jsonb_build_object(
    'collection_id', v_collection_id,
    'invoice_id', p_invoice_id,
    'gross_amount', v_gross_total,
    'applied_amount', v_applied_total,
    'change_amount', v_change_total,
    'credit_amount', v_credit_total,
    'rounding_amount', v_rounding_total,
    'credit_lot_id', v_credit_lot_id,
    'tenders', v_tender_results,
    'invoice', to_jsonb(invoice_row)
  ) INTO v_response
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id;

  UPDATE app_private.canonical_write_operations
     SET subject_id = v_collection_id,
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_org
     AND operation = 'invoice.collection.v5'
     AND subject_scope = p_invoice_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;

  PERFORM app_private.end_accounting_chain_write_v1();
  RETURN v_response;
END;
$function$;

COMMIT;
NOTIFY pgrst, 'reload schema';
