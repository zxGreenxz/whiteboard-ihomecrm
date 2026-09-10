import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { assertContext, recipientKey, sealFiles, unsealFiles } from './sealed-artifact.mjs';
const pair=generateKeyPairSync('rsa',{modulusLength:3072});
const publicPem=pair.publicKey.export({type:'spki',format:'pem'});
const identity={sha:'a'.repeat(40),projectRef:'tryymsxyyckgbrmmvozx'};
test('backup is confidential, authenticated and restored byte-for-byte only for the expected recipient and commit',()=>{
 const plaintext=Buffer.from('private financial backup fixture');
 const key=recipientKey(Buffer.from(publicPem).toString('base64'));
 const result=sealFiles([{name:'fixture.dump',bytes:plaintext}],key,identity);
 assert.equal(result.ciphertext.includes(plaintext),false);
 assert.deepEqual(unsealFiles(result.ciphertext,result.envelope,pair.privateKey,identity.sha)[0].bytes,plaintext);
 assert.throws(()=>unsealFiles(result.ciphertext,result.envelope,pair.privateKey,'b'.repeat(40)),/identity mismatch/);
 const other=generateKeyPairSync('rsa',{modulusLength:3072});
 assert.throws(()=>unsealFiles(result.ciphertext,result.envelope,other.privateKey,identity.sha));
 const corrupt=Buffer.from(result.ciphertext);corrupt[0]^=1;
 // Updating an untrusted outer digest must not bypass GCM authentication.
 const envelope={...result.envelope,ciphertextSha256:createHash('sha256').update(corrupt).digest('hex')};
 assert.throws(()=>unsealFiles(corrupt,envelope,pair.privateKey,identity.sha));
});
test('unreviewed commits, automatic events, foreign branches and unsafe filenames are rejected',()=>{
 const valid={sha:identity.sha,expectedSha:identity.sha,ref:'refs/heads/main',repository:'zxGreenxz/whiteboard-ihomecrm',eventName:'workflow_dispatch'};
 assert.doesNotThrow(()=>assertContext(valid));
 for(const changes of [{sha:'b'.repeat(40)},{eventName:'pull_request'},{ref:'refs/heads/production'},{repository:'fork/whiteboard'}])assert.throws(()=>assertContext({...valid,...changes}));
 for(const name of ['../backup.dump','C:/backup.dump','dir\\backup.dump'])assert.throws(()=>sealFiles([{name,bytes:'x'}],pair.publicKey,identity));
 assert.throws(()=>sealFiles([{name:'x',bytes:'a'},{name:'x',bytes:'b'}],pair.publicKey,identity));
 const small=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'pem'});
 assert.throws(()=>recipientKey(Buffer.from(small).toString('base64')),/3072/);
});
test('maintenance workflow requires manual dispatch and exports only the sealed directory',()=>{
 const workflow=yaml.load(readFileSync(new URL('../../.github/workflows/org-context-backup.yml',import.meta.url),'utf8'));
 assert.deepEqual(Object.keys(workflow.on),['workflow_dispatch']);
 assert.equal(workflow.concurrency['cancel-in-progress'],false);
 const upload=workflow.jobs.backup.steps.find(x=>x.uses?.startsWith('actions/upload-artifact@'));
 assert.equal(upload.with.path,'${{ runner.temp }}/org-context-backup/');
 assert.equal(upload.with['if-no-files-found'],'error');
 const script=readFileSync(new URL('./capture-backup.mjs',import.meta.url),'utf8');
 assert.ok(!script.includes('--apply'));
 const sql=readFileSync(new URL('./snapshot.sql',import.meta.url),'utf8');
 assert.match(sql,/^BEGIN TRANSACTION READ ONLY;/);
 assert.match(sql,/ROLLBACK;\s*$/);
});

test('downloaded artifact verifies before writing, restores exact files, and never overwrites a backup',()=>{
 const temporary=mkdtempSync(join(tmpdir(),'org-backup-test-'));
 try{
  const source=join(temporary,'artifact'),output=join(temporary,'restored'),privateKey=join(temporary,'private.pem');
  mkdirSync(source);
  writeFileSync(privateKey,pair.privateKey.export({type:'pkcs8',format:'pem'}));
  const name='ihomecrm-full-2026-09-10T12-00-00Z.dump',bytes=Buffer.from('binary dump fixture\0\xff');
  const backupSha256=createHash('sha256').update(bytes).digest('hex');
  const manifest={file:'/runner/'+name,sha256:backupSha256,tablesWithData:500,kind:'full',excludedTableData:[]};
  const sealed=sealFiles([{name,bytes},{name:name+'.json',bytes:JSON.stringify(manifest)},{name:'catalog-snapshot.json',bytes:'{}'}],pair.publicKey,identity);
  const receipt={...identity,backupSha256,tablesWithData:500,encryptedSha256:sealed.envelope.ciphertextSha256};
  writeFileSync(join(source,'backup.encrypted'),sealed.ciphertext);
  writeFileSync(join(source,'envelope.json'),JSON.stringify(sealed.envelope));
  const receiptPath=join(source,'receipt.json');writeFileSync(receiptPath,JSON.stringify(receipt));
  const cli=fileURLToPath(new URL('./unseal-backup.mjs',import.meta.url));
  const run=out=>spawnSync(process.execPath,[cli,'--artifact-dir',source,'--private-key',privateKey,'--sha',identity.sha,'--out',out],{encoding:'utf8'});
  const inside=fileURLToPath(new URL('../../..hidden-backup-test',import.meta.url));
  assert.notEqual(run(inside).status,0);
  writeFileSync(receiptPath,JSON.stringify({...receipt,backupSha256:'0'.repeat(64)}));
  assert.notEqual(run(output).status,0);
  assert.deepEqual(readdirSync(temporary).sort(),['artifact','private.pem']);
  writeFileSync(receiptPath,JSON.stringify(receipt));
  const restored=run(output);assert.equal(restored.status,0,restored.stderr);
  assert.deepEqual(readFileSync(join(output,name)),bytes);
  assert.deepEqual(JSON.parse(readFileSync(join(output,name+'.json'))),manifest);
  assert.equal(readdirSync(output).length,4);
  assert.notEqual(run(output).status,0);
  assert.deepEqual(readFileSync(join(output,name)),bytes);
 }finally{rmSync(temporary,{recursive:true,force:true});}
});
