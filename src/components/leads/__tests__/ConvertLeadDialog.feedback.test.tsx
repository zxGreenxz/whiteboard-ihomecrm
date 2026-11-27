// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import type { LeadWithRelations } from '@/hooks/useLeads';
import { ConvertLeadDialog } from '../ConvertLeadDialog';
const io=vi.hoisted(()=>({mark:vi.fn(),rpc:vi.fn(),pending:vi.fn(),clear:vi.fn(),from:vi.fn(),report:vi.fn(),deposits:[] as {id:string;tenant_id:string}[]}));
vi.mock('@/hooks/useLeads',()=>({useConvertLeadToDeposit:()=>({mutateAsync:io.mark,mutate:(id:string,options?:{onSuccess?:()=>void})=>{void Promise.resolve(io.mark(id)).then(()=>options?.onSuccess?.(),()=>undefined);},isPending:false})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'demo-org'})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:io.from,rpc:io.rpc}}));
vi.mock('@/lib/financialPending',async original=>({...await original<typeof import('@/lib/financialPending')>(),financialPending:{read:io.pending,clearConfirmed:io.clear}}));
vi.mock('@/lib/pendingValve',async original=>({...await original<typeof import('@/lib/pendingValve')>(),pendingValve:{report:io.report}}));
vi.mock('@/components/deposits/CreateDepositDialog',()=>({CreateDepositDialog:(p:{initialPayer:string;initialRoomId:string;receiptRequestKey:string;onReceipt:(id:string)=>Promise<void>})=>
  <button onClick={()=>void p.onReceipt('voucher').catch(()=>undefined)}>{p.initialPayer} · {p.initialRoomId} · {p.receiptRequestKey}</button>}));
const lead={id:'lead',customer_name:'Người gửi',room_id:'room'} as LeadWithRelations;
function mount(){return render(<QueryClientProvider client={new QueryClient()}><ConvertLeadDialog open lead={lead} onOpenChange={vi.fn()}/></QueryClientProvider>);}
/** Bảng `deposits` của bản trước: lọc theo các điều kiện `eq` (mã, khách thuê). */
function depositsTable(){
  const filters:Record<string,unknown>={};
  const q={select:()=>q,eq:(column:string,value:unknown)=>{filters[column]=value;return q;},is:()=>q,gte:()=>q,lte:()=>q,order:()=>q,limit:()=>q,
    maybeSingle:async()=>({data:io.deposits.find(row=>row.id===filters.id)??null,error:null}),
    then:(resolve:(value:unknown)=>unknown)=>Promise.resolve({data:io.deposits.filter(row=>row.tenant_id===filters.tenant_id),error:null}).then(resolve)};
  return q;
}
const OLD=new Date(Date.now()-60*60_000).toISOString();
const legacyPending=(completedIds:string[]=[])=>({namespace:'lead-conversion',userId:'actor',organizationId:'demo-org',businessKey:'lead',attemptId:'old',requestKey:'old',completedIds,startedAt:OLD});
const trace=(value:Record<string,unknown>)=>localStorage.setItem('ihome:lead-conversion-trace:v1:old',JSON.stringify({leadId:'lead',...value}));
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();io.deposits=[];io.pending.mockReturnValue(null);io.clear.mockReturnValue(true);io.rpc.mockResolvedValue({data:null,error:null});io.mark.mockResolvedValue({});io.from.mockImplementation(()=>depositsTable());});
afterEach(cleanup);
it('uses the common receipt form and retries only the lead if its status update fails',async()=>{
  io.mark.mockRejectedValueOnce(new Error('status'));
  mount();
  fireEvent.click(await screen.findByRole('button',{name:'Người gửi · room · lead-income-lead'}));
  fireEvent.click(await screen.findByRole('button',{name:'Hoàn tất chuyển đổi'}));
  await waitFor(()=>expect(io.mark).toHaveBeenCalledTimes(2));
  expect(io.from).not.toHaveBeenCalled();
});
it('recovers the confirmed receipt on another visit',async()=>{
  io.rpc.mockResolvedValue({data:'voucher',error:null});mount();
  fireEvent.click(await screen.findByRole('button',{name:'Hoàn tất chuyển đổi'}));
  await waitFor(()=>expect(io.mark).toHaveBeenCalledWith('lead'));
  expect(screen.queryByText('Người gửi · room · lead-income-lead')).toBeNull();
});

