-- =============================================================
-- Hạng mục thu/chi "HẠN CHẾ" (vd Quản Lý) — ẩn khỏi nhân viên thường,
-- chỉ người có quyền mới thấy. Chặn THẬT ở DB (RLS), không chỉ ẩn UI.
--
-- Bối cảnh
-- ────────
-- Chủ muốn ẩn 1 số hạng mục chi nhạy cảm (vd "Quản Lý") khỏi nhân viên:
--   • Không thấy hạng mục đó trong picker khi TẠO phiếu.
--   • Không thấy/sửa các PHIẾU thuộc hạng mục đó trong bảng Thu chi (mọi toà),
--     và phiếu đó KHÔNG được cộng vào tổng.
-- Phiếu income_expenses không trỏ trực tiếp hạng mục — phải qua
-- income_expense_items.income_expense_type_id → income_expense_types.
--
-- Cơ chế 3 tầng
-- ────────────
--   1. Cờ income_expense_types.is_restricted (chủ tự bật/tắt từng hạng mục).
--   2. Cột suy diễn income_expenses.has_restricted_item (maintained bằng trigger,
--      MIRROR counts_in_business_result) = phiếu có ≥1 item thuộc hạng mục hạn chế.
--   3. 2 quyền JSONB (module income_expenses):
--        restricted_create  → A: thấy & chọn hạng mục hạn chế khi TẠO phiếu.
--        restricted_view    → B: thấy & sửa phiếu hạng mục hạn chế trong BẢNG.
--      + RLS RESTRICTIVE (AND lên trên các policy permissive cũ) để ẩn thật.
--
-- LƯU Ý QUAN TRỌNG: RESTRICTIVE policy được AND với MỌI policy permissive (kể cả
-- admin_all / super_admin_all), nên 2 helper PHẢI trả true cho is_super_admin()/
-- is_admin(), và policy còn cho user_id = auth.uid() (người tạo luôn thấy phiếu
-- của mình) — nếu không sẽ ẩn cả phiếu của chính chủ.
--
-- Idempotent.
-- =============================================================

BEGIN;

-- ── 1) Cột mới ───────────────────────────────────────────────────────────────
ALTER TABLE public.income_expense_types
  ADD COLUMN IF NOT EXISTS is_restricted boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.income_expense_types.is_restricted IS
  'Hạng mục hạn chế: chỉ người có quyền income_expenses.restricted_create (tạo) / restricted_view (xem-sửa) mới thấy. Ẩn khỏi picker + bảng + tổng cho người khác.';

ALTER TABLE public.income_expenses
  ADD COLUMN IF NOT EXISTS has_restricted_item boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.income_expenses.has_restricted_item IS
  'Cờ suy diễn (maintained bằng trigger): phiếu có ≥1 item thuộc hạng mục is_restricted=TRUE. Dùng cho RLS ẩn phiếu hạn chế.';

CREATE INDEX IF NOT EXISTS idx_ie_has_restricted_item
  ON public.income_expenses (has_restricted_item);

