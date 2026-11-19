-- Hàm dùng chung DỰNG DÒNG ĐIỀU CHỈNH hoá đơn (luật 17/10: công thức dùng ≥ 2 nơi đặt trong database) — Đợt 3 trang Hoá đơn Mốc 5
-- (docs/plans/hermes-crm/HOA-DON-THAO-TAC-GHI.md mục 4.3, 6.3). Một nguồn luật cho form điều chỉnh của web và thao tác invoice.adjust
-- của trợ lý; hàm ghi vẫn là public.adjust_invoice_v2 (trọng tài cuối: quyền, khoá lạc quan, làm tròn tổng, đối soát cơ cấu).
-- public.invoice_adjustment_build_v1(p_invoice_id uuid, p_ops jsonb DEFAULT '{}') RETURNS jsonb — plpgsql STABLE SECURITY INVOKER
-- search_path='': đọc hoá đơn + dòng dưới RLS người gọi (authenticated), hoặc dưới quyền chủ hàm khi bước ghi DEFINER gọi (postgres) sau
-- khi đã tự đối chiếu phạm vi. Không ghi, không khoá dòng nào, không gọi app_private (vai authenticated không có USAGE).
--  * Dòng giữ nguyên = luật toAdjustmentItem (src/lib/invoiceAdjustmentEntry.ts): giữ id, service_id, loại, phân loại kế toán (mặc định
--    REVENUE), mô tả, chỉ số, kỳ, sort_order; adjust_invoice_v2 tính lại thành tiền = đơn giá × SL × hệ số và bỏ qua amount gửi lên, nên
--    dòng có thành tiền đã lưu lệch đơn giá × SL × hệ số (≥ 0,01) quy về đơn giá = thành tiền, SL 1, hệ số 1 (không thì "giữ nguyên" làm mất tiền).
--  * p_ops = {discountAdd?: số ≥ 0 (giảm THÊM, HDN5), addItems?: [{description, amount}] (dòng OTHER, phân loại REVENUE như mặc định của
--    web — chủ chốt 12/09 không cho chọn), setItems?: [{id, amount}] (đặt thành tiền một dòng theo id: đơn giá = amount, SL 1, hệ số 1)}.
--    Khớp dòng theo lời người dùng là việc của nơi gọi (Hermes khớp mô tả ở tầng tra cứu); ở đây chỉ theo id.
--  * Dòng KHOÁ (lock): có chỉ số (điện/nước theo công tơ), SERVICE có chữ "điện"/"nước" trong mô tả (đúng luật nhận diện dòng điện/nước
--    của decomposeInvoice), cọc (DEPOSIT), NON_PNL, dòng DISCOUNT (hoá đơn thanh lý). setItems vào dòng khoá ⇒ blocker line_locked.
--  * Chặn cả hoá đơn (blockers): not_found, not_issued (chỉ APPROVED/PARTIAL_PAID/PAID/OVERDUE điều chỉnh được — câu 55000 của
--    adjust_invoice_v2), settlement + debt_source_invalid / debt_source_mismatch (đúng luật adjustmentReconcileBlocker của web: nợ cũ phải
--    khớp tổng nguồn đối chiếu, nguồn chỉ 'invoice'/'deposit' với số hữu hạn ≥ 0), line_not_found (id không thuộc hoá đơn), invalid_ops.
--  * Tổng sau KHÔNG tính ở đây: hàm làm tròn app_private.round_invoice_total_v1 nằm ngoài tầm INVOKER; tổng sau lấy từ chạy thử hàm ghi.
-- File không chứa hàm trợ lý (lệ hàm dùng chung). Không ghi dữ liệu nghiệp vụ, không đổi hàm cũ nào. Idempotent (CREATE OR REPLACE);
-- khối kiểm cuối chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('public.invoices') IS NULL OR to_regclass('public.invoice_items') IS NULL
    OR to_regprocedure('public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamp with time zone,text)') IS NULL
    OR (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='invoices'
      AND column_name IN ('subtotal','discount_amount','discount_notes','notes','previous_debt','previous_debt_sources','kind','adjustment_revision',
        'adjustment_review_status','updated_at','paid_amount','total_amount','contract_id','billing_month','invoice_number'))<>15
    OR (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='invoice_items'
      AND column_name IN ('id','invoice_id','service_id','type','accounting_class','description','unit_price','quantity','coefficient','amount',
        'previous_reading','current_reading','from_date','to_date','sort_order'))<>15 THEN
    RAISE EXCEPTION 'invoice_adjustment_build_dependency_invalid'; END IF;