// Đợt 7: dấu `lead-conversion` của luồng bản trước không còn chặn hộp chuyển khách hẹn mãi.
describe('dấu chuyển khách hẹn bản trước',()=>{
  it('không đọc được vết: chặn đúng khách hẹn này qua hộp cảnh báo chung; tự gỡ qua hộp rồi Tải lại thì làm tiếp như bình thường',async()=>{
    io.pending.mockReturnValueOnce(legacyPending());mount();
    expect(await screen.findByText(/chuyển khách hẹn thành đặt cọc gửi lúc/)).toBeTruthy();
    expect(io.report).toHaveBeenCalledWith(expect.objectContaining({pending:expect.objectContaining({attemptId:'old',operation:'chuyển khách hẹn thành đặt cọc'})}));
    expect(io.rpc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));
    expect(await screen.findByRole('button',{name:'Người gửi · room · lead-income-lead'})).toBeTruthy();
    expect(io.rpc).toHaveBeenCalledWith('get_lead_deposit_income_v1',expect.objectContaining({p_lead_id:'lead'}));
  });
  it('lệnh không tới máy chủ ở bước khách thuê (chưa có tiền): gỡ dấu cũ, dùng ngay luồng nhận cọc hiện hành',async()=>{
    io.pending.mockReturnValue(legacyPending(['tenant']));trace({tenantId:'tenant',stage:'deposit',canResume:true});mount();
    expect(await screen.findByRole('button',{name:'Người gửi · room · lead-income-lead'})).toBeTruthy();
    expect(io.clear).toHaveBeenCalledWith(expect.objectContaining({namespace:'lead-conversion',businessKey:'lead'}),'old');
    expect(localStorage.getItem('ihome:lead-conversion-trace:v1:old')).toBeNull();
    expect(io.report).not.toHaveBeenCalled();
  });
  it('tới nhưng mất phản hồi ở bước phiếu cọc: thấy phiếu của khách thuê đó ⇒ chỉ báo «có thể» kèm mã, không tạo phiếu khác',async()=>{
    io.pending.mockReturnValue(legacyPending(['tenant']));trace({tenantId:'tenant',stage:'deposit',canResume:false});
    io.deposits=[{id:'deposit-legacy',tenant_id:'tenant'}];mount();
    expect(await screen.findByText(/Có thể lần chuyển khách hẹn trước đã ghi phiếu cọc \(mã deposit-legacy\)/)).toBeTruthy();
    expect(screen.queryByText('Người gửi · room · lead-income-lead')).toBeNull();
    expect(io.report).toHaveBeenCalledWith(expect.objectContaining({pending:expect.objectContaining({attemptId:'old'})}));
    expect(screen.getByRole('button',{name:'Tải lại'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Hoàn tất chuyển đổi'}));
    await waitFor(()=>expect(io.clear).toHaveBeenCalledWith(expect.objectContaining({businessKey:'lead'}),'old'));
    expect(io.mark).toHaveBeenCalledWith('lead');
  });
  it('phiếu chỉ tra gần đúng mà không phải của khách này: tự gỡ dấu qua hộp cảnh báo rồi Tải lại ⇒ luồng nhận cọc như bình thường',async()=>{
    io.pending.mockReturnValueOnce(legacyPending(['tenant']));trace({tenantId:'tenant',stage:'deposit',canResume:false});
    io.deposits=[{id:'deposit-legacy',tenant_id:'tenant'}];mount();
    expect(await screen.findByText(/Có thể lần chuyển khách hẹn trước/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));
    expect(await screen.findByRole('button',{name:'Người gửi · room · lead-income-lead'})).toBeTruthy();
    expect(io.mark).not.toHaveBeenCalled();
  });
  it('dấu cũ đã nhận mã phiếu cọc: báo đã ghi kèm mã, chỉ hoàn tất khách hẹn rồi gỡ dấu',async()=>{
    io.pending.mockReturnValue(legacyPending(['tenant','deposit-1']));trace({tenantId:'tenant',depositId:'deposit-1',stage:'lead',canResume:true});
    io.deposits=[{id:'deposit-1',tenant_id:'tenant'}];mount();
    expect(await screen.findByText(/đã ghi phiếu cọc \(mã deposit-1\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Hoàn tất chuyển đổi'}));
    await waitFor(()=>expect(io.clear).toHaveBeenCalled());
    expect(io.rpc).not.toHaveBeenCalled();
  });
});

// Đợt 11: vết tiến độ của dấu bản trước được gỡ ngay khi việc của dấu đó đã xong (đã có kết luận, đã hoàn tất, hoặc người dùng
// đã tự gỡ dấu qua hộp cảnh báo), kể cả khi chính dấu đã được gỡ ở nơi khác (gỡ dấu trả false): không còn vết nằm mãi.
describe('vết tiến độ của dấu chuyển khách hẹn bản trước',()=>{
  const TRACE='ihome:lead-conversion-trace:v1:old';
  it('kết luận lần trước chưa ghi tiền mà dấu đã được gỡ ở tab khác: vẫn gỡ vết',async()=>{
    io.clear.mockReturnValue(false);io.pending.mockReturnValue(legacyPending(['tenant']));trace({tenantId:'tenant',stage:'deposit',canResume:true});mount();
    expect(await screen.findByRole('button',{name:'Người gửi · room · lead-income-lead'})).toBeTruthy();
    expect(localStorage.getItem(TRACE)).toBeNull();
  });
  it('phiếu cọc đã ghi, hoàn tất khách hẹn mà dấu đã được gỡ ở tab khác: vẫn gỡ vết',async()=>{
    io.clear.mockReturnValue(false);io.pending.mockReturnValue(legacyPending(['tenant','deposit-1']));trace({tenantId:'tenant',depositId:'deposit-1',stage:'lead',canResume:true});
    io.deposits=[{id:'deposit-1',tenant_id:'tenant'}];mount();
    fireEvent.click(await screen.findByRole('button',{name:'Hoàn tất chuyển đổi'}));
    await waitFor(()=>expect(io.clear).toHaveBeenCalled());
    await waitFor(()=>expect(localStorage.getItem(TRACE)).toBeNull());
  });
  it('chưa kết luận được, người dùng tự gỡ dấu qua hộp cảnh báo rồi Tải lại: vết của dấu đó được gỡ',async()=>{
    io.pending.mockReturnValueOnce(legacyPending(['tenant']));trace({tenantId:'tenant',stage:'lead',canResume:true});mount();
    expect(await screen.findByText(/chuyển khách hẹn thành đặt cọc gửi lúc/)).toBeTruthy();
    expect(localStorage.getItem(TRACE)).not.toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));
    expect(await screen.findByRole('button',{name:'Người gửi · room · lead-income-lead'})).toBeTruthy();
    expect(localStorage.getItem(TRACE)).toBeNull();
  });
  it('phiếu chỉ tra gần đúng, tự gỡ dấu qua hộp cảnh báo rồi Tải lại: vết được gỡ',async()=>{
    io.pending.mockReturnValueOnce(legacyPending(['tenant']));trace({tenantId:'tenant',stage:'deposit',canResume:false});
    io.deposits=[{id:'deposit-legacy',tenant_id:'tenant'}];mount();
    expect(await screen.findByText(/Có thể lần chuyển khách hẹn trước/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));
    expect(await screen.findByRole('button',{name:'Người gửi · room · lead-income-lead'})).toBeTruthy();
    expect(localStorage.getItem(TRACE)).toBeNull();
  });
  it('vết còn dấu của tài khoản khác trỏ tới thì giữ nguyên',async()=>{
    localStorage.setItem('ihome:financial-pending:v1:lead-conversion:other:demo-org:lead',JSON.stringify({...legacyPending(),userId:'other'}));trace({tenantId:'tenant',stage:'lead',canResume:true});mount();
    expect(await screen.findByRole('button',{name:'Người gửi · room · lead-income-lead'})).toBeTruthy();
    expect(localStorage.getItem(TRACE)).not.toBeNull();
  });
});
