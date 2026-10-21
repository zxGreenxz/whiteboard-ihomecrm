import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import { nativeAbsolute, nativeDirectory, nativePrivateRead } from '../../worker/lib/hermes-native-files.js';
import { nativeUid, readNativeConfig, resolveNativeConfig } from '../../worker/lib/hermes-native-config.js';
const fail=(code='native_profile_provisioning_failed')=>{throw Error(code);};
const uuid=value=>full(/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/,value);
const inside=(root,file)=>{const relative=path.relative(root,file);return !relative||!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);};
const envKey=line=>/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(line)?.[1];
const plain=value=>value&&Object.getPrototypeOf(value)===Object.prototype;
const full=(pattern,value)=>typeof value==='string'&&pattern.exec(value)?.[0]===value;
const exact=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const PROFILE_MAX=131072;
const DM_ONLY_PLATFORMS=['zalo_personal'];
const nativeKeys=['HERMES_ZALO_BRIDGE_URL','HERMES_ZALO_BRIDGE_TOKEN','HERMES_ZALO_PROFILE','HERMES_ZALO_PAIRED_UID','HERMES_ZALO_GENERATION'];
function mcpUrl(value) {
  let url;try{url=new URL(value);}catch{fail();}
  if(!(url.protocol==='https:'||url.protocol==='http:'&&url.hostname==='127.0.0.1')||
    url.username||url.password||url.pathname!=='/mcp'||url.search||url.hash)fail();
  return url.href;
}
function preservedHttpUrl(value,origin) {
  let allowed;try{allowed=new URL(origin);}catch{fail();}
  const parts=allowed.hostname.split('.').map(Number);
  const privateIp=parts.length===4&&parts.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&
    (parts[0]===10||parts[0]===172&&parts[1]>=16&&parts[1]<=31||parts[0]===192&&parts[1]===168);
  if(allowed.protocol!=='http:'||!privateIp||allowed.origin!==origin||value!==origin+'/mcp')fail();
  return value;
}
export function validateNativeProvisioningConfiguration(input) {
  if(!plain(input)||Object.keys(input).some(key=>!['configFile','stateRoot','listenPort','mcpUrl','profiles','pollIntervalMs'].includes(key))||
    !Number.isInteger(input.listenPort)||input.listenPort<1024||input.listenPort>65535||
    !Array.isArray(input.profiles)||input.profiles.length<1||input.profiles.length>64) fail();
  const url=new URL(input.mcpUrl);
  if(!(url.protocol==='https:'||url.protocol==='http:'&&url.hostname==='127.0.0.1')||
    url.username||url.password||url.pathname!=='/mcp'||url.search||url.hash) fail();
  const pollIntervalMs=input.pollIntervalMs??30000;
  if(!Number.isSafeInteger(pollIntervalMs)||pollIntervalMs<1000||pollIntervalMs>60000) fail();
  const names=new Set(),homes=new Set(),identities=new Set();
  const profiles=input.profiles.map(row=>{
    if(!plain(row)||Object.keys(row).length!==6||!['assistantId','userId','organizationId','accountId'].every(key=>uuid(row[key]))||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(row.profile??'')) fail();
    const home=nativeAbsolute(row.home),identity=row.assistantId+':'+row.accountId;
    if(names.has(row.profile)||homes.has(home)||identities.has(identity)) fail();
    if(inside(home,nativeAbsolute(input.configFile))||inside(home,nativeAbsolute(input.stateRoot))||
      inside(nativeAbsolute(input.stateRoot),home))fail();
    names.add(row.profile);homes.add(home);identities.add(identity);
    return Object.freeze({...row,home});
  });
  return Object.freeze({configFile:nativeAbsolute(input.configFile),stateRoot:nativeAbsolute(input.stateRoot),
    listenPort:input.listenPort,mcpUrl:url.href,profiles:Object.freeze(profiles),pollIntervalMs});
}
function readOptional(file,max) {
  nativeDirectory(path.dirname(file));
  try{fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  return nativePrivateRead(file,max);
}
function stage(file,contents) {
  if(typeof contents!=='string'||Buffer.byteLength(contents)>PROFILE_MAX)fail();
  const temp=path.join(path.dirname(file),'.hermes-provisioning.'+randomUUID()+'.tmp');
  let fd;
  try {
    fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,contents);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    if(nativePrivateRead(temp,PROFILE_MAX)!==contents)fail();
    return temp;
  } catch(error){try{fs.unlinkSync(temp);}catch(cleanup){if(cleanup.code!=='ENOENT')throw cleanup;}throw error;}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}
