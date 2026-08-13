-- =============================================================================
-- Demo: hai QUẢN LÝ đúng vai — quanly (A+B) và quanly2 (C+D)
--
-- SỬA MỘT CHỖ LẪN VAI. 20260812010000 cần hai người quản lý theo toà nhưng chỉ
-- có một tài khoản tên "quản lý", nên nó mượn `demo.kythuat` làm người thứ hai.
-- Sai về mô hình: kỹ thuật là vai đi sửa chữa, không phải vai quản lý toà. Ai đọc
-- dữ liệu demo sau này sẽ hiểu nhầm rằng hệ thống giao toà cho kỹ thuật.
--
-- Nay:
--   demo.quanly   → DEMO Toà A + B   (giữ nguyên, bộ E2E tham chiếu qua
--                                     FLEET_PASS_QUANLY nên KHÔNG đổi tên)
--   demo.quanly2  → DEMO Toà C + D   (tài khoản mới, tạo bằng GoTrue admin)
--   demo.kythuat  → trả về TOÀN CÔNG TY, đúng vai kỹ thuật đi khắp các toà
--
-- Vì sao thêm tài khoản mới thay vì đổi tên demo.kythuat: đổi email của một
-- auth.users đang được tham chiếu là việc rủi ro không tương xứng với cái được,
-- và `demo_user_ids()` lọc theo mẫu email 'demo.%@username.ihomecrm.local' nên
-- tên mới vẫn nằm trong nhóm demo.
--
-- LUẬT CŨ VẪN GIỮ NGUYÊN:
--   · organization_id TƯỜNG MINH trên mọi dòng — _autofill_org không suy được
--     thì gán cứng về công ty THẬT rồi nuốt lỗi.
--   · Không tạo role_binding thứ hai cho cùng (người, vai):
--     role_bindings_one_open_canonical_role_uidx chặn.
--   · Siết phạm vi = XOÁ dòng trỏ scope ORGANIZATION rồi CHÈN dòng BUILDING.
--     Sót một dòng ORGANIZATION là allow_org bật lại và người đó thấy cả 4 toà.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE TEMP TABLE _truoc(bang text, so bigint) ON COMMIT DROP;
DO $chup$
DECLARE r record; v bigint;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id'
                         AND a.attnum>0 AND NOT a.attisdropped
     WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
       AND NOT c.relispartition
       -- BỎ nhóm viễn trắc nền khỏi phép so. Runtime OpenClaw ghi
       -- openclaw_health_events / openclaw_service_nonces LIÊN TỤC, nên số dòng
       -- của chúng đổi trong lúc transaction này chạy mà KHÔNG phải do nó.
       -- Lần chạy đầu chốt này bắn báo động giả đúng vì lý do đó (+1 và +2 dòng).
       -- Giữ chúng trong phép so là dạy người đọc bỏ qua báo động — tệ hơn nhiều
       -- so với việc loại đúng một nhóm mà migration này chứng minh được là
       -- không hề chạm tới (nó không có một câu lệnh nào nhắc openclaw_*).
       AND c.relname NOT LIKE 'openclaw\_%'
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id = %L',
                   r.relname, 'aaaa0000-0000-4000-8000-000000000001') INTO v;
    INSERT INTO _truoc VALUES (r.relname, v);
  END LOOP;
END
$chup$;

DO $dung$
DECLARE
  ORG   constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  E_QL2 constant text := 'demo.quanly2@username.ihomecrm.local';
  U_KT  constant uuid := 'f9296fe1-955a-406c-87d1-e8138ad014a6';  -- demo.kythuat
  v_ql2  uuid;
  v_mem  uuid;
  v_role uuid;
  v_rb   uuid;
  v_org_scope uuid;
  v_c uuid; v_d uuid;
