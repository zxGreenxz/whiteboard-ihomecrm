-- T5 domain slice #1 — Meter reading canonical writers (SECURITY DEFINER).
-- Thay 5 writer ghi-thẳng-bảng (create/bulkCreate/update/delete/bulkDelete) bằng RPC
-- server-derive + exact permission. GIỮ NGUYÊN hành vi (tạo → APPROVED) — chỉ đóng
-- lỗ hổng: client tự set status/approved_by và bỏ qua kiểm quyền chính xác.
-- Additive: RPC mới, chưa wire frontend ⇒ 0 đổi hành vi cho tới khi frontend gọi.
-- Đường ghi-thẳng-bảng cũ vẫn còn (revoke DML thuộc T6b/T7) → rollback = revert frontend.
-- Org/building/room/settlement_month/recorded_by/previous_reading/reading_code do
-- trigger BEFORE INSERT tự điền; RPC chỉ INSERT cột nghiệp vụ + status/approved_by
-- server-set, và kiểm quyền trên building suy từ meter (KHÔNG tin client).
BEGIN;

-- ===== CREATE =====
CREATE OR REPLACE FUNCTION public.create_meter_reading_v1(
  p_meter_id uuid,
  p_reading_date date,
  p_current_reading numeric,
  p_notes text DEFAULT NULL,
  p_meter_image_url text DEFAULT NULL
) RETURNS public.meter_readings
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_meter RECORD;
  v_row public.meter_readings;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_meter_id IS NULL THEN RAISE EXCEPTION 'Thiếu meter_id'; END IF;
  IF p_reading_date IS NULL THEN RAISE EXCEPTION 'Thiếu ngày ghi'; END IF;
  IF p_current_reading IS NULL OR p_current_reading < 0 THEN RAISE EXCEPTION 'Chỉ số không hợp lệ'; END IF;

  SELECT id, building_id, room_id, organization_id INTO v_meter
  FROM public.meters WHERE id = p_meter_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy đồng hồ' USING ERRCODE='42501'; END IF;
  IF v_meter.building_id IS NULL THEN RAISE EXCEPTION 'Đồng hồ chưa gắn toà nhà'; END IF;

  -- Defense-in-depth org boundary: definer bypass RLS nên phải tự kiểm org membership
  -- (mirror policy meter_readings_org_boundary NULL-tolerant) NGOÀI building-RBAC.
  IF NOT (v_meter.organization_id IS NULL
          OR public.is_super_admin()
          OR v_meter.organization_id = ANY(public.my_org_ids())) THEN
    RAISE EXCEPTION 'Đồng hồ thuộc tổ chức khác' USING ERRCODE='42501';
  END IF;
  IF NOT public.can_do_on_building('meter_readings','create', v_meter.building_id) THEN
    RAISE EXCEPTION 'Không có quyền tạo chỉ số cho toà này' USING ERRCODE='42501';
  END IF;

  BEGIN
    INSERT INTO public.meter_readings
      (meter_id, reading_date, current_reading, notes, meter_image_url, status, approved_by, approved_at)
    VALUES
      (p_meter_id, p_reading_date, p_current_reading, p_notes, p_meter_image_url, 'APPROVED', v_caller, now())
    RETURNING * INTO v_row;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'Chỉ số mới không hợp lệ (phải ≥ chỉ số kỳ trước)' USING ERRCODE='23514';
  END;

  RETURN v_row;
END;
$$;

-- ===== BULK CREATE (per-item atomic, trả kết quả từng dòng) =====
CREATE OR REPLACE FUNCTION public.bulk_create_meter_readings_v1(
  p_readings jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_item jsonb;
  v_row public.meter_readings;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_readings) <> 'array' THEN RAISE EXCEPTION 'p_readings phải là mảng'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_readings)
  LOOP
    BEGIN
      v_row := public.create_meter_reading_v1(
        (v_item->>'meter_id')::uuid,
        (v_item->>'reading_date')::date,
        (v_item->>'current_reading')::numeric,
        NULLIF(v_item->>'notes',''),
        NULLIF(v_item->>'meter_image_url','')
      );
      v_results := v_results || jsonb_build_object(
        'success', true, 'reading_id', v_row.id, 'reading_code', v_row.reading_code,
        'meter_id', v_row.meter_id, 'error_message', NULL);
    EXCEPTION WHEN OTHERS THEN
      v_results := v_results || jsonb_build_object(
        'success', false, 'reading_id', NULL, 'reading_code', NULL,
        'meter_id', v_item->>'meter_id', 'error_message', SQLERRM);
    END;
  END LOOP;

  RETURN v_results;
END;
$$;

