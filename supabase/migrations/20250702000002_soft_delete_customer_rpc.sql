-- =============================================
-- RPC: soft_delete_customer
-- Bypasses RLS issues with soft-delete by using SECURITY DEFINER
-- Only deletes if the calling user owns the record
-- =============================================

CREATE OR REPLACE FUNCTION soft_delete_customer(p_customer_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE customers
  SET deleted_at = NOW()
  WHERE id = p_customer_id
    AND user_id = auth.uid()
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found or not authorized';
  END IF;
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION soft_delete_customer(UUID) TO authenticated;
