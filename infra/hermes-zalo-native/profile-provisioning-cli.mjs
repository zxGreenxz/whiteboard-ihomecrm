#!/usr/bin/env node
import { planNativeProfileUpdate, applyNativeProfileUpdate } from './profile-provisioning.mjs';
import { isMainModule } from './operator.mjs';

export const PROFILE_INPUT_MAX_BYTES=8192;
const fail=()=>{throw Error('native_profile_provisioning_failed');};
const publicError=cause=>['native_profile_revision_changed','native_profile_locked','native_profile_commit_unknown','native_profile_shared_platform'].includes(cause?.message)?
  cause.message:'native_profile_provisioning_failed';

async function readInput(input) {
  const chunks=[];let length=0;
  try {
    for await(const chunk of input){
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      length+=bytes.length;if(length>PROFILE_INPUT_MAX_BYTES)fail();
      chunks.push(bytes);
    }
    const bytes=Buffer.concat(chunks);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
    finally{bytes.fill(0);}
  } finally {for(const chunk of chunks)chunk.fill(0);}
}

/** Trusted operator arguments select only one existing private profile home.
 * The credential and optional exact native projection are accepted only on
 * bounded stdin. No store, worker config, shell command or restart API exists.
 * Run as the profile owner; parent/native operator validates account/own UID.
 */
export async function runProfileProvisioningCli(argv,{input=process.stdin,
  write=line=>process.stdout.write(line),error=line=>process.stderr.write(line)}={}) {
  try {
    if(Array.isArray(argv)&&argv.length===1&&argv[0]==='--help'){
      write(JSON.stringify({usage:'--home <private-absolute-directory> --mcp-url <url/mcp> --profile <name> --account-id <uuid> --own-uid <uid> --paired-uid <uid> [--preserve-existing-http-origin <exact-private-IP-origin>] [--apply --expect <preview-revision>]',
        stdin:'JSON <=8192 bytes: {version:1,credential:hc_...,channel?:{accountId,ownUid,pairedUid,mainUid,profile,generation,token,listenPort}}',
        files:['config.yaml','.env'],activation:'restart_pending; controlled /reload-mcp or gateway restart remains an operator action; no live verification',
        identity:'Without channel, accountId/ownUid must already be checked by the upstream native operator; the existing env does not contain them.',
        existingHttp:'Credential-only opt-in after verifying the exact private host route. Requires an existing reserved CRM server at the unchanged origin + /mcp; cannot create a server or include channel.'})+'\n');return 0;
    }
    if(!Array.isArray(argv))fail();
    const names={'--home':'home','--mcp-url':'mcpUrl','--profile':'profile','--account-id':'accountId','--own-uid':'ownUid','--paired-uid':'pairedUid','--preserve-existing-http-origin':'preserveExistingHttpOrigin'},options={};
    let apply=false,expect;
    for(let index=0;index<argv.length;index++){
      const flag=argv[index];
      if(flag==='--apply'&&!apply){apply=true;continue;}
      const value=argv[++index];
      if(typeof value!=='string'||value.startsWith('--'))fail();
      if(flag==='--expect'&&expect===undefined){expect=value;continue;}
      const name=names[flag];if(!name||Object.hasOwn(options,name))fail();options[name]=value;
    }
    if(Object.keys(options).length!==(Object.hasOwn(options,'preserveExistingHttpOrigin')?7:6)||apply!==(expect!==undefined))fail();
    const request=await readInput(input);
    const result=apply?applyNativeProfileUpdate(options,request,expect):planNativeProfileUpdate(options,request);
    write(JSON.stringify(result)+'\n');return 0;
  } catch(cause){
    error(JSON.stringify({error:publicError(cause),runtimeStatus:'unverified',activation:'restart_pending',
      instruction:'Inspect both profile files before retrying an unknown publication; perform controlled activation separately.'})+'\n');return 1;
  }
}
if(isMainModule(process.argv[1],import.meta.url))process.exitCode=await runProfileProvisioningCli(process.argv.slice(2));
