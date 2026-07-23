-- Finance V2 — Hotfix 7e: sửa guard compat sau khi ON (báo lỗi từ NATHAN 2026-07-23).
--
-- BUG 1: ie_compat_update_pending_v2 / ie_compat_cancel_v2 dùng
-- is_income_expense_flow_owned() — hàm này TRUE cả với phiếu manual tạo qua writer
-- canonical (flow_kind='CANONICAL_INCOME_EXPENSE', 46 row live) ⇒ maker sửa/hủy phiếu
-- Chờ duyệt của CHÍNH MÌNH bị chặn "Phiếu thuộc writer hệ thống". Sửa: chỉ chặn khi
-- ownership row có flow_kind KHÁC canonical-manual (V5/termination/salary…).
--
-- BUG 2 (lỗ V2 §9.2): ie_compat_insert_v2 chỉ check membership ⇒ KNOWER tạo được
-- Phiếu CHI trên sổ mình chỉ "biết". Sửa: account_id NULL → cho (pending chờ phân sổ);
-- có account_id → CUSTODIAN: thu+chi, KNOWER: chỉ thu; không binding → 42501 rõ nghĩa.

BEGIN;

CREATE OR REPLACE FUNCTION app_private.ie_flow_system_owned_v2(p_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM app_private.income_expense_flow_ownership o
    WHERE o.income_expense_id = p_id
      AND o.flow_kind IS DISTINCT FROM 'CANONICAL_INCOME_EXPENSE'
  );
$fn$;
REVOKE ALL ON FUNCTION app_private.ie_flow_system_owned_v2(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Vá guard trong update: thay is_income_expense_flow_owned → ie_flow_system_owned_v2.
-- (re-emit ngắn: chỉ đổi 1 điều kiện, còn lại giữ nguyên qua bản 140000)
DO $patch$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'ie_compat_update_pending_v2';
  v_def := replace(v_def, 'app_private.is_income_expense_flow_owned(p_id)',
                          'app_private.ie_flow_system_owned_v2(p_id)');
  EXECUTE v_def;

  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'ie_compat_cancel_v2';
  v_def := replace(v_def, 'app_private.is_income_expense_flow_owned(v_id)',
                          'app_private.ie_flow_system_owned_v2(v_id)');
  EXECUTE v_def;
END
$patch$;

-- BUG 2: luật possession cho compat insert — thêm check sau resolve actor.
DO $patch2$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'ie_compat_insert_v2';
  v_def := replace(v_def,
$old$  -- Blacklist: client không được set trạng thái duyệt/posting/actor server-owned (§9.3).$old$,
$new$  -- §9.2 possession: có chọn sổ thì phải giữ/biết sổ đó (KNOWER chỉ Phiếu thu).
  IF (p_row->>'account_id') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.cashbook_possession_bindings b
      WHERE b.organization_id = v_org
        AND b.cashbook_id = (p_row->>'account_id')::uuid
        AND b.membership_id = v_actor.membership_id
        AND b.valid_to IS NULL
        AND (b.possession_kind = 'CUSTODIAN'
             OR (b.possession_kind = 'KNOWER' AND COALESCE(p_row->>'type','') = 'INCOME'))
    ) THEN
      RAISE EXCEPTION 'Bạn không phải Người giữ sổ của sổ này (Người biết sổ chỉ tạo Phiếu thu). Chọn sổ khác hoặc để trống sổ.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Blacklist: client không được set trạng thái duyệt/posting/actor server-owned (§9.3).$new$);
  EXECUTE v_def;
END
$patch2$;

COMMIT;

NOTIFY pgrst, 'reload schema';
