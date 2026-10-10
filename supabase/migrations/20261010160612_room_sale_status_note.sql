-- Ô TÌNH TRẠNG gõ tay ở bảng "Danh sách phòng trống" (Cài đặt hiển thị) — chủ chốt 10/10/2026.
--  (1) rooms.sale_status_note: trống = cột TÌNH TRẠNG tự tính như cũ (TRỐNG SẴN, 1/8 TRỐNG,
--      KHÁCH PASS…); có chữ = ảnh và bảng in đúng chữ đó. Chỉ reader trong app trả cột này:
--      trang công khai, Zalo, Copilot vẫn đọc sale facts tự tính.
--  (2) Chữ gõ tay chỉ in khi tình trạng tự tính còn như lúc gõ — hai lớp, mỗi lớp phủ một nhóm:
--      a) Khoá: reader trả sale_fact_key (băm trạng thái công khai, sale_state, ngày trống, ngày
--         dự kiến xong, tin pass); app lưu khoá đó vào sale_status_note_key cùng chữ; lệch khoá thì
--         reader không trả chữ. Phủ các đổi KHÔNG chạm rooms.status: gia hạn/đổi ngày trả phòng,
--         quá hạn báo trống, bật/tắt tin pass, chuẩn bị ↔ sẵn sàng.
--      b) Trigger: rooms.status đổi (khách vào/ra, giữ chỗ cọc) ⇒ xoá chữ + khoá. Phủ vòng cho thuê
--         trọn vẹn — phòng trống sẵn đi hết một vòng thuê rồi trống lại có khoá y như cũ, khoá
--         không phân biệt được (review chéo 10/10; rooms không còn cột phiên bản nào để băm).
--  (3) get_my_available_rooms chép nguyên 20261010114500 (bản đang chạy), chỉ thêm khoá + chữ;
--      không đổi kiểu trả về/ACL.
-- Quyền ghi đi theo RLS rooms_update_rbac (rooms.edit) như sale_note/rent_price cùng bảng.

-- ── 1. Cột ──────────────────────────────────────────────────────────
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS sale_status_note text;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS sale_status_note_key text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.rooms'::regclass AND conname = 'rooms_sale_status_note_len'
  ) THEN
    ALTER TABLE public.rooms ADD CONSTRAINT rooms_sale_status_note_len
      CHECK (sale_status_note IS NULL OR char_length(sale_status_note) <= 120);
  END IF;
END $$;
COMMENT ON COLUMN public.rooms.sale_status_note IS
  'Chữ TÌNH TRẠNG gõ tay cho ảnh/bảng "Danh sách phòng trống"; NULL = tự tính. Chỉ in khi sale_status_note_key khớp sale_fact_key hiện tại.';
COMMENT ON COLUMN public.rooms.sale_status_note_key IS
  'sale_fact_key (get_my_available_rooms) lúc gõ sale_status_note; lệch thì chữ gõ tay coi như hết hiệu lực.';

-- ── 2. rooms.status đổi ⇒ xoá chữ gõ tay ────────────────────────────
-- Không kiểm quyền (quyền sửa phòng do rooms_update_rbac chặn trước) ⇒ INVOKER, không DEFINER.
-- Lệnh UPDATE tự ghi chữ mới cùng lúc đổi status thì giữ chữ được ghi.
CREATE OR REPLACE FUNCTION public.rooms_clear_sale_status_note()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.sale_status_note IS NOT DISTINCT FROM OLD.sale_status_note THEN
    NEW.sale_status_note := NULL;
    NEW.sale_status_note_key := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.rooms_clear_sale_status_note() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_rooms_clear_sale_status_note ON public.rooms;
CREATE TRIGGER trg_rooms_clear_sale_status_note
  BEFORE UPDATE OF status ON public.rooms
  FOR EACH ROW
  EXECUTE FUNCTION public.rooms_clear_sale_status_note();

