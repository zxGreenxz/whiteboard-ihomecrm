-- =============================================
-- Migration: Tách EXTENDED khỏi vai trò "status chính".
-- - "Còn hiệu lực" từ nay CHỈ là status='ACTIVE'. HĐ gia hạn GIỮ status='ACTIVE'
--   (không chuyển EXTENDED nữa). "Đã gia hạn" suy từ bảng contract_extensions.
-- - Giữ nguyên giá trị enum 'EXTENDED' (chỉ ngưng ghi) — không tái tạo type.
-- - Ngưng ghi EXTENDED ở 3 hàm: renew_contract_impl, apply_contract_extension_update,
--   create_new_contract_extension. Làm CHẮC dòng audit contract_extensions (nguồn
--   sự thật của "đã gia hạn") — trước đây bị nuốt lỗi do thiếu cột NOT NULL.
-- - Di trú: mọi HĐ EXTENDED -> ACTIVE; đồng bộ lại cờ phòng (OCCUPIED nếu có HĐ
--   đang hiệu lực mà cờ AVAILABLE) — sửa 2 phòng đang lệch (1392QT/L01, 405PVB/103).
-- - Gia cố trigger trạng thái phòng: coi ACTIVE+EXTENDED đều là "đang thuê" (phòng hờ).
-- Reader guards dùng IN('ACTIVE','EXTENDED') ở các RPC khác giữ nguyên (vô hại).
-- =============================================

-- 1) Trigger trạng thái phòng: active-set = {ACTIVE, EXTENDED}.
CREATE OR REPLACE FUNCTION public.update_room_status_on_contract_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- INSERT: HĐ mới đang hiệu lực → phòng OCCUPIED
  IF TG_OP = 'INSERT' AND NEW.status IN ('ACTIVE','EXTENDED') THEN
    IF NEW.room_id IS NOT NULL THEN
      UPDATE rooms SET status = 'OCCUPIED', updated_at = NOW() WHERE id = NEW.room_id;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    -- Rời active-set → phòng AVAILABLE nếu không còn HĐ đang hiệu lực khác
    IF OLD.status IN ('ACTIVE','EXTENDED') AND NEW.status NOT IN ('ACTIVE','EXTENDED') THEN
      IF NEW.room_id IS NOT NULL THEN
        UPDATE rooms SET status = 'AVAILABLE', updated_at = NOW()
        WHERE id = NEW.room_id
          AND NOT EXISTS (
            SELECT 1 FROM contracts
            WHERE room_id = NEW.room_id
              AND deleted_at IS NULL
              AND status IN ('ACTIVE','EXTENDED')
              AND id <> NEW.id
          );
      END IF;
    END IF;

    -- Vào active-set → phòng OCCUPIED
    IF OLD.status NOT IN ('ACTIVE','EXTENDED') AND NEW.status IN ('ACTIVE','EXTENDED') THEN
      IF NEW.room_id IS NOT NULL THEN
        UPDATE rooms SET status = 'OCCUPIED', updated_at = NOW() WHERE id = NEW.room_id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- 2) renew_contract_impl: GIỮ status (ACTIVE); ghi contract_extensions CHẮC CHẮN.
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
    v_contract.user_id, p_contract_id, 'UPDATE_EXISTING', CURRENT_DATE,
    v_contract.end_date, p_new_end_date, v_months,
    p_new_rent_price, (p_new_rent_price IS NOT NULL AND p_new_rent_price <> v_contract.rent_price),
    p_new_deposit,    (p_new_deposit    IS NOT NULL AND p_new_deposit    <> v_contract.total_deposit),
    p_notes, 'COMPLETED'
  );

  RETURN p_contract_id;
END;
$function$;

-- 3) apply_contract_extension_update (trigger duyệt): GIỮ status (bỏ set EXTENDED).
CREATE OR REPLACE FUNCTION public.apply_contract_extension_update()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' THEN
    IF NEW.extension_type = 'UPDATE_EXISTING' THEN
      -- Cập nhật HĐ tại chỗ; KHÔNG đổi status (giữ ACTIVE).
      UPDATE contracts
      SET
        end_date      = NEW.new_end_date,
        rent_price    = COALESCE(NEW.new_rent_price, rent_price),
        total_deposit = COALESCE(NEW.new_deposit, total_deposit),
        updated_at    = NOW()
      WHERE id = NEW.contract_id;

      IF NEW.services_changed AND NEW.new_services IS NOT NULL THEN
        DELETE FROM contract_services WHERE contract_id = NEW.contract_id;
        INSERT INTO contract_services (contract_id, service_id, unit_price)
        SELECT NEW.contract_id, (service->>'service_id')::UUID, (service->>'unit_price')::DECIMAL(15,2)
        FROM jsonb_array_elements(NEW.new_services) AS service;
      END IF;
    END IF;

    NEW.approved_by := auth.uid();
    NEW.approved_at := NOW();
    NEW.status := 'COMPLETED';
  END IF;

  RETURN NEW;
