import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { fixture, id, USER, ORG, FOREIGN, CONNECTION, SESSION, ASSISTANT } from '../hermes-zalo-router/private-command-fixture.mjs';
import { DOMAIN_READS, DOMAIN_READ_CAPABILITIES, DOMAIN_TOOLS, domainInput, domainResult, summarizeRows } from './domain-contract.mjs';
import { createDomainAuthAdapter, createSupabaseDomainReads } from './domain-adapter.mjs';
import { createDomainMount } from './domain-mount.mjs';
import { createReadCatalogAuthority } from './read-catalog-authority.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
const source = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8');
// B5c step 2 (20261020173818) CREATE OR REPLACEs hermes_domain_read_v1 (buildingName/roomName on leads, contracts,
// invoices, assets, tasks); R2a (20261020233934) adds the `summary` of the whole filtered set to every branch. The
// applied v1 file runs with that latest body swapped in, so every v1 test measures the live definition; an explicit
// HERMES_DOMAIN_SQL candidate is taken as given.
const LIVE_V1_PATH = 'supabase/migrations/20261020233934_hermes_domain_summary_v1.sql';
const v1Block = src => src.match(/CREATE OR REPLACE FUNCTION public\.hermes_domain_read_v1\([\s\S]*?\$fn\$;/)[0];
const candidate = process.env.HERMES_DOMAIN_SQL ? readFileSync(process.env.HERMES_DOMAIN_SQL, 'utf8') : (applied => applied.replace(v1Block(applied), () => v1Block(readFileSync(LIVE_V1_PATH, 'utf8'))))(
  readFileSync('supabase/migrations/20261014081902_hermes_domain_reads_v1.sql', 'utf8'));
const forward = source('20261014000503_hermes_optional_org_policy_v1');
const actual = name => forward.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replaceAll('.', '\\.')}[\\s\\S]*?\\$(?:fn)?\\$;`))[0];
const BUILDING=id('a'), OTHER_BUILDING=id('b'), ROOM=id('c'), OTHER_ROOM=id('e'), ITEM=id('f'), SCOPE=id('0');
const token='hc_'+'A'.repeat(43), digest=createHash('sha256').update(token).digest('hex');
const binding={connectionId:CONNECTION,tokenDigest:digest,expectedEpoch:1,expectedPolicyVersion:1,expectedMembershipId:USER,expectedAuthorizationVersion:1,expectedSessionRevision:1};
const code = expected => error => error.code===expected;

async function setup(t) {
  const f=await fixture(t,{migrations:['20261013084000_hermes_private_command_dispatch_v1']}),{db}=f;
  await db.exec(`CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('session_id',current_setting('request.jwt.claim.session',true))$$;
    CREATE FUNCTION app_private.is_actor_offboarded_v1() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
    CREATE TABLE public.authorization_scopes(id uuid PRIMARY KEY,organization_id uuid,scope_type text,building_id uuid,area_id uuid,cashbook_id uuid);
    CREATE TABLE public.areas(id uuid PRIMARY KEY,organization_id uuid,name text,deleted_at timestamptz);
    CREATE TABLE public.area_buildings(organization_id uuid,area_id uuid,building_id uuid);
    CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,name text,deleted_at timestamptz);
    CREATE TABLE public.rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,status text,deleted_at timestamptz,name text);
    CREATE TABLE public.customers(id uuid PRIMARY KEY,organization_id uuid,full_name text,phone text,deleted_at timestamptz);
    CREATE TABLE public.contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,contract_number text,status text,start_date date,end_date date,actual_end_date date,deleted_at timestamptz);
    CREATE TABLE public.contract_customers(organization_id uuid,contract_id uuid,customer_id uuid);
    CREATE TABLE public.leads(id uuid PRIMARY KEY,organization_id uuid,customer_name text,status text,building_id uuid,room_id uuid,next_follow_up_date timestamptz,deleted_at timestamptz);
    CREATE TABLE public.invoices(id uuid PRIMARY KEY,organization_id uuid,invoice_number text,status text,building_id uuid,room_id uuid,billing_month text,total_amount numeric,deleted_at timestamptz);
    CREATE TABLE public.assets(id uuid PRIMARY KEY,organization_id uuid,name text,code text,condition text,building_id uuid,room_id uuid,quantity numeric,user_id uuid,deleted_at timestamptz);
    CREATE TABLE public.services(id uuid PRIMARY KEY,organization_id uuid,name text,code text,unit text,unit_price numeric,user_id uuid,deleted_at timestamptz);
    CREATE TABLE public.building_services(organization_id uuid,service_id uuid,building_id uuid,is_active boolean);
    CREATE TABLE public.jobs(id uuid PRIMARY KEY,organization_id uuid,title text,code text,status text,building_id uuid,room_id uuid,deadline timestamptz);
    CREATE TABLE public.fixture_domain_acl(permission text PRIMARY KEY,allowed boolean DEFAULT true,org_wide boolean DEFAULT false,building_ids uuid[]);
    CREATE FUNCTION public.current_visible_owner_ids() RETURNS uuid[] LANGUAGE sql AS $$SELECT ARRAY[auth.uid()]$$;
    CREATE FUNCTION app_private.authorized_scope_v3(p_permission text,p_org uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[])
      LANGUAGE sql AS $$SELECT org_wide,building_ids,'{}'::uuid[] FROM public.fixture_domain_acl WHERE permission=p_permission AND allowed AND p_org='${ORG}'::uuid$$;
    CREATE FUNCTION public.get_authorization_context_v1(p_org uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object(
      'organizationId',p_org,'isOffboarded',false,'membershipId','${USER}','authorizationVersion',o.authorization_version,
      'permissions',(SELECT jsonb_object_agg(permission,allowed) FROM public.fixture_domain_acl)) FROM public.organizations o WHERE o.id=p_org$$;
    INSERT INTO public.buildings VALUES('${BUILDING}','${ORG}','Allowed',null),('${OTHER_BUILDING}','${ORG}','Denied',null),('${FOREIGN}','${FOREIGN}','Foreign',null);
    INSERT INTO public.rooms VALUES('${ROOM}','${ORG}','${BUILDING}','OCCUPIED',null,'P101'),('${OTHER_ROOM}','${ORG}','${OTHER_BUILDING}','AVAILABLE',null,'P201');
    INSERT INTO public.authorization_scopes VALUES('${SCOPE}','${ORG}','BUILDING','${BUILDING}',null,null);
    INSERT INTO public.customers VALUES('${ITEM}','${ORG}','Synthetic Resident','0901234567',null);
    INSERT INTO public.contracts VALUES('${ITEM}','${ORG}','${ROOM}','CONTRACT','ACTIVE','2026-01-01','2027-01-01',null,null);
    INSERT INTO public.contract_customers VALUES('${ORG}','${ITEM}','${ITEM}');
    INSERT INTO public.leads VALUES('${ITEM}','${ORG}','Synthetic Lead','B1_LEAD','${BUILDING}','${ROOM}',null,null);
    INSERT INTO public.invoices VALUES('${ITEM}','${ORG}','INVOICE','UNPAID','${BUILDING}','${ROOM}','2026-10',123.45,null);
    INSERT INTO public.assets VALUES('${ITEM}','${ORG}','Synthetic Asset','ASSET','GOOD','${BUILDING}','${ROOM}',2,'${USER}',null);
    INSERT INTO public.services VALUES('${ITEM}','${ORG}','Synthetic Service','SERVICE','unit',12.50,'${USER}',null);
    INSERT INTO public.building_services VALUES('${ORG}','${ITEM}','${BUILDING}',true),('${ORG}','${ITEM}','${OTHER_BUILDING}',true);
    INSERT INTO public.jobs VALUES('${ITEM}','${ORG}','Synthetic Task','TASK','IN_PROGRESS','${BUILDING}','${ROOM}',null);`);
  for (const key of DOMAIN_READ_CAPABILITIES) await db.query('INSERT INTO public.fixture_domain_acl(permission,building_ids) VALUES($1,$2)',[key,[BUILDING,OTHER_BUILDING]]);
  for (const name of ['app_private.hermes_effective_org_policy_v1','app_private.hermes_private_command_connection_v1','app_private.hermes_session_gate_v1','app_private.hermes_store_read_connection_v1']) await db.exec(actual(name));
  await db.exec(candidate);await db.exec(candidate);
  await db.query('UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability=ANY($1)',[DOMAIN_READ_CAPABILITIES]);
  await db.query('UPDATE app_private.hermes_org_policies SET read_capabilities=$1,scope_ids=$2',[DOMAIN_READ_CAPABILITIES,[SCOPE]]);
  await db.query('UPDATE app_private.hermes_connections SET read_capabilities=$1,scope_ids=$2',[DOMAIN_READ_CAPABILITIES,[SCOPE]]);
  await db.query('UPDATE app_private.hermes_connection_tokens SET token_digest=$1',[digest]);
  async function sqlCall(name,args,role='authenticated',actor=USER,session=SESSION) {
    const specs={capabilities:'SELECT public.hermes_domain_capabilities_v1($1::uuid) result',read:'SELECT public.hermes_domain_read_v1($1::jsonb,$2::text,$3::jsonb) result',
      extend:'SELECT app_private.hermes_domain_extend_options_v1($1::jsonb,$2::text) result'};
    assert.ok(Object.hasOwn(specs,name));
    await db.exec('BEGIN');
    await db.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.session',$3,true)",[role==='postgres'?'authenticated':role,actor,session]);
    await db.exec(`SET LOCAL ROLE ${role}`);
    try {const result=(await db.query(specs[name],args)).rows[0].result;await db.exec('COMMIT');return result;}
    catch(error){await db.exec('ROLLBACK');throw error;}finally{await db.exec('RESET ROLE');}
  }
  const rpc=(operation,input={},b=binding,role='authenticated',actor=USER,session=SESSION)=>sqlCall('read',[JSON.stringify(b),operation,JSON.stringify(domainInput(operation,input))],role,actor,session);
  return {f,db,sqlCall,rpc};
}

test('domain contract rejects caller-controlled identity, RPC, implicit writes and malformed result projections',()=>{
  // 16/10 đọc đầy đủ: crm_read_customers chuyển sang họ v3 (SĐT đầy đủ); 17/10 crm_read_occupancy sang v3
  // (snapshot trang Báo cáo lấp đầy). v1 SQL vẫn là bản đã phát hành.
  assert.equal(DOMAIN_TOOLS.filter(tool=>DOMAIN_READS[tool.name.slice(9)].family==='v1').length,6);assert.equal(DOMAIN_READS.occupancy.family,'v3');assert.equal(DOMAIN_READS.customers.family,'v3');
  for(const extra of [{organizationId:FOREIGN},{userId:USER},{rpc:'drop_all'},{table:'customers'},{query:'x\n'},{limit:51},{status:'APPROVED'}]) assert.throws(()=>domainInput('customers',extra));
  const identity={row:{organizationId:ORG},effective:{read:['customers.view']},scopesByPermission:{'customers.view':{buildingIds:[BUILDING]}}};
  const result={organizationId:ORG,domain:'customers',items:[{id:ITEM,name:'Name',phone:'0901234567',contractId:ITEM,buildingId:BUILDING,buildingName:'Allowed',roomId:ROOM,roomName:'P101'}],nextCursor:null,fetchedAt:'2026-10-16T00:00:00.000Z'};
  assert.deepEqual(domainResult('customers',result,identity,domainInput('customers',{})),result);
  for(const changed of [{...result,organizationId:FOREIGN},{...result,items:[{...result.items[0],buildingId:OTHER_BUILDING}]},{...result,items:[{...result.items[0],phoneMasked:'***4567'}]},{...result,fetchedAt:'now'},{...result,nextCursor:ITEM}]) assert.throws(()=>domainResult('customers',changed,identity,domainInput('customers',{})));
});

test('domain SQL: real foundation binding and fixed queries; synthetic CRM ACL/Auth ports, no live JWT proof',{timeout:60000},async t=>{
  const {db,rpc,sqlCall}=await setup(t);
  await t.test('all eight projections execute with saved building overlay and typed amounts',async()=>{
    for(const operation of Object.keys(DOMAIN_READS).filter(key=>DOMAIN_READS[key].family==='v1')){
      const result=await rpc(operation);assert.equal(result.items.length,1,operation);
      domainResult(operation,result,{row:{organizationId:ORG},scopesByPermission:{[DOMAIN_READS[operation].permission]:{buildingIds:[BUILDING,OTHER_BUILDING]}}},domainInput(operation,{}));
      if(operation==='customers')assert.equal(result.items[0].phoneMasked,'***4567');
      if(operation==='invoices')assert.equal(result.items[0].totalAmount,'123.45');
      // B5c step 2: every list row names its building and room (fixture: building 'Allowed', room 'P101').
      if(['leads','contracts','invoices','assets','tasks'].includes(operation))assert.deepEqual([result.items[0].buildingName,result.items[0].roomName],['Allowed','P101'],operation);
      if(operation==='services')assert.deepEqual(result.items[0].buildingIds,[BUILDING]);
      if(operation==='occupancy')assert.equal(result.items[0].total,1);
    }
  });
  // R2a (20261020233934): every list read of v1 carries the summary of the whole filtered set — same WHERE as the
  // page without the cursor or LIMIT. Synthetic rows; the extra tasks are removed again at the end.
  await t.test('R2a summary: counts, byStatus (assets: condition), asset quantity and overdue tasks over the whole filtered set, the same on every page',async()=>{
    const scoped=operation=>({row:{organizationId:ORG},scopesByPermission:{[DOMAIN_READS[operation].permission]:{buildingIds:[BUILDING,OTHER_BUILDING]}}});
    for(const operation of Object.keys(DOMAIN_READS).filter(key=>DOMAIN_READS[key].family==='v1')){
      const result=await rpc(operation);
      assert.deepEqual(Object.keys(result).sort(),['domain','items','nextCursor','organizationId','summary'],operation);
      assert.deepEqual(result.summary,summarizeRows(operation,result.items),`${operation}: one page holds every row, so the summary is the rows'`);
      assert.deepEqual(domainResult(operation,result,scoped(operation),domainInput(operation,{})).summary,result.summary,operation);
    }
    assert.deepEqual((await rpc('assets')).summary,{count:1,byStatus:{GOOD:1},sum:{quantity:'2'}});
    assert.deepEqual((await rpc('contracts')).summary,{count:1,byStatus:{ACTIVE:1},sum:{}});
    assert.deepEqual((await rpc('leads')).summary,{count:1,byStatus:{B1_LEAD:1},sum:{}});
    assert.deepEqual((await rpc('invoices')).summary,{count:1,byStatus:{},sum:{}},'invoices count only: a total over every status would mislead');
    assert.deepEqual((await rpc('services')).summary,{count:1,byStatus:{},sum:{}});
    assert.deepEqual((await rpc('tasks')).summary,{count:1,byStatus:{IN_PROGRESS:1},sum:{},overdue:0},'no deadline is never overdue');
    // Legacy branches (the tools moved to v3) summarise too: customers count, occupancy room totals.
    assert.deepEqual((await rpc('customers')).summary,{count:1,byStatus:{},sum:{}});
    assert.deepEqual((await rpc('occupancy')).summary,{count:1,total:1,occupied:1,available:0});
    const late='77777777-7777-4777-8777-777777777771',done='77777777-7777-4777-8777-777777777772',outside='77777777-7777-4777-8777-777777777773';
    await db.exec(`INSERT INTO public.jobs VALUES('${late}','${ORG}','Quá hạn','LATE','IN_PROGRESS','${BUILDING}',null,'2020-01-01T00:00:00Z'),
      ('${done}','${ORG}','Đã xong','DONE','COMPLETED','${BUILDING}',null,'2020-01-01T00:00:00Z'),
      ('${outside}','${ORG}','Toà khác','OUT','IN_PROGRESS','${OTHER_BUILDING}',null,'2020-01-01T00:00:00Z')`);
    try{
      const all={count:3,byStatus:{IN_PROGRESS:2,COMPLETED:1},sum:{},overdue:1};
      const first=await rpc('tasks',{limit:1}),second=await rpc('tasks',{limit:1,cursor:first.nextCursor});
      assert.deepEqual([first.items.length,first.summary,second.summary],[1,all,all],'cursor and limit never narrow the summary; the overlay building only');
      const pages=[first.items,second.items,(await rpc('tasks',{limit:1,cursor:second.nextCursor})).items].flat();
      assert.deepEqual(summarizeRows('tasks',pages),all,'the summary equals the summary of every page read');
      assert.deepEqual((await rpc('tasks',{status:'COMPLETED'})).summary,{count:1,byStatus:{COMPLETED:1},sum:{},overdue:0},'status filter');
      assert.deepEqual((await rpc('tasks',{query:'late'})).summary,{count:1,byStatus:{IN_PROGRESS:1},sum:{},overdue:1},'query filter (code)');
      assert.deepEqual((await rpc('tasks',{query:'không có'})).summary,{count:0,byStatus:{},sum:{},overdue:0},'empty set: 0 and {} — never null');
      assert.deepEqual((await rpc('assets',{query:'không có'})).summary,{count:0,byStatus:{},sum:{quantity:'0'}});
    }finally{await db.exec(`DELETE FROM public.jobs WHERE id IN ('${late}','${done}','${outside}')`);}
  });
  await t.test('role, caller, provider session, all binding versions and current CRM denial fail closed',async()=>{
    for(const role of ['anon','service_role'])await assert.rejects(rpc('customers',{},binding,role),/permission denied/);
    await assert.rejects(rpc('customers',{},binding,'authenticated',FOREIGN),code('42501'));
    await assert.rejects(rpc('customers',{},binding,'authenticated',USER,FOREIGN),code('42501'));
    for(const key of ['connectionId','expectedMembershipId','expectedEpoch','expectedPolicyVersion','expectedAuthorizationVersion','expectedSessionRevision'])await assert.rejects(rpc('customers',{}, {...binding,[key]:typeof binding[key]==='number'?2:FOREIGN}),code('PT409'));
    await db.exec("UPDATE public.fixture_domain_acl SET allowed=false WHERE permission='customers.view'");
    await assert.rejects(rpc('customers'),code('42501'));
    await db.exec("UPDATE public.fixture_domain_acl SET allowed=true WHERE permission='customers.view'");
  });
  await t.test('overlay is mandatory even for superadmin; foreign building and missing CRM resources are isolated',async()=>{
    await assert.rejects(rpc('customers',{buildingId:OTHER_BUILDING}),code('42501'));
    await db.exec(`INSERT INTO public.super_admins VALUES('${USER}'); UPDATE app_private.hermes_connections SET read_capabilities=ARRAY['tasks.view'];`);
    await assert.rejects(rpc('customers'),code('42501'));
    await db.query('UPDATE app_private.hermes_connections SET read_capabilities=$1',[DOMAIN_READ_CAPABILITIES]);
    await db.exec(`DELETE FROM public.super_admins; UPDATE public.fixture_domain_acl SET building_ids=ARRAY['${OTHER_BUILDING}'::uuid] WHERE permission='customers.view'`);
    assert.equal((await rpc('customers')).items.length,0);
    await db.exec(`UPDATE public.fixture_domain_acl SET building_ids=ARRAY['${BUILDING}'::uuid,'${OTHER_BUILDING}'::uuid] WHERE permission='customers.view'`);
    await db.exec(`UPDATE public.rooms SET organization_id='${FOREIGN}' WHERE id='${ROOM}'`);
    assert.equal((await rpc('customers')).items.length,0);
    await db.exec(`UPDATE public.rooms SET organization_id='${ORG}' WHERE id='${ROOM}'`);
  });
  await t.test('domain-only options retain existing read/action and add permitted scope choices; helper stays private',async()=>{
    const base={organizationId:ORG,userId:USER,membershipId:USER,authorizationVersion:1,isSuperadmin:false,policyVersion:1,enabled:true,read:['assistant.memory.read'],action:['assistant.memory.write'],scopes:[]};
    const result=await sqlCall('extend',[JSON.stringify(base),'connection_options'],'postgres');
    assert.equal(result.read.length,9);assert.deepEqual(result.action,base.action);assert.equal(result.scopes[0].scopeId,SCOPE);
    await assert.rejects(sqlCall('extend',[JSON.stringify(base),'connection_options']),/permission denied/);
    const orgOptions=await sqlCall('extend',[JSON.stringify({...base,choices:{read:['assistant.memory.read'],action:[],scopes:[]}}),'org_options'],'postgres');
    assert.equal(orgOptions.choices.read.length,9,'ordinary admin already admitted by users.edit wrapper remains valid');
    const context=await sqlCall('extend',[JSON.stringify({...base,restrictions:{read:['customers.view'],action:[]},companyCeilings:{read:DOMAIN_READ_CAPABILITIES,action:[]},effective:{read:['assistant.memory.read'],action:['assistant.memory.write']}}),'context'],'postgres');
    assert.deepEqual(context.effective,{read:['assistant.memory.read','customers.view'],action:['assistant.memory.write']});
    await db.exec('UPDATE app_private.hermes_org_policies SET scope_ids=\'{}\'');
    const noChoices=await sqlCall('extend',[JSON.stringify(base),'connection_options'],'postgres');
    assert.deepEqual(noChoices.read,base.read);assert.deepEqual(noChoices.scopes,[]);
    await db.query('UPDATE app_private.hermes_org_policies SET scope_ids=$1',[[SCOPE]]);
  });
  await t.test('unscoped rows require both CRM org-wide and organization overlay',async()=>{
    await db.exec(`UPDATE public.jobs SET building_id=null,room_id=null; UPDATE public.fixture_domain_acl SET org_wide=true WHERE permission='tasks.view'`);
    assert.equal((await rpc('tasks')).items.length,0);
    await db.exec(`UPDATE public.authorization_scopes SET scope_type='ORGANIZATION',building_id=null`);
    assert.equal((await rpc('tasks')).items.length,1);
    await db.exec(`UPDATE public.fixture_domain_acl SET org_wide=false WHERE permission='tasks.view'; UPDATE public.authorization_scopes SET scope_type='BUILDING',building_id='${BUILDING}'; UPDATE public.jobs SET building_id='${BUILDING}',room_id='${ROOM}'`);
  });
  await t.test('keyset pages neither duplicate nor claim completeness and wildcard strings stay literal',async()=>{
    const second='ffffffff-ffff-4fff-8fff-fffffffffffe';
    await db.exec(`INSERT INTO public.jobs SELECT '${second}',organization_id,'100%_ literal',code,status,building_id,room_id,deadline FROM public.jobs LIMIT 1`);
    const first=await rpc('tasks',{limit:1});assert.equal(first.nextCursor,second);
    const next=await rpc('tasks',{limit:1,cursor:first.nextCursor});assert.equal(next.items[0].id,ITEM);assert.equal(next.nextCursor,null);
    assert.equal((await rpc('tasks',{query:'%_'})).items.length,1);await db.exec(`DELETE FROM public.jobs WHERE id='${second}'`);
  });
  await t.test('registry default remains disabled, revocation and neutral policy never grant missing overlay',async()=>{
    await db.exec("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='customers.view'");await assert.rejects(rpc('customers'),code('42501'));
    await db.exec("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='customers.view'");
    await db.exec('DELETE FROM app_private.hermes_org_policies');assert.equal((await rpc('customers',{}, {...binding,expectedPolicyVersion:0})).items.length,1);
    await db.exec(`UPDATE app_private.hermes_connection_tokens SET revoked_at=clock_timestamp()`);await assert.rejects(rpc('customers',{}, {...binding,expectedPolicyVersion:0}),code('42501'));
  });
});

