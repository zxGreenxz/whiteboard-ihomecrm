import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppHandler } from './app-handler.mjs';

const ORG='aaaa0000-0000-4000-8000-000000000001';
const OTHER_ORG='dddd0000-0000-4000-8000-000000000001';
const USER='11111111-1111-4111-8111-111111111111';
const OTHER_USER='22222222-2222-4222-8222-222222222222';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const draft={title:'Sửa vòi',description:'Sửa vòi rò phòng 101',building:'A',room:'101',jobType:'',assignee:'',deadline:'',priority:'NORMAL'};
const extraction={action:'extract',organizationId:ORG,model:'chat-a',transcript:'Sửa vòi phòng 101',referenceTime:'2026-09-26T10:00:00+07:00',timeZone:'Asia/Ho_Chi_Minh'};
function setup(options={}){
  const calls=[];
  const env={VITE_SUPABASE_URL:'https://project.supabase.co',VITE_SUPABASE_PUBLISHABLE_KEY:'public-key',VOICE_LAB_NINEROUTER_API_KEY:'never-expose-key',...options.env};
  const handler=createAppHandler({getEnv:key=>env[key],now:()=>1000,fetchImpl:async(url,request)=>{
    calls.push({url,request});
    const user=request.headers.authorization==='Bearer second-user'?OTHER_USER:USER;
    if(url==='https://project.supabase.co/auth/v1/user')return options.auth?.(user)??json({id:user,is_anonymous:false});
    if(options.requirePublicSchema&&url.includes('/rest/v1/rpc/')&&(request.headers['content-profile']!=='public'||request.headers['accept-profile']!=='public'))return json({code:'PGRST202'},404);
    if(url.endsWith('/rest/v1/rpc/get_my_organizations'))return json({user_id:user,organizations:[{id:ORG,name:'Pilot',member_type:'OWNER'}],...options.organizations});
    if(url.endsWith('/rest/v1/rpc/get_my_permissions_v2')){assert.deepEqual(JSON.parse(request.body),{p_org:options.expectedOrg??ORG});return options.permissionsResponse??json(options.permissions??{tasks:{view:{org_wide:true,building_ids:[],cashbook_ids:[]}}});}
    assert.ok(url.startsWith('https://ai.chillhome.io.vn/v1/'),'upstream origin must be fixed');
    if(url.endsWith('/models'))return json({data:[{id:'chat-a'}]});
    if(url.endsWith('/models/stt'))return json({data:[{id:'stt-a'}]});
    if(url.endsWith('/chat/completions'))return options.chat?.(request)??json({choices:[{message:{content:JSON.stringify({draft,warnings:[]})}}]});
    if(url.endsWith('/audio/transcriptions'))return json({text:'Sửa vòi phòng 101'});
    throw Error('Unexpected external request');
  }});
  return {calls,run:async(body,headers={})=>{
    const result={status:0,headers:{},body:null};
    const response={setHeader(key,value){result.headers[key]=value;},status(status){result.status=status;return this;},json(body){result.body=body;return this;}};
    await handler({method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-token',...headers},body},response);return result;
  }};
}

test('authenticated app member gets capability status with no local-session requirement',async()=>{
  const {run}=setup();const result=await run({action:'status',organizationId:ORG});assert.equal(result.status,200);assert.equal(result.body.authenticated,true);assert.deepEqual(result.body.chatModels,['chat-a']);
});
test('RPC requests explicitly select public when PostgREST defaults to a different schema',async()=>{
  const {run,calls}=setup({requirePublicSchema:true});
  const result=await run({action:'status',organizationId:ORG});
  assert.equal(result.status,200);assert.equal(result.body.authenticated,true);
  const auth=calls.find(call=>call.url.endsWith('/auth/v1/user'));
  assert.equal(auth.request.headers['content-profile'],undefined);assert.equal(auth.request.headers['accept-profile'],undefined);
});
test('missing, invalid and anonymous JWTs cannot reach 9router',async()=>{
  for(const options of [{auth:()=>json({message:'secret-upstream'},401)},{auth:()=>json({id:USER,is_anonymous:true})}]){const {run,calls}=setup(options);assert.equal((await run({action:'status',organizationId:ORG})).status,401);assert.equal(calls.filter(call=>call.url.includes('ai.chillhome')).length,0);}
  const {run,calls}=setup();assert.equal((await run({action:'status',organizationId:ORG},{authorization:''})).status,401);assert.equal(calls.length,0);
});
test('selected organization must belong to verified user even with platform-admin sentinel',async()=>{
  const {run,calls}=setup({permissions:{__superadmin:true},expectedOrg:OTHER_ORG});const result=await run({action:'status',organizationId:OTHER_ORG});assert.equal(result.status,403);assert.equal(calls.filter(call=>call.url.includes('ai.chillhome')).length,0);
  const wrongOwner=setup({organizations:{user_id:OTHER_USER}});assert.equal((await wrongOwner.run({action:'status',organizationId:ORG})).status,403);
});
test('tasks.view must have effective scope; other module permission never grants the pilot',async()=>{
  for(const permissions of [{},{tasks:{create:true}},{tasks:{view:false}},{tasks:{view:{org_wide:false,building_ids:[],cashbook_ids:[]}}},{tasks:{view:{org_wide:'yes',building_ids:['garbage']}}}]){const {run}=setup({permissions});assert.equal((await run({action:'status',organizationId:ORG})).status,403);}
  for(const permissions of [{__superadmin:true},{tasks:{view:{org_wide:false,building_ids:[OTHER_ORG],cashbook_ids:[]}}}]){const {run}=setup({permissions});assert.equal((await run({action:'status',organizationId:ORG})).status,200);}
});
test('missing org-scoped RPC fails closed without legacy union fallback',async()=>{
  const {run,calls}=setup({permissionsResponse:json({code:'PGRST202',message:'secret-upstream'},404)});const result=await run({action:'status',organizationId:ORG});assert.equal(result.status,503);assert.ok(!JSON.stringify(result.body).includes('secret-upstream'));assert.ok(!calls.some(call=>call.url.endsWith('/get_my_permissions')));
});
test('extraction uses validated current model list and returns strict task draft',async()=>{
  const {run}=setup();const result=await run(extraction);assert.equal(result.status,200);assert.deepEqual(result.body.draft,draft);
  assert.equal((await run({...extraction,model:'invented-model'})).status,400);
  assert.equal((await run({...extraction,baseUrl:'https://attacker.example'})).status,400);
});
test('upload rejects invalid base64, unsupported audio and decoded size over 2 MiB',async()=>{
  const {run}=setup();const request={action:'transcribe',organizationId:ORG,model:'stt-a',audioBase64:Buffer.from('audio').toString('base64'),contentType:'audio/webm;codecs=opus'};
  assert.equal((await run(request)).status,200);
  for(const patch of [{audioBase64:'not base64!'},{audioBase64:'AB=='},{audioBase64:''},{contentType:'text/html'}])assert.equal((await run({...request,...patch})).status,400);
  assert.equal((await run({...request,audioBase64:Buffer.alloc(2*1024*1024+1).toString('base64')})).status,413);
});
test('body, transcript and action validation reject oversized or arbitrary operations',async()=>{
  const {run}=setup();assert.equal((await run('x'.repeat(3*1024*1024+1))).status,413);
  assert.equal((await run({...extraction,transcript:'x'.repeat(12001)})).status,400);
  assert.equal((await run({action:'createJob',organizationId:ORG})).status,400);
});
test('provider raw errors and malformed or oversized output are never returned as drafts',async()=>{
  for(const chat of [()=>{throw Error('never-expose-key');},()=>json({error:'never-expose-key'},500),()=>json({choices:[{message:{content:'bad json'}}]}),()=>json({huge:'x'.repeat(1024*1024+1)})]){const {run}=setup({chat});const result=await run(extraction);assert.ok(result.status>=500);assert.ok(!JSON.stringify(result.body).includes('never-expose-key'));assert.equal(result.body.draft,undefined);}
});
test('per-user generation limit does not spend another user quota',async()=>{
  const {run}=setup();for(let i=0;i<10;i++)assert.equal((await run(extraction)).status,200);
  assert.equal((await run(extraction)).status,429);assert.equal((await run(extraction,{authorization:'Bearer second-user'})).status,200);
});
test('missing dedicated server key reports unavailable instead of falling back to generic env key',async()=>{
  const {run}=setup({env:{VOICE_LAB_NINEROUTER_API_KEY:'',NINEROUTER_API_KEY:'must-not-fallback'}});const result=await run({action:'status',organizationId:ORG});assert.equal(result.status,200);assert.equal(result.body.providerReady,false);assert.deepEqual(result.body.chatModels,[]);
});
