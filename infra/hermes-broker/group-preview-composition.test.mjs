import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHostAudit} from '../hermes-runtime/host-ownership.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {mkdir,mkdtemp,realpath,rm} from 'node:fs/promises';
import {createBroker} from './broker.mjs';
import {createGroupPreviewMount, GROUP_PREVIEW_TOOL, groupPreviewIntent} from './group-preview-mount.mjs';
import {createDurableAuthority} from './durable-authority.mjs';
import {createRoomReadService,createSupabaseRoomReads} from './room-read-service.mjs';
import {createRuntimeGateway} from '../hermes-runtime/runtime-gateway.mjs';
import {createConnectionSupervisor} from '../hermes-runtime/connection-supervisor.mjs';
import {ProfileLeaseStore} from '../hermes-runtime/profile-lease.mjs';
import {createPrivateCommandRunner} from './private-command-runner.mjs';
import {createPrivateCommandStore} from './private-command-store.mjs';
import {setupMount, token} from './group-preview-fixture.mjs';
import {installSaleListingSql,PREVIEW_CHAIN} from './sale-listing-sql-fixture.mjs';
const signal=()=>new AbortController().signal;
const code=c=>e=>e.code===c;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});void promise.catch(()=>{});return{promise,resolve,reject};};
const tick=()=>new Promise(done=>setImmediate(done));
const pending=async p=>{let done=false;void p.then(()=>done=true,()=>done=true);await tick();assert.equal(done,false);};
// Supabase's clock may run ahead of (or behind) the connector host. Instants issued by SQL
// get the shared 5 s allowance on upper bounds and on the decision ordering lower bound:
// 50 ms and 4 s pass, 6 s fails. Expiry and staleness stay strict.
const AHEAD=[[50,true],[4000,true],[6000,false]];
const later=(iso,ms)=>new Date(Date.parse(iso)+ms).toISOString();

