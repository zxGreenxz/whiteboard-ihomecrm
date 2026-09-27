import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as drill from '../dien-tap-forward-lane.mjs';

const path = new URL('../../supabase/baseline/restore-contract-termination-acl-fixture.json', import.meta.url);
const fixture = () => readFileSync(path, 'utf8');

test('termination restore fixture guards all twelve measured functions and changes only nine ACLs', () => {
  const sql = drill.taoFixtureAclTermination(fixture());
  assert.match(sql, /^BEGIN;\nSET LOCAL search_path=pg_catalog;/);
  assert.match(sql, /termination ACL before drift/);
  assert.match(sql, /termination ACL after drift/);
  assert.equal((sql.match(/REVOKE ALL ON FUNCTION/g) ?? []).length, 9);
  assert.match(sql, /app_private\.begin_contract_termination_write_v1\(uuid,text\)/);
  assert.match(sql, /public\.guard_contract_termination_settlement\(\)/);
  assert.match(sql, /public\.terminate_contract_move_out_with_credit_v1/);
  assert.match(sql, /p\.prosecdef|prosecdef/);
  assert.match(sql, /p\.proconfig|proconfig/);
  assert.match(sql, /p\.prorettype|prorettype/);
  for (const field of ['md5', 'owner', 'acl', 'secdef', 'volatility', 'config', 'result']) {
    assert.equal((sql.match(new RegExp(`p\\.${field} IS DISTINCT FROM f\\.${field}`, 'g')) ?? []).length, 2, `${field} must be guarded both before and after`);
  }
  assert.doesNotMatch(sql, /CREATE OR REPLACE|ALTER FUNCTION|INSERT INTO|UPDATE |DELETE FROM/);
  assert.match(sql, /COMMIT;$/);
});

test('termination restore fixture is byte pinned and cannot omit, duplicate or forge a signature', () => {
  const original = fixture();
  assert.throws(() => drill.taoFixtureAclTermination(original + ' '), /digest/);
  const parsed = JSON.parse(original);
  for (const mutate of [
    f => f.functions.pop(),
    f => f.functions.push(f.functions[0]),
    f => { f.functions[0].signature = 'public.forged(uuid)'; },
    f => { f.functions[0].before.md5 = '0'.repeat(32); },
    f => { f.functions[0].before.owner = 'anon'; },
    f => { f.functions[0].after.acl = '{anon=X/postgres}'; },
  ]) {
    const changed = structuredClone(parsed);
    mutate(changed);
    assert.throws(() => drill.taoFixtureAclTermination(JSON.stringify(changed)));
  }
});
