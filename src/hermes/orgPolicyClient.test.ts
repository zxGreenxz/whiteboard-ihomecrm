import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHermesOrgPolicyClient, type HermesOrgPolicySnapshot } from './orgPolicyClient';
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: vi.fn() } } }));
const USER='11111111-1111-4111-8111-111111111111', ORG='22222222-2222-4222-8222-222222222222', MEMBER='33333333-3333-4333-8333-333333333333';
const SCOPE='44444444-4444-4444-8444-444444444444', OTHER='55555555-5555-4555-8555-555555555555';
const URL='https://abcdefghijklmnopqrst.supabase.co';
export const example=():HermesOrgPolicySnapshot=>({userId:USER,organizationId:ORG,membershipId:MEMBER,authorizationVersion:4,isSuperadmin:false,
  policy:{organizationId:ORG,version:2,enabled:false,read:['assistant.context.read'],action:[],scopeIds:[]},
  choices:{read:['assistant.context.read','rooms.view'],action:[],scopes:[{scopeId:SCOPE,scopeType:'ORGANIZATION',label:'Toàn tổ chức',buildingId:null,areaId:null,cashbookId:null}]},storedScopes:[]});
const session=()=>({data:{session:{user:{id:USER},access_token:'fixture.browser.jwt'}},error:null});
const json=(value:unknown,status=200)=>Response.json(value,{status});
const denial=(code:string,status:number)=>json({code,message:'PRIVATE',details:null,hint:null},status);
function setup(timeoutMs=30000){
  const scope={userId:USER,organizationId:ORG,generation:0};
  const fetch=vi.fn<typeof globalThis.fetch>(async()=>json(example()));
  const getSession=vi.fn(async()=>session());
  const client=createHermesOrgPolicyClient({userId:USER,organizationId:ORG,currentScope:()=>scope,fetch,getSession,timeoutMs});
  const input=()=>({expectedVersion:2,enabled:true,read:['assistant.context.read','rooms.view'],action:[],scopeIds:[SCOPE]});
  const ack=()=>({organizationId:ORG,version:3,enabled:true,read:input().read,action:[],scopeIds:[SCOPE]});
  return{client,scope,fetch,getSession,input,ack};
}
beforeEach(()=>{vi.stubEnv('VITE_SUPABASE_URL',URL);vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY','sb_publishable_fixture');});
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();vi.restoreAllMocks();});
describe('human Hermes company policy client',()=>{
  it('reads the neutral company ceiling without creating policy and only saves an explicit change with version-zero CAS',async()=>{
    const s=setup(),value=example();
    value.policy={organizationId:ORG,version:0,enabled:true,read:['assistant.context.read','rooms.view'],action:[],scopeIds:[SCOPE]};
    value.storedScopes=[{scopeId:SCOPE,label:'Toàn tổ chức',available:true}];
    s.fetch.mockResolvedValueOnce(json(value));await expect(s.client.load()).resolves.toEqual(value);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    const narrowed={expectedVersion:0,enabled:true,read:['assistant.context.read'],action:[],scopeIds:[]};
    const ack={organizationId:ORG,version:1,enabled:true,read:narrowed.read,action:[],scopeIds:[]};
    s.fetch.mockResolvedValueOnce(json(ack));await expect(s.client.save(narrowed)).resolves.toEqual(ack);
    expect(JSON.parse(s.fetch.mock.calls[1][1]!.body as string)).toMatchObject({p_expected_version:0,p_read:['assistant.context.read'],p_scope_ids:[]});
  });
  it('negotiates read-only v8 only when v9 is definitively absent, with the same organization and bearer',async()=>{
    const s=setup();s.fetch.mockResolvedValueOnce(denial('PGRST202',404));s.fetch.mockResolvedValueOnce(json(example()));
    await expect(s.client.load()).resolves.toEqual(example());
    expect(s.fetch.mock.calls.map(([url])=>url)).toEqual([URL+'/rest/v1/rpc/hermes_org_policy_options_v9',URL+'/rest/v1/rpc/hermes_org_policy_options_v8']);
    expect(s.fetch.mock.calls[0][1]!.body).toEqual(s.fetch.mock.calls[1][1]!.body);
    expect(s.fetch.mock.calls[0][1]!.headers).toEqual(s.fetch.mock.calls[1][1]!.headers);
  });
  it('does not fall back on denied or unknown reads and never negotiates policy writes',async()=>{
    for(const status of [403,503]){
      const s=setup();s.fetch.mockResolvedValueOnce(denial('PGRST202',status));
      await expect(s.client.load()).rejects.toMatchObject({code:'backend_unavailable'});expect(s.fetch).toHaveBeenCalledTimes(1);
    }
    const s=setup();await s.client.load();s.fetch.mockResolvedValueOnce(denial('PGRST202',404));
    await expect(s.client.save(s.input())).rejects.toMatchObject({code:'policy_outcome_unknown',outcomeUnknown:true});
    expect(s.fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps v1 compatibility after exact missing v9 through v2 while refusing malformed v8 fallback',async()=>{
    const s=setup();for(let i=0;i<8;i++)s.fetch.mockResolvedValueOnce(denial('PGRST202',404));s.fetch.mockResolvedValueOnce(json(example()));
    await expect(s.client.load()).resolves.toEqual(example());
    expect(s.fetch.mock.calls.map(([url])=>url)).toEqual([9,8,7,6,5,4,3,2,1].map(version=>URL+`/rest/v1/rpc/hermes_org_policy_options_v${version}`));
    const malformed=setup();malformed.fetch.mockResolvedValueOnce(denial('PGRST202',404));malformed.fetch.mockResolvedValueOnce(json({code:'PGRST202'},404));
    await expect(malformed.client.load()).rejects.toMatchObject({code:'backend_unavailable'});expect(malformed.fetch).toHaveBeenCalledTimes(2);
  });
  it('accepts all registered memory, schedule, room-pass, task, finance and customer choices without enabling them automatically',async()=>{
    const s=setup(),value=example();value.choices.read.push('assistant.memory.read','assistant.memory.supervise','income_expenses.view','meter_readings.view','deposits.view','reports_finance.analysis');
    value.choices.action=['chat_zalo.send','assistant.memory.write','chat_zalo.manage_automation','sale_phong.manage_pass_listings','tasks.create','tasks.edit','tasks.delete',
      'income_expenses.create','income_expenses.approve','customers.create','leads.create','rooms.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit','sale_phong.edit'];
    s.fetch.mockResolvedValueOnce(json(value));await expect(s.client.load()).resolves.toEqual(value);expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(value.policy.action).toEqual([]);
  });
  it('reads selected-org options then writes the existing versioned RPC with the browser JWT and explicit org header',async()=>{
    const s=setup();await expect(s.client.load()).resolves.toEqual(example());s.fetch.mockResolvedValueOnce(json(s.ack()));
    await expect(s.client.save(s.input())).resolves.toEqual(s.ack());
    expect(s.fetch.mock.calls.map(([url])=>url)).toEqual([URL+'/rest/v1/rpc/hermes_org_policy_options_v9',URL+'/rest/v1/rpc/hermes_set_org_policy_v1']);
    expect(s.fetch.mock.calls[1][1]).toMatchObject({method:'POST',mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',headers:{
      authorization:'Bearer fixture.browser.jwt',apikey:'sb_publishable_fixture','x-organization-id':ORG,'content-profile':'public'}});
    expect(JSON.parse(s.fetch.mock.calls[1][1]!.body as string)).toEqual({p_org:ORG,p_expected_version:2,p_enabled:true,p_read:s.input().read,p_action:[],p_scope_ids:[SCOPE]});
    expect(s.getSession).toHaveBeenCalledTimes(4);
  });
  it('requires an authoritative read before each write and never creates a wide default policy',async()=>{
    const s=setup();await expect(s.client.save(s.input())).rejects.toMatchObject({code:'invalid_request',outcomeUnknown:false});expect(s.fetch).not.toHaveBeenCalled();
    s.fetch.mockResolvedValueOnce(json({...example(),policy:{organizationId:ORG,version:0,enabled:false,read:[],action:[],scopeIds:[]}}));
    const result=await s.client.load();expect(result.policy.read).toEqual([]);expect(result.policy.scopeIds).toEqual([]);expect(s.fetch).toHaveBeenCalledTimes(1);
    s.fetch.mockResolvedValueOnce(json({...s.ack(),version:1}));await s.client.save({...s.input(),expectedVersion:0});
    await expect(s.client.save({...s.input(),expectedVersion:1})).rejects.toMatchObject({code:'invalid_request'});expect(s.fetch).toHaveBeenCalledTimes(2);
  });
  it('preserves existing unsupported read/action/scope values when disabling, but cannot add another unsupported grant',async()=>{
    const s=setup(),value=example();value.policy={...value.policy,enabled:true,read:['future.read'],action:['future.write'],scopeIds:[OTHER]};
    value.storedScopes=[{scopeId:OTHER,label:'Phạm vi đã lưu',available:false}];s.fetch.mockResolvedValueOnce(json(value));await s.client.load();
    await expect(s.client.save({...s.input(),read:['other.read']})).rejects.toMatchObject({code:'invalid_request'});
    await expect(s.client.save({...s.input(),action:['other.write']})).rejects.toMatchObject({code:'invalid_request'});
    const input={expectedVersion:2,enabled:false,read:value.policy.read,action:value.policy.action,scopeIds:value.policy.scopeIds};
    s.fetch.mockResolvedValueOnce(json({...value.policy,version:3,enabled:false}));await expect(s.client.save(input)).resolves.toMatchObject({enabled:false,action:['future.write'],scopeIds:[OTHER]});
    expect(s.fetch).toHaveBeenCalledTimes(2);
  });
  it.each([{userId:OTHER},{organizationId:OTHER},{choices:{...example().choices,read:['future.unsupported_read']}},
    {choices:{...example().choices,action:['rooms.delete']}},{storedScopes:[{scopeId:OTHER,label:'Foreign',available:true}]},
    {choices:{...example().choices,scopes:[{...example().choices.scopes[0],cashbookId:OTHER}]}},
    {policy:{...example().policy,organizationId:OTHER}},{token:'PRIVATE'}])('rejects foreign or broadened options %j',async delta=>{
    const s=setup();s.fetch.mockResolvedValueOnce(json({...example(),...delta}));await expect(s.client.load()).rejects.toMatchObject({code:'invalid_response',outcomeUnknown:false});
    await expect(s.client.save(s.input())).rejects.toMatchObject({code:'invalid_request'});
  });
  it.each(['userId','organizationId','generation'] as const)('fences %s changed after load even if returned to same IDs',async field=>{
    const s=setup();await s.client.load();if(field==='generation')s.scope.generation+=2;else s.scope[field]=OTHER;
    await expect(s.client.save(s.input())).rejects.toMatchObject({outcomeUnknown:false});expect(s.fetch).toHaveBeenCalledTimes(1);
  });
  it('snapshots caller arrays before session await',async()=>{
    const s=setup();await s.client.load();const input=s.input();s.getSession.mockImplementationOnce(async()=>{input.read.push('future.unsupported_read');input.scopeIds[0]=OTHER;return session();});
    s.fetch.mockResolvedValueOnce(json(s.ack()));await s.client.save(input);
    expect(JSON.parse(s.fetch.mock.calls[1][1]!.body as string)).toMatchObject({p_read:['assistant.context.read','rooms.view'],p_scope_ids:[SCOPE]});
  });
  it.each([{version:2},{organizationId:OTHER},{read:['assistant.context.read','assistant.context.read']},{action:['rooms.edit']},{scopeIds:[OTHER]},{token:'PRIVATE'}])('wrong write receipt is unknown and cannot retry %j',async delta=>{
    const s=setup();await s.client.load();s.fetch.mockResolvedValueOnce(json({...s.ack(),...delta}));await expect(s.client.save(s.input())).rejects.toMatchObject({code:'policy_outcome_unknown',outcomeUnknown:true});
    await expect(s.client.save(s.input())).rejects.toMatchObject({code:'invalid_request'});expect(s.fetch).toHaveBeenCalledTimes(2);
  });
  it.each([['42501',403,'forbidden'],['PT409',409,'context_changed'],['22023',400,'invalid_request']] as const)('maps known rejection %s without leaking server diagnostics',async(code,status,expected)=>{
    const s=setup();await s.client.load();s.fetch.mockResolvedValueOnce(denial(code,status));
    const error=await s.client.save(s.input()).catch(e=>e);expect(error).toMatchObject({code:expected,outcomeUnknown:false});expect(JSON.stringify(error)).not.toContain('PRIVATE');
  });
  it('keeps a lost ACK unknown, requires explicit readback, and never automatically replays',async()=>{
    const s=setup();await s.client.load();s.fetch.mockRejectedValueOnce(new Error('PRIVATE'));await expect(s.client.save(s.input())).rejects.toMatchObject({outcomeUnknown:true});
    await expect(s.client.save(s.input())).rejects.toMatchObject({code:'invalid_request'});expect(s.fetch).toHaveBeenCalledTimes(2);
    s.fetch.mockResolvedValueOnce(json({...example(),policy:s.ack(),storedScopes:[{scopeId:SCOPE,label:'Toàn tổ chức',available:true}]}));
    expect((await s.client.load()).policy.version).toBe(3);expect(s.fetch).toHaveBeenCalledTimes(3);
  });
  it('does not dispatch when cancelled before send or when the CRM session belongs to another account',async()=>{
    const s=setup(),controller=new AbortController();controller.abort();await expect(s.client.load({signal:controller.signal})).rejects.toMatchObject({code:'cancelled'});
    s.getSession.mockResolvedValueOnce({...session(),data:{session:{...session().data.session,user:{id:OTHER}}}});
    await expect(s.client.load()).rejects.toMatchObject({code:'reauthentication_required'});expect(s.fetch).not.toHaveBeenCalled();
  });
  it('timeouts cannot accept late read authority or dispatch after a late initial session',async()=>{
    vi.useFakeTimers();const s=setup(10);let resolve!:(value:ReturnType<typeof session>)=>void;s.getSession.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const result=s.client.load().catch(e=>e);await vi.advanceTimersByTimeAsync(11);expect(await result).toMatchObject({code:'timeout'});
    resolve(session());await Promise.resolve();await Promise.resolve();expect(s.fetch).not.toHaveBeenCalled();
    await expect(s.client.save(s.input())).rejects.toMatchObject({code:'invalid_request'});
  });
});

