import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { boCommentSql, chuKyHam, docSql, thanHam } from './helpers/sqlTestUtils';

const migrations = resolve(process.cwd(), 'supabase/migrations');
const historyProofMigration = readdirSync(migrations).find(name => name.endsWith('_copilot_g3_owned_voucher_history_proof_v1.sql'));
const raw = historyProofMigration ? docSql(`supabase/migrations/${historyProofMigration}`) : '';
const migration = boCommentSql(raw);
const rpc = 'copilot_g3_owned_voucher_history_proof_v1';
const signature = 'p_organization_id uuid, p_attempt_id uuid, p_case_id int, p_client_request_id text, p_plan_id uuid, p_voucher_id uuid, p_digest_schema_version int, p_expected_ownership_digest text, p_expected_state_digest text, p_expected_approval_version bigint, p_expected_posting_version bigint, p_phase text';

function body(): string {
  const value = thanHam(migration, rpc, 'public');
  const end = /\n\$[a-z_]*\$;/.exec(value);
  return end ? value.slice(0, end.index) : value;
}

describe('G3 owned voucher history proof migration', () => {
  it('defines exactly one read-only public proof RPC with the pinned ABI', () => {
    expect(historyProofMigration).toBeDefined();
    expect(chuKyHam(migration, rpc)).toBe(signature);
    expect(body()).toMatch(/STABLE\s+SECURITY DEFINER/);
    expect(body()).toMatch(/SET search_path = pg_catalog, public, app_private/);
    expect(body()).not.toMatch(/\b(FOR UPDATE|FOR SHARE|INSERT|UPDATE|DELETE)\b/i);
  });

  it('keeps the step-one binding conditional syntactically closed once', () => {
    expect(body()).toMatch(/s\.outcome ->> 'entity_id' = p_voucher_id::text\s*\n\s*\) THEN/);
  });

  it('parenthesizes the CASE expression after IS DISTINCT FROM', () => {
    expect(body()).toMatch(/v_plan\.step_count IS DISTINCT FROM \(CASE WHEN p_case_id = 3 THEN 2 ELSE 1 END\)/);
  });

  it('fails closed on non-DEMO, non-owner, malformed bindings, and nonzero history', () => {
    const source = body();
    expect(source).toMatch(/v_actor IS NULL/);
    expect(source).toMatch(/dddd0000-0000-4000-8000-000000000001/);
    expect(source).toMatch(/owned_fixture_not_found/);
    expect(source).toMatch(/owned_fixture_binding_changed/);
    expect(source).toMatch(/owned_fixture_history_present/);
    expect(source).toMatch(/owned_fixture_state_changed/);
    expect(source).toMatch(/income_expense_postings/);
    expect(source).toMatch(/income_expense_posting_lines/);
    expect(source).toMatch(/income_expense_recognition_adjustments/);
  });

  it('uses the DECIMAL(15,2) text representation that the lifecycle hashes', () => {
    const source = body();
    expect(source).toMatch(/v_voucher\.total_amount::text/);
    expect(source).toMatch(/v_item\.unit_price::text/);
  });

  it('accepts only a terminal C3 step two with no effect, or one exact withdrawn request', () => {
    const source = body();
    expect(source).toMatch(/v_step_two\.status IN \('FAILED', 'BLOCKED', 'SKIPPED'\)/);
    expect(source).toMatch(/v_plan\.status NOT IN \('FAILED', 'CANCELLED', 'EXPIRED'\)/);
    expect(source).toMatch(/r\.maker_user_id = v_actor/);
    expect(source).toMatch(/r\.state = 'CANCELLED'/);
    expect(source).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM public\.approval_requests r/);
  });

  it('returns only the fixed sanitized receipt and has explicit RPC ACLs', () => {
    const source = body();
    for (const key of ['schemaVersion', 'attemptId', 'caseId', 'organizationId', 'planId', 'voucherId', 'phase', 'checkedAt', 'expectedSnapshotMatched', 'approvalVersion', 'postingVersion', 'ownershipVerified', 'postingHistoryComplete', 'zeroPostingHistory', 'noActivePosting', 'noRecognitionAdjustment', 'noUnexpectedFinancialLink', 'cancelledUnpostedVerified']) expect(source).toMatch(new RegExp(`'${key}'`));
    const projection = source.slice(source.lastIndexOf('RETURN jsonb_build_object('));
    expect(projection).not.toMatch(/payload|canonical|nonce|cashbook|posting_id|amount/i);
    expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${rpc}\\([^)]*\\) FROM PUBLIC`));
    expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${rpc}\\([^)]*\\) FROM anon`));
    expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${rpc}\\([^)]*\\) FROM service_role`));
    expect(migration).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${rpc}\\([^)]*\\) TO authenticated`));
  });
});
