// Manual CI job only: uses existing credentials in-place; exports encrypted files,
// never credentials. It does not apply SQL, migrations, policies or financial writes.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assertContext, recipientKey, sealFiles } from './sealed-artifact.mjs';
import { docManifestBackup, chayTruyVanQuanTri } from '../apply-reviewed-migration.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
assertContext({sha:process.env.GITHUB_SHA,expectedSha:process.env.EXPECTED_SHA,ref:process.env.GITHUB_REF,repository:process.env.GITHUB_REPOSITORY,eventName:process.env.GITHUB_EVENT_NAME});
if(process.platform!=='linux')throw new Error('This entry point runs on the Linux maintenance runner');
const recipient=recipientKey(process.env.RECIPIENT_PUBLIC_KEY??'');
if(!process.env.SUPABASE_DB_PASSWORD||!process.env.SUPABASE_PAT)throw new Error('Configured Supabase credentials are required');
const output=join(process.env.RUNNER_TEMP,'org-context-backup');mkdirSync(output,{recursive:true});
const bin=join(tmpdir(),'org-context-pg-client');mkdirSync(bin,{recursive:true});
// Use the same pinned PostgreSQL version as the repository restore drill. Mount
// only the backup/temp directories; the password stays in a 0600 pgpass file.
const backupDir=join(homedir(),'ihomecrm-backups');mkdirSync(backupDir,{recursive:true});
const shq=s=>"'"+s.replaceAll("'","'\\''")+"'";
for(const command of ['pg_dump','pg_restore'])writeFileSync(join(bin,command),
  `#!/bin/sh\nexec docker run --rm --network host --user "$(id -u):$(id -g)" -e PGPASSFILE -v ${shq(backupDir+':'+backupDir)} -v ${shq(tmpdir()+':'+tmpdir())} postgres:17.6 ${command} "$@"\n`,{mode:0o700});
const env={...process.env,PATH:bin+':'+process.env.PATH};
const stdout=execFileSync(process.execPath,[join(root,'scripts/backup-before-schema.mjs'),'--reason','organization-context and attachment repair preflight'],{
 cwd:root,env,encoding:'utf8',timeout:35*60*1000,stdio:['ignore','pipe','pipe'],maxBuffer:4*1024*1024});
const checked=docManifestBackup(stdout);
if(!checked.ok)throw new Error('Backup is not eligible: '+checked.vi);
const manifest=checked.manifest;
if(manifest.projectRef!=='tryymsxyyckgbrmmvozx'||dirname(resolve(manifest.file))!==resolve(backupDir))throw new Error('Unexpected backup destination');
const dump=readFileSync(manifest.file);
if(createHash('sha256').update(dump).digest('hex')!==manifest.sha256)throw new Error('Backup file digest mismatch');
const query=readFileSync(new URL('./snapshot.sql',import.meta.url),'utf8');
const response=await chayTruyVanQuanTri({pat:process.env.SUPABASE_PAT,ref:manifest.projectRef,query});
if(!response.ok)throw new Error('Read-only catalog snapshot failed with HTTP '+response.status);
const payload=JSON.parse(response.body);
const snapshot=payload.at(0)?.snapshot;
if(!Array.isArray(snapshot?.functions)||!Array.isArray(snapshot?.policies)||!Array.isArray(snapshot?.columns))throw new Error('Incomplete catalog snapshot');
const {ciphertext,envelope}=sealFiles([
 {name:basename(manifest.file),bytes:dump},
 {name:basename(manifest.file)+'.json',bytes:JSON.stringify(manifest,null,2)},
 {name:'catalog-snapshot.json',bytes:JSON.stringify(snapshot,null,2)},
],recipient,{sha:process.env.GITHUB_SHA,projectRef:manifest.projectRef});
writeFileSync(join(output,'backup.encrypted'),ciphertext);
writeFileSync(join(output,'envelope.json'),JSON.stringify(envelope,null,2));
const receipt={sha:process.env.GITHUB_SHA,projectRef:manifest.projectRef,createdAt:manifest.createdAt,backupSha256:manifest.sha256,
  tablesWithData:manifest.tablesWithData,excludedTableData:manifest.excludedTableData,functions:snapshot.functions.length,
  policies:snapshot.policies.length,encryptedSha256:envelope.ciphertextSha256};
writeFileSync(join(output,'receipt.json'),JSON.stringify(receipt,null,2));
if(readdirSync(output).sort().join(',')!=='backup.encrypted,envelope.json,receipt.json')throw new Error('Unexpected artifact contents');
console.log(JSON.stringify(receipt));
