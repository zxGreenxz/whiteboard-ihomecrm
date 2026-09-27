-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.renew_contract_impl(p_contract_id uuid, p_new_end_date date, p_new_rent_price numeric, p_new_deposit numeric, p_notes text) md5(prosrc)=2bd721b3a379bc66900405e964ced096
CREATE OR REPLACE FUNCTION public.renew_contract_impl(p_contract_id uuid, p_new_end_date date, p_new_rent_price numeric DEFAULT NULL::numeric, p_new_deposit numeric DEFAULT NULL::numeric, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract RECORD;
  v_months   int;
BEGIN
  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;

  IF v_contract.status NOT IN ('ACTIVE', 'EXTENDED') THEN
    RAISE EXCEPTION 'Chỉ gia hạn được hợp đồng đang hiệu lực (status hiện tại: %)', v_contract.status;
  END IF;

  IF p_new_end_date IS NULL OR p_new_end_date <= v_contract.end_date THEN
    RAISE EXCEPTION 'Ngày kết thúc mới phải sau ngày kết thúc hiện tại (%)', v_contract.end_date;
  END IF;

  -- Gia hạn = CẬP NHẬT tại chỗ; GIỮ status='ACTIVE' (không đổi EXTENDED).
  UPDATE contracts
     SET end_date     = p_new_end_date,
         rent_price   = COALESCE(p_new_rent_price, rent_price),
         total_deposit= COALESCE(p_new_deposit,    total_deposit),
         notes        = CASE
                          WHEN p_notes IS NULL OR length(btrim(p_notes)) = 0 THEN notes
                          WHEN notes  IS NULL OR length(btrim(notes))  = 0 THEN p_notes
                          ELSE notes || E'\n[Gia hạn] ' || p_notes
                        END,
         updated_at   = NOW()
   WHERE id = p_contract_id;

  -- Số tháng gia hạn (cột extension_months NOT NULL), tối thiểu 1.
  v_months := GREATEST(1, (EXTRACT(YEAR  FROM age(p_new_end_date, v_contract.end_date)) * 12
                         + EXTRACT(MONTH FROM age(p_new_end_date, v_contract.end_date)))::int);

  -- Bản ghi gia hạn = NGUỒN SỰ THẬT của "đã gia hạn" (KHÔNG nuốt lỗi).
  INSERT INTO contract_extensions (
    user_id, contract_id, extension_type, extension_date,
    old_end_date, new_end_date, extension_months,
    new_rent_price, rent_price_changed,
    new_deposit,    deposit_changed,
    notes, status
  ) VALUES (
    v_contract.user_id, p_contract_id, 'UPDATE_EXISTING', public.org_today_v1(NULL),
    v_contract.end_date, p_new_end_date, v_months,
    p_new_rent_price, (p_new_rent_price IS NOT NULL AND p_new_rent_price <> v_contract.rent_price),
    p_new_deposit,    (p_new_deposit    IS NOT NULL AND p_new_deposit    <> v_contract.total_deposit),
    p_notes, 'COMPLETED'
  );

  RETURN p_contract_id;
END;
$function$

