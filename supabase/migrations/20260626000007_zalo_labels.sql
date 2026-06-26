-- =============================================================
-- Chat Zalo — Nhãn "Phân loại" của Zalo (getLabels): danh sách nhãn + gắn nhãn
-- vào hội thoại để lọc trên web. Idempotent.
-- =============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.zalo_labels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id  uuid REFERENCES public.zalo_accounts(id) ON DELETE CASCADE,
  label_id    int NOT NULL,
  name        text NOT NULL,
  color       text,
  emoji       text,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, label_id)
);
CREATE INDEX IF NOT EXISTS zalo_labels_user_idx ON public.zalo_labels(user_id);

-- Gắn nhãn vào hội thoại (mảng label_id của tài khoản đó)
ALTER TABLE public.zalo_conversations ADD COLUMN IF NOT EXISTS label_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Triggers
DROP TRIGGER IF EXISTS zalo_labels_set_user_id_audit ON public.zalo_labels;
CREATE TRIGGER zalo_labels_set_user_id_audit BEFORE INSERT ON public.zalo_labels
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
DROP TRIGGER IF EXISTS set_zalo_labels_updated_at ON public.zalo_labels;
CREATE TRIGGER set_zalo_labels_updated_at BEFORE UPDATE ON public.zalo_labels
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- RLS owner + admin/super
ALTER TABLE public.zalo_labels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS zalo_labels_owner_all ON public.zalo_labels;
CREATE POLICY zalo_labels_owner_all ON public.zalo_labels FOR ALL TO authenticated
  USING (user_id = auth.uid() OR public.is_super_admin() OR public.is_admin())
  WITH CHECK (user_id = auth.uid() OR public.is_super_admin() OR public.is_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.zalo_labels TO authenticated, service_role;
REVOKE ALL ON public.zalo_labels FROM anon;

-- Realtime cho nhãn (cập nhật danh sách nhãn tức thì)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='zalo_labels') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.zalo_labels;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
