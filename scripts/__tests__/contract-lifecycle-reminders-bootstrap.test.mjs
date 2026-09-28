import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildLifecycleCronSql } from '../test-env/bootstrap-lifecycle-reminders.mjs';
import * as bootstrap from '../test-env/bootstrap-lifecycle-reminders.mjs';
const ref = 'abcdefghijklmnopqrst';
const token = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fake-test-signature`;
test('TEST-only bootstrap rejects production and wrong-project/non-service tokens', () => {
  assert.throws(()=>buildLifecycleCronSql('tryymsxyyckgbrmmvozx',token({role:'service_role',ref})),/never production/);
  assert.throws(()=>buildLifecycleCronSql(ref,token({role:'authenticated',ref})),/this TEST project/);
  assert.throws(()=>buildLifecycleCronSql(ref,token({role:'service_role',ref:'different'})),/this TEST project/);
});
test('bootstrap is an independent 15-minute server schedule with marker, private vault and idempotent job replacement', () => {
  const sql = buildLifecycleCronSql(ref,token({role:'service_role',ref}));
  assert.match(sql,/test_env\.danh_dau WHERE ref=/);
  assert.match(sql,/vault\.create_secret/);
  assert.match(sql,/cron\.unschedule/);
  assert.match(sql,/\*\/15 \* \* \* \*/);
  assert.match(sql,/\/functions\/v1\/lifecycle-reminders/);
  assert.match(sql,/REVOKE ALL ON FUNCTION test_env\.dispatch/);
  assert.doesNotMatch(sql,/salary-v5|v5_cron|E6|income_expenses|refund/i);
});

test('provisions the dedicated Edge secret with exactly the validated TEST JWT used in Vault', () => {
  assert.equal(typeof bootstrap.buildLifecycleEdgeSecrets, 'function');
  const jwt = token({role:'service_role',ref});
  assert.deepEqual(bootstrap.buildLifecycleEdgeSecrets(ref,jwt), [{name:'LIFECYCLE_REMINDERS_SERVICE_JWT',value:jwt}]);
  assert.ok(buildLifecycleCronSql(ref,jwt).includes("vault.create_secret('"+jwt+"','test_lifecycle_service_jwt')"));
  assert.throws(()=>bootstrap.buildLifecycleEdgeSecrets('tryymsxyyckgbrmmvozx',jwt),/never production/);
  assert.throws(()=>bootstrap.buildLifecycleEdgeSecrets(ref,token({role:'authenticated',ref})),/this TEST project/);
});
