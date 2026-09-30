// @vitest-environment jsdom
import {act,cleanup,renderHook} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import type {ReactNode} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),actor:'actor-a',success:vi.fn()}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:m.actor})}));
vi.mock('sonner',()=>({toast:{success:m.success,info:vi.fn(),error:vi.fn(),warning:vi.fn()}}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:m.rpc,from:()=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data:null,error:null})})}}));
import {useCreateProfitDistribution,useCreateManagerSalaryPayout} from '../income-expenses/specialized';
const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={new QueryClient({defaultOptions:{mutations:{retry:false}}})}>{children}</QueryClientProvider>;
const base={amount:500000,account_id:'account-a',voucher_date:'2026-09-30',organizationId:'org-a'};
const variants=[{name:'profit',useHook:()=>{const h=useCreateProfitDistribution();return {mutateAsync:()=>h.mutateAsync({...base,shareholder_id:'person-a'})};}},{name:'manager',useHook:()=>{const h=useCreateManagerSalaryPayout();return {mutateAsync:()=>h.mutateAsync({...base,manager_id:'person-a'})};}}];
beforeEach(()=>{vi.clearAllMocks();m.actor='actor-a';localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');m.rpc.mockResolvedValue({data:null,error:null});});afterEach(cleanup);
for(const v of variants){
 it(v.name+' marker is persisted with exact RPC idempotency key before writer',async()=>{m.rpc.mockImplementation(async(_name,args)=>{const records=Object.keys(localStorage).filter(k=>k.startsWith('ihome:financial-pending:')).map(k=>JSON.parse(localStorage.getItem(k)!));expect(records).toHaveLength(1);expect(args.p_idempotency_key).toBe(records[0].requestKey);expect(records[0]).toMatchObject({userId:'actor-a',organizationId:'org-a'});return {data:{voucher_id:'voucher-a'},error:null};});const h=renderHook(v.useHook,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync()).resolves.toMatchObject({id:'voucher-a'});});expect(Object.keys(localStorage).filter(k=>k.startsWith('ihome:financial-pending:'))).toEqual([]);});
 it(v.name+' unknown survives remount and keeps request key without second RPC',async()=>{const h=renderHook(v.useHook,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync()).rejects.toBeTruthy();});const key=m.rpc.mock.calls[0][1].p_idempotency_key;h.unmount();const h2=renderHook(v.useHook,{wrapper});await act(async()=>{await expect(h2.result.current.mutateAsync()).rejects.toMatchObject({outcome:'unknown'});});expect(m.rpc).toHaveBeenCalledOnce();const marker=Object.keys(localStorage).find(k=>k.startsWith('ihome:financial-pending:'))!;expect(JSON.parse(localStorage.getItem(marker)!).requestKey).toBe(key);});
 it(v.name+' stale target organization rejects before marker and RPC',async()=>{localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');const h=renderHook(v.useHook,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync()).rejects.toMatchObject({outcome:'failure'});});expect(m.rpc).not.toHaveBeenCalled();expect(Object.keys(localStorage).filter(k=>k.startsWith('ihome:financial-pending:'))).toEqual([]);});
 it(v.name+' known SQL rejection retains code and allows corrected submission',async()=>{const failure={code:'42501',message:'SQL_PRIVATE'};m.rpc.mockResolvedValueOnce({data:null,error:failure}).mockResolvedValueOnce({data:{voucher_id:'voucher-a'},error:null});const h=renderHook(v.useHook,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync()).rejects.toBe(failure);await expect(h.result.current.mutateAsync()).resolves.toMatchObject({id:'voucher-a'});});expect(m.rpc).toHaveBeenCalledTimes(2);});
}
