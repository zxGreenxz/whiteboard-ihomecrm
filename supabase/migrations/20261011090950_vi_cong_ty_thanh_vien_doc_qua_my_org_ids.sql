-- =============================================================================
-- Ví công ty: thành viên ACTIVE đọc được ví của mình (K11-37 = C-03 = Q-05; Q16)
--
-- VẤN ĐỀ (production, chỉ đọc 11/10/2026)
--   company_wallet_snapshot là SECURITY INVOKER và kiểm
--   EXISTS(SELECT … FROM organization_memberships …). Trên production bảng
--   organization_memberships chỉ có policy SELECT organization_memberships_select_super
--   (super admin) ⇒ với MỌI người khác subquery luôn rỗng ⇒ 42501
--   'company_wallet_permission: organization' dù là Chủ công ty ACTIVE. Policy
--   company_wallet_owner của 3 bảng ví cũng dùng cùng subquery ⇒ kể cả qua được cửa
--   hàm, người dùng thường đọc 0 dòng ví của chính mình. company_wallet_mutate và
--   create_company_wallet_voucher là SECURITY DEFINER (chủ hàm bỏ qua RLS) nên vẫn
--   chạy — không đổi ở đây. Test cũ (src/lib/companyWallet/migration.test.ts) tự tạo
--   policy own_membership mà production không có nên che lỗi.
--
-- SỬA (mô hình giữ nguyên theo Q16: thành viên ACTIVE xem/tạo; ghi theo chủ ví +
--   quyền sổ quỹ qua list_cashbooks_for_expense_v2 như cũ)
--   • Cửa thành viên dùng public.my_org_ids() (SECURITY DEFINER, membership ACTIVE
--     của auth.uid()) thay vì đọc bảng organization_memberships dưới RLS.
--   • company_wallet_snapshot giữ SECURITY INVOKER (số dư/phiếu vẫn theo RLS + quyền
--     sổ quỹ của người gọi), chỉ đổi đúng điều kiện thành viên.
--   • Policy company_wallet_owner: user_id = auth.uid() AND org ∈ my_org_ids().
--
-- IDEMPOTENT: CREATE OR REPLACE cùng chữ ký/kiểu trả về; ALTER POLICY; ACL khẳng
-- định lại. Không ghi dữ liệu.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.company_wallet_snapshot(p_organization_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE u uuid:=auth.uid(); result jsonb;
BEGIN
 IF u IS NULL OR COALESCE(public.is_super_admin() AND p_organization_id=ANY(public.sandbox_org_ids()),false) OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'company_wallet_permission: organization' USING ERRCODE='42501'; END IF;
 WITH wallets AS (
  SELECT w.*,a.name AS account_name,
   (a.id IS NOT NULL AND coalesce(v.balance_visible,false)) AS balance_visible,
   CASE WHEN a.id IS NOT NULL AND coalesce(v.balance_visible,false) THEN a.current_amount ELSE NULL END AS balance,
   (a.id IS NOT NULL AND NOT w.hidden AND EXISTS(SELECT 1 FROM public.list_cashbooks_for_expense_v2() c WHERE c.id=w.account_id)) AS can_use
  FROM public.company_wallets w
  LEFT JOIN public.accounts_with_balance_v2 a ON a.id=w.account_id AND a.organization_id=w.organization_id AND NOT a.is_virtual
  LEFT JOIN public.list_cashbook_visibility_v2() v ON v.cashbook_id=w.account_id
  WHERE w.user_id=u AND w.organization_id=p_organization_id
 ), transactions AS (
  SELECT ie.id,o.wallet_id,o.user_id,o.organization_id,ie.code,ie.type,ie.name,ie.total_amount,ie.voucher_date,
   ie.approval_status,ie.posting_status,ie.review_state,ie.attachments,ie.created_at,ie.deleted_at
  FROM public.company_wallet_voucher_origins o JOIN public.income_expenses ie ON ie.id=o.voucher_id AND ie.organization_id=o.organization_id
  WHERE o.user_id=u AND o.organization_id=p_organization_id AND o.source='personal_wallet'
 ) SELECT jsonb_build_object('owner_id',u,'organization_id',p_organization_id,'schema_version',1,
  'wallets',coalesce((SELECT jsonb_agg(to_jsonb(w) ORDER BY hidden,is_preferred DESC,name,id) FROM wallets w),'[]'::jsonb),
  'transactions',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY voucher_date DESC,created_at DESC,id) FROM transactions t),'[]'::jsonb)) INTO result;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.company_wallet_snapshot(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.company_wallet_snapshot(uuid) TO authenticated;

DO $rls$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['company_wallets','company_wallet_requests','company_wallet_voucher_origins'] LOOP
  EXECUTE format('ALTER POLICY company_wallet_owner ON public.%I USING (user_id=(select auth.uid()) AND organization_id IN (SELECT unnest(public.my_org_ids())))',t);
 END LOOP;
END $rls$;

-- Nghiệm thu (chỉ đọc catalog).
DO $nghiem_thu$
DECLARE fn oid:=to_regprocedure('public.company_wallet_snapshot(uuid)');t text;q text;
BEGIN
 IF fn IS NULL OR (SELECT prosecdef FROM pg_proc WHERE oid=fn) THEN
  RAISE EXCEPTION 'Nghiệm thu K11-37 KHÔNG ĐẠT: company_wallet_snapshot phải tồn tại và SECURITY INVOKER';END IF;
 IF position('organization_memberships' IN pg_get_functiondef(fn))>0 OR position('my_org_ids()' IN pg_get_functiondef(fn))=0 THEN
  RAISE EXCEPTION 'Nghiệm thu K11-37 KHÔNG ĐẠT: snapshot còn đọc organization_memberships dưới RLS';END IF;
 IF has_function_privilege('anon',fn,'EXECUTE') OR NOT has_function_privilege('authenticated',fn,'EXECUTE') THEN
  RAISE EXCEPTION 'Nghiệm thu K11-37 KHÔNG ĐẠT: ACL snapshot lệch';END IF;
 FOREACH t IN ARRAY ARRAY['company_wallets','company_wallet_requests','company_wallet_voucher_origins'] LOOP
  SELECT pg_get_expr(p.polqual,p.polrelid) INTO q FROM pg_policy p WHERE p.polrelid=format('public.%I',t)::regclass AND p.polname='company_wallet_owner';
  IF q IS NULL OR position('organization_memberships' IN q)>0 OR position('my_org_ids' IN q)=0 OR position('auth.uid()' IN q)=0 THEN
   RAISE EXCEPTION 'Nghiệm thu K11-37 KHÔNG ĐẠT: policy company_wallet_owner của % chưa theo my_org_ids + chủ ví',t;END IF;
 END LOOP;
END
$nghiem_thu$;

NOTIFY pgrst,'reload schema';

-- ROLLBACK (thủ công): CREATE OR REPLACE company_wallet_snapshot và ALTER POLICY
-- company_wallet_owner về thân ở 20261008164757 (dòng 61 và 73–96). Không có dữ liệu để lùi.
