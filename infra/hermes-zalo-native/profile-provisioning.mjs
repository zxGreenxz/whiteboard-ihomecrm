import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import { nativeAbsolute, nativeDirectory, nativePrivateRead } from '../../worker/lib/hermes-native-files.js';
import { readNativeConfig } from '../../worker/lib/hermes-native-config.js';
const fail=()=>{throw Error('native_profile_provisioning_failed');};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const inside=(root,file)=>{const relative=path.relative(root,file);return !relative||!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);};
const envKey=line=>/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(line)?.[1];
const plain=value=>value&&Object.getPrototypeOf(value)===Object.prototype;
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
  try{return nativePrivateRead(file,max);}
  catch(error){if(!fs.existsSync(file)&&!fs.lstatSync(path.dirname(file)).isSymbolicLink())return null;throw error;}
}
function publish(file,before,contents) {
  if(before===contents)return false;
  nativeDirectory(path.dirname(file));
  if(readOptional(file,131072)!==before)fail();
  const temp=path.join(path.dirname(file),'.hermes-provisioning.'+randomUUID()+'.tmp');
  let fd;
  try {
    fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,contents);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    if(nativePrivateRead(temp,131072)!==contents||readOptional(file,131072)!==before)fail();
    fs.renameSync(temp,file);
    if(process.platform!=='win32'){const directory=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
    return true;
  } finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
/** Only the host-owned allowlist selects a profile/home. The raw hc credential
 * comes from encrypted enrollment handoff, never SQL digests or model input.
 * This writes valid YAML plus scoped plugin env; it never restarts a process.
 */
export function provisionNativeProfile({configuration,mapping,snapshot,token,revoked=false,credentialPending=false}) {
  nativeDirectory(mapping.home);
  const file=path.join(mapping.home,'config.yaml'),envFile=path.join(mapping.home,'.env');
  const before=readOptional(file,131072);
  if(before===null)fail(); // The operator must already own/configure the profile.
  const config=yaml.load(before,{schema:yaml.JSON_SCHEMA});
  if(!plain(config)||config.mcp_servers!==undefined&&!plain(config.mcp_servers))fail();
  const servers={...(config.mcp_servers??{})};
  const envOriginal=readOptional(envFile,131072);
  let env=envOriginal??'';
  if(revoked||credentialPending) {
    delete servers.crm;
    const keys=['HERMES_ZALO_BRIDGE_URL','HERMES_ZALO_BRIDGE_TOKEN','HERMES_ZALO_PROFILE','HERMES_ZALO_PAIRED_UID','HERMES_ZALO_GENERATION'];
    if(revoked) env=env.split(/\r?\n/).filter(line=>!keys.includes(envKey(line))).join('\n');
  } else {
    if(typeof token!=='string'||!/^hc_[A-Za-z0-9_-]{43}$/.test(token))fail();
    const native=readNativeConfig(configuration.configFile),channel=native.channels.find(value=>value.profile===mapping.profile);
    if(!channel||channel.accountId!==mapping.accountId||channel.pairedUid!==snapshot.senderUid||channel.ownUid!==snapshot.ownUid)fail();
    const existing=servers.crm;
    if(existing!==undefined&&!plain(existing))fail();
    const headers=Object.fromEntries(Object.entries(plain(existing?.headers)?existing.headers:{}).filter(([key])=>key.toLowerCase()!=='authorization'));
    servers.crm={...(existing??{}),url:configuration.mcpUrl,
      headers:{...headers,Authorization:'Bearer '+token},strict_redirect_headers:true};
    const values={HERMES_ZALO_BRIDGE_URL:'http://127.0.0.1:'+configuration.listenPort,
      HERMES_ZALO_BRIDGE_TOKEN:channel.token,HERMES_ZALO_PROFILE:mapping.profile,
      HERMES_ZALO_PAIRED_UID:channel.pairedUid,HERMES_ZALO_GENERATION:channel.generation};
    env=env.split(/\r?\n/).filter(line=>!Object.keys(values).includes(envKey(line))).join('\n').trimEnd();
    env+=(env?'\n':'')+Object.entries(values).map(([key,value])=>key+'='+value).join('\n')+'\n';
  }
  if(config.platforms!==undefined&&!plain(config.platforms))fail();
  const platforms={...(config.platforms??{})};
  if(platforms.zalo_personal!==undefined&&!plain(platforms.zalo_personal))fail();
  if(!credentialPending) platforms.zalo_personal={...(platforms.zalo_personal??{}),enabled:!revoked};
  const next={...config,mcp_servers:servers,platforms},encoded=yaml.dump(next,{schema:yaml.JSON_SCHEMA,noRefs:true,lineWidth:-1,sortKeys:false});
  // Preserve the original bytes on a semantic no-op, including comments.
  const yamlChanged=JSON.stringify(config)!==JSON.stringify(next);
  const configChanged=yamlChanged?publish(file,before,encoded):false;
  const envChanged=credentialPending?false:publish(envFile,envOriginal,env);
  return {changed:configChanged||envChanged,activation:configChanged||envChanged?'pending_controlled_restart':'unchanged'};
}