test('domain mount sends the decrypted bound user bearer to actual SQL and rejects permission removal between prepare/finalize',{timeout:60000},async t=>{
  const {f,db,sqlCall}=await setup(t),events=[];
  const expiresAt=(Math.floor(Date.now()/1000)+3600)*1000;
  const accessToken=['header',Buffer.from(JSON.stringify({role:'authenticated',sub:USER,session_id:SESSION,exp:expiresAt/1000})).toString('base64url'),'signature'].join('.');
  const crypto=createSessionCrypto({activeKeyVersion:'test',keys:new Map([['test',randomBytes(32)]])});t.after(()=>crypto.destroy());
  const envelope=crypto.seal({accessToken,refreshToken:'SYNTHETIC_REFRESH',expiresAt},{assistantId:ASSISTANT,userId:USER,organizationId:ORG,sessionId:SESSION});
  await db.query('UPDATE app_private.hermes_sessions SET envelope=$1::jsonb,expires_at=to_timestamp($2/1000.0)',[JSON.stringify(envelope),expiresAt]);
  const dependencyScope=createDependencyScope();t.after(()=>dependencyScope.close());
  let beforeRead,verifications=0;const bindings=[];
  const fetch=async(url,options)=>{
    assert.equal(options.headers.authorization,'Bearer '+accessToken);assert.equal(options.headers.apikey,'sb_publishable_test');assert.equal(options.redirect,'error');
    const name=new URL(url).pathname,args=JSON.parse(options.body);events.push(name);
    if(name==='/rest/v1/rpc/hermes_domain_read_v1')bindings.push(args.p_binding);
    if(name==='/rest/v1/rpc/hermes_domain_read_v1'&&beforeRead){const hook=beforeRead;beforeRead=undefined;await hook();}
    // Families v2 and v3 (wave 2 keys) are later forward files and are absent in this v1 fixture.
    if(['/rest/v1/rpc/hermes_domain_capabilities_v2','/rest/v1/rpc/hermes_domain_capabilities_v3'].includes(name))return Response.json({code:'PGRST202',message:'missing',details:null,hint:null},{status:404});
    try {return Response.json(name==='/rest/v1/rpc/hermes_domain_capabilities_v1'?await sqlCall('capabilities',[args.p_organization_id]):
      (assert.equal(name,'/rest/v1/rpc/hermes_domain_read_v1'),await sqlCall('read',[JSON.stringify(args.p_binding),args.p_domain,JSON.stringify(args.p_input)])));}
    catch(error){return Response.json({code:error.code,message:error.message,details:null,hint:null},{status:error.code==='42501'?403:error.code==='PT409'?409:400});}
  };
  const supabase={url:'https://example.invalid/',publishableKey:'sb_publishable_test'},reads=createSupabaseDomainReads({...supabase,fetch,dependencyScope});
  const baseAuth={async verifySession({accessToken:provided}){assert.equal(provided,accessToken);verifications++;return{userId:USER,sessionId:SESSION,expiresAt};},async readAuthorization(){return{
    userId:USER,isSuperadmin:false,activeOrganizationIds:[ORG],epoch:'synthetic-base',membership:{organizationId:ORG,status:'ACTIVE',revokedAt:null,validFrom:null,validTo:null,membershipId:USER,authorizationVersion:1},
    permissions:{read:[],action:[]},companyCeilings:{read:[],action:[]},scopesByPermission:{}};}};
  const auth=createDomainAuthAdapter({baseAuth,reads});
  const connectionStore=createDurableConnectionStore({transport:{async call(operation,payload){assert.equal(operation,'readConnection');return f.rpc('app_private.hermes_store_read_connection_v1',payload);}}});
  const authority=createDurableAuthority({connectionStore,crypto,auth});
  const service=createDomainMount({authority,connectionStore,crypto,auth,supabase,dependencyScope,fetch}).createService(),options={signal:new AbortController().signal};
  // customers moved to the v3 full-read family (domain-v3.test.mjs); the applied v1 SQL is exercised through contracts.
  const receipt=await service.prepareDomain(token,'contracts',{},options);assert.ok(Object.isFrozen(receipt));assert.deepEqual(Object.keys(receipt),[]);
  const result=await service.finalizeDomain(token,receipt,options);assert.equal(result.items[0].number,'CONTRACT');
  assert.equal(events.at(-1),'/rest/v1/rpc/hermes_domain_read_v1');await assert.rejects(service.finalizeDomain(token,receipt,options),code('context_changed'));
  const stale=await service.prepareDomain(token,'contracts',{},options);await db.exec("UPDATE public.fixture_domain_acl SET allowed=false WHERE permission='contracts.view'");
  const before=events.filter(name=>name.endsWith('read_v1')).length;
  await assert.rejects(service.finalizeDomain(token,stale,options),code('context_changed'));
  assert.equal(events.filter(name=>name.endsWith('read_v1')).length,before);
  await db.exec("UPDATE public.fixture_domain_acl SET allowed=true WHERE permission='contracts.view'");
  const finalFence=await service.prepareDomain(token,'contracts',{},options);
  beforeRead=()=>db.exec("UPDATE app_private.hermes_connections SET read_capabilities=ARRAY['tasks.view']");
  await assert.rejects(service.finalizeDomain(token,finalFence,options),code('forbidden'));
  // B2-2: with the read catalog opt-in, tasks (v1, outside the fast plan) keeps hermes_domain_read_v1 and the seven live
  // keys; the catalog resolves once (one provider verification), then warm reads verify nothing and rebuild nothing.
  const readAuthority=createReadCatalogAuthority({authority:createDurableAuthority({connectionStore,crypto,auth}),connectionStore});
  const cached=createDomainMount({authority,connectionStore,crypto,auth,supabase,dependencyScope,fetch,readAuthority}).createService();
  assert.ok(cached.cachedReadOperations.includes('tasks'));assert.ok(!cached.cachedReadOperations.includes('contracts'));
  const cold=verifications,sent=bindings.length;
  for(let i=0;i<2;i++){const r=await cached.prepareDomain(token,'tasks',{},options);assert.equal((await cached.finalizeDomain(token,r,options)).items[0].title,'Synthetic Task');}
  assert.equal(bindings.length,sent+2);assert.deepEqual(bindings.at(-1),binding);assert.equal(verifications,cold+1,'one catalog resolve, no per-read verification');
  assert.equal(events.at(-1),'/rest/v1/rpc/hermes_domain_read_v1');
});
