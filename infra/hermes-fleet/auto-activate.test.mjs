import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { authorizedPeer, bindingFromProfile } from './binding-guard.mjs';
import { activate, employeeProfile } from './auto-activate.mjs';
import { queuedEmployees, acknowledge } from './activation-queue.mjs';

const id = n => '00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const scope = { organizationId:id(1), accountId:id(2) };
const row = { ...scope, assistantId:id(3), userId:id(4), connectionId:id(5), bindingId:id(6), senderUid:'12345', revision:2, state:'pending' };
const work = { status:'queued', provisioningState:'pending', revision:2, binding:{ ...row,status:'active' } };
const assistant = { connectionId:row.connectionId, identity:{ accountId:row.accountId, pairedUid:row.senderUid }, channelAction:'create' };
test('systemd entry points run through a release directory symlink', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-release-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const current = path.join(temp, 'current');
  fs.symlinkSync(fileURLToPath(new URL('.', import.meta.url)), current, 'junction');
  for (const file of ['activation-queue.mjs', 'auto-activate.mjs', 'binding-guard.mjs']) {
    const run = spawnSync(process.execPath, [path.join(current, file), '--invalid'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /activation_queue_unavailable|activation_cycle_failed|binding_guard_unavailable/);
  }
});
test('worker authority follows the synchronized binding and shuts on unlink, changed identity or missing authority', async () => {
  const origin = { ...work.binding, ownUid:'111' };
  const channel = { profile:employeeProfile(row.bindingId), accountId:row.accountId, ownUid:'111', pairedUid:row.senderUid };
  assert.equal(bindingFromProfile(channel.profile), row.bindingId);
  const allowed = (current, originBinding = origin, native = channel) => authorizedPeer(
    async op => op === 'readZaloBinding' ? originBinding : current, scope, native);
  const ready = { ...work, provisioningState:'synchronized', binding:origin };
  const pending = { ...ready, provisioningState:'restart_pending' };
  const probe = expected => authorizedPeer(async op => op === 'readZaloBinding' ? origin : pending, scope, channel, expected);
  assert.equal(await allowed(pending), false);
  assert.equal(await probe(row), true);
  assert.equal(await probe({ ...row, revision:row.revision + 1 }), false);
  assert.equal(await probe({ ...row, connectionId:id(9) }), false);
  assert.equal(await allowed(ready), true);
  for (const change of [{ status:'revoked' }, { userId:id(8) }, { organizationId:id(8) }, { accountId:id(8) },
    { assistantId:id(8) }, { senderUid:'333' }, { connectionId:null }, { ownUid:'444' }])
    assert.equal(await allowed({ ...ready, binding:{ ...origin, ...change } }), false);
  for (const current of [null, { status:'empty' }, { ...ready, provisioningState:'pending' }, { ...ready, binding:null }])
    assert.equal(await allowed(current), false);
  assert.equal(await allowed(ready, origin, { ...channel, pairedUid:'999' }), false);
  assert.equal(await allowed({ ...ready, binding:{ ...origin, bindingId:id(8) } }, { ...origin, status:'revoked' }), true);
});
test('same employee can re-pair the same Zalo nick while a different employee cannot inherit the home', () => {
  const previous = { ...row, bindingId:id(8) };
  const io = services(), profile = employeeProfile(previous.bindingId);
  io.channels = () => [{ profile, accountId:row.accountId, pairedUid:row.senderUid }];
  io.binding = () => previous;
  io.apply = (_, name) => { assert.equal(name, profile); return { runtimeStatus:'verified', assistant }; };
  assert.equal(activate(row, scope, io), 'activated');
  io.binding = () => ({ ...previous, userId:id(9) });
  assert.equal(activate(row, scope, io), 'existing_channel');
});
function services() {
  const events=[];
  return { events, channels:()=>[], container:()=>null, verifyGuard:()=>true,
    ack:(_,state)=>{ events.push(state); return true; },
    plan:()=>({status:'ready',expectedRevision:'fixture',assistant}),
    apply:(_,profile,expect)=>{assert.equal(profile,employeeProfile(row.bindingId));assert.equal(expect,'fixture');
      events.push('apply');return {runtimeStatus:'verified',assistant};} };
}
test('discover only the selected credential for an active employee binding in the configured company and bot',async()=>{
  let reads=0;
  const discover=(binding,records=[row],state='pending')=>queuedEmployees({...scope,enrollments:records,
    read:async()=>{reads++;return {...work,binding,provisioningState:state};}});
  assert.deepEqual(await discover(work.binding,[{...row,connectionId:id(7)},row]),[row]);
  assert.equal(reads,1);
  for(const changes of [{status:'revoked'},{accountId:id(9)},{organizationId:id(9)},{userId:id(9)},{connectionId:id(9)}])
    assert.deepEqual(await discover({...work.binding,...changes}),[]);
  assert.deepEqual(await discover(work.binding,[row,row]),[]);
  assert.deepEqual(await discover(work.binding,[row],'synchronized'),[]);
  assert.deepEqual(await discover(work.binding,[{...row,organizationId:id(8)}]),[]);
});
test('verified fleet apply precedes queue completion; no duplicate profile on retry',()=>{
  const io=services();
  assert.equal(activate(row,scope,io),'activated');
  assert.deepEqual(io.events,['restart_pending','restart_pending','apply','synchronized']);
  assert.match(employeeProfile('ffffffff-ffff-4fff-8fff-ffffffffffff'),/^[a-z][a-z0-9-]{1,30}$/);
  assert.notEqual(employeeProfile(id(4)),employeeProfile(id(5)));
  assert.equal(activate(row,scope,io,true),'eligible');
  assert.equal(io.events.length,4);
});
test('manual, revoked and parked profiles stay under operator control',()=>{
  for(const channel of [{profile:'owner'},{profile:employeeProfile(row.bindingId),unissued:true}]){
    const io=services();io.channels=()=>[{...channel,accountId:row.accountId,pairedUid:row.senderUid}];
    assert.equal(activate(row,scope,io),'existing_channel');assert.deepEqual(io.events,[]);
  }
  const io=services();io.container=()=>({managed:true,parked:true});
  assert.equal(activate(row,scope,io),'operator_managed');assert.deepEqual(io.events,[]);
});
test('changed selection, capacity refusal, inconclusive verification and missing ACK never mark ready',()=>{
  for(const plan of [{status:'blocked'},{status:'ready',assistant:{...assistant,connectionId:id(8)}},
    {status:'ready',assistant:{...assistant,channelAction:'rotate'}}]){
    const io=services();io.plan=()=>plan;
    assert.equal(activate(row,scope,io),'blocked');assert.deepEqual(io.events,['restart_pending','unavailable']);
  }
  const io=services();io.apply=()=>({runtimeStatus:'unverified',assistant});assert.equal(activate(row,scope,io),'unverified');
  assert.equal(io.events.at(-1),'unavailable');
  const denied = services(); denied.verifyGuard=()=>false;
  assert.equal(activate(row,scope,denied),'unverified');assert.equal(denied.events.at(-1),'unavailable');
  const concurrent=services();let check=0;concurrent.ack=()=>++check<2;
  assert.equal(activate(row,scope,concurrent),'superseded');assert.deepEqual(concurrent.events,[]);
  assert.throws(()=>activate({...row,userId:'invalid'},scope,services()));
});
test('ACK rechecks exact binding and uses the SQL revision compare-and-set',async()=>{
  const writes=[];
  const transport={call:async(op,input)=>{if(op==='readZaloProvisioningWork')return work;writes.push(input);return {status:'recorded'};}};
  for(const changes of [{revision:1},{bindingId:id(8)},{userId:id(8)},{senderUid:'777'},{connectionId:id(8)}])
    assert.equal(await acknowledge(transport,{...row,...changes},'synchronized'),false);
  assert.deepEqual(writes,[]);assert.equal(await acknowledge(transport,row,'synchronized'),true);
  assert.deepEqual(writes,[{assistantId:row.assistantId,accountId:row.accountId,bindingId:row.bindingId,expectedRevision:2,state:'synchronized'}]);
});