-- ===== UPDATE (chỉ UNAPPROVED, CAS qua updated_at) =====
CREATE OR REPLACE FUNCTION public.update_meter_reading_v1(
  p_id uuid,
  p_current_reading numeric DEFAULT NULL,
  p_reading_date date DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_meter_image_url text DEFAULT NULL,
  p_expected_updated_at timestamptz DEFAULT NULL
) RETURNS public.meter_readings
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_r RECORD;
  v_row public.meter_readings;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;

  SELECT id, building_id, organization_id, updated_at INTO v_r
  FROM public.meter_readings WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy chỉ số' USING ERRCODE='42501'; END IF;
  IF v_r.building_id IS NULL THEN RAISE EXCEPTION 'Chỉ số chưa gắn toà nhà'; END IF;

  IF NOT (v_r.organization_id IS NULL
          OR public.is_super_admin()
          OR v_r.organization_id = ANY(public.my_org_ids())) THEN
    RAISE EXCEPTION 'Chỉ số thuộc tổ chức khác' USING ERRCODE='42501';
  END IF;
  IF NOT public.can_do_on_building('meter_readings','edit', v_r.building_id) THEN
    RAISE EXCEPTION 'Không có quyền sửa chỉ số cho toà này' USING ERRCODE='42501';
  END IF;
  -- LƯU Ý: KHÔNG chặn edit khi APPROVED — giữ parity với đường cũ (form hiện sửa
  -- được chỉ số đã duyệt; chỉ số mới luôn tạo APPROVED). Chặn sẽ là đổi hành vi.
  -- Quyền đã được can_do_on_building enforce; đây không phải chứng từ tiền như invoice.
  IF p_expected_updated_at IS NOT NULL AND v_r.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'Chỉ số đã bị thay đổi bởi người khác (version mismatch)' USING ERRCODE='40001';
  END IF;
  IF p_current_reading IS NOT NULL AND p_current_reading < 0 THEN
    RAISE EXCEPTION 'Chỉ số không hợp lệ';
  END IF;

  BEGIN
    UPDATE public.meter_readings SET
      current_reading = COALESCE(p_current_reading, current_reading),
      reading_date    = COALESCE(p_reading_date, reading_date),
      notes           = COALESCE(p_notes, notes),
      meter_image_url = COALESCE(p_meter_image_url, meter_image_url)
    WHERE id = p_id AND deleted_at IS NULL
    RETURNING * INTO v_row;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'Chỉ số mới không hợp lệ (phải ≥ chỉ số kỳ trước)' USING ERRCODE='23514';
  END;

  RETURN v_row;
END;
$$;

-- ===== DELETE (soft-delete, exact permission) =====
CREATE OR REPLACE FUNCTION public.delete_meter_reading_v1(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_r RECORD;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;

  SELECT id, building_id, organization_id INTO v_r
  FROM public.meter_readings WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  -- Idempotent: xoá row không tồn tại / đã xoá = success im lặng (parity đường cũ,
  -- chống double-click / concurrent delete báo lỗi thừa).
  IF NOT FOUND THEN RETURN; END IF;
  IF v_r.building_id IS NULL THEN RAISE EXCEPTION 'Chỉ số chưa gắn toà nhà'; END IF;

  IF NOT (v_r.organization_id IS NULL
          OR public.is_super_admin()
          OR v_r.organization_id = ANY(public.my_org_ids())) THEN
    RAISE EXCEPTION 'Chỉ số thuộc tổ chức khác' USING ERRCODE='42501';
  END IF;
  IF NOT public.can_do_on_building('meter_readings','delete', v_r.building_id) THEN
    RAISE EXCEPTION 'Không có quyền xoá chỉ số cho toà này' USING ERRCODE='42501';
  END IF;

  UPDATE public.meter_readings SET deleted_at = now()
  WHERE id = p_id AND deleted_at IS NULL;
END;
$$;

-- ===== BULK DELETE (per-item, trả danh sách id đã xoá) =====
CREATE OR REPLACE FUNCTION public.bulk_delete_meter_readings_v1(p_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_id uuid;
  v_deleted jsonb := '[]'::jsonb;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;

  FOREACH v_id IN ARRAY COALESCE(p_ids, ARRAY[]::uuid[])
  LOOP
    BEGIN
      PERFORM public.delete_meter_reading_v1(v_id);
      v_deleted := v_deleted || jsonb_build_object('id', v_id, 'success', true);
    EXCEPTION WHEN OTHERS THEN
      v_deleted := v_deleted || jsonb_build_object('id', v_id, 'success', false, 'error_message', SQLERRM);
    END;
  END LOOP;

  RETURN v_deleted;
END;
$$;

-- ===== Grants: các RPC này CÓ ý định client gọi (khác helper approval private) =====
REVOKE ALL ON FUNCTION public.create_meter_reading_v1(uuid, date, numeric, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bulk_create_meter_readings_v1(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_meter_reading_v1(uuid, numeric, date, text, text, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_meter_reading_v1(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bulk_delete_meter_readings_v1(uuid[]) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_meter_reading_v1(uuid, date, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_create_meter_readings_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_meter_reading_v1(uuid, numeric, date, text, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_meter_reading_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_delete_meter_readings_v1(uuid[]) TO authenticated;

COMMIT;
