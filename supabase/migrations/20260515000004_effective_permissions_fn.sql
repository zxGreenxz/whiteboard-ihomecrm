-- =============================================================
-- effective_permissions() + user_can() helpers
--
-- effective_permissions(p_user) trả jsonb dạng:
--   {"__all": true}                          -- super admin hoặc admin
--   {"contracts": ["view","edit","terminate"], "invoices": [...]}
--
-- Logic:
--   1. Nếu is_super_admin → {"__all": true}
--   2. Nếu is_admin       → {"__all": true}
--   3. Union role.permissions của TẤT CẢ staff_assignments của user
--      (vì 1 user có thể nhiều assignment ở nhiều toà nhà với role khác nhau)
--   4. Áp grants/revokes từ user_permission_overrides
--
-- user_can(resource, action) là wrapper short-circuit để các stored
-- proc nhạy cảm có thể guard:
--   IF NOT public.user_can('contracts','terminate') THEN
--     RAISE EXCEPTION USING ERRCODE = '42501';
--   END IF;
--
-- Idempotent.
-- =============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.effective_permissions(p_user uuid DEFAULT auth.uid())
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_super  boolean;
  v_is_admin  boolean;
  v_result    jsonb := '{}'::jsonb;
  v_role_row  record;
  v_resource  text;
  v_actions   jsonb;
  v_action    text;
  v_set       jsonb;
  v_existing  jsonb;
  v_ov        record;
BEGIN
  IF p_user IS NULL THEN
    RETURN v_result;
  END IF;

  -- Super admin shortcut
  SELECT EXISTS (SELECT 1 FROM public.super_admins WHERE user_id = p_user)
    INTO v_is_super;
  IF v_is_super THEN
    RETURN jsonb_build_object('__all', true);
  END IF;

  -- Admin shortcut (mirror is_admin() but per-user)
  SELECT EXISTS (
    SELECT 1
    FROM public.staff_assignments sa
    JOIN public.roles r ON r.id = sa.role_id
    WHERE sa.staff_id = p_user
      AND (
        r.permissions @> '{"__superadmin": true}'::jsonb
        OR r.name = 'Admin'
      )
  ) INTO v_is_admin;
  IF v_is_admin THEN
    RETURN jsonb_build_object('__all', true);
  END IF;

  -- 3. Union role baseline permissions
  -- roles.permissions JSONB shape: {resource: {view:bool, create:bool, edit:bool, delete:bool, <special>:bool}}
  FOR v_role_row IN
    SELECT r.permissions
    FROM public.staff_assignments sa
    JOIN public.roles r ON r.id = sa.role_id
    WHERE sa.staff_id = p_user
  LOOP
    IF v_role_row.permissions IS NULL THEN
      CONTINUE;
    END IF;

    FOR v_resource, v_actions IN
      SELECT key, value FROM jsonb_each(v_role_row.permissions)
    LOOP
      -- Skip flag keys like __superadmin
      IF v_resource LIKE '\_\_%' ESCAPE '\' THEN
        CONTINUE;
      END IF;

      IF jsonb_typeof(v_actions) <> 'object' THEN
        CONTINUE;
      END IF;

      v_existing := COALESCE(v_result -> v_resource, '[]'::jsonb);
      v_set := v_existing;

      FOR v_action IN
        SELECT key FROM jsonb_each_text(v_actions) WHERE value::boolean = true
      LOOP
        IF NOT (v_set ? v_action) THEN
          v_set := v_set || to_jsonb(v_action);
        END IF;
      END LOOP;

      v_result := v_result || jsonb_build_object(v_resource, v_set);
    END LOOP;
  END LOOP;

  -- 4. Apply per-user overrides
  FOR v_ov IN
    SELECT resource, action, effect
    FROM public.user_permission_overrides
    WHERE user_id = p_user
  LOOP
    v_existing := COALESCE(v_result -> v_ov.resource, '[]'::jsonb);

    IF v_ov.effect = 'grant' THEN
      IF NOT (v_existing ? v_ov.action) THEN
        v_existing := v_existing || to_jsonb(v_ov.action);
      END IF;
    ELSIF v_ov.effect = 'revoke' THEN
      SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
        INTO v_existing
        FROM jsonb_array_elements_text(v_existing) AS elem
        WHERE elem <> v_ov.action;
    END IF;

    v_result := v_result || jsonb_build_object(v_ov.resource, v_existing);
  END LOOP;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.effective_permissions(uuid)
  TO authenticated, anon, service_role;

-- ── user_can(resource, action) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.user_can(p_resource text, p_action text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_perms jsonb;
  v_set   jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;

  v_perms := public.effective_permissions(auth.uid());

  IF v_perms ? '__all' THEN
    RETURN true;
  END IF;

  v_set := v_perms -> p_resource;
  IF v_set IS NULL THEN
    RETURN false;
  END IF;

  RETURN v_set ? p_action;
END;
$$;

GRANT EXECUTE ON FUNCTION public.user_can(text, text)
  TO authenticated, anon, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