-- ── 2) Mở rộng recompute_ie_business_result: tính THÊM has_restricted_item ───
--    Giữ nguyên logic counts_in_business_result; tính cả 2 cờ trong 1 pass.
CREATE OR REPLACE FUNCTION public.recompute_ie_business_result(p_ie_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_override      boolean;
  v_has_deposit   boolean;
  v_has_restricted boolean;
  v_result        boolean;
BEGIN
  SELECT business_result_accounting INTO v_override
    FROM income_expenses WHERE id = p_ie_id;

  SELECT
    bool_or(t.is_deposit)    ,
    bool_or(t.is_restricted)
  INTO v_has_deposit, v_has_restricted
  FROM income_expense_items it
  JOIN income_expense_types t ON t.id = it.income_expense_type_id
  WHERE it.income_expense_id = p_ie_id;

  v_has_deposit    := COALESCE(v_has_deposit, false);
  v_has_restricted := COALESCE(v_has_restricted, false);
  v_result := COALESCE(v_override, NOT v_has_deposit);

  UPDATE income_expenses
     SET counts_in_business_result = v_result,
         has_restricted_item       = v_has_restricted
   WHERE id = p_ie_id
     AND (counts_in_business_result IS DISTINCT FROM v_result
       OR has_restricted_item       IS DISTINCT FROM v_has_restricted);
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_ie_business_result(uuid) FROM PUBLIC;

-- ── 3) Trigger trên income_expense_types khi đổi is_restricted ──────────────
--    Đổi cờ hạn chế của 1 hạng mục → recompute has_restricted_item cho mọi phiếu
--    đang dùng hạng mục đó (set-based, không loop).
CREATE OR REPLACE FUNCTION public.trg_ie_type_recompute_restricted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE income_expenses ie
     SET has_restricted_item = sub.has_r
  FROM (
    SELECT it.income_expense_id, bool_or(t.is_restricted) AS has_r
    FROM income_expense_items it
    JOIN income_expense_types t ON t.id = it.income_expense_type_id
    WHERE it.income_expense_id IN (
      SELECT income_expense_id FROM income_expense_items
      WHERE income_expense_type_id = NEW.id
    )
    GROUP BY it.income_expense_id
  ) sub
  WHERE ie.id = sub.income_expense_id
    AND ie.has_restricted_item IS DISTINCT FROM sub.has_r;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ie_type_restricted_recompute ON public.income_expense_types;
CREATE TRIGGER ie_type_restricted_recompute
  AFTER UPDATE OF is_restricted ON public.income_expense_types
  FOR EACH ROW
  WHEN (OLD.is_restricted IS DISTINCT FROM NEW.is_restricted)
  EXECUTE FUNCTION public.trg_ie_type_recompute_restricted();

-- ── 4) Helper quyền (SECURITY DEFINER) ──────────────────────────────────────
-- B: xem & sửa phiếu hạng mục hạn chế.
CREATE OR REPLACE FUNCTION public.can_view_restricted_ie()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT public.is_super_admin()
      OR public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.staff_assignments sa
        LEFT JOIN public.roles r ON r.id = sa.role_id
        WHERE sa.staff_id = auth.uid()
          AND COALESCE(
                (COALESCE(sa.permissions, r.permissions) -> 'income_expenses' ->> 'restricted_view')::boolean,
                false) = true
      );
$$;

COMMENT ON FUNCTION public.can_view_restricted_ie() IS
  'True nếu caller được XEM/SỬA phiếu hạng mục hạn chế: super_admin OR admin OR staff có income_expenses.restricted_view.';

-- A: thấy & chọn hạng mục hạn chế khi tạo phiếu.
CREATE OR REPLACE FUNCTION public.can_create_restricted_ie()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT public.is_super_admin()
      OR public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.staff_assignments sa
        LEFT JOIN public.roles r ON r.id = sa.role_id
        WHERE sa.staff_id = auth.uid()
          AND COALESCE(
                (COALESCE(sa.permissions, r.permissions) -> 'income_expenses' ->> 'restricted_create')::boolean,
                false) = true
      );
$$;

COMMENT ON FUNCTION public.can_create_restricted_ie() IS
  'True nếu caller được THẤY & CHỌN hạng mục hạn chế khi tạo phiếu: super_admin OR admin OR staff có income_expenses.restricted_create.';

-- Đọc cờ is_restricted của 1 hạng mục (bỏ qua RLS) — cho policy INSERT item.
CREATE OR REPLACE FUNCTION public.ie_type_is_restricted(_type_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT is_restricted FROM public.income_expense_types WHERE id = _type_id), false);
$$;

-- Phiếu cha có hạn chế & caller KHÔNG được xem? (true = vẫn được thấy item)
-- Dùng cho RLS RESTRICTIVE trên income_expense_items, tránh đệ quy RLS income_expenses.
CREATE OR REPLACE FUNCTION public.ie_item_restricted_visible(_ie_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = _ie_id
      AND (
        ie.has_restricted_item = false
        OR ie.user_id = auth.uid()
        OR public.can_view_restricted_ie()
      )
  );
