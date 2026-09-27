-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.auto_calculate_termination_financials() md5(prosrc)=2be263528cf7232ae83379fa8b8a4394
CREATE OR REPLACE FUNCTION public.auto_calculate_termination_financials()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_contract RECORD;
  v_days_in_month INTEGER;
  v_daily_rate DECIMAL(15,2);
  v_prorated_days INTEGER;
BEGIN
  SELECT c.start_date, c.end_date, c.rent_price, c.total_deposit
  INTO v_contract
  FROM contracts c
  WHERE c.id = NEW.contract_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract not found: %', NEW.contract_id;
  END IF;

  IF NEW.actual_move_out_date < v_contract.start_date THEN
    RAISE EXCEPTION 'Move-out date (%) cannot be before contract start date (%)',
      NEW.actual_move_out_date, v_contract.start_date;
  END IF;

  -- Các RPC thanh lý cung cấp SẴN số liệu quyết toán thực — trigger chỉ tự tính
  -- khi caller (UI/manual) KHÔNG cung cấp (IS NULL). Trước đây trigger ghi đè
  -- mọi giá trị bằng mô hình prorated cũ → audit sai lệch / vi phạm CHECK.
  IF NEW.outstanding_debt IS NULL THEN
    SELECT COALESCE(SUM(remaining_amount), 0)
    INTO NEW.outstanding_debt
    FROM invoices
    WHERE contract_id = NEW.contract_id
      AND status NOT IN ('PAID', 'CANCELLED');
  END IF;

  v_days_in_month := EXTRACT(DAY FROM (
    DATE_TRUNC('month', NEW.actual_move_out_date) + INTERVAL '1 month - 1 day'
  ));
  v_prorated_days := EXTRACT(DAY FROM NEW.actual_move_out_date);

  IF NEW.prorated_rent IS NULL THEN
    v_daily_rate := v_contract.rent_price / v_days_in_month;
    IF v_prorated_days < v_days_in_month THEN
      NEW.prorated_rent := v_daily_rate * v_prorated_days;
    ELSE
      NEW.prorated_rent := 0;
    END IF;
  END IF;

  IF NEW.prorated_days IS NULL THEN
    IF v_prorated_days < v_days_in_month THEN
      NEW.prorated_days := v_prorated_days;
    ELSE
      NEW.prorated_days := 0;
    END IF;
  END IF;

  IF NEW.total_deposit IS NULL THEN
    NEW.total_deposit := v_contract.total_deposit;
  END IF;

  IF NEW.prorated_services IS NULL THEN
    SELECT COALESCE(SUM(cs.unit_price *
      CASE s.type
        WHEN 'FIXED' THEN (v_prorated_days::DECIMAL / v_days_in_month)
        WHEN 'PER_PERSON' THEN 1
        WHEN 'PER_ROOM' THEN (v_prorated_days::DECIMAL / v_days_in_month)
        ELSE 0
      END
    ), 0)
    INTO NEW.prorated_services
    FROM contract_services cs
    JOIN services s ON s.id = cs.service_id
    WHERE cs.contract_id = NEW.contract_id
      AND s.type != 'METER_READING';
  END IF;

  RETURN NEW;
END;
$function$

