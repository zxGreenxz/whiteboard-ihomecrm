-- =============================================================================
-- Sprint 4b — Seed approval rule set cho mỗi org (domain FINANCIAL_VOUCHER v1).
-- (AUTHORIZATION-PLAN §12.2, §2 "Luôn cần duyệt")
--
-- Rules (priority nhỏ = ưu tiên cao):
--   100 AUTO_POST       system_source='internal_settlement' (cặp bút toán nội bộ)
--   200 REQUIRE_APPROVAL force_match, sensitive source (commission/refund/salary/profit)
--  1000 fallback        REQUIRE_APPROVAL (không rule nào khác match) — 1 step, approver
--                       = PERMISSION income_expenses.approve.
-- Idempotent.
-- =============================================================================

BEGIN;

DO $seed$
DECLARE
  o record;
  v_rs uuid; v_rule uuid; v_step uuid;
BEGIN
  FOR o IN SELECT id FROM public.organizations LOOP
    -- rule set
    INSERT INTO public.approval_rule_sets (organization_id, transaction_domain, version, status)
    VALUES (o.id, 'FINANCIAL_VOUCHER', 1, 'ACTIVE')
    ON CONFLICT (organization_id, transaction_domain, version) DO NOTHING;
    SELECT id INTO v_rs FROM public.approval_rule_sets
      WHERE organization_id=o.id AND transaction_domain='FINANCIAL_VOUCHER' AND version=1;

    -- 100 AUTO_POST internal settlement
    INSERT INTO public.approval_rules (organization_id, rule_set_id, name, priority, effect, system_source, force_match)
    VALUES (o.id, v_rs, 'Auto-post nội bộ (cấn trừ)', 100, 'AUTO_POST', 'internal_settlement', true)
    ON CONFLICT (rule_set_id, priority) DO NOTHING;

    -- 200 force REQUIRE_APPROVAL sensitive (dùng transaction_type marker 'SENSITIVE')
    INSERT INTO public.approval_rules (organization_id, rule_set_id, name, priority, effect, transaction_type, force_match)
    VALUES (o.id, v_rs, 'Bắt buộc duyệt (HH/thưởng/hoàn/lương/LN)', 200, 'REQUIRE_APPROVAL', 'SENSITIVE', true)
    ON CONFLICT (rule_set_id, priority) DO NOTHING;
    SELECT id INTO v_rule FROM public.approval_rules WHERE rule_set_id=v_rs AND priority=200;
    INSERT INTO public.approval_rule_steps (organization_id, rule_id, step_no, min_approvals, mode)
    VALUES (o.id, v_rule, 1, 1, 'ANY') ON CONFLICT (rule_id, step_no) DO NOTHING;
    SELECT id INTO v_step FROM public.approval_rule_steps WHERE rule_id=v_rule AND step_no=1;
    INSERT INTO public.approval_step_approvers (organization_id, step_id, approver_type, permission_key)
    SELECT o.id, v_step, 'PERMISSION', 'income_expenses.approve'
    WHERE NOT EXISTS (SELECT 1 FROM public.approval_step_approvers WHERE step_id=v_step);

    -- 1000 fallback REQUIRE_APPROVAL
    INSERT INTO public.approval_rules (organization_id, rule_set_id, name, priority, effect, is_fallback)
    VALUES (o.id, v_rs, 'Fallback — không khớp rule ⇒ cần duyệt', 1000, 'REQUIRE_APPROVAL', true)
    ON CONFLICT (rule_set_id, priority) DO NOTHING;
    SELECT id INTO v_rule FROM public.approval_rules WHERE rule_set_id=v_rs AND priority=1000;
    INSERT INTO public.approval_rule_steps (organization_id, rule_id, step_no, min_approvals, mode)
    VALUES (o.id, v_rule, 1, 1, 'ANY') ON CONFLICT (rule_id, step_no) DO NOTHING;
    SELECT id INTO v_step FROM public.approval_rule_steps WHERE rule_id=v_rule AND step_no=1;
    INSERT INTO public.approval_step_approvers (organization_id, step_id, approver_type, permission_key)
    SELECT o.id, v_step, 'PERMISSION', 'income_expenses.approve'
    WHERE NOT EXISTS (SELECT 1 FROM public.approval_step_approvers WHERE step_id=v_step);
  END LOOP;
END $seed$;

COMMIT;
