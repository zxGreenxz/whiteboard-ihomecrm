-- =============================================================================
-- Sprint 4c — Approval engine RPCs (ADDITIVE; chưa wired vào UI). (§12.5–12.6)
--   _eval_approval_rule, submit_financial_voucher, decide_financial_voucher,
--   emergency_approve_financial. Maker-checker; rule precedence deterministic;
--   post = income_expenses APPROVED + posting metadata trong cùng transaction.
-- =============================================================================

BEGIN;

-- Rule evaluation: DENY > force REQUIRE_APPROVAL > (auto/normal by priority) > fallback.
CREATE OR REPLACE FUNCTION public._eval_approval_rule(
  p_org uuid, p_amount numeric, p_txn_type text, p_system_source text,
  p_category uuid, p_cashbook uuid, p_building uuid)
 RETURNS TABLE(rule_set_id uuid, version integer, rule_id uuid, effect text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
  WITH aset AS (
    SELECT id, version FROM public.approval_rule_sets
    WHERE organization_id=p_org AND transaction_domain='FINANCIAL_VOUCHER' AND status='ACTIVE'
      AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
    ORDER BY version DESC LIMIT 1
  ),
  matches AS (
    SELECT r.id, r.effect, r.priority, r.is_fallback, s.id AS rs_id, s.version AS rs_ver,
      CASE WHEN r.effect='DENY' THEN 0
           WHEN r.effect='REQUIRE_APPROVAL' AND r.force_match THEN 1
           ELSE 2 END AS eff_rank
    FROM public.approval_rules r JOIN aset s ON r.rule_set_id=s.id
    WHERE r.active AND (
      r.is_fallback OR (
        (r.transaction_type IS NULL OR r.transaction_type=p_txn_type)
        AND (r.system_source IS NULL OR r.system_source=p_system_source)
        AND (r.category_id IS NULL OR r.category_id=p_category)
        AND (r.cashbook_id IS NULL OR r.cashbook_id=p_cashbook)
        AND (r.building_id IS NULL OR r.building_id=p_building)
        AND (r.amount_min IS NULL OR p_amount >= r.amount_min)
        AND (r.amount_max IS NULL OR p_amount <= r.amount_max)
      )
    )
  )
  SELECT rs_id, rs_ver, id, effect FROM matches
  ORDER BY is_fallback ASC, eff_rank ASC, priority ASC LIMIT 1;
$fn$;

-- Post a voucher (shared): APPROVED + posting metadata + request POSTED. Internal only.
CREATE OR REPLACE FUNCTION public._post_financial_voucher(p_voucher uuid, p_request uuid, p_actor uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_posting uuid := gen_random_uuid();
BEGIN
  UPDATE public.income_expenses
     SET approval_status='APPROVED', approved_by=p_actor, approved_at=now(),
         approval_request_id=p_request, posting_id=v_posting, posted_at_v2=now()
   WHERE id=p_voucher AND deleted_at IS NULL;
  UPDATE public.approval_requests
     SET state='POSTED', posted_at=now(), posted_event_id=v_posting, version=version+1
   WHERE id=p_request;
  RETURN v_posting;
END; $fn$;

-- Submit a voucher into the engine. auth.uid() = maker.
CREATE OR REPLACE FUNCTION public.submit_financial_voucher(
  p_voucher uuid, p_idempotency_key text DEFAULT NULL,
  p_system_source text DEFAULT NULL, p_txn_type text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v record;
  v_org uuid; v_mem uuid; v_amount numeric;
  v_rule record; v_req uuid; v_state text; v_step uuid; v_cand int;
  v_existing uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
  SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiếu' USING ERRCODE='P0002'; END IF;
  v_org := v.organization_id; v_amount := COALESCE(v.total_amount,0);

  SELECT id INTO v_mem FROM public.organization_memberships
   WHERE user_id=v_uid AND organization_id=v_org AND status='ACTIVE' LIMIT 1;
  IF v_mem IS NULL AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Bạn không thuộc tổ chức của phiếu' USING ERRCODE='42501';
  END IF;
  IF v_mem IS NULL THEN
    SELECT id INTO v_mem FROM public.organization_memberships WHERE organization_id=v_org AND member_type='OWNER' LIMIT 1;
  END IF;

  -- Idempotency / one-open-request: nếu đã có request OPEN cho subject, trả lại.
  SELECT id INTO v_existing FROM public.approval_requests
   WHERE organization_id=v_org AND subject_type='FINANCIAL_VOUCHER' AND subject_id=p_voucher
     AND state IN ('PENDING_APPROVAL','POSTED') LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'request_id',v_existing,'idempotent',true);
  END IF;

  SELECT * INTO v_rule FROM public._eval_approval_rule(v_org, v_amount, p_txn_type, p_system_source, NULL, v.account_id, v.building_id);
  IF v_rule.rule_id IS NULL THEN
    RAISE EXCEPTION 'Không có rule set ACTIVE — fail closed' USING ERRCODE='42501';
  END IF;

  v_state := CASE v_rule.effect WHEN 'AUTO_POST' THEN 'POSTED' WHEN 'DENY' THEN 'DENIED' ELSE 'PENDING_APPROVAL' END;

  INSERT INTO public.approval_requests (organization_id, subject_type, subject_id, state,
      maker_membership_id, maker_user_id, rule_set_id, rule_set_version, matched_rule_id, rule_effect,
      payload_snapshot, payload_hash, amount, cashbook_id, building_id, system_source)
  VALUES (v_org, 'FINANCIAL_VOUCHER', p_voucher, v_state, v_mem, v_uid,
      v_rule.rule_set_id, v_rule.version, v_rule.rule_id, v_rule.effect,
      to_jsonb(v), md5(to_jsonb(v)::text), v_amount, v.account_id, v.building_id, p_system_source)
  RETURNING id INTO v_req;

  IF v_rule.effect='AUTO_POST' THEN
    PERFORM public._post_financial_voucher(p_voucher, v_req, v_uid);
  ELSIF v_rule.effect='REQUIRE_APPROVAL' THEN
    -- create step 1 + candidates (PERMISSION income_expenses.approve, exclude maker).
    INSERT INTO public.approval_request_steps (organization_id, request_id, step_no, status, mode, min_approvals, candidate_count)
    VALUES (v_org, v_req, 1, 'PENDING', 'ANY', 1, 0) RETURNING id INTO v_step;
    INSERT INTO public.approval_request_step_candidates (organization_id, request_step_id, membership_id, generation, source_kind)
    SELECT v_org, v_step, m.id, 1, 'PERMISSION'
    FROM public.organization_memberships m
    WHERE m.organization_id=v_org AND m.status='ACTIVE' AND m.id <> v_mem
      AND (m.member_type='OWNER'
           OR EXISTS(SELECT 1 FROM public.super_admins s WHERE s.user_id=m.user_id)
           OR (public.effective_perms_v2(m.user_id, v_org) -> 'income_expenses' ->> 'approve')='true');
    GET DIAGNOSTICS v_cand = ROW_COUNT;
    UPDATE public.approval_request_steps SET candidate_count=v_cand WHERE id=v_step;
    IF v_cand < 1 THEN
      RAISE EXCEPTION 'Không có người duyệt đủ điều kiện (fail closed)' USING ERRCODE='42501';
    END IF;
  END IF;

  RETURN jsonb_build_object('ok',true,'request_id',v_req,'effect',v_rule.effect,'state',v_state);
END; $fn$;

-- Decide (approve/reject). Maker-checker + candidate + quorum + post.
CREATE OR REPLACE FUNCTION public.decide_financial_voucher(
  p_request uuid, p_decision text, p_reason text DEFAULT NULL, p_expected_version bigint DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  r public.approval_requests; st public.approval_request_steps;
  v_mem uuid; v_cand uuid; v_approvals int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_decision NOT IN ('APPROVE','REJECT') THEN RAISE EXCEPTION 'decision không hợp lệ'; END IF;
  SELECT * INTO r FROM public.approval_requests WHERE id=p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy request' USING ERRCODE='P0002'; END IF;
  IF r.state <> 'PENDING_APPROVAL' THEN RAISE EXCEPTION 'Request không ở trạng thái chờ duyệt (%).', r.state; END IF;
  IF p_expected_version IS NOT NULL AND r.version <> p_expected_version THEN
    RAISE EXCEPTION 'Xung đột phiên bản (CAS)' USING ERRCODE='40001'; END IF;

  SELECT id INTO v_mem FROM public.organization_memberships
   WHERE user_id=v_uid AND organization_id=r.organization_id AND status='ACTIVE' LIMIT 1;
  IF v_mem IS NULL THEN RAISE EXCEPTION 'Bạn không thuộc tổ chức' USING ERRCODE='42501'; END IF;

  -- Maker-checker: người tạo KHÔNG tự duyệt.
  IF v_mem = r.maker_membership_id OR v_uid = r.maker_user_id THEN
    RAISE EXCEPTION 'Người tạo phiếu không được tự duyệt (maker-checker)' USING ERRCODE='42501';
  END IF;

  SELECT * INTO st FROM public.approval_request_steps
   WHERE request_id=p_request AND status='PENDING' ORDER BY step_no LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không có bước đang chờ'; END IF;

  -- Actor phải là candidate hiện tại.
  SELECT id INTO v_cand FROM public.approval_request_step_candidates
   WHERE request_step_id=st.id AND membership_id=v_mem AND generation=st.current_generation
     AND (valid_to IS NULL OR valid_to > now());
  IF v_cand IS NULL THEN RAISE EXCEPTION 'Bạn không nằm trong danh sách người duyệt bước này' USING ERRCODE='42501'; END IF;

  INSERT INTO public.approval_decisions (organization_id, request_id, request_step_id, candidate_id,
      candidate_generation, actor_membership_id, actor_user_id, decision, reason, request_version)
  VALUES (r.organization_id, p_request, st.id, v_cand, st.current_generation, v_mem, v_uid, p_decision, p_reason, r.version);

  IF p_decision='REJECT' THEN
    UPDATE public.approval_request_steps SET status='REJECTED' WHERE id=st.id;
    UPDATE public.approval_request_steps SET status='CANCELLED' WHERE request_id=p_request AND status='WAITING';
    UPDATE public.approval_requests SET state='REJECTED', version=version+1 WHERE id=p_request;
    RETURN jsonb_build_object('ok',true,'state','REJECTED');
  END IF;

  -- APPROVE: đếm quorum của step (normal APPROVE, current generation).
  SELECT count(*) INTO v_approvals FROM public.approval_decisions d
   WHERE d.request_step_id=st.id AND d.decision='APPROVE' AND d.candidate_generation=st.current_generation;
  IF v_approvals >= st.min_approvals THEN
    UPDATE public.approval_request_steps SET status='APPROVED' WHERE id=st.id;
    -- promote next WAITING step, else post.
    IF EXISTS(SELECT 1 FROM public.approval_request_steps WHERE request_id=p_request AND status='WAITING') THEN
      UPDATE public.approval_request_steps SET status='PENDING'
       WHERE id=(SELECT id FROM public.approval_request_steps WHERE request_id=p_request AND status='WAITING' ORDER BY step_no LIMIT 1);
      UPDATE public.approval_requests SET version=version+1 WHERE id=p_request;
      RETURN jsonb_build_object('ok',true,'state','PENDING_APPROVAL','promoted',true);
    ELSE
      PERFORM public._post_financial_voucher(r.subject_id, p_request, v_uid);
      RETURN jsonb_build_object('ok',true,'state','POSTED');
    END IF;
  END IF;
  UPDATE public.approval_requests SET version=version+1 WHERE id=p_request;
  RETURN jsonb_build_object('ok',true,'state','PENDING_APPROVAL','approvals',v_approvals);
END; $fn$;

-- Grants: authenticated có thể submit/decide (guard nội bộ). Internal helpers revoke.
REVOKE ALL ON FUNCTION public._eval_approval_rule(uuid,numeric,text,text,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._post_financial_voucher(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_financial_voucher(uuid,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_financial_voucher(uuid,text,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.decide_financial_voucher(uuid,text,text,bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_financial_voucher(uuid,text,text,bigint) TO authenticated;

COMMIT;
