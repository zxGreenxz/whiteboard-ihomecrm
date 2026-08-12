-- =============================================================================
-- Dựng lại công ty DEMO — như một công ty THẬT, chỉ khác ở chỗ dữ liệu là để test
--
-- Tổ chức Demo bị xoá ở 20260808080000 (165.548 dòng, cùng tổ chức Test). Nay
-- dựng lại để bộ E2E và việc thử tính năng có chỗ chạy mà không đụng sổ thật.
--
-- ------------------------ VÌ SAO ĐÚNG UUID CŨ -------------------------------
-- dddd0000-0000-4000-8000-000000000001 KHÔNG phải chọn cho đẹp: hàng chục spec
-- trong .e2e-fleet/specs/ hard-code đúng chuỗi đó (accounting-admin.ts:3,
-- business-performance.spec.ts:73, commission-voucher-per-section.spec.ts:33,
-- contract-create-linked-deposit.spec.ts:36, network-center.spec.ts:253…).
-- Dựng bằng UUID mới là làm chết cả bộ E2E trong im lặng.
--
-- --------------------- KHÁC HẲN CƠ CHẾ DEMO CŨ ------------------------------
-- Bản cũ dựa vào sandbox_org_ids() và demo_user_ids() để GIẤU tổ chức này khỏi
-- super admin — vì hồi đó tài khoản super admin cũng chính là tài khoản chủ, nên
-- không giấu thì báo cáo bị cộng gộp.
--
-- Nay KHÔNG cần cơ chế giấu nào, vì chủ công ty đã có tài khoản riêng
-- (20260811030000): sổ sách xem bằng tài khoản chủ thì sạch theo đúng biên giới,
-- không phụ thuộc vào việc có che hay không. Tài khoản hệ thống vẫn thấy cả hai
-- công ty — đó là bản chất của tài khoản hệ thống, không phải lỗi.
--
-- Nên Demo ở đây là một công ty BÌNH THƯỜNG: có chủ riêng, nhân viên riêng, vai
-- riêng, biên giới riêng. Cách ly do 304 policy biên giới lo, giống mọi công ty.
--
-- ------------------------------ SEED GÌ -------------------------------------
-- Đủ để bộ E2E chạy được, không hơn. Preflight của accounting-admin.ts đòi:
-- toà nhà chưa xoá · phòng còn trống · sổ quỹ nhận tiền · dịch vụ cố định có
-- đơn giá > 0 gắn vào toà nhà. Hợp đồng/hoá đơn thì các spec tự dựng fixture và
-- tự dọn, nên KHÔNG seed sẵn — seed thừa chỉ làm số liệu test khó đọc.
--
-- Tài khoản demo.* vẫn còn nguyên trong auth.users (lần xoá tổ chức không đụng
-- tới auth). Ở đây chỉ gắn lại membership + profile + vai.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

DO $dung$
DECLARE
  ORG      constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  ORG_THAT constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  v_chunha   uuid;
  v_scope    uuid;
  v_role_chu uuid;
  v_role_nv  uuid;
  v_mem      uuid;
  v_rb       uuid;
  v_b1       uuid;
  v_b2       uuid;
  v_acc      uuid;
  v_sv_dien  uuid;
  v_sv_nuoc  uuid;
  v_sv_rac   uuid;
  r          record;
  v_n        int;
