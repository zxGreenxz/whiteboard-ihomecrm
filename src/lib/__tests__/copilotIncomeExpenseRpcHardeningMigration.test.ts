import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260830171108_copilot_income_expense_rpc_hardening_v1.sql';
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n')
  : '';
const restrictedGuardPath =
  'supabase/migrations/20260831110236_copilot_restricted_category_guard_v1.sql';
const restrictedGuard = existsSync(restrictedGuardPath)
  ? readFileSync(restrictedGuardPath, 'utf8').replace(/\r\n/g, '\n')
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
    expect(migration).toMatch(/b\.id\s*=\s*ANY\s*\(\s*coalesce\(v_scope\.building_ids/i);
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

  it('enforces system-only and restricted-category policy in preview and execute', () => {
    expect(migration).toMatch(/NOT\s+coalesce\(t\.system_only,\s*false\)/i);
    expect(migration).toMatch(/t\.is_restricted/i);
    expect(migration).toMatch(/public\.can_create_restricted_ie\(\)/i);
    const body = executeBody(migration);
    const typeCheck = body.search(/v_type_row|income_expense_types/i);
    const insert = body.indexOf('public.ie_compat_insert_v2(');
    expect(typeCheck).toBeGreaterThan(0);
    expect(typeCheck).toBeLessThan(insert);
    expect(body.slice(typeCheck, insert)).toMatch(/is_restricted/i);
    expect(body.slice(typeCheck, insert)).toMatch(/can_create_restricted_ie/i);
  });

  it('ships a forward wrapper that protects already-applied RPC bodies', () => {
    expect(restrictedGuard).toMatch(/copilot_ie_type_allowed_v1/i);
    expect(restrictedGuard).toMatch(/FOR SHARE/i);
    expect(restrictedGuard).toMatch(/v_type\.is_restricted/i);
    expect(restrictedGuard).toMatch(/v_type\.system_only/i);
    expect(restrictedGuard).toMatch(/can_create_restricted_ie/i);
    expect(restrictedGuard).toMatch(/copilot_preview_income_expense_legacy_v1/i);
    expect(restrictedGuard).toMatch(/copilot_execute_income_expense_legacy_v1/i);
    expect(restrictedGuard).toMatch(/REVOKE EXECUTE ON FUNCTION public\.copilot_preview_income_expense_legacy_v1/i);
    expect(restrictedGuard).toMatch(/REVOKE EXECUTE ON FUNCTION public\.copilot_execute_income_expense_legacy_v1/i);
  });

  it('forces exactly one draft voucher and rejects approved or posted writer output', () => {
    const body = executeBody(migration);
    expect((body.match(/public\.ie_compat_insert_v2\(/g) ?? []).length).toBe(1);
    expect(body).toMatch(/'repeat_auto_approve'\s*,\s*false/i);
    expect(body).toMatch(/approval_status\s+IS DISTINCT FROM\s+'UNAPPROVED'/i);
    expect(body).toMatch(/posting_status\s+IS DISTINCT FROM\s+'UNPOSTED'/i);
    expect(body).toMatch(/copilot_draft_invariant_violation/i);
  });

  it('validates nonce encoding and pins the exact tool and permission', () => {
    const body = executeBody(migration);
    const formatCheck = body.search(/p_confirmation_nonce\s*!~\s*['"][\^]?\[0-9a-fA-F\]/i);
    const decode = body.indexOf("decode(p_confirmation_nonce, 'hex')");
    expect(formatCheck).toBeGreaterThan(0);
    expect(formatCheck).toBeLessThan(decode);
    expect(body).toMatch(/v_row\.tool\s+IS DISTINCT FROM\s*'tao_phieu_thu_chi_nhap'/i);
    expect(body).toMatch(/v_row\.permission_key\s+IS DISTINCT FROM\s*'income_expenses\.create'/i);
  });

  it('binds idempotency to actor, organization, tool, permission and payload', () => {
    const body = executeBody(migration);
    const key = body.match(/v_key\s*:=([\s\S]{0,900});/i)?.[0] ?? '';
    expect(key).toMatch(/v_actor/i);
    expect(key).toMatch(/v_org/i);
    expect(key).toMatch(/v_row\.tool/i);
    expect(key).toMatch(/permission_key/i);
    expect(key).toMatch(/v_hash/i);
  });

  it('replay verifies the complete audit, voucher and item identity', () => {
    const body = executeBody(migration);
    const replay = body.slice(body.indexOf('IF FOUND THEN'), body.indexOf('SELECT coalesce'));
    expect(replay).toMatch(/v_prev\.user_id/i);
    expect(replay).toMatch(/v_prev\.organization_id/i);
    expect(replay).toMatch(/v_prev\.tool/i);
    expect(replay).toMatch(/entity_table/i);
    expect(replay).toMatch(/payload_hash|copilot_payload_hash_v1/i);
    expect(replay).toMatch(/income_expense_items/i);
    expect(replay).toMatch(/building_id/i);
    expect(replay).toMatch(/approval_status/i);
    expect(replay).toMatch(/posting_status/i);
  });

  it('uses a private transaction capability and fails closed before the writer is ready', () => {
    expect(migration).toMatch(/copilot_ie_writer_context_v1/i);
    expect(migration).toMatch(/copilot_ie_writer_ready_v1/i);
    const body = executeBody(migration);
    expect(body).toMatch(/copilot_writer_context_invalid|writer_not_ready/i);
    expect(body).toMatch(/INSERT INTO app_private\.copilot_ie_writer_context_v1/i);
    expect(body).not.toMatch(/set_config\('app\.copilot_writer_context'/i);
  });
});
