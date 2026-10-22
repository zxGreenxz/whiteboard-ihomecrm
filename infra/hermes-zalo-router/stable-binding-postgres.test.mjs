import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { splitHermesFunctionStatements } from '../../scripts/hermes-task-function-contract.mjs';
import { candidateLocalPostgresBins,assertSupportedLocalPostgresVersion } from '../../scripts/network-center-disposable-db.mjs';
import { createStoreTransport } from '../hermes-broker/store-transport.mjs';
import { provisionNativeBinding } from '../hermes-zalo-native/binding-provisioning.mjs';
import { readNativeConfig } from '../../worker/lib/hermes-native-config.js';
import { mkdirSync } from 'node:fs';
import { fixture,id,ORG,USER,ASSISTANT,SESSION,CONNECTION,BINDING,ACCOUNT,INSTANCE,GENERATION } from './private-command-fixture.mjs';
const sql=readFileSync(new URL('../../supabase/migrations/20261019034850_hermes_zalo_stable_binding_v1.sql',import.meta.url),'utf8');
function trackPoolDrain(pool) {
  // pg-pool resolves end() after removing clients from its list, before their
  // sockets necessarily close. Stopping the cluster then can emit a late 57P01.
  const clientEnds=[];
  pool.on('connect',client=>{
    clientEnds.push(new Promise(resolve=>client.once('end',resolve)));
  });
  return async()=>{await pool.end();await Promise.all(clientEnds);};
}

test('disposable PostgreSQL stop waits for physical clients after pool.end resolves',async()=>{
  const pool=new EventEmitter(),first=new EventEmitter(),second=new EventEmitter();
  const sequence=[];
  pool.end=async()=>{sequence.push('pool ended');};
  const drain=trackPoolDrain(pool);
  pool.emit('connect',first);pool.emit('connect',second);
  const cleanup=drain().then(()=>{sequence.push('stop PostgreSQL');});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(sequence,['pool ended']);
  first.emit('end');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(sequence,['pool ended'],'every physical client must finish');
  second.emit('end');await cleanup;
  assert.deepEqual(sequence,['pool ended','stop PostgreSQL']);
});

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 30000, windowsHide: true, ...options });
  assert.equal(result.status, 0, `${binary}: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
async function localCluster(t) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const bin = candidateLocalPostgresBins().find(p => existsSync(join(p, `initdb${suffix}`)));
  assert(bin, 'PostgreSQL 16+ required: set POSTGRES_BIN; no remote fallback');
  const binary = name => join(bin, name + suffix);
  const version = run(binary('initdb'), ['--version']);
  assertSupportedLocalPostgresVersion('initdb', version); t.diagnostic(version.trim());
  const root = mkdtempSync(join(tmpdir(), 'hermes-binding-pg-'));
  const server = createServer();
  await new Promise((ok, bad) => server.once('error', bad).listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  await new Promise(ok => server.close(ok));
  let started = false;
  const cleanup = () => {
    if (started) run(binary('pg_ctl'), ['-D', root, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
    const target = resolve(root), temp = resolve(tmpdir()) + sep;
    assert(target.startsWith(temp) && target.slice(temp.length).startsWith('hermes-binding-pg-'));
    rmSync(target, { recursive: true });
  };
  try {
    run(binary('initdb'), ['-D', root, '--auth=trust', '--username=postgres', '--encoding=UTF8', '--no-locale']);
    const sockets = process.platform !== 'win32' ? " -k ''" : '';
    run(binary('pg_ctl'), ['-D', root, '-l', join(root, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1${sockets}`, '-w', 'start'], { stdio: 'ignore' });
    started = true;
    const pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', max: 6,
      connectionTimeoutMillis: 5000, options: '-c statement_timeout=10000' });
    return { pool, drain:trackPoolDrain(pool), cleanup, port };
  } catch (error) { cleanup(); throw error; }
}