describe('registered action policy choices',()=>{
 it('accepts group read choices independently from send actions',async()=>{
  const s=setup(),value=example();value.choices.read=['assistant.context.read','rooms.view','chat_zalo.view'];
  s.fetch.mockResolvedValueOnce(json(value));expect((await s.client.load()).choices.read).toContain('chat_zalo.view');
  const input={...s.input(),read:['chat_zalo.view'],action:[],scopeIds:[]};
  const ack={...s.ack(),read:input.read,action:[],scopeIds:[]};s.fetch.mockResolvedValueOnce(json(ack));
  await expect(s.client.save(input)).resolves.toEqual(ack);
 });
 it('does not add fixed action without an authoritative choice, then persists only explicit selection',async()=>{
  const s=setup();await s.client.load();await expect(s.client.save({...s.input(),action:['chat_zalo.send']})).rejects.toMatchObject({code:'invalid_request'});expect(s.fetch).toHaveBeenCalledTimes(1);
  const value=example();value.choices.action=['chat_zalo.send'];s.fetch.mockResolvedValueOnce(json(value));expect((await s.client.load()).policy.action).toEqual([]);
  const ack={...s.ack(),action:['chat_zalo.send']};s.fetch.mockResolvedValueOnce(json(ack));await expect(s.client.save({...s.input(),action:['chat_zalo.send']})).resolves.toEqual(ack);
  expect(JSON.parse(s.fetch.mock.calls[2][1]!.body as string).p_action).toEqual(['chat_zalo.send']);
 });
 it('rejects duplicated or unknown action choices',async()=>{
  for(const action of [['chat_zalo.send','chat_zalo.send'],['future.write']]){const s=setup();s.fetch.mockResolvedValueOnce(json({...example(),choices:{...example().choices,action}}));await expect(s.client.load()).rejects.toMatchObject({code:'invalid_response'});}
 });
});
