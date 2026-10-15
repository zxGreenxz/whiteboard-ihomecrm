import test from 'node:test';
import assert from 'node:assert/strict';
import {setupGroupSendSql} from './group-send-sql-fixture.mjs';
import {USER,INSTANCE,FOREIGN} from './private-command-fixture.mjs';
const rejects=(work,code)=>assert.rejects(work,error=>error.code===code);

test('Hermes uses current user authority and queue origin without Copilot approval',async t=>{
  const x=await setupGroupSendSql(t),{f}=x;
  await t.test('Copilot disabled still enqueues exact server body with distinct actor/account owner; command retry dedups',async()=>{
    await f.rollbackCase(async()=>{
      const p=await x.request(), first=await x.send(p);
      assert.deepEqual(Object.keys(first).sort(),['authority','decision','dispatch','recipientRead','roomPayload']);
      assert.equal(first.dispatch.id,p.requestId); assert.equal(first.dispatch.recipients[0].status,'queued');
      const row=(await f.db.query('SELECT q.user_id,m.sent_by,q.payload,h.body FROM public.zalo_send_queue q JOIN public.zalo_messages m ON m.id=q.message_id JOIN app_private.hermes_group_dispatches h ON h.id=q.hermes_group_dispatch_id')).rows[0];
      assert.equal(row.user_id,FOREIGN);assert.equal(row.sent_by,USER);assert.equal(row.payload.body,row.body);
      assert.match(row.body,/5\.000\.000 đ\/tháng/);assert(!JSON.stringify(first).includes('consent_nonce'));
      assert.deepEqual((await x.send({...p,requestId:'45678901-1234-4567-8123-123456789abc'})).dispatch,first.dispatch);
      await rejects(x.send({...p,intentDigest:'e'.repeat(64)}),'PT409');
      assert.equal((await f.db.query('SELECT count(*)::int n FROM public.zalo_send_queue')).rows[0].n,1);
      await f.db.exec('SET CONSTRAINTS ALL IMMEDIATE');
    });
  });
  await t.test('READY command can deliver once through dedicated provider path; generic admission cannot bypass origin',async()=>{
    await f.rollbackCase(async()=>{
      const ack=await x.send(await x.request()),job=ack.dispatch.recipients[0].jobId;
      await f.rpc('app_private.hermes_store_finish_private_command_v1',{tokenDigest:x.baseline.tokenDigest,claimId:x.CLAIM,text:'queued'});
      await f.db.query("UPDATE public.zalo_send_queue SET status='processing',processing_instance_id=$1 WHERE id=$2",[INSTANCE,job]);
      assert.equal(await x.provider(job,{},true),false);
      assert.equal(await x.provider(job,{body:'tampered'}),false);
      assert.equal(await x.provider(job,{threadId:'other'}),false);
      assert.equal(await x.provider(job,{generation:'45678901-1234-4567-8123-123456789abc'}),false);
      assert.equal(await x.provider(job),true);
      assert.equal(await x.provider(job),false);
    });
  });
  for(const [name,change] of [
    ['send right revoked',"UPDATE public.fixture_authority SET send_zalo=false"],
    ['membership revoked',"UPDATE public.organization_memberships SET status='REVOKED'"],
    ['connection action removed',"UPDATE app_private.hermes_connections SET action_capabilities='{}'"],
    ['scope removed',"UPDATE app_private.hermes_connections SET scope_ids='{}'"],
    ['sender login changed',"UPDATE public.zalo_accounts SET login_requested_at=clock_timestamp()"],
    ['room price changed',"UPDATE public.rooms SET rent_price=1"],
  ]) await t.test(`provider rejects ${name}`,async()=>{
    await f.rollbackCase(async()=>{
      const ack=await x.send(await x.request()),job=ack.dispatch.recipients[0].jobId;
      await f.db.query("UPDATE public.zalo_send_queue SET status='processing',processing_instance_id=$1 WHERE id=$2",[INSTANCE,job]);
      await f.db.exec(change);
      await assert.rejects(x.provider(job));
      assert.equal((await f.db.query('SELECT provider_started_at FROM public.zalo_send_queue WHERE id=$1',[job])).rows[0].provider_started_at,null);
    });
  });
  await t.test('payload/origin edits are denied; unknown status wins over failed and is read-only',async()=>{
    await f.rollbackCase(async()=>{
      const ack=await x.send(await x.request()),job=ack.dispatch.recipients[0].jobId;
      // The existing private-channel guard rejects changing a bot group's
      // thread identity before it can reach the provider snapshot fence.
      for(const statement of ["UPDATE public.zalo_send_queue SET payload='{}'",'DELETE FROM app_private.hermes_group_jobs',"UPDATE app_private.hermes_group_dispatches SET body='changed'", "UPDATE public.zalo_conversations SET thread_id='988' WHERE thread_type='group'"]){
        await f.db.exec('SAVEPOINT edit');await rejects(f.db.exec(statement),'42501');await f.db.exec('ROLLBACK TO SAVEPOINT edit; RELEASE SAVEPOINT edit');
      }
      await f.db.query(`UPDATE public.zalo_send_queue SET status='failed',result='{"outcome":"unknown","requires_reconciliation":true}' WHERE id=$1`,[job]);
      const out=await x.status(ack.dispatch.id);assert.equal(out.recipients[0].status,'unknown');
      assert.equal((await f.db.query('SELECT count(*)::int n FROM public.zalo_send_queue')).rows[0].n,1);
      await f.db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[FOREIGN]);
      await rejects(x.status(ack.dispatch.id),'P0002');
    });
  });
  await t.test('public RPC/helper ACLs remain narrow and all locking public entries are volatile',async()=>{
    for(const [name,allowed] of [['public.hermes_group_send_v1(jsonb)','authenticated'],['public.hermes_group_send_status_v1(uuid)','authenticated'],['public.zalo_worker_begin_hermes_group_provider_v1(uuid,uuid,jsonb)','service_role']]){
      for(const role of ['anon','authenticated','service_role','hermes_store_executor'])assert.equal((await f.db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') ok',[role,name])).rows[0].ok,role===allowed);
      assert.equal((await f.db.query('SELECT provolatile FROM pg_proc WHERE oid=$1::regprocedure',[name])).rows[0].provolatile,'v');
    }
    assert.equal((await f.db.query("SELECT has_function_privilege('service_role','app_private.hermes_group_current_v1(jsonb)','EXECUTE') ok")).rows[0].ok,false);
  });
});
