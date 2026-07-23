-- Finance V2 (Thu Chi V2) — Stage 5: writers-core (plan §7.1/§7.2/§7.3).
-- Private primitives + public RPCs for the manual voucher lifecycle: create/approve/post/
-- approve-and-post + review state machine + cancel/reverse, with fixed lock order, recheck
-- after lock, canonical_write_operations idempotency, committed-birth-XID guard, no raw-DML
-- fallback. No feature mode changed, no org enrolled.

BEGIN;

-- Finance V2 (Thu Chi V2) — Stage 5: WRITERS-CORE (manual voucher lifecycle).
-- Plan §7.1 private primitives + §7.2 public RPCs + §7.3 atomic order.
-- MANUAL VOUCHER lifecycle only. System-writer adapters (V5/salary/refund/pair/
-- execution/evidence-system) are later stages; only minimal manual evidence
-- attach is implemented here.
-- BODY ONLY: orchestrator wraps in one txn. No BEGIN/COMMIT/NOTIFY. Idempotent.

-- =====================================================================
-- §7.1 PRIVATE PRIMITIVES (app_private, owner-only, SECURITY DEFINER)
-- =====================================================================

-- ---------------------------------------------------------------------
-- resolve_finance_actor_v2(p_organization_id): actor + active membership
-- scoped to a known org. RAISE if no active membership. §7.1.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS app_private.resolve_finance_actor_v2(uuid);
CREATE FUNCTION app_private.resolve_finance_actor_v2(p_organization_id uuid)
RETURNS TABLE(user_id uuid, membership_id uuid, organization_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $resolve_actor_org$
DECLARE
  v_uid uuid;
  v_mid uuid;
BEGIN
  v_uid := app_private.current_uid_v1();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'resolve_finance_actor_v2: authentication required'
      USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'resolve_finance_actor_v2: organization is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT m.id INTO v_mid
  FROM public.organization_memberships m
  WHERE m.user_id = v_uid
    AND m.organization_id = p_organization_id
    AND m.status = 'ACTIVE'
    AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= now()
    AND (m.valid_to IS NULL OR m.valid_to > now())
  ORDER BY m.valid_from DESC
  LIMIT 1;

  IF v_mid IS NULL THEN
    RAISE EXCEPTION 'resolve_finance_actor_v2: no active membership for actor in organization %', p_organization_id
      USING ERRCODE = '42501';
  END IF;

  user_id := v_uid;
  membership_id := v_mid;
  organization_id := p_organization_id;
  RETURN NEXT;
END
$resolve_actor_org$;
REVOKE ALL ON FUNCTION app_private.resolve_finance_actor_v2(uuid) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.resolve_finance_actor_v2(uuid) IS
  'Plan §7.1: resolve actor user_id + active membership in a known org from auth.uid(). RAISE 42501 if none.';

-- No-arg variant: only usable when the actor has exactly ONE active membership
-- (ambiguous otherwise). Delegates to the org-scoped resolver. §7.1.
DROP FUNCTION IF EXISTS app_private.resolve_finance_actor_v2();
CREATE FUNCTION app_private.resolve_finance_actor_v2()
RETURNS TABLE(user_id uuid, membership_id uuid, organization_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $resolve_actor$
DECLARE
  v_uid uuid;
  v_org uuid;
  v_count integer;
BEGIN
  v_uid := app_private.current_uid_v1();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'resolve_finance_actor_v2: authentication required'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(DISTINCT m.organization_id) INTO v_count
  FROM public.organization_memberships m
  WHERE m.user_id = v_uid
    AND m.status = 'ACTIVE'
    AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= now()
    AND (m.valid_to IS NULL OR m.valid_to > now());

  IF v_count = 0 THEN
    RAISE EXCEPTION 'resolve_finance_actor_v2: no active membership for actor'
      USING ERRCODE = '42501';
  ELSIF v_count > 1 THEN
    RAISE EXCEPTION 'resolve_finance_actor_v2: ambiguous membership; org-scoped resolution required'
      USING ERRCODE = '42501';
  END IF;

  SELECT m.organization_id INTO v_org
  FROM public.organization_memberships m
  WHERE m.user_id = v_uid
    AND m.status = 'ACTIVE'
    AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= now()
    AND (m.valid_to IS NULL OR m.valid_to > now())
  LIMIT 1;

  RETURN QUERY SELECT * FROM app_private.resolve_finance_actor_v2(v_org);
END
$resolve_actor$;
REVOKE ALL ON FUNCTION app_private.resolve_finance_actor_v2() FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.resolve_finance_actor_v2() IS
  'Plan §7.1: resolve actor from auth.uid() when exactly one active membership exists.';

-- ---------------------------------------------------------------------
-- finance_v2_has_covering_deny: EMERGENCY_DENY / member DENY / role DENY
-- from the canonical auth graph, covering the target at ORGANIZATION or
-- exact CASHBOOK scope, for any of the possession-money permission keys.
-- Building/AREA-scoped denies are enforced separately by the voucher's
-- building-scoped authorize_tenant_action_v3 checks (no building context
-- here). §6.4 / §7.1.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS app_private.finance_v2_has_covering_deny(uuid, uuid, uuid, text[]);
CREATE FUNCTION app_private.finance_v2_has_covering_deny(
  p_org uuid, p_membership uuid, p_cashbook uuid, p_keys text[]
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $has_deny$
BEGIN
  -- EMERGENCY_DENY: blanket (permission_key NULL) or any of the possession keys.
  IF EXISTS (
    SELECT 1 FROM app_private.tenant_emergency_denies d
    WHERE d.organization_id = p_org
      AND (d.permission_key IS NULL OR d.permission_key = ANY(p_keys))
      AND d.active_from <= now()
      AND (d.expires_at IS NULL OR d.expires_at > now())
  ) THEN
    RETURN true;
  END IF;

  -- Active member DENY covering ORGANIZATION or exact CASHBOOK.
  IF EXISTS (
    SELECT 1
    FROM public.member_permission_overrides o
    JOIN public.member_override_scopes mos
      ON mos.organization_id = o.organization_id AND mos.override_id = o.id
    JOIN public.authorization_scopes s
      ON s.organization_id = mos.organization_id AND s.id = mos.scope_id
    WHERE o.organization_id = p_org
      AND o.membership_id = p_membership
      AND o.permission_key = ANY(p_keys)
      AND o.effect = 'DENY'
      AND o.revoked_at IS NULL
      AND (o.expires_at IS NULL OR o.expires_at > now())
      AND (s.scope_type = 'ORGANIZATION'
           OR (s.scope_type = 'CASHBOOK' AND s.cashbook_id = p_cashbook))
  ) THEN
    RETURN true;
  END IF;

  -- Active role DENY covering ORGANIZATION or exact CASHBOOK.
  IF EXISTS (
    SELECT 1
    FROM public.role_bindings rb
    JOIN public.organization_roles r
      ON r.organization_id = rb.organization_id AND r.id = rb.role_id
     AND COALESCE(r.status, 'ACTIVE') = 'ACTIVE'
    JOIN public.role_permissions rp
      ON rp.organization_id = rb.organization_id
     AND rp.role_id = rb.role_id
     AND rp.permission_key = ANY(p_keys)
     AND rp.effect = 'DENY'
    JOIN public.role_binding_scopes rbs
      ON rbs.organization_id = rb.organization_id AND rbs.role_binding_id = rb.id
    JOIN public.authorization_scopes s
      ON s.organization_id = rbs.organization_id AND s.id = rbs.scope_id
    WHERE rb.organization_id = p_org
      AND rb.membership_id = p_membership
      AND COALESCE(rb.valid_from, '-infinity'::timestamptz) <= now()
      AND (rb.valid_to IS NULL OR rb.valid_to > now())
      AND (s.scope_type = 'ORGANIZATION'
           OR (s.scope_type = 'CASHBOOK' AND s.cashbook_id = p_cashbook))
  ) THEN
    RETURN true;
  END IF;

  RETURN false;
END
$has_deny$;
REVOKE ALL ON FUNCTION app_private.finance_v2_has_covering_deny(uuid, uuid, uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_has_covering_deny(uuid, uuid, uuid, text[]) IS
  'Plan §6.4: covering EMERGENCY/member/role DENY (ORGANIZATION/CASHBOOK scope) for possession-money keys; deny wins over binding.';

-- ---------------------------------------------------------------------
-- assert_cashbook_access_v2: possession-derived positive grant. Resolve
-- an open binding of the required kind for the EXACT cashbook AFTER
-- applying covering DENY. RAISE 42501 otherwise. §6.4 / §7.1.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS app_private.assert_cashbook_access_v2(uuid, uuid, text, uuid);
CREATE FUNCTION app_private.assert_cashbook_access_v2(
  p_org uuid, p_cashbook uuid, p_kind text, p_membership uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $assert_access$
DECLARE
  v_keys text[] := ARRAY['cashbooks.post','income_expenses.create',
                         'income_expenses.reverse','income_expenses.cancel'];
BEGIN
  IF p_kind NOT IN ('CUSTODIAN','KNOWER') THEN
    RAISE EXCEPTION 'assert_cashbook_access_v2: invalid possession kind %', p_kind
      USING ERRCODE = '22023';
  END IF;

  -- Membership must be active and in this tenant.
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
    WHERE m.id = p_membership
      AND m.organization_id = p_org
      AND m.status = 'ACTIVE'
      AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= now()
      AND (m.valid_to IS NULL OR m.valid_to > now())
  ) THEN
    RAISE EXCEPTION 'assert_cashbook_access_v2: membership inactive or cross-tenant'
      USING ERRCODE = '42501';
  END IF;

  -- Target cashbook must exist in tenant and not be deleted.
  IF NOT EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = p_cashbook AND a.organization_id = p_org AND a.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'assert_cashbook_access_v2: cashbook % not found in organization', p_cashbook
      USING ERRCODE = '42501';
  END IF;

  -- Covering DENY wins over any binding.
  IF app_private.finance_v2_has_covering_deny(p_org, p_membership, p_cashbook, v_keys) THEN
    RAISE EXCEPTION 'assert_cashbook_access_v2: access denied by covering DENY on cashbook %', p_cashbook
      USING ERRCODE = '42501';
  END IF;

  -- Positive grant: open possession binding of the required kind on the exact cashbook.
  IF NOT EXISTS (
    SELECT 1 FROM public.cashbook_possession_bindings b
    WHERE b.organization_id = p_org
      AND b.cashbook_id = p_cashbook
      AND b.membership_id = p_membership
      AND b.possession_kind = p_kind
      AND b.valid_from <= now()
      AND (b.valid_to IS NULL OR b.valid_to > now())
  ) THEN
    RAISE EXCEPTION 'assert_cashbook_access_v2: no % possession of cashbook %', p_kind, p_cashbook
      USING ERRCODE = '42501';
  END IF;
END
$assert_access$;
REVOKE ALL ON FUNCTION app_private.assert_cashbook_access_v2(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.assert_cashbook_access_v2(uuid, uuid, text, uuid) IS
  'Plan §6.4/§7.1: possession-derived positive grant after covering DENY; RAISE 42501 on failure.';

-- ---------------------------------------------------------------------
-- assert_income_expense_flow_owner_v2: manual RPC must fail if a system
-- writer owns the subject. Compares flow_kind. §7.1.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS app_private.assert_income_expense_flow_owner_v2(uuid, text);
CREATE FUNCTION app_private.assert_income_expense_flow_owner_v2(
  p_voucher uuid, p_expected_owner text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $assert_owner$
DECLARE
  v_flow_kind text;
BEGIN
  SELECT o.flow_kind INTO v_flow_kind
  FROM app_private.income_expense_flow_ownership o
  WHERE o.income_expense_id = p_voucher;

  -- No ownership row: not claimed by any system writer -> manual RPC allowed.
  IF v_flow_kind IS NULL THEN
    RETURN;
  END IF;

  IF v_flow_kind IS DISTINCT FROM p_expected_owner THEN
    RAISE EXCEPTION 'assert_income_expense_flow_owner_v2: voucher % owned by system flow % (manual RPC expects %)',
      p_voucher, v_flow_kind, p_expected_owner
      USING ERRCODE = '42501';
  END IF;
END
$assert_owner$;
REVOKE ALL ON FUNCTION app_private.assert_income_expense_flow_owner_v2(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.assert_income_expense_flow_owner_v2(uuid, text) IS
  'Plan §7.1: manual lifecycle RPC refuses subjects owned by a system writer flow.';

-- ---------------------------------------------------------------------
-- resolve_business_result_v2: server decides KQKD membership + amount +
-- recognition date; client cannot. §7.1.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS app_private.resolve_business_result_v2(uuid);
CREATE FUNCTION app_private.resolve_business_result_v2(p_voucher uuid)
RETURNS TABLE(counts boolean, kqkd numeric, recognition_date date)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $resolve_br$
DECLARE
  v_org uuid;
  v_vdate date;
BEGIN
  SELECT ie.organization_id, ie.voucher_date INTO v_org, v_vdate
  FROM public.income_expenses ie
  WHERE ie.id = p_voucher;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'resolve_business_result_v2: voucher % not found', p_voucher
      USING ERRCODE = 'P0002';
  END IF;

  SELECT
    COALESCE(bool_or(it.accounting_class = 'PNL'), false),
    COALESCE(sum(it.amount) FILTER (WHERE it.accounting_class = 'PNL'), 0::numeric),
    v_vdate
  INTO counts, kqkd, recognition_date
  FROM public.income_expense_items it
  WHERE it.income_expense_id = p_voucher;

  recognition_date := v_vdate;
  RETURN NEXT;
END
$resolve_br$;
REVOKE ALL ON FUNCTION app_private.resolve_business_result_v2(uuid) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.resolve_business_result_v2(uuid) IS
  'Plan §7.1: server-owned KQKD contribution/amount/recognition_date from voucher items.';

-- ---------------------------------------------------------------------
-- assert_committed_birth_boundary_v2: lock the create operation row,
-- require it committed/completed, source hash + birth_operation match,
-- and birth_txid distinct from the current xact. A nested
-- create->approve/post in one txn therefore FAILS. §6.1 / §7.1 / §7.3.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS app_private.assert_committed_birth_boundary_v2(uuid, uuid);
CREATE FUNCTION app_private.assert_committed_birth_boundary_v2(
  p_operation_id uuid, p_voucher uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $birth_boundary$
DECLARE
  v_org uuid;
  v_birth_op uuid;
  v_birth_txid xid8;
  v_src_hash text;
  v_op app_private.canonical_write_operations;
BEGIN
  SELECT ie.organization_id, ie.birth_operation_id, ie.birth_txid, ie.source_payload_hash
    INTO v_org, v_birth_op, v_birth_txid, v_src_hash
  FROM public.income_expenses ie
  WHERE ie.id = p_voucher;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'assert_committed_birth_boundary_v2: voucher % not found', p_voucher
      USING ERRCODE = 'P0002';
  END IF;

  IF v_birth_op IS NULL OR v_birth_txid IS NULL THEN
    RAISE EXCEPTION 'assert_committed_birth_boundary_v2: voucher % has no birth provenance', p_voucher
      USING ERRCODE = '55000';
  END IF;

  IF p_operation_id IS DISTINCT FROM v_birth_op THEN
    RAISE EXCEPTION 'assert_committed_birth_boundary_v2: birth operation mismatch for voucher %', p_voucher
      USING ERRCODE = '55000';
  END IF;

  -- Lock the create operation row (subject-scoped) FOR UPDATE.
  SELECT * INTO v_op
  FROM app_private.canonical_write_operations o
  WHERE o.organization_id = v_org
    AND o.operation = 'income_expense.create.v2'
    AND o.subject_id = p_voucher
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assert_committed_birth_boundary_v2: create operation not found for voucher %', p_voucher
      USING ERRCODE = '55000';
  END IF;

  IF v_op.completed_at IS NULL THEN
    RAISE EXCEPTION 'assert_committed_birth_boundary_v2: birth create operation not committed'
      USING ERRCODE = '55000';
  END IF;

  IF v_src_hash IS NULL OR v_op.payload_hash IS DISTINCT FROM v_src_hash THEN
    RAISE EXCEPTION 'assert_committed_birth_boundary_v2: birth source hash mismatch for voucher %', p_voucher
      USING ERRCODE = '55000';
  END IF;

  -- The decisive commit-boundary proof.
  IF v_birth_txid IS NOT DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'assert_committed_birth_boundary_v2: create and transition in same transaction (birth boundary not committed)'
      USING ERRCODE = '55000';
  END IF;
END
$birth_boundary$;
REVOKE ALL ON FUNCTION app_private.assert_committed_birth_boundary_v2(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.assert_committed_birth_boundary_v2(uuid, uuid) IS
  'Plan §6.1/§7.3: locks create op, requires committed birth (birth_txid <> pg_current_xact_id()); nested create->approve/post fails.';

-- ---------------------------------------------------------------------
-- Canonical idempotency helpers: reserve/lock a canonical_write_operations
-- row for (org, operation, subject_scope, actor, idempotency_key) with a
-- payload_hash. Same key + same payload replays the stored response; same
-- key + different payload conflicts. §6.1.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS app_private.finance_v2_begin_canonical_op(uuid, text, text, uuid, uuid, text, text, uuid);
CREATE FUNCTION app_private.finance_v2_begin_canonical_op(
  p_org uuid, p_operation text, p_subject_scope text, p_actor uuid,
  p_actor_membership uuid, p_idempotency_key text, p_payload_hash text,
  p_subject_id uuid
)
RETURNS app_private.canonical_write_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $begin_op$
DECLARE
  v_op app_private.canonical_write_operations;
BEGIN
  -- Unconditional unique claim = linearization point. ON CONFLICT waits on an
  -- in-flight claimant; if it aborts we become the claimant, if it commits the
  -- locked reread observes its immutable completion.
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key,
    payload_hash, subject_id, actor_membership_id, transaction_id
  ) VALUES (
    p_org, p_operation, p_subject_scope, p_actor, p_idempotency_key,
    p_payload_hash, p_subject_id, p_actor_membership, pg_current_xact_id()
  )
  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
  DO NOTHING;

  SELECT * INTO v_op
  FROM app_private.canonical_write_operations o
  WHERE o.organization_id = p_org
    AND o.operation = p_operation
    AND o.subject_scope = p_subject_scope
    AND o.actor_id = p_actor
    AND o.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finance_v2_begin_canonical_op: failed to reserve operation %', p_operation
      USING ERRCODE = 'P0002';
  END IF;

  IF v_op.payload_hash IS DISTINCT FROM p_payload_hash THEN
    RAISE EXCEPTION 'finance_v2_begin_canonical_op: idempotency key % reused with a different payload for %',
      p_idempotency_key, p_operation
      USING ERRCODE = '23505';
  END IF;

  RETURN v_op;
END
$begin_op$;
REVOKE ALL ON FUNCTION app_private.finance_v2_begin_canonical_op(uuid, text, text, uuid, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_begin_canonical_op(uuid, text, text, uuid, uuid, text, text, uuid) IS
  'Plan §6.1: reserve/lock the canonical idempotency row; conflict on same key/different payload.';

DROP FUNCTION IF EXISTS app_private.finance_v2_finish_canonical_op(uuid, text, text, uuid, text, uuid, jsonb, text, bigint, bigint, bigint);
CREATE FUNCTION app_private.finance_v2_finish_canonical_op(
  p_org uuid, p_operation text, p_subject_scope text, p_actor uuid,
  p_idempotency_key text, p_subject_id uuid, p_response jsonb, p_outcome text,
  p_review_version bigint, p_approval_version bigint, p_posting_version bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $finish_op$
BEGIN
  UPDATE app_private.canonical_write_operations o
  SET subject_id = COALESCE(o.subject_id, p_subject_id),
      response_payload = p_response,
      completed_at = now(),
      outcome_kind = p_outcome,
      resulting_review_version = p_review_version,
      resulting_approval_version = p_approval_version,
      resulting_posting_version = p_posting_version
  WHERE o.organization_id = p_org
    AND o.operation = p_operation
    AND o.subject_scope = p_subject_scope
    AND o.actor_id = p_actor
    AND o.idempotency_key = p_idempotency_key;
END
$finish_op$;
REVOKE ALL ON FUNCTION app_private.finance_v2_finish_canonical_op(uuid, text, text, uuid, text, uuid, jsonb, text, bigint, bigint, bigint) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_finish_canonical_op(uuid, text, text, uuid, text, uuid, jsonb, text, bigint, bigint, bigint) IS
  'Plan §6.1: complete a reserved canonical op with response + resulting versions + outcome.';

-- ---------------------------------------------------------------------
-- Audit/semantic event append (V2_WRITE provenance). §10.4 log reuse.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS app_private.finance_v2_log_event(uuid, text, uuid, uuid, text);
CREATE FUNCTION app_private.finance_v2_log_event(
  p_org uuid, p_event_kind text, p_voucher uuid, p_actor uuid, p_trace text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $log_event$
BEGIN
  INSERT INTO app_private.finance_v2_semantic_event_log (
    organization_id, event_kind, source_table, source_id, source_kind,
    actor, txid, trace_id
  ) VALUES (
    p_org, p_event_kind, 'public.income_expenses', p_voucher, 'V2_WRITE',
    p_actor, pg_current_xact_id(), p_trace
  );
END
$log_event$;
REVOKE ALL ON FUNCTION app_private.finance_v2_log_event(uuid, text, uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_log_event(uuid, text, uuid, uuid, text) IS
  'Plan §10.4: append an immutable V2_WRITE semantic event for a manual voucher transition.';

-- ---------------------------------------------------------------------
-- Cashbook period open check: posted_on must post-date accounts.lock_date.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS app_private.finance_v2_is_cashbook_period_open(uuid, uuid, date);
CREATE FUNCTION app_private.finance_v2_is_cashbook_period_open(
  p_org uuid, p_cashbook uuid, p_posted_on date
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $period_open$
  SELECT EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = p_cashbook
      AND a.organization_id = p_org
      AND a.deleted_at IS NULL
      AND (a.lock_date IS NULL OR p_posted_on > a.lock_date)
  );
$period_open$;
REVOKE ALL ON FUNCTION app_private.finance_v2_is_cashbook_period_open(uuid, uuid, date) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_is_cashbook_period_open(uuid, uuid, date) IS
  'Plan §7.3: cashbook period is open when posted_on post-dates accounts.lock_date.';

-- ---------------------------------------------------------------------
-- Recognition period open check (profit_close): open unless the latest run
-- for the month is a CLOSE/RECLOSE. §5.3 withdraw gate.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS app_private.finance_v2_is_recognition_period_open(uuid, date);
CREATE FUNCTION app_private.finance_v2_is_recognition_period_open(
  p_org uuid, p_period date
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $recog_open$
DECLARE
  v_last text;
BEGIN
  IF p_period IS NULL THEN
    RETURN true;
  END IF;
  SELECT r.operation INTO v_last
  FROM public.profit_close_runs r
  WHERE r.organization_id = p_org
    AND r.period_month = date_trunc('month', p_period::timestamp)::date
  ORDER BY r.created_at DESC
  LIMIT 1;
  RETURN v_last IS NULL OR v_last NOT IN ('CLOSE','RECLOSE');
END
$recog_open$;
REVOKE ALL ON FUNCTION app_private.finance_v2_is_recognition_period_open(uuid, date) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_is_recognition_period_open(uuid, date) IS
  'Plan §5.3: recognition period open unless the latest profit_close run for the month is CLOSE/RECLOSE.';

-- =====================================================================
-- §7.2 PUBLIC RPCs (SECURITY DEFINER, GRANT EXECUTE TO authenticated)
-- Each: reserve idempotency op; resolve actor; lock voucher/account/binding
-- FOR UPDATE in fixed order; recheck perms after lock; append audit; no
-- raw-table fallback. Ignore any client-sent org/user/approval/posting fields.
-- =====================================================================

-- ---------------------------------------------------------------------
-- create_income_expense_v2(payload) -> jsonb.  §7.2 / §8.
-- Birth UNAPPROVED, review PENDING, posting_status per mode. Stamp maker +
-- birth provenance (server). KNOWER may only create INCOME; CUSTODIAN Thu/Chi.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_income_expense_v2(jsonb);
CREATE FUNCTION public.create_income_expense_v2(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $create_ie$
DECLARE
  v_uid uuid;
  v_mid uuid;
  v_org uuid;
  v_building uuid := (payload->>'buildingId')::uuid;
  v_type text := payload->>'type';
  v_name text := payload->>'name';
  v_vdate date := (payload->>'voucherDate')::date;
  v_total numeric(18,2) := COALESCE((payload->>'totalAmount')::numeric, 0);
  v_notes text := payload->>'notes';
  v_payer text := payload->>'payerName';
  v_mode text := COALESCE(payload->>'postingMode', 'CASHBOOK');
  v_cashbook uuid := (payload->>'cashbookId')::uuid;
  v_idem text := payload->>'idempotencyKey';
  v_hash text := md5(payload::text);
  v_posting_status text;
  v_is_custodian boolean;
  v_is_knower boolean;
  v_keys text[] := ARRAY['cashbooks.post','income_expenses.create',
                         'income_expenses.reverse','income_expenses.cancel'];
  v_voucher_id uuid := gen_random_uuid();
  v_birth_op uuid := gen_random_uuid();
  v_counts boolean;
  v_kqkd numeric;
  v_recog date;
  v_op app_private.canonical_write_operations;
  v_item jsonb;
  v_class text;
  v_resp jsonb;
BEGIN
  IF v_building IS NULL THEN
    RAISE EXCEPTION 'create_income_expense_v2: buildingId is required' USING ERRCODE = '22023';
  END IF;
  IF v_type NOT IN ('INCOME','EXPENSE') THEN
    RAISE EXCEPTION 'create_income_expense_v2: type must be INCOME or EXPENSE' USING ERRCODE = '22023';
  END IF;
  IF v_name IS NULL OR length(btrim(v_name)) = 0 THEN
    RAISE EXCEPTION 'create_income_expense_v2: name is required' USING ERRCODE = '22023';
  END IF;
  IF v_vdate IS NULL THEN
    RAISE EXCEPTION 'create_income_expense_v2: voucherDate is required' USING ERRCODE = '22023';
  END IF;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'create_income_expense_v2: totalAmount must be positive' USING ERRCODE = '22023';
  END IF;
  IF v_mode NOT IN ('CASHBOOK','NON_CASH') THEN
    RAISE EXCEPTION 'create_income_expense_v2: postingMode must be CASHBOOK or NON_CASH' USING ERRCODE = '22023';
  END IF;
  IF v_idem IS NULL OR length(v_idem) = 0 THEN
    RAISE EXCEPTION 'create_income_expense_v2: idempotencyKey is required' USING ERRCODE = '22023';
  END IF;

  -- Resolve tenant from the building, then the actor's active membership.
  SELECT b.organization_id INTO v_org
  FROM public.buildings b WHERE b.id = v_building;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'create_income_expense_v2: building % not found', v_building USING ERRCODE = '42501';
  END IF;
  SELECT r.user_id, r.membership_id INTO v_uid, v_mid
  FROM app_private.resolve_finance_actor_v2(v_org) r;

  -- Idempotency reservation (subject_scope = building; subject_id filled on completion).
  v_op := app_private.finance_v2_begin_canonical_op(
    v_org, 'income_expense.create.v2', v_building::text, v_uid, v_mid, v_idem, v_hash, NULL);
  IF v_op.completed_at IS NOT NULL THEN
    RETURN COALESCE(v_op.response_payload, '{}'::jsonb);
  END IF;

  v_posting_status := CASE WHEN v_mode = 'CASHBOOK' THEN 'UNPOSTED' ELSE 'NOT_APPLICABLE' END;

  -- Possession-derived create permission (CASHBOOK mode only).
  IF v_mode = 'CASHBOOK' THEN
    IF v_cashbook IS NULL THEN
      RAISE EXCEPTION 'create_income_expense_v2: cashbookId is required for a CASHBOOK voucher' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.accounts a
                   WHERE a.id = v_cashbook AND a.organization_id = v_org AND a.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'create_income_expense_v2: cashbook % not found', v_cashbook USING ERRCODE = '42501';
    END IF;
    IF app_private.finance_v2_has_covering_deny(v_org, v_mid, v_cashbook, v_keys) THEN
      RAISE EXCEPTION 'create_income_expense_v2: create denied by covering DENY on cashbook %', v_cashbook USING ERRCODE = '42501';
    END IF;
    v_is_custodian := EXISTS (
      SELECT 1 FROM public.cashbook_possession_bindings b
      WHERE b.organization_id = v_org AND b.cashbook_id = v_cashbook AND b.membership_id = v_mid
        AND b.possession_kind = 'CUSTODIAN' AND b.valid_from <= now()
        AND (b.valid_to IS NULL OR b.valid_to > now()));
    v_is_knower := EXISTS (
      SELECT 1 FROM public.cashbook_possession_bindings b
      WHERE b.organization_id = v_org AND b.cashbook_id = v_cashbook AND b.membership_id = v_mid
        AND b.possession_kind = 'KNOWER' AND b.valid_from <= now()
        AND (b.valid_to IS NULL OR b.valid_to > now()));
    IF v_type = 'EXPENSE' AND NOT v_is_custodian THEN
      RAISE EXCEPTION 'create_income_expense_v2: only a CUSTODIAN may create an EXPENSE on cashbook %', v_cashbook USING ERRCODE = '42501';
    END IF;
    IF v_type = 'INCOME' AND NOT (v_is_custodian OR v_is_knower) THEN
      RAISE EXCEPTION 'create_income_expense_v2: CUSTODIAN or KNOWER possession required to create INCOME on cashbook %', v_cashbook USING ERRCODE = '42501';
    END IF;
  ELSE
    -- NON_CASH manual obligation requires the plain create capability at the building.
    IF NOT (SELECT allowed FROM app_private.authorize_tenant_action_v3(v_uid, v_org, 'income_expenses.create', v_building, NULL)) THEN
      RAISE EXCEPTION 'create_income_expense_v2: income_expenses.create required for a NON_CASH voucher' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Birth the header UNAPPROVED / PENDING, server-owned provenance. Never accept
  -- approved_*/posting/payment fields from the client payload.
  INSERT INTO public.income_expenses (
    id, user_id, type, name, building_id, room_id, tenant_id, voucher_date,
    total_amount, approval_status, notes, payer_name, account_id, organization_id,
    posting_mode, posting_status, review_state, review_version, approval_version,
    posting_version, maker_user_id, maker_membership_id, birth_operation_id,
    birth_txid, source_payload_hash, counts_in_business_result, kqkd_amount,
    recognition_date, recognition_source_mode
  ) VALUES (
    v_voucher_id, v_uid, v_type, v_name, v_building,
    (payload->>'roomId')::uuid, (payload->>'tenantId')::uuid, v_vdate,
    v_total, 'UNAPPROVED', v_notes, v_payer,
    CASE WHEN v_mode = 'CASHBOOK' THEN v_cashbook ELSE NULL END, v_org,
    v_mode, v_posting_status, 'PENDING', 1, 1,
    1, v_uid, v_mid, v_birth_op,
    pg_current_xact_id(), v_hash, true, 0,
    v_vdate, 'BASE'
  );

  -- Items (server classifies accounting_class; default PNL).
  IF jsonb_typeof(payload->'items') = 'array' THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
      v_class := COALESCE(v_item->>'accountingClass', 'PNL');
      IF v_class NOT IN ('PNL','INTERNAL','CUSTOMER_CREDIT','DEPOSIT') THEN
        RAISE EXCEPTION 'create_income_expense_v2: invalid accountingClass %', v_class USING ERRCODE = '22023';
      END IF;
      IF (v_item->>'typeId') IS NULL THEN
        RAISE EXCEPTION 'create_income_expense_v2: each item requires typeId' USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.income_expense_items (
        id, income_expense_id, income_expense_type_id, description, quantity,
        unit_price, amount, notes, start_date, end_date, organization_id, accounting_class
      ) VALUES (
        gen_random_uuid(), v_voucher_id, (v_item->>'typeId')::uuid, v_item->>'description',
        COALESCE((v_item->>'quantity')::integer, 1), COALESCE((v_item->>'unitPrice')::numeric, 0),
        COALESCE((v_item->>'amount')::numeric, 0), v_item->>'notes',
        (v_item->>'startDate')::date, (v_item->>'endDate')::date, v_org, v_class
      );
    END LOOP;
  END IF;

  -- Server-owned business result (refresh header from resolver).
  SELECT br.counts, br.kqkd, br.recognition_date INTO v_counts, v_kqkd, v_recog
  FROM app_private.resolve_business_result_v2(v_voucher_id) br;
  UPDATE public.income_expenses
     SET counts_in_business_result = v_counts, kqkd_amount = v_kqkd, recognition_date = v_recog
   WHERE id = v_voucher_id;

  v_resp := jsonb_build_object(
    'voucherId', v_voucher_id, 'approvalStatus', 'UNAPPROVED',
    'reviewState', 'PENDING', 'postingMode', v_mode, 'postingStatus', v_posting_status,
    'reviewVersion', 1, 'approvalVersion', 1, 'postingVersion', 1);

  PERFORM app_private.finance_v2_finish_canonical_op(
    v_org, 'income_expense.create.v2', v_building::text, v_uid, v_idem, v_voucher_id,
    v_resp, 'CREATED', 1, 1, 1);
  PERFORM app_private.finance_v2_log_event(v_org, 'income_expense.create.v2', v_voucher_id, v_uid, v_idem);
  RETURN v_resp;
END
$create_ie$;
REVOKE ALL ON FUNCTION public.create_income_expense_v2(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_income_expense_v2(jsonb) TO authenticated;
COMMENT ON FUNCTION public.create_income_expense_v2(jsonb) IS
  'Plan §7.2: create a manual voucher (UNAPPROVED/PENDING, posting_status per mode), server-owned maker + birth provenance.';

-- ---------------------------------------------------------------------
-- approve_income_expense_v2 -> jsonb.  §7.2 / §7.3.
-- Requires income_expenses.approve + committed birth boundary. UNAPPROVED->
-- APPROVED, balance unchanged, bump approval_version, review_state RESOLVED.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.approve_income_expense_v2(uuid, bigint, text);
CREATE FUNCTION public.approve_income_expense_v2(
  p_voucher uuid, p_expected_approval_version bigint, p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $approve_ie$
DECLARE
  v_uid uuid;
  v_mid uuid;
  v_ie public.income_expenses;
  v_hash text := md5(jsonb_build_object('voucher', p_voucher, 'eav', p_expected_approval_version)::text);
  v_op app_private.canonical_write_operations;
  v_new_appr bigint;
  v_resp jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'approve_income_expense_v2: idempotency key is required' USING ERRCODE = '22023';
  END IF;

  -- Fixed lock order: voucher first.
  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND OR v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'approve_income_expense_v2: voucher % not found', p_voucher USING ERRCODE = 'P0002';
  END IF;

  SELECT r.user_id, r.membership_id INTO v_uid, v_mid
  FROM app_private.resolve_finance_actor_v2(v_ie.organization_id) r;

  v_op := app_private.finance_v2_begin_canonical_op(
    v_ie.organization_id, 'income_expense.approve.v2', p_voucher::text, v_uid, v_mid,
    p_idempotency_key, v_hash, p_voucher);
  IF v_op.completed_at IS NOT NULL THEN
    RETURN COALESCE(v_op.response_payload, '{}'::jsonb);
  END IF;

  PERFORM app_private.assert_income_expense_flow_owner_v2(p_voucher, 'CANONICAL_INCOME_EXPENSE');

  -- Approver capability in the voucher's building scope.
  IF NOT (SELECT allowed FROM app_private.authorize_tenant_action_v3(
            v_uid, v_ie.organization_id, 'income_expenses.approve', v_ie.building_id, NULL)) THEN
    RAISE EXCEPTION 'approve_income_expense_v2: income_expenses.approve required in scope' USING ERRCODE = '42501';
  END IF;

  -- Committed birth boundary: create must have committed in a prior transaction.
  PERFORM app_private.assert_committed_birth_boundary_v2(v_ie.birth_operation_id, p_voucher);

  IF v_ie.approval_status <> 'UNAPPROVED'
     OR v_ie.review_state NOT IN ('PENDING','CHANGES_REQUESTED') THEN
    RAISE EXCEPTION 'approve_income_expense_v2: voucher not in an approvable state (%, %)',
      v_ie.approval_status, v_ie.review_state USING ERRCODE = '55000';
  END IF;
  IF v_ie.approval_version <> p_expected_approval_version THEN
    RAISE EXCEPTION 'approve_income_expense_v2: approval_version mismatch (expected %, found %)',
      p_expected_approval_version, v_ie.approval_version USING ERRCODE = '55000';
  END IF;

  v_new_appr := v_ie.approval_version + 1;
  UPDATE public.income_expenses ie
     SET approval_status = 'APPROVED', approved_by = v_uid, approved_at = now(),
         review_state = 'RESOLVED', approval_version = v_new_appr, updated_at = now()
   WHERE ie.id = p_voucher;

  -- Close the open PENDING_APPROVAL request (one-open lives only on PENDING_APPROVAL).
  UPDATE public.approval_requests ar
     SET state = 'APPROVED', outcome_kind = 'APPROVED', outcome_reason = NULL,
         closed_by_membership_id = v_mid, closed_at = now()
   WHERE ar.organization_id = v_ie.organization_id
     AND ar.subject_type = 'INCOME_EXPENSE' AND ar.subject_id = p_voucher
     AND ar.state = 'PENDING_APPROVAL';

  v_resp := jsonb_build_object('voucherId', p_voucher, 'approvalStatus', 'APPROVED',
                               'reviewState', 'RESOLVED', 'approvalVersion', v_new_appr);
  PERFORM app_private.finance_v2_finish_canonical_op(
    v_ie.organization_id, 'income_expense.approve.v2', p_voucher::text, v_uid, p_idempotency_key,
    p_voucher, v_resp, 'APPROVED', v_ie.review_version, v_new_appr, v_ie.posting_version);
  PERFORM app_private.finance_v2_log_event(v_ie.organization_id, 'income_expense.approve.v2', p_voucher, v_uid, p_idempotency_key);
  RETURN v_resp;
END
$approve_ie$;
REVOKE ALL ON FUNCTION public.approve_income_expense_v2(uuid, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_income_expense_v2(uuid, bigint, text) TO authenticated;
COMMENT ON FUNCTION public.approve_income_expense_v2(uuid, bigint, text) IS
  'Plan §7.2/§7.3: approve-only UNAPPROVED->APPROVED (balance unchanged); requires committed birth boundary.';

-- ---------------------------------------------------------------------
-- Internal: build + activate ONE manual POSTING event with a signed MAIN
-- line and attach FINALIZED evidence. Returns the new posting id. §6.2/§6.3.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS app_private.finance_v2_post_manual_voucher(public.income_expenses, uuid, uuid, uuid, date, uuid[], text);
CREATE FUNCTION app_private.finance_v2_post_manual_voucher(
  p_ie public.income_expenses, p_actor_user uuid, p_actor_membership uuid,
  p_cashbook uuid, p_posted_on date, p_evidence_ids uuid[], p_idempotency_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $post_manual$
DECLARE
  v_posting_id uuid := gen_random_uuid();
  v_signed numeric(18,2);
  v_ev uuid;
  v_ev_count integer := 0;
BEGIN
  IF p_ie.total_amount <= 0 THEN
    RAISE EXCEPTION 'finance_v2_post_manual_voucher: voucher total must be positive to post' USING ERRCODE = '55000';
  END IF;

  -- At least one FINALIZED evidence for a manual posting.
  IF p_evidence_ids IS NULL OR array_length(p_evidence_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'finance_v2_post_manual_voucher: at least one FINALIZED evidence is required' USING ERRCODE = '55000';
  END IF;

  v_signed := CASE WHEN p_ie.type = 'INCOME' THEN p_ie.total_amount ELSE -p_ie.total_amount END;

  INSERT INTO public.income_expense_postings (
    id, organization_id, voucher_id, posting_subject_kind, posting_subject_id,
    direction, account_id, gross_amount, voucher_amount_snapshot, amount_basis,
    net_cash_effect, posted_on, posted_by_membership_id, posted_by_user_id,
    approval_version, event_kind, idempotency_key, source_kind, posting_generation, created_at
  ) VALUES (
    v_posting_id, p_ie.organization_id, p_ie.id, 'VOUCHER', p_ie.id,
    p_ie.type, p_cashbook, p_ie.total_amount, p_ie.total_amount, 'VOUCHER_TOTAL',
    v_signed, p_posted_on, p_actor_membership, p_actor_user,
    p_ie.approval_version, 'POSTING', p_idempotency_key || ':posting', 'MANUAL', 1, now()
  );

  INSERT INTO public.income_expense_posting_lines (
    id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at
  ) VALUES (
    gen_random_uuid(), p_ie.organization_id, v_posting_id, p_cashbook, 'MAIN', v_signed, now()
  );

  -- Attach evidence: lock FINALIZED rows, link ORIGINAL, flip to ATTACHED.
  FOREACH v_ev IN ARRAY p_evidence_ids LOOP
    PERFORM 1 FROM public.finance_evidence_objects e
     WHERE e.id = v_ev AND e.organization_id = p_ie.organization_id
       AND e.state = 'FINALIZED'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'finance_v2_post_manual_voucher: evidence % is not FINALIZED in tenant', v_ev USING ERRCODE = '55000';
    END IF;
    INSERT INTO public.income_expense_posting_evidence (
      id, organization_id, posting_id, evidence_id, relation_kind, created_at
    ) VALUES (
      gen_random_uuid(), p_ie.organization_id, v_posting_id, v_ev, 'ORIGINAL', now()
    );
    UPDATE public.finance_evidence_objects e SET state = 'ATTACHED' WHERE e.id = v_ev;
    v_ev_count := v_ev_count + 1;
  END LOOP;

  IF v_ev_count = 0 THEN
    RAISE EXCEPTION 'finance_v2_post_manual_voucher: at least one FINALIZED evidence is required' USING ERRCODE = '55000';
  END IF;

  RETURN v_posting_id;
END
$post_manual$;
REVOKE ALL ON FUNCTION app_private.finance_v2_post_manual_voucher(public.income_expenses, uuid, uuid, uuid, date, uuid[], text) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_post_manual_voucher(public.income_expenses, uuid, uuid, uuid, date, uuid[], text) IS
  'Plan §6.2/§6.3: one manual POSTING event + signed MAIN line (VOUCHER_TOTAL) + FINALIZED evidence attach.';

-- ---------------------------------------------------------------------
-- post_approved_income_expense_v2(input) -> jsonb.  §7.2 / §7.3.
-- CUSTODIAN of exact cashbook (no approve). APPROVED+UNPOSTED, open period,
-- >=1 FINALIZED evidence. Create posting + MAIN line, set active pointer,
-- posting_status POSTED, bump posting_version.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.post_approved_income_expense_v2(jsonb);
CREATE FUNCTION public.post_approved_income_expense_v2(input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $post_ie$
DECLARE
  v_uid uuid;
  v_mid uuid;
  v_ie public.income_expenses;
  v_voucher uuid := (input->>'subjectId')::uuid;
  v_cashbook uuid := (input->>'cashbookId')::uuid;
  v_posted_on date := (input->>'postedOn')::date;
  v_idem text := input->>'idempotencyKey';
  v_exp_appr bigint := (input->>'expectedApprovalVersion')::bigint;
  v_exp_post bigint := (input->>'expectedPostingVersion')::bigint;
  v_evidence uuid[] := ARRAY(SELECT jsonb_array_elements_text(COALESCE(input->'evidenceIds','[]'::jsonb))::uuid);
  v_hash text := md5(input::text);
  v_op app_private.canonical_write_operations;
  v_posting_id uuid;
  v_new_post bigint;
  v_resp jsonb;
BEGIN
  IF COALESCE(input->>'subjectKind','VOUCHER') <> 'VOUCHER' THEN
    RAISE EXCEPTION 'post_approved_income_expense_v2: only VOUCHER subjects are supported here' USING ERRCODE = '22023';
  END IF;
  IF v_voucher IS NULL OR v_cashbook IS NULL OR v_posted_on IS NULL OR v_idem IS NULL THEN
    RAISE EXCEPTION 'post_approved_income_expense_v2: subjectId, cashbookId, postedOn, idempotencyKey are required' USING ERRCODE = '22023';
  END IF;

  -- Fixed lock order: voucher, then cashbook account.
  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = v_voucher FOR UPDATE;
  IF NOT FOUND OR v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'post_approved_income_expense_v2: voucher % not found', v_voucher USING ERRCODE = 'P0002';
  END IF;

  SELECT r.user_id, r.membership_id INTO v_uid, v_mid
  FROM app_private.resolve_finance_actor_v2(v_ie.organization_id) r;

  v_op := app_private.finance_v2_begin_canonical_op(
    v_ie.organization_id, 'income_expense.post.v2', v_voucher::text, v_uid, v_mid,
    v_idem, v_hash, v_voucher);
  IF v_op.completed_at IS NOT NULL THEN
    RETURN COALESCE(v_op.response_payload, '{}'::jsonb);
  END IF;

  PERFORM app_private.assert_income_expense_flow_owner_v2(v_voucher, 'CANONICAL_INCOME_EXPENSE');

  PERFORM 1 FROM public.accounts a WHERE a.id = v_cashbook AND a.organization_id = v_ie.organization_id
    AND a.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post_approved_income_expense_v2: cashbook % not found', v_cashbook USING ERRCODE = '42501';
  END IF;

  -- CUSTODIAN of the exact cashbook; no approve capability needed.
  PERFORM app_private.assert_cashbook_access_v2(v_ie.organization_id, v_cashbook, 'CUSTODIAN', v_mid);

  IF v_ie.posting_mode <> 'CASHBOOK' THEN
    RAISE EXCEPTION 'post_approved_income_expense_v2: only CASHBOOK vouchers can be posted' USING ERRCODE = '55000';
  END IF;
  IF v_ie.approval_status <> 'APPROVED' OR v_ie.posting_status <> 'UNPOSTED' THEN
    RAISE EXCEPTION 'post_approved_income_expense_v2: voucher must be APPROVED + UNPOSTED (%, %)',
      v_ie.approval_status, v_ie.posting_status USING ERRCODE = '55000';
  END IF;
  IF v_ie.approval_version <> v_exp_appr OR v_ie.posting_version <> v_exp_post THEN
    RAISE EXCEPTION 'post_approved_income_expense_v2: version mismatch' USING ERRCODE = '55000';
  END IF;
  IF NOT app_private.finance_v2_is_cashbook_period_open(v_ie.organization_id, v_cashbook, v_posted_on) THEN
    RAISE EXCEPTION 'post_approved_income_expense_v2: posted_on % is inside a locked cashbook period', v_posted_on USING ERRCODE = '55000';
  END IF;

  v_posting_id := app_private.finance_v2_post_manual_voucher(
    v_ie, v_uid, v_mid, v_cashbook, v_posted_on, v_evidence, v_idem);

  v_new_post := v_ie.posting_version + 1;
  UPDATE public.income_expenses ie
     SET active_posting_id_v2 = v_posting_id, posting_status = 'POSTED',
         posting_id = v_posting_id, posted_at_v2 = now(),
         posting_version = v_new_post, updated_at = now()
   WHERE ie.id = v_voucher;

  v_resp := jsonb_build_object('voucherId', v_voucher, 'postingId', v_posting_id,
                               'postingStatus', 'POSTED', 'postingVersion', v_new_post);
  PERFORM app_private.finance_v2_finish_canonical_op(
    v_ie.organization_id, 'income_expense.post.v2', v_voucher::text, v_uid, v_idem, v_voucher,
    v_resp, 'POSTED', v_ie.review_version, v_ie.approval_version, v_new_post);
  PERFORM app_private.finance_v2_log_event(v_ie.organization_id, 'income_expense.post.v2', v_voucher, v_uid, v_idem);
  RETURN v_resp;
END
$post_ie$;
REVOKE ALL ON FUNCTION public.post_approved_income_expense_v2(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_approved_income_expense_v2(jsonb) TO authenticated;
COMMENT ON FUNCTION public.post_approved_income_expense_v2(jsonb) IS
  'Plan §7.2/§7.3: CUSTODIAN posts an APPROVED+UNPOSTED voucher; one POSTING event + signed MAIN line; posting_status POSTED.';

-- ---------------------------------------------------------------------
-- approve_and_post_income_expense_v2(input) -> jsonb.  §7.2 / §7.3.
-- Actor is approver AND CUSTODIAN. Approve + post atomically; any failure
-- rolls back the whole transaction.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.approve_and_post_income_expense_v2(jsonb);
CREATE FUNCTION public.approve_and_post_income_expense_v2(input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $approve_post_ie$
DECLARE
  v_uid uuid;
  v_mid uuid;
  v_ie public.income_expenses;
  v_voucher uuid := (input->>'subjectId')::uuid;
  v_cashbook uuid := (input->>'cashbookId')::uuid;
  v_posted_on date := (input->>'postedOn')::date;
  v_idem text := input->>'idempotencyKey';
  v_exp_appr bigint := (input->>'expectedApprovalVersion')::bigint;
  v_exp_post bigint := (input->>'expectedPostingVersion')::bigint;
  v_evidence uuid[] := ARRAY(SELECT jsonb_array_elements_text(COALESCE(input->'evidenceIds','[]'::jsonb))::uuid);
  v_hash text := md5(input::text);
  v_op app_private.canonical_write_operations;
  v_posting_id uuid;
  v_new_appr bigint;
  v_new_post bigint;
  v_resp jsonb;
BEGIN
  IF COALESCE(input->>'subjectKind','VOUCHER') <> 'VOUCHER' THEN
    RAISE EXCEPTION 'approve_and_post_income_expense_v2: only VOUCHER subjects are supported here' USING ERRCODE = '22023';
  END IF;
  IF v_voucher IS NULL OR v_cashbook IS NULL OR v_posted_on IS NULL OR v_idem IS NULL THEN
    RAISE EXCEPTION 'approve_and_post_income_expense_v2: subjectId, cashbookId, postedOn, idempotencyKey are required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = v_voucher FOR UPDATE;
  IF NOT FOUND OR v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'approve_and_post_income_expense_v2: voucher % not found', v_voucher USING ERRCODE = 'P0002';
  END IF;

  SELECT r.user_id, r.membership_id INTO v_uid, v_mid
  FROM app_private.resolve_finance_actor_v2(v_ie.organization_id) r;

  v_op := app_private.finance_v2_begin_canonical_op(
    v_ie.organization_id, 'income_expense.approve_and_post.v2', v_voucher::text, v_uid, v_mid,
    v_idem, v_hash, v_voucher);
  IF v_op.completed_at IS NOT NULL THEN
    RETURN COALESCE(v_op.response_payload, '{}'::jsonb);
  END IF;

  PERFORM app_private.assert_income_expense_flow_owner_v2(v_voucher, 'CANONICAL_INCOME_EXPENSE');

  -- Approver capability + committed birth boundary.
  IF NOT (SELECT allowed FROM app_private.authorize_tenant_action_v3(
            v_uid, v_ie.organization_id, 'income_expenses.approve', v_ie.building_id, NULL)) THEN
    RAISE EXCEPTION 'approve_and_post_income_expense_v2: income_expenses.approve required in scope' USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.assert_committed_birth_boundary_v2(v_ie.birth_operation_id, v_voucher);

  -- Lock cashbook + CUSTODIAN of the exact cashbook.
  PERFORM 1 FROM public.accounts a WHERE a.id = v_cashbook AND a.organization_id = v_ie.organization_id
    AND a.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approve_and_post_income_expense_v2: cashbook % not found', v_cashbook USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.assert_cashbook_access_v2(v_ie.organization_id, v_cashbook, 'CUSTODIAN', v_mid);

  IF v_ie.posting_mode <> 'CASHBOOK' THEN
    RAISE EXCEPTION 'approve_and_post_income_expense_v2: only CASHBOOK vouchers can be posted' USING ERRCODE = '55000';
  END IF;
  IF v_ie.approval_status <> 'UNAPPROVED' OR v_ie.review_state NOT IN ('PENDING','CHANGES_REQUESTED')
     OR v_ie.posting_status <> 'UNPOSTED' THEN
    RAISE EXCEPTION 'approve_and_post_income_expense_v2: voucher not approvable+postable (%, %, %)',
      v_ie.approval_status, v_ie.review_state, v_ie.posting_status USING ERRCODE = '55000';
  END IF;
  IF v_ie.approval_version <> v_exp_appr OR v_ie.posting_version <> v_exp_post THEN
    RAISE EXCEPTION 'approve_and_post_income_expense_v2: version mismatch' USING ERRCODE = '55000';
  END IF;
  IF NOT app_private.finance_v2_is_cashbook_period_open(v_ie.organization_id, v_cashbook, v_posted_on) THEN
    RAISE EXCEPTION 'approve_and_post_income_expense_v2: posted_on % is inside a locked cashbook period', v_posted_on USING ERRCODE = '55000';
  END IF;

  v_new_appr := v_ie.approval_version + 1;
  UPDATE public.income_expenses ie
     SET approval_status = 'APPROVED', approved_by = v_uid, approved_at = now(),
         review_state = 'RESOLVED', approval_version = v_new_appr, updated_at = now()
   WHERE ie.id = v_voucher;
  -- Reload with the fresh approval_version so the posting snapshots it.
  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = v_voucher;

  UPDATE public.approval_requests ar
     SET state = 'APPROVED', outcome_kind = 'APPROVED',
         closed_by_membership_id = v_mid, closed_at = now()
   WHERE ar.organization_id = v_ie.organization_id
     AND ar.subject_type = 'INCOME_EXPENSE' AND ar.subject_id = v_voucher
     AND ar.state = 'PENDING_APPROVAL';

  v_posting_id := app_private.finance_v2_post_manual_voucher(
    v_ie, v_uid, v_mid, v_cashbook, v_posted_on, v_evidence, v_idem);

  v_new_post := v_ie.posting_version + 1;
  UPDATE public.income_expenses ie
     SET active_posting_id_v2 = v_posting_id, posting_status = 'POSTED',
         posting_id = v_posting_id, posted_at_v2 = now(),
         posting_version = v_new_post, updated_at = now()
   WHERE ie.id = v_voucher;

  v_resp := jsonb_build_object('voucherId', v_voucher, 'postingId', v_posting_id,
                               'approvalStatus', 'APPROVED', 'postingStatus', 'POSTED',
                               'approvalVersion', v_new_appr, 'postingVersion', v_new_post);
  PERFORM app_private.finance_v2_finish_canonical_op(
    v_ie.organization_id, 'income_expense.approve_and_post.v2', v_voucher::text, v_uid, v_idem, v_voucher,
    v_resp, 'APPROVED_AND_POSTED', v_ie.review_version, v_new_appr, v_new_post);
  PERFORM app_private.finance_v2_log_event(v_ie.organization_id, 'income_expense.approve_and_post.v2', v_voucher, v_uid, v_idem);
  RETURN v_resp;
END
$approve_post_ie$;
REVOKE ALL ON FUNCTION public.approve_and_post_income_expense_v2(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_and_post_income_expense_v2(jsonb) TO authenticated;
COMMENT ON FUNCTION public.approve_and_post_income_expense_v2(jsonb) IS
  'Plan §7.2/§7.3: atomic approve + post (approver AND CUSTODIAN); full rollback on any failure.';

-- ---------------------------------------------------------------------
-- request_income_expense_changes_v2 -> jsonb.  §5.3 / §7.4.
-- Keep UNAPPROVED, review_state CHANGES_REQUESTED (+reason+field mask),
-- bump review_version, close current request to CHANGES_REQUESTED.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.request_income_expense_changes_v2(uuid, bigint, text, jsonb, text);
CREATE FUNCTION public.request_income_expense_changes_v2(
  p_voucher uuid, p_expected_review_version bigint, p_reason text,
  p_field_mask jsonb, p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $req_changes$
DECLARE
  v_uid uuid; v_mid uuid; v_ie public.income_expenses;
  v_hash text := md5(jsonb_build_object('v', p_voucher, 'erv', p_expected_review_version, 'r', p_reason, 'm', p_field_mask)::text);
  v_op app_private.canonical_write_operations; v_new_rev bigint; v_resp jsonb;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: reason is required' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: idempotency key is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND OR v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: voucher % not found', p_voucher USING ERRCODE = 'P0002';
  END IF;
  SELECT r.user_id, r.membership_id INTO v_uid, v_mid FROM app_private.resolve_finance_actor_v2(v_ie.organization_id) r;

  v_op := app_private.finance_v2_begin_canonical_op(
    v_ie.organization_id, 'income_expense.request_changes.v2', p_voucher::text, v_uid, v_mid,
    p_idempotency_key, v_hash, p_voucher);
  IF v_op.completed_at IS NOT NULL THEN RETURN COALESCE(v_op.response_payload, '{}'::jsonb); END IF;

  PERFORM app_private.assert_income_expense_flow_owner_v2(p_voucher, 'CANONICAL_INCOME_EXPENSE');
  IF NOT (SELECT allowed FROM app_private.authorize_tenant_action_v3(
            v_uid, v_ie.organization_id, 'income_expenses.approve', v_ie.building_id, NULL)) THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: approver capability required in scope' USING ERRCODE = '42501';
  END IF;

  IF v_ie.approval_status <> 'UNAPPROVED' OR v_ie.review_state NOT IN ('PENDING','DISPUTED') THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: voucher not in a requestable state (%, %)',
      v_ie.approval_status, v_ie.review_state USING ERRCODE = '55000';
  END IF;
  IF v_ie.review_version <> p_expected_review_version THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: review_version mismatch' USING ERRCODE = '55000';
  END IF;

  v_new_rev := v_ie.review_version + 1;
  UPDATE public.income_expenses ie
     SET review_state = 'CHANGES_REQUESTED', review_reason = p_reason,
         change_field_mask = p_field_mask, review_version = v_new_rev, updated_at = now()
   WHERE ie.id = p_voucher;

  UPDATE public.approval_requests ar
     SET state = 'CHANGES_REQUESTED', outcome_kind = 'REQUEST_CHANGES', outcome_reason = p_reason,
         closed_by_membership_id = v_mid, closed_at = now()
   WHERE ar.organization_id = v_ie.organization_id
     AND ar.subject_type = 'INCOME_EXPENSE' AND ar.subject_id = p_voucher
     AND ar.state = 'PENDING_APPROVAL';

  v_resp := jsonb_build_object('voucherId', p_voucher, 'approvalStatus', 'UNAPPROVED',
                               'reviewState', 'CHANGES_REQUESTED', 'reviewVersion', v_new_rev);
  PERFORM app_private.finance_v2_finish_canonical_op(
    v_ie.organization_id, 'income_expense.request_changes.v2', p_voucher::text, v_uid, p_idempotency_key,
    p_voucher, v_resp, 'REQUEST_CHANGES', v_new_rev, v_ie.approval_version, v_ie.posting_version);
  PERFORM app_private.finance_v2_log_event(v_ie.organization_id, 'income_expense.request_changes.v2', p_voucher, v_uid, p_idempotency_key);
  RETURN v_resp;
END
$req_changes$;
REVOKE ALL ON FUNCTION public.request_income_expense_changes_v2(uuid, bigint, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_income_expense_changes_v2(uuid, bigint, text, jsonb, text) TO authenticated;
COMMENT ON FUNCTION public.request_income_expense_changes_v2(uuid, bigint, text, jsonb, text) IS
  'Plan §5.3/§7.4: UNAPPROVED->CHANGES_REQUESTED (reason+field mask); close current request CHANGES_REQUESTED.';

-- ---------------------------------------------------------------------
-- reject_invalid_income_expense_v2 -> jsonb.  §5.3 / §7.4.
-- CANCELLED + terminal posting state per mode; review RESOLVED; close
-- request REJECTED. Only unposted vouchers.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.reject_invalid_income_expense_v2(uuid, bigint, text, text);
CREATE FUNCTION public.reject_invalid_income_expense_v2(
  p_voucher uuid, p_expected_review_version bigint, p_reason text, p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $reject_ie$
DECLARE
  v_uid uuid; v_mid uuid; v_ie public.income_expenses;
  v_hash text := md5(jsonb_build_object('v', p_voucher, 'erv', p_expected_review_version, 'r', p_reason)::text);
  v_op app_private.canonical_write_operations; v_new_rev bigint; v_resp jsonb;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reject_invalid_income_expense_v2: reason is required' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'reject_invalid_income_expense_v2: idempotency key is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND OR v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'reject_invalid_income_expense_v2: voucher % not found', p_voucher USING ERRCODE = 'P0002';
  END IF;
  SELECT r.user_id, r.membership_id INTO v_uid, v_mid FROM app_private.resolve_finance_actor_v2(v_ie.organization_id) r;

  v_op := app_private.finance_v2_begin_canonical_op(
    v_ie.organization_id, 'income_expense.reject_invalid.v2', p_voucher::text, v_uid, v_mid,
    p_idempotency_key, v_hash, p_voucher);
  IF v_op.completed_at IS NOT NULL THEN RETURN COALESCE(v_op.response_payload, '{}'::jsonb); END IF;

  PERFORM app_private.assert_income_expense_flow_owner_v2(p_voucher, 'CANONICAL_INCOME_EXPENSE');
  IF NOT (SELECT allowed FROM app_private.authorize_tenant_action_v3(
            v_uid, v_ie.organization_id, 'income_expenses.approve', v_ie.building_id, NULL)) THEN
    RAISE EXCEPTION 'reject_invalid_income_expense_v2: approver capability required in scope' USING ERRCODE = '42501';
  END IF;

  IF v_ie.approval_status <> 'UNAPPROVED' OR v_ie.posting_status = 'POSTED' THEN
    RAISE EXCEPTION 'reject_invalid_income_expense_v2: only an unposted UNAPPROVED voucher can be rejected (%, %)',
      v_ie.approval_status, v_ie.posting_status USING ERRCODE = '55000';
  END IF;
  IF v_ie.review_version <> p_expected_review_version THEN
    RAISE EXCEPTION 'reject_invalid_income_expense_v2: review_version mismatch' USING ERRCODE = '55000';
  END IF;

  v_new_rev := v_ie.review_version + 1;
  UPDATE public.income_expenses ie
     SET approval_status = 'CANCELLED', review_state = 'RESOLVED',
         cancellation_kind = 'REJECTED_INVALID', review_reason = p_reason,
         posting_status = CASE WHEN v_ie.posting_mode = 'NON_CASH' THEN 'NOT_APPLICABLE' ELSE 'UNPOSTED' END,
         review_version = v_new_rev, updated_at = now()
   WHERE ie.id = p_voucher;

  UPDATE public.approval_requests ar
     SET state = 'REJECTED', outcome_kind = 'INVALID_OR_DUPLICATE', outcome_reason = p_reason,
         closed_by_membership_id = v_mid, closed_at = now()
   WHERE ar.organization_id = v_ie.organization_id
     AND ar.subject_type = 'INCOME_EXPENSE' AND ar.subject_id = p_voucher
     AND ar.state = 'PENDING_APPROVAL';

  v_resp := jsonb_build_object('voucherId', p_voucher, 'approvalStatus', 'CANCELLED',
                               'reviewState', 'RESOLVED', 'cancellationKind', 'REJECTED_INVALID',
                               'reviewVersion', v_new_rev);
  PERFORM app_private.finance_v2_finish_canonical_op(
    v_ie.organization_id, 'income_expense.reject_invalid.v2', p_voucher::text, v_uid, p_idempotency_key,
    p_voucher, v_resp, 'INVALID_OR_DUPLICATE', v_new_rev, v_ie.approval_version, v_ie.posting_version);
  PERFORM app_private.finance_v2_log_event(v_ie.organization_id, 'income_expense.reject_invalid.v2', p_voucher, v_uid, p_idempotency_key);
  RETURN v_resp;
END
$reject_ie$;
REVOKE ALL ON FUNCTION public.reject_invalid_income_expense_v2(uuid, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_invalid_income_expense_v2(uuid, bigint, text, text) TO authenticated;
COMMENT ON FUNCTION public.reject_invalid_income_expense_v2(uuid, bigint, text, text) IS
  'Plan §5.3/§7.4: reject-invalid -> CANCELLED + terminal posting state per mode; close request REJECTED.';

-- ---------------------------------------------------------------------
-- mark_income_expense_disputed_v2 -> jsonb.  §5.3 / §7.4.
-- UNAPPROVED + DISPUTED (owner+reason+deadline); keep recognition; close
-- request DISPUTED.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.mark_income_expense_disputed_v2(uuid, bigint, uuid, text, timestamptz, text);
CREATE FUNCTION public.mark_income_expense_disputed_v2(
  p_voucher uuid, p_expected_review_version bigint, p_owner_membership uuid,
  p_reason text, p_deadline timestamptz, p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $dispute_ie$
DECLARE
  v_uid uuid; v_mid uuid; v_ie public.income_expenses;
  v_hash text := md5(jsonb_build_object('v', p_voucher, 'erv', p_expected_review_version, 'o', p_owner_membership, 'r', p_reason, 'd', p_deadline)::text);
  v_op app_private.canonical_write_operations; v_new_rev bigint; v_resp jsonb;
BEGIN
  IF p_owner_membership IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) = 0 OR p_deadline IS NULL THEN
    RAISE EXCEPTION 'mark_income_expense_disputed_v2: owner, reason and deadline are required' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'mark_income_expense_disputed_v2: idempotency key is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND OR v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'mark_income_expense_disputed_v2: voucher % not found', p_voucher USING ERRCODE = 'P0002';
  END IF;
  SELECT r.user_id, r.membership_id INTO v_uid, v_mid FROM app_private.resolve_finance_actor_v2(v_ie.organization_id) r;

  v_op := app_private.finance_v2_begin_canonical_op(
    v_ie.organization_id, 'income_expense.mark_disputed.v2', p_voucher::text, v_uid, v_mid,
    p_idempotency_key, v_hash, p_voucher);
  IF v_op.completed_at IS NOT NULL THEN RETURN COALESCE(v_op.response_payload, '{}'::jsonb); END IF;

  PERFORM app_private.assert_income_expense_flow_owner_v2(p_voucher, 'CANONICAL_INCOME_EXPENSE');
  IF NOT (SELECT allowed FROM app_private.authorize_tenant_action_v3(
            v_uid, v_ie.organization_id, 'income_expenses.approve', v_ie.building_id, NULL)) THEN
    RAISE EXCEPTION 'mark_income_expense_disputed_v2: approver capability required in scope' USING ERRCODE = '42501';
  END IF;

  IF v_ie.approval_status <> 'UNAPPROVED' OR v_ie.review_state NOT IN ('PENDING','CHANGES_REQUESTED') THEN
    RAISE EXCEPTION 'mark_income_expense_disputed_v2: voucher not in a disputable state (%, %)',
      v_ie.approval_status, v_ie.review_state USING ERRCODE = '55000';
  END IF;
  IF v_ie.review_version <> p_expected_review_version THEN
    RAISE EXCEPTION 'mark_income_expense_disputed_v2: review_version mismatch' USING ERRCODE = '55000';
  END IF;

  v_new_rev := v_ie.review_version + 1;
  UPDATE public.income_expenses ie
     SET review_state = 'DISPUTED', review_owner_membership_id = p_owner_membership,
         review_reason = p_reason, review_deadline = p_deadline,
         review_version = v_new_rev, updated_at = now()
   WHERE ie.id = p_voucher;

  UPDATE public.approval_requests ar
     SET state = 'DISPUTED', outcome_kind = 'DISPUTE', outcome_reason = p_reason,
         closed_by_membership_id = v_mid, closed_at = now()
   WHERE ar.organization_id = v_ie.organization_id
     AND ar.subject_type = 'INCOME_EXPENSE' AND ar.subject_id = p_voucher
     AND ar.state = 'PENDING_APPROVAL';

  v_resp := jsonb_build_object('voucherId', p_voucher, 'approvalStatus', 'UNAPPROVED',
                               'reviewState', 'DISPUTED', 'reviewVersion', v_new_rev);
  PERFORM app_private.finance_v2_finish_canonical_op(
    v_ie.organization_id, 'income_expense.mark_disputed.v2', p_voucher::text, v_uid, p_idempotency_key,
    p_voucher, v_resp, 'DISPUTE', v_new_rev, v_ie.approval_version, v_ie.posting_version);
  PERFORM app_private.finance_v2_log_event(v_ie.organization_id, 'income_expense.mark_disputed.v2', p_voucher, v_uid, p_idempotency_key);
  RETURN v_resp;
END
$dispute_ie$;
REVOKE ALL ON FUNCTION public.mark_income_expense_disputed_v2(uuid, bigint, uuid, text, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_income_expense_disputed_v2(uuid, bigint, uuid, text, timestamptz, text) TO authenticated;
COMMENT ON FUNCTION public.mark_income_expense_disputed_v2(uuid, bigint, uuid, text, timestamptz, text) IS
  'Plan §5.3/§7.4: disputed -> UNAPPROVED+DISPUTED (owner+reason+deadline); keep recognition; close request DISPUTED.';

-- ---------------------------------------------------------------------
-- withdraw_income_expense_v2 -> jsonb.  §5.3 / §7.4.
-- Only original human maker; only UNAPPROVED+UNPOSTED with review PENDING/
-- CHANGES_REQUESTED; open recognition period. -> CANCELLED+RESOLVED,
-- cancellation_kind WITHDRAWN_BY_MAKER. Close PENDING request WITHDRAWN;
-- a CHANGES_REQUESTED request stays immutable.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.withdraw_income_expense_v2(uuid, bigint, bigint, text);
CREATE FUNCTION public.withdraw_income_expense_v2(
  p_voucher uuid, p_expected_review_version bigint, p_expected_approval_version bigint, p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $withdraw_ie$
DECLARE
  v_uid uuid; v_mid uuid; v_ie public.income_expenses;
  v_hash text := md5(jsonb_build_object('v', p_voucher, 'erv', p_expected_review_version, 'eav', p_expected_approval_version)::text);
  v_op app_private.canonical_write_operations; v_new_rev bigint; v_resp jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'withdraw_income_expense_v2: idempotency key is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND OR v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'withdraw_income_expense_v2: voucher % not found', p_voucher USING ERRCODE = 'P0002';
  END IF;
  SELECT r.user_id, r.membership_id INTO v_uid, v_mid FROM app_private.resolve_finance_actor_v2(v_ie.organization_id) r;

  v_op := app_private.finance_v2_begin_canonical_op(
    v_ie.organization_id, 'income_expense.withdraw.v2', p_voucher::text, v_uid, v_mid,
    p_idempotency_key, v_hash, p_voucher);
  IF v_op.completed_at IS NOT NULL THEN RETURN COALESCE(v_op.response_payload, '{}'::jsonb); END IF;

  PERFORM app_private.assert_income_expense_flow_owner_v2(p_voucher, 'CANONICAL_INCOME_EXPENSE');

  -- Only the original human maker may withdraw their own voucher; system-generated
  -- vouchers have no maker_user_id and are refused.
  IF v_ie.maker_user_id IS NULL OR v_ie.maker_user_id <> v_uid THEN
    RAISE EXCEPTION 'withdraw_income_expense_v2: only the original maker may withdraw this voucher' USING ERRCODE = '42501';
  END IF;
  IF v_ie.approval_status <> 'UNAPPROVED' OR v_ie.posting_status <> 'UNPOSTED'
     OR v_ie.review_state NOT IN ('PENDING','CHANGES_REQUESTED') THEN
    RAISE EXCEPTION 'withdraw_income_expense_v2: only UNAPPROVED+UNPOSTED PENDING/CHANGES_REQUESTED can be withdrawn (%, %, %)',
      v_ie.approval_status, v_ie.posting_status, v_ie.review_state USING ERRCODE = '55000';
  END IF;
  IF v_ie.review_version <> p_expected_review_version OR v_ie.approval_version <> p_expected_approval_version THEN
    RAISE EXCEPTION 'withdraw_income_expense_v2: version mismatch' USING ERRCODE = '55000';
  END IF;
  IF NOT app_private.finance_v2_is_recognition_period_open(v_ie.organization_id, COALESCE(v_ie.recognition_date, v_ie.voucher_date)) THEN
    RAISE EXCEPTION 'withdraw_income_expense_v2: recognition period is locked; use reopen/adjustment workflow' USING ERRCODE = '55000';
  END IF;

  v_new_rev := v_ie.review_version + 1;
  UPDATE public.income_expenses ie
     SET approval_status = 'CANCELLED', review_state = 'RESOLVED',
         cancellation_kind = 'WITHDRAWN_BY_MAKER', review_version = v_new_rev, updated_at = now()
   WHERE ie.id = p_voucher;

  -- Close a still-open PENDING request as WITHDRAWN; a terminal CHANGES_REQUESTED
  -- request is kept immutable (only the withdrawal audit is appended).
  UPDATE public.approval_requests ar
     SET state = 'WITHDRAWN', outcome_kind = 'MAKER_WITHDRAW',
         closed_by_membership_id = v_mid, closed_at = now()
   WHERE ar.organization_id = v_ie.organization_id
     AND ar.subject_type = 'INCOME_EXPENSE' AND ar.subject_id = p_voucher
     AND ar.state = 'PENDING_APPROVAL';

  v_resp := jsonb_build_object('voucherId', p_voucher, 'approvalStatus', 'CANCELLED',
                               'reviewState', 'RESOLVED', 'cancellationKind', 'WITHDRAWN_BY_MAKER',
                               'reviewVersion', v_new_rev);
  PERFORM app_private.finance_v2_finish_canonical_op(
    v_ie.organization_id, 'income_expense.withdraw.v2', p_voucher::text, v_uid, p_idempotency_key,
    p_voucher, v_resp, 'MAKER_WITHDRAW', v_new_rev, v_ie.approval_version, v_ie.posting_version);
  PERFORM app_private.finance_v2_log_event(v_ie.organization_id, 'income_expense.withdraw.v2', p_voucher, v_uid, p_idempotency_key);
  RETURN v_resp;
END
$withdraw_ie$;
REVOKE ALL ON FUNCTION public.withdraw_income_expense_v2(uuid, bigint, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.withdraw_income_expense_v2(uuid, bigint, bigint, text) TO authenticated;
COMMENT ON FUNCTION public.withdraw_income_expense_v2(uuid, bigint, bigint, text) IS
  'Plan §5.3/§7.4: maker withdraw of an UNAPPROVED+UNPOSTED voucher -> CANCELLED+RESOLVED, WITHDRAWN_BY_MAKER.';

-- ---------------------------------------------------------------------
-- resubmit_income_expense_v2 -> jsonb.  §5.3 / §7.4.
-- Only after CHANGES_REQUESTED; new submission/version back to PENDING.
-- (Fresh approval_requests submission row is created by the approval-engine
-- adapter; this stage advances the header review lifecycle.)
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.resubmit_income_expense_v2(uuid, bigint, jsonb, text);
CREATE FUNCTION public.resubmit_income_expense_v2(
  p_voucher uuid, p_expected_review_version bigint, p_patch jsonb, p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $resubmit_ie$
DECLARE
  v_uid uuid; v_mid uuid; v_ie public.income_expenses;
  v_hash text := md5(jsonb_build_object('v', p_voucher, 'erv', p_expected_review_version, 'p', p_patch)::text);
  v_op app_private.canonical_write_operations; v_new_rev bigint; v_resp jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: idempotency key is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND OR v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: voucher % not found', p_voucher USING ERRCODE = 'P0002';
  END IF;
  SELECT r.user_id, r.membership_id INTO v_uid, v_mid FROM app_private.resolve_finance_actor_v2(v_ie.organization_id) r;

  v_op := app_private.finance_v2_begin_canonical_op(
    v_ie.organization_id, 'income_expense.resubmit.v2', p_voucher::text, v_uid, v_mid,
    p_idempotency_key, v_hash, p_voucher);
  IF v_op.completed_at IS NOT NULL THEN RETURN COALESCE(v_op.response_payload, '{}'::jsonb); END IF;

  PERFORM app_private.assert_income_expense_flow_owner_v2(p_voucher, 'CANONICAL_INCOME_EXPENSE');

  -- Only the original maker resubmits after changes were requested.
  IF v_ie.maker_user_id IS NULL OR v_ie.maker_user_id <> v_uid THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: only the original maker may resubmit' USING ERRCODE = '42501';
  END IF;
  IF v_ie.approval_status <> 'UNAPPROVED' OR v_ie.review_state <> 'CHANGES_REQUESTED' THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: only a CHANGES_REQUESTED voucher can be resubmitted (%, %)',
      v_ie.approval_status, v_ie.review_state USING ERRCODE = '55000';
  END IF;
  IF v_ie.review_version <> p_expected_review_version THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: review_version mismatch' USING ERRCODE = '55000';
  END IF;
  -- Guard: no PENDING request may remain open before a fresh submission.
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.organization_id = v_ie.organization_id
               AND ar.subject_type = 'INCOME_EXPENSE' AND ar.subject_id = p_voucher
               AND ar.state = 'PENDING_APPROVAL') THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: an open approval request already exists' USING ERRCODE = '55000';
  END IF;

  v_new_rev := v_ie.review_version + 1;
  UPDATE public.income_expenses ie
     SET review_state = 'PENDING', review_reason = NULL, change_field_mask = NULL,
         review_version = v_new_rev, updated_at = now()
   WHERE ie.id = p_voucher;

  v_resp := jsonb_build_object('voucherId', p_voucher, 'approvalStatus', 'UNAPPROVED',
                               'reviewState', 'PENDING', 'reviewVersion', v_new_rev);
  PERFORM app_private.finance_v2_finish_canonical_op(
    v_ie.organization_id, 'income_expense.resubmit.v2', p_voucher::text, v_uid, p_idempotency_key,
    p_voucher, v_resp, 'RESUBMITTED', v_new_rev, v_ie.approval_version, v_ie.posting_version);
  PERFORM app_private.finance_v2_log_event(v_ie.organization_id, 'income_expense.resubmit.v2', p_voucher, v_uid, p_idempotency_key);
  RETURN v_resp;
END
$resubmit_ie$;
REVOKE ALL ON FUNCTION public.resubmit_income_expense_v2(uuid, bigint, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resubmit_income_expense_v2(uuid, bigint, jsonb, text) TO authenticated;
COMMENT ON FUNCTION public.resubmit_income_expense_v2(uuid, bigint, jsonb, text) IS
  'Plan §5.3/§7.4: resubmit after CHANGES_REQUESTED -> new review submission back to PENDING.';

-- ---------------------------------------------------------------------
-- cancel_unposted_income_expense_v2 -> jsonb.  §7.2.
-- Cancel only unposted; requires income_expenses.cancel; -> CANCELLED +
-- RESOLVED; close open request CANCELLED.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.cancel_unposted_income_expense_v2(uuid, bigint, bigint, text, text);
CREATE FUNCTION public.cancel_unposted_income_expense_v2(
  p_voucher uuid, p_expected_review_version bigint, p_expected_approval_version bigint,
  p_reason text, p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $cancel_ie$
DECLARE
  v_uid uuid; v_mid uuid; v_ie public.income_expenses;
  v_hash text := md5(jsonb_build_object('v', p_voucher, 'erv', p_expected_review_version, 'eav', p_expected_approval_version, 'r', p_reason)::text);
  v_op app_private.canonical_write_operations; v_new_rev bigint; v_resp jsonb;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'cancel_unposted_income_expense_v2: reason is required' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'cancel_unposted_income_expense_v2: idempotency key is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND OR v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'cancel_unposted_income_expense_v2: voucher % not found', p_voucher USING ERRCODE = 'P0002';
  END IF;
  SELECT r.user_id, r.membership_id INTO v_uid, v_mid FROM app_private.resolve_finance_actor_v2(v_ie.organization_id) r;

  v_op := app_private.finance_v2_begin_canonical_op(
    v_ie.organization_id, 'income_expense.cancel_unposted.v2', p_voucher::text, v_uid, v_mid,
    p_idempotency_key, v_hash, p_voucher);
  IF v_op.completed_at IS NOT NULL THEN RETURN COALESCE(v_op.response_payload, '{}'::jsonb); END IF;

  PERFORM app_private.assert_income_expense_flow_owner_v2(p_voucher, 'CANONICAL_INCOME_EXPENSE');
  IF NOT (SELECT allowed FROM app_private.authorize_tenant_action_v3(
            v_uid, v_ie.organization_id, 'income_expenses.cancel', v_ie.building_id, NULL)) THEN
    RAISE EXCEPTION 'cancel_unposted_income_expense_v2: income_expenses.cancel required in scope' USING ERRCODE = '42501';
  END IF;

  IF v_ie.posting_status = 'POSTED' OR v_ie.active_posting_id_v2 IS NOT NULL THEN
    RAISE EXCEPTION 'cancel_unposted_income_expense_v2: a posted voucher must be reversed, not cancelled' USING ERRCODE = '55000';
  END IF;
  IF v_ie.approval_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'cancel_unposted_income_expense_v2: voucher already cancelled' USING ERRCODE = '55000';
  END IF;
  IF v_ie.review_version <> p_expected_review_version OR v_ie.approval_version <> p_expected_approval_version THEN
    RAISE EXCEPTION 'cancel_unposted_income_expense_v2: version mismatch' USING ERRCODE = '55000';
  END IF;

  v_new_rev := v_ie.review_version + 1;
  UPDATE public.income_expenses ie
     SET approval_status = 'CANCELLED', review_state = 'RESOLVED',
         cancellation_kind = 'CANCELLED_UNPOSTED', review_reason = p_reason,
         posting_status = CASE WHEN v_ie.posting_mode = 'NON_CASH' THEN 'NOT_APPLICABLE' ELSE 'UNPOSTED' END,
         review_version = v_new_rev, updated_at = now()
   WHERE ie.id = p_voucher;

  UPDATE public.approval_requests ar
     SET state = 'CANCELLED', outcome_kind = 'CANCELLED', outcome_reason = p_reason,
         closed_by_membership_id = v_mid, closed_at = now()
   WHERE ar.organization_id = v_ie.organization_id
     AND ar.subject_type = 'INCOME_EXPENSE' AND ar.subject_id = p_voucher
     AND ar.state = 'PENDING_APPROVAL';

  v_resp := jsonb_build_object('voucherId', p_voucher, 'approvalStatus', 'CANCELLED',
                               'reviewState', 'RESOLVED', 'reviewVersion', v_new_rev);
  PERFORM app_private.finance_v2_finish_canonical_op(
    v_ie.organization_id, 'income_expense.cancel_unposted.v2', p_voucher::text, v_uid, p_idempotency_key,
    p_voucher, v_resp, 'CANCELLED', v_new_rev, v_ie.approval_version, v_ie.posting_version);
  PERFORM app_private.finance_v2_log_event(v_ie.organization_id, 'income_expense.cancel_unposted.v2', p_voucher, v_uid, p_idempotency_key);
  RETURN v_resp;
END
$cancel_ie$;
REVOKE ALL ON FUNCTION public.cancel_unposted_income_expense_v2(uuid, bigint, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_unposted_income_expense_v2(uuid, bigint, bigint, text, text) TO authenticated;
COMMENT ON FUNCTION public.cancel_unposted_income_expense_v2(uuid, bigint, bigint, text, text) IS
  'Plan §7.2: cancel an unposted voucher with reason/audit; posted vouchers must be reversed.';

-- ---------------------------------------------------------------------
-- reverse_posted_income_expense_v2 -> jsonb.  §7.2 / §6.2.
-- reverse capability + CUSTODIAN; open cashbook period. Append a REVERSAL
-- event (never mutate the original) with opposing signed lines; clear active
-- pointer, posting_status REVERSED, bump posting_version.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.reverse_posted_income_expense_v2(uuid, uuid, date, text, text);
CREATE FUNCTION public.reverse_posted_income_expense_v2(
  p_voucher uuid, p_cashbook uuid, p_posted_on date, p_reason text, p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $reverse_ie$
DECLARE
  v_uid uuid; v_mid uuid; v_ie public.income_expenses;
  v_orig public.income_expense_postings;
  v_hash text := md5(jsonb_build_object('v', p_voucher, 'cb', p_cashbook, 'on', p_posted_on, 'r', p_reason)::text);
  v_op app_private.canonical_write_operations;
  v_rev_id uuid := gen_random_uuid();
  v_line record;
  v_new_post bigint;
  v_resp jsonb;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2: reason is required' USING ERRCODE = '22023';
  END IF;
  IF p_cashbook IS NULL OR p_posted_on IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2: cashbook, postedOn and idempotency key are required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND OR v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2: voucher % not found', p_voucher USING ERRCODE = 'P0002';
  END IF;
  SELECT r.user_id, r.membership_id INTO v_uid, v_mid FROM app_private.resolve_finance_actor_v2(v_ie.organization_id) r;

  v_op := app_private.finance_v2_begin_canonical_op(
    v_ie.organization_id, 'income_expense.reverse.v2', p_voucher::text, v_uid, v_mid,
    p_idempotency_key, v_hash, p_voucher);
  IF v_op.completed_at IS NOT NULL THEN RETURN COALESCE(v_op.response_payload, '{}'::jsonb); END IF;

  PERFORM app_private.assert_income_expense_flow_owner_v2(p_voucher, 'CANONICAL_INCOME_EXPENSE');

  -- Reverse capability + CUSTODIAN of the exact cashbook.
  IF NOT (SELECT allowed FROM app_private.authorize_tenant_action_v3(
            v_uid, v_ie.organization_id, 'income_expenses.reverse', v_ie.building_id, NULL)) THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2: income_expenses.reverse required in scope' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.accounts a WHERE a.id = p_cashbook AND a.organization_id = v_ie.organization_id
    AND a.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2: cashbook % not found', p_cashbook USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.assert_cashbook_access_v2(v_ie.organization_id, p_cashbook, 'CUSTODIAN', v_mid);

  IF v_ie.approval_status <> 'APPROVED' OR v_ie.posting_status <> 'POSTED' OR v_ie.active_posting_id_v2 IS NULL THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2: only an APPROVED+POSTED voucher can be reversed (%, %)',
      v_ie.approval_status, v_ie.posting_status USING ERRCODE = '55000';
  END IF;
  IF NOT app_private.finance_v2_is_cashbook_period_open(v_ie.organization_id, p_cashbook, p_posted_on) THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2: posted_on % is inside a locked cashbook period', p_posted_on USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_orig FROM public.income_expense_postings p WHERE p.id = v_ie.active_posting_id_v2 FOR UPDATE;
  IF NOT FOUND OR v_orig.event_kind <> 'POSTING' THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2: active posting not found for voucher %', p_voucher USING ERRCODE = '55000';
  END IF;
  IF v_orig.account_id <> p_cashbook THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2: cashbook does not match the original posting' USING ERRCODE = '55000';
  END IF;

  -- New REVERSAL event (original is never mutated).
  INSERT INTO public.income_expense_postings (
    id, organization_id, voucher_id, posting_subject_kind, posting_subject_id,
    direction, account_id, gross_amount, voucher_amount_snapshot, amount_basis,
    net_cash_effect, posted_on, posted_by_membership_id, posted_by_user_id,
    approval_version, event_kind, idempotency_key, source_kind, posting_generation,
    reversal_of_id, reversal_reason, created_at
  ) VALUES (
    v_rev_id, v_orig.organization_id, v_orig.voucher_id, v_orig.posting_subject_kind, v_orig.posting_subject_id,
    v_orig.direction, v_orig.account_id, v_orig.gross_amount, v_orig.voucher_amount_snapshot, v_orig.amount_basis,
    -v_orig.net_cash_effect, p_posted_on, v_mid, v_uid,
    v_orig.approval_version, 'REVERSAL', p_idempotency_key || ':reversal', 'MANUAL', v_orig.posting_generation,
    v_orig.id, p_reason, now()
  );

  -- Opposing signed lines for every original line.
  FOR v_line IN
    SELECT * FROM public.income_expense_posting_lines l WHERE l.posting_id = v_orig.id
  LOOP
    INSERT INTO public.income_expense_posting_lines (
      id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at
    ) VALUES (
      gen_random_uuid(), v_line.organization_id, v_rev_id, v_line.account_id, 'REVERSAL', -v_line.signed_amount, now()
    );
  END LOOP;

  v_new_post := v_ie.posting_version + 1;
  UPDATE public.income_expenses ie
     SET active_posting_id_v2 = NULL, posting_status = 'REVERSED',
         reversed_by_posting_id = v_rev_id, posting_version = v_new_post, updated_at = now()
   WHERE ie.id = p_voucher;

  v_resp := jsonb_build_object('voucherId', p_voucher, 'reversalPostingId', v_rev_id,
                               'postingStatus', 'REVERSED', 'postingVersion', v_new_post);
  PERFORM app_private.finance_v2_finish_canonical_op(
    v_ie.organization_id, 'income_expense.reverse.v2', p_voucher::text, v_uid, p_idempotency_key,
    p_voucher, v_resp, 'REVERSED', v_ie.review_version, v_ie.approval_version, v_new_post);
  PERFORM app_private.finance_v2_log_event(v_ie.organization_id, 'income_expense.reverse.v2', p_voucher, v_uid, p_idempotency_key);
  RETURN v_resp;
END
$reverse_ie$;
REVOKE ALL ON FUNCTION public.reverse_posted_income_expense_v2(uuid, uuid, date, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reverse_posted_income_expense_v2(uuid, uuid, date, text, text) TO authenticated;
COMMENT ON FUNCTION public.reverse_posted_income_expense_v2(uuid, uuid, date, text, text) IS
  'Plan §7.2/§6.2: reverse a POSTED voucher via a new REVERSAL event with opposing lines; never mutate the original.';

COMMIT;

NOTIFY pgrst, 'reload schema';
