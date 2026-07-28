import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH =
  "supabase/migrations/20260728010000_business_performance_month_snapshots.sql";

function migrationSql(): string {
  return readFileSync(MIGRATION_PATH, "utf8");
}

describe("business-performance month snapshot migration", () => {
  it("creates a tenant-bound manifest and replace-set detail tables", () => {
    const sql = migrationSql();

    expect(sql).toContain("CREATE TABLE public.finance_month_snapshot_runs");
    expect(sql).toContain("CREATE TABLE public.finance_room_month_snapshots");
    expect(sql).toContain("CREATE TABLE public.finance_contract_month_snapshots");
    expect(sql).toMatch(/organization_id\s+uuid\s+NOT NULL/i);
    expect(sql).toContain("finance_month_snapshot_runs_org_month_uq");
    expect(sql).toContain("finance_room_month_snapshots_run_room_uq");
    expect(sql).toContain("finance_contract_month_snapshots_run_contract_uq");
    expect(sql).toContain("PROVISIONAL");
    expect(sql).toContain("FINALIZED");
    expect(sql).toContain("MISSED");
    expect(sql).toContain("Asia/Ho_Chi_Minh");
  });

  it("enables RLS and denies direct client access to all snapshot tables", () => {
    const sql = migrationSql();
    const tables = [
      "finance_month_snapshot_runs",
      "finance_room_month_snapshots",
      "finance_contract_month_snapshots",
    ];

    for (const table of tables) {
      expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(
        `REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated`,
      );
    }
  });

  it("captures an atomic physical-only replace-set with validation", () => {
    const sql = migrationSql();

    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION app_private.capture_finance_month_snapshot_v1",
    );
    expect(sql).toContain(
      "capture_finance_month_snapshot_v1(uuid, timestamptz, boolean)",
    );
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toMatch(/DELETE FROM public\.finance_room_month_snapshots/i);
    expect(sql).toMatch(/DELETE FROM public\.finance_contract_month_snapshots/i);
    expect(sql).toMatch(/is_virtual\s*=\s*false/i);
    expect(sql).toContain("OCCUPIED");
    expect(sql).toContain("RESERVED");
    expect(sql).toContain("MAINTENANCE");
    expect(sql).toContain("AVAILABLE");
    expect(sql).toContain("UNAVAILABLE");
    expect(sql).toContain("capture_version");
    expect(sql).toContain("validation_summary");
    expect(sql).toContain("snapshot partition validation failed");
  });

  it("starts capture versions at one and does not flag the scheduled cron instant as late", () => {
    const sql = migrationSql();

    expect(sql).toMatch(
      /INSERT INTO public\.finance_month_snapshot_runs[\s\S]*?'PROVISIONAL',\s*0,\s*0,\s*0,/i,
    );
    expect(sql).toMatch(/capture_version\s*=\s*run\.capture_version\s*\+\s*1/i);
    expect(sql).toMatch(
      /v_is_late\s*:=\s*p_as_of_timestamp\s*>\s*v_scheduled_for\s*\+\s*interval\s*'5 minutes'/i,
    );
  });

  it("makes finalized and missed runs plus their details immutable", () => {
    const sql = migrationSql();

    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION app_private.guard_finance_month_snapshot_immutability_v1",
    );
    expect(sql).toContain("finance_month_snapshot_runs_immutable_guard");
    expect(sql).toContain("finance_room_month_snapshots_immutable_guard");
    expect(sql).toContain("finance_contract_month_snapshots_immutable_guard");
    expect(sql).toMatch(/OLD\.status\s+IN\s*\('FINALIZED',\s*'MISSED'\)/i);
  });

  it("exposes only scoped aggregate history and preserves missing months", () => {
    const sql = migrationSql();

    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION public.business_performance_inventory_history_v1",
    );
    expect(sql).toContain(
      "business_performance_inventory_history_v1(uuid, date, date, uuid[])",
    );
    expect(sql).toContain("business_performance_exact_scope_v1");
    expect(sql).toMatch(/p_require_restricted\s*=>\s*true/);
    expect(sql).toContain("snapshot_status");
    expect(sql).toContain("as_of_timestamp");
    expect(sql).toContain("listed_rent_opportunity");
    expect(sql).toContain("invalid_rent_room_count");
    expect(sql).toContain("snapshot_missing");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.business_performance_inventory_history_v1(uuid, date, date, uuid[]) TO authenticated");
  });

  it("schedules current capture and missed-cutoff monitoring without backfill", () => {
    const sql = migrationSql();

    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION app_private.run_finance_month_snapshot_job_v1",
    );
    expect(sql).toContain("finance_month_snapshot_daily_v1");
    expect(sql).toContain("cron.unschedule");
    expect(sql).toContain("cron.schedule");
    expect(sql).toContain("MISSED");
    expect(sql).toContain("ROLLOUT");
    expect(sql).toContain("No historical backfill");
  });
});
