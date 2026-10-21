import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { planNativeProfileUpdate, applyNativeProfileUpdate, readNativeProfileChannel, validateNativeProfileChannel, provisionNativeProfile } from './profile-provisioning.mjs';
import { runProfileProvisioningCli, PROFILE_INPUT_MAX_BYTES } from './profile-provisioning-cli.mjs';

const id=n=>n.repeat(8)+'-'+n.repeat(4)+'-4'+n.repeat(3)+'-8'+n.repeat(3)+'-'+n.repeat(12);
function fixture(t,{bound=true}={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'native-profile-'))),home=path.join(root,'alpha'),nativeRoot=path.join(root,'native'),stateRoot=path.join(nativeRoot,'state');
  for(const directory of [home,nativeRoot,stateRoot])fs.mkdirSync(directory,{mode:0o700});
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const channel={accountId:id('1'),ownUid:'123',pairedUid:'456',mainUid:'456',profile:'alpha',generation:id('2'),token:'hzn_'+'a'.repeat(64),listenPort:8991};
  const options={home,mcpUrl:'http://127.0.0.1:8740/mcp',profile:'alpha',accountId:channel.accountId,ownUid:channel.ownUid,pairedUid:channel.pairedUid};
  const configFile=path.join(home,'config.yaml'),envFile=path.join(home,'.env'),tokenFile=path.join(nativeRoot,'alpha.token'),nativeFile=path.join(nativeRoot,'native.json'),journalFile=path.join(stateRoot,'unknown.json');
  const config={model:{default:'private-existing'},mcp_servers:{other:{command:'existing',args:['unchanged']},crm:{url:options.mcpUrl,headers:{Authorization:'Bearer hc_'+'b'.repeat(43),'X-Keep':'existing'},timeout:30}},platforms:{zalo_personal:{enabled:true,keep:'existing'},telegram:{enabled:false,keep:'existing'}}};
  fs.writeFileSync(configFile,yaml.dump(config),{mode:0o600});
  const env='# exact env comment\r\nKEEP_OTHER="unchanged with spaces"\r\n'+(bound?
    `export HERMES_ZALO_BRIDGE_URL=http://127.0.0.1:8991\r\nHERMES_ZALO_BRIDGE_TOKEN=${channel.token}\r\nHERMES_ZALO_PROFILE=alpha\r\nHERMES_ZALO_PAIRED_UID=456\r\nHERMES_ZALO_GENERATION=${channel.generation}\r\n`:'');
  fs.writeFileSync(envFile,env,{mode:0o600});fs.writeFileSync(tokenFile,channel.token+'\n',{mode:0o600});
  const {token:_token,listenPort:_port,...diskChannel}=channel;
  fs.writeFileSync(nativeFile,JSON.stringify({version:1,stateRoot,listenPort:channel.listenPort,channels:[{...diskChannel,tokenFile}]}),{mode:0o600});
  fs.writeFileSync(journalFile,'synthetic existing unknown journal; never replace',{mode:0o600});
  const request={version:1,credential:'hc_'+'c'.repeat(43)};
  return {root,home,options,configFile,envFile,tokenFile,nativeFile,journalFile,channel,request,env,config};
}
const read=file=>fs.readFileSync(file,'utf8');
const args=options=>Object.entries({'--home':options.home,'--mcp-url':options.mcpUrl,'--profile':options.profile,'--account-id':options.accountId,'--own-uid':options.ownUid,'--paired-uid':options.pairedUid}).flat();
const input=value=>Readable.from([JSON.stringify(value)]);
function snapshot(root) {
  return fs.readdirSync(root,{withFileTypes:true}).flatMap(entry=>{
    const file=path.join(root,entry.name);
    return entry.isDirectory()?snapshot(file):[[file,read(file)]];
  });
}
function apply(f,request=f.request) {return applyNativeProfileUpdate(f.options,request,planNativeProfileUpdate(f.options,request).expectedRevision);}

