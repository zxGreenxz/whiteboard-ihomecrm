-- =============================================================
-- Jobs visibility: chỉ creator HOẶC assignee thấy được phiếu
--
-- Bối cảnh
-- ────────
-- Hiện tại trên `public.jobs` có 2 policy permissive cho SELECT:
--   • "Users can view own jobs"   USING (auth.uid() = user_id)
--   • "jobs_select_staff"          USING (user_id = ANY (current_visible_owner_ids()))
-- Cộng với super_admin bypass.
--
-- `current_visible_owner_ids()` mở rộng tới employer + co-staff
-- cùng employer ⇒ staff thấy được phiếu công việc của đồng nghiệp
-- dù bản thân không phải người tạo và không phải người thực hiện.
-- Người dùng muốn siết lại: chỉ creator HOẶC assignee thấy được,
-- ngoại lệ duy nhất là super admin (đã có policy bypass riêng).
--
-- Thay đổi
-- ────────
--   • DROP "jobs_select_staff"      (mở quá rộng)
--   • DROP "Users can view own jobs" (gộp vào policy mới)
--   • CREATE "jobs_select_owner_or_assignee":
--       USING (auth.uid() = user_id OR auth.uid() = assignee_id)
--     – profiles.id = auth.users.id nên so sánh assignee_id với auth.uid() là hợp lệ.
--
-- INSERT/UPDATE/DELETE giữ nguyên (creator + staff_can + super_admin).
-- Idempotent.
-- =============================================================

BEGIN;

DROP POLICY IF EXISTS "jobs_select_staff" ON public.jobs;
DROP POLICY IF EXISTS "Users can view own jobs" ON public.jobs;
DROP POLICY IF EXISTS "jobs_select_owner_or_assignee" ON public.jobs;

CREATE POLICY "jobs_select_owner_or_assignee"
  ON public.jobs FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    OR auth.uid() = assignee_id
  );

NOTIFY pgrst, 'reload schema';
COMMIT;
