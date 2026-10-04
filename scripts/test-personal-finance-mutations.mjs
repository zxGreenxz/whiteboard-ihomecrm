#!/usr/bin/env node
// dot-bien restores source; this driver additionally restores guarded TEST in finally.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { credential, ketNoi, batBuocDichTest, psql } from './test-env/lib.mjs';
const file = 'supabase/migrations/20261004212309_personal_finance_wallets.sql';
const hardening = 'supabase/migrations/20261004212701_personal_finance_rpc_only.sql';
const cred = credential(), { test } = await ketNoi(cred); await batBuocDichTest(cred, test);
const hash = () => createHash('sha256').update(readFileSync(file)).digest('hex');
const original = hash();
const originalSource = readFileSync(file);
const cases = [
 { name: 'owner', from: "IF old IS NULL THEN RAISE EXCEPTION 'personal_permission: entity'", to: "IF false THEN RAISE EXCEPTION 'personal_permission: entity'", marker: 'FAIL owner isolation' },
 { name: 'idempotency', from: 'RETURN cached.result;', to: 'NULL; -- mutant: ignore successful durable replay', marker: 'FAIL idempotency' },
 { name: 'transfer', from: 'CASE WHEN target_wallet_id=w.id THEN amount ELSE -amount END', to: 'CASE WHEN target_wallet_id=w.id THEN amount ELSE amount END', marker: 'FAIL transfer balanced' },
];
for (const c of cases) {
 console.log(`MUTATION ${c.name}`);
 try {
  const suite = `"${process.execPath}" scripts/test-personal-finance.mjs --apply`;
  const result = spawnSync(process.execPath, ['scripts/dot-bien.mjs', '--file', file, '--tim', c.from, '--thay', c.to, '--suite', suite, '--mong-doi-chua', c.marker], { stdio: 'inherit', timeout: 300000 });
  assert.equal(result.status, 0, `mutation ${c.name} did not prove its invariant`);
 } finally {
  // Also restore if the nested runner is terminated before its own finally executes.
  writeFileSync(file,originalSource);
  assert.equal(hash(), original, 'source digest not restored');
  for (const path of [file,hardening]) psql(test, `BEGIN;${readFileSync(path,'utf8')}COMMIT;`);
  console.log(`RESTORED source ${original} and TEST correct migration`);
 }
}
console.log('PASS 3 meaningful mutants killed; source and TEST restored');
