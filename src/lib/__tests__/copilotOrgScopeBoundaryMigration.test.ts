import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260828160000_copilot_server_scope_v2.sql',
  'utf8',
).replace(/\r\n/g, '\n');
const searchMigration = readFileSync(
  'supabase/migrations/20260829020000_copilot_customer_contract_scope_v1.sql',
  'utf8',
).replace(/\r\n/g, '\n');
const legacyAclMigration = readFileSync(
  'supabase/migrations/20260829060000_copilot_cashbook_legacy_acl_v1.sql',
  'utf8',
).replace(/\r\n/g, '\n');

describe('Copilot server-derived organization boundary', () => {
  it('defines one server-derived RPC boundary for each scoped tool', () => {
    for (const name of [
      'copilot_available_rooms_v1',
      'copilot_invoice_search_v1',
      'copilot_financial_pnl_v1',
      'copilot_occupancy_v1',
      'copilot_invoice_stats_v1',
      'copilot_deposit_summary_v1',
      'copilot_cashbook_settlement_v2',
    ]) {
      expect(migration, `missing ${name}`).toContain(`FUNCTION public.${name}`);
    }
  });

  it('derives building scope from authorized_scope_v3 and rejects forged org/buildings', () => {
    expect(migration).toContain('app_private.authorized_scope_v3');
    expect(migration).toContain("organization_required");
    expect(migration).toContain("not_permitted");
    expect(migration).toContain('p_organization_id');
    expect(migration).not.toContain('p_building_ids uuid[]');
    expect(migration).not.toContain("public.cashbook_settlement_report(p_from, p_to)");
  });

  it('cashbook keeps accounts, sessions, and reconciliations with read-only ACL', () => {
    expect(migration).toContain("'accounts'");
    expect(migration).toContain("'sessions'");
    expect(migration).toContain("'reconciliations'");
    expect(migration).toContain('cashbook_reconciliations');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.copilot_cashbook_settlement_v2');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.copilot_cashbook_settlement_v2');
    expect(migration).toContain('STABLE');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = pg_catalog, public, app_private');
    expect(migration).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\s+(INTO\s+)?public\./i);
  });

  it('revokes browser execution of the superseded v1 cashbook wrapper', () => {
    expect(legacyAclMigration).toContain(
      'REVOKE ALL ON FUNCTION public.copilot_cashbook_settlement_v1(uuid,date,date,uuid[])',
    );
    expect(legacyAclMigration).toContain('FROM PUBLIC, anon, authenticated');
  });

  it('availability preserves the canonical free/soon/pass/holding-deposit semantics', () => {
    expect(migration).toContain('public.room_has_holding_deposit');
    expect(migration).toContain('public.room_pass_listings');
    expect(migration).toContain("status IN ('ACTIVE','EXTENDED')");
    expect(migration).toContain("'status_public', rs.status_public");
    expect(migration).toContain("rs.status_public IN ('free','soon','pass')");
    expect(migration).toContain("b.is_virtual = false");
    expect(migration).not.toContain("'status_public','free'");
    expect(migration).not.toContain("'pass_contact_phone'");
    expect(migration).not.toContain("'pass_contact_name'");
  });

  it('cashbook sessions and reconciliations use participant-aware ACL and explicit fields', () => {
    expect(migration).toMatch(/ch\.giver_id\s*=\s*auth\.uid\(\)/);
    expect(migration).toMatch(/ch\.receiver_id\s*=\s*auth\.uid\(\)/);
    expect(migration).toMatch(/r\.proposed_by\s*=\s*auth\.uid\(\)/);
    expect(migration).toMatch(/r\.counterparty_id\s*=\s*auth\.uid\(\)/);
    expect(migration).toContain('NOT a.is_virtual');
    expect(migration).toContain('public.sandbox_org_ids()');
    expect(migration).toContain('public.demo_user_ids()');
    expect(migration).not.toContain('to_jsonb(ch)');
    expect(migration).not.toContain("'giver_name'");
    expect(migration).not.toContain("'receiver_name'");
    expect(migration).not.toContain("'note'");
  });

  it('customer search and expiring contracts use typed server-side scope boundaries', () => {
    for (const name of ['copilot_customer_search_v1', 'copilot_expiring_contracts_v1']) {
      expect(searchMigration, `missing ${name}`).toContain(`FUNCTION public.${name}`);
    }
    expect(searchMigration).toContain('auth.uid()');
    expect(searchMigration).toContain('customers.view');
    expect(searchMigration).toContain('reports_real_estate.expiring');
    expect(searchMigration).toContain('app_private.authorized_scope_v3');
    expect(searchMigration).toContain('organization_required');
    expect(searchMigration).toContain('not_permitted');
    expect(searchMigration).toContain('RETURNS TABLE');
    expect(searchMigration).not.toContain('p_building_ids uuid[]');
  });

  it('new customer/contract RPCs expose only allowlisted fields and read-only ACL', () => {
    expect(searchMigration).toContain("'room_name'");
    expect(searchMigration).toContain("'building_name'");
    expect(searchMigration).toContain("'customer_name'");
    expect(searchMigration).not.toContain('id_number');
    expect(searchMigration).not.toContain('bank_account_number');
    expect(searchMigration).not.toContain('notes');
    expect(searchMigration).toContain('REVOKE ALL ON FUNCTION public.copilot_customer_search_v1');
    expect(searchMigration).toContain('REVOKE ALL ON FUNCTION public.copilot_expiring_contracts_v1');
    expect(searchMigration).toContain('GRANT EXECUTE ON FUNCTION public.copilot_customer_search_v1');
    expect(searchMigration).toContain('GRANT EXECUTE ON FUNCTION public.copilot_expiring_contracts_v1');
    expect(searchMigration).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\s+(INTO\s+)?public\./i);
  });
});