-- ── 3. Reader trong app trả sale_fact_key + chữ gõ tay còn hiệu lực ──
CREATE OR REPLACE FUNCTION public.get_my_available_rooms()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_caller  uuid := auth.uid();
  v_owner   uuid;
  v_soon    int;
  v_hotline uuid;
  v_sale_policy text;
  v_result  jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT sa.user_id INTO v_owner
  FROM public.staff_assignments sa
  WHERE sa.staff_id = v_caller AND sa.user_id <> v_caller
  LIMIT 1;
  IF v_owner IS NULL THEN
    v_owner := v_caller;
  END IF;

  SELECT soon_days, hotline_id, sale_policy INTO v_soon, v_hotline, v_sale_policy
  FROM public.public_room_settings
  WHERE owner_id = v_owner;
  IF v_soon IS NULL THEN v_soon := 30; END IF;

  WITH rms AS (
    SELECT
      rm.id,
      rm.building_id,
      rm.floor,
      rm.name,
      rm.code,
      rm.area,
      rm.rent_price,
      rm.deposit_amount,
      rm.max_occupants,
      COALESCE(rm.amenities, '[]'::jsonb) AS amenities,
      COALESCE(rm.images,    '[]'::jsonb) AS images,
      rm.description,
      rm.sale_note,
      rm.sale_bonus_note,
      rm.room_type,
      -- 10/10 (Tình trạng gõ tay): chỉ trả chữ khi tình trạng tự tính vẫn như lúc gõ.
      CASE WHEN rm.sale_status_note_key = fk.sale_fact_key THEN rm.sale_status_note END AS sale_status_note,
      fk.sale_fact_key,
      -- Phòng khách nhờ sale (overlay). Khi contact_manager → che SĐT/tên khách.
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_name ELSE NULL END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_phone ELSE NULL END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN pl.sale_policy ELSE NULL END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price ELSE NULL END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date ELSE NULL END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      fact.status_public, fact.sale_state, fact.avail_date, fact.sale_today, fact.expected_ready_on,
      lk.sale_lock
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id AND b.organization_id = rm.organization_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = rm.id AND pl.user_id = v_owner AND pl.active = true
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,v_soon) fact
    CROSS JOIN LATERAL (
      -- format giữ chỗ cho NULL (concat_ws bỏ qua NULL ⇒ hai tình trạng khác nhau có thể trùng khoá);
      -- ngày qua to_char để khoá không phụ thuộc DateStyle của phiên.
      SELECT md5(format('%s|%s|%s|%s|%s|%s', fact.status_public, fact.sale_state,
                        to_char(fact.avail_date, 'YYYY-MM-DD'), to_char(fact.expected_ready_on, 'YYYY-MM-DD'),
                        CASE WHEN fact.status_public = 'pass' THEN pl.id END,
                        CASE WHEN fact.status_public = 'pass' THEN to_char(pl.avail_date, 'YYYY-MM-DD') END)) AS sale_fact_key
    ) fk
    -- 10/10: phòng bị ẩn CHỈ vì lock tạm còn hạn ⇒ nhân viên trong app thấy ai lock, còn bao lâu.
    -- Reader công khai/Zalo/Copilot không có khoá này; trạng thái vẫn 'rented' như phòng đã cọc.
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('id', l.id, 'hours', l.hours, 'note', l.note,
               'locked_at', l.locked_at, 'expires_at', l.expires_at,
               'locked_by_name', COALESCE(NULLIF(btrim(p.full_name), ''), 'Người dùng'),
               'locked_by_me', l.locked_by = v_caller) AS sale_lock
      FROM public.room_sale_locks l
      LEFT JOIN public.profiles p ON p.id = l.locked_by
      WHERE fact.status_public = 'rented'
        AND l.organization_id = rm.organization_id AND l.room_id = rm.id
        AND l.released_at IS NULL AND l.expires_at > now()
        AND EXISTS (
          SELECT 1 FROM app_private.room_sale_workflow_base_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,v_soon) base
          WHERE base.status_public IN ('free','soon'))
    ) lk ON true
    WHERE b.user_id = v_owner
      AND b.is_virtual = false
      AND b.deleted_at IS NULL
      AND rm.deleted_at IS NULL
  ),
  bld_ids AS (
    SELECT DISTINCT building_id FROM rms WHERE status_public IN ('free','soon','pass') OR sale_lock IS NOT NULL
  ),
  rooms_j AS (
    SELECT jsonb_agg(to_jsonb(rms) ORDER BY rms.floor DESC, rms.name) AS j
    FROM rms
    WHERE rms.building_id IN (SELECT building_id FROM bld_ids)
  ),
  blds_j AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id',           b.id,
      'name',         b.name,
      'code',         b.code,
      'area_ids',     COALESCE((
                        SELECT jsonb_agg(ab.area_id)
                        FROM public.area_buildings ab
                        JOIN public.areas a ON a.id = ab.area_id
                        WHERE ab.building_id = b.id AND a.deleted_at IS NULL
                      ), '[]'::jsonb),
      'district',     b.district,
      'ward',         b.ward,
      'address',      CASE
                        WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%'
                          THEN b.street_address
                        ELSE concat_ws(', ',
                               NULLIF(b.street_address, ''),
                               NULLIF(b.ward, ''),
                               NULLIF(b.district, ''),
                               NULLIF(b.province, ''))
                      END,
      'total_floors', b.total_floors,
      'floor_layouts', b.floor_layouts,
      'images',        COALESCE(b.images, '[]'::jsonb),
      'public_contact_name',  b.public_contact_name,
      'public_contact_phone', b.public_contact_phone,
      'public_map_url',       b.public_map_url,
      'public_lift_type',     b.public_lift_type,
      'elec_rate', (
        SELECT COALESCE(bs.unit_price_override, s.unit_price)
        FROM public.building_services bs
        JOIN public.services s ON s.id = bs.service_id
        WHERE bs.building_id = b.id
          AND bs.is_active = true
          AND s.deleted_at IS NULL
          AND s.unit ILIKE 'kwh'
        ORDER BY (s.type = 'FIXED') DESC, s.unit_price
        LIMIT 1
      )
    ) ORDER BY b.name) AS j
    FROM public.buildings b
    WHERE b.id IN (SELECT building_id FROM bld_ids)
  ),
  areas_j AS (
    SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.name) AS j
    FROM public.areas a
    WHERE a.user_id = v_owner AND a.deleted_at IS NULL
  ),
  contact_j AS (
    SELECT jsonb_build_object('name', h.name, 'phone', h.phone_number) AS j
    FROM public.hotlines h
    WHERE h.user_id = v_owner
      AND COALESCE(h.is_active, true) = true
      AND (v_hotline IS NULL OR h.id = v_hotline)
    ORDER BY (h.id = v_hotline) DESC NULLS LAST, h.created_at
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'areas',     COALESCE((SELECT j FROM areas_j), '[]'::jsonb),
    'buildings', COALESCE((SELECT j FROM blds_j), '[]'::jsonb),
    'rooms',     COALESCE((SELECT j FROM rooms_j), '[]'::jsonb),
    'contact',   (SELECT j FROM contact_j),
    'sale_policy', NULLIF(btrim(v_sale_policy), '')
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

-- ── 4. Tự kiểm trước khi commit ─────────────────────────────────────
DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.rooms'::regclass AND tgname='trg_rooms_clear_sale_status_note' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Thiếu trigger xoá chữ Tình trạng khi rooms.status đổi';
  END IF;
  IF position('sale_status_note_key = fk.sale_fact_key' IN pg_get_functiondef('public.get_my_available_rooms()'::regprocedure))=0 THEN
    RAISE EXCEPTION 'get_my_available_rooms chưa trả chữ Tình trạng theo khoá';
  END IF;
  IF has_function_privilege('anon','public.get_my_available_rooms()','EXECUTE')
    OR has_function_privilege('anon','public.rooms_clear_sale_status_note()','EXECUTE') THEN
    RAISE EXCEPTION 'ACL hàm mở quá rộng cho anon';
  END IF;
END
$assert$;
