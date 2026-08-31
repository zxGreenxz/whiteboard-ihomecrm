import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260830183259_copilot_draft_writer_v1.sql';
const hardeningPath =
  'supabase/migrations/20260830171108_copilot_income_expense_rpc_hardening_v1.sql';
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n')
  : '';
const hardening = existsSync(hardeningPath)
  ? readFileSync(hardeningPath, 'utf8').replace(/\r\n/g, '\n')
  : '';

function functionBody(sql: string, name: string): string {
  const start = sql.search(new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\s*\\(`, 'i'));
  return start < 0 ? '' : sql.slice(start);
}

describe('Copilot draft writer migration', () => {
  it('adds a forward-only server-recognized draft-only mode to the compat writer', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.ie_compat_insert_v2/i,
    );
    expect(migration).toMatch(/copilot_writer_context/i);
    expect(migration).toMatch(/v_draft_marker\s+text/i);
    expect(migration).toMatch(
      /approval_status[\s\S]{0,700}v_copilot_draft[\s\S]{0,700}UNAPPROVED/i,
    );
    expect(migration).toMatch(/v_copilot_draft[\s\S]{0,700}account_id[\s\S]{0,700}NULL/i);
  });

  it('routes the Copilot execute RPC through draft-only mode', () => {
    const body = functionBody(
      hardening,
      'public\\.copilot_execute_income_expense_v1',
    );
    expect(body).toMatch(/INSERT INTO app_private\.copilot_ie_writer_context_v1/i);
    expect(body).toMatch(/copilot_ie_writer_ready_v1/i);
    expect(body).not.toMatch(/set_config\('app\.copilot_draft_marker'/i);
  });

  it('keeps the writer output contract and idempotency guard', () => {
    const body = functionBody(
      hardening,
      'public\\.copilot_execute_income_expense_v1',
    );
    expect(migration).toMatch(/approval_status[\s\S]{0,500}UNAPPROVED/i);
    expect(migration).toMatch(/posting_status[\s\S]{0,500}UNPOSTED/i);
    expect(body).toMatch(/pg_advisory_xact_lock\s*\(\s*hashtextextended/i);
    expect(body).toMatch(/ON CONFLICT\s*\(idempotency_key\)\s*DO NOTHING/i);
    expect(body).toMatch(/orphan|entity_id[\s\S]{0,300}not found/i);
  });

  it('does not trust ambient client-set GUCs for draft capability', () => {
    expect(migration).toMatch(/app_private\.copilot_ie_writer_context_v1/i);
    expect(migration).toMatch(/pg_current_xact_id\(\)/i);
    expect(migration).toMatch(/marker_digest/i);
    expect(migration).not.toMatch(/current_setting\('app\.copilot_writer_context'/i);
    expect(migration).not.toMatch(/current_setting\('app\.copilot_draft_marker'/i);
    expect(migration).not.toMatch(/set_config\('app\.copilot_writer_context'/i);
    expect(migration).not.toMatch(/set_config\('app\.copilot_draft_marker'/i);
  });

  it('forces actor identity and strips every recurrence/lifecycle field in draft mode', () => {
    expect(migration).toMatch(/'user_id'\s*,\s*auth\.uid\(\)/i);
    expect(migration).not.toMatch(/'user_id'\s*,\s*COALESCE\(\(p_row->>'user_id'/i);
    expect(migration).toMatch(/repeat_next_date/i);
    expect(migration).toMatch(/repeat_parent_id/i);
    expect(migration).toMatch(/'account_id'\s*,\s*NULL/i);
    expect(migration).toMatch(/'repeat_cycle'\s*,\s*'NONE'/i);
  });

  it('server-validates and rebuilds the Copilot item allowlist', () => {
    expect(migration).toMatch(/income_expense_types/i);
    expect(migration).toMatch(/system_only/i);
    expect(migration).toMatch(/income_expense_items/i);
    expect(migration).toMatch(/organization_id\s*=\s*v_org/i);
    expect(migration).toMatch(/jsonb_build_object\([\s\S]{0,500}income_expense_type_id/i);
  });

  it('enables the private capability only after replacing the shared writer', () => {
    expect(migration).toMatch(
      /UPDATE app_private\.copilot_ie_writer_capabilities_v1[\s\S]{0,500}enabled\s*=\s*true/i,
    );
    expect(migration).toMatch(/writer_version\s*=\s*'draft-v1'/i);
  });

  it('can replay the writer migration without relying on the preceding migration transaction', () => {
    expect(migration).toMatch(
      /CREATE TABLE IF NOT EXISTS app_private\.copilot_ie_writer_context_v1/i,
    );
    expect(migration).toMatch(
      /CREATE TABLE IF NOT EXISTS app_private\.copilot_ie_writer_capabilities_v1/i,
    );
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION app_private\.copilot_ie_writer_ready_v1/i,
    );
  });
});
