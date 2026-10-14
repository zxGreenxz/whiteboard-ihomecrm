import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {cdeExecutionPlan,cdeCleanupSql,cdeCountsSql,verifiedClaims,rollbackOnly,CDE_RPCS,runCdeChecks,CDE_CAPABILITIES} from '../test-hermes-cde-live.mjs';
import {captureSourceIdentity,parseArguments,runChannelScope,fixturePlan,fixtureCleanupIdentity} from '../test-hermes-private-flow.mjs';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {PGlite} from '@electric-sql/pglite';
const root=fileURLToPath(new URL('../../',import.meta.url));
const actor='11111111-1111-4111-8111-111111111111',session='22222222-2222-4222-8222-222222222222',org='33333333-3333-4333-8333-333333333333';
test('CDE has no live default or provider/worker RPC capability',()=>{
  const plan=cdeExecutionPlan();assert.equal(plan.liveExecuted,false);assert.equal(plan.projectRef,'hzulujxgonszuleqticb');
  assert(!CDE_RPCS.some(name=>/due_|run_|send_|ingress|private_command|reply/.test(name)));
});
test('payload copying requires the exact already-verified actor/session/expiry; no token is manufactured by the implementation',()=>{
  // Unit-only inert token. Never used with Auth, HTTP, SQL or live fixture.
  const payload={sub:actor,session_id:session,role:'authenticated',exp:2000000000};
  const subject={actorIndex:0,session:{verified:{userId:actor,sessionId:session,expiresAt:payload.exp*1000},accessToken:'unit.'+Buffer.from(JSON.stringify(payload)).toString('base64url')+'.unit'}};
  assert.deepEqual(JSON.parse(verifiedClaims(subject,[{id:actor}],1)),payload);
  for(const change of [{userId:org},{sessionId:org},{expiresAt:0}])assert.throws(()=>verifiedClaims({...subject,session:{...subject.session,verified:{...subject.session.verified,...change}}},[{id:actor}],1));
  assert.throws(()=>verifiedClaims(subject,[{id:org}],1));
});
test('cleanup is exact fixture-org only and never targets registry, worker lease, immutable evidence or global users',()=>{
  const plan={orgs:[{id:org}]},sql=cdeCleanupSql(plan),counts=cdeCountsSql(plan);
  assert.equal((sql.match(new RegExp(org,'g'))??[]).length,2);assert.match(counts,/cde_queue/);
  assert.doesNotMatch(sql,/capabilities|worker_lease|schedule_grants|auth\.users|TRUNCATE|DISABLE|ALTER/i);
  assert.throws(()=>cdeCleanupSql({orgs:[{id:"x' OR true--"}]}));
});
for(const failure of ['operation','rollback',null])test('positive registry path always ends ROLLBACK; '+failure,async()=>{
  const queries=[],state={uncertain:false};let release;
  const client={async query(text){queries.push(typeof text==='string'?text:text.text);if(text==='ROLLBACK'&&failure==='rollback')throw Error('lost rollback ack');return {rows:[]};},release(broken){release=broken;}};
  const ctx={lease:{},test:'fixture',writeState:state,assertLease:async()=>{}};
  const operation=()=>rollbackOnly(ctx,{connect:async()=>client},{orgs:[{id:org}]},[{connection:{id:session}}],async()=>{if(failure==='operation')throw Error('probe failed');return 7;});
  if(failure)await assert.rejects(operation());else assert.equal(await operation(),7);
  assert.equal(queries[0],'BEGIN');assert.equal(queries.at(-1),'ROLLBACK');assert(!queries.includes('COMMIT'));
  assert.equal(state.uncertain,failure==='rollback');assert.equal(release,failure==='rollback');
});
test('source runner CDE plan is offline with network poisoned and no loader',()=>{
  const runner=fileURLToPath(new URL('../../scripts/test-hermes-private-flow.mjs',import.meta.url));
  const source=`globalThis.fetch=()=>{throw Error('network forbidden')};process.argv=[process.execPath,${JSON.stringify(runner)},'--plan','--mode','cde'];await import(${JSON.stringify(new URL('../../scripts/test-hermes-private-flow.mjs',import.meta.url).href)})`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:root,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).liveExecuted,false);
  const draft=readFileSync(new URL('../test-hermes-private-flow.mjs',import.meta.url),'utf8');
  assert.match(draft,/if \(mode === 'full'\) demand\(.*worker_lease_must_be_absent/);
  assert.match(draft,/mode === 'cde' \? '\.cache\/hermes-cde-live'/);
  assert.doesNotMatch(draft,/hermes-cde-live-next|loader\.mjs|build-patch\.mjs/);
});

