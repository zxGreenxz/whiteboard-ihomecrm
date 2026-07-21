import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

const helperSql = read(
  "supabase/migrations/20260721075000_accounting_canary_caps.sql",
);
const contractSql = read(
  "supabase/migrations/20260721090000_contract_create_v2.sql",
);
const collectionSql = read(
  "supabase/migrations/20260721100000_invoice_collection_v5.sql",
);
const payoutSql = read(
  "supabase/migrations/20260721120000_profit_payout_reservations_v2.sql",
);
const creditSql = read(
  "supabase/migrations/20260721135000_customer_credit_application_v1.sql",
);

describe("accounting canary cap migration", () => {
  it("serializes each CANARY config bucket and enforces all three caps", () => {
    expect(helperSql).toContain("FOR SHARE");
    expect(helperSql).toContain("pg_advisory_xact_lock");
    expect(helperSql).toContain("max_single_amount_vnd");
    expect(helperSql).toContain("max_operation_count");
    expect(helperSql).toContain("max_total_amount_vnd");
    expect(helperSql).toContain("server_feature_flag_operations");
    expect(helperSql).not.toContain("ON CONFLICT DO NOTHING");
  });

  it("does not expose the private claimant to API roles", () => {
    expect(helperSql).toMatch(
      /REVOKE ALL ON FUNCTION app_private\.claim_feature_operation_v1[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/,
    );
  });

  it("claims the correct economic amount in every forward money writer", () => {
    expect(contractSql).toContain("claim_feature_operation_v1");
    expect(contractSql).toContain(
      "round(v_new_deposit_receipts + COALESCE(v_total_amount, 0), 2)",
    );
    expect(collectionSql).toContain("v_retained_total");
    expect(collectionSql).toContain(
      "'invoice.collection.v5',\n    v_org,\n    p_invoice_id::text",
    );
    expect(creditSql).toContain("v_requested\n  );");
    expect(payoutSql).toContain("round(p_amount, 2)\n  );");
  });

  it("validates client-provided deposit accounts as active, real and same-org", () => {
    expect(contractSql).toMatch(
      /PERFORM 1 FROM public\.accounts account_row\s+WHERE account_row\.id = v_account_id\s+AND account_row\.organization_id = v_org\s+AND account_row\.deleted_at IS NULL\s+AND NOT account_row\.is_virtual\s+FOR SHARE;/,
    );
  });

  it("keeps compensating reversals independent from exhausted forward caps", () => {
    expect(collectionSql).toContain("'invoice.collection.reverse.v5'");
    expect(collectionSql).toContain(
      "evaluate_feature_route('invoice.collection.reverse.v5', v_org)",
    );
    expect(creditSql).toContain("'customer.credit.reverse.v1'");
    expect(creditSql).toContain(
      "evaluate_feature_route('customer.credit.reverse.v1', v_org)",
    );
  });
});
