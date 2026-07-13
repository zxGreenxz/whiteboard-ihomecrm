-- =============================================================================
-- Sprint 2c — Materialize normalized RBAC từ roles + staff_assignments (ADDITIVE).
-- (AUTHORIZATION-PLAN.md §16.4)
--
-- • organization_roles: mỗi roles row → org_role trong org của owner (id REUSE
--   roles.id để map trivial). role_permissions: từ roles.permissions JSONB.
-- • role_bindings: mỗi staff_assignment → binding (id REUSE sa.id) nối membership
--   ↔ org_role. authorization_scopes + role_binding_scopes: theo building/area/full.
-- • member_permission_overrides: diff sa.permissions vs role template (legacy
--   per-staff perms là org-wide nhất quán → override unscoped).
--
-- Idempotent (ON CONFLICT DO NOTHING). Inert (không đọc/enforce).
-- =============================================================================

BEGIN;

-- 1) organization_roles (id = roles.id) — role owner map qua legacy_owner_organization_map.
INSERT INTO public.organization_roles (id, organization_id, name, legacy_role_id, is_system)
SELECT r.id, lom.organization_id, r.name, r.id, false
FROM public.roles r
JOIN public.legacy_owner_organization_map lom ON lom.legacy_owner_id = r.user_id
ON CONFLICT (id) DO NOTHING;

-- 2) role_permissions từ roles.permissions JSONB ({module:{action:true}}).
INSERT INTO public.role_permissions (organization_id, role_id, permission_key, effect)
SELECT orl.organization_id, orl.id, pd.key, 'ALLOW'
FROM public.organization_roles orl
JOIN public.roles r ON r.id = orl.legacy_role_id
JOIN public.permission_definitions pd
  ON (r.permissions -> pd.resource ->> pd.action) = 'true'
ON CONFLICT DO NOTHING;

-- 3) Canonical scopes: ORGANIZATION/BUILDING/AREA (partial-unique tự dedup).
INSERT INTO public.authorization_scopes (organization_id, scope_type)
SELECT id, 'ORGANIZATION' FROM public.organizations
ON CONFLICT DO NOTHING;
INSERT INTO public.authorization_scopes (organization_id, scope_type, building_id)
SELECT b.organization_id, 'BUILDING', b.id FROM public.buildings b WHERE b.organization_id IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO public.authorization_scopes (organization_id, scope_type, area_id)
SELECT a.organization_id, 'AREA', a.id FROM public.areas a WHERE a.organization_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- 4) role_bindings (id = sa.id) nối membership của staff ↔ org_role cùng org.
INSERT INTO public.role_bindings (id, organization_id, membership_id, role_id, legacy_assignment_id)
SELECT sa.id, m.organization_id, m.id, sa.role_id, sa.id
FROM public.staff_assignments sa
JOIN public.organization_memberships m
  ON m.user_id = sa.staff_id AND m.status = 'ACTIVE'
JOIN public.organization_roles orl
  ON orl.id = sa.role_id AND orl.organization_id = m.organization_id
ON CONFLICT (id) DO NOTHING;

-- 5) role_binding_scopes: nối binding ↔ scope theo building/area/full của assignment.
INSERT INTO public.role_binding_scopes (organization_id, role_binding_id, scope_id)
SELECT rb.organization_id, rb.id, s.id
FROM public.role_bindings rb
JOIN public.staff_assignments sa ON sa.id = rb.legacy_assignment_id
JOIN public.authorization_scopes s ON s.organization_id = rb.organization_id AND (
     (sa.building_id IS NOT NULL AND s.scope_type='BUILDING' AND s.building_id = sa.building_id)
  OR (sa.building_id IS NULL AND sa.area_id IS NOT NULL AND s.scope_type='AREA' AND s.area_id = sa.area_id)
  OR (sa.building_id IS NULL AND sa.area_id IS NULL AND s.scope_type='ORGANIZATION')
)
ON CONFLICT DO NOTHING;

-- 6) member_permission_overrides: diff per-staff snapshot vs role template.
--    (Legacy sa.permissions org-wide nhất quán across assignments → 1 override/key.)
INSERT INTO public.member_permission_overrides (organization_id, membership_id, permission_key, effect, reason, created_by)
SELECT DISTINCT ON (m.organization_id, m.id, pd.key)
  m.organization_id, m.id, pd.key,
  CASE WHEN COALESCE((sa.permissions -> pd.resource ->> pd.action)='true', false) THEN 'ALLOW' ELSE 'DENY' END,
  'legacy per-staff snapshot diff vs role template',
  sa.user_id
FROM public.staff_assignments sa
JOIN public.organization_memberships m ON m.user_id = sa.staff_id AND m.status='ACTIVE'
JOIN public.roles r ON r.id = sa.role_id
JOIN public.permission_definitions pd ON true
WHERE sa.permissions IS NOT NULL
  AND COALESCE((sa.permissions -> pd.resource ->> pd.action)='true', false)
      <> COALESCE((r.permissions   -> pd.resource ->> pd.action)='true', false)
ON CONFLICT (organization_id, membership_id, permission_key) DO NOTHING;

COMMIT;
