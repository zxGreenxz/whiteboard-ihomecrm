-- =====================================================================
-- Dọn nốt tàn dư "bed/giường" ở tầng DB sau khi đã DROP bảng beds + cột bed_id.
--
-- 1) Hàm legacy get_invoice_statistics (v1) — còn param p_bed_id (chết, body
--    không dùng). Frontend đã chuyển hẳn sang get_invoice_statistics_v2; không
--    có caller nào trong DB (đã kiểm chứng 0 callers). → DROP hẳn v1.
-- 2) Trigger + hàm update_room_bed_status_on_contract_change: thân hàm đã thuần
--    logic room (không còn bed), chỉ còn chữ "bed" trong TÊN. → đổi tên sạch:
--      hàm   update_room_bed_status_on_contract_change → update_room_status_on_contract_change
--      trigger trigger_update_room_bed_status          → trigger_update_room_status
--    Giữ NGUYÊN hành vi: HĐ ACTIVE → phòng OCCUPIED; rời ACTIVE → phòng AVAILABLE
--    (nếu không còn HĐ ACTIVE nào khác trong phòng).
-- 3) Enum bed_status: mồ côi (0 cột dùng, 0 phụ thuộc). → DROP TYPE.
-- =====================================================================

-- ── 1. Bỏ hàm thống kê hoá đơn v1 (kèm param p_bed_id chết) ──────────────
DROP FUNCTION IF EXISTS public.get_invoice_statistics(
  uuid, uuid, uuid, invoice_status, date, date, text, text, uuid, uuid
);

-- ── 2. Đổi tên hàm + trigger vòng đời phòng, gỡ "bed" khỏi tên ───────────
CREATE OR REPLACE FUNCTION public.update_room_status_on_contract_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- INSERT: hợp đồng mới ACTIVE → phòng chuyển OCCUPIED
  IF TG_OP = 'INSERT' AND NEW.status = 'ACTIVE' THEN
    IF NEW.room_id IS NOT NULL THEN
      UPDATE rooms SET status = 'OCCUPIED', updated_at = NOW()
      WHERE id = NEW.room_id;
    END IF;
  END IF;

  -- UPDATE status: ACTIVE ↔ khác
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    -- Rời ACTIVE (TERMINATED/EXPIRED/...): phòng AVAILABLE nếu không còn HĐ ACTIVE khác
    IF OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE' THEN
      IF NEW.room_id IS NOT NULL THEN
        UPDATE rooms SET status = 'AVAILABLE', updated_at = NOW()
        WHERE id = NEW.room_id
          AND NOT EXISTS (
            SELECT 1 FROM contracts
            WHERE room_id = NEW.room_id
              AND status = 'ACTIVE'
              AND id <> NEW.id
          );
      END IF;
    END IF;

    -- Vào ACTIVE: phòng OCCUPIED
    IF OLD.status <> 'ACTIVE' AND NEW.status = 'ACTIVE' THEN
      IF NEW.room_id IS NOT NULL THEN
        UPDATE rooms SET status = 'OCCUPIED', updated_at = NOW()
        WHERE id = NEW.room_id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- Chuyển trigger sang hàm tên mới, rồi bỏ hàm tên cũ.
DROP TRIGGER IF EXISTS trigger_update_room_bed_status ON public.contracts;
DROP TRIGGER IF EXISTS trigger_update_room_status     ON public.contracts;
CREATE TRIGGER trigger_update_room_status
  AFTER INSERT OR UPDATE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.update_room_status_on_contract_change();

DROP FUNCTION IF EXISTS public.update_room_bed_status_on_contract_change();

-- ── 3. Bỏ enum mồ côi bed_status ────────────────────────────────────────
DROP TYPE IF EXISTS public.bed_status;

NOTIFY pgrst, 'reload schema';
