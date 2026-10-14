// C/D/E scope of the TEST-only private-flow fixture. No standalone live entry.
// Actual Auth sessions only; positive SQL changes ALWAYS roll back. Registry
// rows are never committed, so concurrent tenants and workers see no enablement.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { lit } from './test-env/lib.mjs';
import { loadFixtureCa } from './test-hermes-durable-store.mjs';
import { domainInput, domainResult, DOMAIN_READ_CAPABILITIES } from '../infra/hermes-broker/domain-contract.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const demand = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
const hash = value => createHash('sha256').update(value).digest('hex');
export const CDE_CAPABILITIES = Object.freeze(['assistant.memory.read','assistant.memory.write','chat_zalo.manage_automation',...DOMAIN_READ_CAPABILITIES]);
export const CDE_RPCS = Object.freeze(['hermes_work_memory_capabilities_v1','hermes_work_memory_status_v1',
  'hermes_work_memory_configure_v1','hermes_work_memory_list_v1','hermes_work_memory_upsert_v1','hermes_work_memory_forget_v1',
  'hermes_domain_capabilities_v1','hermes_domain_read_v1','hermes_room_schedule_capabilities_v1','hermes_room_schedule_manage_v1',
  'hermes_connection_options_v3','hermes_connection_context_v3','hermes_org_policy_options_v3']);
const SQL = Object.freeze({
  memoryStatus: 'SELECT public.hermes_work_memory_status_v1($1::jsonb) value',
  memoryConfigure: 'SELECT public.hermes_work_memory_configure_v1($1::jsonb,$2::jsonb) value',
  memoryList: 'SELECT public.hermes_work_memory_list_v1($1::jsonb,$2::jsonb) value',
  memoryUpsert: 'SELECT public.hermes_work_memory_upsert_v1($1::jsonb,$2::jsonb) value',
  memoryForget: 'SELECT public.hermes_work_memory_forget_v1($1::jsonb,$2::jsonb) value',
  domainRead: 'SELECT public.hermes_domain_read_v1($1::jsonb,$2::text,$3::jsonb) value',
  scheduleManage: 'SELECT public.hermes_room_schedule_manage_v1($1::jsonb) value',
});
const READ = ['assistant.context.read','assistant.memory.read','reports_real_estate.occupancy','chat_zalo.view'];
const ACTION = ['assistant.memory.write','chat_zalo.manage_automation'];
const ids = values => values.map(id => { demand(UUID.test(id), 'cde_fixture_id_invalid'); return lit(id); }).join(',');
const listed = ownerUserId => ({ownerUserId,limit:10,offset:0,updatedSince:null});

export function cdeExecutionPlan() {
  return { scope:'cde', liveExecuted:false, projectRef:'hzulujxgonszuleqticb',
    requires:['all reviewed apply evidence','official exclusive TEST lease','generated verified Auth sessions','all new C/D/E registry keys still disabled'],
    proof:['real JWT/PostgREST identity and disabled-capability denials','transaction-local positive memory CRUD/sharing and fixed occupancy projection',
      'transaction-local schedule list/revoke using an explicitly revoked inert fixture binding','two-session PostgreSQL sharing revocation lock and next-read denial'],
    excludes:['global registry rollout','worker lease access or takeover','provider/model/send','positive PostgREST data result','live schedule creation or DM observation'] };
}

