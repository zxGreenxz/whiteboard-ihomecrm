-- Preserve invoice item accounting snapshots and sum actual deposit portions.
-- Live definitions captured 2026-09-08; preconditions reject unknown writer drift.
-- No data backfill: historical correction has its own reviewed migration.
BEGIN;
DO $preflight$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef('update_invoice_v1(uuid,uuid,uuid,uuid,text,date,date,numeric,numeric,numeric,numeric,jsonb,numeric,text,boolean,jsonb,uuid,text)'::regprocedure) INTO v_def;
  IF md5(v_def)<>'c18b3cdb867d5883e4800a269fe1459e' AND md5(v_def)<>'e65adc42da19f3343fcc21f3ebb3e0d8' THEN
    RAISE EXCEPTION 'Unexpected definition drift: update_invoice_v1';
  END IF;
  SELECT pg_get_functiondef('create_invoice_v1(uuid,uuid,uuid,text,date,date,text,numeric,numeric,numeric,numeric,jsonb,text,numeric,text,boolean,jsonb,uuid,text,numeric,text)'::regprocedure) INTO v_def;
  IF md5(v_def)<>'bc78bf80e6b278c543f9d6771e78b5db' AND md5(v_def)<>'6545b33eae9919b5249dbd505e60be2a' THEN
    RAISE EXCEPTION 'Unexpected definition drift: create_invoice_v1';
  END IF;
  SELECT pg_get_functiondef('app_private.contract_deposit_sources_v1(uuid,uuid,timestamp with time zone)'::regprocedure) INTO v_def;
  IF md5(v_def)<>'670dcef06ff381f27b303be4da18b391' AND md5(v_def)<>'14527414bc43c36d1500511c843d79d7' THEN
    RAISE EXCEPTION 'Unexpected definition drift: contract_deposit_sources_v1';
  END IF;
END $preflight$;

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
  if v_row.status not in ('DRAFT'::invoice_status, 'APPROVED'::invoice_status)
     or coalesce(v_row.paid_amount,0) <> 0 then
    raise exception 'Không thể chỉnh sửa hoá đơn ở trạng thái này';
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

