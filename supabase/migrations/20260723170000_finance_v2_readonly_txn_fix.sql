-- Finance V2 — Hotfix 7f: read-only-transaction fix (báo lỗi NG TÂM 2026-07-23).
--
-- PostgREST chạy RPC STABLE trong transaction READ ONLY. Các RPC v2 khai STABLE nhưng
-- gọi app_private.authorize_tenant_action_v3 (VOLATILE, SELECT ... FOR SHARE) hoặc
-- app_private.evaluate_feature_route (VOLATILE) ⇒ "cannot execute SELECT FOR SHARE in a
-- read-only transaction" ⇒ get_finance_v2_client_flags_v1 fail ⇒ TOÀN BỘ UI route-aware
-- rơi về LEGACY (mất khu cài CUSTODIAN/KNOWER, approve flow cũ).
--
-- Sửa gốc:
--   1) finance_v2_route_pure_v1: resolver route THUẦN ĐỌC (đúng semantics evaluate:
--      force_freeze→FROZEN; ON→CANONICAL; CANARY→CANONICAL nếu org enrolled + trong
--      cửa sổ, ngược lại LEGACY; SHADOW→SHADOW; OFF/không có→LEGACY).
--   2) get_finance_v2_client_flags_v1 + finance_v2_can_read_posting_v1 (dùng trong RLS
--      SELECT — cũng chạy read-only) chuyển sang resolver thuần.
--   3) Các RPC thật sự cần authorize (FOR SHARE) đổi VOLATILE để PostgREST cấp
--      transaction ghi: get_cashbook_access_admin_v2, list_finance_execution_queue_v2.

BEGIN;

CREATE OR REPLACE FUNCTION app_private.finance_v2_route_pure_v1(p_key text, p_org uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $fn$
  SELECT CASE
    WHEN f.feature_key IS NULL THEN 'LEGACY'
    WHEN f.force_freeze THEN 'FROZEN'
    WHEN f.mode = 'ON' THEN 'CANONICAL'
    WHEN f.mode = 'CANARY' THEN
      CASE WHEN EXISTS (
             SELECT 1 FROM app_private.server_feature_flag_canary_orgs c
             WHERE c.feature_key = f.feature_key AND c.organization_id = p_org)
           AND (f.starts_at IS NULL OR now() >= f.starts_at)
           AND (f.ends_at IS NULL OR now() < f.ends_at)
      THEN 'CANONICAL' ELSE 'LEGACY' END
    WHEN f.mode = 'SHADOW' THEN 'SHADOW'
    ELSE 'LEGACY'
  END
  FROM (SELECT * FROM app_private.server_feature_flags WHERE feature_key = p_key) f
  RIGHT JOIN (SELECT 1) one ON true;
$fn$;
REVOKE ALL ON FUNCTION app_private.finance_v2_route_pure_v1(text, uuid) FROM PUBLIC;
DO $g$ BEGIN
  IF to_regrole('anon') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON FUNCTION app_private.finance_v2_route_pure_v1(text, uuid) FROM anon'; END IF;
  IF to_regrole('service_role') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON FUNCTION app_private.finance_v2_route_pure_v1(text, uuid) FROM service_role'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'GRANT EXECUTE ON FUNCTION app_private.finance_v2_route_pure_v1(text, uuid) TO authenticated'; END IF;
END $g$;

CREATE OR REPLACE FUNCTION public.get_finance_v2_client_flags_v1()
RETURNS TABLE (
  organization_id uuid,
  read_semantics_route text,
  workflow_route text,
  posting_route text,
  access_route text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
  SELECT m.organization_id,
         app_private.finance_v2_route_pure_v1('income_expense.read_semantics.v2', m.organization_id),
         app_private.finance_v2_route_pure_v1('income_expense.workflow.v2', m.organization_id),
         app_private.finance_v2_route_pure_v1('income_expense.posting.v2', m.organization_id),
         app_private.finance_v2_route_pure_v1('cashbook.access.v2', m.organization_id)
  FROM public.organization_memberships m
  WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE';
$fn$;

CREATE OR REPLACE FUNCTION app_private.finance_v2_can_read_posting_v1(
  p_organization_id uuid,
  p_account_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
  SELECT app_private.finance_v2_route_pure_v1('income_expense.read_semantics.v2', p_organization_id)
           IN ('CANONICAL', 'FROZEN')
     AND EXISTS (
       SELECT 1
       FROM public.cashbook_possession_bindings b
       JOIN public.organization_memberships m ON m.id = b.membership_id
       WHERE b.organization_id = p_organization_id
         AND b.cashbook_id = p_account_id
         AND b.possession_kind = 'CUSTODIAN'
         AND b.valid_to IS NULL
         AND m.user_id = auth.uid()
         AND m.status = 'ACTIVE'
     );
$fn$;

-- Các RPC gọi authorize (FOR SHARE) phải chạy trong transaction ghi.
ALTER FUNCTION public.get_cashbook_access_admin_v2(uuid) VOLATILE;
ALTER FUNCTION public.list_finance_execution_queue_v2() VOLATILE;

COMMIT;

NOTIFY pgrst, 'reload schema';
