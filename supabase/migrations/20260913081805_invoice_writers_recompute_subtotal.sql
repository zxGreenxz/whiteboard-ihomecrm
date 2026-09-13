-- 20260913081805_invoice_writers_recompute_subtotal.sql
-- Guard tạm tính cho hai writer hoá đơn tạo/nháp: server tự cộng lại các dòng thay vì
-- tin p_subtotal và amount client gửi (cùng luật với adjust_invoice_v2). Chữ ký không đổi
-- → CREATE OR REPLACE giữ nguyên ACL. Thân hàm chép từ định nghĩa sống 13/09/2026
-- (md5 create 6545b33eae9919b5249dbd505e60be2a, update 9ddc3b16ca488c1c1bad8210a95ae851),
-- chỉ chèn một khối guard vào mỗi hàm. Idempotent: chạy lại cho cùng kết quả.
-- Kiểm chứng: src/lib/__tests__/invoiceWriterSubtotalGuard.test.ts (PGlite, định nghĩa sống).
BEGIN;

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
  v_line_sum numeric := 0; v_price numeric; v_qty numeric; v_coef numeric; v_amount numeric;
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
  -- ---- Guard 13/09/2026: server tự cộng lại dòng, không tin p_subtotal ----
  -- Cùng luật với app_private.normalize_invoice_adjustment_items_v2 (adjust_invoice_v2):
  -- giá/số lượng/hệ số không âm, không NaN; amount (nếu gửi) phải = u×q×c; Σ dòng = tạm tính.
  -- Sai số chấp nhận 1 đồng (dòng cũ 33.333,33 × 3 = 99.999,99 ghi 100.000).
  v_line_sum := 0;
  FOR it IN SELECT value FROM jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) LOOP
    BEGIN
      v_price := coalesce((it->>'unit_price')::numeric, 0);
      v_qty   := coalesce((it->>'quantity')::numeric, 1);
      v_coef  := coalesce((it->>'coefficient')::numeric, 1);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Giá, số lượng hoặc hệ số hạng mục không hợp lệ' USING ERRCODE='22023';
    END;
    IF v_price < 0 OR v_qty < 0 OR v_coef < 0
       OR v_price::text IN ('NaN','Infinity','-Infinity')
       OR v_qty::text   IN ('NaN','Infinity','-Infinity')
       OR v_coef::text  IN ('NaN','Infinity','-Infinity')
       OR v_price*v_qty*v_coef >= 10000000000000 THEN
      RAISE EXCEPTION 'Giá, số lượng hoặc hệ số hạng mục không hợp lệ' USING ERRCODE='22023';
    END IF;
    v_amount := round(v_price*v_qty*v_coef, 2);
    IF it ? 'amount' AND (it->>'amount') IS NOT NULL
       AND abs(coalesce((it->>'amount')::numeric,0) - v_amount) >= 1 THEN
      RAISE EXCEPTION 'Thành tiền dòng "%" (%) không bằng đơn giá × số lượng × hệ số (%)',
        coalesce(it->>'description',''), (it->>'amount')::numeric, v_amount USING ERRCODE='22023';
    END IF;
    v_line_sum := v_line_sum + coalesce((it->>'amount')::numeric, v_amount);
  END LOOP;
  IF abs(v_line_sum - coalesce(p_subtotal,0)) >= 1 THEN
    RAISE EXCEPTION 'Tạm tính client (%) khác tổng các dòng do server cộng lại (%)',
      coalesce(p_subtotal,0), v_line_sum USING ERRCODE='22000';
  END IF;
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
  v_line_sum numeric := 0; v_price numeric; v_qty numeric; v_coef numeric; v_amount numeric;
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

  -- ---- Guard 13/09/2026: server tự cộng lại dòng, không tin p_subtotal ----
  -- Cùng luật với app_private.normalize_invoice_adjustment_items_v2 (adjust_invoice_v2):
  -- giá/số lượng/hệ số không âm, không NaN; amount (nếu gửi) phải = u×q×c; Σ dòng = tạm tính.
  -- Sai số chấp nhận 1 đồng (dòng cũ 33.333,33 × 3 = 99.999,99 ghi 100.000).
  v_line_sum := 0;
  FOR it IN SELECT value FROM jsonb_array_elements(coalesce(v_normalized_items,'[]'::jsonb)) LOOP
    BEGIN
      v_price := coalesce((it->>'unit_price')::numeric, 0);
      v_qty   := coalesce((it->>'quantity')::numeric, 1);
      v_coef  := coalesce((it->>'coefficient')::numeric, 1);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Giá, số lượng hoặc hệ số hạng mục không hợp lệ' USING ERRCODE='22023';
    END;
    IF v_price < 0 OR v_qty < 0 OR v_coef < 0
       OR v_price::text IN ('NaN','Infinity','-Infinity')
       OR v_qty::text   IN ('NaN','Infinity','-Infinity')
       OR v_coef::text  IN ('NaN','Infinity','-Infinity')
       OR v_price*v_qty*v_coef >= 10000000000000 THEN
      RAISE EXCEPTION 'Giá, số lượng hoặc hệ số hạng mục không hợp lệ' USING ERRCODE='22023';
    END IF;
    v_amount := round(v_price*v_qty*v_coef, 2);
    IF it ? 'amount' AND (it->>'amount') IS NOT NULL
       AND abs(coalesce((it->>'amount')::numeric,0) - v_amount) >= 1 THEN
      RAISE EXCEPTION 'Thành tiền dòng "%" (%) không bằng đơn giá × số lượng × hệ số (%)',
        coalesce(it->>'description',''), (it->>'amount')::numeric, v_amount USING ERRCODE='22023';
    END IF;
    v_line_sum := v_line_sum + coalesce((it->>'amount')::numeric, v_amount);
  END LOOP;
  IF abs(v_line_sum - coalesce(p_subtotal,0)) >= 1 THEN
    RAISE EXCEPTION 'Tạm tính client (%) khác tổng các dòng do server cộng lại (%)',
      coalesce(p_subtotal,0), v_line_sum USING ERRCODE='22000';
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
