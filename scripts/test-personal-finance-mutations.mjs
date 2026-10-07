#!/usr/bin/env node
// dot-bien restores source; this driver additionally restores guarded TEST in finally.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { credential, ketNoi, batBuocDichTest, psql } from './test-env/lib.mjs';
const file = 'supabase/migrations/20261004212309_personal_finance_wallets.sql';
const hardening = 'supabase/migrations/20261004212701_personal_finance_rpc_only.sql';
const attachments = 'supabase/migrations/20261007155311_personal_transaction_attachments.sql';
const cred = credential(), { test } = await ketNoi(cred); await batBuocDichTest(cred, test);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const originals = new Map([file,attachments].map(path=>[path,{source:readFileSync(path),hash:hash(path)}]));
const cases = [
 { name: 'owner', file:attachments, from: "IF old IS NULL THEN RAISE EXCEPTION 'personal_permission: entity'", to: "IF false THEN RAISE EXCEPTION 'personal_permission: entity'", marker: 'FAIL owner isolation' },
 { name: 'idempotency', from: 'RETURN cached.result;', to: 'NULL; -- mutant: ignore successful durable replay', marker: 'FAIL idempotency' },
 { name: 'transfer', from: 'CASE WHEN target_wallet_id=w.id THEN amount ELSE -amount END', to: 'CASE WHEN target_wallet_id=w.id THEN amount ELSE amount END', marker: 'FAIL transfer balanced' },
 { name: 'last-visible-category', file:attachments, from: "IF entity='category' AND op<>'create' AND", to: "IF false AND op<>'create' AND", marker: 'last visible category' },
];
const selectedNames = process.argv.filter(a=>a.startsWith('--case=')).map(a=>a.slice(7));
assert(selectedNames.every(name=>cases.some(c=>c.name===name)), 'Unknown mutation case');
const selected = cases.filter(c=>!selectedNames.length || selectedNames.includes(c.name));
for (const c of selected) {
 console.log(`MUTATION ${c.name}`);
 try {
  const suite = `"${process.execPath}" scripts/test-personal-finance.mjs --apply`;
  const result = spawnSync(process.execPath, ['scripts/dot-bien.mjs', '--file', c.file??file, '--tim', c.from, '--thay', c.to, '--suite', suite, '--mong-doi-chua', c.marker], { stdio: 'inherit', timeout: 300000 });
  assert.equal(result.status, 0, `mutation ${c.name} did not prove its invariant`);
 } finally {
  // Also restore if the nested runner is terminated before its own finally executes.
  for(const [path,original] of originals){writeFileSync(path,original.source);assert.equal(hash(path),original.hash,'source digest not restored');}
  for (const path of [file,hardening,attachments]) psql(test, `BEGIN;${readFileSync(path,'utf8')}COMMIT;`);
  console.log('RESTORED source digests and TEST correct migrations');
 }
}
console.log(`PASS ${selected.length} meaningful mutants killed; source and TEST restored`);
