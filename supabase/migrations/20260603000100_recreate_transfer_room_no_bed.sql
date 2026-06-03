-- =============================================================================
-- Tái tạo RPC transfer_room (chuyển phòng) — KHÔNG còn tham số bed.
--
-- BỐI CẢNH: 20260528000005_drop_beds.sql đã DROP transfer_room(uuid,uuid,uuid,
-- numeric,date,text) với ghi chú "sẽ recreate KHÔNG có bed param" nhưng KHÔNG có
-- migration nào tạo lại. Trong khi đó frontend (src/hooks/useContractOperations.ts
-- → useTransferRoom) vẫn gọi rpc('transfer_room', { p_contract_id, p_new_room_id,
-- p_new_rent_price, p_transfer_date, p_notes }) → nút "Chuyển phòng" báo lỗi
-- "function ... does not exist".
--
-- Migration này tạo lại transfer_room với ĐÚNG chữ ký 5 tham số mà FE dùng, bỏ
-- toàn bộ logic giường (beds đã bị drop), và thêm lớp kiểm quyền đồng bộ với các
-- RPC vòng đời khác (20260601000100): caller phải đăng nhập + is_super_admin()
-- HOẶC can_do_on_building('contracts','edit', building_id).
--
-- LƯU Ý: chuyển phòng GIỮ NGUYÊN status hợp đồng (ACTIVE/EXTENDED). Audit ghi vào
-- contract_transfers bằng INSERT status='COMPLETED' nên KHÔNG kích trigger
-- apply_contract_transfer() (trigger chỉ chạy khi UPDATE DRAFT→APPROVED), do đó
-- KHÔNG vô tình set status='TRANSFERRED'.
--
-- An toàn chạy lại (CREATE OR REPLACE + REVOKE/GRANT idempotent).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.transfer_room(
  p_contract_id    uuid,
  p_new_room_id    uuid,
  p_new_rent_price numeric DEFAULT NULL,
  p_transfer_date  date    DEFAULT CURRENT_DATE,
  p_notes          text    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_contract RECORD;
  v_old_room uuid;
BEGIN
  -- 1) Kiểm quyền (đồng bộ policy contracts_update_rbac) ---------------------
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_contract
    FROM public.contracts
   WHERE id = p_contract_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;

  IF NOT (
    public.is_super_admin()
    OR (v_contract.room_id IS NOT NULL AND public.can_do_on_building(
          'contracts', 'edit',
          (SELECT building_id FROM public.rooms WHERE id = v_contract.room_id)))
  ) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên hợp đồng này' USING ERRCODE = '42501';
  END IF;

  -- 2) Tiền điều kiện --------------------------------------------------------
  IF v_contract.status NOT IN ('ACTIVE', 'EXTENDED') THEN
    RAISE EXCEPTION 'Chỉ chuyển phòng được khi hợp đồng đang hiệu lực';
  END IF;

  IF p_new_room_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu phòng mới';
  END IF;

  IF p_new_room_id = v_contract.room_id THEN
    RAISE EXCEPTION 'Phòng mới trùng phòng hiện tại';
  END IF;

  -- Phòng đích không được có hợp đồng khác đang hiệu lực.
  IF EXISTS (
    SELECT 1 FROM public.contracts
     WHERE room_id = p_new_room_id
       AND id <> p_contract_id
       AND status IN ('ACTIVE','EXTENDED')
       AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Phòng mới đã có hợp đồng đang hiệu lực';
  END IF;

  v_old_room := v_contract.room_id;

  -- 3) Chuyển phòng (GIỮ status ACTIVE/EXTENDED) -----------------------------
  UPDATE public.contracts
     SET room_id    = p_new_room_id,
         rent_price = COALESCE(p_new_rent_price, rent_price),
         notes      = CASE
                        WHEN p_notes IS NULL OR length(btrim(p_notes)) = 0 THEN notes
                        WHEN notes  IS NULL OR length(btrim(notes))  = 0 THEN p_notes
                        ELSE notes || E'\n[Chuyển phòng ' || to_char(p_transfer_date,'DD/MM/YYYY') || '] ' || p_notes
                      END,
         updated_at = NOW()
   WHERE id = p_contract_id;

  -- 4) Đồng bộ trạng thái phòng (trigger chỉ fire khi đổi status HĐ, nên đổi tay)
  IF v_old_room IS NOT NULL AND v_old_room <> p_new_room_id THEN
    UPDATE public.rooms SET status = 'AVAILABLE', updated_at = NOW()
     WHERE id = v_old_room
       AND NOT EXISTS (
         SELECT 1 FROM public.contracts
          WHERE room_id = v_old_room
            AND id <> p_contract_id
            AND status IN ('ACTIVE','EXTENDED')
            AND deleted_at IS NULL
       );
  END IF;

  UPDATE public.rooms SET status = 'OCCUPIED', updated_at = NOW() WHERE id = p_new_room_id;

  -- 5) Audit (status='COMPLETED' → KHÔNG kích apply_contract_transfer) --------
  BEGIN
    INSERT INTO public.contract_transfers (
      user_id, contract_id, transfer_type, transfer_date,
      old_room_id, new_room_id, new_rent_price,
      move_out_date, move_in_date, reason, notes, status, approved_at
    ) VALUES (
      v_contract.user_id, p_contract_id, 'ROOM_CHANGE', p_transfer_date,
      v_old_room, p_new_room_id, p_new_rent_price,
      p_transfer_date, p_transfer_date, p_notes, p_notes, 'COMPLETED', NOW()
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- audit best-effort, không chặn nghiệp vụ
  END;

  RETURN p_contract_id;
END;
$$;

-- Quyền: chỉ user đã đăng nhập gọi được (RPC tự kiểm quyền chi tiết bên trong).
REVOKE ALL     ON FUNCTION public.transfer_room(uuid, uuid, numeric, date, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.transfer_room(uuid, uuid, numeric, date, text) TO authenticated;

COMMENT ON FUNCTION public.transfer_room(uuid, uuid, numeric, date, text) IS
  'Chuyển hợp đồng đang hiệu lực sang phòng khác (không bed). Giữ status ACTIVE/EXTENDED; '
  'kiểm quyền can_do_on_building(contracts,edit); audit vào contract_transfers (ROOM_CHANGE, COMPLETED).';
