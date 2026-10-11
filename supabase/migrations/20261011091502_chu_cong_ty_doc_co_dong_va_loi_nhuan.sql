-- =============================================================================
-- Chủ công ty ĐỌC cổ đông / lợi nhuận phân bổ / quản lý lợi nhuận của công ty mình
-- (kiểm toàn bộ 11/10/2026: K11-09 = S1-F11 = C-05; Q17 chủ chốt "Có")
--
-- VẤN ĐỀ (production, chỉ đọc 11/10/2026)
--   Tám bảng dưới chỉ có policy PERMISSIVE theo auth.uid() = user_id (người tạo cấu
--   hình), is_admin()/is_super_admin() hoặc chính cổ đông/quản lý. Tài khoản "Chủ công
--   ty" (không phải super admin, không phải người tạo dòng) đọc REST được 0 dòng ⇒
--   Báo cáo Lợi nhuận tab Tổng quan hiện toàn 0 + "Chưa có cổ đông" một cách im lặng
--   (TEST: super admin thấy 31 profit_monthly / 6 shareholders / 27 building_shareholders
--   / 2 profit_managers, chủ công ty 0). Production: 0 dòng organization_id NULL ở cả
--   tám bảng ⇒ nhánh theo org phủ đủ dữ liệu hiện có; dòng mới đã có org nhờ trigger
--   điền org (20261011042329).
--
-- SỬA: theo đúng mẫu 20260927081925 mục 8 (bảng lương) — MỘT policy PERMISSIVE
--   FOR SELECT TO authenticated mỗi bảng:
--     USING (organization_id IN (SELECT app_private.my_company_owner_org_ids_v1()))
--   CHỈ ĐỌC (bất biến chuCongTyDocSoQuyMigration.test: không policy ghi nào dựa vào
--   helper); ghi vẫn theo policy cũ / RPC có cổng. RESTRICTIVE *_org_boundary,
--   *_hide_sandbox_admin, *_hide_demo_admin giữ nguyên.
--
-- IDEMPOTENT: DROP POLICY IF EXISTS rồi CREATE. Không ghi dữ liệu.
-- Đường lùi: DROP POLICY <bảng>_company_owner_select ON public.<bảng> (8 bảng).
-- =============================================================================

DO $chu_cong_ty$
DECLARE
  t text;
BEGIN
  IF to_regprocedure('app_private.my_company_owner_org_ids_v1()') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.my_company_owner_org_ids_v1' USING ERRCODE = '55000';
  END IF;
  FOREACH t IN ARRAY ARRAY['shareholders','building_shareholders','profit_monthly','profit_allocations',
                           'profit_managers','profit_manager_allocations','profit_manager_salaries',
                           'profit_manager_salary_buildings'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_company_owner_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR SELECT TO authenticated '
      'USING (organization_id IN (SELECT app_private.my_company_owner_org_ids_v1()))',
      t || '_company_owner_select', t);
  END LOOP;
END
$chu_cong_ty$;

-- Nghiệm thu (chỉ đọc catalog): đủ 8 policy, PERMISSIVE, chỉ SELECT, chỉ authenticated,
-- dùng helper; bảng vẫn bật RLS và còn ranh giới org RESTRICTIVE.
DO $nghiem_thu$
DECLARE
  t text;
  p record;
  v_bad text[] := '{}';
BEGIN
  FOREACH t IN ARRAY ARRAY['shareholders','building_shareholders','profit_monthly','profit_allocations',
                           'profit_managers','profit_manager_allocations','profit_manager_salaries',
                           'profit_manager_salary_buildings'] LOOP
    SELECT pol.polpermissive, pol.polcmd, pol.polroles, pg_get_expr(pol.polqual, pol.polrelid) AS q
      INTO p
      FROM pg_policy pol
     WHERE pol.polrelid = format('public.%I', t)::regclass AND pol.polname = t || '_company_owner_select';
    IF NOT FOUND THEN
      v_bad := v_bad || format('%s: thiếu policy', t);
    ELSIF NOT p.polpermissive OR p.polcmd <> 'r' OR p.polroles <> ARRAY['authenticated'::regrole::oid]
          OR position('my_company_owner_org_ids_v1' IN p.q) = 0 THEN
      v_bad := v_bad || format('%s: policy sai dạng (PERMISSIVE SELECT authenticated + helper)', t);
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = format('public.%I', t)::regclass) THEN
      v_bad := v_bad || format('%s: RLS tắt', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy pol WHERE pol.polrelid = format('public.%I', t)::regclass
                    AND pol.polname = t || '_org_boundary' AND NOT pol.polpermissive) THEN
      v_bad := v_bad || format('%s: mất ranh giới org RESTRICTIVE', t);
    END IF;
  END LOOP;
  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'Nghiệm thu Q17/K11-09 KHÔNG ĐẠT: %', array_to_string(v_bad, '; ');
  END IF;
END
$nghiem_thu$;
