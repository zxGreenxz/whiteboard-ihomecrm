-- =============================================================================
-- Sprint 2e — Shareholder/profit-manager → shareholder_profit.view override.
-- (AUTHORIZATION-PLAN.md §11.5) — làm normalized model khớp get_my_permissions.
--
-- get_my_permissions/ai_copilot_perms_for cấp shareholder_profit.view cho
-- shareholder/profit_manager (nhánh cổ đông). Mô hình normalized chưa biết trạng
-- thái cổ đông → shadow-compare lệch đúng key này cho joey/nathan. Thêm override
-- ALLOW để khớp. Idempotent, inert.
-- =============================================================================

BEGIN;

INSERT INTO public.member_permission_overrides (organization_id, membership_id, permission_key, effect, reason, created_by)
SELECT m.organization_id, m.id, 'shareholder_profit.view', 'ALLOW',
       'shareholder/profit_manager grant (mirror get_my_permissions shareholder branch)',
       m.user_id
FROM public.organization_memberships m
WHERE m.status='ACTIVE'
  AND (
    EXISTS (SELECT 1 FROM public.shareholders sh WHERE sh.auth_user_id=m.user_id AND sh.deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM public.profit_managers pm WHERE pm.auth_user_id=m.user_id AND pm.deleted_at IS NULL)
  )
ON CONFLICT (organization_id, membership_id, permission_key) DO UPDATE SET effect='ALLOW';

COMMIT;