$$;

REVOKE ALL ON FUNCTION public.ie_type_is_restricted(uuid)      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ie_item_restricted_visible(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_restricted_ie()      TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_create_restricted_ie()    TO authenticated;
GRANT EXECUTE ON FUNCTION public.ie_type_is_restricted(uuid)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.ie_item_restricted_visible(uuid) TO authenticated;

-- ── 5) RLS RESTRICTIVE: income_expenses (ẩn phiếu hạn chế) ──────────────────
DROP POLICY IF EXISTS income_expenses_restricted_select ON public.income_expenses;
CREATE POLICY income_expenses_restricted_select ON public.income_expenses
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (
    has_restricted_item = false
    OR user_id = auth.uid()
    OR public.can_view_restricted_ie()
  );

DROP POLICY IF EXISTS income_expenses_restricted_update ON public.income_expenses;
CREATE POLICY income_expenses_restricted_update ON public.income_expenses
  AS RESTRICTIVE
  FOR UPDATE
  TO authenticated
  USING (
    has_restricted_item = false
    OR user_id = auth.uid()
    OR public.can_view_restricted_ie()
  );

DROP POLICY IF EXISTS income_expenses_restricted_delete ON public.income_expenses;
CREATE POLICY income_expenses_restricted_delete ON public.income_expenses
  AS RESTRICTIVE
  FOR DELETE
  TO authenticated
  USING (
    has_restricted_item = false
    OR user_id = auth.uid()
    OR public.can_view_restricted_ie()
  );

-- ── 6) RLS RESTRICTIVE: income_expense_items (theo phiếu cha) ───────────────
DROP POLICY IF EXISTS income_expense_items_restricted_select ON public.income_expense_items;
CREATE POLICY income_expense_items_restricted_select ON public.income_expense_items
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (public.ie_item_restricted_visible(income_expense_id));

DROP POLICY IF EXISTS income_expense_items_restricted_update ON public.income_expense_items;
CREATE POLICY income_expense_items_restricted_update ON public.income_expense_items
  AS RESTRICTIVE
  FOR UPDATE
  TO authenticated
  USING (public.ie_item_restricted_visible(income_expense_id));

DROP POLICY IF EXISTS income_expense_items_restricted_delete ON public.income_expense_items;
CREATE POLICY income_expense_items_restricted_delete ON public.income_expense_items
  AS RESTRICTIVE
  FOR DELETE
  TO authenticated
  USING (public.ie_item_restricted_visible(income_expense_id));

-- INSERT: chặn gắn item thuộc hạng mục hạn chế nếu thiếu quyền tạo (A).
DROP POLICY IF EXISTS income_expense_items_restricted_insert ON public.income_expense_items;
CREATE POLICY income_expense_items_restricted_insert ON public.income_expense_items
  AS RESTRICTIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.ie_type_is_restricted(income_expense_type_id) = false
    OR public.can_create_restricted_ie()
  );

-- ── 7) RLS RESTRICTIVE: income_expense_types (ẩn hạng mục hạn chế) ──────────
--    Ẩn khỏi picker/combobox cho người không có A lẫn B. A hoặc B đều thấy được
--    (A để chọn khi tạo, B để hiển thị tên trên phiếu). Người tạo thấy type của mình.
DROP POLICY IF EXISTS income_expense_types_restricted_select ON public.income_expense_types;
CREATE POLICY income_expense_types_restricted_select ON public.income_expense_types
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (
    is_restricted = false
    OR user_id = auth.uid()
    OR public.can_view_restricted_ie()
    OR public.can_create_restricted_ie()
  );

-- ── 8) Backfill has_restricted_item cho phiếu hiện hữu ──────────────────────
--    (Lúc này chưa hạng mục nào is_restricted → tất cả = false; chạy để chắc chắn.)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM income_expenses LOOP
    PERFORM public.recompute_ie_business_result(r.id);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
