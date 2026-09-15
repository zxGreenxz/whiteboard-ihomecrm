-- =============================================================================
-- Chủ công ty tạo được toà, và toà mới tự có phạm vi phân quyền
--
-- I3.3, plan rà soát 15/09/2026. Hai lỗi nối đuôi nhau trên cùng một đường.
--
-- ------------------------------ (A) KHÔNG TẠO ĐƯỢC TOÀ ----------------------
-- Policy buildings_insert_rbac (20260611110000) chỉ cho qua khi:
--     is_super_admin()
--  OR có staff_assignments TOÀN ORG (building_id IS NULL AND area_id IS NULL)
--     mang cờ __superadmin / vai tên 'Admin' / permissions->buildings->create
--
-- Đó là hàng rào theo mô hình CŨ (staff_assignments + roles.permissions jsonb).
-- Cả hệ đã chuyển sang v3 (role_bindings → authorization_scopes →
-- authorized_scope_v3) từ 20260725070000, nhưng riêng cửa INSERT của buildings
-- thì chưa ai chuyển. Đo production 15/09/2026 (read-only, giả lập
-- request.jwt.claims của chính chủ 0520169e-0860-4b4e-a603-675c8aa245aa):
--
--     authorized_scope_v3('buildings.create', org iHome).org_wide  =  TRUE
--     staff_assignments toàn org của người đó                      =  0 dòng
--
-- Tức người có quyền tạo toà theo hệ v3 vẫn bị policy từ chối, vì họ không có
-- dòng nào ở bảng của hệ cũ. Chủ công ty phải mượn tài khoản hệ thống (super
-- admin) để tạo toà — đúng thứ mà việc tách vai chủ khỏi vai IT định bỏ.
--
-- SỬA: THÊM một vế v3 vào policy, KHÔNG bỏ vế cũ. Bỏ vế cũ là chuyện khác
-- (phải đo ai đang sống nhờ nó); thêm vế là nới đúng cho người hệ v3 đã cho
-- phép. authorized_scope_v3 là STABLE, không khoá, không raise — chính nó ghi
-- trong COMMENT là "an toàn dùng trong RLS".
--
-- Chỉ nhận org_wide, KHÔNG nhận building_ids: tạo toà MỚI thì chưa có toà nào
-- để trỏ tới, nên quyền phạm vi-một-toà không phải là quyền tạo toà.
-- buildings.organization_id CÓ THỂ NULL (đo: attnotnull = false); với NULL thì
-- authorized_scope_v3 không trả dòng nào ⇒ vế mới im, vế cũ quyết định — không
-- mở thêm cửa nào cho dòng không khai tổ chức.
--
-- ------------------------------ (B) TOÀ MỚI VÔ HÌNH -------------------------
-- Tạo được toà rồi thì lỗi thứ hai lộ ra: hệ v3 chỉ phân quyền được cho những
-- gì có dòng trong authorization_scopes. Không có đường ghi nào sinh dòng
-- BUILDING cho toà mới — đo production: 0 trigger trên public.buildings ngoài
-- set_user_id_from_auth và update_updated_at_column. Toà mới vì thế KHÔNG xuất
-- hiện trong hộp thoại Phân quyền, và cũng không ai gán được quyền theo toà
-- cho nó. (23 toà đang sống hiện đều đã có scope — do vá tay, không do máy.)
--
-- SỬA: trigger AFTER INSERT sinh dòng BUILDING. Idempotent nhờ unique index
-- auth_scope_building_uidx (organization_id, building_id) WHERE
-- scope_type='BUILDING'.
--
-- Hàm phải SECURITY DEFINER: authorization_scopes bật RLS (3 policy), người
-- tạo toà không nhất thiết ghi thẳng được vào bảng đó.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- (A) Nới cửa INSERT theo hệ v3.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS buildings_insert_rbac ON public.buildings;
CREATE POLICY buildings_insert_rbac ON public.buildings
  FOR INSERT
  WITH CHECK (
    (SELECT public.is_super_admin())
    -- Vế v3: quyền tạo toà ở phạm vi TOÀN TỔ CHỨC của chính org dòng mới khai.
    OR EXISTS (
      SELECT 1
        FROM app_private.authorized_scope_v3('buildings.create', buildings.organization_id) s
       WHERE s.org_wide
    )
    -- Vế cũ (hệ staff_assignments) giữ nguyên từng ký tự — xem pg_get_expr
    -- 15/09/2026. Ai đang sống nhờ nó thì vẫn sống.
    OR EXISTS (
      SELECT 1
        FROM public.staff_assignments sa
        LEFT JOIN public.roles r ON r.id = sa.role_id
       WHERE sa.staff_id = auth.uid()
         AND sa.building_id IS NULL
         AND sa.area_id IS NULL
         AND (
              COALESCE(sa.permissions, r.permissions) @> '{"__superadmin": true}'::jsonb
           OR r.name::text = 'Admin'::text
           OR COALESCE(((COALESCE(sa.permissions, r.permissions) -> 'buildings') ->> 'create')::boolean, false) = true
         )
    )
  );

