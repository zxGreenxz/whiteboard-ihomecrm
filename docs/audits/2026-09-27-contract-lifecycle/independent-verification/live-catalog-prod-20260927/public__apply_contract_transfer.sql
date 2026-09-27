-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.apply_contract_transfer() md5(prosrc)=433a0b413cc4505e47a1dbd82f797600
CREATE OR REPLACE FUNCTION public.apply_contract_transfer()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_bld uuid;
  v_new_bld uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' THEN

    IF NEW.transfer_type IN ('TENANT_CHANGE', 'BOTH_CHANGE') THEN
      RAISE EXCEPTION 'Nhượng hợp đồng phải đi qua RPC transfer_contract(); không duyệt tay contract_transfers (cột new_tenant_id nay là customers.id, không phải tenants.id)'
        USING ERRCODE = '55000';
    END IF;

    -- ══ FAIL-CLOSED: audit phải ĐỦ trước khi cho áp dụng ═══════════════
    -- Đường A luôn ghi đủ old_room_id/move_out_date/move_in_date. Đường B trước
    -- đây nhận bất cứ gì người duyệt để lại, nên có thể sinh ra dòng transfer
    -- thiếu mốc ⇒ projection segments không dựng được đoạn và phải báo
    -- SEGMENT_HISTORY_INCOMPLETE. Chặn tại gốc thì read model không bao giờ phải
    -- đoán. (Hôm nay 0 dòng đi đường này — đây là forward-guard.)
    IF NEW.transfer_type = 'ROOM_CHANGE' THEN
      IF NEW.new_room_id IS NULL THEN
        RAISE EXCEPTION 'Thiếu phòng mới (new_room_id) — không duyệt được phiếu chuyển phòng'
          USING ERRCODE = '22023';
      END IF;
      IF NEW.old_room_id IS NULL THEN
        RAISE EXCEPTION 'Thiếu phòng cũ (old_room_id) — audit chuyển phòng phải đủ hai đầu, nếu không thì không truy được khách ở phòng nào từ ngày nào'
          USING ERRCODE = '22023';
      END IF;
      IF COALESCE(NEW.move_out_date, NEW.transfer_date) IS NULL
         OR COALESCE(NEW.move_in_date, NEW.transfer_date) IS NULL THEN
        RAISE EXCEPTION 'Thiếu mốc ngày chuyển phòng (move_out_date/move_in_date hoặc transfer_date)'
          USING ERRCODE = '22023';
      END IF;

      -- Cùng toà — cùng mệnh đề như đường A, để hai đường không lệch luật.
      SELECT building_id INTO v_old_bld FROM public.rooms WHERE id = NEW.old_room_id;
      SELECT building_id INTO v_new_bld FROM public.rooms WHERE id = NEW.new_room_id;
      IF v_old_bld IS DISTINCT FROM v_new_bld THEN
        RAISE EXCEPTION 'Phòng mới thuộc toà khác — chuyển phòng chỉ trong cùng một toà'
          USING ERRCODE = '42501';
      END IF;

      -- Điền mốc còn trống bằng transfer_date để audit luôn đủ cột.
      NEW.move_out_date := COALESCE(NEW.move_out_date, NEW.transfer_date);
      NEW.move_in_date  := COALESCE(NEW.move_in_date,  NEW.transfer_date);
    END IF;

    -- ══ KHÔNG đụng kỳ hạn, KHÔNG đổi status hợp đồng ═══════════════════
    -- Trước đây khối này ghi đè start_date/end_date và đặt status='TRANSFERRED'
    -- + parent_contract_id=id cho CẢ ROOM_CHANGE. Đổi phòng KHÔNG phải nhượng
    -- hợp đồng: kỳ hạn không đổi, và hợp đồng vẫn CÒN HIỆU LỰC — đặt TRANSFERRED
    -- là làm nó biến mất khỏi mọi danh sách ACTIVE. Đường A (transfer_room) luôn
    -- giữ ACTIVE/EXTENDED; nay đường B giống hệt.
    UPDATE contracts
    SET
      room_id       = COALESCE(NEW.new_room_id, room_id),
      rent_price    = COALESCE(NEW.new_rent_price, rent_price),
      total_deposit = COALESCE(NEW.new_deposit, total_deposit),
      updated_at    = NOW()
    WHERE id = NEW.contract_id;

    IF NEW.old_room_id IS NOT NULL THEN
      UPDATE rooms
      SET status = 'AVAILABLE', updated_at = NOW()
      WHERE id = NEW.old_room_id
        AND NOT EXISTS (
          SELECT 1 FROM contracts
          WHERE room_id = NEW.old_room_id
            AND id != NEW.contract_id
            AND status IN ('ACTIVE','EXTENDED')
            AND deleted_at IS NULL
        );
    END IF;

    IF NEW.new_room_id IS NOT NULL THEN
      UPDATE rooms
      SET status = 'OCCUPIED', updated_at = NOW()
      WHERE id = NEW.new_room_id;
    END IF;

    IF NEW.new_services IS NOT NULL AND jsonb_array_length(NEW.new_services) > 0 THEN
      DELETE FROM contract_services WHERE contract_id = NEW.contract_id;

      INSERT INTO contract_services (contract_id, service_id, unit_price)
      SELECT
        NEW.contract_id,
        (service->>'service_id')::UUID,
        (service->>'unit_price')::DECIMAL(15,2)
      FROM jsonb_array_elements(NEW.new_services) AS service;
    END IF;

    NEW.approved_by := auth.uid();
    NEW.approved_at := NOW();
  END IF;

  RETURN NEW;
END;
$function$

