-- =============================================================
-- Per-user permission overrides
--
-- Cho phép super admin cộng/trừ quyền (action) cho từng user trên
-- baseline role hiện tại. Mỗi row = 1 cặp (resource, action) với
-- effect = 'grant' (cấp thêm) hoặc 'revoke' (gỡ bớt).
--
-- Quyền hiệu dụng của user:
--   role_baseline ∪ {grants} \ {revokes}
--
-- Super admin & tenant admin KHÔNG dùng bảng này — họ bypass toàn
-- bộ qua is_super_admin() / is_admin() (xem migrations
-- 20260506000002 và 20260506000003).
--
-- RLS: chỉ super admin SELECT/INSERT/UPDATE/DELETE.
-- Idempotent.
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_permission_overrides (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  resource    text NOT NULL,
  action      text NOT NULL,
  effect      text NOT NULL CHECK (effect IN ('grant','revoke')),
  reason      text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, resource, action)
);

CREATE INDEX IF NOT EXISTS user_permission_overrides_user_id_idx
  ON public.user_permission_overrides (user_id);

ALTER TABLE public.user_permission_overrides ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.user_permission_overrides TO authenticated;

DROP POLICY IF EXISTS "user_permission_overrides_super_admin_only"
  ON public.user_permission_overrides;
CREATE POLICY "user_permission_overrides_super_admin_only"
  ON public.user_permission_overrides
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- updated_at auto on UPDATE
CREATE OR REPLACE FUNCTION public._touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_permission_overrides_touch_updated_at
  ON public.user_permission_overrides;
CREATE TRIGGER user_permission_overrides_touch_updated_at
  BEFORE UPDATE ON public.user_permission_overrides
  FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();

NOTIFY pgrst, 'reload schema';
COMMIT;
