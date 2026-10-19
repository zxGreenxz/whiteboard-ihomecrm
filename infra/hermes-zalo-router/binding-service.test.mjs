import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createZaloBindingService, prepareLiveLinkObservation, ZaloBindingError, ZaloBindingRpcRejection } from './binding-service.mjs';

const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const USER=id('1'), ORG=id('2'), ACCOUNT=id('3'), CONNECTION=id('4'), CHALLENGE=id('5');
const secret='hz_'+'a'.repeat(64);
function input() {
  return { source:{accountId:ACCOUNT,organizationId:ORG,instanceId:id('6'),generation:id('7'),ownUid:'12345',eventKind:'message'},
    event:{type:0,isSelf:false,threadId:'98765',data:{uidFrom:'98765',idTo:'12345',msgType:'webchat',msgId:'provider-1',content:'/hermes-link '+secret}} };
}
test('worker live DM projects only fixed digest/identity, never a raw code or content authority',()=>{
  const observed=prepareLiveLinkObservation(input());
  assert.deepEqual(observed,{operation:'observe',accountId:ACCOUNT,organizationId:ORG,instanceId:id('6'),generation:id('7'),senderUid:'98765',providerMessageId:'provider-1',challengeDigest:createHash('sha256').update(secret).digest('hex')});
  assert.equal(Object.isFrozen(observed),true);assert(!JSON.stringify(observed).includes(secret));
});
for(const [name,mutate] of [
  ['group',x=>x.event.type=1],['self echo',x=>x.event.isSelf=true],['unknown type',x=>delete x.event.type],
  ['thread mismatch',x=>x.event.threadId='999'],['recipient mismatch',x=>x.event.data.idTo='999'],
  ['system event',x=>x.event.data.msgType='chat.system'],['object content',x=>x.event.data.content={title:'/hermes-link '+secret}],
  ['quote',x=>x.event.data.quote={ownerId:'98765'}],['forward reference',x=>x.event.data.reference={type:3}],
  ['forward decorLog',x=>x.event.data.decorLog={fw:{}}],['missing message ID',x=>delete x.event.data.msgId],
  ['command with appended org override',x=>x.event.data.content+=' org='+ORG],
])test(`live eligibility refuses ${name}`,()=>{const x=input();mutate(x);assert.equal(prepareLiveLinkObservation(x),null)});
test('history listener and missing ingress generation are not eligible trusted sources',()=>{
  const x=input();x.source.eventKind='old_messages';assert.throws(()=>prepareLiveLinkObservation(x),/invalid_source/);
  x.source.eventKind='message';delete x.source.generation;assert.throws(()=>prepareLiveLinkObservation(x),/invalid_source/);
});
test('provider model class is supported but accessor text is never executed',()=>{
  class UserMessage {constructor(){Object.assign(this,input().event)}}
  const x=input();x.event=new UserMessage();assert(prepareLiveLinkObservation(x));
  Object.defineProperty(x.event.data,'content',{get(){throw Error('must not run')}});assert.equal(prepareLiveLinkObservation(x),null);
});
function fixture(overrides={}) {
  const calls=[];let verifies=0;
  const caller={userId:USER,organizationId:ORG,sessionId:id('9')};
  const result={status:'waiting',userId:USER,organizationId:ORG,challengeId:CHALLENGE,challenge:secret,accountId:ACCOUNT,connectionId:CONNECTION,expiresAt:1800000000000};
  const service=createZaloBindingService({verifyCaller:async()=>{verifies++;return overrides.verify?overrides.verify(verifies,caller):structuredClone(caller)},
    rpc:async request=>{calls.push(request);return overrides.rpc?overrides.rpc(request,result):structuredClone(result)}});
  const options={accessToken:'fixture.browser.jwt',organizationId:ORG,signal:new AbortController().signal};
  const begin=()=>service.invoke('begin',{connectionId:CONNECTION,expectedConnectionEpoch:2,accountId:ACCOUNT},options);
  return {service,calls,options,begin,get verifies(){return verifies}};
}
test('CRM Auth runs once before the fixed caller-JWT RPC',async()=>{
  const f=fixture();assert.equal((await f.begin()).challenge,secret);assert.equal(f.verifies,1);assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].functionName,'hermes_zalo_binding_v1');assert.equal(f.calls[0].accessToken,'fixture.browser.jwt');
  assert.deepEqual(f.calls[0].args,{p:{operation:'begin',organizationId:ORG,connectionId:CONNECTION,expectedConnectionEpoch:2,accountId:ACCOUNT}});
});
test('caller cannot supply another user or choose organization through payload',async()=>{
  const f=fixture();await assert.rejects(f.service.invoke('begin',{connectionId:CONNECTION,expectedConnectionEpoch:2,accountId:ACCOUNT,userId:id('9')},f.options),/invalid_request/);assert.equal(f.calls.length,0);
});
test('wrong-company Auth result denies before dispatch even for presumed superadmin',async()=>{
  const f=fixture({verify:(_n,c)=>({...c,organizationId:id('9')})});await assert.rejects(f.begin(),/forbidden/);assert.equal(f.calls.length,0);
});
test('membership is owned by the canonical caller-JWT SQL decision, without a second Auth round trip',async()=>{
  const f=fixture(); await f.begin(); assert.equal(f.verifies,1); assert.equal(f.calls.length,1);
});
for(const [name,mutate] of [
  ['extra credential',r=>({...r,accessToken:'DO_NOT_EXPOSE'})],['wrong owner',r=>({...r,userId:id('9')})],
  ['wrong bot',r=>({...r,accountId:id('9')})],['missing challenge',r=>({...r,challenge:undefined})],
])test(`write response ${name} is withheld`,async()=>{
  const f=fixture({rpc:(_q,r)=>mutate(r)});await assert.rejects(f.begin(),e=>e.outcomeUnknown);assert.equal(f.calls.length,1);
});
test('lost ACK is unknown; raw server diagnostics and credentials never escape',async()=>{
  const f=fixture({rpc:()=>{throw Error('PRIVATE_PROVIDER_DETAILS')}});await assert.rejects(f.begin(),e=>e.message==='binding_outcome_unknown'&&!String(e).includes('PRIVATE'));assert.equal(f.calls.length,1);
});
test('abort before dispatch never invokes Auth or RPC',async()=>{
  const f=fixture(),c=new AbortController();c.abort();f.options.signal=c.signal;await assert.rejects(f.begin(),/cancelled/);assert.equal(f.verifies,0);assert.equal(f.calls.length,0);
});
test('confirm binds exact observed sender and unlink can recover through self-list metadata',async()=>{
  const f=fixture({rpc:q=>q.args.p.operation==='list'?{status:'listed',userId:USER,organizationId:ORG,nextCursor:null,bindings:[{bindingId:id('6'),epoch:1,state:'active',accountId:ACCOUNT,connectionId:CONNECTION,senderUid:'98765'}]}:
    {status:'active',userId:USER,organizationId:ORG,bindingId:id('6'),epoch:1,accountId:ACCOUNT,connectionId:CONNECTION,senderUid:'98765'}});
  const result=await f.service.invoke('confirm',{challengeId:CHALLENGE,expectedCandidateVersion:1,expectedSenderUid:'98765'},f.options);assert.equal(result.senderUid,'98765');
  assert.equal((await f.service.invoke('list',{afterBindingId:null},f.options)).bindings[0].bindingId,result.bindingId);
});
test('SQL candidate contains the independent CRM-confirm, lease, same-org and private ACL guards (not live DB proof)',async()=>{
  const sql=await readFile(new URL('../../supabase/migrations/20261012165523_hermes_zalo_binding_v1.sql',import.meta.url),'utf8');
  assert.match(sql,/h\.state<>'OBSERVED'/);assert.match(sql,/h\.sender_uid IS DISTINCT FROM p->>'expectedSenderUid'/);
  assert.match(sql,/heartbeat_at>clock_timestamp\(\)-interval '30 seconds'/);assert.match(sql,/generation=v_generation/);
  assert.match(sql,/account_id=v_account AND organization_id=o AND enabled/);assert.match(sql,/state='OBSERVED',candidate_version=1/);
  assert.match(sql,/GRANT EXECUTE ON FUNCTION public\.hermes_zalo_binding_v1\(jsonb\) TO authenticated/);
  assert.match(sql,/GRANT EXECUTE ON FUNCTION public\.hermes_zalo_ingress_v1\(jsonb\) TO service_role/);
  assert.doesNotMatch(sql,/GRANT .* ON (?:TABLE )?app_private\.hermes_zalo/);
});

