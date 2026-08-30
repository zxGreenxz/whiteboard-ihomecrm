import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260830171108_copilot_income_expense_rpc_hardening_v1.sql';
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n')
  : '';

function executeBody(sql: string): string {
  const start = sql.search(
    /CREATE OR REPLACE FUNCTION public\.copilot_execute_income_expense_v1\s*\(/i,
  );
  return start < 0 ? '' : sql.slice(start);
}

describe('Copilot income/expense write RPC hardening', () => {
  it('restricts preview to the resolved target building scope', () => {
    expect(migration).toMatch(
      /authorized_scope_v3\(\s*'income_expenses\.create'\s*,\s*p_organization_id\s*\)/i,
    );
    expect(migration).toMatch(/v_building\.id\s*=\s*ANY\s*\(/i);
    expect(migration).toMatch(/v_scope\.org_wide/i);
    expect(migration).toMatch(/RAISE EXCEPTION 'not_permitted'/i);
  });

  it('re-checks actor permission and target scope after nonce validation before insert', () => {
    const body = executeBody(migration);
    const insert = body.indexOf('public.ie_compat_insert_v2(');
    const scope = body.search(/authorized_scope_v3\(\s*'income_expenses\.create'/i);
    const consume = body.indexOf('SET consumed_at = clock_timestamp()');
    expect(insert).toBeGreaterThan(0);
    expect(scope).toBeGreaterThan(0);
    expect(consume).toBeGreaterThan(0);
    expect(scope).toBeLessThan(consume);
    expect(scope).toBeLessThan(insert);
    expect(body.slice(scope, insert)).toMatch(/v_target_building|building_id/i);
    expect(body.slice(scope, insert)).toMatch(/RAISE EXCEPTION 'not_permitted'/i);
  });

  it('forces exactly one draft voucher and rejects approved or posted writer output', () => {
    const body = executeBody(migration);
    expect((body.match(/public\.ie_compat_insert_v2\(/g) ?? []).length).toBe(1);
    expect(body).toMatch(/'repeat_auto_approve'\s*,\s*false/i);
    expect(body).toMatch(/approval_status\s+IS DISTINCT FROM\s+'UNAPPROVED'/i);
    expect(body).toMatch(/posting_status\s+IS DISTINCT FROM\s+'UNPOSTED'/i);
    expect(body).toMatch(/copilot_draft_invariant_violation/i);
  });
});
