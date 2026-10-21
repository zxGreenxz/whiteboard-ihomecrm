import { describe, expect, it } from 'vitest';

import { boCommentSql, docSql } from './helpers/sqlTestUtils';

// File gốc (G1-C) giữ phần chỉ thuộc về nó: transaction, cờ rollout. Thân hàm SỐNG đã dời sang
// 20261021171250 (chưa đọc = PENDING, bỏ CANCELLED) — soi thân ở bản sống, không ở file đóng băng.
const migration = boCommentSql(
  docSql('supabase/migrations/20260908105446_copilot_notification_feed_v1.sql'),
);
const live = boCommentSql(
  docSql('supabase/migrations/20261021171250_thong_bao_chua_doc_bo_cancelled_v1.sql'),
);

function functionBody(source: string, name: string): string {
  const start = source.search(
    new RegExp(`create or replace function public\\.${name}\\s*\\(`, 'i'),
  );
  if (start < 0) return '';
  const rest = source.slice(start + 1);
  const acl = rest.search(/^REVOKE ALL ON FUNCTION/mi);
  return acl < 0 ? source.slice(start) : source.slice(start, start + 1 + acl);
}

describe('copilot notification feed migration', () => {
  const body = () => functionBody(live, 'copilot_notification_feed_v1');

  it('is one lock-bounded, replayable transaction', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toContain("SET LOCAL lock_timeout = '15s';");
    expect(live.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(live.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('is authenticated, stable, and denied by the dedicated notification rollout by default', () => {
    expect(body()).toMatch(/auth\.uid\(\)/);
    expect(body()).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER/);
    expect(body()).toMatch(/SET search_path = pg_catalog, public, app_private/);
    expect(body()).toMatch(/copilot_page_flag_allows_v1\('copilot\.notifications\.feed', p_organization_id\)/);
    expect(migration).toMatch(/'page',\s*'copilot\.notifications\.feed',\s*'disabled'/);
    // Bản sống không đụng cờ rollout.
    expect(live).not.toMatch(/copilot_feature_flags/);
  });

  it('requires notifications.view, the selected organization, and the caller own in-app rows', () => {
    expect(body()).toMatch(/authorized_scope_v3\('notifications\.view', p_organization_id\)/);
    expect(body()).toMatch(/COALESCE\(v_allowed, false\)/);
    expect(body()).toMatch(/n\.organization_id = p_organization_id/);
    expect(body()).toMatch(/n\.user_id = v_actor/);
    expect(body()).toMatch(/n\.channel = 'IN_APP'/);
  });

  it('counts unread exactly like the bell (status PENDING) and hides CANCELLED rows', () => {
    expect(body()).toMatch(/count\(\*\) FILTER \(WHERE public\.notification_is_unread_v1\(n\.status\)\)/);
    expect(body()).toMatch(/OR public\.notification_is_unread_v1\(n\.status\)\)/);
    expect(body().match(/n\.status IS DISTINCT FROM 'CANCELLED'/g)).toHaveLength(2);
    expect(body()).not.toMatch(/IS DISTINCT FROM 'READ'/);
  });

  it('returns only bounded category, state and timestamp facts, never notification content or recipients', () => {
    expect(body()).toMatch(/least\(greatest\(coalesce\(p_limit, 20\), 1\), 50\)/);
    expect(body()).toMatch(/LIMIT v_limit/);
    expect(body()).toMatch(/'tong_chua_doc'/);
    expect(body()).not.toMatch(/content|subject|recipient_|metadata|error_message|invoice_id|contract_id|issue_id|job_id/i);
  });

  it('grants the ABI only to authenticated callers and proves catalog properties', () => {
    for (const source of [migration, live]) {
      expect(source).toMatch(/REVOKE ALL ON FUNCTION public\.copilot_notification_feed_v1\([^)]*\) FROM PUBLIC, anon, authenticated, service_role;/);
      expect(source).toMatch(/GRANT EXECUTE ON FUNCTION public\.copilot_notification_feed_v1\([^)]*\) TO authenticated;/);
      const acceptance = source.slice(source.indexOf('DO $nghiem_thu$'));
      expect(acceptance).toContain('to_regprocedure');
      expect(acceptance).toContain('has_function_privilege');
      expect(acceptance).not.toMatch(/FROM public\.[a-z_]+/i);
    }
  });
});
