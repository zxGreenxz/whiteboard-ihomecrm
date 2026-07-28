import { describe, expect, it, vi } from "vitest";

import {
  BUSINESS_PERFORMANCE_GATED_DATA_MIGRATIONS,
  buildBusinessPerformanceGatedDataRollout,
  main,
  parseRolloutArgs,
} from "../apply-business-performance-gated-data.mjs";

describe("business-performance gated-data rollout", () => {
  it("pins the four migrations in timestamp order and one atomic payload", () => {
    expect(BUSINESS_PERFORMANCE_GATED_DATA_MIGRATIONS).toEqual([
      "supabase/migrations/20260728010000_business_performance_month_snapshots.sql",
      "supabase/migrations/20260728020000_business_performance_finance_roles_and_break_even.sql",
      "supabase/migrations/20260728030000_business_performance_invoice_cohort_and_categories.sql",
      "supabase/migrations/20260728040000_business_performance_inventory_history_safe_scope.sql",
    ]);

    const rollout = buildBusinessPerformanceGatedDataRollout();
    expect(rollout.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(rollout.sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollout.sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(rollout.sql.match(/^NOTIFY pgrst, 'reload schema';$/gm)).toHaveLength(1);
    expect(rollout.sql.indexOf("20260728010000")).toBeLessThan(
      rollout.sql.indexOf("20260728020000"),
    );
    expect(rollout.sql.indexOf("20260728020000")).toBeLessThan(
      rollout.sql.indexOf("20260728030000"),
    );
    expect(rollout.sql.indexOf("20260728030000")).toBeLessThan(
      rollout.sql.indexOf("20260728040000"),
    );
  });

  it("requires an exact bundle hash for live apply", () => {
    expect(parseRolloutArgs(["--dry-run"])).toEqual({
      dryRun: true,
      expectedSha256: null,
      help: false,
    });
    expect(() => parseRolloutArgs([])).toThrow("--expected-sha256");
    expect(() => parseRolloutArgs(["--expected-sha256", "bad"])).toThrow(
      "64-character",
    );
  });

  it("keeps dry-run credential-free and rejects a stale live hash", async () => {
    const loadConfig = vi.fn(() => {
      throw new Error("credentials must stay unopened");
    });
    const execute = vi.fn();
    const messages = [];

    await main(["--dry-run"], {
      loadConfig,
      execute,
      log: (message) => messages.push(message),
    });

    expect(loadConfig).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(messages.join("\n")).toMatch(/sha256 [a-f0-9]{64}/);

    await expect(
      main(["--expected-sha256", "0".repeat(64)], {
        loadConfig,
        execute,
        log: () => {},
      }),
    ).rejects.toThrow("hash mismatch");
    expect(loadConfig).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
