-- Chốt sổ quỹ: danh sách yêu cầu/biên bản chốt chỉ còn các sổ người gọi được xem tồn quỹ
--
-- Lỗ (xác minh trên source 18/10/2026): public.list_cashbook_closings_v1, bản sống ở
-- 20260730170000_cashbook_closing_ritual.sql:499-556 (chưa có migration nào thay thân), chỉ đòi
-- người gọi là thành viên ACTIVE của công ty. Mọi nhân viên vì thế đọc được tên sổ, số đếm,
-- số hệ thống và CHÊNH LỆCH quỹ của MỌI sổ trong công ty. 20260730210000_plan_hardening_wave3.sql
-- (mục 3) đã ghi đúng lỗ này và dựng app_private.can_see_cashbook_v1, nhưng không hàm nào gọi.
--
-- Sửa (không đổi chữ ký, không đổi kiểu trả về, khoá JSON giữ nguyên):
--   · Một dòng chỉ hiện khi sổ nằm trong app_private.ie_visible_cashbook_ids_v1() — quyền xem
--     TỒN QUỸ chuẩn hiện hành (chủ sổ, người giữ sổ CUSTODIAN/OPERATOR/KNOWER, chủ công ty;
--     20260924012853_chu_cong_ty_doc_moi_so_quy.sql), cùng điều kiện thành viên ACTIVE cũ.
--   · Ngoại lệ hẹp cho đúng hai bên của việc chốt: yêu cầu ĐANG CHỜ vẫn hiện cho người đề
--     nghị và người được chỉ định xác nhận; biên bản đã chốt vẫn hiện cho người đề nghị và
--     người đã xác nhận. Người xác nhận chỉ cần cashbooks.close_confirm, không nhất thiết giữ
--     sổ (propose_cashbook_closing_v1 kiểm authorize_tenant_action_v3), nên thiếu ngoại lệ này
--     hộp "Chờ bạn xác nhận" và trang biên bản của họ sẽ trống — vỡ luồng ký hai bên.
--   · Super admin giữ nguyên.
-- Dùng dạng tập (IN (SELECT …)) như RLS, không gọi hàm trên từng dòng.
--
-- Chạy lại được: CREATE OR REPLACE; chốt đầu nhận thân cũ (lọc bằng organization_memberships)
-- hoặc thân mới (đã có ie_visible_cashbook_ids_v1). Nghiệm thu chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $chot$
DECLARE v_src text; v_secdef boolean;
BEGIN
  SELECT p.prosrc, p.prosecdef INTO v_src, v_secdef
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.list_cashbook_closings_v1(uuid)');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'chot: thieu public.list_cashbook_closings_v1(uuid)';
  END IF;
  IF v_secdef IS NOT TRUE
     OR position('app_private.cashbook_closure_requests' in v_src) = 0
     OR position('app_private.cashbook_closures' in v_src) = 0
     OR position('organization_memberships' in v_src) = 0 THEN
    RAISE EXCEPTION 'chot: list_cashbook_closings_v1 khong con la ban 20260730170000 hoac ban va nay - doc lai ban dang chay truoc khi de';
  END IF;
END
$chot$;

