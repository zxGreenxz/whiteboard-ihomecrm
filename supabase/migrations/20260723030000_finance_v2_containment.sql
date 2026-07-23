-- Finance V2 (Thu Chi V2) — Stage 3: containment (plan §9.1/§9.4/§9.6/§10 step 5).
-- Close co-staff / all-building / self-grant / approval-base-read / bucket-wide storage leaks
-- (PERMISSIVE policies OR-merge, so a leak only closes when its policy is DROPPED), and add
-- scoped approval-inbox compat RPCs. LEGACY app keeps working via retained building/owner/
-- shared/possession policies. No feature mode changed, no org enrolled.

BEGIN;

-- =============================================================================
-- Finance V2 (Thu Chi V2) — STAGE-3 CONTAINMENT  (plan §9.1, §9.4, §9.6, §10 step 5, §967/OQ5)
--
-- Đóng các lỗ rò PERMISSIVE (Postgres OR-merge policy: lỗ chỉ đóng khi DROP policy):
--   (a) co-staff visibility (accounts_select_staff),
--   (b) all-building income_expenses / income_expense_items,
--   (c) self-grant cashbook access (account_shared_users insert/delete),
--   (d) approval base-table REST reads (thay bằng RPC scoped),
--   (e) bucket-wide receipt/attachment storage SELECT.
-- KHÔNG bật feature, KHÔNG enroll org. Legacy (feature OFF) vẫn chạy nhờ các
-- policy building-scoped/owner/shared được GIỮ (income_expenses_select_rbac,
-- accounts_select/_shared, *_restricted_*, *_org_boundary, *_super_admin_all,
-- ie_canonical_writer_*). Idempotent (IF EXISTS / CREATE OR REPLACE / REVOKE).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- §9.1/§9.6 (a) accounts: bỏ co-staff visibility leak (giữ owner + shared + super_admin)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS accounts_select_staff ON public.accounts;

-- ---------------------------------------------------------------------------
-- §9.1/§9.6 (b) income_expenses: bỏ all-building leak (giữ *_rbac building-scoped
--   legacy contract + fund_member/possession compat + exact-linked self-view).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS income_expenses_select_all_buildings ON public.income_expenses;
DROP POLICY IF EXISTS income_expenses_insert_all_buildings ON public.income_expenses;
DROP POLICY IF EXISTS income_expenses_insert_shared ON public.income_expenses;
DROP POLICY IF EXISTS income_expenses_update_all_buildings ON public.income_expenses;
DROP POLICY IF EXISTS income_expenses_delete_all_buildings ON public.income_expenses;

-- §9.1/§9.6 (b) income_expense_items: bỏ all-building leak (giữ *_rbac + *_restricted_*)
DROP POLICY IF EXISTS income_expense_items_select_all_buildings ON public.income_expense_items;
DROP POLICY IF EXISTS income_expense_items_insert_all_buildings ON public.income_expense_items;
DROP POLICY IF EXISTS income_expense_items_update_all_buildings ON public.income_expense_items;
DROP POLICY IF EXISTS income_expense_items_delete_all_buildings ON public.income_expense_items;

-- ---------------------------------------------------------------------------
-- §9.1 (c) account_shared_users: user KHÔNG được tự cấp/thu cashbook access qua REST.
--   Giữ SELECT (đọc danh sách), super_admin_all và ie_canonical_writer_*.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS account_shared_users_insert ON public.account_shared_users;
DROP POLICY IF EXISTS account_shared_users_delete ON public.account_shared_users;

-- ---------------------------------------------------------------------------
-- §9.4/§10(1019) (d) Approval base tables: revoke REST read bằng cách DROP các
--   SELECT policy (RLS enabled + không còn permissive SELECT ⇒ authenticated đọc
--   0 dòng qua REST). Thay bằng list_my_pending_approvals_compat_v2/detail bên dưới.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS approval_requests_select_member ON public.approval_requests;
DROP POLICY IF EXISTS approval_request_steps_select_member ON public.approval_request_steps;
DROP POLICY IF EXISTS approval_request_step_candidates_select_member ON public.approval_request_step_candidates;
DROP POLICY IF EXISTS approval_decisions_select_member ON public.approval_decisions;
DROP POLICY IF EXISTS approval_rule_sets_select_member ON public.approval_rule_sets;
DROP POLICY IF EXISTS approval_step_approvers_select_member ON public.approval_step_approvers;
DROP POLICY IF EXISTS authorization_audit_events_select_member ON public.authorization_audit_events;

