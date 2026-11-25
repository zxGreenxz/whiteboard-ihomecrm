-- =============================================================================
-- Sale phòng, đợt 3 «Cọc ở Thu chi» — phạm vi rút gọn sau #499 «Thống nhất nhận cọc qua Thu chi» (20261125133852,
-- đã áp production). Phần máy chủ của lỗi 5, 21 và điều sót S4, S8 của audit 24/11/2026.
--
-- VÌ SAO
--   1. Phiếu cọc 0 đ: audit 24/11 lưu được PT2611442 tổng 0 đ, phòng biến khỏi sale. Sau #499, phiếu THU cọc chưa gắn
--      HĐ mới lập bị trigger hoãn bind_unlinked_deposit_income → attach_deposit_income_v1 từ chối khi tiền cọc ≤ 0, nhưng
--      với câu 22023 «Phiếu PTxxxx thiếu dòng cọc hợp lệ» (mã phiếu đó không còn sau khi giao dịch bị huỷ), và còn khe:
--      sửa / xoá dòng của phiếu ĐÃ nối đợt giữ chỗ (trigger của #499 bỏ qua phiếu đã nối, xoá dòng không trigger nào
--      bắt), bỏ huỷ / khôi phục / gỡ hợp đồng của phiếu (#499 không có trigger trên bảng phiếu), phiếu có system_source
--      hoặc nằm trong danh sách loại trừ.
--   2. Trang Sale chỉ ghi «Đang giữ chỗ» (cờ has_deposit_hold của #499) hoặc «Đã thuê / giữ chỗ»: không biết ai cọc,
--      từ bao giờ; phiếu cọc treo lâu (kể cả phiếu chưa nối đợt ở phòng đang có HĐ) không ai thấy để dọn.
--
-- LÀM GÌ
--   1. Constraint trigger DEFERRABLE INITIALLY DEFERRED a1_ie_item_deposit_amount_positive (dòng phiếu) và
--      a1_ie_deposit_amount_positive (phiếu): lúc COMMIT, phiếu THU chưa gắn hợp đồng, chưa xoá, chưa huỷ có hạng mục
--      cọc (is_deposit) thì tổng amount dòng cọc phải > 0 — không thì 23514 «Phiếu cọc phải có số tiền lớn hơn 0; giữ
--      phòng không thu tiền thì dùng Lock tạm.». Tên «a1_…» để chạy TRƯỚC bind_unlinked_deposit_income (trigger hoãn
--      cùng sự kiện chạy theo thứ tự tên) ⇒ người dùng thấy câu này trước câu 22023 của #499. Áp cho MỌI phiếu, kể cả
--      system_source và phiếu trong deposit_management_exclusions: không đường ghi hợp lệ nào cần phiếu cọc giữ phòng 0 đ
--      (đã rà 25/11: giữ chỗ Sale, cọc HĐ, chuyển cọc sang nhượng, hoàn / cấn cọc thanh lý, phiếu đảo, thu cọc theo hoá
--      đơn, tiền mới nộp lúc ký đều đòi tiền > 0, hoặc là phiếu CHI, hoặc gắn HĐ). Không đụng luồng của #499: huỷ phiếu
--      (approval_status = CANCELLED) và xoá phiếu không bị canh nên «huỷ phiếu cuối nhả đợt» chạy như cũ; nối phiếu vào
--      đợt không sửa dòng phiếu.
--   2. app_private.room_deposit_hold_json_v1(org, phòng): khối «đang giữ bằng cọc» theo mô hình đợt giữ chỗ của #499 —
--      đợt đang mở (room_next_claims LIVE + room_reservations HOLD): người gửi trên phiếu đầu, ngày nhận phiếu đầu, các
--      mã phiếu còn hiệu lực, số ngày giữ (ngày của công ty); phòng không có đợt mà còn phiếu cọc treo chưa nối (cùng vị
--      từ nhánh phiếu của room_has_holding_deposit, vd phòng đang có HĐ) thì lấy theo phiếu cũ nhất. Kèm room_occupied
--      (phòng còn khách ở) để giao diện không hiện Báo pass / Báo sắp trống ở phòng chỉ có cọc giữ chỗ.
--   3. get_sale_room_inventory_v1 và get_my_available_rooms(uuid): thân PRODUCTION hiện hành (đợt 2 Sale phòng
--      20261125034429 + vá has_deposit_hold của #499), giữ nguyên has_deposit_hold, chỉ thêm khoá deposit_hold cho phòng
--      'rented'. Link công khai, bot Zalo, Hermes KHÔNG đổi (không lộ tên người cọc).
--
-- KHÔNG ĐỔI
--   Không quét / sửa phiếu cũ: luật chỉ kiểm khi ghi. 4 phiếu Demo 0 đ (bộ mẫu 20260812010000) để nguyên. Không đổi
--   create_deposit_income_v1, attach / bind / release của #499, room_has_holding_deposit, RLS, quyền, sổ. Khách mới cọc
--   khi HĐ đang ở chưa báo trả vẫn bị #499 chặn (PT409) — điều phối giữ cách đó 25/11.
--
-- AN TOÀN CHẠY LẠI
--   Tiền kiểm: #499 phải đã áp (attach_deposit_income_v1 có mặt); md5(prosrc bỏ CR) hai reader = thân production đo
--   25/11/2026 (sau #499) hoặc thân của chính file này; room_has_holding_deposit đúng thân đã rà. Khác ⇒ 55000, không ghi.
--   Hậu kiểm thân, trigger (hoãn, đúng thứ tự trước bind_unlinked_deposit_income), ACL.
--   BẪY: migration sau này vá lại hai reader (kiểu nối neo như #499) thì lượt replay CI của file này (check-forward-
--   migration-idempotent) sẽ gặp thân khác md5 ghim ⇒ phải khai ngoại lệ pinned như đợt 2 (supabase/migration-policy.json).
--
-- LÙI (migration forward mới)
--   DROP TRIGGER a1_ie_item_deposit_amount_positive ON public.income_expense_items;
--   DROP TRIGGER a1_ie_deposit_amount_positive ON public.income_expenses;
--   dựng lại hai reader bằng thân production đã ghim md5 ở tiền kiểm (bỏ dòng deposit_hold, giữ has_deposit_hold);
--   DROP FUNCTION app_private.room_deposit_hold_json_v1(uuid,uuid), app_private.guard_deposit_voucher_amount_v1().
-- =============================================================================

-- 0. Tiền kiểm: đúng phụ thuộc, đúng thân đã rà.
DO $truoc$
DECLARE
  r record;
  v_md5 text;
BEGIN
  IF to_regclass('public.income_expenses') IS NULL
     OR to_regclass('public.income_expense_items') IS NULL
     OR to_regclass('public.income_expense_types') IS NULL
     OR to_regclass('public.tenants') IS NULL
     OR to_regclass('public.customers') IS NULL
     OR to_regclass('public.contracts') IS NULL
     OR to_regclass('public.room_next_claims') IS NULL
     OR to_regclass('public.room_reservations') IS NULL
     OR to_regclass('public.reservation_receipts') IS NULL
     OR to_regprocedure('public.ie_has_deposit_item(uuid)') IS NULL
     OR to_regprocedure('app_private.reservation_deposit_is_settled_v1(uuid)') IS NULL
     OR to_regprocedure('public.org_today_v1(uuid)') IS NULL
     OR to_regprocedure('app_private.org_timezone_v1(uuid)') IS NULL
     OR to_regprocedure('app_private.room_exit_hold_json_v1(uuid,uuid)') IS NULL
     OR to_regprocedure('app_private.org_building_owner_v1(uuid)') IS NULL
     OR to_regprocedure('app_private.sale_org_permission_v1(uuid,text)') IS NULL
     OR to_regprocedure('app_private.attach_deposit_income_v1(uuid,jsonb,uuid,uuid[])') IS NULL
     OR to_regprocedure('public.get_my_available_rooms(uuid)') IS NULL
     OR to_regprocedure('public.get_my_available_rooms()') IS NOT NULL THEN
    RAISE EXCEPTION 'coc_thu_chi: thiếu phụ thuộc — đợt 2 Sale phòng (20261125034429) và #499 (20261125133852) phải áp trước'
      USING ERRCODE = '55000';
  END IF;
  -- [0] thân production 25/11/2026 (đợt 2 + has_deposit_hold của #499) · [1] thân của chính file này (lượt chạy lại).
  FOR r IN SELECT * FROM (VALUES
      ('public.get_sale_room_inventory_v1(uuid,uuid,uuid)', '0e3e37a193c5db71f34089c7fcb6f789', '750a25e1ce88045eb797ba73bb38741f'),
      ('public.get_my_available_rooms(uuid)', '7a25503d7a27eff1c424e1870f132ef3', 'ebb64f53e46bc81d6ef3bb0b951e9685'),
      -- Không bị thay: nhánh phiếu của khối giữ cọc chép đúng vị từ hàm này — đổi hàm thì phải rà lại khối.
      ('public.room_has_holding_deposit(uuid)', '969b762fdcb47c536d26874b1b193183', '969b762fdcb47c536d26874b1b193183')
    ) AS v(fn, base_md5, file_md5) LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.fn);
    IF v_md5 IS NULL OR NOT (v_md5 = ANY (ARRAY[r.base_md5, r.file_md5])) THEN
      RAISE EXCEPTION '% KHÁC thân đã rà (md5 %) — DỪNG, đối chiếu thân đang chạy', r.fn, v_md5 USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$truoc$;

-- 1. Phiếu cọc phải có tiền. Hàm kiểm chạy lúc COMMIT; DEFINER để RLS không che dòng khi chính client ghi.
CREATE OR REPLACE FUNCTION app_private.guard_deposit_voucher_amount_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_ids  uuid[];
  v_code text;
  v_id   uuid;
BEGIN
  IF TG_TABLE_NAME = 'income_expense_items' THEN
    -- Dòng chuyển phiếu / bị xoá: kiểm cả phiếu cũ (có thể vừa mất dòng cọc có tiền).
    v_ids := ARRAY[CASE WHEN TG_OP <> 'DELETE' THEN NEW.income_expense_id END,
                   CASE WHEN TG_OP <> 'INSERT' THEN OLD.income_expense_id END];
  ELSE
    v_ids := ARRAY[NEW.id];
  END IF;

  -- Đọc trạng thái CUỐI của phiếu và các dòng (không dùng NEW): phiếu đã gắn HĐ / huỷ / xoá trong cùng giao dịch thì thôi.
  SELECT ie.id, ie.code
    INTO v_id, v_code
    FROM public.income_expenses ie
   WHERE ie.id = ANY (v_ids)
     AND ie.type = 'INCOME'
     AND ie.contract_id IS NULL
     AND ie.deleted_at IS NULL
     AND ie.approval_status IS DISTINCT FROM 'CANCELLED'
     AND EXISTS (SELECT 1
                   FROM public.income_expense_items i
                   JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
                  WHERE i.income_expense_id = ie.id
                    AND t.is_deposit)
     AND (SELECT COALESCE(sum(i.amount), 0)
            FROM public.income_expense_items i
            JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
           WHERE i.income_expense_id = ie.id
             AND t.is_deposit) <= 0
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Phiếu cọc phải có số tiền lớn hơn 0; giữ phòng không thu tiền thì dùng Lock tạm.'
      USING ERRCODE = '23514',
            DETAIL = format('Phiếu %s có hạng mục Tiền cọc nhưng tổng tiền cọc không lớn hơn 0 và chưa gắn hợp đồng — phiếu này sẽ giữ phòng mà không thu tiền.',
                            coalesce(v_code, v_id::text)),
            HINT = 'Nhập số tiền cọc lớn hơn 0 hoặc bỏ hạng mục Tiền cọc. Giữ phòng không thu tiền thì dùng Lock tạm ở danh sách phòng trống.';
  END IF;
  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION app_private.guard_deposit_voucher_amount_v1() IS
  'Constraint trigger (DEFERRABLE INITIALLY DEFERRED, chạy trước bind_unlinked_deposit_income): phiếu THU chưa gắn HĐ, chưa huỷ, chưa xoá có hạng mục is_deposit thì tổng amount dòng cọc phải > 0 — giữ phòng không thu tiền dùng Lock tạm. 23514. Sale phòng đợt 3, 25/11/2026.';

REVOKE ALL ON FUNCTION app_private.guard_deposit_voucher_amount_v1() FROM PUBLIC, anon, authenticated, service_role;

-- Dòng phiếu: thêm, xoá, đổi hạng mục / phiếu / số lượng / đơn giá / số tiền (amount do BEFORE tính lại từ số lượng ×
-- đơn giá nên nghe cả hai cột nguồn). Gồm cả dòng của phiếu đã nối đợt giữ chỗ.
DROP TRIGGER IF EXISTS a1_ie_item_deposit_amount_positive ON public.income_expense_items;
CREATE CONSTRAINT TRIGGER a1_ie_item_deposit_amount_positive
  AFTER INSERT OR DELETE OR UPDATE OF income_expense_type_id, income_expense_id, quantity, unit_price, amount
  ON public.income_expense_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_deposit_voucher_amount_v1();

-- Phiếu bỏ hợp đồng, được bỏ huỷ / khôi phục, hoặc đổi sang phiếu THU. Chỉ khi cột thật sự đổi: lệnh ghi lại cùng giá
-- trị lên phiếu cũ (vd 4 phiếu Demo 0 đ) không bị coi là sửa phiếu.
DROP TRIGGER IF EXISTS a1_ie_deposit_amount_positive ON public.income_expenses;
CREATE CONSTRAINT TRIGGER a1_ie_deposit_amount_positive
  AFTER UPDATE OF contract_id, approval_status, type, deleted_at ON public.income_expenses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.type = 'INCOME' AND NEW.contract_id IS NULL AND NEW.deleted_at IS NULL
        AND NEW.approval_status IS DISTINCT FROM 'CANCELLED'
        AND (OLD.type IS DISTINCT FROM NEW.type OR OLD.contract_id IS DISTINCT FROM NEW.contract_id
             OR OLD.approval_status IS DISTINCT FROM NEW.approval_status OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at))
  EXECUTE FUNCTION app_private.guard_deposit_voucher_amount_v1();

-- 2. Khối «đang giữ bằng cọc» cho hai reader nội bộ.
CREATE OR REPLACE FUNCTION app_private.room_deposit_hold_json_v1(p_organization_id uuid, p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_today    date := public.org_today_v1(p_organization_id);
  v_occupied boolean;
  v_hold     public.room_reservations%ROWTYPE;
  v_first    record;
  v_codes    jsonb;
  v_count    integer;
  v_day      date;
  v_payer    text;
BEGIN
  v_occupied := EXISTS (
    SELECT 1 FROM public.contracts c
    WHERE c.organization_id = p_organization_id AND c.room_id = p_room_id AND c.deleted_at IS NULL
      AND c.status IN ('ACTIVE', 'EXTENDED') AND c.actual_end_date IS NULL AND c.start_date <= v_today);

  -- Đợt giữ chỗ đang mở (#499: một đợt sống mỗi phòng, gom các phiếu thu của cùng lượt thuê).
  SELECT r.* INTO v_hold
    FROM public.room_reservations r
    JOIN public.room_next_claims c ON c.reservation_id = r.id AND c.organization_id = r.organization_id
   WHERE c.organization_id = p_organization_id AND c.room_id = p_room_id AND c.status = 'LIVE' AND r.status = 'HOLD'
   ORDER BY r.created_at, r.id
   LIMIT 1;
  IF FOUND THEN
    SELECT ie.id, ie.code, ie.voucher_date, NULLIF(btrim(ie.payer_name), '') AS payer INTO v_first
      FROM public.reservation_receipts rr
      JOIN public.income_expenses ie ON ie.id = rr.source_voucher_id AND ie.organization_id = rr.organization_id
     WHERE rr.reservation_id = v_hold.id AND ie.deleted_at IS NULL AND COALESCE(ie.approval_status, '') <> 'CANCELLED'
     ORDER BY ie.voucher_date, ie.created_at, ie.id
     LIMIT 1;
    SELECT COALESCE(jsonb_agg(x.code ORDER BY x.voucher_date, x.created_at, x.id) FILTER (WHERE x.code IS NOT NULL), '[]'::jsonb),
           count(*)
      INTO v_codes, v_count
      FROM (SELECT DISTINCT ie.id, ie.code, ie.voucher_date, ie.created_at
              FROM public.reservation_receipts rr
              JOIN public.income_expenses ie ON ie.id = rr.source_voucher_id AND ie.organization_id = rr.organization_id
             WHERE rr.reservation_id = v_hold.id AND ie.deleted_at IS NULL AND COALESCE(ie.approval_status, '') <> 'CANCELLED') x;
    -- Đợt cũ không có phiếu (giữ chỗ 0 đ thời kỳ trước) thì tính từ ngày lập đợt theo múi giờ công ty.
    v_day := COALESCE(v_first.voucher_date,
                      (v_hold.created_at AT TIME ZONE app_private.org_timezone_v1(p_organization_id))::date);
    v_payer := COALESCE(v_first.payer,
                        NULLIF(NULLIF(btrim(v_hold.customer_hint), ''), 'Chưa ghi người gửi'),
                        (SELECT NULLIF(btrim(cu.full_name), '') FROM public.customers cu WHERE cu.id = v_hold.customer_id));
    RETURN jsonb_build_object(
      'source', 'hold', 'hold_id', v_hold.id,
      'voucher_id', v_first.id, 'code', v_first.code, 'codes', v_codes,
      'voucher_date', v_day, 'payer_name', v_payer,
      'held_days', GREATEST(0, v_today - v_day),
      'voucher_count', v_count, 'room_occupied', v_occupied);
  END IF;

  -- Không có đợt: phiếu cọc treo chưa nối (dữ liệu cũ, vd phòng đang có HĐ) — cùng vị từ nhánh phiếu của
  -- room_has_holding_deposit; lấy phiếu CŨ NHẤT (giữ lâu nhất là thứ cần dọn trước).
  WITH holding AS (
    SELECT ie.id, ie.code, ie.voucher_date, ie.created_at,
      COALESCE(NULLIF(btrim(ie.payer_name), ''), NULLIF(btrim(t.full_name), '')) AS payer_name
    FROM public.income_expenses ie
    LEFT JOIN public.tenants t ON t.id = ie.tenant_id
    WHERE ie.organization_id = p_organization_id
      AND ie.room_id = p_room_id
      AND ie.deleted_at IS NULL
      AND ie.contract_id IS NULL
      AND ie.type = 'INCOME'
      AND COALESCE(ie.approval_status, '') <> 'CANCELLED'
      AND public.ie_has_deposit_item(ie.id)
      AND NOT app_private.reservation_deposit_is_settled_v1(ie.id)
  )
  SELECT jsonb_build_object(
    'source', 'voucher', 'hold_id', NULL,
    'voucher_id', h.id, 'code', h.code,
    'codes', (SELECT COALESCE(jsonb_agg(x.code ORDER BY x.voucher_date, x.created_at, x.id) FILTER (WHERE x.code IS NOT NULL), '[]'::jsonb) FROM holding x),
    'voucher_date', h.voucher_date, 'payer_name', h.payer_name,
    'held_days', GREATEST(0, v_today - h.voucher_date),
    'voucher_count', (SELECT count(*) FROM holding), 'room_occupied', v_occupied)
  INTO v_codes
  FROM holding h
  ORDER BY h.voucher_date, h.created_at, h.id
  LIMIT 1;
  RETURN v_codes;
END
$fn$;

COMMENT ON FUNCTION app_private.room_deposit_hold_json_v1(uuid, uuid) IS
  'Khối «đang giữ bằng cọc» của phòng cho get_sale_room_inventory_v1 / get_my_available_rooms: đợt giữ chỗ đang mở (#499) — người gửi phiếu đầu, ngày nhận phiếu đầu, các mã phiếu, số ngày giữ, số phiếu — hoặc phiếu cọc treo chưa nối cũ nhất; kèm phòng còn khách ở. Không dùng cho link công khai / bot / Hermes. Sale phòng đợt 3, 25/11/2026.';

REVOKE ALL ON FUNCTION app_private.room_deposit_hold_json_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 3. Bảng nội bộ: thân production (đợt 2 + has_deposit_hold của #499) + khoá deposit_hold.
CREATE OR REPLACE FUNCTION public.get_sale_room_inventory_v1(p_organization_id uuid, p_building_id uuid DEFAULT NULL, p_room_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb; v_owner uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false)
    OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id=p_organization_id AND status='ACTIVE')
    OR (public.is_super_admin() AND COALESCE(p_organization_id = ANY(public.sandbox_org_ids()), false)) THEN
    RAISE EXCEPTION 'Không có quyền xem phòng trong tổ chức này' USING ERRCODE='42501';
  END IF;
  -- Chủ cài đặt chung = người đứng tên chung các toà của công ty (không theo tập toà người xem được giao).
  v_owner:=app_private.org_building_owner_v1(p_organization_id);
  WITH allowed_buildings AS MATERIALIZED (
    SELECT b.*,
      app_private.sale_room_can_edit_v1(b.organization_id,b.id) AS can_edit,
      app_private.sale_room_can_v1(b.organization_id,b.id,'sale_phong.manage_images') AS can_images,
      app_private.sale_room_can_v1(b.organization_id,b.id,'sale_phong.manage_pass_listings') AS can_pass,
      app_private.sale_room_can_v1(b.organization_id,b.id,'sale_phong.lock_room') AS can_lock,
      app_private.sale_room_can_v1(b.organization_id,b.id,'deposits.create') AS can_deposit
    FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL AND NOT b.is_virtual
      AND (p_building_id IS NULL OR b.id=p_building_id)
      AND (app_private.sale_room_can_v1(b.organization_id,b.id,'rooms.view')
        OR app_private.sale_room_can_v1(b.organization_id,b.id,'sale_phong.view'))
  ), inventory AS MATERIALIZED (
    SELECT r.id, r.building_id, r.floor, r.name, r.code, r.area, r.rent_price,
      r.deposit_amount, r.max_occupants, r.amenities, r.images, r.description,
      r.sale_note, CASE WHEN b.can_edit THEN r.sale_bonus_note END AS sale_bonus_note,
      r.room_type, r.updated_at, md5(to_jsonb(r)::text) AS revision,
      r.sale_status_note AS sale_status_note_raw,r.sale_status_note_key,
      app_private.sale_room_fact_key_v1(r.id,r.organization_id) AS sale_fact_key,
      CASE WHEN r.sale_status_note_key=app_private.sale_room_fact_key_v1(r.id,r.organization_id) THEN r.sale_status_note END AS sale_status_note,
      app_private.room_sale_policy_current_v1(r.organization_id,r.id,statement_timestamp()) AS policy,
      COALESCE((SELECT jsonb_agg(app_private.room_sale_policy_json_v1(p,statement_timestamp()) ORDER BY p.starts_at,p.id)
        FROM app_private.room_sale_policies_v1 p WHERE p.organization_id=r.organization_id AND p.room_id=r.id
          AND p.cancelled_at IS NULL AND p.ends_at>statement_timestamp()),'[]'::jsonb) AS policies,
      app_private.room_sale_policy_active_text_v1(r.organization_id,r.id,statement_timestamp()) AS active_policy_text,
      NULLIF(concat_ws(E'\n',NULLIF(btrim(r.sale_note),''),app_private.room_sale_policy_active_text_v1(r.organization_id,r.id,statement_timestamp())),'') AS effective_sale_note,
      fact.status_public, fact.sale_state, fact.avail_date, fact.sale_today, fact.expected_ready_on,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_name END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_phone END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN pl.sale_policy END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      CASE WHEN lk.id IS NOT NULL THEN jsonb_build_object(
        'id',lk.id,'hours',lk.hours,'note',lk.note,'locked_at',lk.locked_at,'expires_at',lk.expires_at,
        'locked_by_name',COALESCE(NULLIF(btrim(lp.full_name),''),'Người dùng'),
        'locked_by_me',lk.locked_by=auth.uid()) END AS sale_lock,
      app_private.room_exit_hold_json_v1(r.organization_id,r.id) AS exit_hold, EXISTS(SELECT 1 FROM public.room_next_claims dc WHERE dc.organization_id=r.organization_id AND dc.room_id=r.id AND dc.status='LIVE') AS has_deposit_hold,
      CASE WHEN fact.status_public='rented' THEN app_private.room_deposit_hold_json_v1(r.organization_id,r.id) END AS deposit_hold,
      jsonb_build_object(
        'edit',b.can_edit,'images',b.can_edit OR b.can_images,'pass',b.can_pass,
        'lock',b.can_lock AND fact.status_public IN ('free','soon') AND lk.id IS NULL,
        'releaseLock',lk.id IS NOT NULL AND ((lk.locked_by=auth.uid() AND b.can_lock) OR b.can_deposit),
        'deposit',b.can_deposit
      ) AS capabilities,
      audit.updated_by_name
    FROM public.rooms r
    JOIN allowed_buildings b ON b.id=r.building_id AND b.organization_id=r.organization_id
    LEFT JOIN public.public_room_settings settings ON settings.owner_id=b.user_id AND settings.organization_id=b.organization_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id=r.id AND pl.organization_id=r.organization_id AND pl.active
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(
      r.id,r.organization_id,r.status::text,pl.id IS NOT NULL,COALESCE(settings.soon_days,30)
    ) fact
    LEFT JOIN LATERAL (
      SELECT l.* FROM public.room_sale_locks l
      WHERE l.room_id=r.id AND l.organization_id=r.organization_id
        AND l.released_at IS NULL AND l.expires_at>now()
        AND fact.status_public='rented'
        AND EXISTS (SELECT 1 FROM app_private.room_sale_workflow_base_fact_v1(
          r.id,r.organization_id,r.status::text,pl.id IS NOT NULL,COALESCE(settings.soon_days,30)
        ) base WHERE base.status_public IN ('free','soon'))
      ORDER BY l.locked_at DESC LIMIT 1
    ) lk ON true
    LEFT JOIN public.profiles lp ON lp.id=lk.locked_by
    LEFT JOIN LATERAL (
      SELECT COALESCE(NULLIF(btrim(p.full_name),''),'Người dùng') AS updated_by_name
      FROM app_private.sale_room_change_receipts cr
      LEFT JOIN public.profiles p ON p.id=cr.actor_id
      WHERE cr.room_id=r.id AND cr.organization_id=r.organization_id
        AND cr.response->>'revision'=md5(to_jsonb(r)::text)
      ORDER BY cr.created_at DESC LIMIT 1
    ) audit ON true
    WHERE r.organization_id=p_organization_id AND r.deleted_at IS NULL
      AND (p_room_id IS NULL OR r.id=p_room_id)
  )
  SELECT jsonb_build_object(
    'server_now',statement_timestamp(),'areas','[]'::jsonb,
    'next_policy_boundary_at',(SELECT min(boundary) FROM app_private.room_sale_policies_v1 p
      JOIN inventory i ON i.id=p.room_id CROSS JOIN LATERAL (VALUES(p.starts_at),(p.ends_at)) d(boundary)
      WHERE p.organization_id=p_organization_id AND p.cancelled_at IS NULL AND boundary>statement_timestamp()),
    'settings_owner_id',v_owner,
    'can_manage_account_settings',(v_owner IS NOT NULL AND app_private.sale_org_wide_permission_v1(p_organization_id,'sale_phong.manage_settings')),
    'sale_policy',(SELECT NULLIF(btrim(s.sale_policy),'') FROM public.public_room_settings s WHERE s.owner_id=v_owner AND s.organization_id=p_organization_id),
    'contact',(SELECT jsonb_build_object('name',h.name,'phone',h.phone_number) FROM public.hotlines h
      LEFT JOIN public.public_room_settings s ON s.owner_id=h.user_id AND s.organization_id=p_organization_id
      WHERE h.user_id=v_owner AND h.organization_id=p_organization_id
      AND COALESCE(h.is_active,true) AND (s.hotline_id IS NULL OR h.id=s.hotline_id)
      ORDER BY (h.id=s.hotline_id) DESC NULLS LAST,h.created_at LIMIT 1),
    'rooms',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.building_id,i.floor,i.name,i.id) FROM inventory i),'[]'::jsonb),
    'buildings',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',b.id,'name',b.name,'code',b.code,'district',b.district,'ward',b.ward,
      'address',concat_ws(', ',NULLIF(b.street_address,''),NULLIF(b.ward,''),NULLIF(b.district,''),NULLIF(b.province,'')),
      'total_floors',b.total_floors,'images',b.images,'public_contact_name',b.public_contact_name,
      'public_contact_phone',b.public_contact_phone,'public_map_url',b.public_map_url,
      'public_lift_type',b.public_lift_type,
      'floor_layouts',b.floor_layouts,
      'area_ids',COALESCE((SELECT jsonb_agg(ab.area_id ORDER BY ab.area_id) FROM public.area_buildings ab
        JOIN public.areas a ON a.id=ab.area_id AND a.organization_id=b.organization_id AND a.deleted_at IS NULL
        WHERE ab.building_id=b.id AND ab.organization_id=b.organization_id),'[]'::jsonb),
      'elec_rate',(SELECT COALESCE(bs.unit_price_override,s.unit_price) FROM public.building_services bs
        JOIN public.services s ON s.id=bs.service_id WHERE bs.building_id=b.id AND bs.is_active
        AND s.deleted_at IS NULL AND s.unit ILIKE 'kwh' ORDER BY (s.type='FIXED') DESC,s.unit_price LIMIT 1)
    ) ORDER BY b.name,b.id) FROM allowed_buildings b
      WHERE EXISTS (SELECT 1 FROM inventory i WHERE i.building_id=b.id)),'[]'::jsonb)
  ) INTO result;
  RETURN result;
