import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, ORG, USER, ACCOUNT, ASSISTANT, CONNECTION, BINDING, FOREIGN } from './private-command-fixture.mjs';

const rejects = (work,code) => assert.rejects(work, error => error.code===code);

test('durable private intake derives actor, enforces authority, and deduplicates without shared writes', async t => {
  const {db,call,request,rollbackCase}=await fixture(t);
  let accepted;
  await t.test('persists one private command and returns only a scoped receipt',async()=>{
    accepted=await call();
    assert.deepEqual(accepted,{status:'queued',commandId:accepted.commandId,accountId:ACCOUNT,organizationId:ORG,providerMessageId:'live-1'});
    const row=(await db.query('SELECT * FROM app_private.hermes_zalo_private_commands')).rows[0];
    assert.equal(row.user_id,USER); assert.equal(row.assistant_id,ASSISTANT); assert.equal(row.connection_id,CONNECTION);
    assert.equal(row.binding_id,BINDING); assert.equal(row.body,request.text); assert.equal(row.state,'QUEUED');
    assert(!JSON.stringify(accepted).includes('PRIVATE'));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.zalo_messages')).rows[0].n,1);
    assert.equal((await db.query('SELECT last_message_text FROM public.zalo_conversations')).rows[0].last_message_text,null);
  });
  await t.test('same provider ID and payload return the same row; different payload is rejected',async()=>{
    assert.deepEqual(await call(),{...accepted,status:'duplicate'});
    for(const change of [{text:'different'},{sentAt:request.sentAt+1}]) await rejects(call(change),'PT409');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM app_private.hermes_zalo_private_commands')).rows[0].n,1);
  });
  await t.test('reconnecting cannot create a second command with the same ID',async()=>{
    await rollbackCase(async()=>{
      await db.query('UPDATE app_private.hermes_zalo_ingress_sessions SET generation=$1',[FOREIGN]);
      await rejects(call(),'PT409');
      assert.deepEqual(await call({generation:FOREIGN}),{...accepted,status:'duplicate'});
    });
  });
  for(const role of ['anon','authenticated','hermes_store_executor']) await t.test(`${role} cannot execute the trusted intake`,()=>rejects(call({},role),'42501'));
  for(const role of ['anon','authenticated','service_role','hermes_store_executor']) await t.test(`${role} has no direct read/write access`,async()=>{
    for(const statement of ['SELECT * FROM app_private.hermes_zalo_private_commands',"UPDATE app_private.hermes_zalo_private_commands SET body='leaked'"]){
      await db.exec(`SET ROLE ${role}`);
      try { await rejects(db.query(statement),'42501'); } finally { await db.exec('RESET ROLE'); }
    }
  });
  for(const [label,change,code] of [
    ['foreign company',{organizationId:FOREIGN},'42501'],['foreign account',{accountId:FOREIGN},'42501'],
    ['unbound sender',{senderUid:'987'},'42501'],['self sender',{senderUid:'123'},'42501'],
    ['forged user',{userId:USER},'22023'],['forged connection',{connectionId:CONNECTION},'22023'],
    ['generation',{generation:FOREIGN},'PT409'],['instance',{instanceId:FOREIGN},'42501'],
    ['old provider timestamp',{sentAt:request.sentAt-301000},'PT409'],['future timestamp',{sentAt:request.sentAt+60000},'PT409'],
    ['pre-attachment timestamp',{sentAt:request.sentAt-120000},'PT409'],['string timestamp',{sentAt:String(request.sentAt)},'22023'],
    ['pre-binding timestamp',{sentAt:request.sentAt-30000},'PT409'],
    ['oversize UTF8',{text:'ễ'.repeat(3000)},'22023'],['empty text',{text:''},'22023'],['handshake text',{text:'/hermes-link hz_'+'a'.repeat(64)},'22023'],
  ]) await t.test(`rejects ${label}`,()=>rejects(call({providerMessageId:`rejected-${label.replaceAll(' ','-')}`,...change}),code));
  for(const [label,statement,code] of [
    ['membership revoked',"UPDATE public.organization_memberships SET status='REVOKED'",'42501'],
    ['ambiguous ordinary user',`INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES('${FOREIGN}','${USER}','${FOREIGN}','ACTIVE')`,'42501'],
    ['company disabled',"UPDATE public.organizations SET status='INACTIVE'",'42501'],
    ['policy disabled','UPDATE app_private.hermes_org_policies SET enabled=false','42501'],
    ['assistant disabled',"UPDATE app_private.hermes_assistants SET state='DISABLED'",'42501'],
    ['expired credential',"UPDATE app_private.hermes_sessions SET expires_at=clock_timestamp()-interval '1 second'",'PT409'],
    ['connection narrowed','UPDATE app_private.hermes_connections SET epoch=epoch+1','PT409'],
    ['token revoked','UPDATE app_private.hermes_connection_tokens SET revoked_at=clock_timestamp()','42501'],
    ['bot disabled','UPDATE app_private.hermes_zalo_bots SET enabled=false','PT409'],
    ['bot version changed','UPDATE app_private.hermes_zalo_bots SET version=version+1','PT409'],
    ['binding revoked',"UPDATE app_private.hermes_zalo_bindings SET state='REVOKED'",'42501'],
    ['expired worker lease',"UPDATE public.zalo_worker_lease SET heartbeat_at=clock_timestamp()-interval '1 minute'",'42501'],
    ['provider logged out',"UPDATE public.zalo_accounts SET status='disconnected'",'42501'],
    ['provider identity changed',"UPDATE public.zalo_accounts SET zalo_uid='999'",'PT409'],
    ['login snapshot changed','UPDATE public.zalo_accounts SET login_requested_at=clock_timestamp()','PT409'],
  ]) await t.test(`rechecks ${label} even for duplicate input`,async()=>{
    await rollbackCase(async()=>{ await db.exec(statement); await rejects(call(),code); });
  });
  await t.test('capacity blocks new commands but allows exact duplicate reconciliation',async()=>{
    for(let n=2;n<=64;n++) assert.equal((await call({providerMessageId:`live-${n}`})).status,'queued');
    await rejects(call({providerMessageId:'live-65'}),'PT429');
    assert.deepEqual(await call(),{...accepted,status:'duplicate'});
    assert.equal((await db.query('SELECT count(*)::int AS n FROM app_private.hermes_zalo_private_commands')).rows[0].n,64);
  });
});
