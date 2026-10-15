// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HermesOrgPolicySettings } from './HermesOrgPolicySettings';
import type { HermesOrgPolicySnapshot } from './orgPolicyClient';
vi.mock('@/integrations/supabase/client',()=>({supabase:{auth:{getSession:async()=>({data:{session:{user:{id:'11111111-1111-4111-8111-111111111111'},access_token:'fixture.browser.jwt'}},error:null})}}}));
const USER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222',MEMBER='33333333-3333-4333-8333-333333333333';
const SCOPE='44444444-4444-4444-8444-444444444444',OTHER='55555555-5555-4555-8555-555555555555';
const scope={userId:USER,organizationId:ORG,generation:0},currentScope=()=>scope;
let value:HermesOrgPolicySnapshot,changed:ReturnType<typeof vi.fn<()=>void>>,fetchMock:ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
const writes=()=>fetchMock.mock.calls.filter(([url])=>String(url).endsWith('/hermes_set_org_policy_v1'));
async function respond(url:RequestInfo|URL,init?:RequestInit){
  if(/\/hermes_org_policy_options_v[1234567]$/.test(String(url)))return Response.json(value);
  if(!String(url).endsWith('/hermes_set_org_policy_v1'))throw new Error('unexpected_fixture_rpc');
  const input=JSON.parse(init!.body as string);
  if(input.p_expected_version!==value.policy.version)return Response.json({code:'PT409',message:'PRIVATE',details:null,hint:null},{status:409});
  value.policy={organizationId:ORG,version:value.policy.version+1,enabled:input.p_enabled,read:input.p_read,action:input.p_action,scopeIds:input.p_scope_ids};
  return Response.json(value.policy);
}
const view=(key='current')=><HermesOrgPolicySettings key={key} userId={USER} organizationId={ORG} currentScope={currentScope} onPolicyChanged={changed}/>;
const open=async()=>{fireEvent.click(screen.getByRole('button',{name:'Cấu hình chính sách công ty'}));await screen.findByRole('checkbox',{name:'Bật Hermes cho công ty'});};
const save=()=>fireEvent.click(screen.getByRole('button',{name:'Lưu chính sách Hermes'}));
beforeEach(()=>{
  scope.userId=USER;scope.organizationId=ORG;scope.generation=0;changed=vi.fn<()=>void>();
  value={userId:USER,organizationId:ORG,membershipId:MEMBER,authorizationVersion:1,isSuperadmin:false,
    policy:{organizationId:ORG,version:2,enabled:false,read:['assistant.context.read'],action:[],scopeIds:[]},
    choices:{read:['assistant.context.read','rooms.view'],action:[],scopes:[{scopeId:SCOPE,scopeType:'ORGANIZATION',label:'Toàn tổ chức',buildingId:null,areaId:null,cashbookId:null}]},storedScopes:[]};
  fetchMock=vi.fn<typeof globalThis.fetch>(respond);vi.stubGlobal('fetch',fetchMock);
  vi.stubEnv('VITE_SUPABASE_URL','https://abcdefghijklmnopqrst.supabase.co');vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY','sb_publishable_fixture');
});
afterEach(()=>{cleanup();vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('company Hermes policy administration through the real client',()=>{
  it('rejects an unknown fixture RPC before it can mutate the company policy',async()=>{
    const before=structuredClone(value),body=JSON.stringify({p_org:ORG,p_expected_version:value.policy.version,
      p_enabled:true,p_read:[],p_action:[],p_scope_ids:[]});
    for(const rpc of ['hermes_org_policy_options_v8','hermes_unexpected_v1']){
      await expect(respond('https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/'+rpc,{method:'POST',body})).rejects.toThrow('unexpected_fixture_rpc');
      expect(value).toEqual(before);
    }
  });
  it('explains neutral policy is optional and does not persist the displayed ceiling on open',async()=>{
    value.policy={...value.policy,version:0,enabled:true};render(view());await open();
    expect(fetchMock.mock.calls[0][0]).toBe('https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/hermes_org_policy_options_v7');
    expect(screen.getByText(/Bạn có thể tạo kết nối mà không cần lưu chính sách này/)).toBeTruthy();
    expect((screen.getByRole('checkbox',{name:'Bật Hermes cho công ty'}) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('button',{name:'Lưu chính sách Hermes'}) as HTMLButtonElement).disabled).toBe(true);
    expect(writes()).toHaveLength(0);expect(changed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox',{name:'Bật Hermes cho công ty'}));save();
    await screen.findByText('Đã tắt Hermes của công ty. Tải lại để tiếp tục chỉnh sửa.');
    expect(JSON.parse(writes()[0][1]!.body as string)).toMatchObject({p_expected_version:0,p_enabled:false});
  });
  it('requires opening and a deliberate change; applies only the current company policy and then requires readback',async()=>{
    render(<StrictMode>{view()}</StrictMode>);expect(fetchMock).not.toHaveBeenCalled();await open();
    expect((screen.getByRole('button',{name:'Lưu chính sách Hermes'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox',{name:'Bật Hermes cho công ty'}));save();
    await screen.findByText('Đã lưu chính sách Hermes của công ty. Tải lại để tiếp tục chỉnh sửa.');
    expect(writes()).toHaveLength(1);expect(changed).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writes()[0][1]!.body as string)).toMatchObject({p_org:ORG,p_expected_version:2,p_enabled:true,p_read:['assistant.context.read'],p_action:[],p_scope_ids:[]});
    expect(screen.queryByRole('button',{name:'Lưu chính sách Hermes'})).toBe(null);
    fireEvent.click(screen.getByRole('button',{name:'Tải lại chính sách'}));await screen.findByRole('checkbox',{name:'Bật Hermes cho công ty'});
    expect(writes()).toHaveLength(1);
  });
  it('preserves unsupported rights and saved scopes on disable, presenting them explicitly for removal',async()=>{
    value.policy={...value.policy,enabled:true,read:['future.read'],action:['future.write'],scopeIds:[OTHER]};
    value.storedScopes=[{scopeId:OTHER,label:'Phạm vi chưa có trong danh sách hiện tại',available:false}];
    render(view());await open();expect(screen.getByText(/future.read/)).toBeTruthy();expect(screen.getByText(/future.write/)).toBeTruthy();expect(screen.getByText(OTHER,{exact:false})).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox',{name:'Bật Hermes cho công ty'}));save();await screen.findByText('Đã tắt Hermes của công ty. Tải lại để tiếp tục chỉnh sửa.');
    expect(JSON.parse(writes()[0][1]!.body as string)).toMatchObject({p_enabled:false,p_read:['future.read'],p_action:['future.write'],p_scope_ids:[OTHER]});
  });
  it('shows denied administration without presenting an empty or disabled company as fact',async()=>{
    fetchMock.mockResolvedValue(Response.json({code:'42501',message:'PRIVATE',details:null,hint:null},{status:403}));render(view());
    fireEvent.click(screen.getByRole('button',{name:'Cấu hình chính sách công ty'}));await screen.findByText(/Bạn cần quyền quản lý người dùng/);
    expect(screen.queryByRole('checkbox',{name:'Bật Hermes cho công ty'})).toBe(null);expect(writes()).toHaveLength(0);
  });
  it('lost acknowledgement blocks mutation and only an explicit read shows the committed policy',async()=>{
    fetchMock.mockImplementation(async(url,init)=>{const result=await respond(url,init);if(String(url).endsWith('/hermes_set_org_policy_v1'))throw new Error('PRIVATE');return result;});
    render(view());await open();fireEvent.click(screen.getByRole('checkbox',{name:'Bật Hermes cho công ty'}));save();
    await screen.findByText(/Chưa xác định kết quả lưu chính sách/);expect(writes()).toHaveLength(1);expect(changed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button',{name:'Lưu chính sách Hermes'})).toBe(null);
    fireEvent.click(screen.getByRole('button',{name:'Tải lại chính sách'}));await screen.findByRole('checkbox',{name:'Bật Hermes cho công ty'});
    expect((screen.getByRole('checkbox',{name:'Bật Hermes cho công ty'}) as HTMLInputElement).checked).toBe(true);expect(writes()).toHaveLength(1);
  });
  it('CAS conflict clears stale draft and never overwrites newer policy',async()=>{
    render(view());await open();fireEvent.click(screen.getByRole('checkbox',{name:'Bật Hermes cho công ty'}));value.policy.version++;save();
    await screen.findByText(/Chính sách, tài khoản hoặc công ty đã thay đổi/);expect(value.policy.enabled).toBe(false);expect(writes()).toHaveLength(1);
  });
  it('discards a late options result when the owning company generation changes',async()=>{
    let resolve!:(result:Response)=>void;fetchMock.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const {rerender}=render(view());fireEvent.click(screen.getByRole('button',{name:'Cấu hình chính sách công ty'}));await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(1));
    scope.generation+=2;rerender(view('new-generation'));await act(async()=>{resolve(Response.json(value));});
    expect(screen.queryByRole('checkbox',{name:'Bật Hermes cho công ty'})).toBe(null);expect(fetchMock.mock.calls[0][1]!.signal!.aborted).toBe(true);expect(changed).not.toHaveBeenCalled();
  });
});

describe('shared permission picker for explicit company action ceiling',()=>{
 it('offers memory and schedule capabilities as explicit unchecked choices',async()=>{
  value.choices.read.push('assistant.memory.read');value.choices.action=['assistant.memory.write','chat_zalo.manage_automation'];render(view());await open();
  const read=screen.getByRole('checkbox',{name:'Xem ghi nhớ công việc CRM được phép'}),write=screen.getByRole('checkbox',{name:'Lưu, sửa và quên ghi nhớ công việc CRM của chính người dùng'});
  expect((read as HTMLInputElement).checked).toBe(false);expect((write as HTMLInputElement).checked).toBe(false);
  fireEvent.click(read);fireEvent.click(write);fireEvent.click(screen.getByRole('button',{name:/Chat Zalo/}));
  const schedule=screen.getByRole('checkbox',{name:/Bật\/tắt luồng tự động hoá/});expect(schedule.getAttribute('data-state')).toBe('unchecked');fireEvent.click(schedule);
  save();await screen.findByText('Đã tắt Hermes của công ty. Tải lại để tiếp tục chỉnh sửa.');
  expect(JSON.parse(writes()[0][1]!.body as string)).toMatchObject({p_read:['assistant.context.read','assistant.memory.read'],p_action:['assistant.memory.write','chat_zalo.manage_automation']});
 });
 it('can select group read without automatically selecting send or room data',async()=>{
  value.choices.read.push('chat_zalo.view');value.choices.action=['chat_zalo.send'];render(view());await open();
  const groups=screen.getAllByRole('button',{name:/Chat Zalo/});fireEvent.click(groups[0]);
  fireEvent.click(screen.getByRole('checkbox',{name:/Vào trang Chat Zalo/}));save();
  await screen.findByText('Đã tắt Hermes của công ty. Tải lại để tiếp tục chỉnh sửa.');
  expect(JSON.parse(writes()[0][1]!.body as string)).toMatchObject({p_read:['assistant.context.read','chat_zalo.view'],p_action:[],p_scope_ids:[]});
 });
 it('starts unselected and saves only after human checks the offered fixed action',async()=>{
  value.choices.action=['chat_zalo.send'];render(view());await open();expect(writes()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:/Chat Zalo/}));const control=screen.getByRole('checkbox',{name:/Gửi \/ soạn tin nhắn/});expect(control.getAttribute('data-state')).toBe('unchecked');
  fireEvent.click(control);save();await screen.findByText('Đã tắt Hermes của công ty. Tải lại để tiếp tục chỉnh sửa.');
  expect(JSON.parse(writes()[0][1]!.body as string)).toMatchObject({p_enabled:false,p_action:['chat_zalo.send']});expect(writes()).toHaveLength(1);
 });
 it('offers supervise and finance choices unchecked with their narrower Hermes meaning, saving only what the human checks',async()=>{
  value.choices.read.push('assistant.memory.supervise');value.choices.action=['income_expenses.create','income_expenses.approve'];render(view());await open();
  const supervise=screen.getByRole('checkbox',{name:/Hermes tổng: tra ghi nhớ công việc được chia sẻ/});expect((supervise as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:/Thu chi/}));
  expect(screen.getByText(/Hermes: ghi phiếu CHI nhanh/)).toBeTruthy();expect(screen.getByText(/không có công cụ duyệt/)).toBeTruthy();
  const create=screen.getByRole('checkbox',{name:/Tạo phiếu thu chi/});expect(create.getAttribute('data-state')).toBe('unchecked');
  fireEvent.click(supervise);fireEvent.click(create);save();await screen.findByText('Đã tắt Hermes của công ty. Tải lại để tiếp tục chỉnh sửa.');
  expect(JSON.parse(writes()[0][1]!.body as string)).toMatchObject({p_read:['assistant.context.read','assistant.memory.supervise'],p_action:['income_expenses.create']});
 });
 it('keeps catalog-disabled stored action visible only for narrowing',async()=>{
  value.policy.action=['chat_zalo.send'];render(view());await open();expect(screen.queryByRole('button',{name:/Chat Zalo/})).toBe(null);
  fireEvent.click(screen.getByRole('checkbox',{name:/chat_zalo.send — quyền đã lưu/}));save();await screen.findByText('Đã tắt Hermes của công ty. Tải lại để tiếp tục chỉnh sửa.');expect(JSON.parse(writes()[0][1]!.body as string).p_action).toEqual([]);
 });
});
