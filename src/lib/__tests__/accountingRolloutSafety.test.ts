import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const prerequisites = readFileSync(
  "supabase/migrations/20260721070000_accounting_rollout_prerequisites.sql",
  "utf8",
);

const historyRepair = readFileSync(
  "supabase/migrations/20260721130000_accounting_history_repair.sql",
  "utf8",
);
const historyResolution = readFileSync(
  "supabase/migrations/20260721132500_accounting_history_resolution_v1.sql",
  "utf8",
);
const payout = readFileSync(
  "supabase/migrations/20260721120000_profit_payout_reservations_v2.sql",
  "utf8",
);
const credit = readFileSync(
  "supabase/migrations/20260721135000_customer_credit_application_v1.sql",
  "utf8",
);
const reporting = readFileSync(
  "supabase/migrations/20260721102000_active_payments_reporting.sql",
  "utf8",
);

describe("accounting rollout safety regressions", () => {
  it("fails closed unless the reviewed production authz catalog is present", () => {
    expect(prerequisites).toContain("production authz foundation");
    expect(prerequisites).toContain("app_private.ie_transition_authorization");
    expect(prerequisites).toContain(
      "app_private.assert_no_engine_request_v1(uuid)",
    );
    expect(prerequisites).toContain("ie_canonical_writer");
    expect(prerequisites).toContain("pg_catalog.pg_auth_members");
    expect(prerequisites).toContain("pg_catalog.has_schema_privilege");
    expect(prerequisites).toContain("pg_catalog.has_table_privilege");
    expect(prerequisites).toContain("pg_catalog.has_function_privilege");
    expect(prerequisites).toContain("procedure_row.proowner");
    expect(prerequisites).toContain("procedure_row.prosecdef");
    expect(prerequisites).toContain("procedure_row.proconfig");
    expect(prerequisites).toContain(
      "must pin pg_catalog first in search_path",
    );
  });

  it("never bootstraps a missing authz foundation from the rollout guard", () => {
    expect(prerequisites).toContain("fresh reset/bare database");
    expect(prerequisites).toContain("does not support");
    expect(prerequisites).not.toMatch(/\bCREATE\s+ROLE\b/i);
    expect(prerequisites).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(prerequisites).not.toMatch(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i);
  });

  it("pins canonical-writer membership and PostgreSQL 17 grant options", () => {
    expect(prerequisites).toContain(
      "membership_row.member <> v_trusted_owner",
    );
    expect(prerequisites).toContain("membership_row.grantor");
    expect(prerequisites).toContain("pg_catalog.to_regrole('supabase_admin')");
    expect(prerequisites).toContain("membership_row.admin_option");
    expect(prerequisites).toContain("membership_row.inherit_option");
    expect(prerequisites).toContain("membership_row.set_option");
    expect(prerequisites).toContain("SELECT count(*) <> 2");
    expect(prerequisites).toContain(
      "expected exact reviewed trusted-owner grants",
    );
  });

  it("does not let a reversed receipt consume invoice capacity before recollection", () => {
    expect(historyRepair).toContain("WHEN payment.reversed_at IS NULL");
    expect(historyRepair).toContain("THEN semantics.retained_amount");
    expect(historyRepair).toContain("ELSE 0");
  });

  it("never backfills a payout from a stale or future profit allocation", () => {
    expect(payout).toContain("AND NOT pm.is_stale");
    expect(payout).toContain(
      "pm.period_month <= date_trunc('month', v_voucher.voucher_date)::date",
    );
  });

  it("keeps soft-deleted invoice credit visible to canonicalization and guards", () => {
    expect(credit).not.toContain("OR source_invoice.deleted_at IS NULL");
    expect(credit).toContain("excess.credit_lot_id IS NULL");
    expect(credit).toContain("CUSTOMER_CREDIT_DELETED_INVOICE_REVERSAL");
    expect(credit).toContain("source_invoice_deleted_at");
    expect(credit).toContain("reversal_excess_amount_id = v_reversal_excess_id");
  });

  it("skips exact production repairs only when no reviewed IDs exist", () => {
    expect(historyResolution).toContain("_acct_history_resolution_scope");
    expect(historyResolution).toContain("real_history_present");
    expect(historyResolution).toContain("demo_history_present");
    expect(historyResolution).toContain("IF NOT (SELECT real_history_present");
  });

  it("refuses to rewrite live report functions after catalog drift", () => {
    expect(reporting).toContain("md5(v_definition)");
    expect(reporting).toContain("drifted from the reviewed source definition");
  });
});