test('bounded cursor pages retain revoked binding recovery beyond one hundred links', async () => {
  const row = n => ({bindingId:n.toString(16).padStart(8,'0')+'-1111-4111-8111-111111111111',epoch:2,state:'revoked',accountId:ACCOUNT,connectionId:CONNECTION,senderUid:'98765'});
  const rows=Array.from({length:101},(_,n)=>row(n+1));
  const f=fixture({rpc:q=>{const after=q.args.p.afterBindingId;const available=rows.filter(r=>after===null||r.bindingId>after);const page=available.slice(0,100);
    return {status:'listed',userId:USER,organizationId:ORG,bindings:page,nextCursor:available.length>100?page.at(-1).bindingId:null};}});
  const first=await f.service.invoke('list',{afterBindingId:null},f.options);
  assert.equal(first.bindings.length,100);assert.equal(first.nextCursor,rows[99].bindingId);
  const second=await f.service.invoke('list',{afterBindingId:first.nextCursor},f.options);
  assert.deepEqual(second.bindings,[rows[100]]);assert.equal(second.nextCursor,null);
  assert.equal(f.calls.length,2);
});

test('cursor page rejects forged continuation and rows at or before the requested cursor', async () => {
  const row={bindingId:id('6'),epoch:2,state:'revoked',accountId:ACCOUNT,connectionId:CONNECTION,senderUid:'98765'};
  for(const [after,nextCursor] of [[null,id('7')],[id('6'),null],[id('7'),null]]){
    const f=fixture({rpc:()=>({status:'listed',userId:USER,organizationId:ORG,bindings:[row],nextCursor})});
    await assert.rejects(f.service.invoke('list',{afterBindingId:after},f.options),e=>e.message==='backend_unavailable'&&!e.outcomeUnknown);
  }
});

