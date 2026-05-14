-- =============================================
-- Mở rộng RLS cho invoice_audit_log: cho phép admin, super admin và staff
-- (qua current_visible_owner_ids) đọc giống như đọc invoices.
-- =============================================

DROP POLICY IF EXISTS "invoice_audit_log_select_own"
  ON public.invoice_audit_log;

CREATE POLICY "invoice_audit_log_select_visible"
  ON public.invoice_audit_log
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.invoices i
      WHERE i.id = invoice_audit_log.invoice_id
        AND (
          i.user_id = auth.uid()
          OR public.is_admin()
          OR public.is_super_admin()
          OR i.user_id = ANY (public.current_visible_owner_ids())
        )
    )
  );