test('preview is read-only; credential update preserves exact native env and every native token/generation/journal',t=>{
  const f=fixture(t),before=snapshot(f.root),plan=planNativeProfileUpdate(f.options,f.request);
  assert.deepEqual(snapshot(f.root),before);assert.equal(plan.changed,false);assert.match(plan.expectedRevision,/^[a-f0-9]{64}$/);
  const nativeBefore=[f.nativeFile,f.tokenFile,f.journalFile].map(read);
  const result=applyNativeProfileUpdate(f.options,f.request,plan.expectedRevision),config=yaml.load(read(f.configFile));
  assert.equal(result.changed,true);assert.equal(result.activation,'restart_pending');assert.equal(result.runtimeStatus,'unverified');
  assert.equal(read(f.envFile),f.env);assert.deepEqual([f.nativeFile,f.tokenFile,f.journalFile].map(read),nativeBefore);
  const expected=structuredClone(f.config);expected.mcp_servers.crm.headers.Authorization='Bearer '+f.request.credential;expected.mcp_servers.crm.strict_redirect_headers=true;
  assert.deepEqual(config,expected);
  assert(!JSON.stringify([plan,result]).includes(f.request.credential));assert(!JSON.stringify(result).includes(f.channel.token));
  const bytes=read(f.configFile),noop=apply(f);assert.equal(noop.changed,false);assert.equal(noop.runtimeStatus,'unverified');
  assert.equal(noop.activation,'restart_pending');assert.equal(read(f.configFile),bytes);assert.equal(read(f.envFile),f.env);
});

test('first binding takes only the validated exact channel projection and leaves native files untouched',t=>{
  const f=fixture(t,{bound:false}),nativeBefore=[f.nativeFile,f.tokenFile,f.journalFile].map(read);
  const projection=readNativeProfileChannel({configFile:f.nativeFile,profile:'alpha'});
  assert.deepEqual(projection,f.channel);assert(!Object.hasOwn(projection,'tokenFile'));assert(!Object.hasOwn(projection,'stateRoot'));
  const request={...f.request,channel:projection};apply(f,request);
  const env=read(f.envFile);assert(env.includes('KEEP_OTHER="unchanged with spaces"'));assert(env.includes('HERMES_ZALO_BRIDGE_TOKEN='+f.channel.token));
  assert(env.includes('HERMES_ZALO_GENERATION='+f.channel.generation));assert.equal(yaml.load(read(f.configFile)).platforms.zalo_personal.enabled,true);
  assert.deepEqual([f.nativeFile,f.tokenFile,f.journalFile].map(read),nativeBefore);
  const noop=apply(f,request);assert.equal(noop.changed,false);assert.equal(read(f.envFile),env);
});

test('credential-only requires complete unique matching native env; upstream retains account/own UID responsibility',t=>{
  const f=fixture(t),before=read(f.configFile);
  for(const env of [f.env.replace('HERMES_ZALO_PROFILE=alpha','HERMES_ZALO_PROFILE=other'),f.env.replace('HERMES_ZALO_PAIRED_UID=456','HERMES_ZALO_PAIRED_UID=789'),
    f.env.replace(/HERMES_ZALO_BRIDGE_TOKEN=.*\r\n/,''),f.env+'HERMES_ZALO_PROFILE=alpha\n',f.env.replace(f.channel.token,'invalid'),f.env.replace('8991','1023')]){
    fs.writeFileSync(f.envFile,env);assert.throws(()=>planNativeProfileUpdate(f.options,f.request));assert.equal(read(f.configFile),before);assert.equal(read(f.envFile),env);
  }
  fs.writeFileSync(f.envFile,f.env);
  // Legacy env deliberately has no accountId or ownUid. This helper validates
  // their syntax, but cannot prove them without the upstream native operator.
  assert.doesNotThrow(()=>planNativeProfileUpdate({...f.options,accountId:id('9'),ownUid:'789'},f.request));
});