test('only typed RPC rejections certify the outcome of a dispatched write', async () => {
  for (const error of [new ZaloBindingRpcRejection('forbidden'), new ZaloBindingError('forbidden'), { code: 'forbidden' }]) {
    const f = fixture({ rpc: () => { throw error; } });
    await assert.rejects(f.begin(), result => result.code === (error instanceof ZaloBindingRpcRejection ? 'forbidden' : 'binding_outcome_unknown'));
    assert.equal(f.calls.length, 1);
  }
});

test('bot directory is bounded, ordered and strips neither malformed rows nor unexpected data silently', async () => {
  const f = fixture({ rpc: () => ({ status: 'listed', userId: USER, organizationId: ORG,
    bots: [{ accountId: ACCOUNT, name: 'Company bot', zaloUid: '12345' }], nextCursor: null }) });
  assert.equal((await f.service.invoke('bots', { afterAccountId: null }, f.options)).bots[0].name, 'Company bot');
  await assert.rejects(f.service.invoke('bots', { afterAccountId: ACCOUNT }, f.options), { code: 'backend_unavailable' });
});

test('bot administration accepts an unconfigured account, pins the version and performs one caller-JWT write', async () => {
  const f = fixture({ rpc: ({ args }) => args.p.operation === 'manageBots' ? { status: 'listed', userId: USER, organizationId: ORG,
    bots: [{ accountId: ACCOUNT, name: 'Secondary', zaloUid: null, connected: false, enabled: false, version: 0 }], nextCursor: null } :
    { status: 'configured', userId: USER, organizationId: ORG, accountId: ACCOUNT, enabled: true, version: 1 } });
  assert.equal((await f.service.invoke('manageBots', { afterAccountId: null }, f.options)).bots[0].version, 0);
  assert.equal((await f.service.invoke('setBot', { accountId: ACCOUNT, expectedVersion: 0, enabled: true }, f.options)).version, 1);
  assert.deepEqual(f.calls[1].args.p, { operation: 'setBot', organizationId: ORG, accountId: ACCOUNT, expectedVersion: 0, enabled: true });
  assert.equal(f.calls.length, 2);
});