-- ---------------------------------------------------------------------------
-- §967/OQ5 (residual base grant): user-facing cashbook access chỉ qua RPC; chỉ
--   còn super-admin policy (cashbook_possession_select_super). Revoke base grant.
-- ---------------------------------------------------------------------------
REVOKE SELECT ON public.cashbook_possession_bindings FROM authenticated;

-- ---------------------------------------------------------------------------
-- §9.1/§9.6 (e) Storage: KHÔNG drop bucket-wide receipt/attachment SELECT.
--
-- VERIFY LIVE (2026-07-22): lỗ "bucket-wide" mà plan §170 mô tả ĐÃ được đóng bởi
-- RESTRICTIVE `storage_pii_org_isolation` = app_private.can_read_storage_object_v1
-- (thêm sau plan ở PS03_storage_shield). Hàm này liệt kê 'income-expense-attachments'
-- và 'payment-receipts' trong danh sách PII ⇒ chỉ cho đọc khi có storage_object_links
-- khớp my_org_ids()/owner (hoặc super-admin). Vậy quyền đọc HIỆN TẠI đã org-scoped:
--   effective SELECT = PERMISSIVE(bucket) AND RESTRICTIVE(org-link).
-- RESTRICTIVE KHÔNG grant được; nếu drop PERMISSIVE thì deny-all ⇒ vỡ đọc receipt
-- hợp lệ qua signed URL (app dùng createSignedUrlFromStored, ĐI qua storage RLS),
-- mà KHÔNG đóng thêm lỗ nào. Do đó GIỮ NGUYÊN, storage đã "private/resource-linked"
-- đúng §9.6. (Nếu sau này phát hiện object PII chưa có storage_object_links → xử lý
-- ở backfill attachment §10.2, không phải drop PERMISSIVE ở đây.)
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- §9.4/§10(1019) Compat scoped RPCs — approval inbox vẫn chạy sau khi mất
--   SELECT policy base-table. SECURITY DEFINER, actor resolve từ auth.uid(),
--   KHÔNG lộ payload_snapshot / candidate list / audit dump / cross-org.
-- ===========================================================================

-- Helper (app_private): các cặp (org, membership) mà actor đang ACTIVE member.
-- Chỉ được gọi từ các definer RPC bên dưới (revoke hết grant client).
CREATE OR REPLACE FUNCTION app_private.resolve_approval_actor_v2()
 RETURNS TABLE(organization_id uuid, membership_id uuid)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = pg_catalog, app_private, public
AS $fn$
  SELECT m.organization_id, m.id
  FROM public.organization_memberships m
  WHERE m.user_id = auth.uid()
    AND m.status = 'ACTIVE';
$fn$;
REVOKE ALL ON FUNCTION app_private.resolve_approval_actor_v2() FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.resolve_approval_actor_v2()
  IS 'Thu Chi V2 §9.4 containment: resolve (org, membership) ACTIVE của actor cho compat approval RPCs. Internal-only.';

-- list_my_pending_approvals_compat_v2: chỉ request PENDING_APPROVAL mà actor là
-- maker HOẶC candidate đủ điều kiện ở step PENDING current generation. Safe columns.
CREATE OR REPLACE FUNCTION public.list_my_pending_approvals_compat_v2()
 RETURNS TABLE(
   id            uuid,
   subject_type  text,
   subject_id    uuid,
   state         text,
   amount        numeric,
   system_source text,
   cashbook_id   uuid,
   building_id   uuid,
   submitted_at  timestamptz)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = pg_catalog, app_private, public
AS $fn$
  WITH actor AS (
    SELECT a.organization_id, a.membership_id
    FROM app_private.resolve_approval_actor_v2() a
  )
  SELECT DISTINCT
    r.id, r.subject_type, r.subject_id, r.state,
    r.amount, r.system_source, r.cashbook_id, r.building_id, r.submitted_at
  FROM public.approval_requests r
  JOIN actor a ON a.organization_id = r.organization_id
  WHERE r.state = 'PENDING_APPROVAL'
    AND (
      r.maker_membership_id = a.membership_id
      OR EXISTS (
        SELECT 1
        FROM public.approval_request_steps st
        JOIN public.approval_request_step_candidates c
          ON c.request_step_id = st.id
         AND c.organization_id = st.organization_id
        WHERE st.request_id = r.id
          AND st.organization_id = r.organization_id
          AND st.status = 'PENDING'
          AND c.membership_id = a.membership_id
          AND c.generation = st.current_generation
          AND (c.valid_to IS NULL OR c.valid_to > now())
      )
    )
  ORDER BY r.submitted_at;