BEGIN
  -- ---------------------------------------------------------------- guard --
  IF EXISTS (SELECT 1 FROM public.organizations WHERE id = ORG) THEN
    RAISE EXCEPTION 'Tổ chức Demo đã tồn tại — file này chỉ để DỰNG LẠI từ đầu. DỪNG.';
  END IF;

  SELECT id INTO v_chunha FROM auth.users WHERE email = 'demo.chunha@username.ihomecrm.local';
  IF v_chunha IS NULL THEN
    RAISE EXCEPTION 'Không còn tài khoản demo.chunha trong auth.users — không dựng được chủ cho Demo. DỪNG.';
  END IF;

  -- ------------------------------------------------------------ tổ chức ---
  INSERT INTO public.organizations (id, slug, name, status)
  VALUES (ORG, 'ihome-demo', 'iHome CRM (Demo)', 'ACTIVE');

  -- Phạm vi "toàn công ty" — vai chủ bám vào đây, giống công ty thật.
  INSERT INTO public.authorization_scopes (organization_id, scope_type)
  VALUES (ORG, 'ORGANIZATION') RETURNING id INTO v_scope;

  -- --------------------------------------------------- thành viên + hồ sơ --
  -- 6 tài khoản demo.* còn nguyên trong auth.users; chỉ gắn lại membership và
  -- profile (profile của chúng đã bị dọn ở 20260808090000 vì lúc đó chúng mang
  -- nhãn công ty THẬT mà không có membership nào — người ma trong danh sách
  -- nhân sự).
  FOR r IN
    SELECT u.id, u.email,
           CASE WHEN u.email LIKE 'demo.chunha@%' THEN 'OWNER'
                WHEN u.email LIKE 'demo.codong@%' THEN 'PARTNER'
                ELSE 'STAFF' END AS loai,
           CASE WHEN u.email LIKE 'demo.chunha@%'  THEN 'DEMO Chủ Nhà'
                WHEN u.email LIKE 'demo.ketoan@%'  THEN 'DEMO Kế Toán'
                WHEN u.email LIKE 'demo.quanly@%'  THEN 'DEMO Quản Lý'
                WHEN u.email LIKE 'demo.kythuat@%' THEN 'DEMO Kỹ Thuật'
                WHEN u.email LIKE 'demo.sale@%'    THEN 'DEMO Sale'
                WHEN u.email LIKE 'demo.codong@%'  THEN 'DEMO Cổ Đông'
                ELSE 'DEMO' END AS ten
      FROM auth.users u
     WHERE u.email LIKE 'demo.%@username.ihomecrm.local'
     ORDER BY u.email
  LOOP
    INSERT INTO public.organization_memberships (organization_id, user_id, member_type, status)
    VALUES (ORG, r.id, r.loai, 'ACTIVE')
    ON CONFLICT DO NOTHING;

    INSERT INTO public.profiles (id, organization_id, full_name)
    VALUES (r.id, ORG, r.ten)
    ON CONFLICT (id) DO UPDATE SET organization_id = ORG, full_name = EXCLUDED.full_name;
  END LOOP;

  -- ------------------------------------------------------------- vai trò --
  -- Chủ công ty Demo: đủ 231 quyền TENANT, phạm vi toàn công ty — cùng khuôn
  -- với công ty thật ở 20260811030000.
  INSERT INTO public.organization_roles (organization_id, name, is_system, version, status)
  VALUES (ORG, 'Chủ công ty', false, 1, 'ACTIVE') RETURNING id INTO v_role_chu;

  INSERT INTO public.role_permissions (organization_id, role_id, permission_key, effect)
  SELECT ORG, v_role_chu, pd.key, 'ALLOW'
    FROM public.permission_definitions pd
   WHERE pd.permission_domain = 'TENANT' AND pd.is_active;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'Vai "Chủ công ty" (Demo): % quyền.', v_n;

  -- Vai nhân viên: chép ĐÚNG tập quyền của "Quản Lý Tòa" bên công ty thật, để
  -- kịch bản test phân quyền phản ánh đúng thứ đang chạy thật.
  INSERT INTO public.organization_roles (organization_id, name, is_system, version, status)
  VALUES (ORG, 'Quản Lý Tòa', false, 1, 'ACTIVE') RETURNING id INTO v_role_nv;

  INSERT INTO public.role_permissions (organization_id, role_id, permission_key, effect)
  SELECT ORG, v_role_nv, rp.permission_key, rp.effect
    FROM public.role_permissions rp
    JOIN public.organization_roles r0 ON r0.id = rp.role_id
   WHERE r0.organization_id = ORG_THAT AND r0.name = 'Quản Lý Tòa';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'Vai "Quản Lý Tòa" (Demo): % quyền chép từ công ty thật.', v_n;

  -- Gán vai + phạm vi cho từng thành viên.
  FOR r IN
    SELECT m.id AS mem_id, u.email
      FROM public.organization_memberships m
      JOIN auth.users u ON u.id = m.user_id
     WHERE m.organization_id = ORG
  LOOP
    INSERT INTO public.role_bindings (organization_id, membership_id, role_id)
    VALUES (ORG, r.mem_id,
            CASE WHEN r.email LIKE 'demo.chunha@%' THEN v_role_chu ELSE v_role_nv END)
    RETURNING id INTO v_rb;
    INSERT INTO public.role_binding_scopes (organization_id, role_binding_id, scope_id)
    VALUES (ORG, v_rb, v_scope);
  END LOOP;

  -- ------------------------------------------------------ dữ liệu để test --
  -- Hai toà nhà, đúng quy mô bản Demo cũ.
  INSERT INTO public.buildings (organization_id, user_id, name, province, district, ward)
  VALUES (ORG, v_chunha, 'DEMO Toà A', 'TP Hồ Chí Minh', 'Quận 1', 'Phường Bến Nghé')
  RETURNING id INTO v_b1;
  INSERT INTO public.buildings (organization_id, user_id, name, province, district, ward)
  VALUES (ORG, v_chunha, 'DEMO Toà B', 'TP Hồ Chí Minh', 'Quận 3', 'Phường Võ Thị Sáu')
  RETURNING id INTO v_b2;

  INSERT INTO public.floors (organization_id, building_id, floor_number, user_id)
  SELECT ORG, b.id, g.n, v_chunha
    FROM (VALUES (v_b1), (v_b2)) AS b(id), generate_series(1, 2) AS g(n);

  -- 4 phòng mỗi toà. rent_price/deposit_amount là NOT NULL nên phải khai.
  INSERT INTO public.rooms (organization_id, building_id, name, rent_price, deposit_amount)
  SELECT ORG, b.id, b.tien || '-' || lpad(g.n::text, 2, '0'), 4000000, 4000000
    FROM (VALUES (v_b1, 'A'), (v_b2, 'B')) AS b(id, tien), generate_series(1, 4) AS g(n);

  -- Dịch vụ cố định CÓ ĐƠN GIÁ — preflight của E2E đòi unit_price > 0.
  INSERT INTO public.services (organization_id, user_id, name, type, unit_price)
  VALUES (ORG, v_chunha, 'DEMO Điện', 'FIXED', 3500) RETURNING id INTO v_sv_dien;
  INSERT INTO public.services (organization_id, user_id, name, type, unit_price)
  VALUES (ORG, v_chunha, 'DEMO Nước', 'FIXED', 100000) RETURNING id INTO v_sv_nuoc;
  INSERT INTO public.services (organization_id, user_id, name, type, unit_price)
  VALUES (ORG, v_chunha, 'DEMO Rác', 'FIXED', 50000) RETURNING id INTO v_sv_rac;

  INSERT INTO public.building_services (organization_id, building_id, service_id, is_active)
  SELECT ORG, b.id, s.id, true
    FROM (VALUES (v_b1), (v_b2)) AS b(id),
         (VALUES (v_sv_dien), (v_sv_nuoc), (v_sv_rac)) AS s(id);

  -- Sổ quỹ nhận tiền.
  INSERT INTO public.accounts (organization_id, user_id, name, code)
  VALUES (ORG, v_chunha, 'DEMO Quỹ tiền mặt', 'DEMO-CASH') RETURNING id INTO v_acc;

  RAISE NOTICE 'Đã dựng công ty Demo: 2 toà, 8 phòng, 3 dịch vụ, 1 sổ quỹ.';