test('projection cannot rebind an existing profile or carry extra paths/commands',t=>{
  const f=fixture(t),before=snapshot(f.root);
  for(const channel of [{...f.channel,accountId:id('9')},{...f.channel,ownUid:'789'},{...f.channel,pairedUid:'789',mainUid:'789'},
    {...f.channel,profile:'other'},{...f.channel,token:'hzn_'+'b'.repeat(64)},{...f.channel,generation:id('9')},
    {...f.channel,tokenFile:f.tokenFile},{...f.channel,stateRoot:f.root},{...f.channel,command:'unsafe'},
    {...f.channel,mainUid:'123'},{...f.channel,listenPort:80},{...f.channel,token:f.channel.token+'\n'},
    {...f.channel,accountId:f.channel.accountId+'\n'},{...f.channel,generation:f.channel.generation+'\n'}]){
    assert.throws(()=>planNativeProfileUpdate(f.options,{...f.request,channel}));assert.deepEqual(snapshot(f.root),before);
  }
  assert.throws(()=>validateNativeProfileChannel({...f.channel,token:undefined}));
});

test('strict request/options reject malformed credentials, unsafe URL, paths and unknown keys without mutation',t=>{
  const f=fixture(t),before=snapshot(f.root);
  for(const request of [null,[],{...f.request,version:2},{...f.request,credential:f.request.credential+'\n'},
    {...f.request,credential:'hzn_'+'a'.repeat(64)},{...f.request,store:{}},{...f.request,home:f.home},{...f.request,command:'unsafe'}]){
    assert.throws(()=>planNativeProfileUpdate(f.options,request));
  }
  for(const options of [{...f.options,mcpUrl:'http://remote.example.test/mcp'},{...f.options,mcpUrl:'https://name:password@example.test/mcp'},
    {...f.options,home:'relative'},{...f.options,configFile:f.configFile},{...f.options,profile:'../other'},{...f.options,ownUid:'456'}]){
    assert.throws(()=>planNativeProfileUpdate(options,f.request));
  }
  assert.deepEqual(snapshot(f.root),before);
});

test('revision binds credential, arguments and both exact files; stale preview never overwrites concurrent edits',t=>{
  const f=fixture(t),revision=planNativeProfileUpdate(f.options,f.request).expectedRevision;
  for(const file of [f.configFile,f.envFile]){
    const before=read(file);fs.writeFileSync(file,before+'\n# concurrent edit\n');const edited=read(file);
    assert.throws(()=>applyNativeProfileUpdate(f.options,f.request,revision),/revision_changed/);assert.equal(read(file),edited);fs.writeFileSync(file,before);
  }
  assert.throws(()=>applyNativeProfileUpdate(f.options,{...f.request,credential:'hc_'+'d'.repeat(43)},revision),/revision_changed/);
  assert.throws(()=>applyNativeProfileUpdate({...f.options,accountId:id('9')},f.request,revision),/revision_changed/);
  const lock=path.join(f.home,'.hermes-profile-provisioning.lock');fs.mkdirSync(lock,{mode:0o700});
  assert.throws(()=>applyNativeProfileUpdate(f.options,f.request,revision),/locked/);assert.equal(fs.existsSync(lock),true);fs.rmdirSync(lock);
});

test('CAS rechecks after staging and preserves an edit made while the private temp is written',t=>{
  const f=fixture(t),revision=planNativeProfileUpdate(f.options,f.request).expectedRevision,original=fs.writeFileSync;
  let injected=false;
  fs.writeFileSync=(...parameters)=>{
    const result=original(...parameters);
    if(typeof parameters[0]==='number'&&!injected){injected=true;original(f.configFile,read(f.configFile)+'\n# mid-stage edit\n');}
    return result;
  };
  try{assert.throws(()=>applyNativeProfileUpdate(f.options,f.request,revision),/revision_changed/);}
  finally{fs.writeFileSync=original;}
  assert(read(f.configFile).endsWith('# mid-stage edit\n'));assert.equal(read(f.envFile),f.env);
  assert(!fs.readdirSync(f.home).some(name=>name.includes('.tmp')||name.includes('.lock')));
});

