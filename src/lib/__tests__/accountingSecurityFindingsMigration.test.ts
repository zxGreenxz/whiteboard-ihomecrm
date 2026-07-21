import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const terminationSql = readFileSync(
  "supabase/migrations/20260721135500_termination_non_cash_payment_semantics.sql",
  "utf8",
);
const payoutSql = readFileSync(
  "supabase/migrations/20260721120000_profit_payout_reservations_v2.sql",
  "utf8",
);
const rolloutSql = readFileSync(
  "supabase/migrations/20260721140500_accounting_rollout_gate_v1.sql",
  "utf8",
);
const finalProfitCloseSql = readFileSync(
  "supabase/migrations/20260720215000_profit_close_v2_ignore_inactive_managers.sql",
  "utf8",
);

function functionBody(sql: string, signature: string): string {
  const start = sql.indexOf(signature);
  expect(start, signature).toBeGreaterThanOrEqual(0);

  const delimiter = sql.indexOf("\n$fn$;", start);
  const fallbackDelimiter = sql.indexOf("\n$$;", start);
  const end = delimiter >= 0 ? delimiter : fallbackDelimiter;
  expect(end, signature).toBeGreaterThan(start);
  return sql.slice(start, end + 6);
}

describe("accounting security migration regressions", () => {
  it("keeps cancelled termination forfeit vouchers terminal in every path", () => {
    const guard = functionBody(
      terminationSql,
      "CREATE OR REPLACE FUNCTION app_private.guard_termination_forfeit_voucher_v1()",
    );
    const transition = functionBody(
      terminationSql,
      "CREATE OR REPLACE FUNCTION public.set_termination_forfeit_status_v1(",
    );

    const terminalGuard = guard.indexOf("OLD.approval_status = 'CANCELLED'");
    const writerCapability = guard.indexOf(
      "FROM app_private.accounting_chain_writer_xids capability",
    );
    expect(terminalGuard).toBeGreaterThanOrEqual(0);
    expect(terminalGuard).toBeLessThan(writerCapability);
    expect(guard).toContain(
      "NEW.approval_status IS DISTINCT FROM OLD.approval_status",
    );
    expect(transition).toContain(
      "IF upper(p_status) <> 'CANCELLED' AND EXISTS (",
    );
    expect(transition).not.toContain(
      "IF upper(p_status) = 'APPROVED' AND EXISTS (",
    );
  });

  it("cannot declassify a linked payout by clearing shareholder and account", () => {
    const guard = functionBody(
      payoutSql,
      "CREATE OR REPLACE FUNCTION public._guard_profit_payout_insert_v2()",
    );
    const validation = guard.indexOf("IF v_is_payout THEN");
    const writerCapability = guard.indexOf(
      "FROM app_private.accounting_chain_writer_xids capability",
    );

    expect(guard).toContain(
      "FROM public.profit_payout_reservations reservation",
    );
    expect(guard).toContain("reservation.payout_voucher_id = NEW.id");
    expect(guard).toContain("request_row.subject_type = 'FINANCIAL_VOUCHER'");
    expect(guard).toContain("request_row.subject_id = NEW.id");
    expect(guard).toContain(
      "request_row.system_source = 'profit.distribution'",
    );
    expect(guard).toContain(
      "v_is_payout := v_is_payout OR v_has_reservation OR v_has_request",
    );
    expect(guard).toContain("IF NEW.shareholder_id IS NULL THEN");
    expect(guard).toContain("IF NEW.account_id IS NULL THEN");
    expect(guard).toContain(
      "reservation.shareholder_id IS DISTINCT FROM NEW.shareholder_id",
    );
    expect(guard).toContain(
      "request_row.cashbook_id IS DISTINCT FROM NEW.account_id",
    );
    expect(validation).toBeGreaterThanOrEqual(0);
    expect(validation).toBeLessThan(writerCapability);
  });

  it("freezes linked payout vouchers and items under approval-engine ownership", () => {
    const linkedGuard = functionBody(
      payoutSql,
      "CREATE OR REPLACE FUNCTION app_private.guard_profit_payout_linked_v2()",
    );
    const itemGuard = functionBody(
      payoutSql,
      "CREATE OR REPLACE FUNCTION app_private.guard_profit_payout_item_v2()",
    );
    const writer = functionBody(
      payoutSql,
      "CREATE OR REPLACE FUNCTION public.distribute_shareholder_profit_v1(",
    );
    const ownership = writer.indexOf(
      "INSERT INTO app_private.income_expense_flow_ownership",
    );
    const submit = writer.indexOf("submit_financial_request_v1");

    expect(ownership).toBeGreaterThanOrEqual(0);
    expect(ownership).toBeLessThan(submit);
    expect(writer).toContain("'SHAREHOLDER_PROFIT_PAYOUT_V2', 2");
    expect(payoutSql).toContain(
      "BEFORE UPDATE OR DELETE ON public.income_expenses",
    );
    expect(linkedGuard).toContain("app_private.ie_transition_authorization");
    expect(linkedGuard).toContain("to_jsonb(OLD) - ARRAY[");
    for (const immutableField of [
      "organization_id",
      "building_id",
      "shareholder_id",
      "account_id",
      "voucher_date",
      "total_amount",
      "source_payload_hash",
      "system_source",
      "deleted_at",
    ]) {
      expect(
        linkedGuard.slice(
          linkedGuard.indexOf("to_jsonb(OLD) - ARRAY["),
          linkedGuard.indexOf("]::text[]"),
        ),
      ).not.toContain(`'${immutableField}'`);
    }
    expect(itemGuard).toContain(
      "Items of a linked profit payout are immutable",
    );
    expect(payoutSql).toContain(
      "BEFORE INSERT OR UPDATE OR DELETE ON public.income_expense_items",
    );
  });

  it("binds reservations, request snapshots, and ownership to one payload hash", () => {
    const linkage = functionBody(
      payoutSql,
      "CREATE OR REPLACE FUNCTION app_private.assert_profit_payout_linkage_v2(",
    );
    const writer = functionBody(
      payoutSql,
      "CREATE OR REPLACE FUNCTION public.distribute_shareholder_profit_v1(",
    );

    expect(payoutSql).toContain("source_payload_hash text");
    expect(linkage).toContain(
      "reservation.source_payload_hash IS DISTINCT FROM",
    );
    expect(linkage).toContain(
      "v_request.payload_hash IS DISTINCT FROM v_voucher.source_payload_hash",
    );
    expect(linkage).toContain(
      "v_request.payload_snapshot->>'source_payload_hash' IS DISTINCT FROM",
    );
    expect(linkage).toContain(
      "ownership.payload_hash_value = v_voucher.source_payload_hash",
    );
    expect(linkage).toContain(
      "abs(v_reservation_total - v_voucher.total_amount) >= 0.01",
    );
    expect(linkage).toMatch(
      /FROM public\.accounts account_row[\s\S]*?NOT account_row\.is_virtual\s+FOR SHARE;/,
    );
    expect(linkage).toContain("FOR SHARE OF building_row, organization");
    expect(linkage).toContain("organization.status = 'ACTIVE'");
    expect(linkage).toContain("building_row.is_virtual");
    expect(writer.indexOf("Reserve before submission")).toBeLessThan(
      writer.indexOf("submit_financial_request_v1"),
    );
    expect(writer).toContain("SET approval_request_id = v_request");
    expect(writer).toContain("v_voucher, false, true");
  });

  it("derives payout freshness from the canonical building source hash", () => {
    const hashHelper = functionBody(
      payoutSql,
      "CREATE OR REPLACE FUNCTION app_private.current_profit_building_source_hash_v1(",
    );
    const freshnessHelper = functionBody(
      payoutSql,
      "CREATE OR REPLACE FUNCTION app_private.profit_monthly_source_is_current_v1(",
    );

    expect(hashHelper).toContain("revision.operation IN ('CLOSE', 'RECLOSE')");
    expect(hashHelper).toContain("'algorithm_version', 'profit-close-v2.1'");
    expect(hashHelper).toContain("'source_building_bases'");
    expect(hashHelper).toContain("'accrual_lines'");
    expect(hashHelper).toContain("'shareholder_config'");
    expect(hashHelper).toContain("'manager_salary_rules'");
    expect(hashHelper).toContain("md5(jsonb_build_object(");
    for (const canonicalRule of [
      "OR shareholder.id IS NULL",
      "OR shareholder.organization_id IS DISTINCT FROM",
      "AND shareholder.is_active",
      "AND shareholder.deleted_at IS NULL",
      "manager.id IS NULL",
      "manager.is_active",
      "manager.deleted_at IS NULL",
    ]) {
      expect(hashHelper).toContain(canonicalRule);
    }
    for (const canonicalRule of [
      "OR sh.id IS NULL",
      "OR sh.organization_id IS DISTINCT FROM",
      "AND sh.is_active",
      "AND sh.deleted_at IS NULL",
      "m.id IS NULL",
      "m.is_active",
      "m.deleted_at IS NULL",
    ]) {
      expect(finalProfitCloseSql).toContain(canonicalRule);
    }
    expect(hashHelper).not.toMatch(
      /OR NOT shareholder\.is_active\s+OR shareholder\.deleted_at IS NOT NULL/,
    );
    expect(hashHelper).not.toMatch(
      /OR NOT manager\.is_active\s+OR manager\.deleted_at IS NOT NULL/,
    );
    expect(freshnessHelper).toContain("profit.source_hash =");
    expect(freshnessHelper).toContain(
      "app_private.current_profit_building_source_hash_v1(profit.id)",
    );
    expect(
      payoutSql.match(/profit_monthly_source_is_current_v1\(pm\.id\)/g),
    ).toHaveLength(2);
  });

  it("serializes source freshness through reservation commit and later posting", () => {
    const sourceLock = functionBody(
      payoutSql,
      "CREATE OR REPLACE FUNCTION app_private.lock_profit_payout_sources_v2()",
    );
    const freshness = functionBody(
      payoutSql,
      "CREATE OR REPLACE FUNCTION app_private.assert_profit_payout_fresh_v2(",
    );
    const linkedGuard = functionBody(
      payoutSql,
      "CREATE OR REPLACE FUNCTION app_private.guard_profit_payout_linked_v2()",
    );
    const transition = functionBody(
      payoutSql,
      "CREATE OR REPLACE FUNCTION app_private.transition_canonical_income_expense_v1(",
    );
    const postRequest = functionBody(
      payoutSql,
      "CREATE OR REPLACE FUNCTION app_private.post_financial_request_v1(",
    );
    const decideRequest = functionBody(
      payoutSql,
      "CREATE OR REPLACE FUNCTION app_private.decide_financial_request_v1(",
    );
    const writer = functionBody(
      payoutSql,
      "CREATE OR REPLACE FUNCTION public.distribute_shareholder_profit_v1(",
    );

    for (const table of [
      "public.income_expenses",
      "public.income_expense_items",
      "public.invoices",
      "public.building_shareholders",
      "public.shareholders",
      "public.profit_manager_salaries",
      "public.profit_manager_salary_buildings",
      "public.profit_monthly",
      "public.profit_allocations",
    ]) {
      expect(sourceLock).toContain(table);
    }
    expect(sourceLock).toContain("IN SHARE ROW EXCLUSIVE MODE");
    let previousTable = -1;
    for (const table of [
      "public.income_expense_items",
      "public.income_expenses",
      "public.income_expense_types",
      "public.invoices",
      "public.building_shareholders",
      "public.shareholders",
      "public.profit_managers",
      "public.profit_manager_salaries",
      "public.profit_manager_salary_buildings",
      "public.staff_assignments",
      "public.roles",
      "public.area_buildings",
      "public.super_admins",
    ]) {
      const tablePosition = sourceLock.indexOf(table);
      expect(tablePosition).toBeGreaterThan(previousTable);
      previousTable = tablePosition;
    }
    expect(payoutSql).toContain("$align_profit_close_item_lock_order$");
    expect(payoutSql).toContain("pg_get_functiondef(proc.oid)");
    expect(payoutSql).toContain("proc.proowner = v_owner");
    expect(payoutSql).toContain("proc.proacl IS NOT DISTINCT FROM v_acl");
    expect(payoutSql).toContain("proc.proconfig IS NOT DISTINCT FROM v_config");
    expect(payoutSql).toContain(
      "E'LOCK TABLE public.income_expense_items,\\n               public.income_expenses,'",
    );
    expect(writer.indexOf("lock_profit_payout_sources_v2")).toBeLessThan(
      writer.indexOf("v_remaining := p_amount"),
    );
    expect(writer).toContain("FOR UPDATE OF pa, pm");
    expect(writer).toContain(
      "pm.period_month <= date_trunc('month', p_voucher_date)::date",
    );
    expect(freshness).toContain(
      "FOR UPDATE OF reservation, allocation, profit",
    );
    expect(freshness).toContain(
      "profit.period_month >\n           date_trunc('month', voucher.voucher_date)::date",
    );
    expect(freshness).toContain(
      "profit_monthly_source_is_current_v1(profit.id)",
    );
    const transitionFreshness = transition.indexOf(
      "assert_profit_payout_fresh_v2(p_income_expense_id)",
    );
    const transitionLinkage = transition.indexOf(
      "assert_profit_payout_linkage_v2(",
    );
    const transitionUpdate = transition.indexOf(
      "UPDATE public.income_expenses",
    );
    expect(transitionFreshness).toBeGreaterThanOrEqual(0);
    expect(transitionFreshness).toBeLessThan(transitionLinkage);
    expect(transitionLinkage).toBeLessThan(transitionUpdate);
    expect(transition).toContain("p_income_expense_id, v_core_writer, true");
    for (const engineBody of [postRequest, decideRequest]) {
      const prelock = engineBody.indexOf("lock_profit_payout_sources_v2()");
      const voucherLock = engineBody.indexOf("FROM public.income_expenses");
      expect(prelock).toBeGreaterThanOrEqual(0);
      expect(prelock).toBeLessThan(voucherLock);
      expect(engineBody).toContain(
        "SET search_path TO pg_catalog, app_private, public",
      );
    }
    expect(postRequest).toContain(
      "v_req.system_source = 'profit.distribution'",
    );
    expect(decideRequest).toContain("p_decision = 'APPROVE'");
    expect(decideRequest).toContain(
      "v_req.system_source = 'profit.distribution'",
    );
    expect(linkedGuard).toContain("NEW.approval_status = 'APPROVED'");
    expect(linkedGuard).not.toContain("assert_profit_payout_fresh_v2");
  });

  it("lets force-freeze win and revalidates when the freeze is cleared", () => {
    const activationGuard = functionBody(
      rolloutSql,
      "CREATE OR REPLACE FUNCTION app_private.guard_accounting_feature_activation_v1()",
    );
    const enrollmentGuard = functionBody(
      rolloutSql,
      "CREATE OR REPLACE FUNCTION app_private.guard_accounting_canary_enrollment_v1()",
    );

    expect(activationGuard.indexOf("IF NEW.force_freeze THEN")).toBeLessThan(
      activationGuard.indexOf("IF NEW.mode IN ('CANARY', 'ON') THEN"),
    );
    expect(rolloutSql).toContain(
      "BEFORE INSERT OR UPDATE OF mode, force_freeze",
    );
    expect(enrollmentGuard).toContain(
      "IF v_mode = 'CANARY' AND NOT v_force_freeze THEN",
    );
    expect(rolloutSql).toContain("AND NOT feature.force_freeze");
  });

  it("checks pre-enrolled SHADOW canaries and derived stale hashes on activation", () => {
    const assertion = functionBody(
      rolloutSql,
      "CREATE OR REPLACE FUNCTION app_private.assert_accounting_feature_activation_v1(",
    );
    const activationGuard = functionBody(
      rolloutSql,
      "CREATE OR REPLACE FUNCTION app_private.guard_accounting_feature_activation_v1()",
    );
    const enrollmentGuard = functionBody(
      rolloutSql,
      "CREATE OR REPLACE FUNCTION app_private.guard_accounting_canary_enrollment_v1()",
    );
    const rolloutLock = functionBody(
      rolloutSql,
      "CREATE OR REPLACE FUNCTION app_private.lock_accounting_feature_rollout_v1(",
    );

    expect(activationGuard).toContain("NEW.feature_key, NEW.mode, NULL");
    expect(assertion).toContain("p_organization_id IS NULL");
    expect(assertion).toContain(
      "FROM app_private.server_feature_flag_canary_orgs canary",
    );
    expect(assertion).toContain(
      "canary.organization_id = profit.organization_id",
    );
    expect(assertion).toContain(
      "app_private.profit_monthly_source_is_current_v1(profit.id)",
    );
    expect(rolloutSql).toContain(
      "JOIN public.profit_monthly profit\n              ON profit.organization_id = canary.organization_id",
    );
    expect(rolloutLock).toContain("pg_advisory_xact_lock");
    expect(activationGuard).toContain(
      "lock_accounting_feature_rollout_v1(NEW.feature_key)",
    );
    expect(enrollmentGuard.indexOf("FOR UPDATE")).toBeLessThan(
      enrollmentGuard.indexOf("lock_accounting_feature_rollout_v1"),
    );
    expect(
      enrollmentGuard.indexOf("lock_accounting_feature_rollout_v1"),
    ).toBeLessThan(
      enrollmentGuard.indexOf("assert_accounting_feature_activation_v1"),
    );
  });
});