END;
$function$;

-- 4) create_new_contract_extension (CREATE_NEW, không nối UI): HĐ mới ACTIVE; HĐ
--    cũ đặt EXPIRED (bị HĐ mới nối tiếp thay thế) — KHÔNG để EXTENDED.
CREATE OR REPLACE FUNCTION public.create_new_contract_extension(p_contract_id uuid, p_extension_months integer, p_new_rent_price numeric DEFAULT NULL::numeric, p_new_deposit numeric DEFAULT NULL::numeric, p_notes text DEFAULT NULL::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_old_contract RECORD;
  v_new_contract_id UUID;
  v_extension_id UUID;
  v_new_end_date DATE;
  v_new_start_date DATE;
BEGIN
  SELECT * INTO v_old_contract
  FROM contracts
  WHERE id = p_contract_id AND status = 'ACTIVE' AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract not found or not active';
  END IF;

  v_new_start_date := v_old_contract.end_date + INTERVAL '1 day';
  v_new_end_date   := v_new_start_date + (p_extension_months || ' months')::INTERVAL;

  INSERT INTO contracts (
    user_id, tenant_id, room_id, contract_number, status, signed_date, start_date,
    end_date, rent_price, payment_cycle, total_deposit, deposit_paid, parent_contract_id, notes
  ) VALUES (
    v_old_contract.user_id, v_old_contract.tenant_id, v_old_contract.room_id,
    NULL, 'ACTIVE', CURRENT_DATE, v_new_start_date, v_new_end_date,
    COALESCE(p_new_rent_price, v_old_contract.rent_price), v_old_contract.payment_cycle,
    COALESCE(p_new_deposit, v_old_contract.total_deposit),
    COALESCE(p_new_deposit, v_old_contract.total_deposit),
    p_contract_id,
    'Gia hạn từ HĐ: ' || COALESCE(v_old_contract.contract_number, p_contract_id::TEXT)
  )
  RETURNING id INTO v_new_contract_id;

  INSERT INTO contract_services (contract_id, service_id, unit_price)
  SELECT v_new_contract_id, service_id, unit_price
  FROM contract_services WHERE contract_id = p_contract_id;

  -- HĐ cũ bị thay thế bởi HĐ mới → EXPIRED (KHÔNG để EXTENDED).
  UPDATE contracts SET status = 'EXPIRED', updated_at = NOW() WHERE id = p_contract_id;

  INSERT INTO contract_extensions (
    user_id, contract_id, extension_type, old_end_date, extension_months, new_end_date,
    new_rent_price, rent_price_changed, new_deposit, deposit_changed, new_contract_id, notes, status
  ) VALUES (
    auth.uid(), p_contract_id, 'CREATE_NEW', v_old_contract.end_date, p_extension_months, v_new_end_date,
    p_new_rent_price, (p_new_rent_price IS NOT NULL AND p_new_rent_price != v_old_contract.rent_price),
    p_new_deposit, (p_new_deposit IS NOT NULL AND p_new_deposit != v_old_contract.total_deposit),
    v_new_contract_id, p_notes, 'COMPLETED'
  )
  RETURNING id INTO v_extension_id;

  RETURN v_new_contract_id;
END;
$function$;

-- 5) Di trú dữ liệu.
-- 5a. Mọi HĐ EXTENDED -> ACTIVE (không còn dùng EXTENDED làm status chính).
UPDATE public.contracts
   SET status = 'ACTIVE', updated_at = NOW()
 WHERE status = 'EXTENDED' AND deleted_at IS NULL;

-- 5b. Đồng bộ cờ phòng: phòng có HĐ đang hiệu lực mà cờ AVAILABLE -> OCCUPIED.
--     (Xử lý cả phòng bị toggle tay sai như 1392QT/L01.) Không đụng MAINTENANCE/RESERVED/UNAVAILABLE.
UPDATE public.rooms r
   SET status = 'OCCUPIED', updated_at = NOW()
 WHERE r.deleted_at IS NULL
   AND r.status = 'AVAILABLE'
   AND EXISTS (
     SELECT 1 FROM public.contracts c
     WHERE c.room_id = r.id AND c.deleted_at IS NULL AND c.status IN ('ACTIVE','EXTENDED')
   );