// Offline fault injection into the actual exported runner. These inert unit
// payloads and SQL doubles never reach Auth, PostgREST or PostgreSQL.
async function reproduce(mode) {
  const actors=Array.from({length:3},()=>({id:randomUUID()}));
  const orgs=Array.from({length:2},()=>({id:randomUUID(),roleId:randomUUID(),buildingId:randomUUID()}));
  const plan={run:randomUUID(),actors,orgs};
  const issue=async(actorIndex,orgIndex)=>{
    const payload={sub:actors[actorIndex].id,session_id:randomUUID(),role:'authenticated',exp:Math.floor(Date.now()/1000)+600};
    return {actorIndex,orgIndex,tokenDigest:'unit',connection:{id:randomUUID(),assistantId:randomUUID()},
      session:{accessToken:'unit.'+Buffer.from(JSON.stringify(payload)).toString('base64url')+'.unit',
        verified:{userId:payload.sub,sessionId:payload.session_id,expiresAt:payload.exp*1000}}};
  };
  const fault=mode==='second_connect_failure'?new Error('unit second connection refused')
    :mode==='commit_40003'?Object.assign(new Error('unit commit unknown'),{severity:'ERROR',code:'40003'})
      :Object.assign(new Error('unit commit ACK lost'),{code:'ECONNRESET'});
  const trace={connects:0,releases:0,checkedOut:0,checkedOutAtEnd:null,rollbacks:0,commits:0,poolEndCalled:false,poolEndSettled:false,callerFinallyReached:false};
  const writeState={uncertain:false}, ctx={db:{},lease:{},test:'offline',assertLease:async()=>{},writeState};
  class FakePool {
    on(){}
    async query(query){
      const text=typeof query==='string'?query:query.text;
      if(text.includes('SELECT capability,mode,enabled'))return {rows:[...CDE_CAPABILITIES,'chat_zalo.view'].map(capability=>({capability,mode:'read',enabled:false}))};
      if(text.includes('pg_blocking_pids'))return {rows:[{blocked:true}]};
      assert.fail('Unexpected offline pool query');
    }
    async connect(){
      const number=++trace.connects;
      if(number===2&&mode==='second_connect_failure')throw fault;
      trace.checkedOut++;let claims,released=false;
      return {
        async query(query){
          const text=typeof query==='string'?query:query.text;
          if(text==='ROLLBACK'){trace.rollbacks++;return {rows:[]};}
          if(text==='COMMIT'){trace.commits++;throw fault;}
          if(text==='SELECT pg_backend_pid() pid')return {rows:[{pid:number}]};
          if(text.includes("set_config('request.jwt.claims'")){claims=JSON.parse(query.values[0]);return {rows:[]};}
          if(text.includes('SELECT auth.uid()'))return {rows:[{actor:claims.sub,role:claims.role,session:claims.session_id}]};
          if(text.includes('SELECT jsonb_build_object'))return {rows:[{value:{}}]};
          if(text.includes('SELECT public.hermes_work_memory_list_v1'))return {rows:[{value:{items:[{}]}}]};
          if(text==='BEGIN'||text==='RESET ROLE'||text==='SET LOCAL ROLE authenticated'||text.startsWith('UPDATE app_private.hermes_'))return {rows:[],rowCount:1};
          assert.fail('Unexpected offline client query');
        },
        release(){assert.equal(released,false);released=true;trace.releases++;trace.checkedOut--;},
      };
    }
    async end(){
      trace.poolEndCalled=true;trace.checkedOutAtEnd=trace.checkedOut;
      // A real pg pool would remain pending with a leaked checked-out client.
      // Fail immediately in the double so the regression cannot hang Node.
      assert.equal(trace.checkedOut,0,'pool.end cannot settle while a client is leaked');
      trace.poolEndSettled=true;
    }
  }
  const originalPool=pg.Pool, originalFetch=globalThis.fetch;let observed;
  try {
    pg.Pool=FakePool;globalThis.fetch=()=>{assert.fail('Network forbidden in fault regression');};
    try {
      await runCdeChecks({ctx,plan,subjects:[await issue(0,0),await issue(1,1)],issue,write:async()=>{},
        okRpc:async()=>assert.fail('HTTP forbidden'),deniedRpc:async()=>assert.fail('HTTP forbidden'),evidence:{},
        check:async(name,operation)=>{if(name==='cde.postgres_mvcc_sharing_revoke_waits_read_then_next_read_denied')await operation();}});
    } catch(error){observed=error;}
    finally {trace.callerFinallyReached=true;}
  } finally {pg.Pool=originalPool;globalThis.fetch=originalFetch;}
  assert.equal(observed,fault,'original failure reaches the caller after pool cleanup');
  assert.equal(trace.connects,2);assert.equal(trace.checkedOut,0);assert.equal(trace.checkedOutAtEnd,0);
  assert.equal(trace.poolEndCalled,true);assert.equal(trace.poolEndSettled,true);assert.equal(trace.callerFinallyReached,true);
  return {trace,writeState};
}

