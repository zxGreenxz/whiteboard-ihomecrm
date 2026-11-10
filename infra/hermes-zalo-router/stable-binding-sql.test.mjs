import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { createNativeBindingReconciler } from '../hermes-zalo-native/binding-reconciler.mjs';
import { createHandoffCipher } from '../hermes-broker/connection-handoff.mjs';
import { readNativeConfig } from '../../worker/lib/hermes-native-config.js';
import { fixture, id, ORG, USER, ASSISTANT, SESSION, CONNECTION, BINDING, ACCOUNT, FOREIGN, INSTANCE, GENERATION, CONVERSATION } from './private-command-fixture.mjs';

const sql = readFileSync(new URL('../../supabase/migrations/20261019034850_hermes_zalo_stable_binding_v1.sql',import.meta.url),'utf8');
// 20261110072604 replaces the body of public.hermes_zalo_binding_v1 only (confirm re-selects the assistant credential while the
// assistant has no ACTIVE binding). Every test below runs on that live body; its revert is not a migration.
const reselect = readFileSync(new URL('../../supabase/migrations/20261110072604_hermes_zalo_confirm_reselect_unbound_v1.sql',import.meta.url),'utf8');
const reselectRevert = readFileSync(new URL('../../docs/plans/hermes-crm/revert/hermes_zalo_confirm_reselect_unbound_revert_v1.sql',import.meta.url),'utf8');
async function setup(t) {
  const f = await fixture(t, { migrations: ['20261013084000_hermes_private_command_dispatch_v1','20261013095000_hermes_zalo_private_reply_v1'] });
  await f.db.exec("CREATE FUNCTION app_private.is_actor_offboarded_v1() RETURNS boolean LANGUAGE sql AS $$SELECT false$$; CREATE FUNCTION app_private.append_authz_audit_v1(o uuid,event text,kind text,entity uuid,prev jsonb,next jsonb,reason text) RETURNS void LANGUAGE plpgsql AS $$BEGIN RETURN; END$$");
  await f.db.exec("ALTER TABLE app_private.hermes_connections ADD COLUMN permission_mode text NOT NULL DEFAULT 'legacy_snapshot'");
  const optional=readFileSync(new URL('../../supabase/migrations/20261014000503_hermes_optional_org_policy_v1.sql',import.meta.url),'utf8');
  const start=optional.indexOf('CREATE OR REPLACE FUNCTION app_private.hermes_effective_org_policy_v1');
  await f.db.exec(optional.slice(start,optional.indexOf('END $fn$;',start)+'END $fn$;'.length));
  await f.db.exec("CREATE TABLE public.role_bindings(membership_id uuid,organization_id uuid,valid_from timestamptz,valid_to timestamptz); CREATE TABLE public.member_permission_overrides(membership_id uuid,organization_id uuid,expires_at timestamptz,revoked_at timestamptz)");
  await f.db.exec(sql); await f.db.exec(sql);
  await f.db.exec(reselect); await f.db.exec(reselect);
  await f.db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[USER]);
  const browser = (operation, rest={},role='authenticated') => f.rpc('public.hermes_zalo_binding_v1',{ operation, organizationId:ORG,...rest },role);
  const binding = async () => (await f.db.query('SELECT * FROM app_private.hermes_zalo_bindings WHERE id=$1',[BINDING])).rows[0];
  return {...f,browser,binding};
}
test('forward SQL is idempotent; settings epoch preserves binding identity and admits a new legacy command',async t=>{
  const f=await setup(t), before=await f.binding();
  await f.db.exec("UPDATE app_private.hermes_connections SET epoch=epoch+1");
  const after=await f.binding();
  assert.equal(after.id,before.id);assert.equal(after.epoch,before.epoch);assert.equal(after.assistant_id,before.assistant_id);
  assert.equal(after.sender_uid,before.sender_uid);assert.equal(after.connection_epoch,2);assert.equal(after.state,'ACTIVE');
  assert.equal((await f.call()).status,'queued');
});
test('credential selection is explicit, owner-scoped and CAS; newer connections never replace it automatically',async t=>{
  const f=await setup(t), next=id('e');
  await f.db.query("INSERT INTO app_private.hermes_connections(id,assistant_id,organization_id,user_id,state,credential_ref,intent_digest,intent_expires_at,activation_operation_id) VALUES($1,$2,$3,$4,'ACTIVE',$5,repeat('d',64),clock_timestamp()+interval '1 hour',$1)",[next,ASSISTANT,ORG,USER,SESSION]);
  await f.db.query("INSERT INTO app_private.hermes_connection_tokens(token_digest,connection_id,expires_at) VALUES(repeat('e',64),$1,clock_timestamp()+interval '10 minutes')",[next]);
  assert.equal((await f.binding()).connection_id,CONNECTION);
  await assert.rejects(f.browser('selectCredential',{connectionId:next,expectedConnectionEpoch:1,expectedActiveConnectionId:FOREIGN}),e=>e.code==='PT409');
  await f.browser('selectCredential',{connectionId:next,expectedConnectionEpoch:1,expectedActiveConnectionId:CONNECTION});
  assert.equal((await f.binding()).connection_id,next);assert.equal((await f.binding()).epoch,1);
  await assert.rejects(f.browser('selectCredential',{connectionId:CONNECTION,expectedConnectionEpoch:1,expectedActiveConnectionId:CONNECTION}),e=>e.code==='PT409');
  await f.db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[FOREIGN]);
  await assert.rejects(f.browser('selectCredential',{connectionId:next,expectedConnectionEpoch:1,expectedActiveConnectionId:next}),e=>e.code==='42501');
});
test('15-minute code is enforced by the database and owned status survives a settings revision',async t=>{
  const f=await setup(t);
  await f.db.exec("CREATE SCHEMA extensions; CREATE FUNCTION extensions.gen_random_bytes(n integer) RETURNS bytea LANGUAGE sql AS $$SELECT decode(repeat('e',n*2),'hex')$$; CREATE FUNCTION extensions.digest(v text,algorithm text) RETURNS bytea LANGUAGE sql AS $$SELECT decode(repeat(md5(v),2),'hex')$$");
  const challenge=await f.browser('begin',{connectionId:CONNECTION,expectedConnectionEpoch:1,accountId:ACCOUNT});
  const row=(await f.db.query('SELECT *,extract(epoch FROM expires_at-created_at) AS lifetime FROM app_private.hermes_zalo_link_challenges WHERE id=$1',[challenge.challengeId])).rows[0];
  assert.equal(Number(row.lifetime),900);
  await f.db.exec('UPDATE app_private.hermes_connections SET epoch=epoch+1');
  assert.equal((await f.browser('status',{challengeId:challenge.challengeId})).status,'waiting');
  await assert.rejects(f.db.query("UPDATE app_private.hermes_zalo_link_challenges SET expires_at=created_at+interval '901 seconds' WHERE id=$1",[challenge.challengeId]),e=>e.code==='23514');
  await assert.rejects(f.rpc('public.hermes_zalo_binding_v1',{operation:'status',organizationId:FOREIGN,challengeId:challenge.challengeId},'authenticated'),e=>e.code==='42501');
});
test('only the trusted store can read provisioning; caller cannot read private pointer table',async t=>{
  const f=await setup(t);
  const snapshot=await f.rpc('app_private.hermes_zalo_provisioning_v1',{bindingId:BINDING});
  assert.equal(snapshot.assistantId,ASSISTANT);assert.equal(snapshot.connectionId,CONNECTION);assert.equal(snapshot.senderUid,'456');
  assert.equal(snapshot.status,'active');assert(!JSON.stringify(snapshot).includes('envelope'));assert.equal(Object.keys(snapshot).length,10);
  for(const role of ['anon','authenticated','service_role']) await assert.rejects(f.rpc('app_private.hermes_zalo_provisioning_v1',{bindingId:BINDING},role),e=>e.code==='42501');
  await f.browser('unlink',{bindingId:BINDING,expectedEpoch:1});
  assert.equal((await f.rpc('app_private.hermes_zalo_provisioning_v1',{bindingId:BINDING})).status,'revoked');
});