test('stage failure publishes neither file; failure between atomic renames is explicitly unknown and leaves inspectable state',t=>{
  const f=fixture(t,{bound:false}),request={...f.request,channel:f.channel},before=snapshot(f.root),revision=planNativeProfileUpdate(f.options,request).expectedRevision;
  const originalWrite=fs.writeFileSync;let writes=0;
  fs.writeFileSync=(...parameters)=>{if(typeof parameters[0]==='number'&&++writes===2)throw Error('SECRET_STAGE_FAILURE');return originalWrite(...parameters);};
  try{assert.throws(()=>applyNativeProfileUpdate(f.options,request,revision),/SECRET_STAGE_FAILURE/);}finally{fs.writeFileSync=originalWrite;}
  assert.deepEqual(snapshot(f.root),before);assert(!fs.readdirSync(f.home).some(name=>name.includes('.tmp')||name.includes('.lock')));
  const originalRename=fs.renameSync;
  fs.renameSync=(source,destination)=>{if(destination===f.envFile)throw Error('SECRET_RENAME_FAILURE');return originalRename(source,destination);};
  try{assert.throws(()=>applyNativeProfileUpdate(f.options,request,revision),/native_profile_commit_unknown/);}finally{fs.renameSync=originalRename;}
  assert.equal(yaml.load(read(f.configFile)).mcp_servers.crm.headers.Authorization,'Bearer '+f.request.credential);
  assert.equal(read(f.envFile),f.env);assert.throws(()=>applyNativeProfileUpdate(f.options,request,revision),/revision_changed/);
  assert(!fs.readdirSync(f.home).some(name=>name.includes('.tmp')||name.includes('.lock')));
});

test('publication errors retain commit_unknown when temporary-file or lock cleanup also fails',async t=>{
  for(const cleanup of ['unlink','lock','both'])await t.test(cleanup,async sub=>{
    const f=fixture(sub,{bound:false}),request={...f.request,channel:f.channel},revision=planNativeProfileUpdate(f.options,request).expectedRevision;
    const rename=fs.renameSync,unlink=fs.unlinkSync,rmdir=fs.rmdirSync,output=[],errors=[];
    fs.renameSync=(source,destination)=>{if(destination===f.envFile)throw Error('SECRET_SECOND_RENAME_FAILURE');return rename(source,destination);};
    fs.unlinkSync=file=>{if(cleanup!=='lock'&&path.dirname(file)===f.home&&file.endsWith('.tmp'))throw Error('SECRET_UNLINK_FAILURE');return unlink(file);};
    fs.rmdirSync=directory=>{if(cleanup!=='unlink'&&directory===path.join(f.home,'.hermes-profile-provisioning.lock'))throw Error('SECRET_LOCK_FAILURE');return rmdir(directory);};
    try{
      const code=await runProfileProvisioningCli([...args(f.options),'--apply','--expect',revision],{input:input(request),write:value=>output.push(value),error:value=>errors.push(JSON.parse(value))});
      assert.equal(code,1);assert.equal(output.length,0);assert.equal(errors[0].error,'native_profile_commit_unknown');
    } finally{fs.renameSync=rename;fs.unlinkSync=unlink;fs.rmdirSync=rmdir;}
    assert.equal(yaml.load(read(f.configFile)).mcp_servers.crm.headers.Authorization,'Bearer '+f.request.credential);
    assert.equal(read(f.envFile),f.env);assert(!JSON.stringify(errors).includes('SECRET'));
  });
});

test('a successful publication followed by lock-cleanup failure is commit_unknown, never success',async t=>{
  const f=fixture(t),revision=planNativeProfileUpdate(f.options,f.request).expectedRevision,rmdir=fs.rmdirSync,output=[],errors=[];
  fs.rmdirSync=directory=>{if(directory===path.join(f.home,'.hermes-profile-provisioning.lock'))throw Error('SECRET_LOCK_FAILURE');return rmdir(directory);};
  try{
    const code=await runProfileProvisioningCli([...args(f.options),'--apply','--expect',revision],{input:input(f.request),write:value=>output.push(value),error:value=>errors.push(JSON.parse(value))});
    assert.equal(code,1);assert.equal(output.length,0);assert.equal(errors[0].error,'native_profile_commit_unknown');
  } finally{fs.rmdirSync=rmdir;}
  assert.equal(yaml.load(read(f.configFile)).mcp_servers.crm.headers.Authorization,'Bearer '+f.request.credential);
  assert.equal(read(f.envFile),f.env);assert(!JSON.stringify(errors).includes('SECRET'));
});

