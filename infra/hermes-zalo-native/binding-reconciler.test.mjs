import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { createNativeBindingReconciler } from './binding-reconciler.mjs';
import { validateNativeProvisioningConfiguration } from './profile-provisioning.mjs';
import { readNativeConfig } from '../../worker/lib/hermes-native-config.js';
const id=n=>n.repeat(8)+'-'+n.repeat(4)+'-4'+n.repeat(3)+'-8'+n.repeat(3)+'-'+n.repeat(12);
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'native-reconcile-'))),home=path.join(root,'alpha'),stateRoot=path.join(root,'state');
  fs.mkdirSync(home,{mode:0o700});fs.mkdirSync(stateRoot,{mode:0o700});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(home,'config.yaml'),'model: {default: private-existing}\nmcp_servers: {other: {url: https://existing.example.test/mcp}}\n',{mode:0o600});
  fs.writeFileSync(path.join(home,'.env'),'KEEP_OTHER=existing\nexport HERMES_ZALO_PAIRED_UID=999\n',{mode:0o600});
  const binding={bindingId:id('1'),bindingEpoch:1,assistantId:id('2'),userId:id('3'),organizationId:id('4'),accountId:id('5'),
    ownUid:'123',senderUid:'456',connectionId:id('6'),status:'active'};
  const work={status:'queued',revision:1,provisioningState:'pending',binding};
  const mapping={assistantId:binding.assistantId,userId:binding.userId,organizationId:binding.organizationId,accountId:binding.accountId,profile:'alpha',home};
  const record={connectionId:binding.connectionId,assistantId:binding.assistantId,userId:binding.userId,organizationId:binding.organizationId,
    operationId:id('7'),token:'hc_'+'a'.repeat(43)};
  const records=[record],calls=[];
  const configuration={configFile:path.join(root,'native.json'),stateRoot,listenPort:8991,mcpUrl:'http://127.0.0.1:8740/mcp',profiles:[mapping]};
  const transport={call:async(op,input)=>{
    calls.push(op);
    if(op==='readZaloProvisioningWork')return structuredClone(work);
    if(op==='readZaloBinding')return structuredClone(binding);
    if(op==='acknowledgeZaloProvisioning'){
      assert.equal(input.expectedRevision,work.revision);assert.equal(input.bindingId,binding.bindingId);work.provisioningState=input.state;return{status:'recorded'};
    }
    throw Error('unexpected');
  }};
  const backend={resolveConnection:async()=>({...record,connectionId:binding.connectionId,expiresAt:Date.now()+600000})};
  const create=options=>createNativeBindingReconciler({configuration,transport,backend,handoff:{list:async()=>structuredClone(records)},...options});
  return{root,home,configuration,mapping,record,records,binding,work,calls,backend,transport,create};
}
test('only the selected handoff credential is delivered; a newer credential never fills a missing selection',async t=>{
  const f=fixture(t);f.records[0].connectionId=id('8');
  const reconciler=f.create();t.after(()=>reconciler.close());
  await reconciler.reconcile();
  assert.equal(f.work.provisioningState,'pending_credential');assert.equal(reconciler.status().state,'pending');
  assert.equal(fs.existsSync(f.configuration.configFile),false);
  f.records[0].connectionId=f.binding.connectionId;await reconciler.reconcile();
  const config=yaml.load(fs.readFileSync(path.join(f.home,'config.yaml'),'utf8'));
  assert.equal(config.mcp_servers.crm.headers.Authorization,'Bearer '+f.record.token);
  assert.equal(config.mcp_servers.other.url,'https://existing.example.test/mcp');assert.equal(config.model.default,'private-existing');
  const env=fs.readFileSync(path.join(f.home,'.env'),'utf8');
  assert(env.includes('KEEP_OTHER=existing'));assert(!env.includes('PAIRED_UID=999'));assert(env.includes('HERMES_ZALO_PAIRED_UID=456'));
  assert.equal(f.work.provisioningState,'restart_pending');
});
test('credential rotation updates MCP only and preserves native token, generation, journal and restart evidence',async t=>{
  const f=fixture(t),reconciler=f.create();t.after(()=>reconciler.close());
  await reconciler.reconcile();
  const before=readNativeConfig(f.configuration.configFile).channels[0],nativeBytes=fs.readFileSync(f.configuration.configFile,'utf8');
  f.record.token='hc_'+'b'.repeat(43);f.records[0].token=f.record.token;f.work.revision++;
  await reconciler.reconcile();
  assert.equal(yaml.load(fs.readFileSync(path.join(f.home,'config.yaml'),'utf8')).mcp_servers.crm.headers.Authorization,'Bearer '+f.record.token);
  assert.equal(fs.readFileSync(f.configuration.configFile,'utf8'),nativeBytes);
  assert.deepEqual(readNativeConfig(f.configuration.configFile).channels[0],before);
  assert.equal(f.work.provisioningState,'restart_pending');
  await reconciler.reconcile();assert.equal(f.work.provisioningState,'restart_pending');
});
test('revocation removes the scoped CRM capability and native env, retains generation and does not remove other servers',async t=>{
  const f=fixture(t),reconciler=f.create();t.after(()=>reconciler.close());await reconciler.reconcile();
  const before=readNativeConfig(f.configuration.configFile).channels[0];f.binding.status='revoked';f.binding.bindingEpoch++;f.work.revision++;
  await reconciler.reconcile();
  const profile=yaml.load(fs.readFileSync(path.join(f.home,'config.yaml'),'utf8'));
  assert.equal(profile.mcp_servers.crm,undefined);assert.equal(profile.platforms.zalo_personal.enabled,false);assert(profile.mcp_servers.other);
  assert(!fs.readFileSync(path.join(f.home,'.env'),'utf8').includes('HERMES_ZALO_BRIDGE_TOKEN'));
  assert.equal(readNativeConfig(f.configuration.configFile).channels[0].generation,before.generation);
  assert.equal(f.work.provisioningState,'restart_pending');
});
test('foreign owner/ambiguous enrollment never mutates a profile; close waits an ignored-abort SQL read',async t=>{
  const f=fixture(t);f.records.push({...f.record,operationId:id('8')});
  let reconciler=f.create();await reconciler.reconcile();assert.equal(f.work.provisioningState,'pending_credential');await reconciler.close();
  let resolveRead,entered;const entry=new Promise(resolve=>{entered=resolve;});
  reconciler=f.create({transport:{call:async()=>{entered();return new Promise(resolve=>{resolveRead=resolve;});}}});
  const work=reconciler.reconcile();await entry;let closed=false;const closing=reconciler.close().then(()=>{closed=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);resolveRead({status:'empty'});await work;await closing;
  assert.equal(reconciler.status().state,'closed');
});
test('private allowlist refuses duplicate profiles, unsafe destinations and shared runtime/WAL namespaces',()=>{
  const row={assistantId:id('1'),userId:id('2'),organizationId:id('3'),accountId:id('4'),profile:'alpha',home:path.resolve('profile-home')};
  const config={configFile:path.resolve('native/config.json'),stateRoot:path.resolve('native/state'),listenPort:8991,mcpUrl:'http://127.0.0.1:8740/mcp',profiles:[row]};
  assert.equal(validateNativeProvisioningConfiguration(config).profiles.length,1);
  for(const bad of [{...config,profiles:[row,row]},{...config,mcpUrl:'http://remote.example.test/mcp'},
    {...config,stateRoot:row.home},{...config,profiles:[{...row,home:config.stateRoot}]}])assert.throws(()=>validateNativeProvisioningConfiguration(bad));
});

test('a selected credential missing from handoff parks the old CRM token while keeping the verified nick',async t=>{
  const f=fixture(t),reconciler=f.create();t.after(()=>reconciler.close());await reconciler.reconcile();
  const native=readNativeConfig(f.configuration.configFile).channels[0],env=fs.readFileSync(path.join(f.home,'.env'),'utf8');
  f.binding.connectionId=id('9');f.work.revision++;
  await reconciler.reconcile();
  const profile=yaml.load(fs.readFileSync(path.join(f.home,'config.yaml'),'utf8'));
  assert.equal(profile.mcp_servers.crm,undefined);assert.equal(profile.platforms.zalo_personal.enabled,true);
  assert.equal(fs.readFileSync(path.join(f.home,'.env'),'utf8'),env);
  assert.deepEqual(readNativeConfig(f.configuration.configFile).channels[0],native);
  assert.equal(f.work.provisioningState,'pending_credential');assert.equal(reconciler.status().state,'pending');
});

test('lost restart-marker ACK prevents file mutation and a later host never infers synchronized from a no-op',async t=>{
  const f=fixture(t),base=f.transport.call;
  f.transport.call=async(op,input)=>{
    const value=await base(op,input);
    if(op==='acknowledgeZaloProvisioning'&&input.state==='restart_pending')throw Error('synthetic lost ACK after commit');
    return value;
  };
  let reconciler=f.create();await reconciler.reconcile();await reconciler.close();
  assert.equal(fs.existsSync(f.configuration.configFile),false);
  assert.equal(f.work.provisioningState,'restart_pending');
  f.transport.call=base;
  reconciler=f.create();await reconciler.reconcile();await reconciler.close();
  const before=fs.readFileSync(f.configuration.configFile,'utf8'),profile=fs.readFileSync(path.join(f.home,'config.yaml'),'utf8');
  // Reproduce old-version disk publication with an absent final ACK. The new
  // process must repair the durable marker even though both files are a no-op.
  f.work.provisioningState='pending';
  const states=[];f.transport.call=async(op,input)=>{if(op==='acknowledgeZaloProvisioning')states.push(input.state);return base(op,input);};
  reconciler=f.create();await reconciler.reconcile();
  assert.equal(f.work.provisioningState,'restart_pending');assert.equal(reconciler.status().state,'pending');
  assert(!states.includes('synchronized'));assert.equal(fs.readFileSync(f.configuration.configFile,'utf8'),before);
  assert.equal(fs.readFileSync(path.join(f.home,'config.yaml'),'utf8'),profile);
  await reconciler.close();
});
test('a crash immediately after profile publication leaves a durable restart marker across process replacement',async t=>{
  const f=fixture(t),rename=fs.renameSync;
  let reconciler=f.create();
  fs.renameSync=(source,destination)=>{rename(source,destination);if(destination===path.join(f.home,'.env'))throw Error('synthetic crash after durable publish');};
  try{await reconciler.reconcile();}finally{fs.renameSync=rename;await reconciler.close();}
  assert.equal(f.work.provisioningState,'restart_pending');
  assert.equal(yaml.load(fs.readFileSync(path.join(f.home,'config.yaml'),'utf8')).mcp_servers.crm.headers.Authorization,'Bearer '+f.record.token);
  const before=readNativeConfig(f.configuration.configFile).channels[0];
  reconciler=f.create();await reconciler.reconcile();
  assert.equal(f.work.provisioningState,'restart_pending');assert.equal(reconciler.status().state,'pending');
  assert.deepEqual(readNativeConfig(f.configuration.configFile).channels[0],before);
  await reconciler.close();
});
