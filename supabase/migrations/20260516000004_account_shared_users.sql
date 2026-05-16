-- =============================================================
-- Account Shared Users — cho phép nhiều user "được dùng" 1 sổ quỹ
--
-- Owner (accounts.user_id) vẫn quản lý sổ (sửa/xoá/khoá, thêm/bớt
-- shared users). Shared users chỉ:
--   • Thấy sổ quỹ trong danh sách
--   • Tạo phiếu thu/chi gắn vào sổ
--   • Xem phiếu thu/chi của owner + shared users khác trong sổ
-- Shared users KHÔNG sửa/xoá sổ và không sửa phiếu của người khác.
-- Admin bypass toàn bộ qua is_admin() như mọi bảng khác.
-- =============================================================

BEGIN;

-- ── 1. Bảng account_shared_users ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.account_shared_users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id)     ON DELETE CASCADE,
  created_by  UUID          REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_account_shared_users_account
  ON public.account_shared_users(account_id);
CREATE INDEX IF NOT EXISTS idx_account_shared_users_user
  ON public.account_shared_users(user_id);

ALTER TABLE public.account_shared_users ENABLE ROW LEVEL SECURITY;

-- ── 2. RLS trên chính account_shared_users ─────────────────────
-- SELECT: shared user xem hàng của chính mình, owner xem toàn bộ
-- hàng của sổ mình quản lý.
DROP POLICY IF EXISTS "account_shared_users_select" ON public.account_shared_users;
CREATE POLICY "account_shared_users_select" ON public.account_shared_users
  FOR SELECT USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = account_shared_users.account_id
        AND a.user_id = auth.uid()
    )
  );

-- INSERT: chỉ owner của account (admin đi qua admin_all)
DROP POLICY IF EXISTS "account_shared_users_insert" ON public.account_shared_users;
CREATE POLICY "account_shared_users_insert" ON public.account_shared_users
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = account_shared_users.account_id
        AND a.user_id = auth.uid()
    )
  );

-- DELETE: chỉ owner của account
DROP POLICY IF EXISTS "account_shared_users_delete" ON public.account_shared_users;
CREATE POLICY "account_shared_users_delete" ON public.account_shared_users
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = account_shared_users.account_id
        AND a.user_id = auth.uid()
    )
  );

-- Admin bypass (giống pattern 20260506000002)
DROP POLICY IF EXISTS "account_shared_users_admin_all" ON public.account_shared_users;
CREATE POLICY "account_shared_users_admin_all" ON public.account_shared_users
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ── 3. Mở rộng SELECT trên accounts cho shared users ───────────
-- Postgres OR-merge mọi SELECT policy → policy mới chỉ thêm
-- nhánh "shared user thấy được sổ", không ảnh hưởng nhánh owner.
DROP POLICY IF EXISTS "accounts_select_shared" ON public.accounts;
CREATE POLICY "accounts_select_shared" ON public.accounts
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.account_shared_users asu
      WHERE asu.account_id = accounts.id
        AND asu.user_id    = auth.uid()
    )
  );

-- ── 4. Mở rộng RLS trên income_expenses cho shared users ───────
-- SELECT: shared user thấy mọi phiếu trên sổ mà mình được share.
DROP POLICY IF EXISTS "income_expenses_select_shared" ON public.income_expenses;
CREATE POLICY "income_expenses_select_shared" ON public.income_expenses
  FOR SELECT USING (
    deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.account_shared_users asu
      WHERE asu.account_id = income_expenses.account_id
        AND asu.user_id    = auth.uid()
    )
  );

-- INSERT: shared user được tạo phiếu (user_id phải = chính họ →
-- người tạo phiếu vẫn là họ, không mượn danh người khác).
DROP POLICY IF EXISTS "income_expenses_insert_shared" ON public.income_expenses;
CREATE POLICY "income_expenses_insert_shared" ON public.income_expenses
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.account_shared_users asu
      WHERE asu.account_id = income_expenses.account_id
        AND asu.user_id    = auth.uid()
    )
  );

-- UPDATE/DELETE phiếu vẫn giữ owner-only (creator của phiếu).
-- Không thêm policy nào — shared users không sửa được phiếu của
-- người khác. Creator của phiếu vẫn sửa/xoá phiếu mình tạo.

NOTIFY pgrst, 'reload schema';
COMMIT;
