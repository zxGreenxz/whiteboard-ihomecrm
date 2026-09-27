-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public._termination_apply_extra_charges(p_invoice_id uuid, p_extra_charges jsonb, p_date date, p_user_id uuid, p_contract_id uuid) md5(prosrc)=e2c1de5beb5d55377346412618cf654c
CREATE OR REPLACE FUNCTION public._termination_apply_extra_charges(p_invoice_id uuid, p_extra_charges jsonb, p_date date, p_user_id uuid, p_contract_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  rec      RECORD;
  v_total  numeric(15,2) := 0;
  v_sort   integer;
  v_kind   text;
  v_desc   text;
  v_amount numeric(15,2);
  v_prev   numeric(10,2);
  v_curr   numeric(10,2);
  v_unit   numeric(15,2);
  v_meter  uuid;
  v_type   invoice_item_type;
BEGIN
  IF p_invoice_id IS NULL
     OR p_extra_charges IS NULL
     OR jsonb_typeof(p_extra_charges) <> 'array' THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(MAX(sort_order), 0) + 1 INTO v_sort
    FROM invoice_items WHERE invoice_id = p_invoice_id;

  FOR rec IN SELECT j FROM jsonb_array_elements(p_extra_charges) AS t(j) LOOP
    v_amount := NULLIF(rec.j->>'amount', '')::numeric;
    IF v_amount IS NULL OR v_amount <= 0 THEN CONTINUE; END IF;

    v_kind := COALESCE(rec.j->>'kind', 'CUSTOM');
    v_desc := COALESCE(NULLIF(btrim(rec.j->>'description'), ''), 'Khoản thu thêm');
    v_unit := NULLIF(rec.j->>'unit_price', '')::numeric;
    v_prev := NULLIF(rec.j->>'previous_reading', '')::numeric;
    v_curr := NULLIF(rec.j->>'current_reading', '')::numeric;
    v_type := CASE v_kind
                WHEN 'PRORATED' THEN 'RENT'
                WHEN 'ELECTRIC' THEN 'SERVICE'
                ELSE 'OTHER' END::invoice_item_type;

    INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, previous_reading, current_reading, sort_order)
    VALUES (p_invoice_id, v_type, v_desc, COALESCE(v_unit, v_amount), 1, 1, v_amount, v_prev, v_curr, v_sort);
    v_sort  := v_sort + 1;
    v_total := v_total + v_amount;

    -- Chốt số điện → ghi 1 bản ghi meter_readings đã duyệt. Không chặn thanh lý
    -- nếu chèn lỗi (vd trùng chỉ số tháng) — bọc trong sub-block.
    IF v_kind = 'ELECTRIC' AND v_curr IS NOT NULL THEN
      v_meter := NULLIF(rec.j->>'meter_id', '')::uuid;
      IF v_meter IS NOT NULL THEN
        BEGIN
          -- reading_code unique TOÀN CỤC nhưng generator mặc định đánh số theo
          -- user → đụng mã giữa các user. Cấp mã riêng (prefix TLY = thanh lý)
          -- để bỏ qua trigger auto_generate_reading_code và không đụng độ.
          INSERT INTO meter_readings (user_id, contract_id, meter_id, reading_code, reading_date, previous_reading, current_reading, status, approved_by, approved_at)
          VALUES (p_user_id, p_contract_id, v_meter,
                  'TLY' || to_char(p_date,'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)),
                  p_date, COALESCE(v_prev, 0), v_curr, 'APPROVED', auth.uid(), NOW());
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      END IF;
    END IF;
  END LOOP;

  IF v_total > 0 THEN
    UPDATE invoices
       SET subtotal     = COALESCE(subtotal, 0) + v_total,
           total_amount = COALESCE(total_amount, 0) + v_total,
           updated_at   = NOW()
     WHERE id = p_invoice_id;
  END IF;

  RETURN v_total;
END $function$

