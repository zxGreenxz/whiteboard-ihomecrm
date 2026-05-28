-- =============================================
-- Fix các trigger function còn ref NEW.bed_id / OLD.bed_id sau khi drop beds
-- =============================================
-- Lỗi: "record 'new' has no field 'bed_id'" khi tạo contract.
-- Nguyên nhân: 3 trigger function còn reference NEW.bed_id sau khi cột đã drop.
-- =============================================

-- 1. auto_calculate_deposit_paid — bỏ logic check bed_id
CREATE OR REPLACE FUNCTION public.auto_calculate_deposit_paid()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_total_deposits DECIMAL(15,2);
  v_target_room_id UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_target_room_id := NEW.room_id;

    SELECT COALESCE(SUM(amount), 0)
    INTO v_total_deposits
    FROM deposits
    WHERE tenant_id = NEW.tenant_id
      AND status IN ('CONFIRMED', 'CONVERTED')
      AND v_target_room_id IS NOT NULL
      AND room_id = v_target_room_id
      AND (deleted_at IS NULL);

    IF NEW.deposit_paid IS NULL OR NEW.deposit_paid = 0 THEN
      NEW.deposit_paid := v_total_deposits;
    END IF;

    UPDATE deposits
    SET
      status = 'CONVERTED',
      contract_id = NEW.id,
      updated_at = NOW()
    WHERE tenant_id = NEW.tenant_id
      AND status = 'CONFIRMED'
      AND v_target_room_id IS NOT NULL
      AND room_id = v_target_room_id
      AND (deleted_at IS NULL);
  END IF;

  RETURN NEW;
END;
$function$;

-- 2. update_asset_status_on_contract_change — bỏ block bed_id
CREATE OR REPLACE FUNCTION public.update_asset_status_on_contract_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Khi contract ACTIVE: assets thuộc room chuyển sang IN_USE
  IF (TG_OP = 'INSERT' AND NEW.status = 'ACTIVE')
     OR (TG_OP = 'UPDATE' AND OLD.status <> 'ACTIVE' AND NEW.status = 'ACTIVE') THEN
    IF NEW.room_id IS NOT NULL THEN
      UPDATE assets
      SET condition = 'IN_USE', updated_at = NOW()
      WHERE room_id = NEW.room_id
        AND condition = 'AVAILABLE';
    END IF;
  END IF;

  -- Khi contract bị thanh lý/hết hạn: assets về AVAILABLE
  IF TG_OP = 'UPDATE' AND OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE' THEN
    IF NEW.room_id IS NOT NULL THEN
      UPDATE assets
      SET condition = 'AVAILABLE', updated_at = NOW()
      WHERE room_id = NEW.room_id
        AND condition = 'IN_USE';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- 3. update_room_bed_status_on_contract_change — bỏ block bed_id, đổi tên ngữ nghĩa
CREATE OR REPLACE FUNCTION public.update_room_bed_status_on_contract_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- INSERT: contract mới ACTIVE → room chuyển OCCUPIED
  IF TG_OP = 'INSERT' AND NEW.status = 'ACTIVE' THEN
    IF NEW.room_id IS NOT NULL THEN
      UPDATE rooms
      SET status = 'OCCUPIED', updated_at = NOW()
      WHERE id = NEW.room_id;
    END IF;
  END IF;

  -- UPDATE status: ACTIVE → khác hoặc khác → ACTIVE
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    -- Đổi sang trạng thái không-ACTIVE (TERMINATED, EXPIRED, ...): room AVAILABLE
    IF OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE' THEN
      IF NEW.room_id IS NOT NULL THEN
        UPDATE rooms
        SET status = 'AVAILABLE', updated_at = NOW()
        WHERE id = NEW.room_id
          AND NOT EXISTS (
            SELECT 1 FROM contracts
            WHERE room_id = NEW.room_id
              AND status = 'ACTIVE'
              AND id <> NEW.id
          );
      END IF;
    END IF;

    -- Đổi sang ACTIVE: room OCCUPIED
    IF OLD.status <> 'ACTIVE' AND NEW.status = 'ACTIVE' THEN
      IF NEW.room_id IS NOT NULL THEN
        UPDATE rooms
        SET status = 'OCCUPIED', updated_at = NOW()
        WHERE id = NEW.room_id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
