import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNTING_MIGRATIONS,
  buildRolloutSql,
  executeManagementQuery,
  loadMigrationBodies,
  main as applyMain,
  parseApplyArgs,
  ROLLOUT_CATALOG_SCOPE_NOTICE,
  STATIC_VALIDATION_NOTICE,
  stripMigrationTransactionControl,
} from "../apply-accounting-rollout.mjs";
import {
  APPLIED_ROLLOUT_MIGRATIONS,
  AUDIT_SQL,
  evaluateAuditReport,
  main as auditMain,
  parseAuditResponse,
} from "../audit-accounting-rollout.mjs";
import {
  DEFAULT_FILES,
  main as validateMain,
  parseValidateArgs,
} from "../validate-accounting-migrations.mjs";

const cleanReport = {
  exceptions: {},
  payout_exceptions: 0,
  profit: { stale_count: 0 },
  profit_activation_readiness: {
    overall: {
      locked_hash_drift_count: 0,
      locked_persisted_stale_count: 0,
      locked_unsafe_count: 0,
    },
    demo: {
      organization_id: "dddd0000-0000-4000-8000-000000000001",
      locked_hash_drift_count: 0,
      locked_persisted_stale_count: 0,
      locked_unsafe_count: 0,
    },
    real: {
      organization_id: "aaaa0000-0000-4000-8000-000000000001",
      locked_hash_drift_count: 0,
      locked_persisted_stale_count: 0,
      locked_unsafe_count: 0,
    },
  },
  profit_active_unsafe_count: 0,
  profit_distribution_force_freeze: false,
  profit_distribution_mode: "SHADOW",
  reversal_integrity_failures: 0,
};

describe("accounting rollout migration assembly", () => {
  it("pins the same ordered set of exactly 13 migrations everywhere", () => {
    expect(ACCOUNTING_MIGRATIONS).toHaveLength(13);
    expect(DEFAULT_FILES).toEqual(ACCOUNTING_MIGRATIONS);
    expect(APPLIED_ROLLOUT_MIGRATIONS).toEqual(ACCOUNTING_MIGRATIONS);
  });

  it("removes migration wrappers without removing the migration body", () => {
    const body = stripMigrationTransactionControl(
      "\uFEFF-- rollout migration\n\nBEGIN;\nSELECT 'BEGIN;';\nDO $$\nBEGIN\n  NULL;\nEND\n$$;\nCOMMIT;\n\nNOTIFY pgrst, 'reload schema';\n",
      "sample.sql",
    );

    expect(body).toContain("-- rollout migration");
    expect(body).toContain("SELECT 'BEGIN;';");
    expect(body).toContain("DO $$\nBEGIN\n  NULL;");
    expect(body).not.toMatch(/^\s*(?:BEGIN|COMMIT)\s*;\s*$/im);
    expect(body).not.toMatch(/^\s*NOTIFY\s+pgrst/im);
  });

  it("rejects migration bodies with ambiguous transaction controls", () => {
    expect(() =>
      stripMigrationTransactionControl(
        "BEGIN;\nSELECT 1;\nCOMMIT;\nCOMMIT;",
        "unsafe.sql",
      ),
    ).toThrow("exactly one standalone BEGIN; and COMMIT;");
  });

  it("loads every real migration with no transaction wrapper left behind", () => {
    const migrations = loadMigrationBodies();
    expect(migrations).toHaveLength(13);
    for (const migration of migrations) {
      expect(migration.body, migration.file).not.toMatch(
        /^\s*(?:BEGIN|COMMIT)\s*;\s*$/im,
      );
      expect(migration.body, migration.file).not.toMatch(
        /^\s*NOTIFY\s+pgrst/im,
      );
    }
  });

  it("builds one timed, advisory-locked transaction and one notification", () => {
    const sql = buildRolloutSql([
      { file: "001.sql", body: "SELECT 1;" },
      { file: "002.sql", body: "SELECT 2;" },
    ]);

    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.match(/^NOTIFY pgrst, 'reload schema';$/gm)).toHaveLength(1);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '15min';");
    expect(sql).toContain("pg_try_advisory_xact_lock");
    expect(sql.indexOf("001.sql")).toBeLessThan(sql.indexOf("002.sql"));
    expect(sql.indexOf("NOTIFY pgrst")).toBeLessThan(sql.lastIndexOf("COMMIT;"));
  });

  it("builds live validation as a rollback with no notification", () => {
    const sql = buildRolloutSql(
      [{ file: "001.sql", body: "SELECT 1;" }],
      { rollback: true, notify: false },
    );

    expect(sql).toMatch(/ROLLBACK;$/);
    expect(sql).not.toContain("NOTIFY pgrst");
    expect(sql).toContain("lock_timeout");
    expect(sql).toContain("statement_timeout");
  });
});

