// Contract test for the G1-C1 read migration.
//
// The four RPCs below cannot be exercised from vitest (they need a cluster and a
// JWT), so what is checked here is the part that a reviewer forgets first and
// that no type system catches: the authorization preamble, the row cap, the ACL
// and the "runs on an empty database" property of the acceptance block.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260902193151_copilot_read_rpc_contracts_ie_approvals_v1.sql';
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n')
  : '';

/** Body of one `CREATE OR REPLACE FUNCTION <name>` up to its closing `$fn$;`. */
function functionBody(name: string): string {
  const start = migration.search(
    new RegExp(`create or replace function public\\.${name}\\s*\\(`, 'i'),
  );
  if (start < 0) return '';
  const end = migration.indexOf('\n$fn$;', start);
  return end < 0 ? migration.slice(start) : migration.slice(start, end + '\n$fn$;'.length);
}

const RPCS = [
  'copilot_contract_search_v1',
  'copilot_contract_detail_v1',
  'copilot_income_expense_search_v1',
  'copilot_pending_requests_v1',
] as const;

const LIMITED = ['copilot_contract_search_v1', 'copilot_income_expense_search_v1', 'copilot_pending_requests_v1'] as const;

describe('copilot read RPC migration — contracts, vouchers, pending inbox', () => {
  it('exists and is a single lock-bounded transaction', () => {
    expect(migration).not.toBe('');
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toMatch(/SET LOCAL lock_timeout = '15s';/);
  });

  it('declares every RPC SECURITY DEFINER, STABLE and with a pinned search_path', () => {
    for (const rpc of RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).not.toBe('');
      expect(body, rpc).toMatch(/\bSECURITY DEFINER\b/);
      expect(body, rpc).toMatch(/\bSTABLE\b/);
      expect(body, rpc).toMatch(/SET search_path = pg_catalog, public, app_private/);
      expect(body, rpc).toMatch(/LANGUAGE plpgsql/);
      // plpgsql (not sql) matters: a `LANGUAGE sql` body is parsed at CREATE time
      // and would make this migration unrunnable on an empty database.
    }
  });

  it('takes the organization boundary from the server, never from the caller', () => {
    for (const rpc of RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).toMatch(/p_organization_id uuid/);
      expect(body, rpc).toMatch(
        /copilot_org_scope_buildings_v1\('(?:contracts|income_expenses)\.view', p_organization_id\)/,
      );
      expect(body, rpc).toMatch(/auth\.uid\(\)/);
      expect(body, rpc).toMatch(/not_permitted/);
      // No RPC may accept a client-supplied building/cashbook array.
      expect(body, rpc).not.toMatch(/p_building_ids|p_cashbook_ids/);
    }
  });

  it('clamps p_limit to 1..50 and echoes the effective cap', () => {
    for (const rpc of LIMITED) {
      const body = functionBody(rpc);
      expect(body, rpc).toMatch(/least\(greatest\(coalesce\(p_limit, 20\), 1\), 50\)/);
      expect(body, rpc).toMatch(/LIMIT v_limit/);
      expect(body, rpc).toMatch(/'gioi_han', v_limit/);
    }
    // The detail RPC has no p_limit: its invoice list is capped by a literal.
    expect(functionBody('copilot_contract_detail_v1')).toMatch(/LIMIT 5/);
  });

  it('keeps restricted income/expense categories behind their own permission', () => {
    const body = functionBody('copilot_income_expense_search_v1');
    expect(body).toMatch(/can_view_restricted_ie\(\)/);
    expect(body).toMatch(/v_thay_han_che OR NOT COALESCE\(ie\.has_restricted_item, false\)/);
  });

  it('reads the pending inbox instead of deciding anything', () => {
    const body = functionBody('copilot_pending_requests_v1');
    expect(body).toMatch(/FROM public\.list_my_pending_approvals_v1\(\) p/);
    expect(body).toMatch(/WHERE p\.organization_id = p_organization_id/);
    // No write verb may appear anywhere in the migration.
    expect(migration).not.toMatch(/\b(?:INSERT INTO|UPDATE\s+public\.|DELETE FROM)\b/i);
  });

  it('revokes PUBLIC/anon/authenticated then grants only authenticated', () => {
    for (const rpc of RPCS) {
      expect(migration, rpc).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${rpc}\\([^)]*\\) FROM PUBLIC;`),
      );
      expect(migration, rpc).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${rpc}\\([^)]*\\) FROM anon;`),
      );
      expect(migration, rpc).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${rpc}\\([^)]*\\) FROM authenticated;`),
      );
      expect(migration, rpc).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${rpc}\\([^)]*\\) TO authenticated;`),
      );
    }
    // The folding helper is an internal detail: revoked from everyone, granted
    // to nobody. It is reachable only through the SECURITY DEFINER owners.
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION app_private\.copilot_fold_text_v1\(text\) FROM authenticated;/,
    );
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION app_private\.copilot_fold_text_v1/,
    );
  });

  it('guards role-dependent statements so a bare cluster can replay it', () => {
    expect(migration).toMatch(/IF to_regrole\('anon'\) IS NOT NULL THEN/);
    expect(migration).toMatch(/IF to_regrole\('authenticated'\) IS NOT NULL THEN/);
  });

  it('accepts on the catalog only — no fixture row, no data read', () => {
    const start = migration.indexOf('DO $nghiem_thu$');
    expect(start).toBeGreaterThan(0);
    const block = migration.slice(start);
    expect(block).toMatch(/to_regprocedure/);
    expect(block).toMatch(/has_function_privilege\('anon'/);
    for (const rpc of RPCS) expect(block, rpc).toContain(rpc);
    // A SELECT against a business table here would break the empty-DB property.
    expect(block).not.toMatch(/FROM public\.[a-z_]+/i);
  });

  it('picks the unaccent-aware folding body from the catalog, not from a guess', () => {
    expect(migration).toMatch(/to_regprocedure\('extensions\.unaccent\(text\)'\) IS NOT NULL/);
    expect(migration).toMatch(/CREATE SCHEMA IF NOT EXISTS app_private;/);
  });

  it('is replayable: every DDL statement is CREATE OR REPLACE or IF NOT EXISTS', () => {
    const creates = migration.match(/^\s*CREATE (?!OR REPLACE|SCHEMA IF NOT EXISTS)[A-Z]/gm) ?? [];
    expect(creates).toEqual([]);
  });
});
