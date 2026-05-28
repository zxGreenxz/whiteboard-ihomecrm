-- Migration: Seed 4 system role templates + migrate existing staff_assignments
--
-- - Tạo 4 template chuẩn: Super Admin / Quản Lý Tòa / Partner / Viewer
-- - Migrate 17 staff_assignments hiện có: role cũ → template tương đương
--   + Admin (1 row, owner) → Super Admin
--   + Manager (16 rows, Joey + Hiệp) → Quản Lý Tòa
-- - Copy role.permissions vào staff_assignments.permissions cho mọi row
--   (snapshot ban đầu = template; sau đó admin có thể tinh chỉnh per staff)
-- - Xóa 5 role hệ thống cũ ở cuối
--
-- Pattern: tạo role mới TRƯỚC, migrate FK, xoá role cũ SAU — tránh FK violation.

DO $$
DECLARE
  v_owner_id    uuid;
  v_super_id    uuid := gen_random_uuid();
  v_manager_id  uuid := gen_random_uuid();
  v_partner_id  uuid := gen_random_uuid();
  v_viewer_id   uuid := gen_random_uuid();

  v_old_admin_id   uuid;
  v_old_manager_id uuid;

  v_super_perms   jsonb;
  v_manager_perms jsonb;
  v_partner_perms jsonb;
  v_viewer_perms  jsonb;
BEGIN
  -- Owner uuid lấy từ super_admins (single org)
  SELECT user_id INTO v_owner_id FROM public.super_admins LIMIT 1;
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy owner trong super_admins — không thể seed templates';
  END IF;

  -- ===== JSONB content cho 4 template =====
  v_super_perms := '{"__superadmin": true}'::jsonb;

  v_manager_perms := jsonb_build_object(
    'dashboard',           jsonb_build_object('view', true),
    'notifications',       jsonb_build_object('view', true),
    'tasks',               jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true, 'approve', true),
    'buildings',           jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true),
    'rooms',               jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true),
    'services',            jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true),
    'service_quotas',      jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true),
    'meters',              jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true),
    'meter_readings',      jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true, 'export', true),
    'leads',               jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true, 'export', true),
    'deposits',            jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true, 'print', true),
    'contracts',           jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true, 'approve', true, 'print', true, 'export', true),
    'customers',           jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true, 'export', true, 'print', true),
    'vehicles',            jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true),
    'cashbooks',           jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true),
    'invoices',            jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true, 'record_payment', true, 'print', true, 'export', true),
    'income_expenses',     jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true, 'approve', true, 'print', true, 'export', true),
    'excess_amounts',      jsonb_build_object('view', true, 'edit', true),
    'assets',              jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true),
    'asset_types',         jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true),
    'warehouses',          jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true),
    'suppliers',           jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true),
    'areas',               jsonb_build_object('view', true),
    'hotline',             jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true),
    'auto_debt',           jsonb_build_object('view', true, 'edit', true),
    'templates',           jsonb_build_object('view', true),
    'task_types',          jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true),
    'categories',          jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true),
    'reports_real_estate', jsonb_build_object('view', true, 'export', true),
    'reports_finance',     jsonb_build_object('view', true, 'export', true)
  );

  v_partner_perms := jsonb_build_object(
    'dashboard',           jsonb_build_object('view', true),
    'notifications',       jsonb_build_object('view', true),
    'buildings',           jsonb_build_object('view', true),
    'rooms',               jsonb_build_object('view', true),
    'leads',               jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true, 'export', true),
    'deposits',            jsonb_build_object('view', true, 'create', true, 'edit', true, 'print', true),
    'contracts',           jsonb_build_object('view', true),
    'customers',           jsonb_build_object('view', true, 'create', true, 'edit', true),
    'vehicles',            jsonb_build_object('view', true),
    'reports_real_estate', jsonb_build_object('view', true)
  );

  v_viewer_perms := jsonb_build_object(
    'dashboard',           jsonb_build_object('view', true),
    'notifications',       jsonb_build_object('view', true),
    'buildings',           jsonb_build_object('view', true),
    'rooms',               jsonb_build_object('view', true),
    'services',            jsonb_build_object('view', true),
    'meters',              jsonb_build_object('view', true),
    'meter_readings',      jsonb_build_object('view', true),
    'leads',               jsonb_build_object('view', true),
    'deposits',            jsonb_build_object('view', true),
    'contracts',           jsonb_build_object('view', true),
    'customers',           jsonb_build_object('view', true),
    'vehicles',            jsonb_build_object('view', true),
    'cashbooks',           jsonb_build_object('view', true),
    'invoices',            jsonb_build_object('view', true),
    'income_expenses',     jsonb_build_object('view', true),
    'assets',              jsonb_build_object('view', true),
    'reports_real_estate', jsonb_build_object('view', true),
    'reports_finance',     jsonb_build_object('view', true)
  );

  -- ===== Bước 1a: rename 5 role hệ thống cũ để tránh va chạm UNIQUE(user_id, name) =====
  UPDATE public.roles SET name = name || '_OLD_20260529' WHERE is_system = true AND name IN ('Admin','Manager','Staff','Accountant','Viewer');

  -- ===== Bước 1b: tạo 4 template mới (uuid generate sẵn) =====
  INSERT INTO public.roles (id, user_id, name, description, is_system, permissions) VALUES
    (v_super_id,   v_owner_id, 'Super Admin',  'Toàn quyền hệ thống — bypass mọi kiểm tra',          true, v_super_perms),
    (v_manager_id, v_owner_id, 'Quản Lý Tòa',  'Quản lý vận hành 1 hoặc nhiều toà — full CRUD + duyệt', true, v_manager_perms),
    (v_partner_id, v_owner_id, 'Partner',      'CTV/đối tác — quản lý khách hẹn + cọc + xem báo cáo BĐS', true, v_partner_perms),
    (v_viewer_id,  v_owner_id, 'Viewer',       'Chỉ xem mọi dữ liệu (read-only)',                     true, v_viewer_perms);

  -- ===== Bước 2: migrate staff_assignments cũ =====
  SELECT id INTO v_old_admin_id   FROM public.roles WHERE name = 'Admin_OLD_20260529'   AND is_system = true LIMIT 1;
  SELECT id INTO v_old_manager_id FROM public.roles WHERE name = 'Manager_OLD_20260529' AND is_system = true LIMIT 1;

  IF v_old_admin_id IS NOT NULL THEN
    UPDATE public.staff_assignments
       SET role_id     = v_super_id,
           permissions = v_super_perms
     WHERE role_id = v_old_admin_id;
  END IF;

  IF v_old_manager_id IS NOT NULL THEN
    UPDATE public.staff_assignments
       SET role_id     = v_manager_id,
           permissions = v_manager_perms
     WHERE role_id = v_old_manager_id;
  END IF;

  -- ===== Bước 3: xoá 5 role hệ thống cũ (Admin/Manager/Staff/Accountant/Viewer cũ) =====
  -- Role 'Viewer' cũ trùng tên — phân biệt qua id (v_viewer_id mới chưa bị xoá vì ON CASCADE chỉ chạy nếu có FK).
  DELETE FROM public.roles
   WHERE is_system = true
     AND id NOT IN (v_super_id, v_manager_id, v_partner_id, v_viewer_id);
END $$;

COMMENT ON TABLE public.roles IS
'Permission templates. Có 4 system templates (is_system=true): Super Admin / Quản Lý Tòa / Partner / Viewer. Khi áp vào staff, permissions được COPY vào staff_assignments.permissions (snapshot độc lập).';
