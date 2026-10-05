#!/usr/bin/env node
// Gate-code mutants, with real TEST RLS leaks or malformed-count unit cases as witnesses.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const file='scripts/measure-org-leak.mjs', original=readFileSync(file);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const cases=[
 { name:'ignore-foreign-owner', from:'if (n.foreign_total > 0 || n.foreign_null > 0) ro = true;', to:'if (false) ro = true;', suite:'scripts/test-personal-owner-null-gate.mjs', marker:'OWNER LEAK MUST BE DETECTED' },
 { name:'ignore-owner-metadata', from:'if (truth?.[key] !== true) loi.push(`Invalid personal owner metadata: ${key}`);', to:'if (false) loi.push(`Invalid personal owner metadata: ${key}`);', suite:'scripts/test-personal-owner-null-gate.mjs', marker:'FAIL CLOSED: missing exemption' },
 { name:'malformed-count-as-zero', from:"if (typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9]\\d*)$/.test(value))) return null;", to:"if (typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9]\\d*)$/.test(value))) return 0;", suite:'node_modules/vitest/vitest.mjs run scripts/__tests__/measure-org-leak.test.mjs', marker:'rejects invalid count' },
];
for(const c of cases) {
 console.log(`MUTATION ${c.name}`);
 try {
  const result=spawnSync(process.execPath,['scripts/dot-bien.mjs','--file',file,'--tim',c.from,'--thay',c.to,'--suite',`"${process.execPath}" ${c.suite}`,'--mong-doi-chua',c.marker],{stdio:'inherit',timeout:300000});
  assert.equal(result.status,0,`${c.name} was not killed for the expected reason`);
 } finally {
  writeFileSync(file,original); assert.equal(digest(readFileSync(file)),digest(original));
  console.log(`RESTORED ${digest(original)}; TEST schema mutants run only inside ROLLBACK`);
 }
}
console.log(`PASS ${cases.length} owner-NULL gate mutants killed`);
