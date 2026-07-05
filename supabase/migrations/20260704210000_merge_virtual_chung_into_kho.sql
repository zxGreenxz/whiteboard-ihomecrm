-- Gộp toà ảo "Chung" về 1 toà chung duy nhất = "Kho Văn Phòng Chung"
--
-- Trước: _chung_building(p_user_id) tạo 1 toà ảo "Chung" RIÊNG cho mỗi user
-- (NG TÂM, JOEY, NATHAN, B.Huy) → dropdown toà nhà hiện 4 mục "Chung" giống hệt
-- nhau, song song với toà thật "Kho Văn Phòng Chung" (0 phòng, 0 HĐ) mà anh em
-- vẫn đang dùng tay để ghi chi phí chung → split-brain 2 nơi hạch toán.
--
-- Sau:
--   1. "Kho Văn Phòng Chung" gắn is_virtual=true → mọi báo cáo LN từng toà
--      (useShareholderProfit, fa_*, rule "toà lỗ") TỰ loại nó như toà ảo cũ;
--      form thu chi (ie_form_buildings) vẫn chọn được vì RPC không lọc is_virtual.
--   2. 41 phiếu trên 4 toà ảo "Chung" dồn về Kho (building_id không ảnh hưởng
--      số dư/hoá đơn/cọc → tắt trigger user tạm thời trong transaction, vì
--      income_expenses_check_lock sẽ chặn phiếu trước ngày khoá sổ).
--   3. Xoá mềm 4 toà ảo "Chung" + dọn building_coverage của chúng.
--   4. _chung_building: tenant thật trả về toà chung hệ thống (Kho) — KHÔNG
--      per-user nữa; demo giữ nguyên hành vi cũ (tự tạo 'Chung' riêng).

DO $$
DECLARE
  v_kho uuid;
  v_expected int;
  v_moved int;
  v_left int;
BEGIN
  SELECT id INTO v_kho FROM buildings
   WHERE name = 'Kho Văn Phòng Chung' AND deleted_at IS NULL
   ORDER BY created_at LIMIT 1;
  IF v_kho IS NULL THEN
    RAISE EXCEPTION 'Khong tim thay toa "Kho Van Phong Chung"';
  END IF;

  -- 1) Kho trở thành toà ảo (toà gom thu chi chung của cả hệ thống)
  UPDATE buildings SET is_virtual = true WHERE id = v_kho AND NOT is_virtual;

  -- 2) Dồn TOÀN BỘ phiếu từ các toà ảo "Chung" về Kho TRƯỚC khi xoá toà.
  --    Assert đủ số phiếu — thiếu 1 phiếu là rollback cả transaction.
  SELECT count(*) INTO v_expected FROM income_expenses
   WHERE building_id IN (
     SELECT id FROM buildings WHERE name = 'Chung' AND is_virtual AND id <> v_kho
   );

  ALTER TABLE income_expenses DISABLE TRIGGER USER;
  UPDATE income_expenses SET building_id = v_kho
   WHERE building_id IN (
     SELECT id FROM buildings WHERE name = 'Chung' AND is_virtual AND id <> v_kho
   );
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  ALTER TABLE income_expenses ENABLE TRIGGER USER;

  SELECT count(*) INTO v_left FROM income_expenses
   WHERE building_id IN (
     SELECT id FROM buildings WHERE name = 'Chung' AND is_virtual AND id <> v_kho
   );
  IF v_moved <> v_expected OR v_left <> 0 THEN
    RAISE EXCEPTION 'Chuyen phieu chua du (expected %, moved %, con lai %) — rollback', v_expected, v_moved, v_left;
  END IF;
  RAISE NOTICE 'Da don % phieu ve Kho Van Phong Chung', v_moved;

  -- 3) Toà ảo đã sạch phiếu → xoá mềm.
  --    (building_coverage là VIEW phái sinh, không có bảng thật để dọn; báo cáo
  --     coverage lọc rooms_total>0 nên toà 0 phòng này vốn đã không hiện.)
  UPDATE buildings SET deleted_at = now()
   WHERE name = 'Chung' AND is_virtual AND id <> v_kho AND deleted_at IS NULL;
END $$;

-- 4) _chung_building: toà chung duy nhất cho tenant thật, demo giữ hành vi cũ
CREATE OR REPLACE FUNCTION public._chung_building(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  -- Tenant thật: toà chung hệ thống = toà ảo không thuộc demo (hiện là
  -- "Kho Văn Phòng Chung"). Không per-user nữa — tránh đẻ nhiều toà "Chung".
  IF NOT (p_user_id = ANY (public.demo_user_ids())) THEN
    SELECT id INTO v_id FROM buildings
     WHERE is_virtual = true AND deleted_at IS NULL
       AND NOT (user_id = ANY (public.demo_user_ids()))
     ORDER BY created_at LIMIT 1;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;

  -- Fallback (demo, hoặc tenant chưa có toà chung): hành vi cũ
  SELECT id INTO v_id FROM buildings
   WHERE user_id = p_user_id AND is_virtual = true AND name = 'Chung'
     AND deleted_at IS NULL
   ORDER BY created_at LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO buildings (user_id, name, type, status, province, district, ward, is_virtual)
  VALUES (p_user_id, 'Chung', 'APARTMENT'::building_type, 'ACTIVE'::building_status, '—', '—', '—', true)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;