CREATE OR REPLACE FUNCTION public.list_cashbook_closings_v1(p_cashbook uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE v_out jsonb; v_actor uuid := auth.uid(); v_super boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  v_super := COALESCE(public.is_super_admin(), false);

  SELECT jsonb_build_object(
    'pending', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'request_id', r.id, 'cashbook_id', r.cashbook_id, 'cashbook_name', a.name,
        'closed_through', r.closed_through, 'counted_balance', r.counted_balance,
        'system_balance', r.system_balance,
        'difference', r.counted_balance - r.system_balance,
        'note', r.note, 'created_at', r.created_at,
        'proposed_by', r.proposed_by, 'proposed_by_name', pp.full_name,
        'confirmer_user_id', r.confirmer_user_id, 'confirmer_name', cp.full_name,
        'is_mine_to_confirm', (r.confirmer_user_id = v_actor)
      ) ORDER BY r.created_at DESC)
      FROM app_private.cashbook_closure_requests r
      JOIN public.accounts a ON a.id = r.cashbook_id
      LEFT JOIN public.profiles pp ON pp.id = r.proposed_by
      LEFT JOIN public.profiles cp ON cp.id = r.confirmer_user_id
      WHERE r.status = 'PENDING'
        AND (p_cashbook IS NULL OR r.cashbook_id = p_cashbook)
        AND (v_super OR (
          EXISTS (
            SELECT 1 FROM public.organization_memberships m
             WHERE m.user_id = v_actor AND m.organization_id = r.organization_id
               AND m.status = 'ACTIVE')
          AND (r.cashbook_id IN (SELECT v.cashbook_id FROM app_private.ie_visible_cashbook_ids_v1() v)
               OR v_actor IN (r.proposed_by, r.confirmer_user_id))))
    ), '[]'::jsonb),
    'closures', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'closure_id', c.id, 'cashbook_id', c.cashbook_id, 'cashbook_name', a.name,
        'closed_through', c.closed_through, 'counted_balance', c.counted_balance,
        'system_balance', c.system_balance,
        'difference', c.counted_balance - c.system_balance,
        'basis', c.basis, 'confirmed_at', c.confirmed_at,
        'proposed_by_name', pp.full_name, 'confirmed_by_name', cp.full_name
      ) ORDER BY c.closed_through DESC, c.id DESC)
      FROM app_private.cashbook_closures c
      JOIN public.accounts a ON a.id = c.cashbook_id
      LEFT JOIN public.profiles pp ON pp.id = c.proposed_by
      LEFT JOIN public.profiles cp ON cp.id = c.confirmed_by
      WHERE (p_cashbook IS NULL OR c.cashbook_id = p_cashbook)
        AND (v_super OR (
          EXISTS (
            SELECT 1 FROM public.organization_memberships m
             WHERE m.user_id = v_actor AND m.organization_id = c.organization_id
               AND m.status = 'ACTIVE')
          AND (c.cashbook_id IN (SELECT v.cashbook_id FROM app_private.ie_visible_cashbook_ids_v1() v)
               OR v_actor IN (c.proposed_by, c.confirmed_by))))
    ), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END
$fn$;

REVOKE ALL ON FUNCTION public.list_cashbook_closings_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_cashbook_closings_v1(uuid) TO authenticated;

DO $nghiem_thu$
DECLARE v_fn regprocedure := to_regprocedure('public.list_cashbook_closings_v1(uuid)');
  v_src text; v_secdef boolean; v_volatile "char"; v_config text[];
BEGIN
  SELECT p.prosrc, p.prosecdef, p.provolatile, p.proconfig INTO v_src, v_secdef, v_volatile, v_config
    FROM pg_proc p WHERE p.oid = v_fn;
  IF v_secdef IS NOT TRUE OR v_volatile <> 's'
     OR v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, app_private, public']::text[] THEN
    RAISE EXCEPTION 'nghiem_thu: list_cashbook_closings_v1 sai definer/volatility/search_path (%, %, %)',
      v_secdef, v_volatile, v_config;
  END IF;
  -- Hai nhánh (đang chờ, đã chốt) đều phải lọc theo phạm vi xem tồn quỹ.
  IF (length(v_src) - length(replace(v_src, 'ie_visible_cashbook_ids_v1()', ''))) / length('ie_visible_cashbook_ids_v1()') <> 2
     OR position('v_actor IN (r.proposed_by, r.confirmer_user_id)' in v_src) = 0
     OR position('v_actor IN (c.proposed_by, c.confirmed_by)' in v_src) = 0
     OR position('auth.uid()' in v_src) = 0 THEN
    RAISE EXCEPTION 'nghiem_thu: list_cashbook_closings_v1 thieu loc theo so nguoi goi nhin thay';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'nghiem_thu: ACL list_cashbook_closings_v1 phai chi authenticated';
  END IF;
END
$nghiem_thu$;

COMMIT;
NOTIFY pgrst, 'reload schema';