test('private group preview composes real broker, durable core, transports and canonical SQL; IO/Auth/CRM synthetic', {timeout:60000}, async t=>{
  const hooks={},f=await setupMount(t,hooks);await installSaleListingSql(f,{chain:PREVIEW_CHAIN});
  const authority=createDurableAuthority({auth:f.baseAuth,connectionStore:f.connectionStore,crypto:f.crypto});
  const roomReads=createRoomReadService({authority,connectionStore:f.connectionStore,crypto:f.crypto,auth:f.baseAuth,reads:createSupabaseRoomReads(f.config)});
  const mount=createGroupPreviewMount({baseAuth:f.baseAuth,connectionStore:f.connectionStore,crypto:f.crypto,
    supabase:{url:f.config.url,publishableKey:f.config.publishableKey},dependencyScope:f.scope,fetch:f.config.fetch});
  let auditHook;
  const create=(limits={})=>createBroker({authority,roomReads,groupPreviews:mount,dependencyScope:f.scope,
    audit:async event=>{f.events.push('audit:'+event.outcome);if(auditHook)await auditHook(event);},limits:{maxResultBytes:65536,...limits}});
  const context={commandId:f.baseline.commandId,claimId:f.CLAIM};
  const each=work=>f.f.rollbackCase(async()=>{hooks.beforeFetch=undefined;auditHook=undefined;await f.reset();await work();});
  await t.test('candidate schema accepts IDs only and snapshots before admission',()=>{
    assert.deepEqual(Object.keys(GROUP_PREVIEW_TOOL.inputSchema.properties).sort(),['conversationIds','roomIds']);
    const raw=structuredClone(f.selection),snap=groupPreviewIntent(raw);raw.roomIds[0]='bad';assert.deepEqual(snap,f.selection);assert(Object.isFrozen(snap.roomIds));
    for(const extra of ['token','accessToken','actor','organizationId','commandId','claimId','accountId','body','verified'])
      assert.throws(()=>groupPreviewIntent({...f.selection,[extra]:'attacker'}),code('invalid_request'));
    assert.throws(()=>groupPreviewIntent({...f.selection,roomIds:[f.ROOM,f.ROOM]}),code('invalid_request'));
    const malicious={...f.selection};Object.defineProperty(malicious,'roomIds',{enumerable:true,get(){throw Error('getter executed');}});
    assert.throws(()=>groupPreviewIntent(malicious),code('invalid_request'));
  });
  await t.test('host group preview uses the real strict audit sink without persisting private content',()=>each(async()=>{
    const baseUrl=path.resolve('.cache/hermes-group-preview-tests/audit');await mkdir(baseUrl,{recursive:true});
    const root=await realpath(await mkdtemp(path.join(await realpath(baseUrl),'fixture-')));await fs.chmod(root,0o700);
    if(process.platform==='win32'){
      const open=fs.open.bind(fs);
      t.mock.method(fs,'open',async(name,flags,mode)=>{
        const info=await fs.lstat(name).catch(()=>null);
        if(info?.isDirectory()&&flags===(constants.O_RDONLY|(constants.O_DIRECTORY??0)|(constants.O_NOFOLLOW??0)))
          return {stat:()=>fs.lstat(name),sync:async()=>{},close:async()=>{}};
        return open(name,flags,mode);
      });
    }
    const sink=createHostAudit({directory:root});auditHook=event=>sink.write(event);
    try{
      const result=await create().previewGroupRooms(token,context,f.selection,{signal:signal()});
      assert.equal(result.status,'preview_only');await sink.close();
      const bytes=await fs.readFile(path.join(root,'broker-audit.jsonl'),'utf8'),rows=bytes.trim().split('\n').map(JSON.parse);
      assert.equal(rows.length,1);assert.equal(rows[0].operation,'private/group-room-preview');assert.equal(rows[0].outcome,'prepared');
      assert.deepEqual(Object.keys(rows[0]).sort(),['connectionId','operation','outcome','requestId']);
      for(const privateValue of [token,f.CLAIM,f.baseline.commandId,result.display.body,'SYNTHETIC_PRIVATE_REFRESH'])assert(!bytes.includes(privateValue));
    }finally{await sink.close();t.mock.restoreAll();await rm(root,{recursive:true,force:true});auditHook=undefined;}
  }));
  await t.test('actual shared admission and audit precede final SQL; output contains only public preview',()=>each(async()=>{
    const broker=create(),result=await broker.previewGroupRooms(token,context,f.selection,{signal:signal()});
    assert.equal(result.status,'preview_only');assert.match(result.display.body,/5\.000\.000 đ\/tháng/);
    assert.equal(result.display.sender,'Synthetic bot');assert.deepEqual(result.display.recipients,[{conversationId:f.GROUP,name:'Synthetic group'}]);
    assert.equal(f.events.at(-1),'hermes_group_preview_decision_v1');assert.equal(f.events.filter(x=>x==='audit:prepared').length,1);
    assert(f.events.indexOf('audit:prepared')<f.events.lastIndexOf('hermes_group_preview_decision_v1'));
    for(const secret of [token,f.CLAIM,f.baseline.commandId,...Object.values(f.identities),'SYNTHETIC_PRIVATE_REFRESH'])assert(!JSON.stringify(result).includes(secret));
    assert(Object.isFrozen(result));assert(Object.isFrozen(result.display));
    assert.equal((await broker.listTools(token)).tools.some(tool=>tool.name===GROUP_PREVIEW_TOOL.name),false);
    await assert.rejects(broker.callTool(token,GROUP_PREVIEW_TOOL.name,f.selection),code('tool_not_available'));
  }));
  await t.test('directory rereads current SQL after audit and projects only group selection data',()=>each(async()=>{
    const broker=create(),result=await broker.groupDirectory(token,context,{signal:signal()});
    assert.deepEqual(result.conversations,[{conversationId:f.GROUP,name:'Synthetic group'}]);
    assert.equal(result.sender,'Synthetic bot');
    assert.deepEqual(Object.keys(result).sort(),['conversations','expiresAt','sender']);
    assert.equal(f.events.at(-1),'hermes_group_directory_v1');
    assert(f.events.indexOf('audit:prepared')<f.events.lastIndexOf('hermes_group_directory_v1'));
    for(const secret of [token,f.CLAIM,f.baseline.commandId,...Object.values(f.identities),'SYNTHETIC_PRIVATE_REFRESH'])assert(!JSON.stringify(result).includes(secret));
    await assert.rejects(broker.groupDirectory(token,{...context,claimId:f.ROOM},{signal:signal()}));
    await assert.rejects(broker.callTool(token,'crm_group_directory',{}),code('tool_not_available'));
  }));
  await t.test('directory action revocation and changed groups during audit cannot release stale targets',()=>each(async()=>{
    auditHook=event=>event.outcome==='prepared'?f.f.db.exec("UPDATE public.zalo_conversations SET peer_name='Changed group'"):undefined;
    await assert.rejects(create().groupDirectory(token,context,{signal:signal()}),code('context_changed'));
    auditHook=event=>event.outcome==='prepared'?f.f.db.exec('UPDATE public.fixture_authority SET send_zalo=false'):undefined;
    await assert.rejects(create().groupDirectory(token,context,{signal:signal()}),e=>['forbidden','context_changed'].includes(e.code));
  }));
  await t.test('send transport uses bound IDs and real preview SQL attestation; queue ACK is synthetic',()=>each(async()=>{
    let creates=0,dispatch,observedId;
    hooks.beforeFetch=async(url,options)=>{
      if(!new URL(url).pathname.endsWith('/hermes_group_send_v1'))return;
      creates++; f.events.push('synthetic-send');
      const input=JSON.parse(options.body);assert.equal(Object.keys(input.p).length,15);
      assert(!Object.hasOwn(input.p,'body'));assert(!Object.hasOwn(input.p,'publicFacts'));
      const decision=await f.config.fetch(url.replace('hermes_group_send_v1','hermes_group_preview_decision_v1'),options);
      dispatch={id:input.p.requestId,expiresAt:new Date(Date.now()+240000).toISOString(),recipients:[{conversationId:f.GROUP,jobId:f.ROOM,status:'queued'}]};
      return Response.json({...await decision.json(),dispatch});
    };
    const result=await create().sendGroupRooms(token,context,f.selection,{signal:signal(),onDispatch:id=>observedId=id});
    assert.deepEqual(result,{status:'queued',dispatchId:dispatch.id,expiresAt:dispatch.expiresAt,
      recipients:[{conversationId:f.GROUP,name:'Synthetic group',status:'queued'}]});
    assert.equal(observedId,dispatch.id);
    assert.equal(creates,1);assert(f.events.indexOf('audit:prepared')<f.events.indexOf('synthetic-send'));
    assert(!JSON.stringify(result).includes(token));assert(!JSON.stringify(result).includes(f.CLAIM));
    await assert.rejects(create().callTool(token,'crm_group_room_send',f.selection),code('tool_not_available'));
  }));
  // Re-serve one real SQL result after `change` moves its DB-issued instants (later or earlier).
  const sqlAhead=(rpc,ahead,change)=>{let through=false;hooks.beforeFetch=async(url,options)=>{
    if(through||!new URL(url).pathname.endsWith('/'+rpc))return;
    through=true;
    try{const response=await f.config.fetch(url,options),value=await response.json();if(response.ok)change(value,ahead);return Response.json(value,{status:response.status});}
    finally{through=false;}
  };};
  await t.test('directory read by a DB clock ahead of this host: 50 ms and 4 s pass, 6 s fails',async()=>{
    for(const [ahead,accepted] of AHEAD)await each(async()=>{
      sqlAhead('hermes_group_directory_v1',ahead,value=>{value.recipientRead.readAt=later(value.recipientRead.readAt,ahead);});
      const result=create().groupDirectory(token,context,{signal:signal()});
      if(accepted)assert.deepEqual((await result).conversations,[{conversationId:f.GROUP,name:'Synthetic group'}]);
      else await assert.rejects(result,code('backend_unavailable'));
    });
  });
  await t.test('final preview decision by a DB clock ahead of this host: 50 ms and 4 s pass, 6 s fails',async()=>{
    for(const [ahead,accepted] of AHEAD)await each(async()=>{
      sqlAhead('hermes_group_preview_decision_v1',ahead,value=>{
        value.decision.checkedAt+=ahead;value.recipientRead.readAt=later(value.recipientRead.readAt,ahead);});
      const result=create().previewGroupRooms(token,context,f.selection,{signal:signal()});
      if(accepted)assert.equal((await result).status,'preview_only');
      else await assert.rejects(result,code('context_changed'));
    });
  });
  await t.test('final preview decision by a DB clock behind this host room read: 50 ms and 4 s pass, 6 s fails',async()=>{
    // checkedAt must not precede the host-stamped roomReadAt/startedAt by more than the skew.
    for(const [behind,accepted] of AHEAD)await each(async()=>{
      sqlAhead('hermes_group_preview_decision_v1',-behind,value=>{
        value.decision.checkedAt-=behind;value.recipientRead.readAt=later(value.recipientRead.readAt,-behind);});
      const result=create().previewGroupRooms(token,context,f.selection,{signal:signal()});
      if(accepted)assert.equal((await result).status,'preview_only');
      else await assert.rejects(result,code('context_changed'));
    });
  });
  await t.test('queue expiry issued by a DB clock ahead of this host: 50 ms and 4 s pass, 6 s is an unknown outcome',async()=>{
    for(const [ahead,accepted] of AHEAD)await each(async()=>{
      let expiresAt;
      hooks.beforeFetch=async(url,options)=>{
        if(!new URL(url).pathname.endsWith('/hermes_group_send_v1'))return;
        const input=JSON.parse(options.body),decision=await f.config.fetch(url.replace('hermes_group_send_v1','hermes_group_preview_decision_v1'),options);
        expiresAt=new Date(Date.now()+300000+ahead).toISOString();
        return Response.json({...await decision.json(),dispatch:{id:input.p.requestId,expiresAt,recipients:[{conversationId:f.GROUP,jobId:f.ROOM,status:'queued'}]}});
      };
      const result=create().sendGroupRooms(token,context,f.selection,{signal:signal()});
      if(accepted)assert.equal((await result).expiresAt,expiresAt);
      else await assert.rejects(result,code('send_outcome_unknown'));
    });
  });
  await t.test('malformed create ACK is unknown, while exact SQL rejection is definite; neither retries',()=>each(async()=>{
    let creates=0,dispatched=0,rejected=0,dispatchId;
    hooks.beforeFetch=async url=>new URL(url).pathname.endsWith('/hermes_group_send_v1')?(creates++,Response.json({dispatch:{status:'queued'},accessToken:'must-not-cross'})):undefined;
    const options={signal:signal(),onDispatch(id){dispatched++;dispatchId=id;},onRejected(){rejected++;}};
    await assert.rejects(create().sendGroupRooms(token,context,f.selection,options),error=>error.code==='send_outcome_unknown'&&error.dispatchId===dispatchId);
    assert.equal(creates,1);assert.equal(dispatched,1);assert.equal(rejected,0);
    hooks.beforeFetch=async url=>new URL(url).pathname.endsWith('/hermes_group_send_v1')?(creates++,Response.json({code:'42501',message:'hermes_group_denied',details:null,hint:null},{status:403})):undefined;
    await assert.rejects(create().sendGroupRooms(token,context,f.selection,options),code('forbidden'));
    assert.equal(creates,2);assert.equal(dispatched,2);assert.equal(rejected,1);
  }));
  await t.test('dispatched send timeout remains unknown and owns shared admission until raw write drains',()=>each(async()=>{
    const entered=deferred(),hold=deferred();let creates=0;
    hooks.beforeFetch=async url=>{
      if(!new URL(url).pathname.endsWith('/hermes_group_send_v1'))return;
      creates++;entered.resolve();await hold.promise;return Response.json({});
    };
    const broker=create({timeoutMs:200,maxConcurrentCalls:1}),op=f.scope.begin(()=>broker.sendGroupRooms(token,context,f.selection,{signal:signal()}));
    const unknown=assert.rejects(op.result,code('send_outcome_unknown'));await entered.promise;
    try{await unknown;await pending(op.drained);await assert.rejects(broker.listTools(token),code('busy'));assert.equal(creates,1);}
    finally{hold.resolve();await op.drained;}
  }));
  await t.test('status is read-only, binds recipients to current directory and strips job/provider IDs',()=>each(async()=>{
    let statusReads=0,foreign=false;
    hooks.beforeFetch=async(url,options)=>{
      if(!new URL(url).pathname.endsWith('/hermes_group_send_status_v1'))return;
      statusReads++;assert.deepEqual(JSON.parse(options.body),{p_dispatch_id:f.ROOM});
      return Response.json({id:f.ROOM,expiresAt:new Date(Date.now()-1000).toISOString(),recipients:[{
        conversationId:foreign?f.ROOM:f.GROUP,jobId:f.CLAIM,name:'Untrusted stale label',status:'unknown'}]});
    };
    const result=await create().groupSendStatus(token,context,f.ROOM,{signal:signal()});
    assert.equal(result.status,'dispatch_status');assert.equal(result.dispatchId,f.ROOM);
    assert.deepEqual(result.recipients,[{conversationId:f.GROUP,name:'Synthetic group',status:'unknown'}]);
    assert.equal(f.events.at(-1),'hermes_group_directory_v1');assert(!JSON.stringify(result).includes(f.CLAIM));
    foreign=true;await assert.rejects(create().groupSendStatus(token,context,f.ROOM,{signal:signal()}),code('context_changed'));
    assert.equal(statusReads,2);assert(!f.events.includes('hermes_group_send_v1'));
  }));
  await t.test('oversized recipient and room batches fail explicitly before preparing or dispatching',()=>each(async()=>{
    const broker=create();
    await assert.rejects(broker.sendGroupRooms(token,context,{...f.selection,conversationIds:Array(9).fill(f.GROUP)},{signal:signal()}),code('group_recipient_limit'));
    await assert.rejects(broker.sendGroupRooms(token,context,{...f.selection,roomIds:Array(21).fill(f.ROOM)},{signal:signal()}),code('group_room_limit'));
    assert(!f.events.includes('hermes_group_directory_v1'));assert(!f.events.includes('hermes_group_send_v1'));
  }));
  await t.test('missing capability denies preview without changing legacy room discovery',()=>each(async()=>{
    const broker=create(),before=await broker.listTools(token);
    await f.f.db.exec("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='chat_zalo.view'");
    await assert.rejects(broker.previewGroupRooms(token,context,f.selection,{signal:signal()}),e=>['forbidden','context_changed','tool_not_available'].includes(e.code));
    assert.deepEqual(await broker.listTools(token),before);assert(!f.events.includes('hermes_group_preview_decision_v1'));
  }));
  await t.test('missing DB RPC denies only preview and never silently grants action',()=>each(async()=>{
    const broker=create(),before=await broker.listTools(token);
    hooks.beforeFetch=async url=>new URL(url).pathname.endsWith('/hermes_group_action_context_v1')?Response.json({code:'PGRST202'},{status:404}):undefined;
    await assert.rejects(broker.previewGroupRooms(token,context,f.selection,{signal:signal()}),code('backend_unavailable'));
    assert.deepEqual(await broker.listTools(token),before);assert(!f.events.includes('hermes_group_directory_v1'));
  }));
  await t.test('wrong claim is checked by SQL before room read',()=>each(async()=>{
    await assert.rejects(create().previewGroupRooms(token,{...context,claimId:f.ROOM},f.selection,{signal:signal()}),e=>['forbidden','context_changed'].includes(e.code));
    assert(!f.events.includes('copilot_available_rooms_v1'));assert(!f.events.includes('hermes_group_preview_decision_v1'));
  }));
  await t.test('auditor failure and unknown audit outcome never release prepared text',()=>each(async()=>{
    auditHook=async()=>{throw Error('PRIVATE_FAILURE');};
    await assert.rejects(create().previewGroupRooms(token,context,f.selection,{signal:signal()}),code('backend_unavailable'));
    assert(!f.events.includes('hermes_group_preview_decision_v1'));
  }));
  await t.test('action revoked during actual audit rejects before final release',()=>each(async()=>{
    auditHook=event=>event.outcome==='prepared'?f.f.db.exec('UPDATE public.fixture_authority SET send_zalo=false'):undefined;
    await assert.rejects(create().previewGroupRooms(token,context,f.selection,{signal:signal()}),e=>['forbidden','context_changed'].includes(e.code));
    assert(!f.events.includes('hermes_group_preview_decision_v1'));
  }));
  await t.test('changed room facts immediately before final SQL cannot return a stale proposal',()=>each(async()=>{
    f.beforeDecision(()=>f.f.db.exec("UPDATE public.fixture_rooms SET payload=jsonb_set(payload,'{rooms,0,rent_price}','5100000')"));
    await assert.rejects(create().previewGroupRooms(token,context,f.selection,{signal:signal()}),code('context_changed'));
    assert(f.events.includes('hermes_group_preview_decision_v1'));assert.equal(f.events.at(-1),'audit:denied');
  }));
  await t.test('shared rate budget counts private previews and ordinary legacy calls together',()=>each(async()=>{
    const broker=create({maxRequestsPerMinute:1});await broker.previewGroupRooms(token,context,f.selection,{signal:signal()});
    await assert.rejects(broker.listTools(token),code('rate_limited'));
  }));
  await t.test('caller abort before admission issues no Auth or SQL request',()=>each(async()=>{
    const controller=new AbortController();controller.abort();
    await assert.rejects(create().previewGroupRooms(token,context,f.selection,{signal:controller.signal}),code('timeout'));
    assert.deepEqual(f.events,['audit:timeout']);
  }));
  await t.test('unknown audit completion keeps quota and emits no preview after observer timeout',()=>each(async()=>{
    const entered=deferred(),hold=deferred();auditHook=async event=>{if(event.outcome==='prepared'){entered.resolve();await hold.promise;}};
    const broker=create({timeoutMs:200,maxConcurrentCalls:1}),op=f.scope.begin(()=>broker.previewGroupRooms(token,context,f.selection,{signal:signal()}));
    const rejected=assert.rejects(op.result,code('timeout'));await entered.promise;
    try{await rejected;await pending(op.drained);await assert.rejects(broker.listTools(token),code('busy'));assert(!f.events.includes('hermes_group_preview_decision_v1'));}
    finally{hold.resolve();await op.drained;auditHook=undefined;}
  }));
  await t.test('timeout keeps per-connection admission until ignored-abort fetch and body cancellation really drain',()=>each(async()=>{
    const entered=deferred(),hold=deferred(),cancelEntered=deferred(),cancelHold=deferred();let rawSignal;
    hooks.beforeFetch=async(url,options)=>{
      if(!new URL(url).pathname.endsWith('/hermes_group_directory_v1'))return;
      rawSignal=options.signal;entered.resolve();await hold.promise;
      return new Response(new ReadableStream({cancel(){cancelEntered.resolve();return cancelHold.promise;}}),{headers:{'content-type':'application/json'}});
    };
    const broker=create({timeoutMs:200,maxConcurrentCalls:1});
    const op=f.scope.begin(()=>broker.previewGroupRooms(token,context,f.selection,{signal:signal()}));
    const rejected=assert.rejects(op.result,code('timeout'));await entered.promise;
    try{
      await rejected;assert(rawSignal.aborted);await pending(op.drained);
      await assert.rejects(broker.listTools(token),code('busy'));
      hold.resolve();await cancelEntered.promise;await pending(op.drained);
      await assert.rejects(broker.previewGroupRooms(token,context,f.selection,{signal:signal()}),code('busy'));
    }finally{hold.resolve();cancelHold.resolve();await op.drained;hooks.beforeFetch=undefined;}
    assert((await broker.listTools(token)).tools.some(tool=>tool.name==='crm_available_rooms'));
  }));
  await t.test('real SQL dispatch ACK → runner → supervisor WeakMap → gateway → broker → final SQL preview',()=>each(async()=>{
    // Reset only this disposable fixture row; no live ledger or remote IO exists.
    await f.f.db.exec("UPDATE app_private.hermes_zalo_private_commands SET state='QUEUED',claim_id=NULL,claimed_at=NULL,dispatched_at=NULL");
    const base=path.resolve('.cache/hermes-group-preview-mount/leases');await mkdir(base,{recursive:true});
    const root=await realpath(await mkdtemp(path.join(base,'fixture-'))),home=path.join(root,'home');await mkdir(home);
    let supervisor,preview,observedContext,observedInput,runtimeHandle;
    const backend={async resolveConnection(given,{signal}){
      assert.equal(given,token);const current=await authority.resolve(given,{signal});
      return{connectionId:current.row.id,assistantId:current.row.assistantId,userId:current.row.userId,organizationId:current.row.organizationId,expiresAt:current.row.expiresAt};
    },async renewConnection(){throw Error('not used');}};
    const broker=create(),gateway=createRuntimeGateway({backend,broker,dependencyScope:f.scope,
      modelService:{beginCompletion(){throw Error('model IO outside this fixture');}},
      resolvePrivateCommandContext:(handle,binding)=>supervisor.readPrivateCommandContext(handle,binding),
      transport:{async open(){return{descriptor:{networkName:'fixture',networkId:'b'.repeat(64),mcpUrl:'http://hermes-gateway:8787/mcp',modelBaseUrl:'http://hermes-gateway:8787/v1'},async close(){}};}}});
    const runtime={
      prepare({binding}){runtimeHandle=gateway.prepare(binding);return runtimeHandle;},
      start:handle=>gateway.start(handle),setAdmission:(handle,on)=>gateway.setAdmission(handle,on),stop:handle=>gateway.close(handle),
      beginExecutePrivateCommand(handle,input,options){
        observedInput=input;observedContext=options.commandContext;
        gateway.beginTurn(handle,{commandId:input.commandId,signal:options.signal,commandContext:options.commandContext});
        const result=gateway.previewGroupRooms(handle,{commandId:input.commandId,signal:options.signal},f.selection)
          .then(value=>{preview=value;return{text:'Synthetic preview ready'};});
        const drained=result.then(()=>undefined,()=>undefined).then(()=>gateway.endTurn(handle,{commandId:input.commandId}));
        return{result,drained};
      },
    };
    supervisor=createConnectionSupervisor({backend,runtime,dependencyScope:f.scope,
      profileStore:new ProfileLeaseStore({homeRoot:root,directory:path.join(root,'leases')}),
      timers:{setTimeout(){return{};},clearTimeout(){}}});
    const operations=[],names={claimPrivateCommand:'claim',dispatchPrivateCommand:'dispatch',finishPrivateCommand:'finish',failPrivateCommand:'fail',prunePrivateCommands:'prune'};
    const store=createPrivateCommandStore({transport:{call(operation,payload){
      operations.push({operation,payload});return f.scope.track(()=>f.f.rpc('app_private.hermes_store_'+names[operation]+'_private_command'+(operation==='prunePrivateCommands'?'s':'')+'_v1',payload));
    }}});
    const runner=createPrivateCommandRunner({store,supervisor,resolveConnection:backend.resolveConnection,dependencyScope:f.scope});
    const ticket=await gateway.register(token,{home});let lease;
    try{
      lease=await supervisor.start({token,home});const operation=runner.beginRun(token,lease,{signal:signal()});
      assert.deepEqual(await operation.result,{status:'ready',commandId:f.baseline.commandId});await operation.drained;
      assert.equal(preview.status,'preview_only');assert.match(preview.display.body,/5\.000\.000 đ\/tháng/);
      assert.deepEqual(Object.keys(observedInput).sort(),['bindingEpoch','bindingId','commandId','text']);
      assert(Object.isFrozen(observedContext));assert.deepEqual(Reflect.ownKeys(observedContext),[]);
      assert.deepEqual(operations.map(x=>x.operation),['claimPrivateCommand','dispatchPrivateCommand','finishPrivateCommand']);
      const claim=operations[1].payload.claimId;assert.notEqual(claim,context.claimId);
      const row=(await f.f.db.query('SELECT state,claim_id,reply_body FROM app_private.hermes_zalo_private_commands')).rows[0];
      assert.equal(row.state,'READY');assert.equal(row.claim_id,claim);assert.equal(row.reply_body,'Synthetic preview ready');
      assert.throws(()=>gateway.previewGroupRooms(runtimeHandle,{commandId:f.baseline.commandId,signal:signal()},f.selection),code('inactive'));
      for(const secret of [claim,token,...Object.values(f.identities)])assert(!JSON.stringify(preview).includes(secret));
    }finally{
      await Promise.allSettled([runner.close(),supervisor.close()]);await gateway.shutdown();await gateway.releaseRegistration(ticket);
      assert(path.resolve(root).startsWith(path.resolve(base)+path.sep));await rm(root,{recursive:true,force:true});
    }
  }));
  await t.test('private gateway resolves current opaque turn context for model preview and rejects context revocation',()=>each(async()=>{
    let handler,active=true,reads=0;const opaque=Object.freeze({}),identity={...f.identities,expiresAt:Date.now()+600000};
    const broker=create();
    // Resolver is synthetic in this composition test. Actual runner -> supervisor
    // WeakMap provenance is exercised by the unchanged tracked bridge suite.
    const gateway=createRuntimeGateway({backend:{async resolveConnection(){return identity;}},broker,
      modelService:{beginCompletion(){throw Error('not used');}},dependencyScope:f.scope,
      resolvePrivateCommandContext(handle,binding){reads++;assert.equal(handle,opaque);assert.equal(binding.token,token);assert.equal(binding.commandId,context.commandId);if(!active)throw Error('revoked');return context;},
      transport:{async open(input){handler=input.handler;return{descriptor:{networkName:'fixture',networkId:'b'.repeat(64),mcpUrl:'http://hermes-gateway:8787/mcp',modelBaseUrl:'http://hermes-gateway:8787/v1'},async close(){}};}}});
    const home=path.resolve('.cache/hermes-group-preview-mount/synthetic-home'),ticket=await gateway.register(token,{home});
    const handle=gateway.prepare({home,assistantId:identity.assistantId,userId:identity.userId,organizationId:identity.organizationId});
    await gateway.start(handle);gateway.setAdmission(handle,true);
    try{
      assert.throws(()=>gateway.previewGroupRooms(handle,{commandId:context.commandId,signal:signal()},f.selection),code('inactive'));
      gateway.beginTurn(handle,{commandId:context.commandId,commandContext:opaque});
      const result=await gateway.previewGroupRooms(handle,{commandId:context.commandId,signal:signal()},f.selection);
      assert.equal(result.status,'preview_only');
      const req=Readable.from([Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:GROUP_PREVIEW_TOOL.name,arguments:f.selection}}))]);
      req.method='POST';req.url='/mcp';req.headers={host:'hermes-gateway:8787','content-type':'application/json'};req.rawHeaders=['Host',req.headers.host,'Content-Type','application/json'];
      const res=new EventEmitter(),done=deferred();res.destroyed=false;res.writableEnded=false;res.writeHead=status=>res.status=status;
      res.end=body=>{res.writableEnded=true;done.resolve(JSON.parse(body));};handler(req,res);
      assert.equal(JSON.parse((await done.promise).result.content[0].text).status,'preview_only');
      f.beforeDecision(()=>{active=false;});
      await assert.rejects(gateway.previewGroupRooms(handle,{commandId:context.commandId,signal:signal()},f.selection));
      await assert.rejects(Promise.resolve().then(()=>gateway.previewGroupRooms(handle,{commandId:context.commandId,signal:signal()},f.selection)));
      await gateway.endTurn(handle,{commandId:context.commandId});
    }finally{await gateway.close(handle);await gateway.releaseRegistration(ticket);await gateway.shutdown();}
  }));
});