BEGIN
  SELECT u.id INTO v_ql2 FROM auth.users u WHERE u.email = E_QL2;
  IF v_ql2 IS NULL THEN
    RAISE EXCEPTION 'Chưa có tài khoản % — tạo bằng GoTrue admin trước. DỪNG.', E_QL2;
  END IF;

  SELECT id INTO v_c FROM public.buildings WHERE organization_id=ORG AND name='DEMO Toà C';
  SELECT id INTO v_d FROM public.buildings WHERE organization_id=ORG AND name='DEMO Toà D';
  IF v_c IS NULL OR v_d IS NULL THEN
    RAISE EXCEPTION 'Không thấy DEMO Toà C/D. DỪNG.';
  END IF;

  SELECT id INTO v_role FROM public.organization_roles
   WHERE organization_id=ORG AND name='Quản Lý Tòa';
  SELECT id INTO v_org_scope FROM public.authorization_scopes
   WHERE organization_id=ORG AND scope_type='ORGANIZATION' LIMIT 1;

  -- 1. Hồ sơ + thành viên cho quản lý 2.
  INSERT INTO public.profiles (id, organization_id, full_name)
  VALUES (v_ql2, ORG, 'DEMO Quản Lý 2')
  ON CONFLICT (id) DO UPDATE SET organization_id=ORG, full_name='DEMO Quản Lý 2';

  SELECT id INTO v_mem FROM public.organization_memberships
   WHERE organization_id=ORG AND user_id=v_ql2;
  IF v_mem IS NULL THEN
    INSERT INTO public.organization_memberships (organization_id, user_id, member_type, status)
    VALUES (ORG, v_ql2, 'STAFF', 'ACTIVE') RETURNING id INTO v_mem;
  END IF;

  -- 2. Gán vai Quản Lý Tòa + phạm vi ĐÚNG hai toà C, D.
  SELECT id INTO v_rb FROM public.role_bindings
   WHERE organization_id=ORG AND membership_id=v_mem AND role_id=v_role;
  IF v_rb IS NULL THEN
    INSERT INTO public.role_bindings (organization_id, membership_id, role_id)
    VALUES (ORG, v_mem, v_role) RETURNING id INTO v_rb;
  END IF;

  INSERT INTO public.role_binding_scopes (organization_id, role_binding_id, scope_id)
  SELECT ORG, v_rb, s.id
    FROM public.authorization_scopes s
   WHERE s.organization_id=ORG AND s.scope_type='BUILDING'
     AND s.building_id IN (v_c, v_d)
  ON CONFLICT DO NOTHING;

  -- 3. TRẢ demo.kythuat VỀ TOÀN CÔNG TY — kỹ thuật đi khắp các toà.
  DELETE FROM public.role_binding_scopes rbs
   USING public.role_bindings rb, public.organization_memberships m,
         public.authorization_scopes s
   WHERE rbs.role_binding_id = rb.id
     AND rb.membership_id = m.id
     AND m.user_id = U_KT AND m.organization_id = ORG
     AND s.id = rbs.scope_id AND s.scope_type = 'BUILDING';

  INSERT INTO public.role_binding_scopes (organization_id, role_binding_id, scope_id)
  SELECT ORG, rb.id, v_org_scope
    FROM public.role_bindings rb
    JOIN public.organization_memberships m ON m.id = rb.membership_id
   WHERE m.user_id = U_KT AND m.organization_id = ORG
  ON CONFLICT DO NOTHING;
