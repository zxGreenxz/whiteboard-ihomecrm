// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import type { LeadWithRelations } from '@/hooks/useLeads';
import { ConvertLeadDialog } from '../ConvertLeadDialog';
const io=vi.hoisted(()=>({mark:vi.fn(),rpc:vi.fn(),pending:vi.fn(),trace:vi.fn(),from:vi.fn()}));
vi.mock('@/hooks/useLeads',()=>({useConvertLeadToDeposit:()=>({mutateAsync:io.mark,mutate:(id:string)=>io.mark(id),isPending:false})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'demo-org'})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:io.from,rpc:io.rpc}}));
vi.mock('@/lib/financialPending',()=>({financialPending:{read:io.pending}}));
vi.mock('@/lib/leadConversionProgress',()=>({readLeadConversionTrace:io.trace}));
vi.mock('@/components/deposits/CreateDepositDialog',()=>({CreateDepositDialog:(p:{initialPayer:string;initialRoomId:string;receiptRequestKey:string;onReceipt:(id:string)=>Promise<void>})=>
  <button onClick={()=>void p.onReceipt('voucher').catch(()=>undefined)}>{p.initialPayer} · {p.initialRoomId} · {p.receiptRequestKey}</button>}));
const lead={id:'lead',customer_name:'Người gửi',room_id:'room'} as LeadWithRelations;
function mount(){return render(<QueryClientProvider client={new QueryClient()}><ConvertLeadDialog open lead={lead} onOpenChange={vi.fn()}/></QueryClientProvider>);}
beforeEach(()=>{vi.clearAllMocks();io.pending.mockReturnValue(null);io.rpc.mockResolvedValue({data:null,error:null});io.mark.mockResolvedValue({});});
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
it('requires reconciliation for an uncertain historical conversion',async()=>{
  io.pending.mockReturnValue({requestKey:'old'});io.trace.mockReturnValue(null);mount();
  expect(await screen.findByText(/Lần chuyển khách hẹn trước cần đối chiếu/)).toBeTruthy();
  expect(io.rpc).not.toHaveBeenCalled();
});

it('resumes an old confirmed tenant with a rejected receipt, preserving the lead key',async()=>{
  io.pending.mockReturnValue({requestKey:'old',completedIds:['tenant']});
  io.trace.mockReturnValue({leadId:'lead',tenantId:'tenant',stage:'deposit',canResume:true});
  const q={select:()=>q,eq:()=>q,is:()=>q,maybeSingle:async()=>({data:{id:'tenant'},error:null})};
  io.from.mockReturnValue(q);mount();
  expect(await screen.findByRole('button',{name:'Người gửi · room · lead-income-lead'})).toBeTruthy();
  expect(io.from).toHaveBeenCalledWith('tenants');
});
