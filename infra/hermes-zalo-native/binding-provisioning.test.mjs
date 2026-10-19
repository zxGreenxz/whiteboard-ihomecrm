import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { provisionNativeBinding } from './binding-provisioning.mjs';
import { runBindingProvisioningCli } from './binding-provisioning-cli.mjs';
import { readNativeConfig } from '../../worker/lib/hermes-native-config.js';
const id=n=>n.repeat(8)+'-'+n.repeat(4)+'-4'+n.repeat(3)+'-8'+n.repeat(3)+'-'+n.repeat(12);
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'native-binding-'))),stateRoot=path.join(root,'state');
  fs.mkdirSync(stateRoot,{mode:0o700});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const row={bindingId:id('1'),bindingEpoch:1,assistantId:id('2'),userId:id('3'),organizationId:id('4'),
    accountId:id('5'),ownUid:'123',senderUid:'456',connectionId:id('6'),status:'active'};
  const calls=[],options={bindingId:row.bindingId,profileBinding:{assistantId:row.assistantId,userId:row.userId,
    organizationId:row.organizationId,profile:'alpha'},configFile:path.join(root,'config.json'),
    tokenFile:path.join(root,'alpha.token'),stateRoot,listenPort:8991,signal:new AbortController().signal,
    transport:{call:async(...args)=>{calls.push(args);return structuredClone(row);}}};
  return {row,options,calls,root};
}
test('verified SQL snapshot provisions through real operator; credential changes preserve channel token, generation and journals',async t=>{
  const f=fixture(t),plan=await provisionNativeBinding(f.options);
  assert.equal(plan.status,'planned');assert.equal(fs.existsSync(f.options.configFile),false);
  const result=await provisionNativeBinding({...f.options,apply:true,expect:plan.expectedRevision});
  assert.equal(result.status,'updated');assert.equal(result.operator.activation,'pending_controlled_worker_restart');
  const before=readNativeConfig(f.options.configFile),configBytes=fs.readFileSync(f.options.configFile,'utf8');
  f.row.connectionId=id('7');
  const {stateRoot,listenPort,...existing}=f.options;
  assert.equal((await provisionNativeBinding(existing)).status,'unchanged');
  assert.equal(fs.readFileSync(f.options.configFile,'utf8'),configBytes);
  assert.deepEqual(readNativeConfig(f.options.configFile),before);
  assert(!JSON.stringify(result).includes(before.channels[0].token));
  assert(f.calls.every(([operation,input])=>operation==='readZaloBinding'&&input.bindingId===f.row.bindingId));
});
test('wrong owner/profile mapping, stale SQL, and changed sender are rejected before config mutation',async t=>{
  const f=fixture(t),plan=await provisionNativeBinding(f.options);
  f.row.userId=id('8');await assert.rejects(provisionNativeBinding({...f.options,apply:true,expect:plan.expectedRevision}));
  assert.equal(fs.existsSync(f.options.configFile),false);
  f.row.userId=f.options.profileBinding.userId;f.row.bindingEpoch++;
  await assert.rejects(provisionNativeBinding({...f.options,apply:true,expect:plan.expectedRevision}));
  assert.equal(fs.existsSync(f.options.configFile),false);
});
test('revoked SQL identity uses existing operator revoke and retains channel history',async t=>{
  const f=fixture(t),plan=await provisionNativeBinding(f.options);
  await provisionNativeBinding({...f.options,apply:true,expect:plan.expectedRevision});
  const before=readNativeConfig(f.options.configFile).channels[0];
  f.row.status='revoked';
  const planned=await provisionNativeBinding(f.options);
  await provisionNativeBinding({...f.options,apply:true,expect:planned.expectedRevision});
  const after=readNativeConfig(f.options.configFile).channels[0];
  assert.equal(after.generation,before.generation);assert.equal(after.profile,before.profile);
  assert.notEqual(after.token,before.token);
  const configBytes=fs.readFileSync(f.options.configFile,'utf8');
  assert.equal((await provisionNativeBinding(f.options)).status,'unchanged');
  assert.equal(fs.readFileSync(f.options.configFile,'utf8'),configBytes);
});
test('executable bridge opens only the configured trusted store, previews the real operator, and redacts backend failures',async t=>{
  const f=fixture(t),output=[],errors=[];let closed=0;
  const injected={loadConfig:async()=>({version:1,store:{},bindingId:f.row.bindingId,profileBinding:f.options.profileBinding,
    native:{configFile:f.options.configFile,tokenFile:f.options.tokenFile,stateRoot:f.options.stateRoot,listenPort:f.options.listenPort}}),
    connectStore:async()=>({transport:f.options.transport,close:async()=>{closed++;}}),write:value=>output.push(JSON.parse(value)),error:value=>errors.push(JSON.parse(value))};
  assert.equal(await runBindingProvisioningCli(['--config','/host/private.json'],injected),0);
  assert.equal(output[0].status,'planned');assert.equal(closed,1);assert.equal(fs.existsSync(f.options.configFile),false);
  injected.connectStore=async()=>{throw Error('SECRET_PRIVATE_DIAGNOSTICS');};
  assert.equal(await runBindingProvisioningCli(['--config','/host/private.json'],injected),1);
  assert(!JSON.stringify(errors).includes('SECRET'));assert.equal(closed,1);
});

test('a second configured profile uses the existing native namespace without bootstrap-only arguments',async t=>{
  const f=fixture(t),first=await provisionNativeBinding(f.options);
  await provisionNativeBinding({...f.options,apply:true,expect:first.expectedRevision});
  const original=readNativeConfig(f.options.configFile).channels[0];
  f.row.bindingId=id('8');f.row.assistantId=id('9');f.row.userId=id('a');f.row.senderUid='789';
  const options={...f.options,bindingId:f.row.bindingId,profileBinding:{...f.options.profileBinding,
    assistantId:f.row.assistantId,userId:f.row.userId,profile:'beta'},tokenFile:path.join(f.root,'beta.token')};
  const planned=await provisionNativeBinding(options);
  await provisionNativeBinding({...options,apply:true,expect:planned.expectedRevision});
  const channels=readNativeConfig(f.options.configFile).channels;
  assert.equal(channels.length,2);assert.deepEqual(channels[0],original);
  assert.equal(channels[1].profile,'beta');assert.equal(channels[1].pairedUid,'789');
});