END
$dung$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  ORG constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  r record; v bigint; v_lech text := ''; v_n bigint; v_uid uuid;
BEGIN
  -- Cách ly tổ chức: công ty thật không đổi một dòng nào.
  FOR r IN SELECT bang, so FROM _truoc LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id = %L',
                   r.bang, 'aaaa0000-0000-4000-8000-000000000001') INTO v;
    IF v <> r.so THEN v_lech := v_lech || format('%s(%s→%s) ', r.bang, r.so, v); END IF;
  END LOOP;
  IF v_lech <> '' THEN
    RAISE EXCEPTION 'ĐÃ CHẠM VÀO CÔNG TY THẬT: %', v_lech;
  END IF;

  -- Đúng HAI người bị giới hạn theo toà, và đúng là hai tài khoản quản lý.
  SELECT count(*) INTO v FROM (
    SELECT m.user_id
      FROM public.organization_memberships m
      JOIN public.role_bindings rb ON rb.membership_id = m.id
      JOIN public.role_binding_scopes rbs ON rbs.role_binding_id = rb.id
      JOIN public.authorization_scopes s ON s.id = rbs.scope_id
     WHERE m.organization_id=ORG AND s.scope_type='BUILDING'
     GROUP BY m.user_id) t;
  IF v <> 2 THEN RAISE EXCEPTION 'Có % người bị giới hạn theo toà, cần đúng 2.', v; END IF;

  FOR r IN SELECT * FROM (VALUES
      ('demo.quanly@username.ihomecrm.local',  'DEMO Toà A', 'DEMO Toà B'),
      ('demo.quanly2@username.ihomecrm.local', 'DEMO Toà C', 'DEMO Toà D')) AS t(mail, t1, t2)
  LOOP
    SELECT u.id INTO v_uid FROM auth.users u WHERE u.email = r.mail;

    SELECT count(*) INTO v
      FROM public.role_binding_scopes rbs
      JOIN public.role_bindings rb ON rb.id = rbs.role_binding_id
      JOIN public.organization_memberships m ON m.id = rb.membership_id
      JOIN public.authorization_scopes s ON s.id = rbs.scope_id
      JOIN public.buildings b ON b.id = s.building_id
     WHERE m.user_id=v_uid AND m.organization_id=ORG
       AND s.scope_type='BUILDING' AND b.name IN (r.t1, r.t2);
    IF v <> 2 THEN RAISE EXCEPTION '% không có đúng 2 toà (%, %) — đếm được %.', r.mail, r.t1, r.t2, v; END IF;

    SELECT count(*) INTO v
      FROM public.role_binding_scopes rbs
      JOIN public.role_bindings rb ON rb.id = rbs.role_binding_id
      JOIN public.organization_memberships m ON m.id = rb.membership_id
      JOIN public.authorization_scopes s ON s.id = rbs.scope_id
     WHERE m.user_id=v_uid AND m.organization_id=ORG AND s.scope_type='ORGANIZATION';
    IF v <> 0 THEN RAISE EXCEPTION '% còn % phạm vi TOÀN CÔNG TY — sẽ thấy cả 4 toà.', r.mail, v; END IF;
  END LOOP;

  -- demo.kythuat phải trở lại toàn công ty.
  SELECT u.id INTO v_uid FROM auth.users u WHERE u.email='demo.kythuat@username.ihomecrm.local';
  SELECT count(*) INTO v
    FROM public.role_binding_scopes rbs
    JOIN public.role_bindings rb ON rb.id = rbs.role_binding_id
    JOIN public.organization_memberships m ON m.id = rb.membership_id
    JOIN public.authorization_scopes s ON s.id = rbs.scope_id
   WHERE m.user_id=v_uid AND m.organization_id=ORG AND s.scope_type='ORGANIZATION';
  IF v <> 1 THEN RAISE EXCEPTION 'demo.kythuat chưa trở lại phạm vi toàn công ty (đếm %).', v; END IF;

  -- Soi bằng chính vai quản lý 2.
  CREATE TEMP TABLE _soi(k text, gt bigint) ON COMMIT DROP;
  GRANT INSERT, SELECT ON _soi TO PUBLIC;
  SELECT u.id INTO v_uid FROM auth.users u WHERE u.email='demo.quanly2@username.ihomecrm.local';
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO _soi
  SELECT 'toa',   (SELECT count(*) FROM (SELECT public.accessible_building_ids()) s)
  UNION ALL SELECT 'ngoai', (SELECT count(*) FROM public.buildings WHERE organization_id <> ORG);
  RESET ROLE;

  SELECT gt INTO v_n FROM _soi WHERE k='toa';
  IF v_n <> 2 THEN RAISE EXCEPTION 'quanly2 truy cập được % toà, cần 2.', v_n; END IF;
  SELECT gt INTO v_n FROM _soi WHERE k='ngoai';
  IF v_n <> 0 THEN RAISE EXCEPTION 'quanly2 thấy % toà công ty KHÁC.', v_n; END IF;

  RAISE NOTICE 'Nghiệm thu đạt: đúng 2 quản lý theo toà, kỹ thuật trở lại toàn công ty.';
END
$nghiem_thu$;

COMMIT;