CREATE OR REPLACE FUNCTION public.create_invoice_v1(p_contract_id uuid, p_building_id uuid, p_room_id uuid, p_billing_month text, p_issue_date date, p_due_date date, p_kind text, p_subtotal numeric, p_discount_amount numeric, p_total_amount numeric, p_previous_debt numeric, p_items jsonb, p_idempotency_key text, p_prepaid_amount numeric DEFAULT 0, p_discount_notes text DEFAULT NULL::text, p_electricity_prev_overridden boolean DEFAULT false, p_previous_debt_sources jsonb DEFAULT '[]'::jsonb, p_template_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_applied_credit numeric DEFAULT 0, p_creator_name text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_authz boolean;
  v_auto boolean;
  v_status text;
  v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype;
  v_route text;
  v_invoice uuid;
  v_invoice_number text;
  v_resp json;
  it jsonb; v_idx int := 0;
  v_total_calc numeric(15,2);
  v_applied numeric(15,2);
  c_op constant text := 'invoice.create.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  v_key := btrim(coalesce(p_idempotency_key,''));
  if char_length(v_key) < 8 or char_length(v_key) > 200
     or v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_total_amount is null or p_total_amount < 0 then raise exception 'Tổng tiền không hợp lệ'; end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items phải là JSON array'; end if;

  FOR it IN SELECT value FROM jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) LOOP
    IF jsonb_typeof(it) IS DISTINCT FROM 'object' OR
       (it ? 'accounting_class' AND ((it->>'accounting_class') IS NULL OR
        (it->>'accounting_class') NOT IN ('REVENUE','DEPOSIT','NON_PNL'))) THEN
      RAISE EXCEPTION 'accounting_class không hợp lệ' USING ERRCODE='22023';
    END IF;
  END LOOP;

  -- derive + lock: building → org; contract same-org; room same-building/org.
  select b.organization_id into v_org from public.buildings b
    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where b.id=p_building_id and b.deleted_at is null for share of o,b;
  if not found or v_org is null then
    raise exception 'Toà nhà không thuộc tổ chức đang hoạt động' using errcode='42501'; end if;
  -- contracts link to a building via their room, not a direct building_id column.
  perform 1 from public.contracts c where c.id=p_contract_id and c.deleted_at is null
    and c.organization_id=v_org for share;
  if not found then raise exception 'Hợp đồng không thuộc tổ chức' using errcode='42501'; end if;
  if p_room_id is not null then
    perform 1 from public.rooms r where r.id=p_room_id and r.deleted_at is null
      and r.building_id=p_building_id and r.organization_id=v_org for share;
    if not found then raise exception 'Phòng không thuộc toà/tổ chức' using errcode='42501'; end if;
  end if;

  -- exact permission invoices.create, building-scoped.
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'invoices.create', p_building_id, null);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền tạo hoá đơn (invoices.create)' using errcode='42501'; end if;

  -- server decides APPROVED vs DRAFT from org settings; missing row = abort.
  select auto_approve_invoice into v_auto from public.organization_invoice_settings
   where organization_id = v_org;
  if v_auto is null then
    raise exception 'Thiếu cấu hình auto_approve_invoice cho tổ chức' using errcode='55000'; end if;
  v_status := case when v_auto then 'APPROVED' else 'DRAFT' end;

  v_hash := md5(jsonb_build_object('contract',p_contract_id,'month',p_billing_month,
    'total',p_total_amount,'org',v_org)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_contract_id::text || '|' || p_billing_month, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op
     and o.subject_scope=p_contract_id::text || '|' || p_billing_month
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then
    raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then
    raise exception 'Writer hoá đơn chưa bật cho tổ chức này' using errcode='55000'; end if;

  -- ---- PARITY: làm tròn server mirror roundInvoiceTotal + ASSERT khớp total ----
  -- total = round(p_subtotal − discount + nợ cũ) TRÊN SUBTOTAL CLIENT GỬI (KHÔNG
  -- re-sum items — giữ giả định item-shape của mọi caller, gồm create_contract_v1).
  -- KHÔNG clamp ≥0 (mirror useCreateInvoice; KHÁC clamp hiển thị Math.max(0,…) của
  -- GenerateInvoiceDialog). Guard p_total_amount<0 ở trên vẫn chặn tổng âm.
  v_total_calc := app_private.round_invoice_total_v1(
    coalesce(p_subtotal,0) - coalesce(p_discount_amount,0) + coalesce(p_previous_debt,0));

  if v_total_calc is distinct from p_total_amount then
    raise exception
      'Tổng tiền client (%) khác tổng server làm tròn (%) [subtotal=%, discount=%, nợ cũ=%]',
      p_total_amount, v_total_calc, coalesce(p_subtotal,0),
      coalesce(p_discount_amount,0), coalesce(p_previous_debt,0)
      using errcode='22000';
  end if;

  -- create the invoice; the live partial-unique (contract_id, billing_month)
  -- WHERE deleted_at IS NULL AND status<>'CANCELLED' AND kind='MONTHLY'
  -- enforces one-per-period. invoice_number BỎ TRỐNG → trigger
  -- generate_invoice_number_v2 (BEFORE INSERT) tự sinh.
  insert into public.invoices
    (user_id, organization_id, contract_id, building_id, room_id, billing_month,
     issue_date, due_date, kind, status, subtotal, discount_amount, discount_notes,
     electricity_prev_overridden, total_amount, prepaid_amount, paid_amount,
     previous_debt, previous_debt_sources, notes, template_id, creator_name,
     approved_by, approved_at)
  values
    (v_actor, v_org, p_contract_id, p_building_id, p_room_id, p_billing_month,
     p_issue_date, p_due_date, coalesce(p_kind,'MONTHLY'), v_status::invoice_status,
     coalesce(p_subtotal,0), coalesce(p_discount_amount,0), p_discount_notes,
     coalesce(p_electricity_prev_overridden,false), p_total_amount,
     coalesce(p_prepaid_amount,0), 0,
     coalesce(p_previous_debt,0),
     coalesce(p_previous_debt_sources,'[]'::jsonb), p_notes, p_template_id,
     p_creator_name,
     case when v_auto then v_actor else null end,
     case when v_auto then now() else null end)
  returning id, invoice_number into v_invoice, v_invoice_number;

  -- ---- PARITY: bước tiêu credit (mirror useCreateInvoice:639-652) ----
  -- Áp credit vào Giảm trừ HĐ → ghi excess_amounts ÂM CÙNG TX. amount đã cộng vào
  -- discount_amount ở client nên KHÔNG trừ 2 lần; row âm chỉ hạ số dư credit HĐ.
  v_applied := coalesce(p_applied_credit,0);
  if v_applied > 0 and p_contract_id is not null then
    insert into public.excess_amounts
      (user_id, organization_id, contract_id, amount, description,
       source_invoice_id, source_payment_id)
    values
      (v_actor, v_org, p_contract_id, -v_applied,
       'Áp credit vào Giảm trừ HĐ ' || coalesce(v_invoice_number, v_invoice::text),
       v_invoice, null);
  end if;

  -- ---- PARITY: items whitelist 12 field client ----
  -- amount = amount client gửi (1 trong 12 field, giữ hành vi writer cũ), fallback
  -- tính unit_price*quantity*coefficient nếu vắng. sort_order lấy client, fallback
  -- thứ tự xuất hiện.
  if p_items is not null then
    for it in select value from jsonb_array_elements(p_items) loop
      v_idx := v_idx + 1;
      insert into public.invoice_items
        (invoice_id, organization_id, service_id, type, description, unit_price,
         quantity, coefficient, amount, previous_reading, current_reading,
         from_date, to_date, sort_order, accounting_class)
      values (
        v_invoice, v_org,
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

  v_resp := json_build_object('invoice_id', v_invoice, 'status', v_status,
                              'invoice_number', v_invoice_number);
  update app_private.canonical_write_operations
     set subject_id=v_invoice, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op
     and subject_scope=p_contract_id::text || '|' || p_billing_month
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.contract_deposit_sources_v1(p_organization_id uuid, p_contract_id uuid, p_as_of timestamp with time zone DEFAULT now())
 RETURNS TABLE(voucher_id uuid, code text, direction text, bucket text, exclude_reason text, amount numeric, signed_amount numeric, account_id uuid, is_virtual boolean, system_source text, voucher_date date, created_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH linked AS (
    SELECT ie.id FROM public.income_expenses ie
     WHERE ie.organization_id=p_organization_id AND ie.contract_id=p_contract_id
    UNION
    SELECT l.income_expense_id FROM public.contract_deposit_links l
     WHERE l.organization_id=p_organization_id AND l.contract_id=p_contract_id
  )
  SELECT ie.id, ie.code,
         CASE WHEN ie.type = 'INCOME' THEN 'IN' ELSE 'OUT' END,
         CASE
           WHEN ie.deleted_at IS NOT NULL              THEN 'EXCLUDED'
           WHEN ie.approval_status = 'CANCELLED'       THEN 'EXCLUDED'
           WHEN ie.approval_status IS DISTINCT FROM 'APPROVED'       THEN 'EXCLUDED'
           WHEN ie.reversal_of_income_expense_id IS NOT NULL THEN 'EXCLUDED'
           WHEN ie.posting_status = 'REVERSED'         THEN 'EXCLUDED'
           WHEN COALESCE(a.is_virtual, false)          THEN 'RECOGNIZED_HISTORICAL'
           WHEN ie.posting_status = 'POSTED'           THEN 'REAL_CASH'
           ELSE 'EXCLUDED'
         END,
         CASE
           WHEN ie.deleted_at IS NOT NULL        THEN 'đã xoá'
           WHEN ie.approval_status = 'CANCELLED' THEN 'đã huỷ'
           WHEN ie.approval_status IS DISTINCT FROM 'APPROVED' THEN 'chưa duyệt'
           WHEN ie.reversal_of_income_expense_id IS NOT NULL THEN 'phiếu đảo bút toán'
           WHEN ie.posting_status = 'REVERSED'   THEN 'đã đảo bút toán'
           WHEN COALESCE(a.is_virtual,false)     THEN NULL
           WHEN ie.posting_status IS DISTINCT FROM 'POSTED'    THEN 'chưa ghi sổ'
           ELSE NULL
         END,
         deposit_items.amount,
         CASE
           WHEN ie.deleted_at IS NOT NULL
             OR ie.approval_status = 'CANCELLED'
             OR ie.approval_status IS DISTINCT FROM 'APPROVED'
             OR ie.reversal_of_income_expense_id IS NOT NULL
             OR ie.posting_status = 'REVERSED'
             OR (NOT COALESCE(a.is_virtual,false) AND ie.posting_status IS DISTINCT FROM 'POSTED')
           THEN 0
           WHEN ie.type = 'INCOME' THEN deposit_items.amount
           ELSE -deposit_items.amount
         END,
         ie.account_id, COALESCE(a.is_virtual, false), ie.system_source,
         ie.voucher_date, ie.created_at
    FROM linked
    JOIN public.income_expenses ie ON ie.id=linked.id
    JOIN public.contracts c ON c.id=p_contract_id AND c.organization_id=p_organization_id
    LEFT JOIN public.accounts a ON a.id=ie.account_id AND a.organization_id=p_organization_id
    JOIN LATERAL (
      SELECT sum(coalesce(it.amount,it.unit_price*it.quantity)) AS amount
        FROM public.income_expense_items it
       WHERE it.income_expense_id=ie.id AND it.organization_id=p_organization_id
         AND it.accounting_class='DEPOSIT'
    ) deposit_items ON deposit_items.amount IS NOT NULL
   WHERE ie.organization_id = p_organization_id
     AND ie.created_at <= p_as_of
   -- Thứ tự ỔN ĐỊNH: hai lần gọi phải cho cùng một danh sách.
   ORDER BY ie.created_at, ie.id;
$function$
;

COMMENT ON FUNCTION app_private.contract_deposit_sources_v1(uuid,uuid,timestamptz) IS
'Deposit snapshots only; sum DEPOSIT items on direct or explicitly linked vouchers once. Preserve real cash versus historical recognition, exclude cancelled/unapproved/reversed/deleted sources. Never classify by display name.';
REVOKE ALL ON FUNCTION app_private.contract_deposit_sources_v1(uuid,uuid,timestamptz) FROM PUBLIC,anon,authenticated;
COMMIT;