$fn$;
REVOKE ALL ON FUNCTION public.list_my_pending_approvals_compat_v2() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.list_my_pending_approvals_compat_v2() TO authenticated;
COMMENT ON FUNCTION public.list_my_pending_approvals_compat_v2()
  IS 'Thu Chi V2 §9.4/§10(1019) containment: approval inbox scoped (maker/eligible-approver, current generation). Không lộ payload/candidate list.';

-- get_approval_request_detail_compat_v2: chi tiết tối thiểu cho 1 request actor
-- được xem (maker HOẶC từng là candidate, hoặc super_admin). Không cross-org cho
-- member thường, không payload_snapshot/candidate identities/audit dump.
CREATE OR REPLACE FUNCTION public.get_approval_request_detail_compat_v2(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_uid       uuid := auth.uid();
  r           public.approval_requests;
  v_mem       uuid;
  v_is_super  boolean;
  v_is_maker  boolean := false;
  v_can_decide boolean := false;
  v_steps     jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO r FROM public.approval_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_is_super := public.is_super_admin();

  -- Actor phải là ACTIVE member của org request (member thường: không cross-org).
  SELECT m.id INTO v_mem
  FROM public.organization_memberships m
  WHERE m.user_id = v_uid
    AND m.organization_id = r.organization_id
    AND m.status = 'ACTIVE'
  LIMIT 1;

  IF v_mem IS NULL AND NOT v_is_super THEN
    RETURN NULL;
  END IF;

  v_is_maker := (v_mem IS NOT NULL AND r.maker_membership_id = v_mem);

  -- Được xem nếu: super_admin, maker, hoặc từng là candidate (bất kỳ step/generation).
  IF NOT (
    v_is_super
    OR v_is_maker
    OR (v_mem IS NOT NULL AND EXISTS (
         SELECT 1
         FROM public.approval_request_steps st
         JOIN public.approval_request_step_candidates c
           ON c.request_step_id = st.id
          AND c.organization_id = st.organization_id
         WHERE st.request_id = r.id
           AND st.organization_id = r.organization_id
           AND c.membership_id = v_mem
       ))
  ) THEN
    RETURN NULL;
  END IF;

  -- Actor có thể duyệt ngay bây giờ? (candidate current generation, step PENDING, không phải maker)
  v_can_decide := r.state = 'PENDING_APPROVAL'
    AND NOT v_is_maker
    AND v_mem IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.approval_request_steps st
      JOIN public.approval_request_step_candidates c
        ON c.request_step_id = st.id
       AND c.organization_id = st.organization_id
      WHERE st.request_id = r.id
        AND st.organization_id = r.organization_id
        AND st.status = 'PENDING'
        AND c.membership_id = v_mem
        AND c.generation = st.current_generation
        AND (c.valid_to IS NULL OR c.valid_to > now())
    );

  -- Tóm tắt step (KHÔNG kèm danh tính candidate / decision / audit).
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'step_no',            st.step_no,
           'status',             st.status,
           'mode',               st.mode,
           'min_approvals',      st.min_approvals,
           'current_generation', st.current_generation,
           'candidate_count',    st.candidate_count
         ) ORDER BY st.step_no), '[]'::jsonb)
    INTO v_steps
  FROM public.approval_request_steps st
  WHERE st.request_id = r.id
    AND st.organization_id = r.organization_id;

  RETURN jsonb_build_object(
    'id',            r.id,
    'subject_type',  r.subject_type,
    'subject_id',    r.subject_id,
    'state',         r.state,
    'amount',        r.amount,
    'system_source', r.system_source,
    'cashbook_id',   r.cashbook_id,
    'building_id',   r.building_id,
    'submitted_at',  r.submitted_at,
    'posted_at',     r.posted_at,
    'rule_effect',   r.rule_effect,
    'version',       r.version,
    'is_maker',      v_is_maker,
    'can_decide',    v_can_decide,
    'steps',         v_steps
  );
END;
$fn$;
REVOKE ALL ON FUNCTION public.get_approval_request_detail_compat_v2(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_approval_request_detail_compat_v2(uuid) TO authenticated;
COMMENT ON FUNCTION public.get_approval_request_detail_compat_v2(uuid)
  IS 'Thu Chi V2 §9.4/§10(1019) containment: chi tiết 1 approval request scoped cho actor (maker/candidate/super_admin). Không payload_snapshot/candidate identities/audit.';

COMMIT;

NOTIFY pgrst, 'reload schema';