// The parent verified this exact access token with /auth/v1/user. Copy its
// payload verbatim; never synthesize a session ID, actor, role or signed JWT.
export function verifiedClaims(subject, actors, now=Date.now()) {
  const session=subject.session, actor=actors[subject.actorIndex];
  demand(session?.verified?.userId===actor?.id && typeof session.accessToken==='string', 'cde_verified_session_required');
  const parts=session.accessToken.split('.'); demand(parts.length===3, 'cde_verified_session_required');
  let value; try { value=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8')); } catch { demand(false,'cde_verified_session_required'); }
  demand(value?.sub===actor.id && value.role==='authenticated' && value.session_id===session.verified.sessionId
    && UUID.test(value.session_id) && Number.isSafeInteger(value.exp) && value.exp*1000>now
    && session.verified.expiresAt===value.exp*1000, 'cde_verified_session_required');
  return Buffer.from(parts[1],'base64url').toString('utf8');
}

export function cdeCleanupSql(plan) {
  const orgs=ids(plan.orgs.map(o=>o.id));
  return `BEGIN; DELETE FROM app_private.hermes_work_memories WHERE organization_id IN (${orgs});
    DELETE FROM app_private.hermes_work_memory_settings WHERE organization_id IN (${orgs}); COMMIT;`;
}
export function cdeCountsSql(plan) {
  const orgs=ids(plan.orgs.map(o=>o.id));
  return `SELECT (SELECT count(*) FROM app_private.hermes_work_memories WHERE organization_id IN (${orgs}))::int cde_memories,
    (SELECT count(*) FROM app_private.hermes_work_memory_settings WHERE organization_id IN (${orgs}))::int cde_settings,
    (SELECT count(*) FROM app_private.hermes_room_schedules WHERE organization_id IN (${orgs}))::int cde_schedules,
    (SELECT count(*) FROM app_private.hermes_schedule_grants WHERE organization_id IN (${orgs}))::int cde_grants,
    (SELECT count(*) FROM app_private.hermes_schedule_events e JOIN app_private.hermes_room_schedules s ON s.id=e.schedule_id WHERE s.organization_id IN (${orgs}))::int cde_events,
    (SELECT count(*) FROM public.zalo_send_queue WHERE organization_id IN (${orgs}))::int cde_queue`;
}

export async function verifyCdeLiveSurface(pool) {
  const signatures=[
    ...['capabilities_v1(uuid)','status_v1(jsonb)','configure_v1(jsonb,jsonb)','list_v1(jsonb,jsonb)','upsert_v1(jsonb,jsonb)','forget_v1(jsonb,jsonb)'].map(s=>['public.hermes_work_memory_'+s,'authenticated']),
    ['public.hermes_domain_capabilities_v1(uuid)','authenticated'],['public.hermes_domain_read_v1(jsonb,text,jsonb)','authenticated'],
    ['public.hermes_room_schedule_manage_v1(jsonb)','authenticated'],['public.hermes_room_schedule_capabilities_v1(uuid)','authenticated'],
    ['public.hermes_room_schedule_due_v1(uuid,uuid[])','service_role'],['public.hermes_room_schedule_run_v1(uuid,bigint,uuid)','service_role'],
    ['public.hermes_connection_options_v3(uuid)','authenticated'],['public.hermes_connection_context_v3(uuid)','authenticated'],['public.hermes_org_policy_options_v3(uuid)','authenticated'],
    ['app_private.hermes_store_prune_work_memories_v1(jsonb)','hermes_store_executor'],
    ['app_private.hermes_domain_extend_options_v1(jsonb,text)',null],['app_private.hermes_domain_permission_v1(text)',null],
    ['app_private.hermes_domain_text_v1(text)',null],['app_private.hermes_work_memory_context_v1(jsonb,boolean)',null],
    ['app_private.hermes_work_memory_settings_json_v1(app_private.hermes_work_memory_settings)',null],
  ];
  for(const [signature,role] of signatures){
    const result=await pool.query('SELECT r,has_function_privilege(r,$1,\'EXECUTE\') allowed FROM unnest($2::text[]) r',[signature,['anon','authenticated','service_role','hermes_store_executor']]);
    assert.equal(result.rows.length,4);assert(result.rows.every(row=>row.allowed===(row.r===role)),signature);
  }
  const names=['work_memory_settings','work_memories','room_schedules','schedule_grants','schedule_runs','schedule_events'].map(n=>'app_private.hermes_'+n);
  const rls=await pool.query('SELECT relrowsecurity FROM pg_class WHERE oid=ANY($1::regclass[])',[names]);
  assert.equal(rls.rows.length,6);assert(rls.rows.every(row=>row.relrowsecurity));
  const acl=await pool.query('SELECT has_table_privilege(r,t,p) allowed FROM unnest($1::text[]) r CROSS JOIN unnest($2::text[]) t CROSS JOIN unnest($3::text[]) p',
    [['anon','authenticated','service_role','hermes_store_executor'],names,['SELECT','INSERT','UPDATE','DELETE']]);
  assert.equal(acl.rows.length,96);assert(acl.rows.every(row=>row.allowed===false));
  const registry=(await pool.query('SELECT capability,enabled FROM app_private.hermes_capabilities WHERE capability=ANY($1::text[])',[CDE_CAPABILITIES])).rows;
  assert.equal(registry.length,CDE_CAPABILITIES.length);assert(registry.every(row=>row.enabled===false),'no CDE rollout is authorized by this fixture');
}

async function bindingOf(client, subject) {
  await client.query('RESET ROLE');
  const row=(await client.query({text:`SELECT jsonb_build_object('connectionId',c.id,'tokenDigest',$2::text,'expectedEpoch',c.epoch,
    'expectedPolicyVersion',p.version,'expectedMembershipId',m.value->'membershipId','expectedAuthorizationVersion',m.value->'authorizationVersion',
    'expectedSessionRevision',s.revision) value FROM app_private.hermes_connections c
    JOIN app_private.hermes_sessions s ON s.id=c.credential_ref JOIN app_private.hermes_org_policies p ON p.organization_id=c.organization_id
    CROSS JOIN LATERAL (SELECT app_private.hermes_member_v1(c.user_id,c.organization_id) value) m WHERE c.id=$1::uuid`,
    values:[subject.connection.id,subject.tokenDigest],queryMode:'extended'})).rows;
  demand(row.length===1,'cde_binding_missing'); return row[0].value;
}
async function asActor(client, subject, actors) {
  const claims=verifiedClaims(subject,actors), payload=JSON.parse(claims);
  await client.query('RESET ROLE');
  await client.query({text:"SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.role',$3,true)",
    values:[claims,payload.sub,payload.role],queryMode:'extended'});
  await client.query('SET LOCAL ROLE authenticated');
  const {rows}=await client.query("SELECT auth.uid()::text actor,auth.role() role,auth.jwt()->>'session_id' session");
  assert.deepEqual(rows[0],{actor:payload.sub,role:'authenticated',session:payload.session_id});
}
async function call(client, subject, actors, operation, args) {
  demand(Object.hasOwn(SQL,operation),'cde_fixed_sql_required'); await asActor(client,subject,actors);
  return (await client.query({text:SQL[operation],values:args.map(x=>typeof x==='object'?JSON.stringify(x):x),queryMode:'extended'})).rows[0].value;
}
async function denial(client, action, codes=['42501']) {
  await client.query('SAVEPOINT cde_denial'); let error;
  try { await action(); } catch(e) { error=e; }
  await client.query('ROLLBACK TO SAVEPOINT cde_denial'); await client.query('RELEASE SAVEPOINT cde_denial');
  demand(error?.severity==='ERROR' && codes.includes(error.code),'cde_expected_sql_denial_missing');
}
async function positiveSetup(client, plan, subjects) {
  // This function is reachable only after BEGIN inside rollbackOnly().
  await client.query('RESET ROLE');
  await client.query({text:'UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability=ANY($1::text[])',
    values:[[...CDE_CAPABILITIES,'chat_zalo.view']],queryMode:'extended'});
  await client.query({text:`UPDATE app_private.hermes_org_policies p SET read_capabilities=$2::text[],action_capabilities=$3::text[],
    scope_ids=ARRAY(SELECT id FROM public.authorization_scopes WHERE organization_id=p.organization_id AND scope_type='ORGANIZATION')
    WHERE organization_id=ANY($1::uuid[])`,values:[plan.orgs.map(o=>o.id),READ,ACTION],queryMode:'extended'});
  await client.query({text:`UPDATE app_private.hermes_connections c SET read_capabilities=$2::text[],action_capabilities=$3::text[],
    scope_ids=ARRAY(SELECT id FROM public.authorization_scopes WHERE organization_id=c.organization_id AND scope_type='ORGANIZATION')
    WHERE id=ANY($1::uuid[]) AND organization_id=ANY($4::uuid[])`,
    values:[subjects.map(s=>s.connection.id),READ,ACTION,plan.orgs.map(o=>o.id)],queryMode:'extended'});
}
export async function rollbackOnly(ctx, pool, plan, subjects, operation) {
  await ctx.assertLease(ctx.lease,ctx.test); const client=await pool.connect(); let began=false, broken=false;
  try { await client.query('BEGIN'); began=true; await positiveSetup(client,plan,subjects); return await operation(client); }
  finally {
    if(began) try { await client.query('ROLLBACK'); } catch { broken=true; ctx.writeState.uncertain=true; }
    client.release(broken);
    demand(!broken,'cde_rollback_not_acknowledged');
  }
}

async function seedInertSchedule(client, plan, subject) {
  // Uncommitted and never deliverable: disabled bot + REVOKED challenge/binding,
  // no ingress session/message/observation and no worker call. Tests management
  // of a historical grant only, NOT successful creation of a live standing grant.
  await client.query('RESET ROLE');
  const org=plan.orgs[subject.orgIndex],actor=plan.actors[subject.actorIndex],c=subject.connection;
  const account=randomUUID(),conversation=randomUUID(),challenge=randomUUID(),binding=randomUUID(),schedule=randomUUID(),grant=randomUUID();
  const q=(text,values)=>client.query({text,values,queryMode:'extended'});
  await q("INSERT INTO public.zalo_accounts(id,user_id,organization_id,kind,name,zalo_uid,status,meta) VALUES($1,$2,$3,'personal','CDE inert rollback fixture','123456789','disconnected',$4::jsonb)",[account,actor.id,org.id,JSON.stringify({hermesFixtureRun:plan.run,providerDisabled:true})]);
  await q("INSERT INTO public.zalo_conversations(id,user_id,organization_id,account_id,thread_id,thread_type,peer_name) VALUES($1,$2,$3,$4,'123456789','group','CDE inert rollback fixture')",[conversation,actor.id,org.id,account]);
  await q('INSERT INTO app_private.hermes_zalo_bots(account_id,organization_id,enabled,updated_by) VALUES($1,$2,false,$3)',[account,org.id,actor.id]);
  await q("INSERT INTO app_private.hermes_zalo_link_challenges(id,user_id,organization_id,assistant_id,connection_id,connection_epoch,account_id,bot_version,challenge_digest,expires_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,clock_timestamp()+interval '1 minute','REVOKED')",
    [challenge,actor.id,org.id,c.assistantId,c.id,c.epoch,account,hash(randomUUID())]);
  await q("INSERT INTO app_private.hermes_zalo_bindings(id,user_id,organization_id,assistant_id,connection_id,connection_epoch,account_id,bot_version,sender_uid,conversation_id,challenge_id,state,revoked_at) VALUES($1,$2,$3,$4,$5,$6,$7,1,'123456789',$8,$9,'REVOKED',clock_timestamp())",
    [binding,actor.id,org.id,c.assistantId,c.id,c.epoch,account,conversation,challenge]);
  const zone=(await client.query('SELECT app_private.org_timezone_v1($1::uuid) zone',[org.id])).rows[0].zone;
  const settings={template:'rooms_public_text_v1',buildingIds:[org.buildingId],conversationIds:[conversation],weekdays:[1],time:'00:00',timeZone:zone,maxRooms:1,maxMessagesPerDay:1,expiresAt:new Date(Date.now()+3600000).toISOString()};
  await q("INSERT INTO app_private.hermes_room_schedules(id,user_id,organization_id,connection_id,grant_id,revision,state,last_request_id,last_request_digest) VALUES($1,$2,$3,$4,$5,1,'ACTIVE',$1,sha256(convert_to('cde-fixture','UTF8')))",[schedule,actor.id,org.id,c.id,grant]);
  await q("INSERT INTO app_private.hermes_schedule_grants(id,schedule_id,revision,user_id,organization_id,connection_id,binding_id,binding_epoch,account_id,settings,request_id,request_digest,expires_at) VALUES($1,$2,1,$3,$4,$5,$6,1,$7,$8::jsonb,$2,sha256(convert_to('cde-fixture','UTF8')),clock_timestamp()+interval '1 hour')",
    [grant,schedule,actor.id,org.id,c.id,binding,account,JSON.stringify(settings)]);
  return {schedule,grant};
}

export async function runCdeChecks({ctx,plan,subjects,issue,write,okRpc,deniedRpc,check,evidence}) {
  subjects=[...subjects,await issue(2,0),await issue(2,1)];
  const [owner,foreign,superA,superB]=subjects, actors=plan.actors;
  subjects.forEach(s=>verifiedClaims(s,actors));
  const pool=new pg.Pool({...ctx.db,database:'postgres',ssl:loadFixtureCa(),max:3,connectionTimeoutMillis:5000,
    statement_timeout:12000,lock_timeout:5000,options:'-c statement_timeout=12000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=15000',application_name:'hermes-cde-fixture'});
  pool.on('error',()=>{ctx.writeState.uncertain=true;});
  let registry;
  try {
    await ctx.assertLease(ctx.lease,ctx.test);
    registry=(await pool.query('SELECT capability,mode,enabled FROM app_private.hermes_capabilities WHERE capability=ANY($1::text[]) ORDER BY capability',[[...CDE_CAPABILITIES,'chat_zalo.view']])).rows;
    demand(CDE_CAPABILITIES.every(key=>registry.some(r=>r.capability===key && r.enabled===false)),'cde_registry_must_remain_disabled');
    await check('cde.real_jwt_postgrest_disabled_and_explicit_org',async()=>{
      for(const s of subjects) {
        const org=plan.orgs[s.orgIndex].id, actor={session:s.session};
        const caps=await okRpc(actor,'hermes_work_memory_capabilities_v1',{p_organization_id:org});
        assert.equal(caps.userId,actors[s.actorIndex].id); assert.equal(caps.organizationId,org); assert.equal(caps.readAllowed,false);assert.equal(caps.writeAllowed,false);
        const domains=await okRpc(actor,'hermes_domain_capabilities_v1',{p_organization_id:org});
        for(const key of DOMAIN_READ_CAPABILITIES)assert.equal(domains.permissions[key].allowed,false);
        const schedules=await okRpc(actor,'hermes_room_schedule_capabilities_v1',{p_organization_id:org});assert.equal(schedules.allowed,false);
        const options=await okRpc(actor,'hermes_connection_options_v3',{p_org:org});
        assert(!options.read.some(k=>CDE_CAPABILITIES.includes(k)));assert(!options.action.some(k=>CDE_CAPABILITIES.includes(k)));
      }
      await deniedRpc({session:owner.session},'hermes_domain_capabilities_v1',{p_organization_id:plan.orgs[1].id});
      const b=await bindingOf(pool,owner);
      await deniedRpc({session:owner.session},'hermes_work_memory_status_v1',{p:b});
      await deniedRpc({session:foreign.session},'hermes_work_memory_status_v1',{p:b});
      await deniedRpc({session:owner.session},'hermes_domain_read_v1',{p_binding:b,p_domain:'occupancy',p_input:domainInput('occupancy',{})});
      await deniedRpc({session:owner.session},'hermes_room_schedule_manage_v1',{p:{binding:{...b,requestId:randomUUID()},operation:'list',input:{limit:20,cursor:null}}});
    });
    await write(`BEGIN; ${plan.orgs.map(org=>['users.view','reports_real_estate.occupancy','chat_zalo.view'].map(key=>
      `INSERT INTO public.role_permissions(organization_id,role_id,permission_key,effect) VALUES(${lit(org.id)},${lit(org.roleId)},${lit(key)},'ALLOW') ON CONFLICT DO NOTHING;`).join('\n')).join('\n')}
      INSERT INTO app_private.hermes_work_memory_settings(organization_id,user_id,enabled,sharing) VALUES(${lit(plan.orgs[0].id)},${lit(actors[0].id)},true,'superadmin');
      INSERT INTO app_private.hermes_work_memories(organization_id,user_id,assistant_id,connection_id,key,content,source_label,expires_at)
      VALUES(${lit(plan.orgs[0].id)},${lit(actors[0].id)},${lit(owner.connection.assistantId)},${lit(owner.connection.id)},'q2_seed','Synthetic fixture only','Q2 fixture',clock_timestamp()+interval '1 day'); COMMIT;`);
    await check('cde.sql_transaction_local_memory_owner_share_action_revoke_forget',()=>rollbackOnly(ctx,pool,plan,subjects,async client=>{
      const b=await bindingOf(client,owner), sa=await bindingOf(client,superA), sb=await bindingOf(client,superB);
      let configured=await call(client,owner,actors,'memoryConfigure',[b,{enabled:true,sharing:'owner',retentionDays:1,expectedAccessVersion:1}]);
      await denial(client,()=>call(client,superA,actors,'memoryList',[sa,listed(actors[0].id)]));
      const saved=await call(client,owner,actors,'memoryUpsert',[b,{key:'q2_added',content:'Explicit synthetic work note',sourceLabel:'Q2 fixture',expectedId:null,expectedVersion:0,expectedAccessVersion:configured.settings.accessVersion}]);
      configured=await call(client,owner,actors,'memoryConfigure',[b,{enabled:true,sharing:'superadmin',retentionDays:1,expectedAccessVersion:configured.settings.accessVersion}]);
      const shared=await call(client,superA,actors,'memoryList',[sa,listed(actors[0].id)]);assert.equal(shared.items.length,2);
      await denial(client,()=>call(client,superB,actors,'memoryList',[sb,listed(actors[0].id)]));
      await denial(client,()=>call(client,foreign,actors,'memoryStatus',[b]));
      await client.query('RESET ROLE');await client.query('SAVEPOINT cde_overlay');
      await client.query('UPDATE app_private.hermes_connections SET action_capabilities=ARRAY[]::text[] WHERE id=$1',[owner.connection.id]);
      await denial(client,()=>call(client,owner,actors,'memoryConfigure',[b,{enabled:true,sharing:'owner',retentionDays:1,expectedAccessVersion:configured.settings.accessVersion}]));
      await client.query('ROLLBACK TO SAVEPOINT cde_overlay');
      configured=await call(client,owner,actors,'memoryConfigure',[b,{enabled:true,sharing:'owner',retentionDays:1,expectedAccessVersion:configured.settings.accessVersion}]);
      await denial(client,()=>call(client,superA,actors,'memoryList',[sa,listed(actors[0].id)]));
      assert.equal((await call(client,owner,actors,'memoryForget',[b,{key:'q2_added',expectedId:saved.id,expectedVersion:saved.version,expectedAccessVersion:configured.settings.accessVersion}])).forgotten,true);
    }));
    await check('cde.sql_transaction_local_fixed_domain_current_permission_and_overlay',()=>rollbackOnly(ctx,pool,plan,subjects,async client=>{
      const b=await bindingOf(client,owner),input=domainInput('occupancy',{});
      const result=await call(client,owner,actors,'domainRead',[b,'occupancy',input]);
      domainResult('occupancy',result,{row:{organizationId:plan.orgs[0].id},scopesByPermission:{'reports_real_estate.occupancy':{buildingIds:[plan.orgs[0].buildingId]}}},input);
      assert.equal(result.items.length,1);assert.equal(result.items[0].available,1);
      await denial(client,()=>call(client,owner,actors,'domainRead',[b,'occupancy',{...input,buildingId:plan.orgs[1].buildingId}]));
      await client.query('RESET ROLE');await client.query('SAVEPOINT cde_overlay');
      await client.query('UPDATE app_private.hermes_connections SET read_capabilities=ARRAY[\'assistant.context.read\'] WHERE id=$1',[owner.connection.id]);
      await denial(client,()=>call(client,owner,actors,'domainRead',[b,'occupancy',input]));await client.query('ROLLBACK TO SAVEPOINT cde_overlay');
      await client.query('RESET ROLE');
      await client.query("DELETE FROM public.role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_key='reports_real_estate.occupancy'",[plan.orgs[0].id,plan.orgs[0].roleId]);
      const fresh=await bindingOf(client,owner);
      await denial(client,()=>call(client,owner,actors,'domainRead',[fresh,'occupancy',input]));
    }));
    await check('cde.sql_transaction_local_schedule_revoke_inert_grant_no_send',()=>rollbackOnly(ctx,pool,plan,subjects,async client=>{
      const fixture=await seedInertSchedule(client,plan,owner),b=await bindingOf(client,owner),requestId=randomUUID();
      const payload={binding:{...b,requestId},operation:'revoke',input:{requestId,scheduleId:fixture.schedule,expectedRevision:1}};
      await denial(client,()=>call(client,foreign,actors,'scheduleManage',[payload]));
      await client.query('RESET ROLE');await client.query('SAVEPOINT cde_schedule_permission');
      await client.query("DELETE FROM public.role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_key='chat_zalo.manage_automation'",[plan.orgs[0].id,plan.orgs[0].roleId]);
      const fresh=await bindingOf(client,owner);
      await denial(client,()=>call(client,owner,actors,'scheduleManage',[{...payload,binding:{...fresh,requestId}}]));
      await client.query('ROLLBACK TO SAVEPOINT cde_schedule_permission');
      await client.query('RESET ROLE');await client.query('SAVEPOINT cde_schedule_overlay');
      await client.query('UPDATE app_private.hermes_connections SET action_capabilities=ARRAY[]::text[] WHERE id=$1',[owner.connection.id]);
      await denial(client,()=>call(client,owner,actors,'scheduleManage',[payload]));
      await client.query('ROLLBACK TO SAVEPOINT cde_schedule_overlay');
      const revoked=await call(client,owner,actors,'scheduleManage',[payload]);assert.equal(revoked.schedule.state,'REVOKED');assert.equal(revoked.schedule.revision,2);
      assert.deepEqual(await call(client,owner,actors,'scheduleManage',[payload]),revoked);
      await client.query('RESET ROLE');
      await denial(client,()=>client.query('SELECT app_private.hermes_schedule_current_v1($1::jsonb)',[JSON.stringify({scheduleId:fixture.schedule,grantId:fixture.grant,scheduleRevision:1,connectionId:owner.connection.id})]));
      const count=(await client.query('SELECT count(*)::int n FROM public.zalo_send_queue WHERE organization_id=ANY($1::uuid[])',[plan.orgs.map(o=>o.id)])).rows[0].n;assert.equal(count,0);
    }));
    await check('cde.postgres_mvcc_sharing_revoke_waits_read_then_next_read_denied',async()=>{
      let reader,writer,readerOpen=false,writerOpen=false,committing=false,pending,readerBroken=false,writerBroken=false;
      try {
        // Protect each successful acquisition, including a failed second connect.
        reader=await pool.connect();writer=await pool.connect();
        await ctx.assertLease(ctx.lease,ctx.test);await reader.query('BEGIN');readerOpen=true;await positiveSetup(reader,plan,subjects);
        const sa=await bindingOf(reader,superA);assert.equal((await call(reader,superA,actors,'memoryList',[sa,listed(actors[0].id)])).items.length,1);
        await reader.query('RESET ROLE');const readPid=(await reader.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await writer.query('BEGIN');writerOpen=true;const writePid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        pending=writer.query({text:"UPDATE app_private.hermes_work_memory_settings SET sharing='owner',access_version=access_version+1 WHERE organization_id=$1 AND user_id=$2 RETURNING access_version",values:[plan.orgs[0].id,actors[0].id],queryMode:'extended'});
        // Observe PostgreSQL's actual waiter, never infer a lock from a timer.
        void pending.catch(()=>{});let blocked=false;
        for(let attempt=0;attempt<60;attempt++) {
          await ctx.assertLease(ctx.lease,ctx.test);
          const row=(await pool.query('SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) blocked',[readPid,writePid])).rows[0];
          if(row.blocked){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,25));
        }
        demand(blocked,'cde_mvcc_writer_not_blocked_by_reader');await reader.query('ROLLBACK');readerOpen=false;
        const changed=await pending;pending=null;assert.equal(changed.rowCount,1);committing=true;await writer.query('COMMIT');writerOpen=false;committing=false;
        evidence.mvcc={readerBlockedWriter:true,nextReadDenied:false,writer:'exact fixture settings UPDATE',providerTouched:false};
      } catch(error) {
        // COMMIT was dispatched: an ERROR (including 40003) is not proof of
        // rollback. A later ROLLBACK ACK cannot settle the original COMMIT.
        if(committing)ctx.writeState.uncertain=true;throw error;
      }
      finally {
        if(readerOpen)try{await reader.query('ROLLBACK');}catch{readerBroken=true;ctx.writeState.uncertain=true;}
        if(pending)await pending.catch(()=>{});
        if(writerOpen)try{await writer.query('ROLLBACK');}catch{writerBroken=true;ctx.writeState.uncertain=true;}
        reader?.release(readerBroken);writer?.release(writerBroken);
      }
      await rollbackOnly(ctx,pool,plan,subjects,async client=>{
        const sa=await bindingOf(client,superA);await denial(client,()=>call(client,superA,actors,'memoryList',[sa,listed(actors[0].id)]));
        const b=await bindingOf(client,owner);assert.equal((await call(client,owner,actors,'memoryList',[b,listed(null)])).items.length,1);
      });evidence.mvcc.nextReadDenied=true;
    });
    const after=(await pool.query('SELECT capability,mode,enabled FROM app_private.hermes_capabilities WHERE capability=ANY($1::text[]) ORDER BY capability',[[...CDE_CAPABILITIES,'chat_zalo.view']])).rows;
    assert.deepEqual(after,registry);evidence.registryUnchanged=true;evidence.positivePostgrest=false;evidence.positiveSqlRollback=true;
  } finally { await pool.end().catch(error=>{ctx.writeState.uncertain=true;throw error;}); }
}