describe("accounting rollout command safety", () => {
  it("keeps live validation opt-in", async () => {
    expect(parseValidateArgs([]).liveRollback).toBe(false);
    expect(parseValidateArgs(["--live-rollback"]).liveRollback).toBe(true);

    const loadConfig = vi.fn(() => {
      throw new Error("must not load production credentials");
    });
    const fetchImpl = vi.fn(() => {
      throw new Error("must not call production");
    });
    const messages = [];

    await validateMain([], {
      fetchImpl,
      loadConfig,
      log: (message) => messages.push(message),
    });

    expect(loadConfig).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(messages).toContain(ROLLOUT_CATALOG_SCOPE_NOTICE);
    expect(messages).toContain(STATIC_VALIDATION_NOTICE);
    expect(messages.join("\n")).toContain("No database query was executed");
  });

  it("supports an apply dry run without loading credentials", async () => {
    expect(parseApplyArgs(["--dry-run"]).dryRun).toBe(true);
    const loadConfig = vi.fn(() => {
      throw new Error("must not load production credentials");
    });
    const messages = [];

    await applyMain(["--dry-run"], {
      loadConfig,
      log: (message) => messages.push(message),
    });

    expect(loadConfig).not.toHaveBeenCalled();
    expect(messages).toContain(ROLLOUT_CATALOG_SCOPE_NOTICE);
    expect(messages).toContain(STATIC_VALIDATION_NOTICE);
    expect(messages.join("\n")).toContain("No database query was executed");
  });

  it("documents that rollout helpers cannot bootstrap a bare database", () => {
    expect(ROLLOUT_CATALOG_SCOPE_NOTICE).toContain("production-catalog-only");
    expect(ROLLOUT_CATALOG_SCOPE_NOTICE).toContain("fresh reset/bare database");
    expect(ROLLOUT_CATALOG_SCOPE_NOTICE).toContain(
      "must not be used instead of foundation migrations",
    );
    expect(STATIC_VALIDATION_NOTICE).toContain("no target catalog was queried");
  });

  it("redacts the PAT from Management API failures", async () => {
    const pat = "sbp_test_secret_value";
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => `request rejected for ${pat}`,
    }));

    await expect(
      executeManagementQuery(
        "SELECT 1;",
        { pat, projectRef: "testproject" },
        fetchImpl,
      ),
    ).rejects.toThrow("[REDACTED]");

    try {
      await executeManagementQuery(
        "SELECT 1;",
        { pat, projectRef: "testproject" },
        fetchImpl,
      );
    } catch (error) {
      expect(String(error)).not.toContain(pat);
    }
  });
});

