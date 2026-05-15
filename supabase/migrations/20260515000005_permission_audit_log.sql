-- =============================================================
-- permission_audit_log
--
-- Trigger on user_permission_overrides ghi nhật ký mọi
-- INSERT/UPDATE/DELETE để super admin trace lại ai cấp/gỡ quyền
-- cho ai, khi nào, vì sao.
--
-- RLS: chỉ super admin SELECT. Không cho insert trực tiếp (trigger
-- tự ghi với SECURITY DEFINER).
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.permission_audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id  uuid NOT NULL,
  actor_id        uuid,
  op              text NOT NULL CHECK (op IN ('INSERT','UPDATE','DELETE')),
  resource        text NOT NULL,
  action          text NOT NULL,
  old_effect      text,
  new_effect      text,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS permission_audit_log_target_created_idx
  ON public.permission_audit_log (target_user_id, created_at DESC);

ALTER TABLE public.permission_audit_log ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.permission_audit_log TO authenticated;

DROP POLICY IF EXISTS "permission_audit_log_super_admin_select"
  ON public.permission_audit_log;
CREATE POLICY "permission_audit_log_super_admin_select"
  ON public.permission_audit_log
  FOR SELECT TO authenticated
  USING (public.is_super_admin());

-- Trigger function — SECURITY DEFINER để bypass RLS khi insert
CREATE OR REPLACE FUNCTION public._audit_user_permission_overrides()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.permission_audit_log
      (target_user_id, actor_id, op, resource, action, new_effect, reason)
    VALUES
      (NEW.user_id, auth.uid(), 'INSERT', NEW.resource, NEW.action, NEW.effect, NEW.reason);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO public.permission_audit_log
      (target_user_id, actor_id, op, resource, action, old_effect, new_effect, reason)
    VALUES
      (NEW.user_id, auth.uid(), 'UPDATE', NEW.resource, NEW.action, OLD.effect, NEW.effect, NEW.reason);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.permission_audit_log
      (target_user_id, actor_id, op, resource, action, old_effect)
    VALUES
      (OLD.user_id, auth.uid(), 'DELETE', OLD.resource, OLD.action, OLD.effect);
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS user_permission_overrides_audit
  ON public.user_permission_overrides;
CREATE TRIGGER user_permission_overrides_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.user_permission_overrides
  FOR EACH ROW EXECUTE FUNCTION public._audit_user_permission_overrides();

NOTIFY pgrst, 'reload schema';
COMMIT;