test('bot configuration cannot use coerced values, overwrite stale versions or disclose mismatched acknowledgements', async () => {
  const f = fixture({ rpc: () => ({ status: 'configured', userId: USER, organizationId: ORG, accountId: ACCOUNT, enabled: true, version: 3 }) });
  for (const patch of [{ expectedVersion: -1 }, { expectedVersion: 0.5 }, { expectedVersion: '0' },
    { expectedVersion: Number.MAX_SAFE_INTEGER - 1 }, { enabled: 'true' }, { userId: USER }]) {
    await assert.rejects(f.service.invoke('setBot', { accountId: ACCOUNT, expectedVersion: 0, enabled: true, ...patch }, f.options), { code: 'invalid_request' });
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.service.invoke('setBot', { accountId: ACCOUNT, expectedVersion: 0, enabled: true }, f.options), { code: 'binding_outcome_unknown' });
  assert.equal(f.calls.length, 1);
  for (const code of ['forbidden', 'context_changed']) {
    const denied = fixture({ rpc: () => { throw new ZaloBindingRpcRejection(code); } });
    await assert.rejects(denied.service.invoke('setBot', { accountId: ACCOUNT, expectedVersion: 2, enabled: false }, denied.options), { code, outcomeUnknown: false });
    assert.equal(denied.calls.length, 1);
  }
});

test('admin projection rejects extra account secrets, fabricated readiness and enabled version zero', async () => {
  for (const patch of [{ sessionKey: 'PRIVATE' }, { connected: true }, { enabled: true }, { version: -1 }]) {
    const f = fixture({ rpc: () => ({ status: 'listed', userId: USER, organizationId: ORG, nextCursor: null,
      bots: [{ accountId: ACCOUNT, name: 'Secondary', zaloUid: null, connected: false, enabled: false, version: 0, ...patch }] }) });
    await assert.rejects(f.service.invoke('manageBots', { afterAccountId: null }, f.options), { code: 'backend_unavailable', outcomeUnknown: false });
  }
});

test('SQL admin source requires both CRM grants, exact org/CAS and revokes prior links; mutations fail (not live SQL proof)', async () => {
  const sql = await readFile(new URL('../../supabase/migrations/20261012165523_hermes_zalo_binding_v1.sql', import.meta.url), 'utf8');
  const guard = source => {
    const authority = source.slice(source.indexOf("IF op IN ('manageBots','setBot') THEN"), source.indexOf("    v_account:=app_private.hermes_uuid_v1(p->'accountId');"));
    assert(authority.includes("require_perm_v1(o,'users.edit'"));
    assert(authority.includes("require_perm_v1(o,'chat_zalo.manage_automation'"));
    assert(source.includes('b.account_id IS NOT NULL AND b.organization_id<>o'));
    assert(source.includes('WHERE hermes_zalo_bots.organization_id=o AND hermes_zalo_bots.version=v_epoch RETURNING * INTO b;'));
    assert.match(source, /RETURNING \* INTO b;\s+IF NOT FOUND THEN RAISE EXCEPTION 'hermes_zalo_context_changed'/);
    assert(source.includes("(p->>'enabled')::boolean AND v_can_enable IS DISTINCT FROM true"));
    assert.match(source, /UPDATE app_private\.hermes_zalo_link_challenges SET state='REVOKED'\s+WHERE account_id=v_account AND organization_id=o AND state IN \('WAITING','OBSERVED'\)/);
    assert.match(source, /UPDATE app_private\.hermes_zalo_bindings SET state='REVOKED',epoch=epoch\+1,revoked_at=clock_timestamp\(\)\s+WHERE account_id=v_account AND organization_id=o AND state='ACTIVE'/);
    const directory = source.slice(source.indexOf("  ELSIF op='manageBots' THEN\n"), source.indexOf("  ELSIF op='bots' THEN\n"));
    assert(directory.includes("WHERE a.organization_id=o AND a.kind='personal' AND (z.account_id IS NULL OR z.organization_id=o)"));
    assert(directory.includes('ORDER BY a.id LIMIT 101'));
    assert(directory.includes('SELECT * FROM window_rows ORDER BY id LIMIT 100'));
  };
  guard(sql);
  for (const [from, to] of [["require_perm_v1(o,'users.edit'", "require_perm_v1(o,'users.view'"],
    ["require_perm_v1(o,'chat_zalo.manage_automation'", "require_perm_v1(o,'chat_zalo.view'"],
    [' AND hermes_zalo_bots.version=v_epoch', ''], ['b.organization_id<>o', 'false'],
    ["hermes_zalo_bindings SET state='REVOKED',epoch=epoch+1", "hermes_zalo_bindings SET state='REVOKED',epoch=epoch"],
    ['a.organization_id=o AND a.kind=', 'a.kind=']]) assert.throws(() => guard(sql.replace(from, to)));
});