describe("read-only accounting rollout audit", () => {
  it("uses a read-only transaction and contains no data/schema mutations", () => {
    expect(AUDIT_SQL).toMatch(/^BEGIN TRANSACTION READ ONLY;/);
    expect(AUDIT_SQL).toMatch(/COMMIT;$/);
    expect(AUDIT_SQL).not.toMatch(
      /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i,
    );
  });

  it("derives locked profit readiness from persisted stale state and source hash drift", () => {
    expect(AUDIT_SQL).toContain(
      "app_private.profit_monthly_source_is_current_v1(profit.id)",
    );
    expect(AUDIT_SQL).toMatch(
      /freshness\.is_stale\s+OR NOT freshness\.source_is_current/,
    );
    expect(AUDIT_SQL).toMatch(
      /NOT freshness\.is_stale\s+AND NOT freshness\.source_is_current/,
    );
    expect(AUDIT_SQL).toContain("'locked_persisted_stale_count'");
    expect(AUDIT_SQL).toContain("'locked_hash_drift_count'");
    expect(AUDIT_SQL).toContain("'locked_unsafe_count'");
    expect(AUDIT_SQL).toContain("'profit_distribution_force_freeze'");
    expect(AUDIT_SQL).toContain("AND NOT feature.force_freeze");
    expect(AUDIT_SQL).toContain("dddd0000-0000-4000-8000-000000000001");
    expect(AUDIT_SQL).toContain("aaaa0000-0000-4000-8000-000000000001");
  });

  it("parses the report row returned by the Management API", () => {
    expect(
      parseAuditResponse(
        JSON.stringify([{ accounting_rollout_report: cleanReport }]),
      ),
    ).toEqual(cleanReport);
  });

  it("blocks schema-integrity failures and unsafe rows in the active profit scope", () => {
    expect(evaluateAuditReport(cleanReport)).toEqual({
      activeUnsafeProfitCount: 0,
      hashDriftProfitCount: 0,
      openExceptionCount: 0,
      payoutExceptionCount: 0,
      persistedStaleProfitCount: 0,
      profitActivationReady: true,
      profitDistributionForceFreeze: false,
      profitDistributionMode: "SHADOW",
      profitReadinessByOrganization: {
        demo: cleanReport.profit_activation_readiness.demo,
        real: cleanReport.profit_activation_readiness.real,
      },
      reversalFailureCount: 0,
      schemaIntegrityReady: true,
      unsafeProfitCount: 0,
    });

    const blockedReports = [
      { ...cleanReport, exceptions: { PAYMENT: 1 } },
      { ...cleanReport, reversal_integrity_failures: 1 },
      { ...cleanReport, payout_exceptions: 1 },
      {
        ...cleanReport,
        profit_activation_readiness: {
          ...cleanReport.profit_activation_readiness,
          overall: {
            locked_hash_drift_count: 1,
            locked_persisted_stale_count: 0,
            locked_unsafe_count: 1,
          },
        },
        profit_active_unsafe_count: 1,
        profit_distribution_mode: "ON",
      },
    ];
    for (const report of blockedReports) {
      expect(() => evaluateAuditReport(report)).toThrow(
        "Accounting rollout audit blocked",
      );
    }
  });

  it("reports stale legacy profit while keeping SHADOW rollout safely inactive", () => {
    expect(
      evaluateAuditReport({
        ...cleanReport,
        profit: { stale_count: 43 },
        profit_activation_readiness: {
          ...cleanReport.profit_activation_readiness,
          overall: {
            locked_hash_drift_count: 0,
            locked_persisted_stale_count: 42,
            locked_unsafe_count: 42,
          },
        },
      }),
    ).toMatchObject({
      activeUnsafeProfitCount: 0,
      hashDriftProfitCount: 0,
      persistedStaleProfitCount: 42,
      profitActivationReady: false,
      profitDistributionMode: "SHADOW",
      schemaIntegrityReady: true,
      unsafeProfitCount: 42,
    });
  });

  it("keeps schema integrity separate when only an inactive source hash has drifted", () => {
    expect(
      evaluateAuditReport({
        ...cleanReport,
        profit_activation_readiness: {
          ...cleanReport.profit_activation_readiness,
          overall: {
            locked_hash_drift_count: 1,
            locked_persisted_stale_count: 0,
            locked_unsafe_count: 1,
          },
        },
      }),
    ).toMatchObject({
      activeUnsafeProfitCount: 0,
      hashDriftProfitCount: 1,
      persistedStaleProfitCount: 0,
      profitActivationReady: false,
      schemaIntegrityReady: true,
      unsafeProfitCount: 1,
    });
  });

  it.each(["CANARY", "ON"])(
    "keeps frozen %s rollout inactive while reporting activation not ready",
    (profitDistributionMode) => {
      expect(
        evaluateAuditReport({
          ...cleanReport,
          profit_activation_readiness: {
            ...cleanReport.profit_activation_readiness,
            overall: {
              locked_hash_drift_count: 1,
              locked_persisted_stale_count: 0,
              locked_unsafe_count: 1,
            },
          },
          profit_distribution_force_freeze: true,
          profit_distribution_mode: profitDistributionMode,
        }),
      ).toMatchObject({
        activeUnsafeProfitCount: 0,
        hashDriftProfitCount: 1,
        profitActivationReady: false,
        profitDistributionForceFreeze: true,
        profitDistributionMode,
        schemaIntegrityReady: true,
        unsafeProfitCount: 1,
      });
    },
  );

  it("reports schema integrity success separately from activation readiness", async () => {
    const report = {
      ...cleanReport,
      profit_activation_readiness: {
        ...cleanReport.profit_activation_readiness,
        overall: {
          locked_hash_drift_count: 1,
          locked_persisted_stale_count: 0,
          locked_unsafe_count: 1,
        },
      },
    };
    const messages = [];
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify([{ accounting_rollout_report: report }]),
    }));

    await auditMain([], {
      fetchImpl,
      loadConfig: () => ({ pat: "test-pat", projectRef: "testproject" }),
      log: (message) => messages.push(message),
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(messages).toContain("Schema integrity audit passed.");
    expect(messages.join("\n")).toContain(
      "Profit activation readiness is NOT READY: 1 unsafe locked row(s)",
    );
    expect(messages).toContain(
      "Read-only accounting rollout audit completed; production data is unchanged.",
    );
  });
});
