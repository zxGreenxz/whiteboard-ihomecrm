import test from 'node:test';
import assert from 'node:assert/strict';
import {createBroker} from './broker.mjs';
import {createGroupPreviewMount} from './group-preview-mount.mjs';
import {createDurableAuthority} from './durable-authority.mjs';
import {createRoomReadService,createSupabaseRoomReads} from './room-read-service.mjs';
import {setupMount,token} from './group-preview-fixture.mjs';
import {installGroupSendSql} from '../hermes-zalo-router/group-send-sql-fixture.mjs';
import {USER,SESSION,FOREIGN} from '../hermes-zalo-router/private-command-fixture.mjs';

// Real mount/broker/transports and canonical send/status SQL in one PGlite.
// The encrypted connection store is real. HTTPS IO, Auth verification and CRM
// authority/sale-fact ports remain explicit synthetic boundaries, not JWT,
// PostgREST, provider delivery or concurrent PostgreSQL integration evidence.
test('group send composes the real broker with canonical SQL queue and status', {timeout:60000},async t=>{
  const hooks={},f=await setupMount(t,hooks);
  await installGroupSendSql(f);
  let beforeWrite,loseReply=false,sendCalls=0,statusCalls=0,observedId;
  const specs={
    hermes_group_send_v1:{keys:['p'],sql:'SELECT public.hermes_group_send_v1($1::jsonb) result'},
    hermes_group_send_status_v1:{keys:['p_dispatch_id'],sql:'SELECT public.hermes_group_send_status_v1($1::uuid) result'},
  };
  hooks.beforeFetch=async(url,options)=>{
    const u=new URL(url),name=u.pathname.slice('/rest/v1/rpc/'.length),spec=specs[name];
    if(!spec)return;
    assert.equal(u.origin,'https://example.invalid');assert.equal(u.pathname,'/rest/v1/rpc/'+name);
    assert.equal(options.redirect,'error');assert.equal(options.method,'POST');
    assert.equal(options.headers.apikey,'sb_publishable_test');
    assert(options.headers.authorization.startsWith('Bearer '));
    await f.baseAuth.verifySession({accessToken:options.headers.authorization.slice(7)});
    const args=JSON.parse(options.body);assert.deepEqual(Object.keys(args).sort(),spec.keys);
    if(name==='hermes_group_send_v1'){
      sendCalls++;assert.equal(Object.keys(args.p).length,15);
      assert(!Object.hasOwn(args.p,'body'));assert(!Object.hasOwn(args.p,'publicFacts'));
      assert.equal(args.p.requestId,observedId);
      if(beforeWrite)await beforeWrite();
    }else statusCalls++;
    f.events.push(name);
    await f.f.db.exec('SAVEPOINT send_http; SET LOCAL ROLE authenticated');
    let result;
    try{
      await f.f.db.query("SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.session',$2,true)",[USER,SESSION]);
      result=(await f.f.db.query(spec.sql,spec.keys.map(key=>key==='p'?JSON.stringify(args[key]):args[key]))).rows[0].result;
      await f.f.db.exec('RESET ROLE; RELEASE SAVEPOINT send_http');
    }catch(error){
      await f.f.db.exec('ROLLBACK TO SAVEPOINT send_http; RELEASE SAVEPOINT send_http; RESET ROLE');
      return Response.json({code:error.code,message:error.message,details:null,hint:null},{status:error.code==='42501'?403:error.code==='PT409'?409:400});
    }
    // Fail after the real SQL response exists: the write may have succeeded.
    if(name==='hermes_group_send_v1'&&loseReply)throw new TypeError('synthetic lost response after SQL');
    return Response.json(result);
  };
  const authority=createDurableAuthority({auth:f.baseAuth,connectionStore:f.connectionStore,crypto:f.crypto});
  const roomReads=createRoomReadService({authority,connectionStore:f.connectionStore,crypto:f.crypto,auth:f.baseAuth,reads:createSupabaseRoomReads(f.config)});
  const mount=createGroupPreviewMount({baseAuth:f.baseAuth,connectionStore:f.connectionStore,crypto:f.crypto,
    supabase:{url:f.config.url,publishableKey:f.config.publishableKey},dependencyScope:f.scope,fetch:f.config.fetch});
  const create=()=>createBroker({authority,roomReads,groupPreviews:mount,dependencyScope:f.scope,
    audit:async event=>f.events.push('audit:'+event.outcome),limits:{maxResultBytes:65536}});
  const context={commandId:f.baseline.commandId,claimId:f.CLAIM};
  const options=()=>({signal:new AbortController().signal,onDispatch:id=>{observedId=id;}});
  const each=work=>f.f.rollbackCase(async()=>{
    beforeWrite=undefined;loseReply=false;sendCalls=0;statusCalls=0;observedId=undefined;
    await f.reset();await work();
  });
  const queueRows=()=>f.f.db.query('SELECT q.id,q.user_id,q.payload,q.hermes_group_dispatch_id,m.sent_by,m.body FROM public.zalo_send_queue q JOIN public.zalo_messages m ON m.id=q.message_id');
  await t.test('real SQL ACK queues a server-rendered body and status reads that same dispatch',()=>each(async()=>{
    const broker=create(),result=await broker.sendGroupRooms(token,context,f.selection,options());
    assert.equal(result.status,'queued');assert.equal(result.dispatchId,observedId);
    assert.deepEqual(result.recipients,[{conversationId:f.GROUP,name:'Synthetic group',status:'queued'}]);
    const rows=(await queueRows()).rows;assert.equal(rows.length,1);
    assert.equal(rows[0].hermes_group_dispatch_id,result.dispatchId);
    assert.equal(rows[0].user_id,FOREIGN);assert.equal(rows[0].sent_by,USER);
    assert.equal(rows[0].payload.body,rows[0].body);assert.match(rows[0].body,/5\.000\.000 đ\/tháng/);
    assert(f.events.indexOf('audit:prepared')<f.events.indexOf('hermes_group_send_v1'));
    const status=await broker.groupSendStatus(token,context,result.dispatchId,options());
    assert.equal(status.status,'dispatch_status');assert.equal(status.dispatchId,result.dispatchId);
    assert.deepEqual(status.recipients,result.recipients);assert.equal(statusCalls,1);assert.equal(sendCalls,1);
    for(const secret of [token,f.CLAIM,f.baseline.commandId,rows[0].id,'SYNTHETIC_PRIVATE_REFRESH'])
      assert(!JSON.stringify([result,status]).includes(secret));
    await f.f.db.exec('SET CONSTRAINTS ALL IMMEDIATE');
  }));
  await t.test('revocation immediately before real SQL write denies with zero queue and provenance rows',()=>each(async()=>{
    beforeWrite=()=>f.f.db.exec('UPDATE public.fixture_authority SET send_zalo=false');
    let rejected=0;
    await assert.rejects(create().sendGroupRooms(token,context,f.selection,{...options(),onRejected(){rejected++;}}),error=>error.code==='context_changed');
    assert.equal(sendCalls,1);assert.equal(rejected,1);assert.equal((await queueRows()).rows.length,0);
    assert.equal((await f.f.db.query('SELECT count(*)::int n FROM app_private.hermes_group_dispatches')).rows[0].n,0);
    assert.equal((await f.f.db.query('SELECT count(*)::int n FROM app_private.hermes_group_jobs')).rows[0].n,0);
  }));
  await t.test('lost real SQL reply stays unknown; status recovers the known ID without another write',()=>each(async()=>{
    loseReply=true;const broker=create();let rejected=0;
    await assert.rejects(broker.sendGroupRooms(token,context,f.selection,{...options(),onRejected(){rejected++;}}),error=>error.code==='send_outcome_unknown'&&error.dispatchId===observedId);
    const rows=(await queueRows()).rows;assert.equal(rows.length,1);assert.equal(rejected,0);
    assert.equal(rows[0].hermes_group_dispatch_id,observedId);assert.equal(sendCalls,1);
    const status=await broker.groupSendStatus(token,context,observedId,options());
    assert.equal(status.dispatchId,rows[0].hermes_group_dispatch_id);assert.equal(status.recipients[0].status,'queued');
    assert.equal(statusCalls,1);assert.equal(sendCalls,1);assert.equal((await queueRows()).rows.length,1);
  }));
});
