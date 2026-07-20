import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProfitCloseAdjustments,
  mergeProfitCloseDrafts,
  resolveProfitCloseOrganizationId,
  validateProfitCloseDrafts,
  type ProfitCloseDraftMap,
} from "@/lib/profitClose";

describe("profit close draft initialization", () => {
  it("starts an unlocked row with an explicit zero adjustment", () => {
    expect(
      mergeProfitCloseDrafts(
        [{ buildingId: "b1", locked: false }],
        {},
        new Set(),
      ),
    ).toEqual({ b1: { adjustmentAmount: 0, adjustmentReason: "" } });
  });

  it("reuses only the signed snapshot adjustment, never a stale absolute adjusted value", () => {
    const drafts = mergeProfitCloseDrafts(
      [
        {
          buildingId: "b1",
          locked: true,
          snapshotAdjustmentAmount: -250_000,
          snapshotAdjustmentReason: " Giảm khoản bất thường ",
        },
      ],
      {},
      new Set(),
    );

    expect(drafts.b1).toEqual({
      adjustmentAmount: -250_000,
      adjustmentReason: "Giảm khoản bất thường",
    });
  });

  it("does not overwrite dirty input during a background preview refresh", () => {
    const previous: ProfitCloseDraftMap = {
      b1: { adjustmentAmount: 125_000, adjustmentReason: "User đang sửa" },
    };
    const drafts = mergeProfitCloseDrafts(
      [
        {
          buildingId: "b1",
          locked: true,
          snapshotAdjustmentAmount: 900_000,
          snapshotAdjustmentReason: "Server refresh",
        },
      ],
      previous,
      new Set(["b1"]),
    );

    expect(drafts.b1).toBe(previous.b1);
  });
});

describe("profit close adjustment validation", () => {
  it("requires a per-row reason for every non-zero signed adjustment", () => {
    const result = validateProfitCloseDrafts(
      ["increase", "decrease"],
      {
        increase: { adjustmentAmount: 100, adjustmentReason: "" },
        decrease: { adjustmentAmount: -100, adjustmentReason: "Giảm theo biên bản" },
      },
      { reclose: false, overallReason: "" },
    );

    expect(result.valid).toBe(false);
    expect(result.rowErrors).toEqual({
      increase: "Lý do điều chỉnh phải có 8–500 ký tự",
    });
  });

  it("requires an overall reason only for reclose", () => {
    const drafts = { b1: { adjustmentAmount: 0, adjustmentReason: "" } };
    expect(
      validateProfitCloseDrafts(["b1"], drafts, {
        reclose: false,
        overallReason: "",
      }).valid,
    ).toBe(true);
    expect(
      validateProfitCloseDrafts(["b1"], drafts, {
        reclose: true,
        overallReason: " ",
      }).overallReasonError,
    ).toBe("Lý do chốt lại phải có 8–1000 ký tự");
  });

  it("builds explicit zero and signed adjustment payloads", () => {
    expect(
      buildProfitCloseAdjustments(
        ["b1", "b2"],
        {
          b1: { adjustmentAmount: 0, adjustmentReason: "ignored" },
          b2: { adjustmentAmount: -75_000, adjustmentReason: "  Điều chỉnh giảm  " },
        },
      ),
    ).toEqual([
      { building_id: "b1", adjustment_amount: 0, adjustment_reason: null },
      {
        building_id: "b2",
        adjustment_amount: -75_000,
        adjustment_reason: "Điều chỉnh giảm",
      },
    ]);
  });
});

describe("profit close organization scope", () => {
  const organizations = [
    { organization_id: "org-a" },
    { organization_id: "org-b" },
  ];

  it("auto-selects only when exactly one organization is available", () => {
    expect(resolveProfitCloseOrganizationId([organizations[0]], "")).toBe("org-a");
    expect(resolveProfitCloseOrganizationId(organizations, "")).toBe("");
  });

  it("preserves a valid explicit selection and clears an invalid one", () => {
    expect(resolveProfitCloseOrganizationId(organizations, "org-b")).toBe("org-b");
    expect(resolveProfitCloseOrganizationId(organizations, "org-missing")).toBe("");
  });
});

describe("profit close V2 boundaries", () => {
  const hookSource = readFileSync(
    resolve(process.cwd(), "src/hooks/useShareholderProfit.ts"),
    "utf8",
  );
  const uiSource = readFileSync(
    resolve(process.cwd(), "src/components/shareholders/ProfitLockTab.tsx"),
    "utf8",
  );
  const migrationSource = readFileSync(
    resolve(
      process.cwd(),
      "supabase/migrations/20260720210000_profit_close_v2.sql",
    ),
    "utf8",
  );
  const guardMigrationSource = readFileSync(
    resolve(
      process.cwd(),
      "supabase/migrations/20260720223000_profit_close_v2_scope_reset_guard.sql",
    ),
    "utf8",
  );

  it("keeps the frontend writer RPC-only with no legacy fallback", () => {
    const canonicalSection = hookSource.slice(
      hookSource.indexOf("// --- Canonical V2 close workflow"),
    );
    const directSnapshotDml =
      /\.from\(["']profit_(?:monthly|allocations|manager_allocations)["']\)[\s\S]{0,240}?\.(?:insert|upsert|update|delete)\(/;

    expect(hookSource).not.toContain("canonicalFallback");
    expect(uiSource).not.toContain("canonicalFallback");
    expect(canonicalSection).not.toMatch(directSnapshotDml);
    expect(canonicalSection).toContain("profit_close_preview_v2");
    expect(canonicalSection).toContain("profit_close_v2");
    expect(canonicalSection).toContain("profit_reclose_v2");
    expect(canonicalSection).toContain("profit_reset_checked_v2");
  });

  it("never mutates canonical source/config tables in the V2 migration", () => {
    const sourceTables = [
      "income_expenses",
      "income_expense_items",
      "invoices",
      "building_shareholders",
      "shareholders",
      "profit_managers",
      "profit_manager_salaries",
      "profit_manager_salary_buildings",
    ].join("|");
    const forbiddenDml = new RegExp(
      `\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?)\\s+(?:public\\.)?(?:${sourceTables})\\b`,
      "i",
    );

    expect(migrationSource).not.toMatch(forbiddenDml);
  });

  it("guards writes with source hash and preserves reset revisions", () => {
    expect(migrationSource).toMatch(
      /v_preview->>'source_hash'\s*<>\s*v_expected_hash/,
    );
    expect(migrationSource).toContain(
      "CREATE TABLE IF NOT EXISTS public.profit_close_revisions",
    );
    expect(migrationSource).toContain("CREATE OR REPLACE FUNCTION public.profit_reset_v2");
    expect(migrationSource).toMatch(/DELETE FROM public\.profit_monthly/);
    expect(migrationSource).toContain("NULL building_ids includes legacy virtual rows");
  });

  it("scopes organizations explicitly and guards destructive reset state", () => {
    expect(hookSource).toContain("profit_close_scopes_v2");
    expect(hookSource).toContain("profit_close_state_v2");
    expect(uiSource).toContain("resolveProfitCloseOrganizationId");
    expect(guardMigrationSource).toContain("p_expected_state_hash");
    expect(guardMigrationSource).toContain("p_expected_snapshot_ids");
    expect(guardMigrationSource).toContain("pg_advisory_xact_lock");
    expect(guardMigrationSource).toContain("PROFIT_SNAPSHOT_CONFLICT");
    expect(guardMigrationSource).toMatch(
      /REVOKE ALL ON FUNCTION public\.profit_reset_v2[\s\S]*authenticated/,
    );
  });
});
