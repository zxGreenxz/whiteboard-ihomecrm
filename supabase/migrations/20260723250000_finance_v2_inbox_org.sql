-- Finance V2 — Hotfix 7k: inbox Chờ duyệt route-aware (F3 verification).
--
-- ApprovalsPage resolve route V2 theo org của TỪNG request (v2Routes.getOrg) nhưng
-- list_my_pending_approvals_v1 KHÔNG trả organization_id ⇒ FE nhận undefined ⇒
-- LEGACY vĩnh viễn: inbox không bao giờ hiện "Duyệt và Thu/Chi…" và "Duyệt" vẫn
-- đi decide legacy (đổi tồn quỹ qua bridge) dù org đã CANONICAL.
-- Re-emit RPC thêm organization_id (+ approval_version/posting_version của phiếu
-- cho CAS đúng thay vì mặc định 1). Thêm cột cuối — caller cũ không vỡ.

BEGIN;

DROP FUNCTION IF EXISTS public.list_my_pending_approvals_v1();
CREATE FUNCTION public.list_my_pending_approvals_v1()
 RETURNS TABLE(
   request_id uuid, submission_no bigint, submitted_at timestamptz,
   amount numeric, voucher_id uuid, voucher_code text, voucher_name text,
   voucher_type text, maker_name text, step_no integer, request_version bigint,
   organization_id uuid, approval_version bigint, posting_version bigint
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
  select ar.id, ar.submission_no, ar.submitted_at,
         ar.amount, ie.id, ie.code, ie.name, ie.type::text,
         coalesce(ie.creator_name, '—'), s.step_no, ar.version,
         ar.organization_id,
         coalesce(ie.approval_version, 1), coalesce(ie.posting_version, 1)
    from public.approval_requests ar
    join public.approval_request_steps s
      on s.request_id = ar.id and s.status = 'PENDING'
    join public.approval_request_step_candidates c
      on c.request_step_id = s.id
     and c.generation = s.current_generation
     and c.valid_to is null
    join public.organization_memberships m
      on m.id = c.membership_id and m.status = 'ACTIVE'
    left join public.income_expenses ie on ie.id = ar.subject_id
   where ar.state = 'PENDING_APPROVAL'
     and ar.subject_type = 'FINANCIAL_VOUCHER'
     and m.user_id = auth.uid()
   order by ar.submitted_at asc;
$function$;

REVOKE ALL ON FUNCTION public.list_my_pending_approvals_v1() FROM PUBLIC;
DO $acl$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.list_my_pending_approvals_v1() FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.list_my_pending_approvals_v1() TO authenticated;
  END IF;
END
$acl$;

-- Smoke: RPC chạy được và có đủ cột mới.
DO $smoke$
DECLARE v_cols int;
BEGIN
  SELECT count(*) INTO v_cols
  FROM information_schema.columns
  WHERE table_name = 'list_my_pending_approvals_v1';
  -- RETURNS TABLE không tạo relation — kiểm bằng proc signature thay thế.
  IF (SELECT pronargs FROM pg_proc WHERE proname='list_my_pending_approvals_v1'
      AND pronamespace='public'::regnamespace) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'inbox RPC smoke: signature sai';
  END IF;
  RAISE NOTICE 'inbox RPC re-emitted (organization_id + versions)';
END
$smoke$;

COMMIT;

NOTIFY pgrst, 'reload schema';