test('TG4 stable binding uses real PostgreSQL role fences and serializes settings/credential selection without relinking',{timeout:90000},async t=>{
  const {pool,drain,cleanup,port}=await localCluster(t);
  const client=await pool.connect();
  const db={exec:text=>client.query(text),query:(...args)=>client.query(...args),close:async()=>{}};
  try {
    const f=await fixture({after(){}},{database:db,migrations:['20261013084000_hermes_private_command_dispatch_v1','20261013095000_hermes_zalo_private_reply_v1']});
    await db.exec("CREATE TABLE public.role_bindings(membership_id uuid,organization_id uuid,valid_from timestamptz,valid_to timestamptz); CREATE TABLE public.member_permission_overrides(membership_id uuid,organization_id uuid,expires_at timestamptz,revoked_at timestamptz)");
    await db.exec("ALTER TABLE app_private.hermes_connections ADD COLUMN permission_mode text NOT NULL DEFAULT 'legacy_allowlist', ADD COLUMN excluded_read text[] NOT NULL DEFAULT '{}', ADD COLUMN excluded_action text[] NOT NULL DEFAULT '{}', ADD COLUMN scope_mode text NOT NULL DEFAULT 'restricted'; CREATE FUNCTION app_private.is_actor_offboarded_v1() RETURNS boolean LANGUAGE sql AS $$SELECT false$$");
    await db.exec("CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions; CREATE TABLE public.authorization_scopes(id uuid,organization_id uuid); CREATE TABLE public.authorization_audit_events(id uuid PRIMARY KEY,organization_id uuid,occurred_at timestamptz,actor_user_id uuid,actor_membership_id uuid,event_type text,resource_type text,resource_id uuid,old_state jsonb,new_state jsonb,reason text,prev_hash text,event_hash text)");
    const auditSource=readFileSync(new URL('../../supabase/migrations/20260725180000_authz_audit_append_helper.sql',import.meta.url),'utf8');
    const auditStart=auditSource.indexOf('create or replace function app_private.append_authz_audit_v1(');
    await db.exec(auditSource.slice(auditStart,auditSource.indexOf('$fn$;',auditStart)+'$fn$;'.length));
    const limits=readFileSync(new URL('../../supabase/migrations/20261019034754_hermes_inherit_crm_limits_v1.sql',import.meta.url),'utf8');
    const needed=new Set(['hermes_connection_json_v1','hermes_validate_exclusions_v2','hermes_audit_connection_change_v2',
      'hermes_store_connection_settings_v1','hermes_store_restrict_connection_v1','hermes_store_revoke_connection_v1']);
    for(const statement of splitHermesFunctionStatements(limits)){
      const name=statement.split('CREATE OR REPLACE FUNCTION app_private.')[1]?.split('(')[0];
      if(needed.has(name))await db.exec(statement);
    }
    const optional=readFileSync(new URL('../../supabase/migrations/20261014000503_hermes_optional_org_policy_v1.sql',import.meta.url),'utf8');
    const start=optional.indexOf('CREATE OR REPLACE FUNCTION app_private.hermes_effective_org_policy_v1');
    await db.exec(optional.slice(start,optional.indexOf('END $fn$;',start)+'END $fn$;'.length));
    await db.exec(sql);await db.exec(sql);
    const next=id('e');
    await db.query("INSERT INTO app_private.hermes_connections(id,assistant_id,organization_id,user_id,state,credential_ref,intent_digest,intent_expires_at,activation_operation_id) VALUES($1,$2,$3,$4,'ACTIVE',$5,repeat('d',64),clock_timestamp()+interval '1 hour',$1)",[next,ASSISTANT,ORG,USER,SESSION]);
    await db.query("INSERT INTO app_private.hermes_connection_tokens(token_digest,connection_id,expires_at) VALUES(repeat('e',64),$1,clock_timestamp()+interval '10 minutes')",[next]);
    const invoke=async(connection,payload)=>{
      await connection.query('BEGIN');
      await connection.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",[USER]);
      await connection.query('SET LOCAL ROLE authenticated');
      try {const result=await connection.query('SELECT public.hermes_zalo_binding_v1($1::jsonb) value',[JSON.stringify(payload)]);await connection.query('COMMIT');return result.rows[0].value;}
      catch(error){await connection.query('ROLLBACK');throw error;}
    };
    const a=await pool.connect(),b=await pool.connect();
    try {
      await t.test('two stale selections cannot both replace the explicit credential',async()=>{
        const payload={operation:'selectCredential',organizationId:ORG,connectionId:next,expectedConnectionEpoch:1,expectedActiveConnectionId:CONNECTION};
        await a.query('BEGIN; UPDATE app_private.hermes_zalo_active_credentials SET revision=revision+1');
        let settled=false;
        const pending=invoke(b,payload).finally(()=>{settled=true;});
        // Observe a real waiting SQL statement, without assuming a fixed sleep.
        let waits=false;
        for(let n=0;n<50&&!waits;n++) {const row=await client.query("SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT public.hermes_zalo_binding_v1%'");waits=row.rows[0].n>0;await new Promise(resolve=>setImmediate(resolve));}
        assert.equal(waits,true);assert.equal(settled,false);
        await a.query('COMMIT');assert.equal((await pending).connectionId,next);
        await assert.rejects(invoke(b,payload),error=>error.code==='PT409');
      });
      await t.test('settings update waits consistently, projects the current epoch, and leaves sender identity unchanged',async()=>{
        await a.query('BEGIN');await a.query('UPDATE app_private.hermes_connections SET epoch=epoch+1 WHERE id=$1',[next]);
        const projected=(await a.query('SELECT * FROM app_private.hermes_zalo_bindings WHERE id=$1',[BINDING])).rows[0];
        assert.equal(projected.connection_epoch,'2');assert.equal(projected.epoch,'1');assert.equal(projected.sender_uid,'456');
        const pending=invoke(b,{operation:'selectCredential',organizationId:ORG,connectionId:next,expectedConnectionEpoch:1,expectedActiveConnectionId:next});
        const rejected=assert.rejects(pending,error=>error.code==='PT409');
        await a.query('COMMIT');await rejected;
        assert.equal((await f.call()).status,'queued');
      });
      await t.test('concurrent begin calls keep only one live code for the same user and company',async()=>{
        const input={operation:'begin',organizationId:ORG,connectionId:next,expectedConnectionEpoch:2,accountId:ACCOUNT};
        const codes=await Promise.all([invoke(a,input),invoke(b,input)]);
        assert.notEqual(codes[0].challengeId,codes[1].challengeId);
        const waiting=await client.query("SELECT count(*)::int n FROM app_private.hermes_zalo_link_challenges WHERE state IN ('WAITING','OBSERVED')");
        assert.equal(waiting.rows[0].n,1);
      });
      await t.test('inherit mode no longer rejects a whole connection at a partial company ceiling; legacy keeps that contract',async()=>{
        await client.query("UPDATE app_private.hermes_connections SET read_capabilities='{rooms.view,customers.view}' WHERE id=$1",[next]);
        await client.query("UPDATE app_private.hermes_org_policies SET read_capabilities='{rooms.view}'");
        await assert.rejects(client.query("SELECT (app_private.hermes_private_command_connection_v1(repeat('e',64))).id"),e=>e.code==='42501');
        await client.query("UPDATE app_private.hermes_connections SET permission_mode='inherit_crm' WHERE id=$1",[next]);
        assert.equal((await client.query("SELECT (app_private.hermes_private_command_connection_v1(repeat('e',64))).id")).rows[0].id,next);
        const input={tokenDigest:'e'.repeat(64),claimId:id('f')};
        const claimed=await f.rpc('app_private.hermes_store_claim_private_command_v1',input);
        assert.equal(claimed.status,'claimed');
        await f.rpc('app_private.hermes_store_dispatch_private_command_v1',input);
        await f.rpc('app_private.hermes_store_finish_private_command_v1',{...input,text:'Synthetic reply'});
        const reply=await f.rpc('public.hermes_zalo_private_reply_v1',{operation:'claim',accountId:ACCOUNT,organizationId:ORG,
          instanceId:INSTANCE,generation:GENERATION,accountOwnerId:USER,ownUid:'123',loginRequestedAt:null,deliveryId:id('d')},'service_role');
        assert.equal(reply.status,'claimed');
      });
      await t.test('mutation checks detect stale-CAS bypass and skipped binding epoch projection',async()=>{
        await client.query('BEGIN');
        try {
          const projection=(await client.query("SELECT pg_get_functiondef('app_private.hermes_zalo_project_credential_v1()'::regprocedure) source")).rows[0].source;
          assert(projection.includes('connection_epoch=c.epoch'));
          await client.query(projection.replace('connection_epoch=c.epoch','connection_epoch=connection_epoch'));
          await client.query('UPDATE app_private.hermes_connections SET epoch=epoch+1 WHERE id=$1',[next]);
          const broken=(await client.query('SELECT connection_epoch FROM app_private.hermes_zalo_bindings WHERE id=$1',[BINDING])).rows[0].connection_epoch;
          assert.notEqual(broken,'3','current-epoch invariant detects the deliberately broken trigger');
        } finally {await client.query('ROLLBACK');}
        await client.query('BEGIN');
        try {
          const browser=(await client.query("SELECT pg_get_functiondef('public.hermes_zalo_binding_v1(jsonb)'::regprocedure) source")).rows[0].source;
          const fence='(connection_id=v_id OR connection_id=c.id AND v_id IS NULL)';
          assert(browser.includes(fence));
          await client.query(browser.replace(fence,'true'));
          await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",[USER]);
          await client.query('SET LOCAL ROLE authenticated');
          const payload={operation:'selectCredential',organizationId:ORG,connectionId:CONNECTION,expectedConnectionEpoch:1,expectedActiveConnectionId:CONNECTION};
          const exploited=(await client.query('SELECT public.hermes_zalo_binding_v1($1::jsonb) result',[JSON.stringify(payload)])).rows[0].result;
          assert.equal(exploited.status,'selected','mutation accepts stale selection denied by the normal guard');
        } finally {await client.query('ROLLBACK');}
      });
      await t.test('queued mapping acknowledgements cannot erase a newer settings or selection event',async()=>{
        const selector={assistantId:ASSISTANT,accountId:ACCOUNT};
        const work=await f.rpc('app_private.hermes_zalo_provisioning_work_v1',selector);
        assert.equal(work.binding.connectionId,next);
        await client.query('UPDATE app_private.hermes_connections SET epoch=epoch+1 WHERE id=$1',[next]);
        await assert.rejects(f.rpc('app_private.hermes_zalo_provisioning_ack_v1',{...selector,bindingId:BINDING,
          expectedRevision:work.revision,state:'synchronized'}),e=>e.code==='PT409');
        const current=await f.rpc('app_private.hermes_zalo_provisioning_work_v1',selector);
        assert(current.revision>work.revision);
        await f.rpc('app_private.hermes_zalo_provisioning_ack_v1',{...selector,bindingId:BINDING,
          expectedRevision:current.revision,state:'restart_pending'});
        // A subsequent settings revision retains the unverified restart receipt.
        await client.query('UPDATE app_private.hermes_connections SET epoch=epoch+1 WHERE id=$1',[next]);
        assert.equal((await f.rpc('app_private.hermes_zalo_provisioning_work_v1',selector)).provisioningState,'restart_pending');
      });
      await t.test('trusted real SQL transport provisions the existing native operator without exposing credentials',async()=>{
        await client.query('CREATE ROLE hermes_store_binding_fixture LOGIN; GRANT hermes_store_executor TO hermes_store_binding_fixture');
        const privatePool=new pg.Pool({host:'127.0.0.1',port,user:'hermes_store_binding_fixture',database:'postgres',max:2});
        const drainPrivatePool=trackPoolDrain(privatePool);
        const transport=createStoreTransport({pool:privatePool,expectedRole:'hermes_store_binding_fixture'});
        const root=mkdtempSync(join(tmpdir(),'hermes-binding-native-')),stateRoot=join(root,'state');
        mkdirSync(stateRoot,{mode:0o700});
        try {
          const options={transport,bindingId:BINDING,profileBinding:{assistantId:ASSISTANT,userId:USER,organizationId:ORG,profile:'alpha'},
            configFile:join(root,'config.json'),tokenFile:join(root,'alpha.token'),stateRoot,listenPort:8991,signal:new AbortController().signal};
          const plan=await provisionNativeBinding(options);
          const result=await provisionNativeBinding({...options,apply:true,expect:plan.expectedRevision});
          assert.equal(result.status,'updated');
          assert.equal(readNativeConfig(options.configFile).channels[0].pairedUid,'456');
          assert(!JSON.stringify(result).includes(readNativeConfig(options.configFile).channels[0].token));
          assert.equal(result.operator.activation,'pending_controlled_worker_restart');
        } finally {await drainPrivatePool();const target=resolve(root);assert(target.startsWith(resolve(tmpdir())+sep)&&target.includes('hermes-binding-native-'));rmSync(target,{recursive:true});}
      });
      await t.test('canonical audited action and settings/restrict/revoke serialize on org row before audit/session locks',async()=>{
        const waitForLock=async connection=>{
          for(let attempt=0;attempt<100;attempt++){
            const activity=(await client.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[connection.processID])).rows[0];
            if(activity?.wait_event_type==='Lock')return;
            await new Promise(resolve=>setTimeout(resolve,5));
          }
          assert.fail('expected a real PostgreSQL lock wait');
        };
        const writes=[
          ['settings','hermes_store_connection_settings_v1',{permissionMode:'inherit_crm',exclusions:{read:[],action:[]},scopeMode:'unrestricted',scopeIds:[]}],
          ['restrict','hermes_store_restrict_connection_v1',{read:[],action:[],scopeIds:[]}],
          ['revoke','hermes_store_revoke_connection_v1',{}]
        ];
        for(const [name,fn,extra] of writes){
          const epoch=Number((await client.query('SELECT epoch FROM app_private.hermes_connections WHERE id=$1',[CONNECTION])).rows[0].epoch);
          await a.query('BEGIN');
          await a.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[USER]);
          await a.query("SELECT (app_private.hermes_private_command_connection_v1(repeat('b',64))).id");
          await b.query('BEGIN');
          const writing=b.query('SELECT app_private.'+fn+'($1::jsonb) result',[JSON.stringify({connectionId:CONNECTION,expectedEpoch:epoch,...extra})]);
          void writing.catch(()=>{});
          try{
            await waitForLock(b);
            const advisory=(await client.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted) held",[b.processID])).rows[0].held;
            assert.equal(advisory,false,name+' must wait on organization before taking audit/session locks');
            // This is the real canonical hash-chain audit helper, not a no-op.
            await a.query("SELECT app_private.append_authz_audit_v1($1,$2,'hermes_connection',$3,NULL,'{}'::jsonb,'fixture action')",[ORG,'FIXTURE_ACTION_'+name,CONNECTION]);
            await a.query('COMMIT');
            assert.equal((await writing).rows[0].result.ok,true);
          }finally{await a.query('ROLLBACK');await writing.catch(()=>{});await b.query('ROLLBACK');}
        }
        assert.equal(Number((await client.query("SELECT count(*) n FROM public.authorization_audit_events WHERE event_type LIKE 'FIXTURE_ACTION_%'")).rows[0].n),3);
      });
      await t.test('binding write waits before session/audit while a real settings transaction holds its canonical locks; metadata still completes',async()=>{
        const epoch=Number((await client.query('SELECT epoch FROM app_private.hermes_connections WHERE id=$1',[CONNECTION])).rows[0].epoch);
        await a.query('BEGIN');
        await a.query('SELECT app_private.hermes_store_connection_settings_v1($1::jsonb)',[JSON.stringify({
          connectionId:CONNECTION,expectedEpoch:epoch,permissionMode:'inherit_crm',exclusions:{read:[],action:[]},scopeMode:'unrestricted',scopeIds:[]})]);
        const binding=invoke(b,{operation:'begin',organizationId:ORG,connectionId:CONNECTION,expectedConnectionEpoch:epoch+1,accountId:ACCOUNT});
        void binding.catch(()=>{});
        try{
          let waiting=false;
          for(let attempt=0;attempt<100&&!waiting;attempt++){
            waiting=(await client.query("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",[b.processID])).rows[0]?.waiting;
            if(!waiting)await new Promise(resolve=>setTimeout(resolve,5));
          }
          assert.equal(waiting,true);
          assert.equal((await client.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted) held",[b.processID])).rows[0].held,false);
          await client.query("SET statement_timeout='500ms'");
          try{
            const listed=await invoke(client,{operation:'list',organizationId:ORG,afterBindingId:null});
            assert.equal(listed.status,'listed');
          }finally{await client.query("SET statement_timeout='10000ms'");}
          await a.query('COMMIT');
          assert.equal((await binding).status,'waiting');
        }finally{await a.query('ROLLBACK');await binding.catch(()=>{});}
      });
      await t.test('negative control removing the writer org lock reproduces the real action/audit deadlock',async()=>{
        const original=(await client.query("SELECT pg_get_functiondef('app_private.hermes_store_connection_settings_v1(jsonb)'::regprocedure) source")).rows[0].source;
        const orgLock='PERFORM app_private.lock_org_for_decision_v1(c.organization_id);';
        assert(original.includes(orgLock));
        await client.query(original.replace(orgLock,'-- negative control: organization lock removed'));
        let writing,appending;
        try{
          await a.query("SET deadlock_timeout='100ms'");await b.query("SET deadlock_timeout='100ms'");
          await a.query('BEGIN');await a.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[USER]);
          await a.query("SELECT (app_private.hermes_private_command_connection_v1(repeat('b',64))).id");
          const epoch=Number((await client.query('SELECT epoch FROM app_private.hermes_connections WHERE id=$1',[CONNECTION])).rows[0].epoch);
          await b.query('BEGIN');
          writing=b.query('SELECT app_private.hermes_store_connection_settings_v1($1::jsonb)',[JSON.stringify({
            connectionId:CONNECTION,expectedEpoch:epoch,permissionMode:'inherit_crm',exclusions:{read:[],action:[]},scopeMode:'unrestricted',scopeIds:[]})]);
          void writing.catch(()=>{});
          let blocked=false;
          for(let attempt=0;attempt<100&&!blocked;attempt++){
            blocked=(await client.query("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",[b.processID])).rows[0]?.waiting;
            if(!blocked)await new Promise(resolve=>setTimeout(resolve,5));
          }
          assert.equal(blocked,true);
          assert.equal((await client.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted) held",[b.processID])).rows[0].held,true);
          appending=a.query("SELECT app_private.append_authz_audit_v1($1,'FIXTURE_NEGATIVE_ACTION','hermes_connection',$2,NULL,'{}'::jsonb,'negative control')",[ORG,CONNECTION]);
          void appending.catch(()=>{});
          const completed=await Promise.allSettled([writing,appending]);
          assert(completed.some(result=>result.status==='rejected'&&result.reason.code==='40P01'),'removed org lock must reproduce PostgreSQL deadlock detection');
        }finally{
          await a.query('ROLLBACK');await b.query('ROLLBACK');
          await writing?.catch(()=>{});await appending?.catch(()=>{});
          await client.query(original);await a.query("SET deadlock_timeout='1s'");await b.query("SET deadlock_timeout='1s'");
        }
      });
      await t.test('authenticated users cannot read private pointer table or host-only provisioning snapshot',async()=>{
        await b.query('BEGIN; SET LOCAL ROLE authenticated');
        await assert.rejects(b.query('SELECT * FROM app_private.hermes_zalo_active_credentials'),e=>e.code==='42501');
        await b.query('ROLLBACK; BEGIN; SET LOCAL ROLE authenticated');
        await assert.rejects(b.query('SELECT app_private.hermes_zalo_provisioning_v1($1::jsonb)',[JSON.stringify({bindingId:BINDING})]),e=>e.code==='42501');
        await b.query('ROLLBACK');
      });
    } finally {await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
  } finally {client.release();await drain();cleanup();}
});