END
$fn$;
REVOKE ALL ON FUNCTION public.get_sale_room_inventory_v1(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sale_room_inventory_v1(uuid, uuid, uuid) TO authenticated;

-- 4. «Phòng trống» (điện thoại): thân production (đợt 2 + has_deposit_hold của #499) + khoá deposit_hold.
CREATE OR REPLACE FUNCTION public.get_my_available_rooms(p_organization_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  v_caller  uuid := auth.uid();
  v_orgs    uuid[];
  v_org     uuid := p_organization_id;
  v_owner   uuid;
  v_hotline uuid;
  v_sale_policy text;
  v_result  jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN NULL;
  END IF;

  -- Công ty: công ty đang chọn. Bản web cũ không gửi ⇒ công ty duy nhất của người gọi; thuộc nhiều công ty thì công
  -- ty có toà người gọi đứng tên nếu duy nhất (đường cũ của nick chủ), không thì bắt chọn — không đoán.
  v_orgs := COALESCE(public.my_org_ids(), '{}'::uuid[]);
  IF v_org IS NULL THEN
    IF cardinality(v_orgs) = 1 THEN
      v_org := v_orgs[1];
    ELSIF cardinality(v_orgs) = 0 THEN
      RAISE EXCEPTION 'my_available_rooms_not_member' USING ERRCODE = '42501',
        HINT = 'Tài khoản không còn là thành viên đang hoạt động của công ty nào.';
    ELSE
      SELECT CASE WHEN count(DISTINCT b.organization_id) = 1 THEN (array_agg(DISTINCT b.organization_id))[1] END INTO v_org
        FROM public.buildings b
       WHERE b.user_id = v_caller AND b.deleted_at IS NULL AND b.organization_id = ANY (v_orgs);
      IF v_org IS NULL THEN
        RAISE EXCEPTION 'my_available_rooms_org_required' USING ERRCODE = '22023',
          HINT = 'Tài khoản thuộc nhiều công ty: gửi p_organization_id của công ty đang chọn.';
      END IF;
    END IF;
  ELSIF NOT (v_org = ANY (v_orgs)) THEN
    RAISE EXCEPTION 'my_available_rooms_not_member' USING ERRCODE = '42501',
      HINT = 'Tài khoản không phải thành viên đang hoạt động của công ty này.';
  END IF;

  -- Hotline và chính sách chung: theo người đứng tên chung các toà của công ty (chủ cài đặt chung).
  v_owner := app_private.org_building_owner_v1(v_org);
  SELECT hotline_id, sale_policy INTO v_hotline, v_sale_policy
  FROM public.public_room_settings
  WHERE owner_id = v_owner AND organization_id = v_org;

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
      lk.sale_lock,
      app_private.room_exit_hold_json_v1(rm.organization_id,rm.id) AS exit_hold, EXISTS(SELECT 1 FROM public.room_next_claims dc WHERE dc.organization_id=rm.organization_id AND dc.room_id=rm.id AND dc.status='LIVE') AS has_deposit_hold,
      CASE WHEN fact.status_public = 'rented' THEN app_private.room_deposit_hold_json_v1(rm.organization_id,rm.id) END AS deposit_hold
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id AND b.organization_id = rm.organization_id
    -- Số ngày sắp trống theo người đứng tên từng toà (như bảng nội bộ).
    LEFT JOIN public.public_room_settings ps ON ps.owner_id = b.user_id AND ps.organization_id = b.organization_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = rm.id AND pl.organization_id = rm.organization_id AND pl.active = true
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,COALESCE(ps.soon_days,30)) fact
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
          SELECT 1 FROM app_private.room_sale_workflow_base_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,COALESCE(ps.soon_days,30)) base
          WHERE base.status_public IN ('free','soon'))
    ) lk ON true
    WHERE b.organization_id = v_org
      AND b.is_virtual = false
      AND b.deleted_at IS NULL
      AND rm.deleted_at IS NULL
      -- Như bảng nội bộ: toà người xem có quyền xem phòng hoặc xem trang Sale.
      AND (app_private.sale_room_can_v1(b.organization_id,b.id,'rooms.view')
        OR app_private.sale_room_can_v1(b.organization_id,b.id,'sale_phong.view'))
  ),
  bld_ids AS (
    SELECT DISTINCT building_id FROM rms WHERE status_public IN ('free','soon','pass') OR sale_lock IS NOT NULL OR exit_hold IS NOT NULL OR has_deposit_hold
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
    WHERE a.organization_id = v_org AND a.deleted_at IS NULL
  ),
  contact_j AS (
    SELECT jsonb_build_object('name', h.name, 'phone', h.phone_number) AS j
    FROM public.hotlines h
    WHERE h.user_id = v_owner AND h.organization_id = v_org
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

  RETURN app_private.room_sale_policy_overlay_v1(v_result);
END;
$fn$;
REVOKE ALL ON FUNCTION public.get_my_available_rooms(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_available_rooms(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_available_rooms(uuid) TO service_role;

-- 5. Hậu kiểm (chỉ catalog — chạy được trên database rỗng).
DO $sau$
DECLARE
  r record;
  v_md5 text;
  v_n int;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.get_sale_room_inventory_v1(uuid,uuid,uuid)', '750a25e1ce88045eb797ba73bb38741f'),
      ('public.get_my_available_rooms(uuid)', 'ebb64f53e46bc81d6ef3bb0b951e9685'),
      ('app_private.room_deposit_hold_json_v1(uuid,uuid)', 'aedf72d27d5a899d60acdb019b3a879c'),
      ('app_private.guard_deposit_voucher_amount_v1()', '8bbf344c32988686aa7c823f7073c79d')
    ) AS v(fn, file_md5) LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.fn);
    IF v_md5 IS DISTINCT FROM r.file_md5 THEN
      RAISE EXCEPTION 'coc_thu_chi: % sau áp khác thân của file (md5 %)', r.fn, v_md5 USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF to_regprocedure('public.get_my_available_rooms()') IS NOT NULL THEN
    RAISE EXCEPTION 'coc_thu_chi: bản get_my_available_rooms() không tham số không được có lại' USING ERRCODE = '55000';
  END IF;
  -- Cờ của #499 phải còn nguyên ở cả hai reader.
  IF (SELECT count(*) FROM pg_proc WHERE oid IN ('public.get_sale_room_inventory_v1(uuid,uuid,uuid)'::regprocedure,
        'public.get_my_available_rooms(uuid)'::regprocedure) AND prosrc LIKE '%AS has_deposit_hold%') <> 2 THEN
    RAISE EXCEPTION 'coc_thu_chi: reader mất has_deposit_hold của #499' USING ERRCODE = '55000';
  END IF;

  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'app_private.guard_deposit_voucher_amount_v1()'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'app_private.room_deposit_hold_json_v1(uuid,uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'coc_thu_chi: hàm kiểm / khối giữ cọc phải SECURITY DEFINER' USING ERRCODE = '55000';
  END IF;

  -- Hai trigger hoãn tới COMMIT, đang bật, đúng hàm; trigger dòng nghe cả INSERT, UPDATE, DELETE.
  SELECT count(*) INTO v_n
    FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgdeferrable AND tginitdeferred AND tgenabled = 'O'
     AND tgfoid = 'app_private.guard_deposit_voucher_amount_v1()'::regprocedure
     AND ((tgrelid = 'public.income_expense_items'::regclass AND tgname = 'a1_ie_item_deposit_amount_positive'
           AND (tgtype & 4) <> 0 AND (tgtype & 8) <> 0 AND (tgtype & 16) <> 0)
       OR (tgrelid = 'public.income_expenses'::regclass AND tgname = 'a1_ie_deposit_amount_positive'
           AND (tgtype & 16) <> 0));
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'coc_thu_chi: thiếu trigger chặn phiếu cọc 0 đ (% / 2, phải DEFERRABLE INITIALLY DEFERRED)', v_n
      USING ERRCODE = '55000';
  END IF;
  -- Câu «phải có số tiền» phải đến trước câu 22023 của #499: trigger hoãn cùng sự kiện chạy theo thứ tự tên.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.income_expense_items'::regclass AND NOT tgisinternal
               AND tgdeferrable AND tgname <= 'a1_ie_item_deposit_amount_positive'
               AND tgname <> 'a1_ie_item_deposit_amount_positive') THEN
    RAISE EXCEPTION 'coc_thu_chi: có trigger hoãn khác trên income_expense_items chạy trước luật chặn cọc 0 đ' USING ERRCODE = '55000';
  END IF;

  IF has_function_privilege('anon', 'app_private.guard_deposit_voucher_amount_v1()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.guard_deposit_voucher_amount_v1()', 'EXECUTE')
     OR has_function_privilege('anon', 'app_private.room_deposit_hold_json_v1(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.room_deposit_hold_json_v1(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'coc_thu_chi: anon/authenticated còn EXECUTE trên hàm nội bộ' USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('anon', 'public.get_sale_room_inventory_v1(uuid,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_my_available_rooms(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_sale_room_inventory_v1(uuid,uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_my_available_rooms(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_my_available_rooms(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'coc_thu_chi: quyền gọi hai reader lệch (anon không được, authenticated được)' USING ERRCODE = '55000';
  END IF;
END
$sau$;