test('actual worker observation is required before the owner can pair the exact sender; copied codes and stale confirmation fail',async t=>{
  const f=await setup(t);
  await f.db.exec("CREATE SCHEMA extensions; CREATE FUNCTION extensions.gen_random_bytes(n integer) RETURNS bytea LANGUAGE sql AS $$SELECT decode(repeat('e',n*2),'hex')$$; CREATE FUNCTION extensions.digest(v text,algorithm text) RETURNS bytea LANGUAGE sql AS $$SELECT decode(repeat(md5(v),2),'hex')$$");
  await f.browser('unlink',{bindingId:BINDING,expectedEpoch:1});
  const challenge=await f.browser('begin',{connectionId:CONNECTION,expectedConnectionEpoch:1,accountId:ACCOUNT});
  const confirmation={challengeId:challenge.challengeId,expectedCandidateVersion:1,expectedSenderUid:'456'};
  await assert.rejects(f.browser('confirm',confirmation),e=>e.code==='PT409');
  await f.db.query(`INSERT INTO public.zalo_messages(id,account_id,organization_id,conversation_id,direction,msg_type,body,zalo_msg_id,zalo_raw,created_at) VALUES($1,$2,$3,$4,'in','text','[Hermes link - hidden]','observed-live','{\"uidFrom\":\"456\",\"idTo\":\"123\",\"msgType\":\"webchat\"}',clock_timestamp())`,[id('f'),ACCOUNT,ORG,CONVERSATION]);
  const digest=(await f.db.query('SELECT challenge_digest FROM app_private.hermes_zalo_link_challenges WHERE id=$1',[challenge.challengeId])).rows[0].challenge_digest;
  await f.rpc('public.hermes_zalo_ingress_v1',{operation:'observe',accountId:ACCOUNT,organizationId:ORG,instanceId:INSTANCE,
    generation:GENERATION,senderUid:'456',providerMessageId:'observed-live',challengeDigest:digest},'service_role');
  assert.equal((await f.browser('status',{challengeId:challenge.challengeId})).status,'observed');
  await assert.rejects(f.browser('confirm',{...confirmation,expectedSenderUid:'789'}),e=>e.code==='PT409');
  const linked=await f.browser('confirm',confirmation);
  assert.equal(linked.senderUid,'456');
  assert.equal((await f.db.query('SELECT assistant_id FROM app_private.hermes_zalo_bindings WHERE id=$1',[linked.bindingId])).rows[0].assistant_id,ASSISTANT);
  await assert.rejects(f.browser('confirm',confirmation),e=>e.code==='PT409');
  const queued=(await f.db.query('SELECT * FROM app_private.hermes_zalo_provisioning_queue WHERE assistant_id=$1 AND account_id=$2',[ASSISTANT,ACCOUNT])).rows[0];
  assert.equal(queued.binding_id,linked.bindingId);assert.equal(queued.state,'pending');
  const root=mkdtempSync(path.join(os.tmpdir(),'binding-reconcile-')),stateRoot=path.join(root,'state'),home=path.join(root,'alpha');
  mkdirSync(stateRoot,{mode:0o700});mkdirSync(home,{mode:0o700});
  writeFileSync(path.join(home,'config.yaml'),'model:\n  default: existing-private-model\nmcp_servers: {}\n',{mode:0o600});
  const cipher=createHandoffCipher({activeKeyVersion:'fixture',keys:new Map([['fixture',Buffer.alloc(32,7)]])});
  const rawToken='hc_'+'a'.repeat(43),record={connectionId:CONNECTION,assistantId:ASSISTANT,userId:USER,
    organizationId:ORG,operationId:CONNECTION,token:rawToken};
  const encrypted=cipher.seal(record);
  const calls=[];
  const transport={call:async(operation,input)=>{
    calls.push(operation);
    const functions={readZaloProvisioningWork:'app_private.hermes_zalo_provisioning_work_v1',
      acknowledgeZaloProvisioning:'app_private.hermes_zalo_provisioning_ack_v1',readZaloBinding:'app_private.hermes_zalo_provisioning_v1'};
    return f.rpc(functions[operation],input);
  }};
  let enrolled=true;
  const reconciler=createNativeBindingReconciler({configuration:{configFile:path.join(root,'native.json'),stateRoot,listenPort:8991,
    mcpUrl:'http://127.0.0.1:8740/mcp',profiles:[{assistantId:ASSISTANT,userId:USER,organizationId:ORG,accountId:ACCOUNT,profile:'alpha',home}]},
    transport,handoff:{list:async()=>enrolled?[cipher.open(encrypted)]:[]},
    backend:{resolveConnection:async(token)=>{assert.equal(token,rawToken);return {...record,expiresAt:Date.now()+600000};}}});
  try {
    enrolled=false;await reconciler.reconcile();
    assert.equal((await f.db.query('SELECT state FROM app_private.hermes_zalo_provisioning_queue')).rows[0].state,'pending_credential');
    enrolled=true;await reconciler.reconcile();
    const profile=yaml.load(readFileSync(path.join(home,'config.yaml'),'utf8'));
    assert.equal(profile.mcp_servers.crm.headers.Authorization,'Bearer '+rawToken);
    assert.equal(profile.platforms.zalo_personal.enabled,true);
    const native=readNativeConfig(path.join(root,'native.json')).channels[0];
    assert.equal(native.pairedUid,'456');
    assert.equal((await f.db.query('SELECT state FROM app_private.hermes_zalo_provisioning_queue')).rows[0].state,'restart_pending');
    const listed=await f.browser('list',{afterBindingId:null});
    assert.equal(listed.bindings.find(row=>row.bindingId===linked.bindingId).provisioningState,'restart_pending');
    const configBytes=readFileSync(path.join(root,'native.json'),'utf8'),profileBytes=readFileSync(path.join(home,'config.yaml'),'utf8');
    await reconciler.reconcile();
    assert.equal(readFileSync(path.join(root,'native.json'),'utf8'),configBytes);
    assert.equal(readFileSync(path.join(home,'config.yaml'),'utf8'),profileBytes);
    assert.equal(readNativeConfig(path.join(root,'native.json')).channels[0].generation,native.generation);
    assert(!JSON.stringify(reconciler.status()).includes(rawToken));assert(calls.includes('acknowledgeZaloProvisioning'));
    // A READY reply has not passed provider admission. Unlink must deny its
    // next dispatch even though the live native worker is awaiting restart.
    const sentAt=Number((await f.db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint n')).rows[0].n);
    await f.call({providerMessageId:'after-new-pair',sentAt});
    const command={tokenDigest:'b'.repeat(64),claimId:id('e')};
    await f.rpc('app_private.hermes_store_claim_private_command_v1',command);
    await f.rpc('app_private.hermes_store_dispatch_private_command_v1',command);
    await f.rpc('app_private.hermes_store_finish_private_command_v1',{...command,text:'Synthetic queued reply'});
    const source={accountId:ACCOUNT,organizationId:ORG,instanceId:INSTANCE,generation:GENERATION,accountOwnerId:USER,
      ownUid:'123',loginRequestedAt:null,deliveryId:id('d')};
    assert.equal((await f.rpc('public.hermes_zalo_private_reply_v1',{...source,operation:'claim'},'service_role')).status,'claimed');
    await f.browser('unlink',{bindingId:linked.bindingId,expectedEpoch:1});
    await assert.rejects(f.rpc('public.hermes_zalo_private_reply_v1',{...source,operation:'dispatch'},'service_role'),e=>e.code==='42501');
    enrolled=false;await reconciler.reconcile();
    const revokedProfile=yaml.load(readFileSync(path.join(home,'config.yaml'),'utf8'));
    assert.equal(revokedProfile.mcp_servers.crm,undefined);assert.equal(revokedProfile.platforms.zalo_personal.enabled,false);
    assert(!readFileSync(path.join(home,'.env'),'utf8').includes('HERMES_ZALO_BRIDGE_TOKEN'));
    assert.equal(readNativeConfig(path.join(root,'native.json')).channels[0].generation,native.generation);

  } finally {await reconciler.close();cipher.destroy();rmSync(root,{recursive:true});}
});

// --- 20261110072604: confirm re-selects the assistant credential while the assistant has no ACTIVE binding ---
// md5(prosrc) of the two reviewed bodies, as pinned by the forward file and by its revert.
const BODY_20261019='e1d3f75afa5e5d1a16d15fe7a7d0ab3b',BODY_RESELECT='f915a08d71d4a827588648955edfa001';
// Synthetic ids; each only has to be unique inside its own table.
const NEXT=id('e'),ACCOUNT_B=id('0'),CONVERSATION_B=id('a'),GENERATION_B=id('d');
const EXTENSIONS="CREATE SCHEMA extensions; CREATE FUNCTION extensions.gen_random_bytes(n integer) RETURNS bytea LANGUAGE sql AS $$SELECT decode(repeat('e',n*2),'hex')$$; CREATE FUNCTION extensions.digest(v text,algorithm text) RETURNS bytea LANGUAGE sql AS $$SELECT decode(repeat(md5(v),2),'hex')$$";
const selection=async f=>({...(await f.db.query('SELECT connection_id,revision::int AS revision,selected_by FROM app_private.hermes_zalo_active_credentials WHERE assistant_id=$1',[ASSISTANT])).rows[0]});
const bodyMd5=async f=>(await f.db.query("SELECT md5(replace(prosrc,chr(13),'')) AS md5 FROM pg_proc WHERE oid='public.hermes_zalo_binding_v1(jsonb)'::regprocedure")).rows[0].md5;
// A second ACTIVE CRM connection of the same assistant, as "Tạo kết nối" leaves it: it is not selected by being created.
async function addConnection(f,connection) {
  await f.db.query("INSERT INTO app_private.hermes_connections(id,assistant_id,organization_id,user_id,state,credential_ref,intent_digest,intent_expires_at,activation_operation_id) VALUES($1,$2,$3,$4,'ACTIVE',$5,repeat('d',64),clock_timestamp()+interval '1 hour',$1)",[connection,ASSISTANT,ORG,USER,SESSION]);
  await f.db.query("INSERT INTO app_private.hermes_connection_tokens(token_digest,connection_id,expires_at) VALUES(repeat('e',64),$1,clock_timestamp()+interval '10 minutes')",[connection]);
}
// begin, then the bot account's own worker observes the code from sender 456: the challenge is OBSERVED and ready for confirm.
// The fixed gen_random_bytes stub gives every code the same digest, so each test begins once.
async function observedChallenge(f,connection,{account=ACCOUNT,conversation=CONVERSATION,generation=GENERATION,ownUid='123'}={}) {
  const challenge=await f.browser('begin',{connectionId:connection,expectedConnectionEpoch:1,accountId:account});
  await f.db.query("INSERT INTO public.zalo_messages(id,account_id,organization_id,conversation_id,direction,msg_type,body,zalo_msg_id,zalo_raw,created_at) VALUES($1,$2,$3,$4,'in','text','[Hermes link - hidden]','observed-live',$5::jsonb,clock_timestamp())",
    [id('f'),account,ORG,conversation,JSON.stringify({uidFrom:'456',idTo:ownUid,msgType:'webchat'})]);
  const digest=(await f.db.query('SELECT challenge_digest FROM app_private.hermes_zalo_link_challenges WHERE id=$1',[challenge.challengeId])).rows[0].challenge_digest;
  await f.rpc('public.hermes_zalo_ingress_v1',{operation:'observe',accountId:account,organizationId:ORG,instanceId:INSTANCE,
    generation,senderUid:'456',providerMessageId:'observed-live',challengeDigest:digest},'service_role');
  return {challengeId:challenge.challengeId,expectedCandidateVersion:1,expectedSenderUid:'456'};
}
// The reported dead end: linked once, unlinked (the binding is REVOKED, the selection row stays), then a new CRM connection.
async function unlinkedWithNewConnection(f,{revokeEarlier}) {
  await f.db.exec(EXTENSIONS);
  await f.browser('unlink',{bindingId:BINDING,expectedEpoch:1});
  // The row change of hermes_store_revoke_connection_v1 (20261019034754, which this fixture does not load).
  if(revokeEarlier) await f.db.query("UPDATE app_private.hermes_connections SET state='REVOKED',epoch=epoch+1,revoked_at=clock_timestamp() WHERE id=$1",[CONNECTION]);
  await addConnection(f,NEXT);
  assert.deepEqual(await selection(f),{connection_id:CONNECTION,revision:1,selected_by:USER},'unlink and revoke leave the earlier selection behind');
  return observedChallenge(f,NEXT);
}
// The assistant keeps its ACTIVE binding on the first bot account; the code is for a second bot account of the same company, so
// a refused confirm can only be the credential rule (the one-binding-per-account unique indexes are not in play).
async function activeBindingAndOtherConnection(t,prepare=async()=>{}) {
  const f=await setup(t);
  await f.db.exec(EXTENSIONS);
  await addConnection(f,NEXT);
  await prepare(f);
  await f.db.query("INSERT INTO public.zalo_accounts VALUES($1,$2,$3,'personal','connected','Synthetic bot B','124',null)",[ACCOUNT_B,ORG,USER]);
  await f.db.query("INSERT INTO public.zalo_conversations VALUES($1,$2,$3,'user','456','456',null,0)",[CONVERSATION_B,ACCOUNT_B,ORG]);
  await f.db.query('INSERT INTO app_private.hermes_zalo_bots(account_id,organization_id,enabled,updated_by) VALUES($1,$2,true,$3)',[ACCOUNT_B,ORG,USER]);
  await f.db.query("INSERT INTO app_private.hermes_zalo_ingress_sessions(account_id,organization_id,account_owner_id,instance_id,generation,own_uid,registered_at) VALUES($1,$2,$3,$4,$5,'124',clock_timestamp()-interval '1 minute')",
    [ACCOUNT_B,ORG,USER,INSTANCE,GENERATION_B]);
  return {f,confirmation:await observedChallenge(f,NEXT,{account:ACCOUNT_B,conversation:CONVERSATION_B,generation:GENERATION_B,ownUid:'124'})};
}

test('confirm re-selects the credential when the assistant has no ACTIVE binding and the earlier selected connection was revoked',async t=>{
  const f=await setup(t);
  await f.db.exec("CREATE TABLE app_private.fixture_audit(seq integer GENERATED ALWAYS AS IDENTITY,reason text); CREATE OR REPLACE FUNCTION app_private.append_authz_audit_v1(o uuid,event text,kind text,entity uuid,prev jsonb,next jsonb,reason text) RETURNS void LANGUAGE sql AS $$INSERT INTO app_private.fixture_audit(reason) VALUES($7)$$");
  const linked=await f.browser('confirm',await unlinkedWithNewConnection(f,{revokeEarlier:true}));
  // binding-service.mjs and zaloBindingClient.ts validate this shape strictly: no field was added.
  assert.deepEqual(Object.keys(linked).sort(),['accountId','bindingId','connectionId','epoch','organizationId','provisioningState','senderUid','status','userId']);
  assert.equal(linked.status,'active');assert.equal(linked.connectionId,NEXT);assert.equal(linked.accountId,ACCOUNT);
  assert.deepEqual(await selection(f),{connection_id:NEXT,revision:2,selected_by:USER});
  const created=(await f.db.query('SELECT state,connection_id,connection_epoch::int AS connection_epoch,sender_uid FROM app_private.hermes_zalo_bindings WHERE id=$1',[linked.bindingId])).rows[0];
  assert.deepEqual({...created},{state:'ACTIVE',connection_id:NEXT,connection_epoch:1,sender_uid:'456'});
  const earlier=await f.binding();
  assert.equal(earlier.state,'REVOKED');assert.equal(earlier.connection_id,CONNECTION,'the unlinked binding keeps its history');
  const snapshot=await f.rpc('app_private.hermes_zalo_provisioning_v1',{bindingId:linked.bindingId});
  assert.equal(snapshot.status,'active');assert.equal(snapshot.connectionId,NEXT);
  assert.deepEqual((await f.db.query('SELECT reason FROM app_private.fixture_audit ORDER BY seq')).rows.map(row=>row.reason),
    ['Explicit CRM user action: unlink','Explicit CRM user action: begin',`Explicit CRM user action: confirm (credential reselected from ${CONNECTION})`]);
});
test('confirm re-selects the credential when the assistant has no ACTIVE binding and the earlier selected connection is still ACTIVE',async t=>{
  const f=await setup(t);
  const linked=await f.browser('confirm',await unlinkedWithNewConnection(f,{revokeEarlier:false}));
  assert.equal(linked.connectionId,NEXT);
  assert.deepEqual(await selection(f),{connection_id:NEXT,revision:2,selected_by:USER});
  const created=(await f.db.query('SELECT state,connection_id FROM app_private.hermes_zalo_bindings WHERE id=$1',[linked.bindingId])).rows[0];
  assert.deepEqual({...created},{state:'ACTIVE',connection_id:NEXT});
  const earlier=(await f.db.query('SELECT state,epoch::int AS epoch FROM app_private.hermes_connections WHERE id=$1',[CONNECTION])).rows[0];
  assert.deepEqual({...earlier},{state:'ACTIVE',epoch:1},'the earlier connection itself is untouched');
  // With an ACTIVE binding again, the selection changes only through the explicit CAS.
  await f.browser('selectCredential',{connectionId:CONNECTION,expectedConnectionEpoch:1,expectedActiveConnectionId:NEXT});
  assert.deepEqual(await selection(f),{connection_id:CONNECTION,revision:3,selected_by:USER});
  assert.equal((await f.db.query('SELECT connection_id FROM app_private.hermes_zalo_bindings WHERE id=$1',[linked.bindingId])).rows[0].connection_id,CONNECTION);
});
test('confirm still refuses with PT409 and keeps the selection when the assistant has an ACTIVE binding on another connection',async t=>{
  const {f,confirmation}=await activeBindingAndOtherConnection(t);
  await assert.rejects(f.browser('confirm',confirmation),e=>e.code==='PT409'&&/hermes_zalo_context_changed/.test(e.message));
  assert.deepEqual(await selection(f),{connection_id:CONNECTION,revision:1,selected_by:USER});
  const kept=await f.binding();
  assert.equal(kept.state,'ACTIVE');assert.equal(kept.connection_id,CONNECTION);
  assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM app_private.hermes_zalo_bindings')).rows[0].n),1);
  assert.equal((await f.browser('status',{challengeId:confirmation.challengeId})).status,'observed');
  // Positive control: the refusal was the credential rule. After the explicit CAS the very same confirmation pairs.
  await f.browser('selectCredential',{connectionId:NEXT,expectedConnectionEpoch:1,expectedActiveConnectionId:CONNECTION});
  const linked=await f.browser('confirm',confirmation);
  assert.equal(linked.accountId,ACCOUNT_B);assert.equal(linked.connectionId,NEXT);
  assert.deepEqual(await selection(f),{connection_id:NEXT,revision:2,selected_by:USER},'confirm on the already selected connection does not bump the revision');
});
test('mutation: without the no-ACTIVE-binding condition the same confirm silently re-points a live binding to another credential',async t=>{
  const guard="AND NOT EXISTS(SELECT 1 FROM app_private.hermes_zalo_bindings z WHERE z.assistant_id=c.assistant_id AND z.state='ACTIVE')";
  const {f,confirmation}=await activeBindingAndOtherConnection(t,async f=>{
    const source=(await f.db.query("SELECT pg_get_functiondef('public.hermes_zalo_binding_v1(jsonb)'::regprocedure) AS source")).rows[0].source;
    assert.equal(source.split(guard).length,2,'the condition is one exact clause of the confirm branch');
    await f.db.exec(source.replace(guard,''));
  });
  const linked=await f.browser('confirm',confirmation);
  assert.equal(linked.connectionId,NEXT,'the mutant accepts what the reviewed body refuses');
  assert.equal((await selection(f)).connection_id,NEXT);
  assert.equal((await f.binding()).connection_id,NEXT,'the live binding of the first bot account moved without selectCredential');
});
test('the confirm re-selection migration is idempotent, keeps the caller ACL, and both files refuse an unreviewed body',async t=>{
  const f=await setup(t);
  assert.equal(await bodyMd5(f),BODY_RESELECT);
  await f.db.exec(reselect);
  assert.equal(await bodyMd5(f),BODY_RESELECT);
  const acl=(await f.db.query("SELECT r.rolname,has_function_privilege(r.oid,'public.hermes_zalo_binding_v1(jsonb)'::regprocedure,'EXECUTE') AS allowed FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role','hermes_store_executor') ORDER BY r.rolname")).rows;
  assert.deepEqual(acl.map(row=>[row.rolname,row.allowed]),[['anon',false],['authenticated',true],['hermes_store_executor',false],['service_role',false]]);
  await f.db.exec("CREATE OR REPLACE FUNCTION public.hermes_zalo_binding_v1(p jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$BEGIN RETURN p; END$$");
  const unreviewed=await bodyMd5(f);
  for(const file of [reselect,reselectRevert]) {
    await assert.rejects(f.db.exec(file),/body_drift/);
    await f.db.exec('ROLLBACK');
    assert.equal(await bodyMd5(f),unreviewed);
  }
});
test('the revert restores the 20261019034850 body (the dead end returns) and the forward file re-applies on top of it',async t=>{
  const f=await setup(t);
  await f.db.exec(reselectRevert);await f.db.exec(reselectRevert);
  assert.equal(await bodyMd5(f),BODY_20261019);
  const confirmation=await unlinkedWithNewConnection(f,{revokeEarlier:true});
  await assert.rejects(f.browser('confirm',confirmation),e=>e.code==='PT409'&&/hermes_zalo_context_changed/.test(e.message));
  assert.deepEqual(await selection(f),{connection_id:CONNECTION,revision:1,selected_by:USER});
  await f.db.exec(reselect);
  assert.equal(await bodyMd5(f),BODY_RESELECT);
  assert.equal((await f.browser('confirm',confirmation)).connectionId,NEXT);
  assert.deepEqual(await selection(f),{connection_id:NEXT,revision:2,selected_by:USER});
});