END $requires$;

CREATE OR REPLACE FUNCTION public.invoice_adjustment_build_v1(p_invoice_id uuid,p_ops jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  inv record; v_items jsonb; v_lines jsonb; v_after jsonb; v_changed jsonb:='[]'::jsonb; v_blockers jsonb:='[]'::jsonb; v_ops jsonb;
  v_src jsonb; v_amount numeric; v_sourced numeric:=0; v_invalid boolean:=false; v_x jsonb; v_hit jsonb; v_next int; v_add numeric:=0;
  v_ids text[]:='{}'; v_n int;
BEGIN
  IF current_user NOT IN ('authenticated','postgres') THEN RAISE EXCEPTION 'invoice_adjustment_build_denied' USING ERRCODE='42501'; END IF;
  v_ops:=COALESCE(p_ops,'{}'::jsonb);
  -- Khuôn thao tác sai là lỗi của nơi gọi (không phải luật nghiệp vụ): 22023. Ép kiểu chỉ sau khi CASE đã xác nhận kiểu (OR không dừng sớm).
  IF p_invoice_id IS NULL OR jsonb_typeof(v_ops)<>'object'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_ops) k WHERE k NOT IN ('discountAdd','addItems','setItems'))
    OR (v_ops ? 'discountAdd' AND CASE WHEN jsonb_typeof(v_ops->'discountAdd')<>'number' THEN true
      ELSE (v_ops->>'discountAdd')::numeric NOT BETWEEN 0 AND 9999999999999 END)
    OR (v_ops ? 'addItems' AND CASE WHEN jsonb_typeof(v_ops->'addItems')<>'array' THEN true
      ELSE jsonb_array_length(v_ops->'addItems')>50 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_ops->'addItems') a WHERE CASE
        WHEN jsonb_typeof(a)<>'object' OR jsonb_typeof(a->'description') IS DISTINCT FROM 'string' OR jsonb_typeof(a->'amount') IS DISTINCT FROM 'number' THEN true
        ELSE char_length(btrim(a->>'description')) NOT BETWEEN 1 AND 500 OR (a->>'amount')::numeric NOT BETWEEN 0.01 AND 9999999999999 END) END)
    OR (v_ops ? 'setItems' AND CASE WHEN jsonb_typeof(v_ops->'setItems')<>'array' THEN true
      ELSE jsonb_array_length(v_ops->'setItems')>50 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_ops->'setItems') s WHERE CASE
        WHEN jsonb_typeof(s)<>'object' OR jsonb_typeof(s->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(s->'amount') IS DISTINCT FROM 'number' THEN true
        ELSE (s->>'id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          OR (s->>'amount')::numeric NOT BETWEEN 0 AND 9999999999999 END)
        OR (SELECT count(DISTINCT lower(s->>'id')) FROM jsonb_array_elements(v_ops->'setItems') s)<>jsonb_array_length(v_ops->'setItems') END) THEN
    RAISE EXCEPTION 'invoice_adjustment_ops_invalid' USING ERRCODE='22023';
  END IF;

  SELECT i.id,i.organization_id,i.building_id,i.room_id,i.contract_id,i.invoice_number,COALESCE(i.kind,'MONTHLY') AS kind,i.status::text AS status,
    i.billing_month,COALESCE(i.subtotal,0) AS subtotal,COALESCE(i.discount_amount,0) AS discount,i.discount_notes,i.notes,
    COALESCE(i.previous_debt,0) AS previous_debt,i.previous_debt_sources,COALESCE(i.total_amount,0) AS total,COALESCE(i.paid_amount,0) AS paid,
    i.adjustment_revision,i.adjustment_review_status,i.updated_at
    INTO inv FROM public.invoices i WHERE i.id=p_invoice_id AND i.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('invoiceId',p_invoice_id,'blockers',jsonb_build_array('not_found')); END IF;

  -- Dòng giữ nguyên (toAdjustmentItem) + nhãn khoá, theo thứ tự hàm ghi so "không đổi gì" (sort_order, id).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',it.id,'service_id',it.service_id,'type',it.type::text,
        'accounting_class',COALESCE(it.accounting_class,'REVENUE'),'description',it.description,
        'unit_price',CASE WHEN d.drift THEN it.amount ELSE d.price END,'quantity',CASE WHEN d.drift THEN 1 ELSE d.qty END,
        'coefficient',CASE WHEN d.drift THEN 1 ELSE d.coef END,'previous_reading',it.previous_reading,'current_reading',it.current_reading,
        'from_date',it.from_date,'to_date',it.to_date,'sort_order',COALESCE(it.sort_order,0)) ORDER BY it.sort_order,it.id),'[]'::jsonb),
    COALESCE(jsonb_agg(jsonb_build_object('id',it.id,'description',it.description,'type',it.type::text,'accountingClass',COALESCE(it.accounting_class,'REVENUE'),
        'amount',COALESCE(it.amount,d.price*d.qty*d.coef),
        'lock',CASE WHEN it.previous_reading IS NOT NULL OR it.current_reading IS NOT NULL THEN 'meter'
          WHEN it.type::text='SERVICE' AND (strpos(lower(translate(COALESCE(it.description,''),'ĐỆƯỚ','đệướ')),'điện')>0
            OR strpos(lower(translate(COALESCE(it.description,''),'ĐỆƯỚ','đệướ')),'nước')>0) THEN 'meter'
          WHEN COALESCE(it.accounting_class,'REVENUE')='DEPOSIT' THEN 'deposit'
          WHEN COALESCE(it.accounting_class,'REVENUE')='NON_PNL' THEN 'non_pnl'
          WHEN it.type::text='DISCOUNT' THEN 'discount_line' END) ORDER BY it.sort_order,it.id),'[]'::jsonb)
    INTO v_items,v_lines
    FROM public.invoice_items it
    CROSS JOIN LATERAL (SELECT COALESCE(it.unit_price,0) AS price,COALESCE(it.quantity,0) AS qty,COALESCE(it.coefficient,1) AS coef) b
    CROSS JOIN LATERAL (SELECT b.price,b.qty,b.coef,it.amount IS NOT NULL AND abs(it.amount-b.price*b.qty*b.coef)>=0.01 AS drift) d
    WHERE it.invoice_id=p_invoice_id;

  IF inv.status NOT IN ('APPROVED','PARTIAL_PAID','PAID','OVERDUE') THEN v_blockers:=v_blockers||'["not_issued"]'::jsonb; END IF;
  -- adjustmentReconcileBlocker: hoá đơn thanh lý (dòng hoàn trả mang dấu trừ mà hàm ghi cộng dương); nợ cũ phải khớp nguồn đối chiếu.
  IF inv.kind='SETTLEMENT' THEN v_blockers:=v_blockers||'["settlement"]'::jsonb;
  ELSIF jsonb_typeof(inv.previous_debt_sources) IS DISTINCT FROM 'array' THEN
    IF inv.previous_debt>0 THEN v_blockers:=v_blockers||'["debt_source_mismatch"]'::jsonb; END IF;
  ELSE
    FOR v_src IN SELECT value FROM jsonb_array_elements(inv.previous_debt_sources) LOOP
      -- Number(s.amount) của web: null/'' ⇒ 0; chuỗi số ⇒ số; còn lại (thiếu, chữ, vô hạn) ⇒ không hợp lệ.
      v_amount:=CASE jsonb_typeof(v_src->'amount') WHEN 'number' THEN (v_src->>'amount')::numeric WHEN 'null' THEN 0
        WHEN 'boolean' THEN CASE WHEN (v_src->>'amount')::boolean THEN 1 ELSE 0 END
        WHEN 'string' THEN CASE WHEN btrim(v_src->>'amount')='' THEN 0
          WHEN btrim(v_src->>'amount') ~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]{1,3})?$' THEN btrim(v_src->>'amount')::numeric END END;
      IF jsonb_typeof(v_src) IS DISTINCT FROM 'object' OR COALESCE(v_src->>'type','') NOT IN ('invoice','deposit') OR v_amount IS NULL OR v_amount<0 THEN
        v_invalid:=true; EXIT; END IF;
      v_sourced:=v_sourced+v_amount;
    END LOOP;
    IF v_invalid THEN v_blockers:=v_blockers||'["debt_source_invalid"]'::jsonb;
    ELSIF abs(v_sourced-inv.previous_debt)>=0.01 THEN v_blockers:=v_blockers||'["debt_source_mismatch"]'::jsonb; END IF;
  END IF;

  -- Thao tác: đặt thành tiền theo id, thêm dòng, giảm thêm.
  v_after:=v_items;
  FOR v_x IN SELECT value FROM jsonb_array_elements(COALESCE(v_ops->'setItems','[]'::jsonb)) LOOP
    SELECT l INTO v_hit FROM jsonb_array_elements(v_lines) l WHERE l->>'id'=lower(v_x->>'id');
    IF v_hit IS NULL THEN
      IF NOT v_blockers ? 'line_not_found' THEN v_blockers:=v_blockers||'["line_not_found"]'::jsonb; END IF; CONTINUE; END IF;
    IF v_hit->>'lock' IS NOT NULL THEN
      IF NOT v_blockers ? 'line_locked' THEN v_blockers:=v_blockers||'["line_locked"]'::jsonb; END IF; CONTINUE; END IF;
    SELECT jsonb_agg(CASE WHEN e->>'id'=v_hit->>'id' THEN e||jsonb_build_object('unit_price',(v_x->>'amount')::numeric,'quantity',1,'coefficient',1) ELSE e END
      ORDER BY n) INTO v_after FROM jsonb_array_elements(v_after) WITH ORDINALITY x(e,n);
    v_changed:=v_changed||jsonb_build_array(jsonb_build_object('op','set','id',v_hit->>'id','description',v_hit->>'description',
      'before',(v_hit->>'amount')::numeric,'after',(v_x->>'amount')::numeric));
  END LOOP;
  SELECT COALESCE(max((e->>'sort_order')::int),-1)+1 INTO v_next FROM jsonb_array_elements(v_after) e;
  v_n:=0;
  FOR v_x IN SELECT value FROM jsonb_array_elements(COALESCE(v_ops->'addItems','[]'::jsonb)) LOOP
    v_after:=v_after||jsonb_build_array(jsonb_build_object('id',NULL,'service_id',NULL,'type','OTHER','accounting_class','REVENUE',
      'description',btrim(v_x->>'description'),'unit_price',(v_x->>'amount')::numeric,'quantity',1,'coefficient',1,'previous_reading',NULL,
      'current_reading',NULL,'from_date',NULL,'to_date',NULL,'sort_order',v_next+v_n));
    v_n:=v_n+1;
    v_changed:=v_changed||jsonb_build_array(jsonb_build_object('op','add','description',btrim(v_x->>'description'),'after',(v_x->>'amount')::numeric));
  END LOOP;
  IF COALESCE((v_ops->>'discountAdd')::numeric,0)>0 THEN
    v_add:=(v_ops->>'discountAdd')::numeric;
    v_changed:=v_changed||jsonb_build_array(jsonb_build_object('op','discount','before',inv.discount,'after',inv.discount+v_add));
  END IF;

  RETURN jsonb_build_object('invoiceId',inv.id,'organizationId',inv.organization_id,'buildingId',inv.building_id,'roomId',inv.room_id,
    'contractId',inv.contract_id,'invoiceNumber',inv.invoice_number,'kind',inv.kind,'status',inv.status,'billingMonth',inv.billing_month,
    'reviewStatus',inv.adjustment_review_status,
    'expected',jsonb_build_object('revision',inv.adjustment_revision,'paid',inv.paid,'updatedAt',inv.updated_at),
    'before',jsonb_build_object('items',v_items,'lines',v_lines,'subtotal',inv.subtotal,'discount',inv.discount,'discountNotes',inv.discount_notes,
      'notes',inv.notes,'previousDebt',inv.previous_debt,'sourcedDebt',v_sourced,'total',inv.total),
    'after',jsonb_build_object('items',v_after,'discount',inv.discount+v_add,
      'subtotal',(SELECT COALESCE(sum(round((e->>'unit_price')::numeric*(e->>'quantity')::numeric*(e->>'coefficient')::numeric,2)),0)
        FROM jsonb_array_elements(v_after) e)),
    'changed',v_changed,'blockers',v_blockers);
END $fn$;

ALTER FUNCTION public.invoice_adjustment_build_v1(uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.invoice_adjustment_build_v1(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.invoice_adjustment_build_v1(uuid,jsonb) TO authenticated;

DO $check$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.invoice_adjustment_build_v1(uuid,jsonb)'::regprocedure AND NOT prosecdef AND provolatile='s'
      AND replace(COALESCE(array_to_string(proconfig,','),''),'"','')='search_path=')
    OR has_function_privilege('anon','public.invoice_adjustment_build_v1(uuid,jsonb)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.invoice_adjustment_build_v1(uuid,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'invoice_adjustment_build_catalog_invalid'; END IF;
END $check$;
COMMIT;