COMMENT ON POLICY buildings_insert_rbac ON public.buildings IS
  'Tao toa: super admin, HOAC quyen buildings.create pham vi toan to chuc theo authorized_scope_v3 (he v3, them 15/09/2026), HOAC staff_assignments toan org theo he cu. Chi nhan org_wide - quyen pham vi mot toa khong phai quyen tao toa moi.';

-- ---------------------------------------------------------------------------
-- (B) Toà mới tự có phạm vi phân quyền.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.sinh_authorization_scope_toa_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $f$
BEGIN
  -- Toà chưa khai tổ chức thì không có tổ chức nào để phân quyền trong. Im
  -- lặng bỏ qua thay vì nổ: cửa INSERT của buildings không bắt buộc cột này,
  -- và làm hỏng việc tạo toà vì một dòng phạm vi là đổi lỗi nhẹ lấy lỗi nặng.
  IF NEW.organization_id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.authorization_scopes (organization_id, scope_type, building_id)
  VALUES (NEW.organization_id, 'BUILDING', NEW.id)
  ON CONFLICT DO NOTHING;

  RETURN NULL;
END;
$f$;

COMMENT ON FUNCTION app_private.sinh_authorization_scope_toa_v1() IS
  'AFTER INSERT tren public.buildings: sinh dong authorization_scopes BUILDING cho toa moi. Khong co dong nay thi toa moi khong hien trong hop thoai Phan quyen va khong gan duoc quyen theo toa. Idempotent nho auth_scope_building_uidx.';

REVOKE ALL ON FUNCTION app_private.sinh_authorization_scope_toa_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.sinh_authorization_scope_toa_v1() FROM anon;
REVOKE ALL ON FUNCTION app_private.sinh_authorization_scope_toa_v1() FROM authenticated;

DROP TRIGGER IF EXISTS z90_sinh_authorization_scope ON public.buildings;
CREATE TRIGGER z90_sinh_authorization_scope
  AFTER INSERT ON public.buildings
  FOR EACH ROW EXECUTE FUNCTION app_private.sinh_authorization_scope_toa_v1();

-- Vá những toà đang sống mà thiếu phạm vi (đo 15/09: 0 — dây an toàn).
INSERT INTO public.authorization_scopes (organization_id, scope_type, building_id)
SELECT b.organization_id, 'BUILDING', b.id
  FROM public.buildings b
 WHERE b.deleted_at IS NULL
   AND b.organization_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.authorization_scopes s
      WHERE s.scope_type = 'BUILDING' AND s.building_id = b.id
   )
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_n int; v_thieu bigint;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_policy
   WHERE polrelid = 'public.buildings'::regclass
     AND polname = 'buildings_insert_rbac'
     AND pg_get_expr(polwithcheck, polrelid) LIKE '%authorized_scope_v3%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'buildings_insert_rbac chua co ve authorized_scope_v3. DUNG.';
  END IF;

  -- Ve cu phai con nguyen: noi cua khong duoc am tham thu hep cua ai dang dung.
  SELECT count(*) INTO v_n
    FROM pg_policy
   WHERE polrelid = 'public.buildings'::regclass
     AND polname = 'buildings_insert_rbac'
     AND pg_get_expr(polwithcheck, polrelid) LIKE '%staff_assignments%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'buildings_insert_rbac mat ve staff_assignments cu. DUNG.';
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND c.relname = 'buildings'
     AND c.relnamespace = 'public'::regnamespace
     AND t.tgname = 'z90_sinh_authorization_scope';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Thieu trigger sinh authorization_scope tren buildings. DUNG.';
  END IF;

  SELECT count(*) INTO v_thieu
    FROM public.buildings b
   WHERE b.deleted_at IS NULL AND b.organization_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.authorization_scopes s
                      WHERE s.scope_type = 'BUILDING' AND s.building_id = b.id);
  IF v_thieu > 0 THEN
    RAISE EXCEPTION 'Con % toa dang song thieu authorization_scope. DUNG.', v_thieu;
  END IF;

  RAISE NOTICE 'OK: cua tao toa nhan he v3, toa moi tu sinh pham vi phan quyen.';
END
$nghiem_thu$;

-- =============================================================================
-- ROLLBACK:
--   DROP POLICY buildings_insert_rbac ON public.buildings; rồi CREATE lại đúng
--   biểu thức cũ (pg_get_expr 15/09/2026 — chính là vế staff_assignments trong
--   file này, bọc với is_super_admin()).
--   DROP TRIGGER z90_sinh_authorization_scope ON public.buildings;
--   DROP FUNCTION app_private.sinh_authorization_scope_toa_v1();
--   Dòng authorization_scopes đã sinh thì GIỮ — xoá chúng là làm toà biến mất
--   khỏi hộp thoại phân quyền, tức là dựng lại đúng lỗi vừa vá.
-- =============================================================================