function syncDirectory(directory) {
  if(process.platform==='win32')return;
  const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function combineFailure(primary,cleanup) {
  return primary?new AggregateError([primary,cleanup],'native_profile_cleanup_failed'):cleanup;
}
function publicationFailure(error,publication) {
  return publication.started&&error.message!=='native_profile_commit_unknown'?
    new Error('native_profile_commit_unknown',{cause:error}):error;
}
function publishPrepared(prepared,publication) {
  const changes=prepared.files.filter(row=>row.before!==row.contents),staged=[];
  let failure;
  try {
    // Stage every changed file before publishing either. The two renames are
    // individually atomic; an interrupted pair must be inspected, not retried.
    for(const row of changes)staged.push({...row,temp:stage(row.file,row.contents)});
    if(prepared.files.some(row=>readOptional(row.file,PROFILE_MAX)!==row.before))fail('native_profile_revision_changed');
    for(const row of staged){
      publication.started=true;fs.renameSync(row.temp,row.file);row.temp=null;
      syncDirectory(path.dirname(row.file));
      if(nativePrivateRead(row.file,PROFILE_MAX)!==row.contents)fail('native_profile_commit_unknown');
    }
  } catch(error){failure=error;}
  finally{for(const row of staged)if(row.temp){try{fs.unlinkSync(row.temp);}catch(error){if(error.code!=='ENOENT')failure=combineFailure(failure,error);}}}
  if(failure)throw publicationFailure(failure,publication);
  return changes.length>0;
}
function withProfileLock(home,run) {
  nativeDirectory(home);
  const lock=path.join(home,'.hermes-profile-provisioning.lock');
  try{fs.mkdirSync(lock,{mode:0o700});}catch(error){if(error.code==='EEXIST')fail('native_profile_locked');throw error;}
  const publication={started:false};let result,failure;
  try{nativeDirectory(lock);result=run(publication);}catch(error){failure=error;}
  finally{try{fs.rmdirSync(lock);}catch(error){failure=combineFailure(failure,error);}}
  if(failure)throw publicationFailure(failure,publication);
  return result;
}

/** Only this bounded projection crosses from the native operator's UID into a
 * profile's UID. No native config path, token-file path or state is included.
 * The caller must transfer it privately in memory, never print it to stdout. */
export function validateNativeProfileChannel(channel) {
  if(!exact(channel,['accountId','ownUid','pairedUid','mainUid','profile','generation','token','listenPort'])||
    !uuid(channel.accountId)||!uuid(channel.generation)||!nativeUid(channel.ownUid)||!nativeUid(channel.pairedUid)||
    channel.ownUid===channel.pairedUid||channel.mainUid!==channel.pairedUid||
    !full(/[a-z][a-z0-9_-]{0,63}/,channel.profile)||!full(/hzn_[a-f0-9]{64}/,channel.token)||
    !Number.isInteger(channel.listenPort)||channel.listenPort<1024||channel.listenPort>65535)fail();
  return Object.freeze({...channel});
}
export function readNativeProfileChannel({configFile,profile}={}) {
  if(!full(/[a-z][a-z0-9_-]{0,63}/,profile))fail();
  const native=resolveNativeConfig(JSON.parse(nativePrivateRead(configFile,65536)),{createState:false});
  const channel=native.channels.find(value=>value.profile===profile);
  if(!channel)fail();
  return validateNativeProfileChannel({...channel,listenPort:native.listenPort});
}
/** Only the host-owned allowlist selects a profile/home. The raw hc credential
 * comes from encrypted enrollment handoff, never SQL digests or model input.
 * This writes valid YAML plus scoped plugin env; it never restarts a process.
 */
function managedCrmServer(servers,url) {
  const present=['crm','ihomecrm'].filter(key=>Object.hasOwn(servers,key));
  if(present.length>1)fail();
  const key=present[0]??'crm';
  if(present.length&&(!plain(servers[key])||servers[key].url!==url))fail();
  return key;
}
function prepareProfile({configuration,mapping,snapshot,token,revoked=false,credentialPending=false,nativeChannel,credentialOnly=false,requireExistingServer=false}) {
  nativeDirectory(mapping.home);
  const file=path.join(mapping.home,'config.yaml'),envFile=path.join(mapping.home,'.env');
  const before=readOptional(file,PROFILE_MAX);
  if(before===null)fail(); // The operator must already own/configure the profile.
  const config=yaml.load(before,{schema:yaml.JSON_SCHEMA});
  if(!plain(config)||config.mcp_servers!==undefined&&!plain(config.mcp_servers))fail();
  const servers={...(config.mcp_servers??{})},serverKey=managedCrmServer(servers,configuration.mcpUrl);
  if(requireExistingServer&&!Object.hasOwn(servers,serverKey))fail();
  const envOriginal=readOptional(envFile,PROFILE_MAX);
  let env=envOriginal??'';
  if(revoked||credentialPending) {
    delete servers[serverKey];
    if(revoked) env=env.split(/\r?\n/).filter(line=>!nativeKeys.includes(envKey(line))).join('\n');
  } else {
    if(!full(/hc_[A-Za-z0-9_-]{43}/,token))fail();
    let channel=nativeChannel;
    if(!credentialOnly){
      channel??=readNativeConfig(configuration.configFile)?.channels.find(value=>value.profile===mapping.profile);
      if(!channel||channel.accountId!==mapping.accountId||channel.pairedUid!==snapshot.senderUid||channel.ownUid!==snapshot.ownUid)fail();
    }
    const existing=servers[serverKey];
    if(existing!==undefined&&!plain(existing))fail();
    const headers=Object.fromEntries(Object.entries(plain(existing?.headers)?existing.headers:{}).filter(([key])=>key.toLowerCase()!=='authorization'));
    servers[serverKey]={...(existing??{}),url:configuration.mcpUrl,
      headers:{...headers,Authorization:'Bearer '+token},strict_redirect_headers:true};
    if(!credentialOnly){
      const values=channelEnv({...channel,listenPort:configuration.listenPort});
      env=env.split(/\r?\n/).filter(line=>!Object.keys(values).includes(envKey(line))).join('\n').trimEnd();
      env+=(env?'\n':'')+Object.entries(values).map(([key,value])=>key+'='+value).join('\n')+'\n';
    }
  }
  if(config.platforms!==undefined&&!plain(config.platforms))fail();
  const platforms={...(config.platforms??{})};
  if(platforms.zalo_personal!==undefined&&!plain(platforms.zalo_personal))fail();
  if(!credentialPending&&!credentialOnly) platforms.zalo_personal={...(platforms.zalo_personal??{}),enabled:!revoked};
  // K1 (NEN-CHUNG-THAO-TAC-GHI.md §8.2): a profile that carries a CRM token may only
  // serve the paired 1-1 Zalo channel; any other platform not explicitly
  // `enabled: false` could relay group chats to write tools. Refuse, never disable.
  if(Object.hasOwn(servers,serverKey)&&Object.entries(platforms).some(([name,value])=>
    !DM_ONLY_PLATFORMS.includes(name)&&!(plain(value)&&value.enabled===false)))fail('native_profile_shared_platform');
  const next=credentialOnly?{...config,mcp_servers:servers}:{...config,mcp_servers:servers,platforms};
  const encoded=yaml.dump(next,{schema:yaml.JSON_SCHEMA,noRefs:true,lineWidth:-1,sortKeys:false});
  // Preserve the original bytes on a semantic no-op, including comments.
  const yamlChanged=JSON.stringify(config)!==JSON.stringify(next);
  const files=[{file,before,contents:yamlChanged?encoded:before},
    {file:envFile,before:envOriginal,contents:credentialPending||credentialOnly?envOriginal:env}];
  if(files.some(row=>row.contents!==null&&Buffer.byteLength(row.contents)>PROFILE_MAX))fail();
  return {files};
}
export function provisionNativeProfile(options) {
  return withProfileLock(options.mapping.home,publication=>{
    const changed=publishPrepared(prepareProfile(options),publication);
    return {changed,activation:changed?'pending_controlled_restart':'unchanged'};
  });
}

function channelEnv(channel) {
  return {HERMES_ZALO_BRIDGE_URL:'http://127.0.0.1:'+channel.listenPort,
    HERMES_ZALO_BRIDGE_TOKEN:channel.token,HERMES_ZALO_PROFILE:channel.profile,
    HERMES_ZALO_PAIRED_UID:channel.pairedUid,HERMES_ZALO_GENERATION:channel.generation};
}
function managedEnv(raw) {
  const values={};
  for(const line of (raw??'').split(/\r?\n/)){
    const key=envKey(line);if(!nativeKeys.includes(key))continue;
    if(Object.hasOwn(values,key))fail();
    const match=/^\s*(?:export\s+)?[A-Z0-9_]+\s*=\s*([^\s'"#]+)\s*$/.exec(line);
    if(!match)fail();values[key]=match[1];
  }
  return values;
}
function validateExistingEnv(values,options) {
  if(!exact(values,nativeKeys)||values.HERMES_ZALO_PROFILE!==options.profile||
    values.HERMES_ZALO_PAIRED_UID!==options.pairedUid||!uuid(values.HERMES_ZALO_GENERATION)||
    !full(/hzn_[a-f0-9]{64}/,values.HERMES_ZALO_BRIDGE_TOKEN)||
    !full(/http:\/\/127\.0\.0\.1:[0-9]{4,5}/,values.HERMES_ZALO_BRIDGE_URL))fail();
  const port=Number(values.HERMES_ZALO_BRIDGE_URL.split(':').at(-1));
  if(port<1024||port>65535)fail();
}
function prepareUpdate(options,input) {
  const keys=['home','mcpUrl','profile','accountId','ownUid','pairedUid'];
  const preserve=Object.hasOwn(options??{},'preserveExistingHttpOrigin');
  if(!exact(options,preserve?[...keys,'preserveExistingHttpOrigin']:keys)||!full(/[a-z][a-z0-9_-]{0,63}/,options.profile)||!uuid(options.accountId)||
    !nativeUid(options.ownUid)||!nativeUid(options.pairedUid)||options.ownUid===options.pairedUid)fail();
  if(!exact(input,Object.hasOwn(input??{},'channel')?['version','credential','channel']:['version','credential'])||
    input.version!==1||!full(/hc_[A-Za-z0-9_-]{43}/,input.credential))fail();
  // Explicit local-operator compatibility for an already configured Docker/LAN
  // route. Never creates or redirects a server; normal provisioning stays strict.
  // The operator must verify the exact host route before selecting this origin.
  if(preserve&&Object.hasOwn(input,'channel'))fail();
  const normalized={...options,home:nativeAbsolute(options.home),mcpUrl:preserve?
    preservedHttpUrl(options.mcpUrl,options.preserveExistingHttpOrigin):mcpUrl(options.mcpUrl)};
  nativeDirectory(normalized.home);
  const env=readOptional(path.join(normalized.home,'.env'),PROFILE_MAX),values=managedEnv(env);
  let channel;
  if(Object.hasOwn(input,'channel')){
    channel=validateNativeProfileChannel(input.channel);
    if(['profile','accountId','ownUid','pairedUid'].some(key=>channel[key]!==normalized[key]))fail();
    if(Object.keys(values).length){
      validateExistingEnv(values,normalized);
      if(nativeKeys.some(key=>values[key]!==channelEnv(channel)[key]))fail();
    }
  } else validateExistingEnv(values,normalized);
  const prepared=prepareProfile({configuration:{mcpUrl:normalized.mcpUrl,listenPort:channel?.listenPort},
    mapping:normalized,snapshot:{senderUid:normalized.pairedUid,ownUid:normalized.ownUid},token:input.credential,
    nativeChannel:channel,credentialOnly:!channel,requireExistingServer:preserve});
  // Re-read env within the same snapshot; absent/mismatched native identity is
  // never repaired by a credential-only operation. Account/own UID validation
  // belongs to the upstream native operator: the legacy env has neither field.
  if(prepared.files[1].before!==env)fail('native_profile_revision_changed');
  if(channel&&Object.keys(values).length)prepared.files[1].contents=env;
  const expectedRevision=createHash('sha256').update(JSON.stringify([normalized,input,prepared.files.map(row=>row.before)])).digest('hex');
  return {...prepared,expectedRevision};
}
function updateSummary(prepared,applied) {
  return {version:1,status:applied?'updated':'planned',changed:applied&&prepared.files.some(row=>row.before!==row.contents),
    expectedRevision:prepared.expectedRevision,runtimeStatus:'unverified',activation:'restart_pending',scope:'profile_files_only'};
}
export function planNativeProfileUpdate(options,input) {return updateSummary(prepareUpdate(options,input),false);}
export function applyNativeProfileUpdate(options,input,expect) {
  if(!full(/[a-f0-9]{64}/,expect))fail('native_profile_revision_changed');
  return withProfileLock(nativeAbsolute(options.home),publication=>{
    const prepared=prepareUpdate(options,input);
    if(prepared.expectedRevision!==expect)fail('native_profile_revision_changed');
    publishPrepared(prepared,publication);
    return updateSummary(prepared,true);
  });
}
