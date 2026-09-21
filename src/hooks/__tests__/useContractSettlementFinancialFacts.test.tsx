// @vitest-environment jsdom
import { renderHook,waitFor,act,cleanup } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { afterEach,expect,it,vi } from 'vitest';
import type { ReactNode } from 'react';
const s=vi.hoisted(()=>({actor:'aaaaaaaa-0000-4000-8000-000000000001',org:'aaaaaaaa-0000-4000-8000-000000000002',rpc:vi.fn()}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({data:{id:s.actor}})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:s.org})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:s.rpc,channel:()=>{const ch={on:()=>ch,subscribe:()=>ch};return ch;},removeChannel:vi.fn()}}));
import {useContractSettlementFinancialFacts} from '../useContractSettlementFinancialFacts';
const room='aaaaaaaa-0000-4000-8000-000000000003';
const response=(error:unknown=null)=>{const p=Promise.resolve({data:{schemaVersion:1,organizationId:s.org,roomId:room,targetContractId:room,terminationId:null,voucherId:null,sourceReceiptId:null,today:'2026-09-21',generatedAt:'2026-09-21T00:00:00Z',receiptsComplete:true,invoicesComplete:true,receipts:[],invoices:[],depositRequired:4,termination:null,obligation:null,notes:null},error});return Object.assign(p,{abortSignal:()=>p});};
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('binds actor scope, suppresses failed refresh data and exposes rejecting refresh',async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
 const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>;
 s.rpc.mockImplementation(()=>response());
 const hook=renderHook(()=>useContractSettlementFinancialFacts({roomId:room,contractId:room}),{wrapper});
 await waitFor(()=>expect(hook.result.current.data?.depositReceived.state).toBe('verified'));
 s.rpc.mockImplementation(()=>response({code:'42501',message:'internal secret'}));
 await act(async()=>{await expect(hook.result.current.refresh()).rejects.toThrow('Không đọc được');});
 await waitFor(()=>expect(hook.result.current.data).toBeUndefined());expect(hook.result.current.error?.message).not.toContain('secret');
 client.clear();
});
