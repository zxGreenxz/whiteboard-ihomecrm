-- =============================================================================
-- Quyền lợi nhuận cổ đông: bỏ tính ngoại lệ ĐÃ THU HỒI, và chốt bảng xem trước
-- chốt lợi nhuận (gói 1A của "Chi chia lợi nhuận theo sổ tổng").
--
-- VÌ SAO
--   1. public.authorize_v2 đọc member_permission_overrides mà KHÔNG lọc
--      revoked_at. Màn Thành viên (update_member_authorization_v1) thu hồi rồi
--      chèn lại ngoại lệ mỗi lần lưu, nên một ngoại lệ ALLOW đã bị gỡ vẫn cấp
--      quyền mãi mãi, và một DENY đã gỡ vẫn chặn mãi mãi. Chỉ các hàm chốt lợi
--      nhuận còn gọi hàm này (trực tiếp hoặc qua _profit_assert_authorized_v2 /
--      _profit_can_read_audit_v2), với ba khoá shareholder_profit.view|lock|unlock.
--      Hệ quả đo được (chỉ đọc, 15/11/2026): người đã bị gỡ
--      shareholder_profit.view vẫn gọi thẳng được profit_close_preview_v2 và
--      profit_total_group_peers_v2 của cả công ty.
--   2. profit_close_preview_v2 trả doanh thu, chi phí, lợi nhuận từng toà và
--      phần chia của MỌI cổ đông. Quyền "view" (cổ đông tự xem) không đủ để mở
--      bảng này; nó chỉ dành cho người chốt, mở chốt, chi lợi nhuận hoặc quản lý
--      cổ đông.
--
-- LÀM GÌ
--   A. app_private.profit_viewer_can_v1(org, khoá): kiểm quyền KHÔNG khoá dòng,
--      dựa trên app_private.authorized_scope_v3 (tôn trọng revoked_at,
--      expires_at, vai ACTIVE, emergency deny). Dùng được trong hàm STABLE và
--      trong policy.
--   B. authorize_v2: thêm "AND o.revoked_at IS NULL" vào hai truy vấn ngoại lệ
--      (DENY và ALLOW). Mọi dòng khác giữ nguyên.
--   C. profit_close_preview_v2: thêm một khối kiểm trước; phần còn lại giữ
--      nguyên. Luật hiệu lực sau migration = khối mới VÀ kiểm cũ của
--      _profit_close_preview_core_v2 (view hoặc lock) — fail-closed.
--
-- KHÔNG LÀM: không đụng _profit_close_preview_core_v2, không đổi chữ ký, DEFAULT,
--   search_path, volatility hay ACL của hai hàm bị thay thân.
--
-- GIỚI HẠN ĐÃ BIẾT (ghi để không hiểu nhầm phạm vi):
--   - Khối kiểm trước dùng luật của authorized_scope_v3 (ngoại lệ phải có cạnh
--     phạm vi, vai ACTIVE, binding còn hạn, DENY theo toà/sổ làm mất "toàn công
--     ty"), chặt hơn authorize_v2. Người "chốt được" theo authorize_v2 mà không
--     đạt luật v3 sẽ bị chặn ở bảng xem trước (fail-closed). Đo production
--     15/11/2026: 0 trường hợp.
--   - Migration này chỉ đóng bảng xem trước chốt (phần chia của mọi cổ đông,
--     lương điều hành). Báo cáo lãi lỗ theo toà (fa_monthly_pnl_accrual) vẫn
--     theo quyền xem toà như trước — ngoài phạm vi.
--
-- AN TOÀN CHẠY LẠI: khối ghim md5 chỉ nhận đúng hai thân: thân production đã rà
--   hoặc thân do chính migration này ghi (lượt hai). Thân khác ⇒ dừng 55000,
--   không ghi đè.
-- LÙI: viết một migration forward MỚI chỉ gồm hai CREATE OR REPLACE với thân cũ
--   (authorize_v2: 20260713110300_sprint2d_authorize_v2.sql; preview:
--   supabase/baseline/schema.sql). KHÔNG chạy lại nguyên file 20260713110300 (nó
--   còn thay effective_perms_v2). Lùi authorize_v2 là mở lại lỗ ngoại lệ đã thu
--   hồi. Hàm A để nguyên.
-- =============================================================================

BEGIN;

-- 0. Nền + ghim md5 hai thân sắp thay (md5 của prosrc đã bỏ CR).
DO $truoc$
DECLARE
  v_src text;
BEGIN
  IF to_regprocedure('app_private.authorized_scope_v3(text,uuid)') IS NULL
     OR to_regprocedure('public.is_super_admin()') IS NULL
     OR to_regprocedure('public._profit_close_preview_core_v2(uuid,date,uuid[],jsonb,text,boolean)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu hàm nền (authorized_scope_v3 / is_super_admin / _profit_close_preview_core_v2)'
      USING ERRCODE = '55000';
  END IF;

  SELECT replace(p.prosrc, chr(13), '') INTO v_src
    FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.authorize_v2(text,uuid,text,uuid)');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.authorize_v2(text,uuid,text,uuid)' USING ERRCODE = '55000';
  END IF;
  -- [thân production đã rà, thân của chính migration này (lượt hai)]
  IF md5(v_src) <> ALL (ARRAY['13f230d17ac2139eb41b3843b065e04e', 'f0e0670ea071b367d6195f6c77614496']) THEN
    RAISE EXCEPTION 'authorize_v2 đã đổi so với bản đã rà — chụp lại prosrc rồi rà lại'
      USING ERRCODE = '55000';
  END IF;

  SELECT replace(p.prosrc, chr(13), '') INTO v_src
    FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.profit_close_preview_v2(uuid,date,uuid[],jsonb)');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.profit_close_preview_v2(uuid,date,uuid[],jsonb)' USING ERRCODE = '55000';
  END IF;
  IF md5(v_src) <> ALL (ARRAY['839468e9ce78ca17d32be3133be6dfb2', '7cae35c3ac92fc625cc84d8f999e2ebd']) THEN
    RAISE EXCEPTION 'profit_close_preview_v2 đã đổi so với bản đã rà — chụp lại prosrc rồi rà lại'
      USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- A. Kiểm quyền không khoá dòng cho các lệnh đọc về lợi nhuận cổ đông.
--    Khoá không tồn tại ⇒ authorized_scope_v3 trả rỗng ⇒ false (fail-closed).
CREATE OR REPLACE FUNCTION app_private.profit_viewer_can_v1(
  p_organization_id uuid,
  p_permission_key  text
) RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  IF public.is_super_admin() THEN
    RETURN true;
  END IF;
  IF p_organization_id IS NULL OR p_permission_key IS NULL THEN
    RETURN false;
  END IF;
  RETURN COALESCE(
    (SELECT bool_or(s.org_wide)
       FROM app_private.authorized_scope_v3(p_permission_key, p_organization_id) s),
    false
  );
END
$fn$;

COMMENT ON FUNCTION app_private.profit_viewer_can_v1(uuid, text) IS
  'Người gọi có quyền p_permission_key trên toàn công ty p_organization_id không. Không khoá dòng; tôn trọng ngoại lệ đã thu hồi/hết hạn. Dùng cho RPC đọc STABLE và policy về lợi nhuận cổ đông.';

REVOKE ALL ON FUNCTION app_private.profit_viewer_can_v1(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.profit_viewer_can_v1(uuid, text) TO authenticated;

-- B. authorize_v2: ngoại lệ đã thu hồi không còn hiệu lực (cả DENY lẫn ALLOW).
CREATE OR REPLACE FUNCTION public.authorize_v2(
  p_permission_key text, p_org uuid, p_resource_type text, p_resource_id uuid
) RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE
  v_user uuid := auth.uid();
  v_mem  uuid;
  v_bid  uuid;   -- building resolved
  v_aid  uuid;   -- area resolved
  v_deny boolean;
  v_allow boolean;
BEGIN
  IF v_user IS NULL THEN RETURN false; END IF;
  SELECT id INTO v_mem FROM public.organization_memberships
   WHERE user_id = v_user AND organization_id = p_org AND status='ACTIVE' LIMIT 1;
  IF v_mem IS NULL THEN RETURN false; END IF;

  -- Per-user DENY (unscoped legacy overrides) thắng tuyệt đối.
  SELECT EXISTS(SELECT 1 FROM public.member_permission_overrides o
     WHERE o.membership_id=v_mem AND o.permission_key=p_permission_key AND o.effect='DENY'
       AND o.revoked_at IS NULL
       AND (o.expires_at IS NULL OR o.expires_at>now())) INTO v_deny;
  IF v_deny THEN RETURN false; END IF;

  -- Resolve building/area context của resource.
  IF p_resource_type='BUILDING' THEN v_bid := p_resource_id;
  ELSIF p_resource_type='AREA' THEN v_aid := p_resource_id;
  ELSIF p_resource_type='CASHBOOK' THEN
    -- cashbook scope: match trực tiếp theo cashbook_id.
    NULL;
  END IF;

  -- Per-user ALLOW override (unscoped) cấp quyền ngay.
  SELECT EXISTS(SELECT 1 FROM public.member_permission_overrides o
     WHERE o.membership_id=v_mem AND o.permission_key=p_permission_key AND o.effect='ALLOW'
       AND o.revoked_at IS NULL
       AND (o.expires_at IS NULL OR o.expires_at>now())) INTO v_allow;
  IF v_allow THEN RETURN true; END IF;

  -- Role ALLOW qua binding có scope khớp resource.
  SELECT EXISTS(
    SELECT 1
    FROM public.role_bindings rb
    JOIN public.role_permissions rp
      ON rp.organization_id=p_org AND rp.role_id=rb.role_id
     AND rp.permission_key=p_permission_key AND rp.effect='ALLOW'
    JOIN public.role_binding_scopes rbs
      ON rbs.role_binding_id=rb.id
    JOIN public.authorization_scopes s
      ON s.id=rbs.scope_id AND s.organization_id=p_org
    WHERE rb.membership_id=v_mem AND (rb.valid_to IS NULL OR rb.valid_to>now())
      AND (
        s.scope_type='ORGANIZATION'
        OR (s.scope_type='BUILDING' AND v_bid IS NOT NULL AND s.building_id=v_bid)
        OR (s.scope_type='AREA' AND v_aid IS NOT NULL AND s.area_id=v_aid)
        OR (s.scope_type='AREA' AND v_bid IS NOT NULL
            AND EXISTS(SELECT 1 FROM public.area_buildings ab
                       WHERE ab.area_id=s.area_id AND ab.building_id=v_bid))
        OR (s.scope_type='CASHBOOK' AND p_resource_type='CASHBOOK' AND s.cashbook_id=p_resource_id)
      )
  ) INTO v_allow;
  RETURN v_allow;
END;
$fn$;

REVOKE ALL ON FUNCTION public.authorize_v2(text,uuid,text,uuid) FROM PUBLIC, anon, authenticated;

-- C. Bảng xem trước chốt lợi nhuận: chỉ người chốt, mở chốt, chi lợi nhuận
--    hoặc quản lý cổ đông. KHÔNG có nhánh cho quyền xem % / xem số toà.
CREATE OR REPLACE FUNCTION public.profit_close_preview_v2(p_organization_id uuid, p_period_month date, p_building_ids uuid[] DEFAULT NULL::uuid[], p_adjustments jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_building_ids uuid[] := p_building_ids;
  v_permission text := 'shareholder_profit.view';
  v_preview jsonb;
BEGIN
  IF p_period_month IS NULL
     OR p_period_month <> date_trunc('month', p_period_month)::date THEN
    RAISE EXCEPTION 'period_month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;

  IF NOT public.is_super_admin()
     AND NOT (
       app_private.profit_viewer_can_v1(p_organization_id, 'shareholder_profit.lock')
       OR app_private.profit_viewer_can_v1(p_organization_id, 'shareholder_profit.unlock')
       OR app_private.profit_viewer_can_v1(p_organization_id, 'shareholder_profit.distribute')
       OR app_private.profit_viewer_can_v1(p_organization_id, 'shareholder_profit.manage_shareholders')
     ) THEN
    RAISE EXCEPTION 'Bạn không có quyền xem bảng xem trước chốt lợi nhuận'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_super_admin()
     AND NOT public.authorize_v2(
       'shareholder_profit.view', p_organization_id, 'ORGANIZATION', NULL
     )
     AND public.authorize_v2(
       'shareholder_profit.lock', p_organization_id, 'ORGANIZATION', NULL
     ) THEN
    v_permission := 'shareholder_profit.lock';
  END IF;

  IF v_building_ids IS NULL THEN
    SELECT array_agg(b.id ORDER BY b.id)
    INTO v_building_ids
    FROM public.buildings b
    WHERE b.organization_id = p_organization_id
      AND b.deleted_at IS NULL
      AND b.is_virtual = false;
  END IF;

  v_preview := public._profit_close_preview_core_v2(
    p_organization_id, p_period_month, v_building_ids,
    p_adjustments, v_permission, false
  );
  RETURN public._profit_enrich_unallocated_v3(v_preview, p_adjustments);
END
$$;

REVOKE ALL ON FUNCTION public.profit_close_preview_v2(uuid, date, uuid[], jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.profit_close_preview_v2(uuid, date, uuid[], jsonb) TO authenticated, service_role;

-- Z. Hậu kiểm: đúng thân, đúng ACL.
DO $sau$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.authorize_v2(text,uuid,text,uuid)');
  IF (length(v_src) - length(replace(v_src, 'o.revoked_at IS NULL', ''))) / length('o.revoked_at IS NULL') <> 2 THEN
    RAISE EXCEPTION 'authorize_v2 phải lọc revoked_at ở đúng hai truy vấn ngoại lệ' USING ERRCODE = '55000';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.profit_close_preview_v2(uuid,date,uuid[],jsonb)');
  IF position('app_private.profit_viewer_can_v1' in v_src) = 0
     OR position('view_percent' in v_src) > 0
     OR position('view_building_totals' in v_src) > 0 THEN
    RAISE EXCEPTION 'profit_close_preview_v2 thiếu khối kiểm trước hoặc có nhánh quyền xem không được phép'
      USING ERRCODE = '55000';
  END IF;

  IF has_function_privilege('authenticated', 'public.authorize_v2(text,uuid,text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.authorize_v2(text,uuid,text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.profit_close_preview_v2(uuid,date,uuid[],jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.profit_close_preview_v2(uuid,date,uuid[],jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'app_private.profit_viewer_can_v1(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'app_private.profit_viewer_can_v1(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ACL sau migration không đúng kỳ vọng' USING ERRCODE = '55000';
  END IF;
END
$sau$;

COMMIT;
