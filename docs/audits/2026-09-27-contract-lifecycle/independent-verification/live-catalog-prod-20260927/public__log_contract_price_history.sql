-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.log_contract_price_history() md5(prosrc)=546631467d463af818e1a6dfb294a7b4
CREATE OR REPLACE FUNCTION public.log_contract_price_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_building_id     uuid;
  v_room_rent       numeric;
  v_source          text;
  v_rent_before     numeric;
  v_deposit_before  numeric;
  v_rent_changed    boolean;
  v_deposit_changed boolean;
BEGIN
  -- HĐ theo giường (bed_id) không gắn giá phòng → bỏ qua.
  IF NEW.room_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT r.building_id, r.rent_price
    INTO v_building_id, v_room_rent
  FROM public.rooms r
  WHERE r.id = NEW.room_id;

  IF v_building_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_source         := 'CONTRACT_CREATE';
    v_rent_before    := v_room_rent;       -- giá niêm yết của phòng
    v_deposit_before := NEW.rent_price;    -- cọc mặc định = tiền thuê HĐ
  ELSE
    v_source         := 'CONTRACT_EDIT';
    v_rent_before    := OLD.rent_price;
    v_deposit_before := OLD.total_deposit;
  END IF;

  v_rent_changed :=
    COALESCE(NEW.rent_price, 0) IS DISTINCT FROM COALESCE(v_rent_before, 0);
  v_deposit_changed :=
    COALESCE(NEW.total_deposit, 0) IS DISTINCT FROM COALESCE(v_deposit_before, 0);

  IF NOT v_rent_changed AND NOT v_deposit_changed THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.room_price_history (
    room_id, building_id, source, contract_id,
    rent_price_before, rent_price_after,
    deposit_before, deposit_after,
    note, changed_by
  ) VALUES (
    NEW.room_id, v_building_id, v_source, NEW.id,
    v_rent_before, NEW.rent_price,
    v_deposit_before, NEW.total_deposit,
    CASE
      WHEN v_source = 'CONTRACT_CREATE' AND v_rent_changed AND v_deposit_changed
        THEN 'Ký HĐ — giá thuê khác giá phòng & điều chỉnh cọc'
      WHEN v_source = 'CONTRACT_CREATE' AND v_rent_changed
        THEN 'Ký HĐ — giá thuê khác giá mặc định của phòng'
      WHEN v_source = 'CONTRACT_CREATE'
        THEN 'Ký HĐ — điều chỉnh tiền cọc so với tiền thuê'
      WHEN v_rent_changed AND v_deposit_changed
        THEN 'Sửa HĐ — đổi giá thuê & tiền cọc'
      WHEN v_rent_changed
        THEN 'Sửa HĐ — đổi giá thuê'
      ELSE 'Sửa HĐ — đổi tiền cọc'
    END,
    auth.uid()
  );

  RETURN NEW;
END;
$function$