END
$dung$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — soi bằng CHÍNH vai chủ Demo, và kiểm CẢ HAI CHIỀU cách ly.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  ORG      constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  ORG_THAT constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  v_chunha uuid;
  v_chu_that uuid;
BEGIN
  SELECT id INTO v_chunha   FROM auth.users WHERE email = 'demo.chunha@username.ihomecrm.local';
  SELECT id INTO v_chu_that FROM auth.users WHERE email = 'nguyentam@username.ihomecrm.local';

  CREATE TEMP TABLE _nt(k text, v bigint) ON COMMIT DROP;
  GRANT INSERT, SELECT ON _nt TO PUBLIC;

  -- CHIỀU 1 — chủ Demo thấy đủ công ty MÌNH, và KHÔNG thấy gì của công ty thật.
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_chunha::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO _nt
  SELECT 'demo_toa',   (SELECT count(*) FROM public.buildings)
  UNION ALL SELECT 'demo_phong', (SELECT count(*) FROM public.rooms)
  UNION ALL SELECT 'demo_ngoai', (SELECT count(*) FROM public.buildings WHERE organization_id <> ORG)
  UNION ALL SELECT 'demo_sup',   (SELECT public.is_super_admin())::int
  UNION ALL SELECT 'demo_scope', (SELECT count(*) FROM (SELECT public.accessible_building_ids()) s);
  RESET ROLE;

  -- CHIỀU 2 — chủ công ty THẬT không thấy gì của Demo.
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_chu_that::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO _nt
  SELECT 'that_thay_demo', (SELECT count(*) FROM public.buildings WHERE organization_id = ORG)
  UNION ALL SELECT 'that_toa', (SELECT count(*) FROM public.buildings);
  RESET ROLE;

  IF (SELECT v FROM _nt WHERE k = 'demo_sup') <> 0 THEN
    RAISE EXCEPTION 'Chủ Demo lại là super admin. DỪNG.';
  END IF;
  IF (SELECT v FROM _nt WHERE k = 'demo_toa') <> 2 THEN
    RAISE EXCEPTION 'Chủ Demo thấy % toà (cần 2) — vai chưa ăn.', (SELECT v FROM _nt WHERE k='demo_toa');
  END IF;
  IF (SELECT v FROM _nt WHERE k = 'demo_phong') <> 8 THEN
    RAISE EXCEPTION 'Chủ Demo thấy % phòng (cần 8).', (SELECT v FROM _nt WHERE k='demo_phong');
  END IF;
  IF (SELECT v FROM _nt WHERE k = 'demo_scope') <> 2 THEN
    RAISE EXCEPTION 'Phạm vi toà nhà của chủ Demo là % (cần 2).', (SELECT v FROM _nt WHERE k='demo_scope');
  END IF;
  IF (SELECT v FROM _nt WHERE k = 'demo_ngoai') <> 0 THEN
    RAISE EXCEPTION 'Chủ Demo thấy % toà của công ty KHÁC — cách ly hỏng. DỪNG.',
      (SELECT v FROM _nt WHERE k='demo_ngoai');
  END IF;
  IF (SELECT v FROM _nt WHERE k = 'that_thay_demo') <> 0 THEN
    RAISE EXCEPTION 'Chủ công ty THẬT thấy % toà của Demo — cách ly hỏng chiều ngược. DỪNG.',
      (SELECT v FROM _nt WHERE k='that_thay_demo');
  END IF;
  IF (SELECT v FROM _nt WHERE k = 'that_toa') <> 18 THEN
    RAISE EXCEPTION 'Chủ công ty thật nay thấy % toà (trước là 18) — Demo đã ảnh hưởng tới sổ thật. DỪNG.',
      (SELECT v FROM _nt WHERE k='that_toa');
  END IF;

  RAISE NOTICE 'Nghiệm thu đạt: Demo tách rời hai chiều, chủ thật vẫn thấy đúng 18 toà.';
END
$nghiem_thu$;

COMMIT;

-- =============================================================================
-- SAU KHI CHẠY: mật khẩu 3 tài khoản fleet nằm ở CLAUDE.local.md (FLEET_PASS_*).
-- Nếu chúng không còn đúng thì đặt lại qua GoTrue admin — lần xoá tổ chức không
-- đụng auth.users nên tài khoản và mật khẩu vẫn như cũ.
--
-- ROLLBACK: xoá theo thứ tự ngược — role_binding_scopes, role_bindings,
-- role_permissions, organization_roles, dữ liệu nghiệp vụ của org, memberships,
-- profiles, authorization_scopes, rồi organizations. Hoặc dùng chính
-- scripts/org-split-prepared/03-dien-tap-xoa-hai-org.sql (đổi danh sách org).
-- =============================================================================
