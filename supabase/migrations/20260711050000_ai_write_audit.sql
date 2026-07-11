-- AI Copilot Phase 5 (PLAN.md v2.1): audit log + idempotency cho WRITE TOOLS
-- draft-first. Mỗi lần tool ghi dữ liệu: INSERT audit TRƯỚC với idempotency_key
-- UNIQUE — trùng key (23505) = lệnh đã thực thi → client trả về entity cũ,
-- KHÔNG tạo trùng (chống model gọi lặp / user bấm lại).

BEGIN;

CREATE TABLE public.ai_write_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tool text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  entity_table text NOT NULL,
  entity_id uuid,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_write_audit_user ON public.ai_write_audit (user_id, created_at DESC);

ALTER TABLE public.ai_write_audit ENABLE ROW LEVEL SECURITY;
-- user thấy audit của mình; super admin thấy hết
CREATE POLICY ai_write_audit_select ON public.ai_write_audit
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (SELECT public.is_super_admin()));
-- tool chạy client-side bằng session user → INSERT own; KHÔNG update/delete
CREATE POLICY ai_write_audit_insert ON public.ai_write_audit
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));
-- cho phép user gắn entity_id SAU khi tạo entity thành công (chỉ dòng của mình)
CREATE POLICY ai_write_audit_update_own ON public.ai_write_audit
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

COMMIT;
