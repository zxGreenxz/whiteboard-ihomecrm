// Native album proofs on the independently marked TEST database; always ROLLBACK.
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>readFileSync(join(root,p),'utf8');
const base=read('supabase/migrations/20261011052259_zalo_rpc_only_scope_va_atomic_queue.sql');
let migration=read('supabase/migrations/20261012012329_zalo_broadcast_album_phong.sql');
const mutation=process.argv.includes('--mutation-first-photo');
if(mutation){
 const needle='SELECT jsonb_array_elements(v_attachments) LOOP';
 if(!migration.includes(needle))throw Error('Mutation point moved');
 migration=migration.replaceAll(needle,'SELECT jsonb_array_elements(v_attachments) LIMIT 1 LOOP');
}
const folder=mkdtempSync(join(tmpdir(),'ihome-zalo-album-'));
try{
 const path=join(folder,'proof.sql');
 writeFileSync(path,"SET LOCAL client_min_messages='warning';\n"+base+'\n'+migration+"\nSET LOCAL client_min_messages='notice';\n"+read('scripts/tests/zalo-security-atomic.sql')+'\n'+read('scripts/tests/zalo-broadcast-album.sql'));
 const result=spawnSync(process.execPath,[join(root,'scripts/test-env/thu-sql.mjs'),path],{cwd:root,encoding:'utf8',timeout:120000});
 const output=`${result.stdout||''}\n${result.stderr||''}`;
 if(mutation){
  if(result.status===0||!output.includes('ZALO_TEST_ASSERT: album keeps all eight canonical photos')){console.error(output);throw Error('Mutation did not fail at intended assertion');}
  console.log('ALBUM_MUTATION_PASS: dropping later images is detected; transaction rolled back.');
 }else{console.log(output.trim());if(result.status!==0||!output.includes('ALBUM_SQL_PASS:'))process.exitCode=1;}
}finally{rmSync(folder,{recursive:true,force:true});}
