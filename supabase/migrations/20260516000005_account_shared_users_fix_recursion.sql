-- =============================================================
-- Fix infinite recursion trong policies:
--   accounts_select_shared        → EXISTS account_shared_users
--   account_shared_users_select   → EXISTS accounts
-- → vòng lặp khi SELECT accounts.
--
-- Cách phá: 2 helper SECURITY DEFINER function, RLS không apply
-- bên trong → cắt vòng.
-- =============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.is_account_owner(p_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.accounts
    WHERE id = p_account_id
      AND user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_account_owner(uuid)
  TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION public.is_account_shared_with_me(p_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.account_shared_users
    WHERE account_id = p_account_id
      AND user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_account_shared_with_me(uuid)
  TO authenticated, anon, service_role;

-- Rewrite các policy có recursion.

DROP POLICY IF EXISTS "account_shared_users_select" ON public.account_shared_users;
CREATE POLICY "account_shared_users_select" ON public.account_shared_users
  FOR SELECT USING (
    user_id = auth.uid()
    OR public.is_account_owner(account_id)
  );

DROP POLICY IF EXISTS "account_shared_users_insert" ON public.account_shared_users;
CREATE POLICY "account_shared_users_insert" ON public.account_shared_users
  FOR INSERT WITH CHECK (
    public.is_account_owner(account_id)
  );

DROP POLICY IF EXISTS "account_shared_users_delete" ON public.account_shared_users;
CREATE POLICY "account_shared_users_delete" ON public.account_shared_users
  FOR DELETE USING (
    public.is_account_owner(account_id)
  );

DROP POLICY IF EXISTS "accounts_select_shared" ON public.accounts;
CREATE POLICY "accounts_select_shared" ON public.accounts
  FOR SELECT USING (
    public.is_account_shared_with_me(id)
  );

DROP POLICY IF EXISTS "income_expenses_select_shared" ON public.income_expenses;
CREATE POLICY "income_expenses_select_shared" ON public.income_expenses
  FOR SELECT USING (
    deleted_at IS NULL
    AND public.is_account_shared_with_me(account_id)
  );

DROP POLICY IF EXISTS "income_expenses_insert_shared" ON public.income_expenses;
CREATE POLICY "income_expenses_insert_shared" ON public.income_expenses
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND public.is_account_shared_with_me(account_id)
  );

NOTIFY pgrst, 'reload schema';
COMMIT;
