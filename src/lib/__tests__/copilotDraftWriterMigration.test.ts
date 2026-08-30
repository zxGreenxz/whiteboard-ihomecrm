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
    expect(body).toMatch(/set_config\('app\.copilot_draft_marker'/i);
    expect(body).toMatch(/copilot_writer_context/i);
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
});