test('before publication, lock-cleanup failure remains an error and retains both original causes',t=>{
  const f=fixture(t),before=snapshot(f.root),rmdir=fs.rmdirSync;
  fs.rmdirSync=directory=>{if(directory===path.join(f.home,'.hermes-profile-provisioning.lock'))throw Error('SYNTHETIC_CLEANUP_FAILURE');return rmdir(directory);};
  try{
    assert.throws(()=>applyNativeProfileUpdate(f.options,f.request,'0'.repeat(64)),error=>{
      assert(error instanceof AggregateError);assert.equal(error.message,'native_profile_cleanup_failed');
      assert.deepEqual(error.errors.map(cause=>cause.message),['native_profile_revision_changed','SYNTHETIC_CLEANUP_FAILURE']);return true;
    });
  } finally{fs.rmdirSync=rmdir;}
  assert.deepEqual(snapshot(f.root),before);
});

test('hardlinked and symlinked targets are rejected by existing private-file guards',t=>{
  const f=fixture(t),link=path.join(f.home,'hardlink');fs.linkSync(f.configFile,link);
  assert.throws(()=>planNativeProfileUpdate(f.options,f.request));fs.unlinkSync(link);
  const real=path.join(f.home,'real.env');fs.renameSync(f.envFile,real);
  try{fs.symlinkSync(real,f.envFile);}catch(error){if(process.platform==='win32'&&error.code==='EPERM'){fs.renameSync(real,f.envFile);return;}throw error;}
  assert.throws(()=>planNativeProfileUpdate(f.options,f.request));fs.unlinkSync(f.envFile);fs.renameSync(real,f.envFile);
});

test('CLI uses bounded stdin, default preview and fixed errors; no secret reaches stdout/stderr',async t=>{
  const f=fixture(t),output=[],errors=[],ports={write:value=>output.push(JSON.parse(value)),error:value=>errors.push(JSON.parse(value))};
  assert.equal(await runProfileProvisioningCli(args(f.options),{...ports,input:input(f.request)}),0);
  const revision=output[0].expectedRevision;assert.equal(output[0].status,'planned');assert.equal(read(f.envFile),f.env);
  assert.equal(await runProfileProvisioningCli([...args(f.options),'--apply','--expect',revision],{...ports,input:input(f.request)}),0);
  assert.equal(output[1].changed,true);
  for(const value of [JSON.stringify({...f.request,debug:f.channel.token}),' '.repeat(PROFILE_INPUT_MAX_BYTES+1),'{"credential":"'+f.request.credential+'"',Buffer.from([0xff])]){
    assert.equal(await runProfileProvisioningCli(args(f.options),{...ports,input:Readable.from([value])}),1);
  }
  assert.equal(await runProfileProvisioningCli([...args(f.options),'--credential',f.request.credential],{...ports,input:input(f.request)}),1);
  assert.equal(await runProfileProvisioningCli([...args(f.options),'--expect',revision],{...ports,input:input(f.request)}),1);
  const serialized=JSON.stringify({output,errors});assert(!serialized.includes(f.request.credential));assert(!serialized.includes(f.channel.token));
  assert(errors.every(value=>value.runtimeStatus==='unverified'&&value.activation==='restart_pending'));
});