test('timeout keeps admission until the underlying write settles; close drains and never retries', async () => {
  let resolveWrite, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  let calls = 0, signal;
  const caller = { userId: USER, organizationId: ORG, sessionId: id('9') };
  const service = createZaloBindingService({ verifyCaller: async () => caller, timeoutMs: 25, maxConcurrent: 1,
    rpc: q => { calls++; signal = q.signal; entered(); return new Promise(resolve => { resolveWrite = resolve; }); } });
  const options = { accessToken: 'fixture.browser.jwt', organizationId: ORG, signal: new AbortController().signal };
  const pending = service.invoke('begin', { connectionId: CONNECTION, expectedConnectionEpoch: 2, accountId: ACCOUNT }, options);
  const rejected = assert.rejects(pending, { code: 'binding_outcome_unknown' });
  await enteredPromise; await rejected; assert(signal.aborted);
  await assert.rejects(service.invoke('list', { afterBindingId: null }, options), { code: 'busy' });
  let closed = false; const closing = service.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  resolveWrite({}); await closing;
  await assert.rejects(service.invoke('list', { afterBindingId: null }, options), { code: 'backend_closed' });
  assert.equal(calls, 1);
});

test('binding source locks lease, account, bot, ingress before challenge and uses bounded history pages', async () => {
  const sql=await readFile(new URL('../../supabase/migrations/20261012165523_hermes_zalo_binding_v1.sql',import.meta.url),'utf8');
  const section=sql.slice(sql.indexOf("ELSIF op IN ('status','confirm') THEN"),sql.indexOf("ELSIF op='list' THEN\n"));
  const assertLocks = source => {
    const fragments=["FROM public.zalo_worker_lease WHERE id='singleton' FOR SHARE", "FROM public.zalo_accounts WHERE id=h.account_id AND organization_id=o AND kind='personal' AND status='connected' FOR SHARE",
      "FROM app_private.hermes_zalo_bots WHERE account_id=h.account_id AND organization_id=o AND enabled FOR SHARE",
      "FROM app_private.hermes_zalo_ingress_sessions WHERE account_id=h.account_id AND organization_id=o FOR SHARE",
      "FROM app_private.hermes_zalo_link_challenges WHERE id=v_id AND user_id=u AND organization_id=o FOR UPDATE"];
    let position=-1;for(const part of fragments){const found=source.indexOf(part);assert(found>position,part);position=found;}
    assert(position<source.indexOf('INSERT INTO app_private.hermes_zalo_bindings'));
  };
  assertLocks(section);
  assert.throws(()=>assertLocks(section.replace("WHERE id='singleton' FOR SHARE","WHERE id='singleton'")));
  assert(sql.includes('ORDER BY z.id LIMIT 101'));assert(sql.includes('SELECT * FROM window_rows ORDER BY id LIMIT 100'));
  assert(sql.includes('z.user_id=u AND z.organization_id=o AND (v_after IS NULL OR z.id>v_after)'));
  assert(!sql.includes('hermes_zalo_list_too_large'));
});
