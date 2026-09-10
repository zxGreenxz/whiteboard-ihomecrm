// Decrypt/download verification only. Never connects to or restores a database.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, relative, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unsealFiles } from './sealed-artifact.mjs';

const args=process.argv.slice(2);
const get=name=>args[args.indexOf(name)+1];
for(const name of ['--artifact-dir','--private-key','--sha'])if(!args.includes(name)||!get(name)||get(name).startsWith('--'))throw new Error('Required: --artifact-dir PATH --private-key PATH --sha SHA [--out PATH]');
const sha=get('--sha');
const source=resolve(get('--artifact-dir'));
const output=resolve(args.includes('--out')?get('--out'):join(homedir(),'ihomecrm-backups','org-context-'+sha.slice(0,12)));
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const fromRoot=relative(root,output);
if(!fromRoot||(!(fromRoot==='..'||fromRoot.startsWith('..'+sep))&&!isAbsolute(fromRoot)))throw new Error('Decrypted backup must stay outside the repository');
const receipt=JSON.parse(readFileSync(join(source,'receipt.json'),'utf8'));
const envelope=JSON.parse(readFileSync(join(source,'envelope.json'),'utf8'));
if(receipt.sha!==sha||receipt.encryptedSha256!==envelope.ciphertextSha256||receipt.projectRef!=='tryymsxyyckgbrmmvozx')throw new Error('Receipt identity mismatch');
const files=unsealFiles(readFileSync(join(source,'backup.encrypted')),envelope,readFileSync(resolve(get('--private-key'))),sha);
if(files.length!==3||!files.some(x=>x.name==='catalog-snapshot.json'))throw new Error('Incomplete backup payload');
const dump=files.find(x=>/^ihomecrm-full-\d{4}-[0-9TZ-]+\.dump$/.test(x.name));
const manifest=dump&&files.find(x=>x.name===dump.name+'.json');
if(!dump||!manifest||dump.sha256!==receipt.backupSha256)throw new Error('Backup dump or manifest missing/mismatched');
const backup=JSON.parse(manifest.bytes.toString());
if(backup.sha256!==dump.sha256||backup.tablesWithData!==receipt.tablesWithData||backup.kind!=='full'||backup.excludedTableData?.length)throw new Error('Backup manifest mismatch');
for(const file of files)if(existsSync(join(output,file.name)))throw new Error('Refusing to overwrite an existing backup');
if(existsSync(join(output,'local-verification.json')))throw new Error('Local receipt already exists');
mkdirSync(output,{recursive:true});
for(const file of files)writeFileSync(join(output,file.name),file.bytes,{flag:'wx',mode:0o600});
const result={verifiedAt:new Date().toISOString(),sha,projectRef:receipt.projectRef,originalRunnerPath:backup.file,
 localDump:join(output,dump.name),backupSha256:dump.sha256,files:files.map(x=>({name:x.name,sha256:x.sha256}))};
writeFileSync(join(output,'local-verification.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify(result));
