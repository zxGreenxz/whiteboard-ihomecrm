-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.update_room_status_on_contract_change() md5(prosrc)=e8a1164f00e0838c201aeb58916ccdce
CREATE OR REPLACE FUNCTION public.update_room_status_on_contract_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_con_hd_khac boolean;
BEGIN
  -- INSERT: HĐ mới đang hiệu lực → phòng OCCUPIED
  IF TG_OP = 'INSERT' AND NEW.status IN ('ACTIVE','EXTENDED') THEN
    IF NEW.room_id IS NOT NULL THEN
      UPDATE rooms SET status = 'OCCUPIED', updated_at = NOW() WHERE id = NEW.room_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'update_room_status_on_contract_change: khong cap nhat duoc phong % (INSERT hop dong %)',
          NEW.room_id, NEW.id;
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    -- Rời active-set → phòng AVAILABLE nếu không còn HĐ đang hiệu lực khác
    IF OLD.status IN ('ACTIVE','EXTENDED') AND NEW.status NOT IN ('ACTIVE','EXTENDED') THEN
      IF NEW.room_id IS NOT NULL THEN
        -- Tách phép kiểm ra khỏi câu UPDATE: còn HĐ hiệu lực khác là lý do CHÍNH
        -- ĐÁNG để không đổi gì, và nó phải phân biệt được với "không ghi nổi".
        SELECT EXISTS (
          SELECT 1 FROM contracts
           WHERE room_id = NEW.room_id
             AND deleted_at IS NULL
             AND status IN ('ACTIVE','EXTENDED')
             AND id <> NEW.id
        ) INTO v_con_hd_khac;

        IF NOT v_con_hd_khac THEN
          UPDATE rooms SET status = 'AVAILABLE', updated_at = NOW() WHERE id = NEW.room_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'update_room_status_on_contract_change: khong tra duoc phong % ve AVAILABLE (hop dong %)',
              NEW.room_id, NEW.id;
          END IF;
        END IF;
      END IF;
    END IF;

    -- Vào active-set → phòng OCCUPIED
    IF OLD.status NOT IN ('ACTIVE','EXTENDED') AND NEW.status IN ('ACTIVE','EXTENDED') THEN
      IF NEW.room_id IS NOT NULL THEN
        UPDATE rooms SET status = 'OCCUPIED', updated_at = NOW() WHERE id = NEW.room_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'update_room_status_on_contract_change: khong cap nhat duoc phong % (hop dong % vao active-set)',
            NEW.room_id, NEW.id;
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$

