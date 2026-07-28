import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../supabase/migrations/20260728180000_income_expense_type_canonicalization.sql",
  import.meta.url,
);
const migrationExists = existsSync(migrationUrl);
const sql = migrationExists ? readFileSync(migrationUrl, "utf8") : "";

describe("income/expense type canonicalization migration", () => {
  it("exists as one atomic migration", () => {
    expect(migrationExists).toBe(true);
    expect(sql.match(/^\s*BEGIN\s*;/gim)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;/gim)).toHaveLength(1);
  });

  it("defines one normalized organization identity and an append-only audit", () => {
    expect(sql).toMatch(
      /create or replace function public\.normalize_income_expense_type_name/i,
    );
    expect(sql).toMatch(
      /create table (?:if not exists )?public\.income_expense_type_merge_audit/i,
    );
    expect(sql).toMatch(/moved_item_ids\s+uuid\[\]/i);
    expect(sql).toMatch(/finance_role_assignments_before\s+jsonb/i);
    expect(sql).toMatch(/alter column organization_id set not null/i);
    expect(sql).toMatch(
      /create unique index income_expense_types_org_side_normalized_name_uq/i,
    );
    expect(sql).toMatch(/revoke all on table[^;]+from public, anon, authenticated/is);
  });

  it("fails closed for accounting or finance-role semantic conflicts", () => {
    expect(sql).toMatch(/conflicting is_deposit/i);
    expect(sql).toMatch(/finance reporting role[^;]+overlap/is);
    expect(sql).toMatch(/organization mismatch/i);
    expect(sql.match(/trigger_row\.tgenabled\s+not in\s*\(\s*'O'\s*,\s*'A'\s*\)/gi)).toHaveLength(2);
  });

  it("repairs legacy cross-organization item references with a separate audit", () => {
    expect(sql).toMatch(
      /create table (?:if not exists )?public\.income_expense_type_reference_repair_audit/i,
    );
    expect(sql).toMatch(/insert into public\.income_expense_type_reference_repair_audit/i);
    expect(sql).toMatch(/cross_org_item_type_repair_map/i);
    expect(sql).toMatch(/source_type_id/i);
    expect(sql).toMatch(/target_type_id/i);
    expect(sql).toMatch(/type organization mismatch remains after repair/i);
  });

  it("audits before moving every live relational reference", () => {
    const auditInsert = sql.search(
      /insert into public\.income_expense_type_merge_audit/i,
    );
    const roleUpdate = sql.search(
      /update public\.finance_reporting_role_assignments/i,
    );
    const disableTriggers = sql.search(
      /alter table public\.income_expense_items disable trigger user/i,
    );
    const itemUpdate = sql.search(/update public\.income_expense_items/i);
    const enableTriggers = sql.search(
      /alter table public\.income_expense_items enable trigger user/i,
    );
    const duplicateDelete = sql.search(
      /delete from public\.income_expense_types/i,
    );
    const uniqueIndex = sql.search(
      /create unique index income_expense_types_org_side_normalized_name_uq/i,
    );

    for (const position of [
      auditInsert,
      roleUpdate,
      disableTriggers,
      itemUpdate,
      enableTriggers,
      duplicateDelete,
      uniqueIndex,
    ]) {
      expect(position).toBeGreaterThanOrEqual(0);
    }
    expect(auditInsert).toBeLessThan(roleUpdate);
    expect(roleUpdate).toBeLessThan(disableTriggers);
    expect(disableTriggers).toBeLessThan(itemUpdate);
    expect(itemUpdate).toBeLessThan(enableTriggers);
    expect(enableTriggers).toBeLessThan(duplicateDelete);
    expect(duplicateDelete).toBeLessThan(uniqueIndex);
  });

  it("moves legacy system writers from user identity to organization identity", () => {
    expect(sql).toMatch(
      /create or replace function public\.seed_commission_expense_types/i,
    );
    expect(sql).toMatch(
      /create or replace function public\.create_commission_voucher/i,
    );
    expect(sql).toMatch(
      /create or replace function public\.resolve_fixed_expense_type/i,
    );
    expect(sql).toMatch(
      /drop trigger if exists on_auth_user_created_seed_commission_types on auth\.users/i,
    );
    expect(sql).toMatch(/t\.organization_id\s*=\s*v_contract\.organization_id/i);
  });

  it("resolves legacy writer organization from current profile or active membership", () => {
    const resolver = sql.match(
      /create or replace function app_private\.resolve_ie_type_org_for_user_v1[\s\S]+?\$resolve_org\$;/i,
    )?.[0];

    expect(resolver).toBeDefined();
    expect(resolver).toMatch(/select profile\.organization_id[\s\S]+into v_organization_id/i);
    expect(resolver).toMatch(/if v_organization_id is not null then[\s\S]+return v_organization_id/i);
    expect(resolver).toMatch(/organization_memberships[\s\S]+status = 'ACTIVE'/i);
    expect(resolver).not.toMatch(/from public\.income_expense_types/i);
  });
});
