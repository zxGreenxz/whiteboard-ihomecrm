-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.transfer_room(p_contract_id uuid, p_new_room_id uuid, p_new_rent_price numeric, p_transfer_date date, p_notes text) md5(prosrc)=90d6b6cbe3d7525c7e606045d25e93c2
CREATE OR REPLACE FUNCTION public.transfer_room(p_contract_id uuid, p_new_room_id uuid, p_new_rent_price numeric DEFAULT NULL::numeric, p_transfer_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract   RECORD;
  v_old_room   uuid;
  v_old_bld    uuid;
  v_new_bld    uuid;
  v_new_org    uuid;
  v_lock_a     uuid;
  v_lock_b     uuid;
BEGIN
  -- 1) Quyền (giữ đúng như trước) -------------------------------------------
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  IF p_new_room_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu phòng mới';
  END IF;
  IF p_transfer_date IS NULL THEN
    -- Audit phải có mốc ngày, kẻo projection không dựng được đoạn.
    RAISE EXCEPTION 'Thiếu ngày chuyển phòng' USING ERRCODE = '22023';
  END IF;

  -- ══ KHOÁ PHÒNG TRƯỚC KHI ĐỌC ═══════════════════════════════════════
  -- Lỗ 3: kiểm "phòng đích còn trống" là SELECT trần nên hai hợp đồng cùng
  -- chuyển vào một phòng thì cả hai đều lọt. Khoá tư vấn theo TỪNG phòng và lấy
  -- theo THỨ TỰ ID TĂNG DẦN — hai phiên có chung một phòng sẽ xếp hàng, và không
  -- thể chờ chéo nhau (điều kiện đủ để tránh deadlock: mọi phiên khoá cùng thứ tự).
  -- Phải khoá TRƯỚC khi SELECT contract, vì phòng cũ chỉ biết được sau khi đọc
  -- contract ⇒ đọc contract "trần" một lần để lấy phòng cũ, khoá, rồi ĐỌC LẠI
  -- dưới FOR UPDATE và kiểm lại mọi tiền đề trên dữ liệu sau khoá.
  SELECT c.room_id INTO v_old_room
    FROM public.contracts c
   WHERE c.id = p_contract_id AND c.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;

  v_lock_a := LEAST(COALESCE(v_old_room, p_new_room_id), p_new_room_id);
  v_lock_b := GREATEST(COALESCE(v_old_room, p_new_room_id), p_new_room_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended('room:' || v_lock_a::text, 0));
  IF v_lock_b IS DISTINCT FROM v_lock_a THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
              pg_catalog.hashtextextended('room:' || v_lock_b::text, 0));
  END IF;

  -- Lỗ 2: nay khoá dòng hợp đồng. Đọc LẠI sau khoá phòng để thấy trạng thái mới
  -- nhất (phiên trước có thể vừa đổi room_id).
  SELECT * INTO v_contract
    FROM public.contracts
   WHERE id = p_contract_id AND deleted_at IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;
  v_old_room := v_contract.room_id;

  IF NOT (
    public.is_super_admin()
    OR (v_contract.room_id IS NOT NULL AND public.can_do_on_building(
          'contracts', 'edit',
          (SELECT building_id FROM public.rooms WHERE id = v_contract.room_id)))
  ) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên hợp đồng này' USING ERRCODE = '42501';
  END IF;

  -- 2) Tiền điều kiện — kiểm LẠI sau khoá ------------------------------------
  IF v_contract.status NOT IN ('ACTIVE', 'EXTENDED') THEN
    RAISE EXCEPTION 'Chỉ chuyển phòng được khi hợp đồng đang hiệu lực';
  END IF;
  IF p_new_room_id = v_contract.room_id THEN
    RAISE EXCEPTION 'Phòng mới trùng phòng hiện tại';
  END IF;

  -- Lỗ 4: phòng mới phải cùng TOÀ và cùng ORG với phòng hiện tại. Không có mệnh
  -- đề này thì chuyển được hợp đồng sang toà khác — kể cả tổ chức khác.
  SELECT r.building_id, b.organization_id INTO v_new_bld, v_new_org
    FROM public.rooms r
    LEFT JOIN public.buildings b ON b.id = r.building_id
   WHERE r.id = p_new_room_id AND r.deleted_at IS NULL;
  IF v_new_bld IS NULL THEN
    RAISE EXCEPTION 'Phòng mới không tồn tại';
  END IF;

  IF v_old_room IS NOT NULL THEN
    SELECT r.building_id INTO v_old_bld
      FROM public.rooms r WHERE r.id = v_old_room;
    IF v_old_bld IS DISTINCT FROM v_new_bld THEN
      RAISE EXCEPTION
        'Phòng mới thuộc toà khác — chuyển phòng chỉ trong cùng một toà. Muốn đổi toà thì thanh lý hợp đồng rồi tạo hợp đồng mới.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Kiểm phòng đích SAU KHI đã giữ khoá ⇒ kết quả không thể lỗi thời.
  IF EXISTS (
    SELECT 1 FROM public.contracts
     WHERE room_id = p_new_room_id
       AND id <> p_contract_id
       AND status IN ('ACTIVE','EXTENDED')
       AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Phòng mới đã có hợp đồng đang hiệu lực';
  END IF;

  -- 3) AUDIT TRƯỚC, KHÔNG BỌC EXCEPTION -------------------------------------
  -- Lỗ 1: trước đây khối này nằm CUỐI và bọc `EXCEPTION WHEN OTHERS THEN NULL`,
  -- nên chuyển phòng xong mà mất dấu vết là chuyện có thể xảy ra êm ru. Nay ghi
  -- TRƯỚC mọi tác dụng phụ: audit lỗi ⇒ chưa có gì bị đổi, cả transaction rollback.
  -- status='COMPLETED' để KHÔNG kích trigger đường B (giữ đúng ý định cũ).
  INSERT INTO public.contract_transfers (
    user_id, contract_id, transfer_type, transfer_date,
    old_room_id, new_room_id, new_rent_price,
    move_out_date, move_in_date, reason, notes, status, approved_at, approved_by
  ) VALUES (
    v_contract.user_id, p_contract_id, 'ROOM_CHANGE', p_transfer_date,
    v_old_room, p_new_room_id, p_new_rent_price,
    p_transfer_date, p_transfer_date, p_notes, p_notes, 'COMPLETED', NOW(), auth.uid()
  );

  -- 4) Chuyển phòng (GIỮ status ACTIVE/EXTENDED, KHÔNG đụng kỳ hạn) ----------
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

  -- 5) Đồng bộ trạng thái phòng --------------------------------------------
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

  RETURN p_contract_id;
END;
$function$