test('Q2-R1: second connect failure releases the reader and pool.end settles before caller cleanup',async()=>{
  const {trace,writeState}=await reproduce('second_connect_failure');
  assert.equal(trace.releases,1);assert.equal(trace.rollbacks,0);assert.equal(trace.commits,0);assert.equal(writeState.uncertain,false);
});
for(const mode of ['commit_40003','commit_transport_ack_loss'])test('Q2-R2: '+mode+' preserves uncertainty after ROLLBACK ACK and releases both clients',async()=>{
  const {trace,writeState}=await reproduce(mode);
  assert.equal(trace.releases,2);assert.equal(trace.rollbacks,2);assert.equal(trace.commits,1);assert.equal(writeState.uncertain,true);
});

test('source identity binds the actual CDE helper and test without cache-shadow dependencies',()=>{
  const identity=captureSourceIdentity();
  for(const path of ['scripts/test-hermes-cde-live.mjs','scripts/test-hermes-private-flow.mjs','scripts/__tests__/hermes-cde-live.test.mjs']){
    assert.equal(identity[path],createHash('sha256').update(readFileSync(new URL('../../'+path,import.meta.url))).digest('hex'));
  }
  assert(!Object.keys(identity).some(path=>path.startsWith('.cache/')));
});
test('explicit CDE route invokes only its branch, including failure, while retaining the TEST target guard',async()=>{
  const args=['--run','--env','test','--expected-project-ref','hzulujxgonszuleqticb','--mode','cde'];
  assert.equal(parseArguments(args).mode,'cde');
  assert.throws(()=>parseArguments(args.map(value=>value==='test'?'prod':value)),{code:'explicit_test_run_required'});
  const calls=[];
  const handlers={cde:async()=>{calls.push('cde');return 7;},management:async()=>assert.fail('management forbidden'),full:async()=>assert.fail('worker forbidden')};
  assert.equal(await runChannelScope('cde',handlers),7);assert.deepEqual(calls,['cde']);
  await assert.rejects(runChannelScope('cde',{...handlers,cde:async()=>{throw Error('unit failure');}}),/unit failure/);
});
test('CDE cleanup counts compose with psqlJson derived-table wrapper in local PostgreSQL',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`CREATE SCHEMA app_private;
      CREATE TABLE app_private.hermes_work_memories(organization_id uuid);
      CREATE TABLE app_private.hermes_work_memory_settings(organization_id uuid);
      CREATE TABLE app_private.hermes_room_schedules(id uuid,organization_id uuid);
      CREATE TABLE app_private.hermes_schedule_grants(organization_id uuid);
      CREATE TABLE app_private.hermes_schedule_events(schedule_id uuid);
      CREATE TABLE public.zalo_send_queue(organization_id uuid);`);
    const sql=cdeCountsSql({orgs:[{id:org}]});
    const result=await db.query(`SELECT COALESCE(json_agg(t), '[]'::json) FROM (${sql}\n) t;`);
    assert.deepEqual(result.rows[0].coalesce,[{cde_memories:0,cde_settings:0,cde_schedules:0,cde_grants:0,cde_events:0,cde_queue:0}]);
  }finally{await db.close();}
});
test('cleanup identity retains exact generated scope but excludes all credential material',()=>{
  const plan=fixturePlan();plan.actors[0].id=actor;plan.connectionIds.push(session);
  plan.privateToken='never-persist-token';plan.actors[0].session={accessToken:'never-persist-session'};
  const identity=fixtureCleanupIdentity(plan),serialized=JSON.stringify(identity);
  assert.deepEqual(identity.actors[0],{id:actor,email:plan.actors[0].email});
  assert.deepEqual(identity.connectionIds,[session]);assert.equal(identity.organizations[0].id,plan.orgs[0].id);
  assert.deepEqual(identity.channelAccountIds,plan.channels.map(channel=>channel.accountId));
  assert.equal(identity.roomRead.roomId,plan.roomRead.roomId);assert.equal(identity.role,plan.role);
  for(const secret of [plan.rolePassword,...plan.actors.map(item=>item.password),'never-persist-token','never-persist-session'])assert(!serialized.includes(secret));
  plan.connectionIds.push(org);assert.deepEqual(identity.connectionIds,[session]);
});
