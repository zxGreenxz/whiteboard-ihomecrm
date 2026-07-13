-- =============================================================================
-- Sprint 2d — authorize_v2 + effective_perms_v2 (SHADOW helpers).
-- (AUTHORIZATION-PLAN.md §11.6)
--
-- SHADOW/INERT: chưa dùng trong RLS/RPC nào. Dùng để đối chiếu với
-- get_my_permissions trước khi cutover RLS v2 (Sprint 3). Definer, không grant
-- client (revoke anon/auth). search_path pinned.
-- =============================================================================

BEGIN;

-- Flat {module:{action:true}} từ mô hình normalized cho (user, org).
-- Deny override thắng; role_permissions qua active bindings + allow overrides.
CREATE OR REPLACE FUNCTION public.effective_perms_v2(p_user uuid, p_org uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog','public'
AS $fn$
  WITH mem AS (
    SELECT id FROM public.organization_memberships
    WHERE user_id = p_user AND organization_id = p_org AND status = 'ACTIVE'
  ),
  role_keys AS (
    SELECT DISTINCT rp.permission_key AS key
    FROM mem
    JOIN public.role_bindings rb
      ON rb.membership_id = mem.id AND (rb.valid_to IS NULL OR rb.valid_to > now())
    JOIN public.role_permissions rp
      ON rp.organization_id = p_org AND rp.role_id = rb.role_id AND rp.effect = 'ALLOW'
  ),
  allow_ov AS (
    SELECT o.permission_key AS key FROM public.member_permission_overrides o
    JOIN mem ON o.membership_id = mem.id
    WHERE o.effect = 'ALLOW' AND (o.expires_at IS NULL OR o.expires_at > now())
  ),
  deny_ov AS (
    SELECT o.permission_key AS key FROM public.member_permission_overrides o
    JOIN mem ON o.membership_id = mem.id
    WHERE o.effect = 'DENY' AND (o.expires_at IS NULL OR o.expires_at > now())
  ),
  effective AS (
    SELECT key FROM (SELECT key FROM role_keys UNION SELECT key FROM allow_ov) u
    WHERE key NOT IN (SELECT key FROM deny_ov)
  )
  SELECT COALESCE(jsonb_object_agg(resource, actions), '{}'::jsonb)
  FROM (
    SELECT pd.resource, jsonb_object_agg(pd.action, true) AS actions
    FROM effective e JOIN public.permission_definitions pd ON pd.key = e.key
    GROUP BY pd.resource
  ) g;
$fn$;

-- Scope-aware point check (cho RLS/RPC v2 Sprint 3). Resolve scope từ resource.
-- resource_type ∈ ('BUILDING','AREA','CASHBOOK','ORGANIZATION'); resource_id là
-- building_id/area_id/account_id tương ứng (NULL cho ORGANIZATION).
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

REVOKE ALL ON FUNCTION public.effective_perms_v2(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.authorize_v2(text,uuid,text,uuid) FROM PUBLIC, anon, authenticated;

COMMIT;
