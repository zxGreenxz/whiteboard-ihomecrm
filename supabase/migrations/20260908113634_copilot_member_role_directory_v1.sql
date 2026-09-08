-- G1-C: read-only, selected-organization directory of redacted members and role templates.
BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.copilot_member_role_directory_v1(
  p_organization_id uuid,
  p_member_status text DEFAULT NULL,
  p_member_type text DEFAULT NULL,
  p_only_without_roles boolean DEFAULT false,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_org_wide boolean := false;
  v_member_status text := NULLIF(upper(btrim(coalesce(p_member_status, ''))), '');
  v_member_type text := NULLIF(upper(btrim(coalesce(p_member_type, ''))), '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_members jsonb;
  v_roles jsonb;
  v_summary jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF v_member_status IS NOT NULL AND v_member_status NOT IN ('ACTIVE', 'INVITED', 'SUSPENDED') THEN
    RAISE EXCEPTION 'invalid_member_status' USING ERRCODE = '22023';
  END IF;
  IF v_member_type IS NOT NULL AND v_member_type NOT IN ('OWNER', 'STAFF', 'SHAREHOLDER', 'PARTNER', 'SERVICE') THEN
    RAISE EXCEPTION 'invalid_member_type' USING ERRCODE = '22023';
  END IF;
  IF NOT app_private.copilot_page_flag_allows_v1('copilot.members-roles.directory', p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  SELECT scope.org_wide INTO v_org_wide
    FROM app_private.authorized_scope_v3('users.view', p_organization_id) scope;
  IF NOT COALESCE(v_org_wide, false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'thanh_vien', count(*)::integer,
    'dang_hoat_dong', count(*) FILTER (WHERE m.status = 'ACTIVE')::integer,
    'chua_gan_vai_tro', count(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.role_bindings rb
        WHERE rb.organization_id = p_organization_id
          AND rb.membership_id = m.id
          AND rb.valid_to IS NULL
      )
    )::integer
  ) INTO v_summary
  FROM public.organization_memberships m
  WHERE m.organization_id = p_organization_id
    AND m.revoked_at IS NULL
    AND m.status <> 'REVOKED';

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'ma_thanh_vien', s.member_ref,
      'loai', s.member_type,
      'trang_thai', s.status,
      'vai_tro', s.role_names,
      'so_quyen_hieu_luc', s.effective_permission_count
    ) ORDER BY s.member_type_rank, s.member_ref
  ), '[]'::jsonb)
  INTO v_members
  FROM (
    SELECT
      'TV-' || upper(substr(replace(m.id::text, '-', ''), 1, 8)) AS member_ref,
      m.member_type::text AS member_type,
      m.status::text AS status,
      CASE m.member_type WHEN 'OWNER' THEN 0 WHEN 'STAFF' THEN 1 ELSE 2 END AS member_type_rank,
      COALESCE((
        SELECT jsonb_agg(r.name ORDER BY r.name)
        FROM public.role_bindings rb
        JOIN public.organization_roles r
          ON r.id = rb.role_id
          AND r.organization_id = p_organization_id
        WHERE rb.organization_id = p_organization_id
          AND rb.membership_id = m.id
          AND rb.valid_to IS NULL
      ), '[]'::jsonb) AS role_names,
      COALESCE(cardinality(app_private.allowed_keys_for_membership_v3(m.id)), 0) AS effective_permission_count
    FROM public.organization_memberships m
    WHERE m.organization_id = p_organization_id
      AND m.revoked_at IS NULL
      AND m.status <> 'REVOKED'
      AND (v_member_status IS NULL OR m.status::text = v_member_status)
      AND (v_member_type IS NULL OR m.member_type::text = v_member_type)
      AND (
        NOT COALESCE(p_only_without_roles, false)
        OR NOT EXISTS (
          SELECT 1
          FROM public.role_bindings rb
          WHERE rb.organization_id = p_organization_id
            AND rb.membership_id = m.id
            AND rb.valid_to IS NULL
        )
      )
    ORDER BY CASE m.member_type WHEN 'OWNER' THEN 0 WHEN 'STAFF' THEN 1 ELSE 2 END, m.id
    LIMIT v_limit
  ) s;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'ten', s.name,
      'he_thong', s.is_system,
      'trang_thai', s.status,
      'so_thanh_vien', s.member_count,
      'so_quyen_cho_phep', s.allow_count,
      'so_quyen_cam', s.deny_count
    ) ORDER BY s.is_system DESC, s.name
  ), '[]'::jsonb)
  INTO v_roles
  FROM (
    SELECT
      r.name,
      r.is_system,
      COALESCE(r.status, 'ACTIVE') AS status,
      (
        SELECT count(DISTINCT rb.membership_id)::integer
        FROM public.role_bindings rb
        JOIN public.organization_memberships m
          ON m.id = rb.membership_id
          AND m.organization_id = p_organization_id
          AND m.revoked_at IS NULL
          AND m.status <> 'REVOKED'
        WHERE rb.organization_id = p_organization_id
          AND rb.role_id = r.id
          AND rb.valid_to IS NULL
      ) AS member_count,
      (SELECT count(*)::integer FROM public.role_permissions rp
       WHERE rp.organization_id = p_organization_id AND rp.role_id = r.id AND rp.effect = 'ALLOW') AS allow_count,
      (SELECT count(*)::integer FROM public.role_permissions rp
       WHERE rp.organization_id = p_organization_id AND rp.role_id = r.id AND rp.effect = 'DENY') AS deny_count
    FROM public.organization_roles r
    WHERE r.organization_id = p_organization_id
      AND COALESCE(r.status, 'ACTIVE') <> 'ARCHIVED'
    ORDER BY r.is_system DESC, r.name
    LIMIT v_limit
  ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_members),
    'tong_hop', v_summary,
    'thanh_vien', v_members,
    'vai_tro', v_roles
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.copilot_member_role_directory_v1(uuid, text, text, boolean, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_member_role_directory_v1(uuid, text, text, boolean, integer) TO authenticated;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);
INSERT INTO public.copilot_feature_flags(scope, contract_id, state, reason, evidence_link, rollback_reference)
VALUES (
  'page',
  'copilot.members-roles.directory',
  'disabled',
  'G1-C: chờ kiểm thử quyền, redaction và rollout DEMO',
  'migration:20260908113634_copilot_member_role_directory_v1',
  'migration:20260908113634_copilot_member_role_directory_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;
SELECT set_config('app.copilot_feature_flag_transition', '', true);

DO $nghiem_thu$
DECLARE
  v_fn regprocedure := to_regprocedure('public.copilot_member_role_directory_v1(uuid,text,text,boolean,integer)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'copilot_member_role_directory_missing';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'copilot_member_role_directory_acl_invalid';
  END IF;
END
$nghiem_thu$;

COMMIT;