test('executable CLI accepts the private handoff through stdin without secret arguments or env',t=>{
  const f=fixture(t),cli=fileURLToPath(new URL('./profile-provisioning-cli.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[cli,...args(f.options)],{input:JSON.stringify(f.request),encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'planned');
  assert(!result.stdout.includes(f.request.credential));assert(!result.stderr.includes(f.request.credential));
});


function aliasProfile(f,aliases) {
  const config=structuredClone(f.config);delete config.mcp_servers.crm;
  Object.assign(config.mcp_servers,aliases);fs.writeFileSync(f.configFile,yaml.dump(config));return config;
}
function sameUidProfileOptions(f,extra={}) {
  return {configuration:{configFile:f.nativeFile,mcpUrl:f.options.mcpUrl,listenPort:f.channel.listenPort},
    mapping:{home:f.home,profile:f.options.profile,accountId:f.options.accountId},
    snapshot:{senderUid:f.options.pairedUid,ownUid:f.options.ownUid},...extra};
}
test('managed alias preserves ihomecrm with an env-ref authorization and writes no second CRM server',t=>{
  const f=fixture(t),original=aliasProfile(f,{ihomecrm:{...f.config.mcp_servers.crm,headers:{Authorization:'Bearer '+'$'+'{IHOME_CRM_TOKEN}',authorization:'Bearer '+'$'+'{OLDER_CRM_TOKEN}','X-Keep':'existing'}}});
  const env=f.env+'IHOME_CRM_TOKEN=hc_'+'b'.repeat(43)+'\r\nOLDER_CRM_TOKEN=hc_'+'d'.repeat(43)+'\r\n';fs.writeFileSync(f.envFile,env);
  const beforeNative=[f.nativeFile,f.tokenFile,f.journalFile].map(read);apply(f);
  const actual=yaml.load(read(f.configFile)),expected=structuredClone(original);
  expected.mcp_servers.ihomecrm.headers={Authorization:'Bearer '+f.request.credential,'X-Keep':'existing'};expected.mcp_servers.ihomecrm.strict_redirect_headers=true;
  assert.deepEqual(actual,expected);assert.equal(actual.mcp_servers.crm,undefined);assert.equal(read(f.envFile),env);
  assert.deepEqual([f.nativeFile,f.tokenFile,f.journalFile].map(read),beforeNative);
});
test('managed alias defaults to crm only when neither reserved alias exists',t=>{
  const f=fixture(t);aliasProfile(f,{});apply(f);const actual=yaml.load(read(f.configFile));
  assert.equal(actual.mcp_servers.crm.headers.Authorization,'Bearer '+f.request.credential);assert.equal(actual.mcp_servers.ihomecrm,undefined);
  assert.deepEqual(actual.mcp_servers.other,f.config.mcp_servers.other);assert.equal(read(f.envFile),f.env);
});
test('managed alias refuses an existing reserved alias with a different URL before any update or removal',t=>{
  for(const key of ['crm','ihomecrm'])for(const server of [null,[],false,'not-a-server',{url:'https://unrelated.example.test/mcp',headers:{Authorization:'Bearer synthetic-other'}}]){
    const f=fixture(t);aliasProfile(f,{[key]:server});
    const before=snapshot(f.root);
    assert.throws(()=>planNativeProfileUpdate(f.options,f.request),/native_profile_provisioning_failed/);
    assert.throws(()=>provisionNativeProfile(sameUidProfileOptions(f,{credentialPending:true})),/native_profile_provisioning_failed/);
    assert.throws(()=>provisionNativeProfile(sameUidProfileOptions(f,{revoked:true})),/native_profile_provisioning_failed/);
    assert.deepEqual(snapshot(f.root),before);
  }
});
test('managed alias refuses both exact-URL aliases for update, pending and revoke before publishing files',t=>{
  const f=fixture(t);aliasProfile(f,{crm:f.config.mcp_servers.crm,ihomecrm:{...f.config.mcp_servers.crm,headers:{Authorization:'Bearer '+'$'+'{OTHER_CRM_TOKEN}'}}});
  const before=snapshot(f.root);
  assert.throws(()=>planNativeProfileUpdate(f.options,f.request),/native_profile_provisioning_failed/);
  assert.throws(()=>provisionNativeProfile(sameUidProfileOptions(f,{credentialPending:true})),/native_profile_provisioning_failed/);
  assert.throws(()=>provisionNativeProfile(sameUidProfileOptions(f,{revoked:true})),/native_profile_provisioning_failed/);
  assert.deepEqual(snapshot(f.root),before);
});
test('managed alias pending and revoke remove the exact ihomecrm capability while preserving other MCP servers',t=>{
  for(const mode of ['credentialPending','revoked']){
    const f=fixture(t),original=aliasProfile(f,{ihomecrm:{...f.config.mcp_servers.crm,headers:{Authorization:'Bearer '+'$'+'{IHOME_CRM_TOKEN}'}}});
    const beforeNative=[f.nativeFile,f.tokenFile,f.journalFile].map(read);
    provisionNativeProfile(sameUidProfileOptions(f,{[mode]:true}));const actual=yaml.load(read(f.configFile));
    assert.equal(actual.mcp_servers.ihomecrm,undefined);assert.equal(actual.mcp_servers.crm,undefined);assert.deepEqual(actual.mcp_servers.other,original.mcp_servers.other);
    assert.deepEqual([f.nativeFile,f.tokenFile,f.journalFile].map(read),beforeNative);
    if(mode==='credentialPending'){assert.equal(read(f.envFile),f.env);assert.deepEqual(actual.platforms,original.platforms);}
    else{assert.equal(actual.platforms.zalo_personal.enabled,false);assert(!read(f.envFile).includes('HERMES_ZALO_BRIDGE_TOKEN'));}
    const after=snapshot(f.root),repeat=provisionNativeProfile(sameUidProfileOptions(f,{[mode]:true}));
    assert.equal(repeat.changed,false);assert.deepEqual(snapshot(f.root),after);
  }
});
test('managed alias refuses both reserved aliases even at different URLs before update, pending or revoke',t=>{
  const f=fixture(t),other={url:'https://another.example.test/mcp',headers:{Authorization:'Bearer unrelated'}};
  aliasProfile(f,{ihomecrm:f.config.mcp_servers.crm,crm:other});const before=snapshot(f.root);
  assert.throws(()=>planNativeProfileUpdate(f.options,f.request),/native_profile_provisioning_failed/);
  assert.throws(()=>provisionNativeProfile(sameUidProfileOptions(f,{credentialPending:true})),/native_profile_provisioning_failed/);
  assert.throws(()=>provisionNativeProfile(sameUidProfileOptions(f,{revoked:true})),/native_profile_provisioning_failed/);
  assert.deepEqual(snapshot(f.root),before);
});
test('managed alias repeated pending resumes with one default CRM server and preserves exact native env',t=>{
  for(const key of ['crm','ihomecrm']){
    const f=fixture(t);aliasProfile(f,{[key]:f.config.mcp_servers.crm});const nativeBefore=[f.nativeFile,f.tokenFile,f.journalFile].map(read);
    provisionNativeProfile(sameUidProfileOptions(f,{credentialPending:true}));
    assert.equal(provisionNativeProfile(sameUidProfileOptions(f,{credentialPending:true})).changed,false);
    assert.equal(read(f.envFile),f.env);apply(f);const actual=yaml.load(read(f.configFile));
    assert.equal(actual.mcp_servers.ihomecrm,undefined);assert.equal(actual.mcp_servers.crm.headers.Authorization,'Bearer '+f.request.credential);
    assert.equal(read(f.envFile),f.env);assert.deepEqual(actual.mcp_servers.other,f.config.mcp_servers.other);
    assert.deepEqual([f.nativeFile,f.tokenFile,f.journalFile].map(read),nativeBefore);assert.equal(apply(f).changed,false);
  }
});
test('managed alias first-binding projection preserves the existing ihomecrm key',t=>{
  const f=fixture(t,{bound:false});aliasProfile(f,{ihomecrm:f.config.mcp_servers.crm});apply(f,{...f.request,channel:f.channel});
  const actual=yaml.load(read(f.configFile));assert.equal(actual.mcp_servers.crm,undefined);assert.equal(actual.mcp_servers.ihomecrm.headers.Authorization,'Bearer '+f.request.credential);
  assert(read(f.envFile).includes('HERMES_ZALO_GENERATION='+f.channel.generation));
});

test('credential-only operator can explicitly preserve an existing private HTTP origin without changing native state',async t=>{
  const f=fixture(t),origin='http://172.17.0.1:8740';
  f.options.mcpUrl=origin+'/mcp';
  aliasProfile(f,{ihomecrm:{...f.config.mcp_servers.crm,url:f.options.mcpUrl}});
  const before=snapshot(f.root),nativeBefore=[f.envFile,f.nativeFile,f.tokenFile,f.journalFile].map(read);
  assert.throws(()=>planNativeProfileUpdate(f.options,f.request),/native_profile_provisioning_failed/);
  const options={...f.options,preserveExistingHttpOrigin:origin},plan=planNativeProfileUpdate(options,f.request);
  assert.deepEqual(snapshot(f.root),before);
  let output='',error='';
  const code=await runProfileProvisioningCli([...args(f.options),'--preserve-existing-http-origin',origin,'--apply','--expect',plan.expectedRevision],
    {input:input(f.request),write:s=>output+=s,error:s=>error+=s});
  assert.equal(code,0);assert.equal(error,'');assert.equal(JSON.parse(output).changed,true);
  const config=yaml.load(read(f.configFile));
  assert.equal(config.mcp_servers.ihomecrm.url,origin+'/mcp');
  assert.equal(config.mcp_servers.ihomecrm.headers.Authorization,'Bearer '+f.request.credential);
  assert.equal(config.mcp_servers.ihomecrm.strict_redirect_headers,true);assert.equal(config.mcp_servers.crm,undefined);
  assert.deepEqual([f.envFile,f.nativeFile,f.tokenFile,f.journalFile].map(read),nativeBefore);
});

test('preserving HTTP cannot create a server, change its destination, or accompany a first-binding projection',t=>{
  const origin='http://172.17.0.1:8740',url=origin+'/mcp';
  for(const variant of ['absent','other-host','other-port','channel']){
    const f=fixture(t);f.options.mcpUrl=url;
    aliasProfile(f,variant==='absent'?{}:{ihomecrm:{...f.config.mcp_servers.crm,
      url:variant==='other-host'?'http://172.17.0.2:8740/mcp':variant==='other-port'?'http://172.17.0.1:8741/mcp':url}});
    const before=snapshot(f.root);
    assert.throws(()=>planNativeProfileUpdate({...f.options,preserveExistingHttpOrigin:origin},
      variant==='channel'?{...f.request,channel:f.channel}:f.request),/native_profile_provisioning_failed/);
    assert.deepEqual(snapshot(f.root),before);
  }
});

test('preserving HTTP requires a canonical private IP origin and exact /mcp URL',t=>{
  const origin='http://172.17.0.1:8740';
  for(const [allow,url] of [
    [origin+'/',origin+'/mcp'],['http://example.test:8740','http://example.test:8740/mcp'],
    ['http://8.8.8.8:8740','http://8.8.8.8:8740/mcp'],['http://2853249585:8740','http://172.17.0.1:8740/mcp'],
    [origin,origin+'/other'],[origin,origin+'/mcp?key=secret'],[origin,origin+'/mcp#x'],
    [origin,'http://user:pass@172.17.0.1:8740/mcp'],[origin,'http://172.17.0.2:8740/mcp'],
    [origin,'http://172.17.0.1:8741/mcp'],[origin,origin+'/%6dcp'],
  ]){
    const f=fixture(t),before=snapshot(f.root);
    assert.throws(()=>planNativeProfileUpdate({...f.options,mcpUrl:url,preserveExistingHttpOrigin:allow},f.request),/native_profile_provisioning_failed/);
    assert.deepEqual(snapshot(f.root),before);
  }
});

test('K1: a profile that would carry a CRM token refuses any platform besides zalo_personal not explicitly off; pending/revoke still remove it',async t=>{
  for(const [name,value] of [['telegram',{enabled:true}],['discord',{}],['api_server','on'],['slack',{enabled:'false'}]]){
    const f=fixture(t),config=structuredClone(f.config);config.platforms[name]=value;fs.writeFileSync(f.configFile,yaml.dump(config));
    const before=snapshot(f.root),shared=/^Error: native_profile_shared_platform$/;
    assert.throws(()=>planNativeProfileUpdate(f.options,f.request),shared);
    assert.throws(()=>planNativeProfileUpdate(f.options,{...f.request,channel:f.channel}),shared);
    assert.throws(()=>provisionNativeProfile(sameUidProfileOptions(f,{token:f.request.credential})),shared);
    const errors=[];
    assert.equal(await runProfileProvisioningCli(args(f.options),{input:input(f.request),write:()=>{},error:value=>errors.push(JSON.parse(value))}),1);
    assert.equal(errors[0].error,'native_profile_shared_platform');assert(!JSON.stringify(errors).includes(f.request.credential));
    assert.deepEqual(snapshot(f.root),before);
    for(const mode of ['credentialPending','revoked']){
      provisionNativeProfile(sameUidProfileOptions(f,{[mode]:true}));const actual=yaml.load(read(f.configFile));
      assert.equal(actual.mcp_servers.crm,undefined);assert.deepEqual(actual.platforms[name],value);
    }
  }
});
