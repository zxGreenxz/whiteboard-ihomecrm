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
async function setup(t) {
  const f = await fixture(t, { migrations: ['20261013084000_hermes_private_command_dispatch_v1','20261013095000_hermes_zalo_private_reply_v1'] });
  await f.db.exec("CREATE FUNCTION app_private.is_actor_offboarded_v1() RETURNS boolean LANGUAGE sql AS $$SELECT false$$; CREATE FUNCTION app_private.append_authz_audit_v1(o uuid,event text,kind text,entity uuid,prev jsonb,next jsonb,reason text) RETURNS void LANGUAGE plpgsql AS $$BEGIN RETURN; END$$");
  await f.db.exec("ALTER TABLE app_private.hermes_connections ADD COLUMN permission_mode text NOT NULL DEFAULT 'legacy_snapshot'");
  const optional=readFileSync(new URL('../../supabase/migrations/20261014000503_hermes_optional_org_policy_v1.sql',import.meta.url),'utf8');
  const start=optional.indexOf('CREATE OR REPLACE FUNCTION app_private.hermes_effective_org_policy_v1');
  await f.db.exec(optional.slice(start,optional.indexOf('END $fn$;',start)+'END $fn$;'.length));
  await f.db.exec("CREATE TABLE public.role_bindings(membership_id uuid,organization_id uuid,valid_from timestamptz,valid_to timestamptz); CREATE TABLE public.member_permission_overrides(membership_id uuid,organization_id uuid,expires_at timestamptz,revoked_at timestamptz)");
  await f.db.exec(sql); await f.db.exec(sql);
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
