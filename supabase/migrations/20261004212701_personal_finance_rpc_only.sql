-- Apply AFTER the RPC-based app is healthy; legacy app versions use direct DML.
REVOKE ALL ON public.personal_transactions FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.personal_transactions TO authenticated;
DROP POLICY IF EXISTS personal_transactions_org_boundary ON public.personal_transactions;
NOTIFY pgrst,'reload schema';
